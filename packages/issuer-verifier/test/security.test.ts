/**
 * 安全回歸測試 —— 2026-08 安全掃描發現的漏洞，每一項都用「攻擊會成功嗎」的形式釘住。
 *
 * 這些情境在修復前全部會通過驗證（ok=true），是原本測試套件的完全盲區：
 *   C1  did:key:z<攻擊者公鑰>#did:ethr:0x<受信任位址> 繞過信任根
 *   C2  竄改 VC 外層信封（proof.type 非 JwtProof2020）偽造 issuer / 撤銷鍵
 *   H1  KB-JWT 缺 iat / iat 在未來 ⇒ 新鮮度檢查被短路，出示可無限重放
 *   H2  不帶 requireKeyBinding / nonce ⇒ KB 與防重放整段被跳過
 *   H12 撤銷未做 issuer 命名空間 ⇒ 他家 issuer 撤銷會影響本憑證
 *   vct 未驗 ⇒ 其他型別憑證只要有 kycLevel 就被當 KYC 接受
 */
import { describe, it, expect, beforeAll } from "vitest";
import { SigningKey, sha256, toUtf8Bytes, getBytes, computeAddress, Wallet } from "ethers";
import type { IIdentifier } from "@veramo/core";
import { createVeramoAgent, createIssuerDid, createHolderDid } from "../src/agent.js";
import type { ChainTrustAgent } from "../src/agent.js";
import { InMemoryChainGateway } from "../src/chain/gateway.js";
import { issuerAddressFromIdentifier } from "../src/credentialHash.js";
import {
  issueKycSdJwt,
  presentKycWithKeyBinding,
  verifyKycSdJwtPresentation,
} from "../src/sdjwt.js";
import { issueKYCCredential, revocationKeyOf } from "../src/issuer.js";
import { verifyCredential, issuerAddressFromDid, canonicalDid } from "../src/verifier.js";

const AUD = "chaintrust-verifier";
const NONCE = "sec-test-nonce";

const b64u = (buf: Uint8Array | Buffer): string =>
  Buffer.from(buf).toString("base64url");
const b64uJson = (o: unknown): string => b64u(Buffer.from(JSON.stringify(o), "utf-8"));

/** 以任意私鑰簽 ES256K（複製 KB-JWT 的簽章格式），供攻擊者模擬使用 */
function signES256K(privKey: string, data: string): string {
  const sig = new SigningKey(privKey).sign(sha256(toUtf8Bytes(data)));
  return b64u(Buffer.concat([getBytes(sig.r), getBytes(sig.s)]));
}

describe("C1 — did:key 夾帶 #did:ethr 片段不得繞過信任根", () => {
  it("canonicalDid 會剝掉 fragment / query / path", () => {
    expect(canonicalDid("did:key:zABC#did:ethr:0x1111111111111111111111111111111111111111")).toBe(
      "did:key:zABC"
    );
    expect(canonicalDid("did:ethr:0x1111111111111111111111111111111111111111?x=1")).toBe(
      "did:ethr:0x1111111111111111111111111111111111111111"
    );
  });

  it("did:key:<攻擊者>#did:ethr:<受信任位址> 不會被解析成受信任位址", () => {
    const attacker = Wallet.createRandom();
    const attackerDidKey = `did:key:z${"Q".repeat(40)}`; // 格式無效即可，重點是不得走 ethr 分支
    const trusted = "0x1111111111111111111111111111111111111111";
    const spoofed = `${attackerDidKey}#did:ethr:${trusted}`;

    // 修復前：正則未錨定且 ethr 分支優先，這裡會回傳 trusted 位址
    let resolved: string | null = null;
    try {
      resolved = issuerAddressFromDid(spoofed);
    } catch {
      resolved = null; // 解析失敗才是正確行為（它是一個 did:key，且內容無效）
    }
    expect(resolved).not.toBe(trusted);
    expect(attacker.address).toBeTruthy();
  });

  it("合法 did:ethr 仍可正常解析（修復沒有誤殺正常路徑）", () => {
    const addr = "0x1111111111111111111111111111111111111111";
    expect(issuerAddressFromDid(`did:ethr:${addr}`).toLowerCase()).toBe(addr);
    expect(issuerAddressFromDid(`did:ethr:polygon:amoy:${addr}`).toLowerCase()).toBe(addr);
  });

  it("尾端夾帶垃圾的 did:ethr 會被拒絕（正則兩端錨定）", () => {
    const addr = "0x1111111111111111111111111111111111111111";
    expect(() => issuerAddressFromDid(`did:ethr:${addr}EXTRA`)).toThrow();
    expect(() => issuerAddressFromDid(`prefix-did:ethr:${addr}`)).toThrow();
  });

  it("過長 DID 被擋下（避免 O(n²) base58 解碼成為 CPU DoS）", () => {
    expect(() => canonicalDid("did:key:z" + "1".repeat(5000))).toThrow(/過長/);
  });
});

