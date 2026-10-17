/** issuer-verifier API（經同源代理 /api → issuer-verifier；金鑰由代理層注入）。 */

/**
 * 交易情境 ID。交易內容本身由驗證方伺服器持有（issuer-verifier `src/scenarios.ts`），
 * 錢包只能選情境、不能自帶數值——被攔截的人不該能自己把交易報成正常（2026-08 稽核 H9）。
 */
export type ScenarioId = "normal" | "mule" | "microloan";

export interface TopFactor {
  feature: string;
  label: string;
  impact: number;
}

export interface RiskAssessment {
  risk: number | null;
  decision: "pass" | "review" | "block";
  reasons: string[];
  source: string;
  p_fraud?: number | null;
  anomaly?: number | null;
  confidence?: number | null;
  confidence_band?: "high" | "medium" | "low" | null;
  top_factors?: TopFactor[];
  /** 規則保底把分數往上拉（金流紅旗不得被模型分數抹掉） */
  rule_floor_applied?: boolean;
}

/** AI 模型評估報告（GET /metrics）。 */
export interface ModelMetrics {
  primary_metric?: string;
  fraud_prevalence?: number;
  holdout_pr_auc?: number;
  holdout_roc_auc?: number;
  recall_at_fpr_1pct?: number;
  precision_at_100?: number;
  mcc?: number;
  rows?: number;
  fraud?: number;
  source?: string;
  calibration_quality?: { ece: number; brier: number; reliability_curve?: unknown[] };
  baselines?: Record<string, { pr_auc: number; roc_auc: number }>;
  cht_signal_ablation?: {
    without_cht_pr_auc: number;
    with_cht_pr_auc: number;
    lift_pr_auc: number;
    lift_pct: number;
    signals: string[];
    /** 證據等級：simulation = 由以標籤為條件生成的合成訊號推得，非真實效度 */
    evidence_grade?: string;
    caveat_zh?: string;
  };
}

export interface MetricsResponse {
  available: boolean;
  model_loaded?: boolean;
  metrics?: ModelMetrics;
}

export interface SdJwtVerifyResult {
  ok: boolean;
  checks: { signature: boolean; trustedIssuer: boolean; notRevoked: boolean; predicate: boolean; keyBinding?: boolean };
  disclosed: string[];
  withheld: string[];
  payload?: Record<string, unknown>;
  reason?: string;
}

export interface VerifyResponse {
  verify: SdJwtVerifyResult;
  risk?: RiskAssessment;
  outcome: "approve" | "review" | "reject";
  /** 驗證方實際採用的交易情境 */
  scenario?: ScenarioId;
}

const BASE = "/api";
/** 錯誤訊息只回傳截斷後的內容，避免把整頁 HTML／堆疊灌進 UI */
const MAX_ERR_CHARS = 300;

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, MAX_ERR_CHARS);
    throw new Error(`${path} ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function health(): Promise<{ ok: boolean; issuerDid: string }> {
  const res = await fetch(`${BASE}/health`);
  if (!res.ok) throw new Error(`/health ${res.status}`);
  const j = (await res.json()) as Partial<{ ok: boolean; issuerDid: string }>;
  return { ok: j.ok === true, issuerDid: typeof j.issuerDid === "string" ? j.issuerDid : "" };
}

/**
 * 會等待後端冷啟動的健康檢查。
 *
 * 後端跑在免費方案的雲端服務上，閒置後會休眠，冷啟動實測 30–50 秒，期間平台
 * 的路由層回 502/504 或直接逾時。單次 fetch 會立刻失敗，讓畫面顯示「服務未
 * 連線」——但服務其實只是還沒醒。
 *
 * 對第一次開啟這個網址的人（例如評審）而言，「正在喚醒，請稍候」和「壞掉了」
 * 是天差地別的兩件事，所以改成在時間預算內重試，並回報已等待秒數供 UI 顯示。
 */
export async function healthAwaitingWake(opts?: {
  budgetMs?: number;
  onWaking?: (elapsedSec: number) => void;
}): Promise<{ ok: boolean; issuerDid: string }> {
  const started = Date.now();
  const deadline = started + (opts?.budgetMs ?? 90_000);
  let lastError: unknown = new Error("unreachable");
  for (;;) {
    try {
      return await health();
    } catch (e) {
      lastError = e;
    }
    if (Date.now() >= deadline) break;
    opts?.onWaking?.(Math.round((Date.now() - started) / 1000));
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw lastError;
}

export async function issueKyc(
  holderDid: string,
  subject?: Record<string, unknown>
): Promise<{ vc: string; holderDid: string; issuerDid: string }> {
  // holderDid 由瀏覽器端金鑰推導（keys.ts）——伺服器不再代管持有者金鑰
  return postJson("/sdjwt/issue", { holderDid, subject });
}

/**
 * 向驗證方取一次性 nonce（防重放）；aud 為驗證方識別。
 * 這兩個值會被顯示在同意畫面並簽進 KB-JWT，因此型別必須先驗過再回傳。
 */
export async function getNonce(): Promise<{ nonce: string; aud: string }> {
  const r = await postJson<Partial<{ nonce: string; aud: string }>>("/sdjwt/nonce", {});
  if (typeof r.nonce !== "string" || !r.nonce || typeof r.aud !== "string" || !r.aud) {
    throw new Error("驗證方回傳的挑戰（nonce/aud）格式不正確，已中止出示。");
  }
  return { nonce: r.nonce, aud: r.aud };
}

/** 第二發證者：中華電信門號電子卡（W3C JWT VC，mock adapter） */
export interface MobileVc {
  credentialSubject: {
    id: string;
    msisdnVerified: boolean;
    carrier: string;
    realName: string;
    msisdnMasked: string;
  };
  issuer: { id: string } | string;
}
export async function issueMobile(
  holderDid: string,
  msisdn: string
): Promise<{ vc: MobileVc; revocationKey: string }> {
  return postJson("/issue/mobile", { holderDid, msisdn });
}

/** 普惠金融：以電信繳費紀錄申請財務信譽 VC（同一 holderDid 可與 KYC 憑證共存） */
export async function issueReputation(holderDid?: string): Promise<{
  vc: string;
  holderDid: string;
  issuerDid: string;
}> {
  return postJson("/sdjwt/issue-reputation", { holderDid });
}

export type PresentationKind = "kyc" | "reputation";

export async function verifyPresentation(
  presentation: string,
  scenario: ScenarioId,
  kind: PresentationKind = "kyc",
  opts?: { nonce?: string }
): Promise<VerifyResponse> {
  // 驗證政策（KB 必驗、aud）與交易脈絡一律由伺服器決定；前端只回傳挑戰 nonce 與情境 ID。
  return postJson("/sdjwt/verify", { presentation, scenario, kind, nonce: opts?.nonce });
}

export async function getMetrics(): Promise<MetricsResponse> {
  const res = await fetch(`${BASE}/metrics`);
  if (!res.ok) return { available: false };
  return res.json() as Promise<MetricsResponse>;
}
