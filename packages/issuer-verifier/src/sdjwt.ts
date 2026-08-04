import { randomUUID } from "crypto";
import { sha256, toUtf8Bytes, SigningKey, computeAddress, hexlify } from "ethers";
import { SDJwtVcInstance } from "@sd-jwt/sd-jwt-vc";
import { digest, generateSalt } from "@sd-jwt/crypto-nodejs";
import type { IIdentifier } from "@veramo/core";
import type { ChainTrustAgent } from "./agent.js";
import type { ChainGateway } from "./chain/gateway.js";
import { credentialHash } from "./credentialHash.js";
import { secp256k1PublicKeyFromDidKey, checkTrustAndRevocation } from "./verifier.js";
import { REVOCATION_STATUS_TYPE } from "./issuer.js";
import { MockBillingHistoryAdapter, type BillingSummary } from "./adapters/cht.js";

/** KYC VC 中可選擇揭露的 claim（其餘如 iss/vct/sub/credentialStatus 常駐可見） */
export const KYC_SD_CLAIMS = ["kycLevel", "over18", "country", "fullName", "birthDate"] as const;
type KycSdClaim = (typeof KYC_SD_CLAIMS)[number];

/** 普惠金融：信譽 VC 中可選擇揭露的 claim（最小揭露預設只出示 reputationTier） */
export const REPUTATION_SD_CLAIMS = [
  "reputationTier",
  "tenureMonths",
  "onTimeRatio",
  "avgMonthlyBillBand",
] as const;

// ── base64url ─────────────────────────────────────────────
function b64uToString(s: string): string {
  return Buffer.from(s, "base64url").toString("utf-8");
}
function b64uToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

// ── ES256K 簽/驗（與 did:key Secp256k1 一致）────────────────
/** signer：用 issuer 在 Veramo 的金鑰簽 JWS（回傳 base64url(r||s)） */
function es256kSigner(agent: ChainTrustAgent, kid: string) {
  return async (data: string): Promise<string> => {
    return agent.keyManagerSign({
      keyRef: kid,
      algorithm: "ES256K",
      data,
      encoding: "utf-8",
    });
  };
}

/** verifier：由 JWS payload 的 iss(did:key) 推導公鑰，驗 ES256K。可驗任意 issuer。 */
const selfResolvingVerifier = async (data: string, sig: string): Promise<boolean> => {
  const payloadB64 = data.split(".")[1];
  if (!payloadB64) return false;
  const payload = JSON.parse(b64uToString(payloadB64));
  const iss: string | undefined = payload?.iss;
  if (!iss) return false;
  const expectedAddr = computeAddress("0x" + secp256k1PublicKeyFromDidKey(iss));
  return verifyES256K(data, sig, expectedAddr);
};

/** 驗 ES256K：以還原公鑰推得位址與 expectedAddr 比對（兩 parity 皆試）。 */
function verifyES256K(data: string, sigB64u: string, expectedAddr: string): boolean {
  const dgst = sha256(toUtf8Bytes(data));
  const raw = b64uToBytes(sigB64u);
  if (raw.length !== 64) return false;
  const r = hexlify(raw.slice(0, 32));
  const s = hexlify(raw.slice(32, 64));
  for (const yParity of [0, 1] as const) {
    try {
      const pub = SigningKey.recoverPublicKey(dgst, { r, s, yParity });
      if (computeAddress(pub) === expectedAddr) return true;
    } catch {
      /* try next parity */
    }
  }
  return false;
}

// ── Key binding（階段 B）工具 ──────────────────────────────
const KB_TYP = "kb+jwt";

function b64uJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** 由 did:key(Secp256k1) 推 JWK（cnf 用，綁定持有者公鑰） */
function jwkFromDidKey(did: string): { kty: string; crv: string; x: string; y: string } {
  const compressed = secp256k1PublicKeyFromDidKey(did);
  const uncompressed = SigningKey.computePublicKey("0x" + compressed, false); // 0x04|x|y
  const hex = uncompressed.slice(4); // 去掉 0x04
  const x = Buffer.from(hex.slice(0, 64), "hex").toString("base64url");
  const y = Buffer.from(hex.slice(64, 128), "hex").toString("base64url");
  return { kty: "EC", crv: "secp256k1", x, y };
}

