import { describe, it, expect, beforeAll } from "vitest";
import {
  createVeramoAgent,
  createIssuerDid,
  createHolderDid,
  type ChainTrustAgent,
} from "../src/agent.js";
import { InMemoryChainGateway } from "../src/chain/gateway.js";
import { issueKYCCredential, revocationKeyOf } from "../src/issuer.js";
import { verifyCredential, issuerAddressFromDid } from "../src/verifier.js";
import { issuerAddressFromIdentifier } from "../src/credentialHash.js";

describe("ChainTrust issuer/verifier 流程", () => {
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
    chain.setRevokeAs(issuerAddressFromIdentifier(issuer));
  });

  it("verifier 由 did:key 推導的位址與 issuer identifier 一致", () => {
    const fromDid = issuerAddressFromDid(issuer.did);
    const fromId = issuerAddressFromIdentifier(issuer);
    expect(fromDid).toBe(fromId);
  });

  it("受信任 issuer + 未撤銷 → 驗證通過", async () => {
    const vc = await issueKYCCredential(agent, {
      issuerDid: issuer.did,
      holderDid: holder.did,
    });
    const r = await verifyCredential(agent, chain, vc);
    expect(r.ok).toBe(true);
    expect(r.checks).toEqual({ signature: true, trustedIssuer: true, notRevoked: true });
  });

  it("撤銷後 → 驗證失敗 (notRevoked=false)", async () => {
    const vc = await issueKYCCredential(agent, {
      issuerDid: issuer.did,
      holderDid: holder.did,
    });
    expect((await verifyCredential(agent, chain, vc)).ok).toBe(true);
    await chain.revoke(revocationKeyOf(vc));
    const r = await verifyCredential(agent, chain, vc);
    expect(r.ok).toBe(false);
    expect(r.checks.notRevoked).toBe(false);
  });

  it("未受信任 issuer → 驗證失敗 (trustedIssuer=false)", async () => {
    const rogue = await createIssuerDid(agent, "rogue");
    const vc = await issueKYCCredential(agent, {
      issuerDid: rogue.did,
      holderDid: holder.did,
    });
    const r = await verifyCredential(agent, chain, vc);
    expect(r.ok).toBe(false);
    expect(r.checks.trustedIssuer).toBe(false);
  });
});
