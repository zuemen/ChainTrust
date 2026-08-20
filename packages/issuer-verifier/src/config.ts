import * as dotenv from "dotenv";
dotenv.config();

/** 執行環境設定。私鑰類一律從 .env 讀，勿入庫。 */
export const config = {
  port: Number(process.env.PORT ?? 3001),
  // 鏈：'memory'（離線 e2e/dev）或 'ethers'（接已部署合約）
  chainMode: (process.env.CHAIN_MODE ?? "memory") as "memory" | "ethers",
  amoyRpcUrl: process.env.AMOY_RPC_URL ?? "https://rpc-amoy.polygon.technology",
  // 接真合約時用：issuer 操作（撤銷）的簽署私鑰；缺則為唯讀
  chainPrivateKey: process.env.CHAIN_PRIVATE_KEY,
  // AI 反詐服務（M2 用）
  aiServiceUrl: process.env.AI_SERVICE_URL ?? "http://localhost:8000",
  // did:ethr 用的網路名稱（落地時換 CHT BaaS）
  ethrNetwork: process.env.ETHR_NETWORK ?? "polygon:amoy",
  ethrChainId: Number(process.env.ETHR_CHAIN_ID ?? 80002),
  // mutating 端點 API 金鑰。fail-closed：未設定時簽發／撤銷端點一律停用，
  // 不再「沒設就放行」（否則忘記設定 API_KEY 就等於把簽發假 KYC 憑證與
  // 撤銷他人憑證的能力公開給任何人）。
  apiKey: process.env.API_KEY,
  // 僅供本機開發：明確設為 "true" 時，才允許在沒有 API_KEY 的情況下放行
  // mutating 端點，且只在 CHAIN_MODE=memory（離線 PoC）下生效。
  allowUnauthenticatedDev: process.env.ALLOW_UNAUTHENTICATED_DEV === "true",
  // 階段 C：CORS 允許來源（預設僅錢包前端）
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  // 階段 B：本驗證方 aud 識別
  verifierAud: process.env.VERIFIER_AUD ?? "chaintrust-verifier",
};
