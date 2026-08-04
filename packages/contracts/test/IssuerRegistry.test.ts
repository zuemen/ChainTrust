import { expect } from "chai";
import { ethers } from "hardhat";

describe("IssuerRegistry", () => {
  async function deploy() {
    const [owner, issuer, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("IssuerRegistry");
    const registry = await Factory.deploy();
    await registry.waitForDeployment();
    return { registry, owner, issuer, other };
  }

  it("owner 設為部署者", async () => {
    const { registry, owner } = await deploy();
    expect(await registry.owner()).to.equal(owner.address);
  });

  it("預設未信任", async () => {
    const { registry, issuer } = await deploy();
    expect(await registry.isTrustedIssuer(issuer.address)).to.equal(false);
  });

  it("owner 可信任 issuer 並發事件", async () => {
    const { registry, issuer } = await deploy();
    await expect(registry.setTrustedIssuer(issuer.address, true))
      .to.emit(registry, "IssuerTrustChanged")
      .withArgs(issuer.address, true);
    expect(await registry.isTrustedIssuer(issuer.address)).to.equal(true);
  });

  it("owner 可取消信任", async () => {
    const { registry, issuer } = await deploy();
    await registry.setTrustedIssuer(issuer.address, true);
    await registry.setTrustedIssuer(issuer.address, false);
    expect(await registry.isTrustedIssuer(issuer.address)).to.equal(false);
  });

  it("非 owner 不可設定（revert）", async () => {
    const { registry, issuer, other } = await deploy();
    await expect(
      registry.connect(other).setTrustedIssuer(issuer.address, true)
    ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
  });

  it("不可信任 zero address", async () => {
    const { registry } = await deploy();
    await expect(
      registry.setTrustedIssuer(ethers.ZeroAddress, true)
    ).to.be.revertedWithCustomError(registry, "ZeroIssuer");
  });

  it("批次信任多家機構並各發事件", async () => {
    const { registry, issuer, other } = await deploy();
    await expect(registry.setTrustedIssuers([issuer.address, other.address], true))
      .to.emit(registry, "IssuerTrustChanged")
      .withArgs(issuer.address, true)
      .and.to.emit(registry, "IssuerTrustChanged")
      .withArgs(other.address, true);
    expect(await registry.isTrustedIssuer(issuer.address)).to.equal(true);
    expect(await registry.isTrustedIssuer(other.address)).to.equal(true);
  });

  it("批次設定含 zero address 整筆 revert", async () => {
    const { registry, issuer } = await deploy();
    await expect(
      registry.setTrustedIssuers([issuer.address, ethers.ZeroAddress], true)
    ).to.be.revertedWithCustomError(registry, "ZeroIssuer");
  });

  it("非 owner 不可批次設定（revert）", async () => {
    const { registry, issuer, other } = await deploy();
    await expect(
      registry.connect(other).setTrustedIssuers([issuer.address], true)
    ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
  });

  // === _set no-op 短路 ===
  describe("_set no-op 短路", () => {
    it("重複設為 true 不再發事件", async () => {
      const { registry, issuer } = await deploy();
      await registry.setTrustedIssuer(issuer.address, true);
      await expect(registry.setTrustedIssuer(issuer.address, true)).to.not.emit(
        registry,
        "IssuerTrustChanged"
      );
      expect(await registry.isTrustedIssuer(issuer.address)).to.equal(true);
    });

    it("對從未信任者設為 false 不發事件", async () => {
      const { registry, issuer } = await deploy();
      await expect(registry.setTrustedIssuer(issuer.address, false)).to.not.emit(
        registry,
        "IssuerTrustChanged"
      );
      expect(await registry.isTrustedIssuer(issuer.address)).to.equal(false);
    });

    it("no-op 仍檢查 zero address", async () => {
      const { registry } = await deploy();
      await expect(
        registry.setTrustedIssuer(ethers.ZeroAddress, false)
      ).to.be.revertedWithCustomError(registry, "ZeroIssuer");
    });
  });

  // === 擁有權：停用 renounce + 兩步移轉 ===
  describe("擁有權", () => {
    it("renounceOwnership 一律 revert（信任根不可被凍結）", async () => {
      const { registry, other } = await deploy();
      await expect(registry.renounceOwnership()).to.be.revertedWithCustomError(
        registry,
        "RenounceDisabled"
      );
      await expect(
        registry.connect(other).renounceOwnership()
      ).to.be.revertedWithCustomError(registry, "RenounceDisabled");
    });

    it("Ownable2Step：transferOwnership 只設 pending，owner 不變", async () => {
      const { registry, owner, other } = await deploy();
      await expect(registry.transferOwnership(other.address))
        .to.emit(registry, "OwnershipTransferStarted")
        .withArgs(owner.address, other.address);
      expect(await registry.owner()).to.equal(owner.address);
      expect(await registry.pendingOwner()).to.equal(other.address);
    });

    it("Ownable2Step：pending owner accept 後才真正移轉", async () => {
      const { registry, owner, other } = await deploy();
      await registry.transferOwnership(other.address);
      await expect(registry.connect(other).acceptOwnership())
        .to.emit(registry, "OwnershipTransferred")
        .withArgs(owner.address, other.address);
      expect(await registry.owner()).to.equal(other.address);
      expect(await registry.pendingOwner()).to.equal(ethers.ZeroAddress);
      // 新 owner 可設定、舊 owner 不可
      await registry.connect(other).setTrustedIssuer(owner.address, true);
      await expect(
        registry.setTrustedIssuer(owner.address, false)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("Ownable2Step：非 pending owner 不可 accept（revert）", async () => {
      const { registry, issuer, other } = await deploy();
      await registry.transferOwnership(other.address);
      await expect(
        registry.connect(issuer).acceptOwnership()
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });
  });
});
