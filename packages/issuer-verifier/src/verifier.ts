import type { VerifiableCredential } from "@veramo/core";
import type { ChainTrustAgent } from "./agent.js";
import type { ChainGateway } from "./chain/gateway.js";
import { revocationKeyOf } from "./issuer.js";
import { scoreTransaction, type TxContext, type RiskAssessment } from "./fraud.js";
import { getAddress, computeAddress } from "ethers";

export interface VerifyChecks {
  signature: boolean;
  trustedIssuer: boolean;
  notRevoked: boolean;
}

export interface VerifyResult {
  ok: boolean;
  checks: VerifyChecks;
  issuerAddress?: string;
  reason?: string;
}

export interface VerifyAndScoreResult extends VerifyResult {
  /** 憑證有效時的 AI 風險評估；憑證無效則不評分（undefined） */
  risk?: RiskAssessment;
  /** 綜合結論：approve（驗證通過且 AI pass）/ review / reject */
  outcome: "approve" | "review" | "reject";
}

export interface TrustRevokeResult {
  trustedIssuer: boolean;
  notRevoked: boolean;
  issuerAddress?: string;
  reason?: string;
}

/**
 * 共用：驗章後的「信任根 + 撤銷」鏈上檢查（verifier.ts 與 sdjwt.ts 共用，避免重複）。
 *  - 由 issuer DID 推導 ETH 位址 → IssuerRegistry.isTrustedIssuer
 *  - revocationKey → RevocationRegistry.isRevoked
 */
export async function checkTrustAndRevocation(
  chain: ChainGateway,
  issuerDid: string,
  revocationKey: string | undefined
): Promise<TrustRevokeResult> {
  let issuerAddress: string;
  try {
    issuerAddress = issuerAddressFromDid(issuerDid);
  } catch (e: any) {
    return { trustedIssuer: false, notRevoked: false, reason: `信任查詢失敗：${e?.message ?? e}` };
  }
  // 鏈上查詢一律 fail-closed：RPC 抖動／限流不可退化成「通過」。
  let trustedIssuer: boolean;
  try {
    trustedIssuer = await chain.isTrustedIssuer(issuerAddress);
  } catch (e: any) {
    console.error("[verifier] isTrustedIssuer 鏈上查詢失敗:", e);
    return { trustedIssuer: false, notRevoked: false, issuerAddress, reason: "CHAIN_UNAVAILABLE：信任根查詢失敗" };
  }
  if (!trustedIssuer) {
    return { trustedIssuer: false, notRevoked: false, issuerAddress, reason: `Issuer 未被信任根背書：${issuerAddress}` };
  }
  if (!revocationKey) {
    return { trustedIssuer: true, notRevoked: false, issuerAddress, reason: "出示缺 credentialStatus" };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(revocationKey)) {
    return { trustedIssuer: true, notRevoked: false, issuerAddress, reason: "credentialStatus 非合法 bytes32" };
  }
  // 撤銷查詢帶入該憑證「實際簽發者」的位址：RevocationRegistry 已改為 issuer 命名空間，
  // 別家 issuer 撤銷同一個 hash 不會影響本憑證（修 H12 的系統側對應改動）。
  let revoked: boolean;
  try {
    revoked = await chain.isRevoked(issuerAddress, revocationKey);
  } catch (e: any) {
    console.error("[verifier] isRevoked 鏈上查詢失敗:", e);
    return { trustedIssuer: true, notRevoked: false, issuerAddress, reason: "CHAIN_UNAVAILABLE：撤銷狀態查詢失敗" };
  }
  return {
    trustedIssuer: true,
    notRevoked: !revoked,
    issuerAddress,
    reason: revoked ? "VC 已被撤銷" : undefined,
  };
}

/**
 * 驗證一張 VC：
 *  1) 驗章（Veramo verifyCredential）
 *  2) 查 IssuerRegistry.isTrustedIssuer
 *  3) 查 RevocationRegistry.isRevoked
 * 任一不過即 ok=false 並回明確 reason。
 */
export async function verifyCredential(
  agent: ChainTrustAgent,
  chain: ChainGateway,
  vc: VerifiableCredential
): Promise<VerifyResult> {
  const checks: VerifyChecks = {
    signature: false,
    trustedIssuer: false,
    notRevoked: false,
  };

  // 1) 驗章
  //
  // 安全關鍵：驗章後的所有判斷（issuer、subject、credentialStatus）一律取自
  // Veramo 由 JWT 解出的 `res.verifiableCredential`，**不可**採信呼叫端傳入的外層信封。
  // Veramo 的信封／JWT 一致性檢查前置條件是 `credential.proof.type === 'JwtProof2020'`
  // （見 @veramo/credential-w3c action-handler.js:220），攻擊者只要把 proof.type 改成
  // 其他字串即可跳過該檢查而簽章仍然驗過，進而偽造 issuer 與 revocationKey。
  let verified: VerifiableCredential;
  try {
    if (typeof vc !== "object" || vc === null) {
      return { ok: false, checks, reason: "vc 必須是 JSON 物件" };
    }
    if (vc.proof?.type !== "JwtProof2020") {
      return {
        ok: false,
        checks,
        reason: `不支援的 proof.type：${String(vc.proof?.type)}（僅接受 JwtProof2020）`,
      };
    }
    // 停用 Veramo 內建 credentialStatus 檢查：撤銷由我們的 ChainGateway 查 RevocationRegistry。
    const res = await agent.verifyCredential({
      credential: vc,
      policies: { credentialStatus: false },
    });
    checks.signature = res.verified === true;
    if (!checks.signature) {
      return { ok: false, checks, reason: `簽章驗證失敗：${res.error?.message ?? "unknown"}` };
    }
    const fromJwt = res.verifiableCredential as VerifiableCredential | undefined;
    if (!fromJwt) {
      return { ok: false, checks, reason: "驗章結果缺 verifiableCredential（無法取得 JWT payload）" };
    }
    verified = fromJwt;
  } catch (e: any) {
    return { ok: false, checks, reason: `簽章驗證例外：${e?.message ?? e}` };
  }

  const issuerDid = typeof verified.issuer === "string" ? verified.issuer : verified.issuer?.id;
  if (!issuerDid) {
    return { ok: false, checks, reason: "JWT payload 缺 issuer" };
  }

  // 2)+3) 信任根 + 撤銷（共用 helper）— 一律用 JWT 解出的憑證，而非呼叫端信封
  const tr = await checkTrustAndRevocation(chain, issuerDid, revocationKeyOf(verified));
  checks.trustedIssuer = tr.trustedIssuer;
  checks.notRevoked = tr.notRevoked;
  if (!tr.trustedIssuer || !tr.notRevoked) {
    return { ok: false, checks, issuerAddress: tr.issuerAddress, reason: tr.reason };
  }

  return { ok: true, checks, issuerAddress: tr.issuerAddress };
}