/** 由 cnf JWK 推 ETH 位址（驗 KB 簽章用） */
function addrFromJwk(jwk: { x: string; y: string }): string {
  const x = Buffer.from(jwk.x, "base64url").toString("hex").padStart(64, "0");
  const y = Buffer.from(jwk.y, "base64url").toString("hex").padStart(64, "0");
  return computeAddress("0x04" + x + y);
}

/** sd_hash = base64url(sha256(core))，core 為含末尾 '~' 的 SD-JWT（KB 之前） */
function sdHash(core: string): string {
  const d = sha256(toUtf8Bytes(core)); // 0x..
  return Buffer.from(d.slice(2), "hex").toString("base64url");
}

// ── SD-JWT 實例 ───────────────────────────────────────────
function issuerInstance(agent: ChainTrustAgent, kid: string): SDJwtVcInstance {
  return new SDJwtVcInstance({
    signer: es256kSigner(agent, kid),
    signAlg: "ES256K",
    hasher: digest,
    hashAlg: "sha-256",
    saltGenerator: generateSalt,
  });
}

function holderVerifierInstance(): SDJwtVcInstance {
  // 出示(present)與驗證(verify)需要 hasher 重算揭露雜湊；驗證另需 verifier。
  return new SDJwtVcInstance({
    verifier: selfResolvingVerifier,
    hasher: digest,
    hashAlg: "sha-256",
    saltGenerator: generateSalt,
  });
}

// ── 對外 API ──────────────────────────────────────────────
/** KYC 憑證有效期：180 天 */
export const KYC_VALIDITY_SEC = 180 * 24 * 3600;
/** 信譽憑證有效期：90 天（繳費行為變動較快） */
export const REPUTATION_VALIDITY_SEC = 90 * 24 * 3600;

export interface IssueKycSdJwtInput {
  issuer: IIdentifier;
  holderDid: string;
  subject?: {
    kycLevel?: number; // 2 = full KYC
    over18?: boolean;
    country?: string;
    fullName?: string;
    birthDate?: string;
  };
}

/** 簽發 SD-JWT KYCCredential：PII claim 皆為 salted、可選擇揭露 */
export async function issueKycSdJwt(input: IssueKycSdJwtInput, agent: ChainTrustAgent): Promise<string> {
  const kid = input.issuer.keys[0]?.kid;
  if (!kid) throw new Error("Issuer identifier 無金鑰 kid");
  const sdjwt = issuerInstance(agent, kid);

  const id = `urn:uuid:${randomUUID()}`;
  const s = input.subject ?? {};
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    iss: input.issuer.did,
    iat,
    // KYC 資料有時效（住址、風險等級會變）。沒有 exp 的憑證只能靠主動上鏈撤銷失效，
    // 而撤銷需要 issuer 察覺並付 gas —— 等於實務上永不過期。
    exp: iat + KYC_VALIDITY_SEC,
    vct: "KYCCredential",
    sub: input.holderDid,
    jti: id,
    // demo 預設值明確標示為展示資料：KYC 系統的預設不應該是「已通過最高等級驗證」
    kycLevel: s.kycLevel ?? 2,
    over18: s.over18 ?? true,
    country: s.country ?? "TW",
    fullName: s.fullName ?? "DEMO-USER（示範資料）",
    birthDate: s.birthDate ?? "1990-01-01",
    // 常駐可見，供 verifier 查鏈上撤銷
    credentialStatus: {
      id: `chaintrust:revocation#${credentialHash(id)}`,
      type: REVOCATION_STATUS_TYPE,
      revocationKey: credentialHash(id),
    },
    // 階段 B：cnf 綁定持有者公鑰（key binding 的信任錨）
    cnf: { jwk: jwkFromDidKey(input.holderDid) },
  };
  const disclosureFrame = { _sd: [...KYC_SD_CLAIMS] };
  return sdjwt.issue(payload, disclosureFrame as any);
}

