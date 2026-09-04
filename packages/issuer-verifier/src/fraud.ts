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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? config.aiTimeoutMs);
  try {
    let body: TxContext & { threat_intel_hit?: boolean } = ctx;
    if (ctx.payee_account_id) {
      const adapter = opts?.threatIntelAdapter ?? new MockThreatIntelAdapter();
      const intel = await adapter.lookup(ctx.payee_account_id);
      body = { ...ctx, threat_intel_hit: intel.hit };
    }
    const res = await doFetch(`${baseUrl}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { risk: null, decision: "review", reasons: [`FRAUD_HTTP_${res.status}`], source: "unavailable" };
    }
    const responseBody = (await res.json()) as RiskAssessment;
    return responseBody;
  } catch (e: any) {
    return {
      risk: null,
      decision: "review",
      reasons: ["FRAUD_SERVICE_UNAVAILABLE"],
      source: "unavailable",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 取得 AI 模型評估報告（PR-AUC、校準、基線、CHT 增益）。供前端可信度報告/簡報。 */
export async function fetchMetrics(
  opts?: { baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch }
): Promise<{ available: boolean; model_loaded?: boolean; metrics?: unknown; reason?: string }> {
  const baseUrl = opts?.baseUrl ?? config.aiServiceUrl;
  const doFetch = opts?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? config.aiMetricsTimeoutMs);
  try {
    const res = await doFetch(`${baseUrl}/metrics`, { signal: controller.signal });
    // 帶上 reason：部署後只看到 available:false 無從判斷是網址設錯、服務睡著
    // 還是模型沒載入，排查時只能靠猜。
    if (!res.ok) return { available: false, reason: `http_${res.status}` };
    return (await res.json()) as { available: boolean; model_loaded?: boolean; metrics?: unknown };
  } catch (e: unknown) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return { available: false, reason: aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? config.aiWarmupTimeoutMs);
  try {
    const res = await doFetch(`${baseUrl}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