/**
 * 整合 M2.1：驗證 VC 通過後呼叫 AI 反詐 /score，產生綜合決策。
 * - 憑證無效 → outcome="reject"，不評分。
 * - 憑證有效 → 依 AI decision：pass→approve、review→review、block→reject。
 */
export async function verifyAndScore(
  agent: ChainTrustAgent,
  chain: ChainGateway,
  vc: VerifiableCredential,
  txContext: TxContext,
  opts?: { fraudBaseUrl?: string }
): Promise<VerifyAndScoreResult> {
  const v = await verifyCredential(agent, chain, vc);
  if (!v.ok) {
    return { ...v, outcome: "reject" };
  }
  const risk = await scoreTransaction(txContext, { baseUrl: opts?.fraudBaseUrl });
  const outcome =
    risk.decision === "block" ? "reject" : risk.decision === "review" ? "review" : "approve";
  return { ...v, risk, outcome };
}

/** DID 字串長度上限：避免超長輸入餵進 O(n²) 的 base58 解碼（CPU DoS） */
const MAX_DID_LENGTH = 256;

/**
 * 取出 DID 的 canonical 形式：去掉 DID URL 的 fragment(#)、query(?)、path(/)。
 *
 * 安全關鍵：驗簽與信任查詢**必須**基於同一次解析的結果。
 * 舊版直接對整串 DID 做未錨定的 did:ethr 正則比對，使得
 * `did:key:z<攻擊者公鑰>#did:ethr:0x<受信任位址>` 會用 `#` 前的金鑰驗簽、
 * 卻用 `#` 後塞入的位址查信任清單，等同任何人都能自簽受信任憑證。
 */
export function canonicalDid(did: string): string {
  if (typeof did !== "string" || did.length === 0) {
    throw new Error("issuer DID 不是字串");
  }
  if (did.length > MAX_DID_LENGTH) {
    throw new Error(`issuer DID 過長（>${MAX_DID_LENGTH}）`);
  }
  return did.split("#")[0].split("?")[0].split("/")[0];
}

/**
 * 由 issuer DID 推導 ETH 位址。
 * - did:ethr:<net?>:0x.. → 位址
 * - did:key（Secp256k1）→ 解 multibase 公鑰推導位址
 *
 * 先取 canonical DID 再依 method 前綴分派，正則全部錨定，
 * 確保「用來驗簽的金鑰識別」與「用來查信任清單的位址」來自同一個 DID。
 */
export function issuerAddressFromDid(did: string): string {
  const canonical = canonicalDid(did);

  if (canonical.startsWith("did:ethr:")) {
    const ethrMatch = canonical.match(/^did:ethr:(?:[a-zA-Z0-9_.%-]+:)*(0x[0-9a-fA-F]{40})$/);
    if (!ethrMatch) throw new Error(`did:ethr 格式不合法：${canonical}`);
    return getAddress(ethrMatch[1]);
  }

  if (canonical.startsWith("did:key:")) {
    const pubHex = secp256k1PublicKeyFromDidKey(canonical);
    return computeAddress("0x" + pubHex);
  }

  throw new Error(`不支援的 issuer DID 方法：${canonical}`);
}

/** 解析 did:key（Secp256k1）取出公鑰 hex（去除 multicodec 前綴 0xe701） */
export function secp256k1PublicKeyFromDidKey(did: string): string {
  const canonical = canonicalDid(did);
  if (!canonical.startsWith("did:key:")) throw new Error("非 did:key");
  const mb = canonical.slice("did:key:".length);
  if (mb[0] !== "z") throw new Error("did:key 非 base58btc(z) 編碼");
  const bytes = base58btcDecode(mb.slice(1));
  // multicodec：secp256k1-pub = 0xe7 0x01（varint），其後為 33-byte 壓縮公鑰
  if (bytes.length !== 35) {
    throw new Error(`did:key 長度不符（期望 35 bytes，實得 ${bytes.length}）`);
  }
  if (bytes[0] !== 0xe7 || bytes[1] !== 0x01) {
    throw new Error("did:key 非 Secp256k1（multicodec 前綴不符）");
  }
  const pub = bytes.slice(2);
  return Buffer.from(pub).toString("hex");
}

// 最小 base58btc 解碼（Bitcoin 字母表）
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58btcDecode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of s) {
    const val = B58.indexOf(ch);
    if (val < 0) throw new Error(`base58 非法字元：${ch}`);
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // 前導 '1' → 前導 0 byte
  for (let k = 0; k < s.length && s[k] === "1"; k++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}
