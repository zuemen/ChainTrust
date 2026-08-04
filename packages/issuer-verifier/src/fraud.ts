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
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 5000);
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
): Promise<{ available: boolean; model_loaded?: boolean; metrics?: unknown }> {
  const baseUrl = opts?.baseUrl ?? config.aiServiceUrl;
  const doFetch = opts?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 5000);
  try {
    const res = await doFetch(`${baseUrl}/metrics`, { signal: controller.signal });
    if (!res.ok) return { available: false };
    return (await res.json()) as { available: boolean; model_loaded?: boolean; metrics?: unknown };
  } catch {
    return { available: false };
  } finally {
    clearTimeout(timer);
  }
}
