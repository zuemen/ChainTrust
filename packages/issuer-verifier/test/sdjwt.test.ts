import { describe, it, expect, beforeAll } from "vitest";
import {
  createVeramoAgent,
  createIssuerDid,
  createHolderDid,
  type ChainTrustAgent,
} from "../src/agent.js";
import { InMemoryChainGateway } from "../src/chain/gateway.js";
import {
  issueKycSdJwt,
  presentKycMinimal,
  presentKycWithKeyBinding,
  verifyKycSdJwtPresentation,
  issueReputationSdJwt,
  verifyReputationSdJwtPresentation,
  reputationTierFromBilling,
  KYC_SD_CLAIMS,
  REPUTATION_SD_CLAIMS,
} from "../src/sdjwt.js";
import { issuerAddressFromIdentifier } from "../src/credentialHash.js";

describe("SD-JWT 選擇性揭露 (M2.0)", () => {
  let agent: ChainTrustAgent;
  let issuer: Awaited<ReturnType<typeof createIssuerDid>>;
  let holder: Awaited<ReturnType<typeof createHolderDid>>;
  let chain: InMemoryChainGateway;

  beforeAll(async () => {
    agent = createVeramoAgent();
    issuer = await createIssuerDid(agent);
    holder = await createHolderDid(agent);
    chain = new InMemoryChainGateway();
    await chain.setTrustedIssuer(issuerAddressFromIdentifier(issuer), true);
  });

  async function freshVc() {
    return issueKycSdJwt(
      {
        issuer,
        holderDid: holder.did,
        subject: { kycLevel: 2, over18: true, country: "TW", fullName: "王小明", birthDate: "1990-01-01" },
      },
      agent
    );
  }

  it("最小揭露：只揭露 kycLevel，其餘 PII 不存在於出示內容", async () => {
    const vc = await freshVc();
    const pres = await presentKycMinimal(vc, ["kycLevel"]);
    const r = await verifyKycSdJwtPresentation(chain, pres, { minKycLevel: 2 });

    expect(r.ok).toBe(true);
    expect(r.disclosed).toEqual(["kycLevel"]);
    const keys = Object.keys(r.payload ?? {});
    for (const hidden of ["fullName", "birthDate", "country", "over18"]) {
      expect(keys).not.toContain(hidden);
    }
    // 仍走完整信任 + 撤銷檢查 + 述詞
    expect(r.checks).toEqual({
      signature: true,
      trustedIssuer: true,
      notRevoked: true,
      predicate: true,
    });
  });

  it("withheld 清單涵蓋所有未揭露的 SD claim", async () => {
    const vc = await freshVc();
    const pres = await presentKycMinimal(vc, ["kycLevel"]);
    const r = await verifyKycSdJwtPresentation(chain, pres);
    const expectedWithheld = KYC_SD_CLAIMS.filter((k) => k !== "kycLevel");
    expect(r.withheld.sort()).toEqual([...expectedWithheld].sort());
  });

  it("撤銷後 SD-JWT 出示驗證失敗 (notRevoked=false)", async () => {
    const vc = await freshVc();
    const pres = await presentKycMinimal(vc, ["kycLevel"]);
    const ok = await verifyKycSdJwtPresentation(chain, pres, { minKycLevel: 2 });
    expect(ok.ok).toBe(true);

    const key = (ok.payload as any).credentialStatus.revocationKey;
    await chain.revoke(key);
    const r = await verifyKycSdJwtPresentation(chain, pres, { minKycLevel: 2 });
    expect(r.ok).toBe(false);
    expect(r.checks.notRevoked).toBe(false);
  });

  it("述詞不滿足：未揭露 kycLevel → predicate=false", async () => {
    const vc = await freshVc();
    // 不揭露任何 SD claim
    const pres = await presentKycMinimal(vc, []);
    const r = await verifyKycSdJwtPresentation(chain, pres, { minKycLevel: 2 });
    expect(r.ok).toBe(false);
    expect(r.checks.predicate).toBe(false);
    expect(r.disclosed).toEqual([]);
  });
});

