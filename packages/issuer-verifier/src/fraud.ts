import { config } from "./config.js";
import { MockThreatIntelAdapter, type ThreatIntelAdapter } from "./adapters/cht.js";

/** 交易／出示情境（對應 ai-service ScoreRequest；欄位缺省由服務端補預設） */
export interface TxContext {
  amount?: number;
  type?: "CASH_IN" | "CASH_OUT" | "DEBIT" | "PAYMENT" | "TRANSFER";
  oldbalanceOrg?: number;
  newbalanceOrig?: number;
  oldbalanceDest?: number;
  newbalanceDest?: number;
  tx_count_1h?: number;
  tx_count_24h?: number;
  device_changed?: boolean;
  mobile_realname_verified?: boolean;
  vc_age_days?: number;
  cross_institution_presentations?: number;
  payee_risk?: number;
  payee_account_id?: string;
  geo_jump?: boolean;
  account_age_days?: number;
}

export interface TopFactor {
  feature: string;
  label: string;
  impact: number;
}

export interface RiskAssessment {
  risk: number | null;
  decision: "pass" | "review" | "block";
  reasons: string[];
  source: "model" | "rules" | "unavailable";
  p_fraud?: number | null;
  anomaly?: number | null;
  confidence?: number | null;
  confidence_band?: "high" | "medium" | "low" | null;
  top_factors?: TopFactor[];
}


/**
 * 冷啟動期間的閘道錯誤：PaaS 的路由層在容器還沒 ready 時會「立刻」回這些狀態碼，
 * 而不是把連線掛著等。因此單純把逾時拉長救不了——必須重試。
 */
const GATEWAY_WAKING = new Set([502, 503, 504]);

/**
 * 會等待上游冷啟動的 fetch。
 *
 * 免費方案的 PaaS 閒置會休眠，冷啟動實測 33 秒；期間路由層立刻回 502。
 * 本函式在總時間預算內反覆重試（網路錯誤與 502/503/504 都算「還在開機」），
 * 讓睡著的服務有機會被喚醒，而不是第一個 502 就宣告失敗。
 */
async function fetchAwaitingWake(
  url: string,
  init: RequestInit,
  o: { budgetMs: number; attemptMs: number; gapMs?: number; fetchImpl: typeof fetch }
): Promise<{ res?: Response; reason?: string }> {
  const deadline = Date.now() + o.budgetMs;
  // 重試間隔隨預算縮放：預算小的時候用小間隔，才不會「只夠試一次」。
  const gap = Math.min(o.gapMs ?? 3000, Math.max(200, Math.floor(o.budgetMs / 6)));
  let last = "unreachable";
  do {
    const controller = new AbortController();
    const attempt = Math.min(o.attemptMs, Math.max(1, deadline - Date.now()));
    const timer = setTimeout(() => controller.abort(), attempt);
    try {
      const res = await o.fetchImpl(url, { ...init, signal: controller.signal });
      if (res.ok) return { res };
      last = `http_${res.status}`;
      // 非閘道類錯誤（400/401/500…）是上游的真實回應，重試沒有意義。
      if (!GATEWAY_WAKING.has(res.status)) return { res, reason: last };
    } catch (e: unknown) {
      last = e instanceof Error && e.name === "AbortError" ? "timeout" : "unreachable";
    } finally {
      clearTimeout(timer);
    }
    if (Date.now() + gap >= deadline) break;
    await new Promise((r) => setTimeout(r, gap));
  } while (Date.now() < deadline);
  return { reason: last };
}

/**
 * 呼叫 AI 反詐服務 POST /score。
 * 服務不可用時不擋驗證流程：回 decision="review" 並標記 FRAUD_SERVICE_UNAVAILABLE。
 */
export async function scoreTransaction(
  ctx: TxContext,
  opts?: {
    baseUrl?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    threatIntelAdapter?: ThreatIntelAdapter;
  }
): Promise<RiskAssessment> {
  const baseUrl = opts?.baseUrl ?? config.aiServiceUrl;
  const doFetch = opts?.fetchImpl ?? fetch;
  const budget = opts?.timeoutMs ?? config.aiTimeoutMs;
  try {
    let body: TxContext & { threat_intel_hit?: boolean } = ctx;
    if (ctx.payee_account_id) {
      const adapter = opts?.threatIntelAdapter ?? new MockThreatIntelAdapter();
      const intel = await adapter.lookup(ctx.payee_account_id);
      body = { ...ctx, threat_intel_hit: intel.hit };
    }
    // 使用者正在等驗證結果，預算要有上限；預算內遇到冷啟動的 502 仍會重試。
    const { res, reason } = await fetchAwaitingWake(
      `${baseUrl}/score`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      { budgetMs: budget, attemptMs: Math.min(budget, 8000), gapMs: 1500, fetchImpl: doFetch }
    );
    if (!res || !res.ok) {
      const code = reason && reason.startsWith("http_") ? `FRAUD_HTTP_${reason.slice(5)}` : "FRAUD_SERVICE_UNAVAILABLE";
      return { risk: null, decision: "review", reasons: [code], source: "unavailable" };
    }
    return (await res.json()) as RiskAssessment;
  } catch {
    return {
      risk: null,
      decision: "review",
      reasons: ["FRAUD_SERVICE_UNAVAILABLE"],
      source: "unavailable",
    };
  }
}

/** 取得 AI 模型評估報告（PR-AUC、校準、基線、CHT 增益）。供前端可信度報告/簡報。 */
export async function fetchMetrics(
  opts?: { baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch }
): Promise<{ available: boolean; model_loaded?: boolean; metrics?: unknown; reason?: string }> {
  const baseUrl = opts?.baseUrl ?? config.aiServiceUrl;
  const doFetch = opts?.fetchImpl ?? fetch;
  const budget = opts?.timeoutMs ?? config.aiMetricsTimeoutMs;
  // 這條路徑沒有人在等，預算放長並允許重試，同時擔任「叫醒睡著的 AI」的角色。
  const { res, reason } = await fetchAwaitingWake(`${baseUrl}/metrics`, {}, {
    budgetMs: budget,
    attemptMs: Math.min(budget, 15000),
    gapMs: 3000,
    fetchImpl: doFetch,
  });
  // 帶上 reason：部署後只看到 available:false 無從判斷是網址設錯、服務睡著
  // 還是模型沒載入，排查時只能靠猜。
  if (!res || !res.ok) return { available: false, reason: reason ?? "unreachable" };
  return (await res.json()) as { available: boolean; model_loaded?: boolean; metrics?: unknown };
}

/**
 * 暖機：對 AI 服務送一次長逾時的 /health，把休眠中的容器叫醒。
 * 免費方案的 PaaS 冷啟動要數十秒，正常請求的逾時遠短於此，因此若沒有這條
 * 專門的長逾時路徑，服務一旦睡著就再也醒不過來。失敗不拋錯（純盡力而為）。
 */
export async function warmUpFraudService(
  opts?: { baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch }
): Promise<boolean> {
  const baseUrl = opts?.baseUrl ?? config.aiServiceUrl;
  const doFetch = opts?.fetchImpl ?? fetch;
  const budget = opts?.timeoutMs ?? config.aiWarmupTimeoutMs;
  const { res } = await fetchAwaitingWake(`${baseUrl}/health`, {}, {
    budgetMs: budget,
    attemptMs: Math.min(budget, 15000),
    gapMs: 3000,
    fetchImpl: doFetch,
  });
  return !!res && res.ok;
}
