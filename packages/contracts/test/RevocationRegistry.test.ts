import { expect } from "chai";
import { ethers } from "hardhat";

describe("RevocationRegistry", () => {
  const HASH = ethers.keccak256(ethers.toUtf8Bytes("kyc-vc-001"));

  // 部署 IssuerRegistry 並背書 issuer / otherIssuer；outsider 為未受信任位址。
  async function deploy() {
    const [issuer, otherIssuer, outsider] = await ethers.getSigners();
    const IR = await ethers.getContractFactory("IssuerRegistry");
    const issuerRegistry = await IR.deploy(); // owner = issuer(signer0)
    await issuerRegistry.waitForDeployment();
    await issuerRegistry.setTrustedIssuer(issuer.address, true);
    await issuerRegistry.setTrustedIssuer(otherIssuer.address, true);

    const Factory = await ethers.getContractFactory("RevocationRegistry");
    const registry = await Factory.deploy(await issuerRegistry.getAddress());
    await registry.waitForDeployment();
    return { registry, issuerRegistry, issuer, otherIssuer, outsider };
  }

  it("預設未撤銷", async () => {
    const { registry, issuer } = await deploy();
    expect(await registry.isRevoked(issuer.address, HASH)).to.equal(false);
  });

  it("受信任 issuer 撤銷後 isRevoked=true + 發事件（事件帶 issuer）", async () => {
    const { registry, issuer } = await deploy();
    await expect(registry.revoke(HASH))
      .to.emit(registry, "CredentialRevoked")
      .withArgs(issuer.address, HASH);
    expect(await registry.isRevoked(issuer.address, HASH)).to.equal(true);
  });

  it("未受信任位址不可撤銷（revert）— 杜絕任意第三方惡意撤銷", async () => {
    const { registry, issuer, outsider } = await deploy();
    await expect(
      registry.connect(outsider).revoke(HASH)
    ).to.be.revertedWithCustomError(registry, "UntrustedIssuer");
    expect(await registry.isRevoked(issuer.address, HASH)).to.equal(false);
    expect(await registry.isRevoked(outsider.address, HASH)).to.equal(false);
  });

  it("issuer 可復原自己的撤銷", async () => {
    const { registry, issuer } = await deploy();
    await registry.revoke(HASH);
    await expect(registry.unrevoke(HASH))
      .to.emit(registry, "CredentialUnrevoked")
      .withArgs(issuer.address, HASH);
    expect(await registry.isRevoked(issuer.address, HASH)).to.equal(false);
  });

  // === H12：命名空間隔離 ===
  describe("H12 issuer 命名空間隔離", () => {
    it("受信任 issuer B 撤銷同一 hash，不影響 isRevoked(A, h)", async () => {
      const { registry, issuer, otherIssuer } = await deploy();
      await registry.connect(otherIssuer).revoke(HASH);
      // B 自己的命名空間被標記，A 的完全不受影響
      expect(await registry.isRevoked(otherIssuer.address, HASH)).to.equal(true);
      expect(await registry.isRevoked(issuer.address, HASH)).to.equal(false);
    });

    it("B 搶先撤銷後，A 仍可自行撤銷與復原（不存在搶註冊/前置攻擊）", async () => {
      const { registry, issuer, otherIssuer } = await deploy();
      await registry.connect(otherIssuer).revoke(HASH); // 前置攻擊者搶先
      await expect(registry.revoke(HASH))
        .to.emit(registry, "CredentialRevoked")
        .withArgs(issuer.address, HASH);
      expect(await registry.isRevoked(issuer.address, HASH)).to.equal(true);
      await registry.unrevoke(HASH);
      expect(await registry.isRevoked(issuer.address, HASH)).to.equal(false);
      // B 的紀錄仍在自己的格子裡，A 無法也不需要動它
      expect(await registry.isRevoked(otherIssuer.address, HASH)).to.equal(true);
    });

    it("B 無法復原 A 的撤銷（只寫得到自己的命名空間）", async () => {
      const { registry, issuer, otherIssuer } = await deploy();
      await registry.revoke(HASH);
      await registry.connect(otherIssuer).unrevoke(HASH); // 不 revert，但只動到 B 自己
      expect(await registry.isRevoked(issuer.address, HASH)).to.equal(true);
      expect(await registry.isRevoked(otherIssuer.address, HASH)).to.equal(false);
    });
  });

  // === H13：unrevoke 需受信任 ===
  describe("H13 unrevoke 權限", () => {
    it("未受信任位址不可 unrevoke（revert）", async () => {
      const { registry, outsider } = await deploy();
      await expect(
        registry.connect(outsider).unrevoke(HASH)
      ).to.be.revertedWithCustomError(registry, "UntrustedIssuer");
    });

    it("issuer 被撤銷信任後，revoke 與 unrevoke 皆 revert", async () => {
      const { registry, issuerRegistry, issuer, otherIssuer } = await deploy();
      await registry.connect(otherIssuer).revoke(HASH);
      await issuerRegistry.connect(issuer).setTrustedIssuer(otherIssuer.address, false);

      await expect(
        registry.connect(otherIssuer).revoke(HASH)
      ).to.be.revertedWithCustomError(registry, "UntrustedIssuer");
      await expect(
        registry.connect(otherIssuer).unrevoke(HASH)
      ).to.be.revertedWithCustomError(registry, "UntrustedIssuer");
      // 既有撤銷紀錄維持不變（失去信任不等於自動復效）
      expect(await registry.isRevoked(otherIssuer.address, HASH)).to.equal(true);
    });
  });

  // === 建構子防呆 ===
  describe("建構子", () => {
    it("傳 address(0) revert ZeroRegistry", async () => {
      const Factory = await ethers.getContractFactory("RevocationRegistry");
      await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        Factory,
        "ZeroRegistry"
      );
    });

    it("傳 EOA（無 code）revert ZeroRegistry", async () => {
      const [, , outsider] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("RevocationRegistry");
      await expect(Factory.deploy(outsider.address)).to.be.revertedWithCustomError(
        Factory,
        "ZeroRegistry"
      );
    });
  });

  // === revokeBatch ===
  describe("revokeBatch", () => {
    const hashes = (n: number) =>
      Array.from({ length: n }, (_, i) => ethers.keccak256(ethers.toUtf8Bytes(`vc-${i}`)));

    it("批次撤銷多張 VC 並各發事件", async () => {
      const { registry, issuer } = await deploy();
      const hs = hashes(3);
      await expect(registry.revokeBatch(hs))
        .to.emit(registry, "CredentialRevoked")
        .withArgs(issuer.address, hs[0])
        .and.to.emit(registry, "CredentialRevoked")
        .withArgs(issuer.address, hs[2]);
      for (const h of hs) {
        expect(await registry.isRevoked(issuer.address, h)).to.equal(true);
      }
    });

    it("剛好 MAX_BATCH 筆可通過", async () => {
      const { registry, issuer } = await deploy();
      const max = Number(await registry.MAX_BATCH());
      const hs = hashes(max);
      await registry.revokeBatch(hs);
      expect(await registry.isRevoked(issuer.address, hs[max - 1])).to.equal(true);
    });

    it("超過 MAX_BATCH revert InvalidBatchLength", async () => {
      const { registry } = await deploy();
      const max = Number(await registry.MAX_BATCH());
      await expect(registry.revokeBatch(hashes(max + 1))).to.be.revertedWithCustomError(
        registry,
        "InvalidBatchLength"
      );
    });

    it("空陣列 revert InvalidBatchLength", async () => {
      const { registry } = await deploy();
      await expect(registry.revokeBatch([])).to.be.revertedWithCustomError(
        registry,
        "InvalidBatchLength"
      );
    });

    it("未受信任位址不可批次撤銷（revert）", async () => {
      const { registry, outsider } = await deploy();
      await expect(
        registry.connect(outsider).revokeBatch(hashes(2))
      ).to.be.revertedWithCustomError(registry, "UntrustedIssuer");
    });
  });
});