describe("C2 — VC 外層信封竄改不得被採信", () => {
  let agent: ChainTrustAgent;
  let chain: InMemoryChainGateway;
  let issuer: IIdentifier;
  let rogue: IIdentifier;
  let holder: IIdentifier;

  beforeAll(async () => {
    agent = createVeramoAgent();
    chain = new InMemoryChainGateway();
    issuer = await createIssuerDid(agent, "trusted-bank");
    rogue = await createIssuerDid(agent, "rogue-bank");
    holder = await createHolderDid(agent, "victim-holder");
    await chain.setTrustedIssuer(issuerAddressFromIdentifier(issuer), true);
    chain.setRevokeAs(issuerAddressFromIdentifier(issuer));
  });

  it("未受信任 issuer 自簽的 VC 本來就該被擋", async () => {
    const vc = await issueKYCCredential(agent, { issuerDid: rogue.did, holderDid: holder.did });
    const r = await verifyCredential(agent, chain, vc);
    expect(r.ok).toBe(false);
    expect(r.checks.trustedIssuer).toBe(false);
  });

  it("把 issuer.id 改成受信任 DID + proof.type 改名，不得通過（修復前 ok=true）", async () => {
    const vc = await issueKYCCredential(agent, { issuerDid: rogue.did, holderDid: holder.did });
    const forged: any = JSON.parse(JSON.stringify(vc));
    forged.issuer = { id: issuer.did }; // 冒充受信任銀行
    forged.credentialSubject.privilegeLevel = "ADMIN"; // 加料
    forged.proof.type = "JsonWebSignature2020"; // 跳過 Veramo 的信封一致性檢查
    const r = await verifyCredential(agent, chain, forged);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/proof\.type/);
  });

  it("改 revocationKey 讓已撤銷憑證復活，不得成功（修復前 ok=true）", async () => {
    const vc = await issueKYCCredential(agent, { issuerDid: issuer.did, holderDid: holder.did });
    const key = revocationKeyOf(vc)!;
    await chain.revoke(key);
    expect((await verifyCredential(agent, chain, vc)).checks.notRevoked).toBe(false);

    const revived: any = JSON.parse(JSON.stringify(vc));
    revived.credentialStatus.revocationKey = "0x" + "ab".repeat(32); // 換一把沒被撤銷的鍵
    revived.proof.type = "JsonWebSignature2020";
    const r = await verifyCredential(agent, chain, revived);
    expect(r.ok).toBe(false);
  });

  it("即使 proof.type 正確，外層與 JWT 不一致仍由 Veramo 擋下", async () => {
    const vc = await issueKYCCredential(agent, { issuerDid: issuer.did, holderDid: holder.did });
    const forged: any = JSON.parse(JSON.stringify(vc));
    forged.credentialSubject.kycLevel = "super-admin";
    const r = await verifyCredential(agent, chain, forged);
    expect(r.ok).toBe(false);
  });
});

