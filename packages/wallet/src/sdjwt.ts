/**
 * 瀏覽器端 SD-JWT 解析、驗證與選擇性揭露（不需重簽，純丟棄未選 disclosure）。
 * 讓「持有者在自己錢包決定揭露哪些欄位」這件事真正發生在 client 端。
 *
 * 2026-08 修補（H11）：新增 `validateIssuedVc()`——錢包不再無條件相信
 * 收到的 VC。存入保險庫前會驗發證者 ES256K 簽章、比對 disclosure 摘要、
 * 檢查 `cnf.jwk` 是否綁定本機金鑰、`exp`/`nbf` 時效與 `iss` 格式。
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { utf8ToBytes } from "@noble/hashes/utils";

export interface Disclosure {
  raw: string;
  claim: string;
  value: unknown;
}

export interface ParsedSdJwt {
  jwt: string;
  payload: Record<string, unknown>;
  disclosures: Disclosure[];
}

/** EC 公鑰座標（cnf.jwk 與本機金鑰比對用） */
export interface JwkEc {
  kty: string;
  crv: string;
  x: string;
  y: string;
}

/**
 * 限定用途的 key binding 簽章器（由 keys.ts 提供、呼叫端注入）。
 * 出示流程不再自己去拿全域金鑰，因此可攔截、可替換、可測試。
 */
export interface KeyBindingSigner {
  did: string;
  attach(core: string, kb: { aud: string; nonce: string }): string;
}

export interface VcValidation {
  ok: boolean;
  /** 任一項成立即應**拒絕儲存** */
  errors: string[];
  /** 可接受但需在 UI 標示（例如發證端尚未補上 exp） */
  warnings: string[];
}

/** 允許的時鐘偏移（秒） */
const CLOCK_SKEW_SEC = 120;
/** 粗略的 DID 語法檢查：method 為小寫英數，method-specific-id 非空 */
const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._%:-]+$/;

function b64urlDecodeToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function b64urlDecodeToString(s: string): string {
  return new TextDecoder().decode(b64urlDecodeToBytes(s));
}

function b64uEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 統一 base64 / base64url 表示，避免只因編碼字元不同而誤判不符 */
function normalizeB64u(s: string): string {
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 解析 SD-JWT 緊湊格式 `<jwt>~<d1>~<d2>~...~` */
export function parseSdJwt(compact: string): ParsedSdJwt {
  const segs = compact.split("~");
  const jwt = segs[0];
  const discSegs = segs.slice(1).filter((s) => s.length > 0);

  const payloadJson = b64urlDecodeToString(jwt.split(".")[1] ?? "");
  const payload = payloadJson ? (JSON.parse(payloadJson) as Record<string, unknown>) : {};

  const disclosures: Disclosure[] = discSegs.map((raw) => {
    const arr = JSON.parse(b64urlDecodeToString(raw)) as unknown[];
    // 物件屬性 disclosure = [salt, key, value]；陣列元素 = [salt, value]
    if (arr.length >= 3) return { raw, claim: String(arr[1]), value: arr[2] };
    return { raw, claim: "(element)", value: arr[1] };
  });

  return { jwt, payload, disclosures };
}

// ── 發證者簽章驗證（did:key + Secp256k1）───────────────────
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
  let leading = 0;
  for (const ch of s) {
    if (ch !== "1") break;
    leading++;
  }
  return new Uint8Array([...new Array<number>(leading).fill(0), ...bytes.reverse()]);
}

/** 由 did:key(Secp256k1) 取出 33-byte 壓縮公鑰（與 issuer-verifier 的解碼互為鏡像） */
export function compressedPublicKeyFromDidKey(did: string): Uint8Array {
  if (!did.startsWith("did:key:")) throw new Error("非 did:key");
  const mb = did.slice("did:key:".length);
  if (mb[0] !== "z") throw new Error("did:key 非 base58btc(z) 編碼");
  const bytes = base58btcDecode(mb.slice(1));
  if (bytes.length !== 35) throw new Error(`did:key 長度不符（期望 35 bytes，實得 ${bytes.length}）`);
  if (bytes[0] !== 0xe7 || bytes[1] !== 0x01) throw new Error("did:key 非 Secp256k1");
  return bytes.slice(2);
}

