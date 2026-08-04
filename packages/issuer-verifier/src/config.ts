import * as dotenv from "dotenv";
dotenv.config();

const CHAIN_MODES = ["memory", "ethers"] as const;
export type ChainMode = (typeof CHAIN_MODES)[number];

/**
 * 嚴格解析 CHAIN_MODE。
 *
 * 舊版是純型別斷言 `as "memory" | "ethers"`，且 buildChain 只判斷 `=== "ethers"`，
 * 所以把 CHAIN_MODE 打成 "ethersjs"／"Ethers"／多一個空白，服務照常啟動但
 * 信任根其實是一份自己蓋章的記憶體集合 —— 鏈上撤銷完全不生效、驗證恆真。
 */
function parseChainMode(raw: string | undefined): ChainMode {
  const v = (raw ?? "memory").trim();
  if ((CHAIN_MODES as readonly string[]).includes(v)) return v as ChainMode;
  console.error(
    `[config] CHAIN_MODE 不合法：${JSON.stringify(raw)}（僅接受 ${CHAIN_MODES.join(" / ")}）`
  );
  process.exit(1);
}

/** 執行環境設定。私鑰類一律從 .env 讀，勿入庫。 */
export const config = {
  port: Number(process.env.PORT ?? 3001),
  nodeEnv: process.env.NODE_ENV ?? "development",
  // 鏈：'memory'（離線 e2e/dev）或 'ethers'（接已部署合約）
  chainMode: parseChainMode(process.env.CHAIN_MODE),
  amoyRpcUrl: process.env.AMOY_RPC_URL ?? "https://rpc-amoy.polygon.technology",
  // 接真合約時用：issuer 操作（撤銷）的簽署私鑰；缺則為唯讀
  chainPrivateKey: process.env.CHAIN_PRIVATE_KEY,
  // AI 反詐服務（M2 用）
  aiServiceUrl: process.env.AI_SERVICE_URL ?? "http://localhost:8000",
  // did:ethr 用的網路名稱（落地時換 CHT BaaS）
  ethrNetwork: process.env.ETHR_NETWORK ?? "polygon:amoy",
  ethrChainId: Number(process.env.ETHR_CHAIN_ID ?? 80002),
  // 階段 C：mutating 端點 API 金鑰。非 development 環境未設即拒絕啟動（見 server.ts）
  apiKey: process.env.API_KEY,
  // 部署網路名（對應 contracts/deployments/<network>.json），與 ETHR_NETWORK 解耦但預設一致
  deploymentNetwork: process.env.DEPLOYMENT_NETWORK ?? "amoy",
  // LEGACY：伺服器代簽 KB 的 /sdjwt/present（簽章機），預設關閉，僅 e2e 需要時開
  enableLegacyPresent: process.env.ENABLE_LEGACY_PRESENT === "1",
  // 階段 C：CORS 允許來源（預設僅錢包前端）
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  // 階段 B：本驗證方 aud 識別
  verifierAud: process.env.VERIFIER_AUD ?? "chaintrust-verifier",
};