// ── 普惠金融：FinancialReputationCredential（電信繳費信譽）──

/** 由繳費摘要推信譽等級：3=優良、2=良好、1=待累積。規則透明、可向使用者與監理稽核解釋。 */
export function reputationTierFromBilling(s: BillingSummary): number {
  if (s.tenureMonths >= 36 && s.onTimeRatio >= 0.95 && s.latePayments12m === 0) return 3;
  if (s.tenureMonths >= 12 && s.onTimeRatio >= 0.85) return 2;
  return 1;
}

export interface IssueReputationSdJwtInput {
  issuer: IIdentifier;
  holderDid: string;
  msisdn?: string;
  /** 測試/展示用：覆寫繳費摘要（預設走 BillingHistoryAdapter mock） */
  billingOverride?: BillingSummary;
}

/**
 * 簽發 SD-JWT FinancialReputationCredential：電信繳費紀錄 → 可攜財務信譽。
 * 普惠金融核心：無聯徵紀錄者（學生/新住民/自由工作者）以繳費史累積可驗證信譽；
 * 明細不出錢包，出示時預設只揭露 reputationTier。
 */
export async function issueReputationSdJwt(
  input: IssueReputationSdJwtInput,
  agent: ChainTrustAgent
): Promise<string> {
  const kid = input.issuer.keys[0]?.kid;
  if (!kid) throw new Error("Issuer identifier 無金鑰 kid");
  const billing =
    input.billingOverride ??
    (await new MockBillingHistoryAdapter().getBillingSummary(input.msisdn ?? "0912345678"));
  const sdjwt = issuerInstance(agent, kid);
  const id = `urn:uuid:${randomUUID()}`;
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    iss: input.issuer.did,
    iat,
    exp: iat + REPUTATION_VALIDITY_SEC,
    vct: "FinancialReputationCredential",
    sub: input.holderDid,
    jti: id,
    carrier: billing.carrier, // 常駐可見（發證脈絡，非個資）
    reputationTier: reputationTierFromBilling(billing),
    tenureMonths: billing.tenureMonths,
    onTimeRatio: billing.onTimeRatio,
    avgMonthlyBillBand: billing.avgMonthlyBillBand,
    credentialStatus: {
      id: `chaintrust:revocation#${credentialHash(id)}`,
      type: REVOCATION_STATUS_TYPE,
      revocationKey: credentialHash(id),
    },
    cnf: { jwk: jwkFromDidKey(input.holderDid) },
  };
  const disclosureFrame = { _sd: [...REPUTATION_SD_CLAIMS] };
  return sdjwt.issue(payload, disclosureFrame as any);
}

/** Holder 出示：只揭露指定 claim（預設只揭露 kycLevel 供述詞檢查），其餘 PII 不洩 */
export async function presentKycMinimal(
  sdJwtVc: string,
  revealKeys: string[] = ["kycLevel"]
): Promise<string> {
  const sdjwt = holderVerifierInstance();
  const frame: Record<string, boolean> = {};
  for (const k of revealKeys) frame[k] = true;
  return sdjwt.present(sdJwtVc, frame as any);
}

/**
 * 階段 B：帶 key binding 的出示。
 * 在最小揭露 core 後附上 KB-JWT（aud/nonce/iat/sd_hash），用持有者私鑰 ES256K 簽。
 * 防止出示被攔截後轉手他人（他人無持有者私鑰，無法產生對應 cnf 的 KB）。
 */
