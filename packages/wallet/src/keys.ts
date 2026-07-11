/**
 * 持有者金鑰（瀏覽器端）— T2「金鑰自主」強化。
 *
 * 自主權身分（SSI）的核心主張是「金鑰在使用者手上」。本模組讓 holder 的
 * Secp256k1 金鑰對在瀏覽器端生成與保存，DID 由公鑰在本地推導，
 * KB-JWT（key binding）也在本地簽——伺服器從此拿不到持有者私鑰。
 *
 * PoC 簡化（已於提案書誠實聲明）：私鑰以 hex 存 localStorage。
 * 落地版應改 WebAuthn / Secure Enclave / SIM 綁定；介面不變。
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

const KEY_STORAGE = "chaintrust.holderKey"; // 私鑰 hex（PoC）

// ── base58btc（Bitcoin 字母表）編碼：與 server 端 decode 鏡像 ──
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58btcEncode(bytes: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  // 前導 0 byte → 前導 '1'
  let prefix = "";
  for (const b of bytes) {
    if (b !== 0) break;
    prefix += "1";
  }
  return prefix + digits.reverse().map((d) => B58[d]).join("");
}

function b64u(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uJson(obj: unknown): string {
  return b64u(new TextEncoder().encode(JSON.stringify(obj)));
}

/** 由壓縮公鑰（33B）推 did:key：multicodec secp256k1-pub = 0xe7 0x01 */
export function didKeyFromCompressedPublicKey(pub: Uint8Array): string {
  const prefixed = new Uint8Array(2 + pub.length);
  prefixed[0] = 0xe7;
  prefixed[1] = 0x01;
  prefixed.set(pub, 2);
  return "did:key:z" + base58btcEncode(prefixed);
}

export interface HolderKeys {
  did: string;
  /** 簽 ES256K JWS：sha256(utf8(data)) → 64B r||s（lowS）→ base64url */
  sign: (data: string) => string;
}

/** 取得（或首次生成）瀏覽器端持有者金鑰。私鑰不出瀏覽器。 */
export function ensureHolderKeys(): HolderKeys {
  let privHex = localStorage.getItem(KEY_STORAGE);
  if (!privHex) {
    privHex = bytesToHex(secp256k1.utils.randomPrivateKey());
    localStorage.setItem(KEY_STORAGE, privHex);
  }
  const priv = hexToBytes(privHex);
  const pub = secp256k1.getPublicKey(priv, true); // 壓縮 33B
  const did = didKeyFromCompressedPublicKey(pub);
  return {
    did,
    sign: (data: string) => {
      const digest = sha256(utf8ToBytes(data));
      const sig = secp256k1.sign(digest, priv, { lowS: true });
      return b64u(sig.toCompactRawBytes());
    },
  };
}

/** 刪除本機金鑰（連同憑證重置時用） */
export function forgetHolderKeys(): void {
  localStorage.removeItem(KEY_STORAGE);
}

/**
 * 在瀏覽器端組 KB-JWT 並附掛於最小揭露 core 之後。
 * core：`<jwt>~<d1>~...~`（末尾含 '~'）
 * sd_hash = base64url(sha256(core))；aud/nonce 由驗證方核發。
 */
export function attachKeyBinding(
  keys: HolderKeys,
  core: string,
  kb: { aud: string; nonce: string }
): string {
  const header = { alg: "ES256K", typ: "kb+jwt" };
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    aud: kb.aud,
    nonce: kb.nonce,
    sd_hash: b64u(sha256(utf8ToBytes(core))),
  };
  const signingInput = `${b64uJson(header)}.${b64uJson(payload)}`;
  return core + `${signingInput}.${keys.sign(signingInput)}`;
}
