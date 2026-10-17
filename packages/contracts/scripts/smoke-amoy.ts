import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Amoy 部署後煙霧測試（amoy-deploy-checklist.md 步驟 7）：
 *  1) owner 將 deployer 自身設為受信任 issuer
 *     —— issuer-verifier 在 ethers 模式下，若未另設 ISSUER_PRIVATE_KEY，就以 CHAIN_PRIVATE_KEY
 *        （= deployer）作為「銀行 A」發證者金鑰：憑證由它簽、撤銷交易也由它送。
 *        RevocationRegistry 以 msg.sender 為撤銷命名空間、revoke 要求 msg.sender 受信任，
 *        因此 deployer 必須先受信任，簽發→撤銷→驗證才對得上同一個位址。
 *  2) （可選）TRUST_ISSUER=0x... 額外背書一個 issuer 位址（例如另設的 CHT_ISSUER_PRIVATE_KEY
 *     對應位址，可由 server 的 /info 查到 chtIssuerAddr）。
 *  3) revoke → isRevoked=true → unrevoke → isRevoked=false，各步印 PolygonScan 交易連結。
 * 用法：pnpm --filter @chaintrust/contracts smoke:amoy
 */

const SCAN = "https://amoy.polygonscan.com";

function txLink(hash: string) {
  return `${SCAN}/tx/${hash}`;
}

async function main() {
  const net = network.name;
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    console.error(
      `\n[smoke] 網路 "${net}" 沒有可用帳戶。請在 packages/contracts/.env 設定 DEPLOYER_PRIVATE_KEY。\n`
    );
    process.exitCode = 1;
    return;
  }
  const signer = signers[0];

  const file = path.join(__dirname, "..", "deployments", `${net}.json`);
  if (!fs.existsSync(file)) {
    console.error(`\n[smoke] 找不到 ${file}，請先執行 deploy:amoy。\n`);
    process.exitCode = 1;
    return;
  }
  const dep = JSON.parse(fs.readFileSync(file, "utf-8"));
  const issuerRegistryAddr: string = dep.contracts.IssuerRegistry;
  const revocationRegistryAddr: string = dep.contracts.RevocationRegistry;

  console.log(`[smoke] network=${net}`);
  console.log(`[smoke] signer=${signer.address}`);
  console.log(`[smoke] IssuerRegistry     = ${SCAN}/address/${issuerRegistryAddr}`);
  console.log(`[smoke] RevocationRegistry = ${SCAN}/address/${revocationRegistryAddr}`);

  const issuerRegistry = await ethers.getContractAt("IssuerRegistry", issuerRegistryAddr, signer);
  const revocationRegistry = await ethers.getContractAt(
    "RevocationRegistry",
    revocationRegistryAddr,
    signer
  );

  // 1) deployer 自身受信任（撤銷交易的 msg.sender）
  if (!(await issuerRegistry.isTrustedIssuer(signer.address))) {
    const tx = await issuerRegistry.setTrustedIssuer(signer.address, true);
    await tx.wait();
    console.log(`[smoke] setTrustedIssuer(deployer)  ✔  ${txLink(tx.hash)}`);
  } else {
    console.log(`[smoke] deployer 已受信任，略過背書`);
  }

  // 2) 可選：背書額外 issuer 位址（例如 issuer-verifier 的 Veramo issuer）
  const extra = process.env.TRUST_ISSUER;
  if (extra) {
    const addr = ethers.getAddress(extra);
    if (!(await issuerRegistry.isTrustedIssuer(addr))) {
      const tx = await issuerRegistry.setTrustedIssuer(addr, true);
      await tx.wait();
      console.log(`[smoke] setTrustedIssuer(${addr})  ✔  ${txLink(tx.hash)}`);
    } else {
      console.log(`[smoke] ${addr} 已受信任，略過背書`);
    }
  }

  // 3) 撤銷/復原一筆測試 hash，確認鏈上事件
  const testHash = ethers.keccak256(ethers.toUtf8Bytes(`smoke-${Date.now()}`));
  console.log(`[smoke] 測試 credentialHash = ${testHash}`);

  // 撤銷狀態以 issuer 命名空間隔離，查詢一律帶上簽發者位址（此處 = signer）
  const txRevoke = await revocationRegistry.revoke(testHash);
  await txRevoke.wait();
  console.log(`[smoke] revoke    ✔  ${txLink(txRevoke.hash)}`);
  if (!(await revocationRegistry.isRevoked(signer.address, testHash))) {
    throw new Error("smoke 失敗：revoke 後 isRevoked 應為 true");
  }
  console.log(`[smoke] isRevoked(signer, hash) = true  ✔`);

  const txUnrevoke = await revocationRegistry.unrevoke(testHash);
  await txUnrevoke.wait();
  console.log(`[smoke] unrevoke  ✔  ${txLink(txUnrevoke.hash)}`);
  if (await revocationRegistry.isRevoked(signer.address, testHash)) {
    throw new Error("smoke 失敗：unrevoke 後 isRevoked 應為 false");
  }
  console.log(`[smoke] isRevoked(signer, hash) = false ✔`);

  console.log(`\n✅ Amoy 煙霧測試通過。上述 PolygonScan 連結即為「真的在鏈上」的事證。`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