describe("FinancialReputationCredential 普惠信譽 (SD-JWT)", () => {
  let agent: ChainTrustAgent;
  let issuer: Awaited<ReturnType<typeof createIssuerDid>>;
  let holder: Awaited<ReturnType<typeof createHolderDid>>;
  let chain: InMemoryChainGateway;

  beforeAll(async () => {
    agent = createVeramoAgent();
    issuer = await createIssuerDid(agent);
    holder = await createHolderDid(agent);
    chain = new InMemoryChainGateway();
    await chain.setTrustedIssuer(issuerAddressFromIdentifier(issuer), true);
  });

  it("tier 規則：多年準時繳費=3；一年以上尚可=2；否則=1", () => {
    const base = { avgMonthlyBillBand: "x", carrier: "c" };
    expect(
      reputationTierFromBilling({ ...base, tenureMonths: 78, onTimeRatio: 0.98, latePayments12m: 0 })
    ).toBe(3);
    expect(
      reputationTierFromBilling({ ...base, tenureMonths: 18, onTimeRatio: 0.9, latePayments12m: 2 })
    ).toBe(2);
    expect(
      reputationTierFromBilling({ ...base, tenureMonths: 6, onTimeRatio: 0.99, latePayments12m: 0 })
    ).toBe(1);
  });

  it("最小揭露：只揭露 reputationTier，繳費明細不存在於出示內容", async () => {
    const vc = await issueReputationSdJwt({ issuer, holderDid: holder.did }, agent);
    const pres = await presentKycMinimal(vc, ["reputationTier"]);
    const r = await verifyReputationSdJwtPresentation(chain, pres, { minTier: 2 });

    expect(r.ok).toBe(true);
    expect(r.disclosed).toEqual(["reputationTier"]);
    const keys = Object.keys(r.payload ?? {});
    for (const hidden of ["tenureMonths", "onTimeRatio", "avgMonthlyBillBand"]) {
      expect(keys).not.toContain(hidden);
    }
    expect(r.checks).toEqual({
      signature: true,
      trustedIssuer: true,
      notRevoked: true,
      predicate: true,
    });
  });

  it("withheld 清單涵蓋所有未揭露的信譽 SD claim", async () => {
    const vc = await issueReputationSdJwt({ issuer, holderDid: holder.did }, agent);
    const pres = await presentKycMinimal(vc, ["reputationTier"]);
    const r = await verifyReputationSdJwtPresentation(chain, pres);
    const expectedWithheld = REPUTATION_SD_CLAIMS.filter((k) => k !== "reputationTier");
    expect(r.withheld.sort()).toEqual([...expectedWithheld].sort());
  });

  it("信譽不足（tier 1）→ predicate=false", async () => {
    const vc = await issueReputationSdJwt(
      {
        issuer,
        holderDid: holder.did,
        billingOverride: {
          tenureMonths: 3,
          onTimeRatio: 0.7,
          latePayments12m: 4,
          avgMonthlyBillBand: "NT$0–999",
          carrier: "中華電信 (mock)",
        },
      },
      agent
    );
    const pres = await presentKycMinimal(vc, ["reputationTier"]);
    const r = await verifyReputationSdJwtPresentation(chain, pres, { minTier: 2 });
    expect(r.ok).toBe(false);
    expect(r.checks.predicate).toBe(false);
    expect(r.reason).toMatch(/reputationTier/);
  });

  it("撤銷後信譽出示驗證失敗 (notRevoked=false)", async () => {
    const vc = await issueReputationSdJwt({ issuer, holderDid: holder.did }, agent);
    const pres = await presentKycMinimal(vc, ["reputationTier"]);
    const ok = await verifyReputationSdJwtPresentation(chain, pres);
    expect(ok.ok).toBe(true);

    const key = (ok.payload as any).credentialStatus.revocationKey;
    await chain.revoke(key);
    const r = await verifyReputationSdJwtPresentation(chain, pres);
    expect(r.ok).toBe(false);
    expect(r.checks.notRevoked).toBe(false);
  });
});

