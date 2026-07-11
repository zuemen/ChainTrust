/**
 * 瀏覽器端 SD-JWT 解析與選擇性揭露（不需重簽，純丟棄未選 disclosure）。
 * 讓「持有者在自己錢包決定揭露哪些欄位」這件事真正發生在 client 端。
 */

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

function b64urlDecodeToString(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 解析 SD-JWT 緊湊格式 `<jwt>~<d1>~<d2>~...~`（PoC：無 key binding） */
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
 */
import { ensureHolderKeys, attachKeyBinding } from "./keys.ts";

export function buildPresentationWithKeyBinding(
  parsed: ParsedSdJwt,
  revealClaims: string[],
  kb: { aud: string; nonce: string }
): string {
  const core = buildPresentation(parsed, revealClaims);
  return attachKeyBinding(ensureHolderKeys(), core, kb);
}