/** 驗 JWS 的 ES256K 簽章：digest = sha256(utf8(`${header}.${payload}`))，sig = 64B r||s */
function verifyJwsEs256k(jwt: string, pub: Uint8Array): boolean {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  const sig = b64urlDecodeToBytes(parts[2]);
  if (sig.length !== 64) return false;
  const digest = sha256(utf8ToBytes(`${parts[0]}.${parts[1]}`));
  // lowS: false —— 只做真偽判定，不對簽發端的 s 值規範做額外要求
  return secp256k1.verify(sig, digest, pub, { lowS: false });
}

// ── 憑證驗證（存入錢包前的把關）─────────────────────────────
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * 驗證剛收到的 VC 是否可信、且真的屬於這台裝置。
 *
 * 檢查項目：
 *  1) 結構與 payload 可解析
 *  2) `iss` 存在且為合法 DID 語法
 *  3) 發證者 ES256K 簽章有效（`iss` 為 did:key 時可在瀏覽器完整驗證）
 *  4) 每個 disclosure 的摘要都出現在 `_sd`（防止被塞入偽造欄位）
 *  5) `cnf.jwk` 等於本機金鑰的公開座標（**最關鍵**：中間人回的假 VC 綁不到你的金鑰）
 *  6) `sub` 若存在必須等於本機 DID
 *  7) `exp` / `nbf` 時效（缺 `exp` 先容忍但標示為警告）
 *  8) `vct` 型別符合預期
 *
 * 注意：發證者是否受**鏈上信任根**背書、憑證是否已撤銷，需要 IssuerRegistry /
 * RevocationRegistry，只能在 verifier 端檢查——因此一律列為 warning，
 * 錢包不會據此宣稱「已受信任」。
 */
