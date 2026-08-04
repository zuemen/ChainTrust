/** issuer-verifier API（經 vite proxy /api → :3001）。 */

export interface TxContext {
  amount?: number;
  type?: "CASH_IN" | "CASH_OUT" | "DEBIT" | "PAYMENT" | "TRANSFER";
  oldbalanceOrg?: number;
  newbalanceOrig?: number;
  mobile_realname_verified?: boolean;
  tx_count_1h?: number;
  tx_count_24h?: number;
  device_changed?: boolean;
  geo_jump?: boolean;
  account_age_days?: number;
  payee_risk?: number;
  cross_institution_presentations?: number;
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
  source: string;
  p_fraud?: number | null;
  anomaly?: number | null;
  confidence?: number | null;
  confidence_band?: "high" | "medium" | "low" | null;
  top_factors?: TopFactor[];
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
}

const BASE = "/api";

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function health(): Promise<{ ok: boolean; issuerDid: string }> {
  const res = await fetch(`${BASE}/health`);
  return res.json();
}

export async function issueKyc(
  holderDid: string,
  subject?: Record<string, unknown>
): Promise<{ vc: string; holderDid: string; issuerDid: string }> {
  // holderDid 由瀏覽器端金鑰推導（keys.ts）——伺服器不再代管持有者金鑰
  return postJson("/sdjwt/issue", { holderDid, subject });
}

/** 向驗證方取一次性 nonce（防重放）；aud 為驗證方識別。 */
export async function getNonce(): Promise<{ nonce: string; aud: string }> {
  return postJson("/sdjwt/nonce", {});
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
  tx: TxContext,
  kind: PresentationKind = "kyc",
  opts?: { nonce?: string }
): Promise<VerifyResponse> {
  // 驗證政策（是否強制 key binding、aud）一律由伺服器決定，前端只回傳挑戰用的 nonce。
  return postJson("/sdjwt/verify", { presentation, tx, kind, nonce: opts?.nonce });
}

export async function getMetrics(): Promise<MetricsResponse> {
  const res = await fetch(`${BASE}/metrics`);
  if (!res.ok) return { available: false };
  return res.json() as Promise<MetricsResponse>;
}
