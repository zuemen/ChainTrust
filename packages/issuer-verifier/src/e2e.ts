/**
 * M1 端到端示範：
 *  1) 建 Issuer/Holder DID，信任根背書 Issuer
 *  2) 簽發 KYC VC → 驗證「通過」
 *  3) 撤銷 → 驗證「失敗」(notRevoked=false)
 *  4) （加碼）未受信任的 Issuer → 驗證「失敗」
 *
 * 預設用 InMemoryChainGateway（離線可跑）。設 CHAIN_MODE=ethers 可接已部署合約。
 */
import { createVeramoAgent, createIssuerDid, createHolderDid } from "./agent.js";
import {
  InMemoryChainGateway,
  EthersChainGateway,
  loadDeployment,
  type ChainGateway,
} from "./chain/gateway.js";
import { issueKYCCredential, revocationKeyOf } from "./issuer.js";
import { verifyCredential } from "./verifier.js";
import {
  issueKycSdJwt,
  issueReputationSdJwt,
  presentKycMinimal,
  presentKycWithKeyBinding,
  verifyKycSdJwtPresentation,
  verifyReputationSdJwtPresentation,
} from "./sdjwt.js";
import { issuerAddressFromIdentifier } from "./credentialHash.js";
import { MockPublicCaAdapter } from "./adapters/cht.js";
import { config } from "./config.js";

