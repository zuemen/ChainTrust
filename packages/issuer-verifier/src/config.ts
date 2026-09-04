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
  // 呼叫 AI 服務的逾時。分成兩個是因為兩條路徑的取捨不同：
  //  - score：使用者正在等待驗證結果，逾時要有上限，寧可降級成 review。
  //  - metrics：錢包載入時呼叫，沒有人在等，可以放長；這條路徑同時擔任
  //    「把睡著的 AI 服務叫醒」的角色。
  // 背景：免費方案的 PaaS（如 Render）閒置會休眠，冷啟動實測約 33–50 秒。
  // 舊版兩條路徑都寫死 5 秒 —— 每次請求都在 5 秒被 abort，容器永遠來不及
  // 開機完成，反詐功能會一直停在「服務不可用」而且無法自行恢復。
  aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 15000),
  aiMetricsTimeoutMs: Number(process.env.AI_METRICS_TIMEOUT_MS ?? 60000),
  // 啟動時先送一次暖機請求（不阻塞啟動）；0 為關閉。
  aiWarmupTimeoutMs: Number(process.env.AI_WARMUP_TIMEOUT_MS ?? 60000),
  // 週期性 keepalive，避免 demo 進行到一半 AI 服務睡著；0 為關閉。
  aiKeepaliveMs: Number(process.env.AI_KEEPALIVE_MS ?? 0),
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
  // 部署網路名（對應 contracts/deployments/<network>.json），與 ETHR_NETWORK 解耦但預設一致
  deploymentNetwork: process.env.DEPLOYMENT_NETWORK ?? "amoy",
  // LEGACY：伺服器代簽 KB 的 /sdjwt/present（簽章機），預設關閉，僅 e2e 需要時開
  enableLegacyPresent: process.env.ENABLE_LEGACY_PRESENT === "1",
  // 階段 C：CORS 允許來源（預設僅錢包前端）
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  // 階段 B：本驗證方 aud 識別
  verifierAud: process.env.VERIFIER_AUD ?? "chaintrust-verifier",
};
