import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Amoy 部署後煙霧測試（amoy-deploy-checklist.md 步驟 7）：
 *  1) owner 將 deployer 自身設為受信任 issuer
 *     —— RevocationRegistry.revoke 要求 msg.sender 受信任；
 *        issuer-verifier 的 EthersChainGateway 以 CHAIN_PRIVATE_KEY（= deployer）簽撤銷交易，
 *        故 deployer 位址必須先受信任，e2e/server 的撤銷才走得通。
 *  2) （可選）TRUST_ISSUER=0x... 額外背書一個 issuer 位址（例如 server /health 回傳的 issuerAddr）。
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

  const txRevoke = await revocationRegistry.revoke(testHash);
  await txRevoke.wait();
  console.log(`[smoke] revoke    ✔  ${txLink(txRevoke.hash)}`);
  if (!(await revocationRegistry.isRevoked(testHash))) {
    throw new Error("smoke 失敗：revoke 後 isRevoked 應為 true");
  }
  console.log(`[smoke] isRevoked = true  ✔`);

  const txUnrevoke = await revocationRegistry.unrevoke(testHash);
  await txUnrevoke.wait();
  console.log(`[smoke] unrevoke  ✔  ${txLink(txUnrevoke.hash)}`);
  if (await revocationRegistry.isRevoked(testHash)) {
    throw new Error("smoke 失敗：unrevoke 後 isRevoked 應為 false");
  }
  console.log(`[smoke] isRevoked = false ✔`);

  console.log(`\n✅ Amoy 煙霧測試通過。上述 PolygonScan 連結即為「真的在鏈上」的事證。`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