describe("H1/H2 — KB 與防重放不得因呼叫端不傳參數而被跳過", () => {
  let agent: ChainTrustAgent;
  let chain: InMemoryChainGateway;
  let issuer: IIdentifier;
  let holder: IIdentifier;
  let vc: string;

  beforeAll(async () => {
    agent = createVeramoAgent();
    chain = new InMemoryChainGateway();
    issuer = await createIssuerDid(agent, "kb-issuer");
    holder = await createHolderDid(agent, "kb-holder");
    await chain.setTrustedIssuer(issuerAddressFromIdentifier(issuer), true);
    chain.setRevokeAs(issuerAddressFromIdentifier(issuer));
    vc = await issueKycSdJwt({ issuer, holderDid: holder.did, subject: { kycLevel: 2 } }, agent);
  });

  it("正常帶 KB 的出示通過", async () => {
    const pres = await presentKycWithKeyBinding(agent, holder, vc, ["kycLevel"], {
      aud: AUD,
      nonce: NONCE,
    });
    const r = await verifyKycSdJwtPresentation(chain, pres, {
      expectedAud: AUD,
      expectedNonce: NONCE,
    });
    expect(r.ok).toBe(true);
    expect(r.checks.keyBinding).toBe(true);
  });

  it("H2：拿掉 KB-JWT 的裸出示一律失敗（修復前不傳 requireKeyBinding 即 ok=true）", async () => {
    const pres = await presentKycWithKeyBinding(agent, holder, vc, ["kycLevel"], {
      aud: AUD,
      nonce: NONCE,
    });
    const stripped = pres.slice(0, pres.lastIndexOf("~") + 1); // 去掉尾端 KB-JWT
    const r = await verifyKycSdJwtPresentation(chain, stripped, {
      expectedAud: AUD,
      expectedNonce: NONCE,
    });
    expect(r.ok).toBe(false);
    expect(r.checks.keyBinding).toBe(false);
    expect(r.reason).toMatch(/key binding/);
  });

  it("H2：nonce 不符即失敗（重放他人側錄的出示）", async () => {
    const pres = await presentKycWithKeyBinding(agent, holder, vc, ["kycLevel"], {
      aud: AUD,
      nonce: NONCE,
    });
    const r = await verifyKycSdJwtPresentation(chain, pres, {
      expectedAud: AUD,
      expectedNonce: "another-nonce",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nonce/);
  });

  /** 手工組一個 KB-JWT，可自由控制 iat（模擬攻擊者） */
  async function presentWithCustomKb(
    iatOverride: number | undefined,
    holderPriv: string
  ): Promise<string> {
    const good = await presentKycWithKeyBinding(agent, holder, vc, ["kycLevel"], {
      aud: AUD,
      nonce: NONCE,
    });
    const core = good.slice(0, good.lastIndexOf("~") + 1);
    const goodKb = good.slice(good.lastIndexOf("~") + 1);
    const sdHash = JSON.parse(
      Buffer.from(goodKb.split(".")[1], "base64url").toString("utf-8")
    ).sd_hash;

    const header = { alg: "ES256K", typ: "kb+jwt" };
    const payload: Record<string, unknown> = { aud: AUD, nonce: NONCE, sd_hash: sdHash };
    if (iatOverride !== undefined) payload.iat = iatOverride;
    const signingInput = `${b64uJson(header)}.${b64uJson(payload)}`;
    return `${core}${signingInput}.${signES256K(holderPriv, signingInput)}`;
  }

  it("H1：KB-JWT 缺 iat 即失敗（修復前整個新鮮度檢查被短路）", async () => {
    const priv = (await agent.keyManagerGet({ kid: holder.keys[0].kid })) as any;
    const holderPriv = priv?.privateKeyHex ? "0x" + priv.privateKeyHex : null;
    if (!holderPriv) return; // 取不到私鑰時跳過（不同 KMS 實作）

    const pres = await presentWithCustomKb(undefined, holderPriv);
    const r = await verifyKycSdJwtPresentation(chain, pres, {
      expectedAud: AUD,
      expectedNonce: NONCE,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/iat/);
  });

  it("H1：iat 設在未來即失敗（修復前 now-iat 為負數，永不過期）", async () => {
    const priv = (await agent.keyManagerGet({ kid: holder.keys[0].kid })) as any;
    const holderPriv = priv?.privateKeyHex ? "0x" + priv.privateKeyHex : null;
    if (!holderPriv) return;

    const tenYears = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600;
    const pres = await presentWithCustomKb(tenYears, holderPriv);
    const r = await verifyKycSdJwtPresentation(chain, pres, {
      expectedAud: AUD,
      expectedNonce: NONCE,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/未來|過期/);
  });
});

describe("H12 — 撤銷必須是 issuer 命名空間", () => {
  it("別家 issuer 撤銷同一個 hash 不影響本憑證", async () => {
    const chain = new InMemoryChainGateway();
    const A = "0x1111111111111111111111111111111111111111";
    const B = "0x2222222222222222222222222222222222222222";
    const hash = "0x" + "cd".repeat(32);

    chain.setRevokeAs(B);
    await chain.revoke(hash); // B 搶先撤銷 A 簽發的憑證

    expect(await chain.isRevoked(A, hash)).toBe(false); // A 的憑證不受影響
    expect(await chain.isRevoked(B, hash)).toBe(true);

    chain.setRevokeAs(A);
    await chain.revoke(hash); // A 仍可自行撤銷（修復前會被 B 永久鎖死）
    expect(await chain.isRevoked(A, hash)).toBe(true);
  });
});

describe("vct — 憑證型別必須相符", () => {
  it("信譽憑證不得被當成 KYC 憑證接受", async () => {
    const agent = createVeramoAgent();
    const chain = new InMemoryChainGateway();
    const issuer = await createIssuerDid(agent, "vct-issuer");
    const holder = await createHolderDid(agent, "vct-holder");
    await chain.setTrustedIssuer(issuerAddressFromIdentifier(issuer), true);
    chain.setRevokeAs(issuerAddressFromIdentifier(issuer));

    const { issueReputationSdJwt } = await import("../src/sdjwt.js");
    const repVc = await issueReputationSdJwt({ issuer, holderDid: holder.did }, agent);
    const pres = await presentKycWithKeyBinding(agent, holder, repVc, ["reputationTier"], {
      aud: AUD,
      nonce: NONCE,
    });
    // 用 KYC 的驗證器驗一張信譽憑證
    const r = await verifyKycSdJwtPresentation(chain, pres, {
      expectedAud: AUD,
      expectedNonce: NONCE,
    });
    expect(r.ok).toBe(false);
    expect(r.checks.credentialType).toBe(false);
    expect(r.reason).toMatch(/型別/);
  });
});