// 小工具
function line(s = "") {
  console.log(s);
}
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`\n❌ 斷言失敗：${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`   ✔ ${msg}`);
}

function makeChain(): ChainGateway {
  if (config.chainMode === "ethers") {
    const dep = loadDeployment("amoy");
    if (!dep) throw new Error("CHAIN_MODE=ethers 但找不到 deployments/amoy.json，請先部署合約");
    return new EthersChainGateway({
      rpcUrl: config.amoyRpcUrl,
      issuerRegistry: dep.contracts.IssuerRegistry,
      revocationRegistry: dep.contracts.RevocationRegistry,
      privateKey: config.chainPrivateKey,
    });
  }
  return new InMemoryChainGateway();
}

async function main() {
  line("=== ChainTrust M1 端到端示範 ===");
  line(`鏈模式：${config.chainMode}`);

  const agent = createVeramoAgent();
  const chain = makeChain();
  const publicCa = new MockPublicCaAdapter();

  // 1) DID + 信任根背書
  const issuer = await createIssuerDid(agent);
  const holder = await createHolderDid(agent);
  const issuerAddr = issuerAddressFromIdentifier(issuer);
  line(`\n[1] Issuer DID = ${issuer.did}`);
  line(`    Issuer 位址 = ${issuerAddr}`);
  line(`    Holder DID = ${holder.did}`);

  const anchor = await publicCa.anchorIssuerRoot(issuerAddr);
  line(`    CHT PublicCA 背書：${anchor.anchored}（${anchor.rootAuthority}）`);
  await chain.setTrustedIssuer(issuerAddr, true);
  assert(await chain.isTrustedIssuer(issuerAddr), "IssuerRegistry 已信任此 Issuer");

  // 2) 簽發 + 驗證通過
  line(`\n[2] 簽發 KYCCredential…`);
  const vc = await issueKYCCredential(agent, {
    issuerDid: issuer.did,
    holderDid: holder.did,
    subject: { kycLevel: "full", over18: true, country: "TW" },
  });
  line(`    VC id = ${vc.id}`);
  const r1 = await verifyCredential(agent, chain, vc);
  line(`    驗證結果：${JSON.stringify(r1.checks)}（reason: ${r1.reason ?? "-"}）`);
  assert(r1.ok === true, "未撤銷時驗證通過 (ok=true)");
  assert(r1.checks.signature && r1.checks.trustedIssuer && r1.checks.notRevoked, "三項檢查皆通過");

  // 3) 撤銷 → 驗證失敗
  line(`\n[3] 撤銷此 VC…`);
  const key = revocationKeyOf(vc);
  line(`    撤銷鍵 = ${key}`);
  await chain.revoke(key);
  assert(await chain.isRevoked(key), "RevocationRegistry 顯示已撤銷");
  const r2 = await verifyCredential(agent, chain, vc);
  line(`    驗證結果：${JSON.stringify(r2.checks)}（reason: ${r2.reason}）`);
  assert(r2.ok === false, "撤銷後驗證失敗 (ok=false)");
  assert(r2.checks.notRevoked === false, "notRevoked=false");

  // 4) 未受信任 issuer → 失敗
  line(`\n[4] 另建未受信任 Issuer 簽發…`);
  const rogue = await createIssuerDid(agent, "rogue-issuer");
  const vc2 = await issueKYCCredential(agent, {
    issuerDid: rogue.did,
    holderDid: holder.did,
  });
  const r3 = await verifyCredential(agent, chain, vc2);
  line(`    驗證結果：${JSON.stringify(r3.checks)}（reason: ${r3.reason}）`);
  assert(r3.ok === false && r3.checks.trustedIssuer === false, "未受信任 Issuer 驗證失敗");

  // ── M2.0：SD-JWT 選擇性揭露 ──────────────────────────────
  line(`\n=== M2.0 SD-JWT 選擇性揭露 ===`);
  const sdVc = await issueKycSdJwt(
    {
      issuer,
      holderDid: holder.did,
      subject: { kycLevel: 2, over18: true, country: "TW", fullName: "王小明", birthDate: "1990-01-01" },
    },
    agent
  );
  line(`[5] 簽發 SD-JWT KYCCredential（${sdVc.split("~").length - 2} 個可選擇揭露欄位）`);

  // Holder 只揭露 kycLevel（供「kycLevel>=2」述詞），其餘 PII 不洩
  const pres = await presentKycMinimal(sdVc, ["kycLevel"]);
  const sd1 = await verifyKycSdJwtPresentation(chain, pres, { minKycLevel: 2 });
  line(`    實際揭露欄位：[${sd1.disclosed.join(", ")}]`);
  line(`    未揭露(隱藏)欄位：[${sd1.withheld.join(", ")}]`);
  line(`    出示內容 payload keys：[${Object.keys(sd1.payload ?? {}).join(", ")}]`);
  line(`    驗證結果：${JSON.stringify(sd1.checks)}`);
  assert(sd1.ok === true, "最小揭露出示驗證通過（含 kycLevel>=2 述詞）");
  assert(sd1.disclosed.length === 1 && sd1.disclosed[0] === "kycLevel", "只揭露 kycLevel");
  const payloadKeys = Object.keys(sd1.payload ?? {});
  for (const hidden of ["fullName", "birthDate", "country", "over18"]) {
    assert(!payloadKeys.includes(hidden), `未揭露欄位不存在於出示內容：${hidden}`);
  }
  assert(sd1.checks.trustedIssuer && sd1.checks.notRevoked, "SD-JWT 仍走 isTrustedIssuer + isRevoked");

  // 撤銷該 SD-JWT VC → 驗證失敗
  line(`\n[6] 撤銷 SD-JWT VC…`);
  const sdKey = (sd1.payload as any).credentialStatus.revocationKey;
  await chain.revoke(sdKey);
  const sd2 = await verifyKycSdJwtPresentation(chain, pres, { minKycLevel: 2 });
  line(`    驗證結果：${JSON.stringify(sd2.checks)}（reason: ${sd2.reason}）`);
  assert(sd2.ok === false && sd2.checks.notRevoked === false, "撤銷後 SD-JWT 出示驗證失敗");

  // ── 階段 B：SD-JWT key binding ──────────────────────────
  line(`\n=== 階段B SD-JWT key binding ===`);
  const kbVc = await issueKycSdJwt({ issuer, holderDid: holder.did, subject: { kycLevel: 2 } }, agent);
  const AUD = "chaintrust-verifier";
  const NONCE = "demo-nonce-001";
  line(`[7] 持有者以私鑰簽 KB-JWT 出示（aud=${AUD}）`);
  const kbPres = await presentKycWithKeyBinding(agent, holder, kbVc, ["kycLevel"], { aud: AUD, nonce: NONCE });
  const kb1 = await verifyKycSdJwtPresentation(chain, kbPres, {
    requireKeyBinding: true, expectedAud: AUD, expectedNonce: NONCE,
  });
  line(`    驗證結果：${JSON.stringify(kb1.checks)}`);
  assert(kb1.ok === true && kb1.checks.keyBinding === true, "持有者 KB 出示驗證通過");

  line(`[8] 攻擊者攔截後以自己私鑰簽 KB（無持有者私鑰）`);
  const attacker = await createHolderDid(agent, "attacker");
  const evilPres = await presentKycWithKeyBinding(agent, attacker, kbVc, ["kycLevel"], { aud: AUD, nonce: NONCE });
  const kb2 = await verifyKycSdJwtPresentation(chain, evilPres, {
    requireKeyBinding: true, expectedAud: AUD, expectedNonce: NONCE,
  });
  line(`    驗證結果：${JSON.stringify(kb2.checks)}（reason: ${kb2.reason}）`);
  assert(kb2.ok === false && kb2.checks.keyBinding === false, "轉手出示（他人私鑰）被擋下");

  // ── 普惠金融：電信繳費信譽 VC ───────────────────────────
  line(`\n=== 普惠金融 FinancialReputationCredential ===`);
  line(`[9] 以電信繳費紀錄簽發信譽 VC（無聯徵者的替代信用）…`);
  const repVc = await issueReputationSdJwt({ issuer, holderDid: holder.did }, agent);
  const repPres = await presentKycMinimal(repVc, ["reputationTier"]);
  const rep = await verifyReputationSdJwtPresentation(chain, repPres, { minTier: 2 });
  line(`    實際揭露欄位：[${rep.disclosed.join(", ")}]`);
  line(`    未揭露(隱藏)欄位：[${rep.withheld.join(", ")}]`);
  line(`    驗證結果：${JSON.stringify(rep.checks)}`);
  assert(rep.ok === true, "信譽出示驗證通過（reputationTier>=2 述詞）");
  assert(rep.disclosed.length === 1 && rep.disclosed[0] === "reputationTier", "只揭露 reputationTier");
  for (const hidden of ["tenureMonths", "onTimeRatio", "avgMonthlyBillBand"]) {
    assert(!(hidden in (rep.payload ?? {})), `繳費明細不存在於出示內容：${hidden}`);
  }

  line(`[10] 信譽不足者（在網 3 個月、常逾繳）出示 → 述詞擋下`);
  const lowVc = await issueReputationSdJwt(
    {
      issuer,
      holderDid: holder.did,
      billingOverride: {
        tenureMonths: 3, onTimeRatio: 0.7, latePayments12m: 4,
        avgMonthlyBillBand: "NT$0–999", carrier: "中華電信 (mock)",
      },
    },
    agent
  );
  const lowPres = await presentKycMinimal(lowVc, ["reputationTier"]);
  const low = await verifyReputationSdJwtPresentation(chain, lowPres, { minTier: 2 });
  line(`    驗證結果：${JSON.stringify(low.checks)}（reason: ${low.reason}）`);
  assert(low.ok === false && low.checks.predicate === false, "信譽等級不足被述詞擋下");

  line("\n✅ M1 + M2.0 + 階段B + 普惠信譽 e2e 全數通過。");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