describe("SD-JWT key binding (階段 B)", () => {
  let agent: ChainTrustAgent;
  let issuer: Awaited<ReturnType<typeof createIssuerDid>>;
  let holder: Awaited<ReturnType<typeof createHolderDid>>;
  let chain: InMemoryChainGateway;

  const AUD = "chaintrust-verifier";
  const NONCE = "nonce-abc-123";

  beforeAll(async () => {
    agent = createVeramoAgent();
    issuer = await createIssuerDid(agent);
    holder = await createHolderDid(agent);
    chain = new InMemoryChainGateway();
    await chain.setTrustedIssuer(issuerAddressFromIdentifier(issuer), true);
  });

  async function freshVc() {
    return issueKycSdJwt({ issuer, holderDid: holder.did, subject: { kycLevel: 2 } }, agent);
  }

  it("正向：持有者簽 KB → keyBinding 通過、aud/nonce 正確", async () => {
    const vc = await freshVc();
    const pres = await presentKycWithKeyBinding(agent, holder, vc, ["kycLevel"], { aud: AUD, nonce: NONCE });
    const r = await verifyKycSdJwtPresentation(chain, pres, {
      requireKeyBinding: true,
      expectedAud: AUD,
      expectedNonce: NONCE,
    });
    expect(r.ok).toBe(true);
    expect(r.checks.keyBinding).toBe(true);
  });

  it("負向：他人（無持有者私鑰）簽 KB → keyBinding 失敗", async () => {
    const vc = await freshVc(); // cnf 綁 holder
    const attacker = await createHolderDid(agent, "attacker");
    // 攻擊者攔截 VC 後用自己的私鑰簽 KB
    const pres = await presentKycWithKeyBinding(agent, attacker, vc, ["kycLevel"], { aud: AUD, nonce: NONCE });
    const r = await verifyKycSdJwtPresentation(chain, pres, {
      requireKeyBinding: true,
      expectedAud: AUD,
      expectedNonce: NONCE,
    });
    expect(r.ok).toBe(false);
    expect(r.checks.keyBinding).toBe(false);
    expect(r.reason).toMatch(/持有者公鑰不符|key binding/);
  });

  it("負向：nonce 不符 → 失敗（防重放）", async () => {
    const vc = await freshVc();
    const pres = await presentKycWithKeyBinding(agent, holder, vc, ["kycLevel"], { aud: AUD, nonce: NONCE });
    const r = await verifyKycSdJwtPresentation(chain, pres, {
      requireKeyBinding: true,
      expectedAud: AUD,
      expectedNonce: "different-nonce",
    });
    expect(r.ok).toBe(false);
    expect(r.checks.keyBinding).toBe(false);
    expect(r.reason).toMatch(/nonce/);
  });

  it("負向：aud 不符 → 失敗（出示對象錯誤）", async () => {
    const vc = await freshVc();
    const pres = await presentKycWithKeyBinding(agent, holder, vc, ["kycLevel"], { aud: "other-bank", nonce: NONCE });
    const r = await verifyKycSdJwtPresentation(chain, pres, {
      requireKeyBinding: true,
      expectedAud: AUD,
      expectedNonce: NONCE,
    });
    expect(r.ok).toBe(false);
    expect(r.checks.keyBinding).toBe(false);
    expect(r.reason).toMatch(/aud/);
  });

  it("負向：要求 KB 但出示無 KB → 失敗", async () => {
    const vc = await freshVc();
    const pres = await presentKycMinimal(vc, ["kycLevel"]); // 無 KB
    const r = await verifyKycSdJwtPresentation(chain, pres, { requireKeyBinding: true, expectedAud: AUD });
    expect(r.ok).toBe(false);
    expect(r.checks.keyBinding).toBe(false);
  });
});
