import { JsonRpcProvider, Wallet, Contract, getAddress } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

/**
 * ChainGateway — 抽象鏈上信任根/撤銷查詢，讓 verifier 與鏈實作解耦。
 * （對應 ADR-007：BaaS 切換以 adapter 完成，呼叫端不變；文件/poc-spec.md 稱此為
 * `BaasAdapter`，程式碼實際命名為 `ChainGateway`，兩者指同一個切換點。）
 *
 * 目標產品：中華電信「區塊鏈即服務平台」（BaaS，雲端 REST API，支援 Ethereum／
 * Hyperledger，機房在 hicloud）。`EthersChainGateway`（見下）已示範以 ethers.js
 * 呼叫任一 EVM 相容 RPC 端點，落地時把 RPC URL 換成 CHT BaaS 的 Ethereum 端點即可，
 * 不需改動此介面或呼叫端。詳見 `docs/completeness-roadmap.md` §3.1（2026-07-21 調研）。
 */
export interface ChainGateway {
  isTrustedIssuer(issuerAddress: string): Promise<boolean>;
  isRevoked(credentialHash: string): Promise<boolean>;
  /** 信任根管理（dev/e2e 或具 owner 權限時可用） */
  setTrustedIssuer(issuerAddress: string, trusted: boolean): Promise<void>;
  /** 由 issuer 撤銷 VC（dev/e2e 或具私鑰時可用） */
  revoke(credentialHash: string): Promise<void>;
  unrevoke(credentialHash: string): Promise<void>;
}

/**
 * 記憶體實作：鏡射合約語意，供離線 e2e / 單元測試使用。
 * 註：此為單一操作者的 dev 鏡射，不強制 IssuerRegistry 信任檢查；
 *     撤銷授權的真正強制在 RevocationRegistry 合約（見 contracts/ 與其測試）。
 */
export class InMemoryChainGateway implements ChainGateway {
  private trusted = new Set<string>();
  private revoked = new Set<string>();

  async isTrustedIssuer(issuerAddress: string): Promise<boolean> {
    return this.trusted.has(getAddress(issuerAddress));
  }
  async isRevoked(credentialHash: string): Promise<boolean> {
    return this.revoked.has(credentialHash.toLowerCase());
  }
  async setTrustedIssuer(issuerAddress: string, trusted: boolean): Promise<void> {
    const a = getAddress(issuerAddress);
    if (trusted) this.trusted.add(a);
    else this.trusted.delete(a);
  }
  async revoke(credentialHash: string): Promise<void> {
    this.revoked.add(credentialHash.toLowerCase());
  }
  async unrevoke(credentialHash: string): Promise<void> {
    this.revoked.delete(credentialHash.toLowerCase());
  }
}

const ISSUER_REGISTRY_ABI = [
  "function setTrustedIssuer(address issuer, bool trusted) external",
  "function isTrustedIssuer(address issuer) external view returns (bool)",
];
const REVOCATION_REGISTRY_ABI = [
  "function revoke(bytes32 credentialHash) external",
  "function unrevoke(bytes32 credentialHash) external",
  "function isRevoked(bytes32 credentialHash) external view returns (bool)",
];

export interface EthersGatewayOptions {
  rpcUrl: string;
  issuerRegistry: string;
  revocationRegistry: string;
  /** 需要寫入（撤銷/設信任）時提供；缺則唯讀 */
  privateKey?: string;
}

/**
 * Ethers 實作：接已部署的 IssuerRegistry / RevocationRegistry。
 */
export class EthersChainGateway implements ChainGateway {
  private provider: JsonRpcProvider;
  private signer?: Wallet;
  private issuerRegistry: Contract;
  private revocationRegistry: Contract;

  constructor(opts: EthersGatewayOptions) {
    this.provider = new JsonRpcProvider(opts.rpcUrl);
    const runner = opts.privateKey
      ? (this.signer = new Wallet(opts.privateKey, this.provider))
      : this.provider;
    this.issuerRegistry = new Contract(opts.issuerRegistry, ISSUER_REGISTRY_ABI, runner);
    this.revocationRegistry = new Contract(
      opts.revocationRegistry,
      REVOCATION_REGISTRY_ABI,
      runner
    );
  }

  async isTrustedIssuer(issuerAddress: string): Promise<boolean> {
    return this.issuerRegistry.isTrustedIssuer(getAddress(issuerAddress));
  }
  async isRevoked(credentialHash: string): Promise<boolean> {
    return this.revocationRegistry.isRevoked(credentialHash);
  }
  private requireSigner() {
    if (!this.signer) throw new Error("EthersChainGateway：唯讀模式，請提供 CHAIN_PRIVATE_KEY");
  }
  async setTrustedIssuer(issuerAddress: string, trusted: boolean): Promise<void> {
    this.requireSigner();
    const tx = await this.issuerRegistry.setTrustedIssuer(getAddress(issuerAddress), trusted);
    await tx.wait();
  }
  async revoke(credentialHash: string): Promise<void> {
    this.requireSigner();
    const tx = await this.revocationRegistry.revoke(credentialHash);
    await tx.wait();
  }
  async unrevoke(credentialHash: string): Promise<void> {
    this.requireSigner();
    const tx = await this.revocationRegistry.unrevoke(credentialHash);
    await tx.wait();
  }
}

/** 讀取 contracts 套件部署輸出（deployments/<network>.json） */
export function loadDeployment(network: string): {
  contracts: { IssuerRegistry: string; RevocationRegistry: string };
} | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, "../../../contracts/deployments", `${network}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}