export async function presentKycWithKeyBinding(
  agent: ChainTrustAgent,
  holder: IIdentifier,
  sdJwtVc: string,
  revealKeys: string[],
  kb: { aud: string; nonce: string }
): Promise<string> {
  const kid = holder.keys[0]?.kid;
  if (!kid) throw new Error("Holder identifier 無金鑰 kid，無法簽 KB-JWT");
  const core = await presentKycMinimal(sdJwtVc, revealKeys); // 末尾含 '~'
  const header = { alg: "ES256K", typ: KB_TYP };
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    aud: kb.aud,
    nonce: kb.nonce,
    sd_hash: sdHash(core),
  };
  const signingInput = `${b64uJson(header)}.${b64uJson(payload)}`;
  const sig = await agent.keyManagerSign({
    keyRef: kid,
    algorithm: "ES256K",
    data: signingInput,
    encoding: "utf-8",
  });
  return core + `${signingInput}.${sig}`;
}

interface KbVerifyResult {
  ok: boolean;
  reason?: string;
}

/** 驗 KB-JWT：typ、對 cnf 公鑰的簽章、sd_hash、aud、nonce、新鮮度。 */
function verifyKeyBinding(
  kbJwt: string | null,
  core: string,
  payload: Record<string, any>,
  opts: { expectedAud: string; expectedNonce: string; maxAgeSec?: number; clockSkewSec?: number }
): KbVerifyResult {
  if (!kbJwt) return { ok: false, reason: "缺 key binding（KB-JWT）" };
  const parts = kbJwt.split(".");
  if (parts.length !== 3) return { ok: false, reason: "KB-JWT 格式錯誤" };
  const [h, p, s] = parts;
  let header: any, kbPayload: any;
  try {
    header = JSON.parse(b64uToString(h));
    kbPayload = JSON.parse(b64uToString(p));
  } catch {
    return { ok: false, reason: "KB-JWT 解析失敗" };
  }
  if (header?.typ !== KB_TYP) return { ok: false, reason: "KB typ 非 kb+jwt" };
  // 明確斷言 alg：不要依賴「verifyES256K 剛好只認 ES256K」這個實作巧合擋下 alg confusion。
  if (header?.alg !== "ES256K") return { ok: false, reason: `KB alg 非 ES256K：${String(header?.alg)}` };

  const jwk = payload?.cnf?.jwk;
  if (!jwk) return { ok: false, reason: "SD-JWT 缺 cnf（未綁定持有者）" };
  const holderAddr = addrFromJwk(jwk);
  if (!verifyES256K(`${h}.${p}`, s, holderAddr)) {
    return { ok: false, reason: "KB 簽章與持有者公鑰不符（疑似被轉手）" };
  }
  if (kbPayload?.sd_hash !== sdHash(core)) {
    return { ok: false, reason: "sd_hash 不符（出示內容遭竄改）" };
  }
  // aud / nonce 為必比對項：驗證方策略不可因為呼叫端沒傳而靜默略過。
  if (kbPayload?.aud !== opts.expectedAud) {
    return { ok: false, reason: "aud 不符（出示對象錯誤）" };
  }
  if (kbPayload?.nonce !== opts.expectedNonce) {
    return { ok: false, reason: "nonce 不符（可能為重放）" };
  }
  // iat 必填且必須是 number：舊版用 `typeof === "number" &&` 短路，
  // 導致缺 iat 或把 iat 設在未來時整個新鮮度檢查被跳過，出示可無限期重放。
  const maxAge = opts.maxAgeSec ?? 300;
  const skew = opts.clockSkewSec ?? 60;
  if (typeof kbPayload?.iat !== "number" || !Number.isFinite(kbPayload.iat)) {
    return { ok: false, reason: "KB-JWT 缺 iat（無法判斷新鮮度）" };
  }
  const ageSec = Date.now() / 1000 - kbPayload.iat;
  if (ageSec > maxAge) return { ok: false, reason: "KB-JWT 已過期" };
  if (ageSec < -skew) return { ok: false, reason: "KB-JWT iat 位於未來（超出容許時鐘偏移）" };
  return { ok: true };
}