export function validateIssuedVc(
  compact: string,
  holder: { did: string; publicJwk: JwkEc },
  opts?: { expectedVct?: string; nowSec?: number }
): VcValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  let parsed: ParsedSdJwt;
  try {
    parsed = parseSdJwt(compact);
  } catch (e: unknown) {
    return {
      ok: false,
      errors: [`憑證格式無法解析：${e instanceof Error ? e.message : String(e)}`],
      warnings,
    };
  }

  const p = parsed.payload;

  // 1) 結構
  if (parsed.jwt.split(".").length !== 3) {
    errors.push("SD-JWT 主體不是合法 JWS（缺簽章段）");
  }

  // 2)+3) 發證者身分與簽章
  const iss = typeof p.iss === "string" ? p.iss : "";
  if (!iss) {
    errors.push("憑證缺 iss（發證者）");
  } else if (!DID_PATTERN.test(iss)) {
    errors.push(`發證者 DID 格式不合法：${iss}`);
  } else if (iss.startsWith("did:key:")) {
    try {
      if (!verifyJwsEs256k(parsed.jwt, compressedPublicKeyFromDidKey(iss))) {
        errors.push("發證者簽章驗證失敗（憑證可能被偽造或竄改）");
      }
    } catch (e: unknown) {
      errors.push(`無法驗證發證者簽章：${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    warnings.push(`發證者 DID 方法（${iss.split(":")[1]}）無法在瀏覽器離線驗簽，簽章由驗證方伺服器把關`);
  }

  // 4) disclosure 摘要必須出現在 _sd
  const sdDigests = Array.isArray(p._sd) ? p._sd.filter((d): d is string => typeof d === "string") : [];
  const sdSet = new Set(sdDigests.map(normalizeB64u));
  for (const d of parsed.disclosures) {
    const digest = b64uEncode(sha256(utf8ToBytes(d.raw)));
    if (!sdSet.has(digest)) {
      errors.push(`欄位「${d.claim}」的摘要不在憑證 _sd 中（疑似被外部塞入）`);
    }
  }

  // 5) cnf.jwk 必須綁定本機金鑰
  const cnf = (p.cnf as { jwk?: Partial<JwkEc> } | undefined)?.jwk;
  if (!cnf) {
    errors.push("憑證缺 cnf.jwk：未綁定持有者金鑰，無法做 key binding");
  } else if (cnf.kty !== "EC" || cnf.crv !== "secp256k1") {
    errors.push(`cnf.jwk 類型非 EC/secp256k1（實得 ${String(cnf.kty)}/${String(cnf.crv)}）`);
  } else if (
    normalizeB64u(cnf.x ?? "") !== normalizeB64u(holder.publicJwk.x) ||
    normalizeB64u(cnf.y ?? "") !== normalizeB64u(holder.publicJwk.y)
  ) {
    errors.push("憑證綁定的公鑰不是本機金鑰——此憑證不屬於這台裝置（可能是中間人回應的假憑證）");
  }

  // 6) sub
  if (typeof p.sub === "string" && p.sub !== holder.did) {
    errors.push("憑證 sub 與本機持有者 DID 不符");
  }

  // 7) 時效
  const now = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const exp = asNumber(p.exp);
  const nbf = asNumber(p.nbf);
  const iat = asNumber(p.iat);
  if (exp === null) {
    warnings.push("憑證未帶 exp（到期時間）：暫時容忍，發證端補上後將改為強制檢查");
  } else if (exp + CLOCK_SKEW_SEC < now) {
    errors.push(`憑證已過期（exp = ${new Date(exp * 1000).toLocaleString()}）`);
  }
  if (nbf !== null && nbf - CLOCK_SKEW_SEC > now) {
    errors.push(`憑證尚未生效（nbf = ${new Date(nbf * 1000).toLocaleString()}）`);
  }
  if (iat !== null && iat - CLOCK_SKEW_SEC > now) {
    warnings.push("憑證簽發時間在未來（iat），請確認裝置時鐘是否正確");
  }

  // 8) 型別
  if (opts?.expectedVct && p.vct !== opts.expectedVct) {
    errors.push(`憑證型別不符：預期 ${opts.expectedVct}，實得 ${String(p.vct ?? "無")}`);
  }

  warnings.push("發證者是否受鏈上信任根背書、是否已撤銷，由驗證方伺服器檢查（錢包無法離線判定）");

  return { ok: errors.length === 0, errors, warnings };
}

/** 以選定的 claim 重組出示內容（只保留被同意揭露的 disclosure） */
export function buildPresentation(parsed: ParsedSdJwt, revealClaims: string[]): string {
  const kept = parsed.disclosures
    .filter((d) => revealClaims.includes(d.claim))
    .map((d) => d.raw);
  return [parsed.jwt, ...kept].join("~") + "~";
}

/**
 * 帶 key binding 的出示（全程瀏覽器端）：
 * 最小揭露 core + KB-JWT（aud/nonce/sd_hash，以本機持有者私鑰簽 ES256K）。
 * 防止出示內容被攔截後轉手他人——他人無持有者私鑰，簽不出對應 cnf 的 KB。
 *
 * 簽章器由呼叫端注入（見 keys.ts `getKeyBindingSigner()`）：本模組不再自行
 * 取得全域金鑰，避免任何同源腳本 import 本函式就取得簽章能力。
 */
export function buildPresentationWithKeyBinding(
  parsed: ParsedSdJwt,
  revealClaims: string[],
  kb: { aud: string; nonce: string },
  signer: KeyBindingSigner
): string {
  if (!signer || typeof signer.attach !== "function") {
    throw new Error("缺少 key binding 簽章器：出示流程必須由已解鎖的錢包提供簽章器。");
  }
  const core = buildPresentation(parsed, revealClaims);
  return signer.attach(core, kb);
}
