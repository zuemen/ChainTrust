/**
 * T2 相容性測試：模擬「瀏覽器端持有者金鑰」的完整回路。
 *
 * 錢包端（packages/wallet/src/keys.ts）以 @noble/curves 在本機：
 *   1) 生成 Secp256k1 金鑰對 → 推導 did:key（multicodec 0xe701 + base58btc）
 *   2) 最小揭露後以本機私鑰簽 KB-JWT（ES256K：sha256(utf8) → r||s lowS → base64url）
 *
 * 本測試用 ethers.SigningKey 產生位元級相同的簽章與 DID 編碼，證明：
 * 伺服器完全不知道持有者私鑰的前提下，issueKycSdJwt → 錢包式出示 →
 * verifyKycSdJwtPresentation(requireKeyBinding) 全綠。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes, createHash } from "crypto";
import { SigningKey, sha256 as ethSha256, toUtf8Bytes, getBytes } from "ethers";
import { createVeramoAgent, createIssuerDid } from "../src/agent.js";
import { InMemoryChainGateway } from "../src/chain/gateway.js";
import { issuerAddressFromIdentifier } from "../src/credentialHash.js";
import { issueKycSdJwt, verifyKycSdJwtPresentation } from "../src/sdjwt.js";
import type { ChainTrustAgent } from "../src/agent.js";
import type { IIdentifier } from "@veramo/core";

// ── 鏡像 wallet/src/keys.ts 的編碼（base58btc encode + did:key + KB 組裝）──
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
  let prefix = "";
  for (const b of bytes) { if (b !== 0) break; prefix += "1"; }
  return prefix + digits.reverse().map((d) => B58[d]).join("");
}
function didKeyFromCompressedPub(pubHex0x: string): string {
  const pub = getBytes(pubHex0x); // 33B compressed
  const prefixed = new Uint8Array(2 + pub.length);
  prefixed[0] = 0xe7; prefixed[1] = 0x01; prefixed.set(pub, 2);
  return "did:key:z" + base58btcEncode(prefixed);
}
const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const b64uJson = (o: unknown) => b64u(Buffer.from(JSON.stringify(o)));

/** 瀏覽器端等價簽章：sha256(utf8(data)) → ES256K → 64B r||s → base64url */
function browserStyleSign(sk: SigningKey, data: string): string {
  const digest = ethSha256(toUtf8Bytes(data)); // ethers Signature 為 canonical lowS
  const sig = sk.sign(digest);
  return b64u(Buffer.concat([getBytes(sig.r), getBytes(sig.s)]));
}

/** 錢包式最小揭露：只保留同意的 disclosure（鏡像 wallet/src/sdjwt.ts） */
function walletPresent(compact: string, revealClaims: string[]): string {
  const segs = compact.split("~");
  const jwt = segs[0];
  const kept = segs.slice(1).filter((s) => {
    if (!s) return false;
    const arr = JSON.parse(Buffer.from(s, "base64url").toString("utf-8"));
    return arr.length >= 3 && revealClaims.includes(String(arr[1]));
  });
  return [jwt, ...kept].join("~") + "~";
}

function walletAttachKb(sk: SigningKey, core: string, aud: string, nonce: string): string {
  const header = { alg: "ES256K", typ: "kb+jwt" };
  const sdHash = b64u(createHash("sha256").update(core, "utf-8").digest());
  const payload = { iat: Math.floor(Date.now() / 1000), aud, nonce, sd_hash: sdHash };
  const input = `${b64uJson(header)}.${b64uJson(payload)}`;
  return core + `${input}.${browserStyleSign(sk, input)}`;
}

describe("瀏覽器端持有者金鑰（金鑰自主）× 伺服器 KB 驗證", () => {
  let agent: ChainTrustAgent;
  let issuer: IIdentifier;
  let chain: InMemoryChainGateway;
  let holderSk: SigningKey;
  let holderDid: string;
  let vc: string;

  beforeAll(async () => {
    agent = createVeramoAgent();
    chain = new InMemoryChainGateway();
    issuer = await createIssuerDid(agent);
    await chain.setTrustedIssuer(issuerAddressFromIdentifier(issuer), true);

    // 「瀏覽器」自行生成金鑰與 DID——伺服器 agent 從頭到尾沒有這把私鑰
    holderSk = new SigningKey("0x" + randomBytes(32).toString("hex"));
    holderDid = didKeyFromCompressedPub(holderSk.compressedPublicKey);

    vc = await issueKycSdJwt({ issuer, holderDid }, agent);
  });

  it("did:key 編碼與伺服器解碼互為鏡像（cnf 綁定正確公鑰）", () => {
    expect(holderDid.startsWith("did:key:z")).toBe(true);
    // 憑證 payload 的 sub 應為瀏覽器端 DID
    const payload = JSON.parse(Buffer.from(vc.split(".")[1], "base64url").toString("utf-8"));
    expect(payload.sub).toBe(holderDid);
    expect(payload.cnf?.jwk?.crv).toBe("secp256k1");
  });

  it("最小揭露＋本機簽 KB → requireKeyBinding 驗證全綠", async () => {
    const core = walletPresent(vc, ["kycLevel"]);
    const aud = "chaintrust-verifier";
    const nonce = "test-nonce-001";
    const presentation = walletAttachKb(holderSk, core, aud, nonce);

    const r = await verifyKycSdJwtPresentation(chain, presentation, {
      minKycLevel: 2,
      requireKeyBinding: true,
      expectedAud: aud,
      expectedNonce: nonce,
    });
    expect(r.reason).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.checks).toMatchObject({
      signature: true, trustedIssuer: true, notRevoked: true, predicate: true, keyBinding: true,
    });
    // 最小揭露成立：只看得到 kycLevel，其餘 PII 全部 withheld
    expect(r.disclosed).toEqual(["kycLevel"]);
    expect(r.withheld).toEqual(expect.arrayContaining(["fullName", "birthDate", "country", "over18"]));
  });

  it("nonce 不符（重放）→ keyBinding 失敗", async () => {
    const core = walletPresent(vc, ["kycLevel"]);
    const presentation = walletAttachKb(holderSk, core, "chaintrust-verifier", "nonce-A");
    const r = await verifyKycSdJwtPresentation(chain, presentation, {
      minKycLevel: 2, requireKeyBinding: true,
      expectedAud: "chaintrust-verifier", expectedNonce: "nonce-B",
    });
    expect(r.ok).toBe(false);
    expect(r.checks.keyBinding).toBe(false);
  });

  it("他人金鑰簽 KB（出示遭轉手）→ keyBinding 失敗", async () => {
    const thief = new SigningKey("0x" + randomBytes(32).toString("hex"));
    const core = walletPresent(vc, ["kycLevel"]);
    const presentation = walletAttachKb(thief, core, "chaintrust-verifier", "nonce-C");
    const r = await verifyKycSdJwtPresentation(chain, presentation, {
      minKycLevel: 2, requireKeyBinding: true,
      expectedAud: "chaintrust-verifier", expectedNonce: "nonce-C",
    });
    expect(r.ok).toBe(false);
    expect(r.checks.keyBinding).toBe(false);
    expect(r.reason).toContain("持有者公鑰不符");
  });
});