export interface SdJwtVerifyChecks {
  signature: boolean;
  trustedIssuer: boolean;
  notRevoked: boolean;
  predicate: boolean;
  /** 憑證型別（vct）符合驗證情境所要求的型別 */
  credentialType?: boolean;
  /** 有效期（exp/nbf）檢查 */
  notExpired?: boolean;
  /** 階段 B：持有者 key binding（一律必驗） */
  keyBinding?: boolean;
}
export interface SdJwtVerifyResult {
  ok: boolean;
  checks: SdJwtVerifyChecks;
  issuerAddress?: string;
  /** 此次出示實際揭露的 PII claim 清單 */
  disclosed: string[];
  /** 未揭露（被最小揭露隱藏）的 PII claim 清單 */
  withheld: string[];
  payload?: Record<string, unknown>;
  reason?: string;
}

/** 述詞（policy）：由驗證情境決定，對已揭露 payload 評估 */
interface SdJwtPredicate {
  evaluate: (payload: Record<string, any>) => boolean;
  failReason: (payload: Record<string, any>) => string;
}

/**
 * 驗證方策略。
 *
 * 安全關鍵：`expectedAud` / `expectedNonce` 為**必填**。
 * 舊版是選填且由 HTTP request body 帶入，攻擊者只要不傳這兩個欄位、
 * 並拿掉出示尾端的 KB-JWT，key binding 與 nonce 防重放整條防線就被關閉
 * （`requireKeyBinding || kbJwt` 兩者皆假 ⇒ 整段跳過）。
 * 現在 KB 一律必驗，策略只能由伺服器端決定。
 */
interface SdJwtKbOpts {
  expectedAud: string;
  expectedNonce: string;
}

/**
 * 驗證 SD-JWT 出示（泛用，KYC / 信譽共用）：
 *  1) 驗章（揭露雜湊比對 + ES256K）— 即使缺完整 PII 也能驗
 *  2) isTrustedIssuer（由 iss did:key 推導位址）
 *  3) isRevoked（credentialStatus.revocationKey）
 *  4) 述詞（由呼叫端注入，如 kycLevel>=2、reputationTier>=2）
 *  5) key binding（出示含 KB 或要求 KB 時）
 */
async function verifySdJwtPresentation(
  chain: ChainGateway,
  presentation: string,
  sdClaims: readonly string[],
  predicate: SdJwtPredicate,
  expectedVct: string,
  opts: SdJwtKbOpts
): Promise<SdJwtVerifyResult> {
  const checks: SdJwtVerifyChecks = {
    signature: false,
    trustedIssuer: false,
    notRevoked: false,
    predicate: false,
  };
  if (typeof presentation !== "string" || presentation.length === 0) {
    return { ok: false, checks, disclosed: [], withheld: [...sdClaims], reason: "presentation 必須是非空字串" };
  }
  const sdjwt = holderVerifierInstance();

  // 分離 KB-JWT（最後一段若含 "." 即為 KB-JWT；disclosure 為單段 base64url 無 "."）
  let core = presentation;
  let kbJwt: string | null = null;
  const lastTilde = presentation.lastIndexOf("~");
  const tail = lastTilde >= 0 ? presentation.slice(lastTilde + 1) : "";
  if (tail.includes(".")) {
    kbJwt = tail;
    core = presentation.slice(0, lastTilde + 1);
  }

  let payload: Record<string, any>;
  try {
    const verified = await sdjwt.verify(core);
    payload = (verified.payload ?? {}) as Record<string, any>;
    checks.signature = true;
  } catch (e: any) {
    return {
      ok: false,
      checks,
      disclosed: [],
      withheld: [...sdClaims],
      reason: `SD-JWT 驗章失敗：${e?.message ?? e}`,
    };
  }

  const disclosed = sdClaims.filter((k) => k in payload);
  const withheld = sdClaims.filter((k) => !(k in payload));

  // 1.5) 憑證型別：不驗 vct 的話，任何受信任 issuer 簽發的**其他型別**憑證
  //      只要 payload 裡剛好有數值型 kycLevel 就會被當成 KYC 憑證接受。
  checks.credentialType = payload.vct === expectedVct;
  if (!checks.credentialType) {
    return {
      ok: false,
      checks,
      disclosed,
      withheld,
      reason: `憑證型別不符：期望 ${expectedVct}，實得 ${String(payload.vct)}`,
    };
  }

  // 1.6) 有效期：簽發端已補上 exp，這裡明確檢查（過期憑證不得通過）
  const nowSec = Math.floor(Date.now() / 1000);
  const skewSec = 60;
  if (payload.exp != null) {
    if (typeof payload.exp !== "number" || nowSec - skewSec > payload.exp) {
      checks.notExpired = false;
      return { ok: false, checks, disclosed, withheld, reason: "憑證已過期（exp）" };
    }
  }
  if (payload.nbf != null && (typeof payload.nbf !== "number" || nowSec + skewSec < payload.nbf)) {
    checks.notExpired = false;
    return { ok: false, checks, disclosed, withheld, reason: "憑證尚未生效（nbf）" };
  }
  checks.notExpired = true;

  // 2)+3) 信任根 + 撤銷（與 verifier.ts 共用 helper）
  const tr = await checkTrustAndRevocation(
    chain,
    String(payload.iss),
    payload.credentialStatus?.revocationKey
  );
  checks.trustedIssuer = tr.trustedIssuer;
  checks.notRevoked = tr.notRevoked;
  const issuerAddress = tr.issuerAddress;
  if (!tr.trustedIssuer || !tr.notRevoked) {
    return { ok: false, checks, issuerAddress, disclosed, withheld, reason: tr.reason };
  }

  // 4) 述詞（由驗證情境注入）
  checks.predicate = predicate.evaluate(payload);
  if (!checks.predicate) {
    return {
      ok: false,
      checks,
      issuerAddress,
      disclosed,
      withheld,
      payload,
      reason: predicate.failReason(payload),
    };
  }

  // 5) key binding：一律必驗（缺 KB-JWT 即失敗），aud/nonce 由伺服器策略帶入
  {
    const kbRes = verifyKeyBinding(kbJwt, core, payload, {
      expectedAud: opts.expectedAud,
      expectedNonce: opts.expectedNonce,
    });
    checks.keyBinding = kbRes.ok;
    if (!kbRes.ok) {
      return {
        ok: false,
        checks,
        issuerAddress,
        disclosed,
        withheld,
        payload,
        reason: `key binding 失敗：${kbRes.reason}`,
      };
    }
  }

  return { ok: true, checks, issuerAddress, disclosed, withheld, payload };
}

/** 驗證 KYC 出示：述詞 kycLevel >= minKycLevel（預設 2） */
export async function verifyKycSdJwtPresentation(
  chain: ChainGateway,
  presentation: string,
  opts: { minKycLevel?: number } & SdJwtKbOpts
): Promise<SdJwtVerifyResult> {
  const minLevel = opts.minKycLevel ?? 2;
  return verifySdJwtPresentation(
    chain,
    presentation,
    KYC_SD_CLAIMS,
    {
      evaluate: (p) => typeof p.kycLevel === "number" && p.kycLevel >= minLevel,
      failReason: (p) =>
        `述詞未滿足：需 kycLevel>=${minLevel}（揭露值：${p.kycLevel ?? "未揭露"}）`,
    },
    "KYCCredential",
    opts
  );
}

/** 驗證信譽出示（普惠金融）：述詞 reputationTier >= minTier（預設 2） */
export async function verifyReputationSdJwtPresentation(
  chain: ChainGateway,
  presentation: string,
  opts: { minTier?: number } & SdJwtKbOpts
): Promise<SdJwtVerifyResult> {
  const minTier = opts.minTier ?? 2;
  return verifySdJwtPresentation(
    chain,
    presentation,
    REPUTATION_SD_CLAIMS,
    {
      evaluate: (p) => typeof p.reputationTier === "number" && p.reputationTier >= minTier,
      failReason: (p) =>
        `述詞未滿足：需 reputationTier>=${minTier}（揭露值：${p.reputationTier ?? "未揭露"}）`,
    },
    "FinancialReputationCredential",
    opts
  );
}
