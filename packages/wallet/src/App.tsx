import { useEffect, useMemo, useState } from "react";
import {
  issueKyc,
  issueMobile,
  getNonce,
  issueReputation,
  verifyPresentation,
  health,
  getMetrics,
  type TxContext,
  type VerifyResponse,
  type ModelMetrics,
  type MobileVc,
  type PresentationKind,
} from "./api.ts";
import { parseSdJwt, buildPresentationWithKeyBinding, type ParsedSdJwt } from "./sdjwt.ts";
import { ensureHolderKeys } from "./keys.ts";

const VC_KEY = "chaintrust.vc";
const MOBILE_VC_KEY = "chaintrust.mobileVc";
const REP_KEY = "chaintrust.repvc";

// claim 中文標籤與是否屬敏感個資
const CLAIM_LABELS: Record<string, { label: string; pii: boolean }> = {
  kycLevel: { label: "KYC 等級", pii: false },
  over18: { label: "已滿 18 歲", pii: false },
  country: { label: "國籍", pii: true },
  fullName: { label: "真實姓名", pii: true },
  birthDate: { label: "出生日期", pii: true },
  // 普惠信譽憑證：等級可揭露，繳費明細屬敏感資料
  reputationTier: { label: "信譽等級", pii: false },
  tenureMonths: { label: "門號在網月數", pii: true },
  onTimeRatio: { label: "準時繳費比例", pii: true },
  avgMonthlyBillBand: { label: "月均帳單區間", pii: true },
};

const TIER_LABELS: Record<number, string> = { 3: "3（優良）", 2: "2（良好）", 1: "1（待累積）" };

const REASON_LABELS: Record<string, string> = {
  MULE_PATTERN: "人頭金流樣態（大額轉出後帳戶清空）",
  PASS_THROUGH: "過水帳戶（資金進來即清空轉出）",
  STRUCTURING: "結構化拆分（金額壓在通報門檻下）",
  RAPID_MOVEMENT: "快速資金移動（高頻＋大額清空）",
  FAN_IN_COLLECTION: "聚合戶（多來源匯入單一帳戶）",
  MULE_RING: "人頭環（帳戶圖譜高風險）",
  NO_REALNAME: "未通過門號實名（CHT 電子卡）",
  VELOCITY: "短時間高頻交易",
  DEVICE_CHANGE: "裝置變更",
  GEO_JUMP: "地理位置跳躍",
  NEW_ACCOUNT: "新開帳戶",
  HIGH_PAYEE_RISK: "收款方高風險",
  CROSS_INST_REUSE: "跨機構頻繁出示",
  MODEL_ANOMALY: "模型偵測到異常樣態",
  FRAUD_SERVICE_UNAVAILABLE: "反詐服務暫時無法連線（保守標記）",
};

const CONF_LABELS: Record<string, string> = { high: "高信心", medium: "中等信心", low: "低信心" };

const SCENARIOS: Record<string, { title: string; desc: string; tx: TxContext }> = {
  normal: {
    title: "正常交易",
    desc: "小額消費 NT$1,280，已實名、老帳戶",
    tx: {
      type: "PAYMENT", amount: 1280, oldbalanceOrg: 52000, newbalanceOrig: 50720,
      mobile_realname_verified: true, account_age_days: 900, payee_risk: 0.05,
      tx_count_1h: 1, tx_count_24h: 4,
    },
  },
  mule: {
    title: "高風險大額轉帳（疑似人頭）",
    desc: "NT$920,000 轉出清空帳戶、未實名、新帳戶、裝置/地理異常",
    tx: {
      type: "TRANSFER", amount: 920000, oldbalanceOrg: 1000000, newbalanceOrig: 0,
      mobile_realname_verified: false, tx_count_1h: 8, tx_count_24h: 41,
      device_changed: true, geo_jump: true, account_age_days: 2, payee_risk: 0.92,
      cross_institution_presentations: 13,
    },
  },
};

// 普惠情境：微型貸款撥款（小額、已實名，AI 照常評分把關普惠通道）
const MICROLOAN_TX: TxContext = {
  type: "CASH_IN", amount: 30000, oldbalanceOrg: 8000, newbalanceOrig: 38000,
  mobile_realname_verified: true, account_age_days: 540, payee_risk: 0.02,
  tx_count_1h: 1, tx_count_24h: 2,
};

// 各出示情境的必要 claim（述詞用，不可取消勾選）
const REQUIRED_BY_KIND: Record<PresentationKind, string> = {
  kyc: "kycLevel",
  reputation: "reputationTier",
};

type Stage = "wallet" | "consent" | "result";

export function App() {
  const [issuerDid, setIssuerDid] = useState<string>("");
  const [online, setOnline] = useState<boolean | null>(null);
  const [vc, setVc] = useState<string | null>(() => localStorage.getItem(VC_KEY));
  const [repVc, setRepVc] = useState<string | null>(() => localStorage.getItem(REP_KEY));
  const [holderDid, setHolderDid] = useState<string>(() => localStorage.getItem("chaintrust.holder") ?? "");
  const [mobileVc, setMobileVc] = useState<MobileVc | null>(() => {
    try { return JSON.parse(localStorage.getItem(MOBILE_VC_KEY) ?? "null"); } catch { return null; }
  });
  const [scenario, setScenario] = useState<keyof typeof SCENARIOS>("normal");
  const [requestKind, setRequestKind] = useState<PresentationKind>("kyc");
  const [reveal, setReveal] = useState<Set<string>>(new Set([REQUIRED_BY_KIND.kyc]));
  const [stage, setStage] = useState<Stage>("wallet");
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const [metrics, setMetrics] = useState<ModelMetrics | null>(null);

  const parsed: ParsedSdJwt | null = useMemo(() => {
    if (!vc) return null;
    try { return parseSdJwt(vc); } catch { return null; }
  }, [vc]);

  const parsedRep: ParsedSdJwt | null = useMemo(() => {
    if (!repVc) return null;
    try { return parseSdJwt(repVc); } catch { return null; }
  }, [repVc]);

  const activeParsed = requestKind === "reputation" ? parsedRep : parsed;
  const requiredClaim = REQUIRED_BY_KIND[requestKind];

  useEffect(() => {
    health().then((h) => { setOnline(h.ok); setIssuerDid(h.issuerDid); }).catch(() => setOnline(false));
    getMetrics().then((m) => { if (m.available && m.metrics) setMetrics(m.metrics); }).catch(() => {});
    // 金鑰自主遷移：舊憑證若綁定「伺服器代管 DID」（與本機金鑰推導的 DID 不符），
    // KB 簽章必然失敗——直接清除並提示重新申請。
    const localDid = ensureHolderKeys().did;
    const storedDid = localStorage.getItem("chaintrust.holder");
    if (storedDid && storedDid !== localDid && localStorage.getItem(VC_KEY)) {
      localStorage.removeItem(VC_KEY);
      localStorage.removeItem(MOBILE_VC_KEY);
      localStorage.setItem("chaintrust.holder", localDid);
      setVc(null); setMobileVc(null); setHolderDid(localDid);
      setError("錢包已升級為本機金鑰（金鑰自主），舊憑證已失效，請重新申請。");
    }
  }, []);

  async function handleIssue() {
    setBusy(true); setError("");
    try {
      // 金鑰自主：金鑰對在瀏覽器生成，DID 由本機公鑰推導，私鑰永不離開此裝置。
      const keys = ensureHolderKeys();
      const r = await issueKyc(keys.did);
      localStorage.setItem(VC_KEY, r.vc);
      localStorage.setItem("chaintrust.holder", keys.did);
      setVc(r.vc); setHolderDid(keys.did);
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(false); }
  }

  async function handleIssueMobile() {
    setBusy(true); setError("");
    try {
      const keys = ensureHolderKeys();
      const r = await issueMobile(keys.did, "0912345678");
      localStorage.setItem(MOBILE_VC_KEY, JSON.stringify(r.vc));
      setMobileVc(r.vc);
      if (!holderDid) { localStorage.setItem("chaintrust.holder", keys.did); setHolderDid(keys.did); }
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(false); }
  }

  async function handleIssueRep() {
    setBusy(true); setError("");
    try {
      const r = await issueReputation(holderDid || undefined);
      localStorage.setItem(REP_KEY, r.vc);
      if (!holderDid) {
        localStorage.setItem("chaintrust.holder", r.holderDid);
        setHolderDid(r.holderDid);
      }
      setRepVc(r.vc);
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(false); }
  }

  function handleForget() {
    localStorage.removeItem(VC_KEY);
    localStorage.removeItem(MOBILE_VC_KEY);
    setVc(null); setMobileVc(null); setResult(null); setStage("wallet");
  }

  function handleForgetRep() {
    localStorage.removeItem(REP_KEY);
    setRepVc(null); setResult(null); setStage("wallet");
  }

  function openConsent(kind: PresentationKind) {
    setRequestKind(kind);
    setReveal(new Set([REQUIRED_BY_KIND[kind]]));
    setResult(null);
    setStage("consent");
  }

  function toggleReveal(claim: string) {
    if (claim === requiredClaim) return; // 必需，不可取消
    setReveal((prev) => {
      const next = new Set(prev);
      next.has(claim) ? next.delete(claim) : next.add(claim);
      return next;
    });
  }

  async function handlePresent() {
    if (!activeParsed) return;
    setBusy(true); setError("");
    try {
      // 1) 向驗證方取一次性 nonce（防重放）
      const { nonce, aud } = await getNonce();
      // 2) 全程瀏覽器端：最小揭露 + 本機私鑰簽 KB-JWT（防出示被轉手）
      const presentation = buildPresentationWithKeyBinding(activeParsed, [...reveal], { aud, nonce });
      // 3) KB 必驗與 aud 由驗證方伺服器強制，前端只回傳挑戰 nonce
      const tx = requestKind === "reputation" ? MICROLOAN_TX : SCENARIOS[scenario].tx;
      const res = await verifyPresentation(presentation, tx, requestKind, { nonce });
      setResult(res); setStage("result");
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(false); }
  }

  const disclosableClaims = activeParsed?.disclosures.map((d) => d.claim) ?? [];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="logo">鏈</span>
          <div><h1>ChainTrust 錢包</h1><p>自主權金融身分 · 一次 KYC、跨機構重用</p></div>
        </div>
        <div className={`status ${online ? "ok" : online === false ? "down" : ""}`}>
          <span className="dot" />{online == null ? "連線中…" : online ? "服務已連線" : "服務未連線"}
        </div>
      </header>

      {error && <div className="banner err">⚠ {error}</div>}
      {online === false && (
        <div className="banner warn">
          後端未連線。請先啟動 issuer-verifier（<code>pnpm iv:dev</code>）與 ai-service。
        </div>
      )}

      {/* 我的憑證 */}
      <section className="card">
        <div className="card-h"><h2>我的憑證</h2><span className="tag">發證：銀行 A（KYC Issuer）</span></div>
        {!parsed ? (
          <div className="empty">
            <p>你的錢包還沒有 KYC 憑證。向 <b>銀行 A</b> 申請一張可重複使用的可驗證憑證（VC）。</p>
            <button className="btn primary" disabled={busy || !online} onClick={handleIssue}>
              {busy ? "申請中…" : "向銀行 A 申請 KYC 憑證"}
            </button>
          </div>
        ) : (
          <div>
            <div className="cred">
              <div className="cred-row"><span>類型</span><b>KYCCredential（SD-JWT）</b></div>
              <div className="cred-row"><span>發證者</span><code title={String(parsed.payload.iss)}>{shortDid(String(parsed.payload.iss))}</code></div>
              <div className="cred-row"><span>持有者</span><code title={holderDid}>{shortDid(holderDid)}</code></div>
            </div>
            <p className="hint">🔒 以下欄位只存在你的錢包，出示時由你決定揭露哪些：</p>
            <div className="chips">
              {parsed.disclosures.map((d) => (
                <span key={d.claim} className={`chip ${CLAIM_LABELS[d.claim]?.pii ? "pii" : ""}`}>
                  {CLAIM_LABELS[d.claim]?.label ?? d.claim}：<b>{fmtClaim(d.claim, d.value)}</b>
                </span>
              ))}
            </div>
            <button className="btn ghost" onClick={handleForget}>刪除憑證</button>
          </div>
        )}
      </section>

      {/* 第二發證者：中華電信門號電子卡（多機構信任網路） */}
      <section className="card">
        <div className="card-h"><h2>門號實名憑證</h2><span className="tag">發證：中華電信（門號電子卡）</span></div>
        {!mobileVc ? (
          <div className="empty">
            <p>由<b>第二個發證機構</b>簽發：中華電信以門號電子卡驗證實名後發出憑證，
              與銀行 A <b>同受一個信任根背書</b>——多機構信任網路的最小示範。</p>
            <button className="btn primary" disabled={busy || !online} onClick={handleIssueMobile}>
              {busy ? "申請中…" : "申請門號實名憑證（0912-***-678）"}
            </button>
          </div>
        ) : (
          <div>
            <div className="cred">
              <div className="cred-row"><span>類型</span><b>MobileRealNameCredential</b></div>
              <div className="cred-row"><span>電信商</span><b>{mobileVc.credentialSubject.carrier}</b></div>
              <div className="cred-row"><span>門號</span><b>{mobileVc.credentialSubject.msisdnMasked}</b></div>
              <div className="cred-row"><span>實名驗證</span><b>{mobileVc.credentialSubject.msisdnVerified ? "✓ 已通過" : "✗ 未通過"}</b></div>
            </div>
            <p className="hint">🏛 與 KYC 憑證來自不同發證者，但由同一個鏈上信任根（IssuerRegistry）背書。</p>
          </div>
        )}
      </section>

      {/* 普惠信譽憑證 */}
      <section className="card">
        <div className="card-h"><h2>繳費信譽憑證</h2><span className="tag">發證：中華電信（普惠金融）</span></div>
        {!parsedRep ? (
          <div className="empty">
            <p>沒有聯徵信用紀錄？你的<b>電信繳費史</b>就是可攜的財務信譽。<br />
              向 <b>中華電信</b> 申請繳費信譽憑證（明細留在錢包，出示時只揭露等級）。</p>
            <button className="btn primary" disabled={busy || !online} onClick={handleIssueRep}>
              {busy ? "申請中…" : "向中華電信申請 繳費信譽憑證"}
            </button>
          </div>
        ) : (
          <div>
            <div className="cred">
              <div className="cred-row"><span>類型</span><b>FinancialReputationCredential（SD-JWT）</b></div>
              <div className="cred-row"><span>發證者</span><code title={String(parsedRep.payload.iss)}>{shortDid(String(parsedRep.payload.iss))}</code></div>
              <div className="cred-row"><span>資料來源</span><b>{String(parsedRep.payload.carrier ?? "中華電信")}</b></div>
            </div>
            <p className="hint">🔒 繳費明細只存在你的錢包，出示時預設只揭露信譽等級：</p>
            <div className="chips">
              {parsedRep.disclosures.map((d) => (
                <span key={d.claim} className={`chip ${CLAIM_LABELS[d.claim]?.pii ? "pii" : ""}`}>
                  {CLAIM_LABELS[d.claim]?.label ?? d.claim}：<b>{fmtClaim(d.claim, d.value)}</b>
                </span>
              ))}
            </div>
            <button className="btn ghost" onClick={handleForgetRep}>刪除憑證</button>
          </div>
        )}
      </section>

      {/* 出示請求：銀行 B / 商家（KYC） */}
      <section className="card">
        <div className="card-h"><h2>出示請求</h2><span className="tag">來自：銀行 B / 商家（Verifier）</span></div>
        <p>對方要求證明：<b>已完成 KYC（等級 ≥ 2）</b>。<br />
          依最小揭露原則，你<b>不需</b>提供姓名、生日等個資。</p>
        <div className="scen">
          {(Object.keys(SCENARIOS) as (keyof typeof SCENARIOS)[]).map((k) => (
            <label key={k} className={`scen-opt ${scenario === k ? "sel" : ""} ${k === "mule" ? "danger" : ""}`}>
              <input type="radio" name="scen" checked={scenario === k} onChange={() => setScenario(k)} />
              <div><b>{SCENARIOS[k].title}</b><p>{SCENARIOS[k].desc}</p></div>
            </label>
          ))}
        </div>
        <button className="btn primary" disabled={!parsed || !online} onClick={() => openConsent("kyc")}>
          檢視將揭露的資料 →
        </button>
      </section>

      {/* 出示請求：微型貸款（普惠金融） */}
      <section className="card">
        <div className="card-h"><h2>出示請求</h2><span className="tag">來自：微型貸款平台（普惠金融）</span></div>
        <p>對方要求證明：<b>繳費信譽等級 ≥ 2</b> —— <b>無需聯徵紀錄</b>。<br />
          你只揭露信譽等級，在網月數、繳費比例等明細<b>留在錢包</b>。</p>
        {!parsedRep && <p className="hint">先在上方申請「繳費信譽憑證」。</p>}
        <button className="btn primary" disabled={!parsedRep || !online} onClick={() => openConsent("reputation")}>
          檢視將揭露的資料 →
        </button>
      </section>

      {/* 最小揭露同意 */}
      {stage === "consent" && activeParsed && (
        <div className="modal-bg" onClick={() => setStage("wallet")}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>最小揭露同意</h2>
            <p className="hint">驗證方只會看到你<b>勾選</b>的欄位，其餘個資不會離開錢包。</p>
            <div className="consent-list">
              {disclosableClaims.map((claim) => {
                const meta = CLAIM_LABELS[claim] ?? { label: claim, pii: false };
                const checked = reveal.has(claim);
                const required = claim === requiredClaim;
                return (
                  <label key={claim} className={`consent-row ${checked ? "on" : ""}`}>
                    <input type="checkbox" checked={checked} disabled={required} onChange={() => toggleReveal(claim)} />
                    <span className="cl-label">{meta.label}{required && <em> · 必需</em>}{meta.pii && <em className="pii-tag"> · 個資</em>}</span>
                    <span className="cl-state">{checked ? "將揭露" : "不會揭露"}</span>
                  </label>
                );
              })}
            </div>
            <div className="reveal-summary">
              <div><span className="ok">將揭露</span> {[...reveal].map((c) => CLAIM_LABELS[c]?.label ?? c).join("、") || "—"}</div>
              <div><span className="muted">不會揭露</span> {disclosableClaims.filter((c) => !reveal.has(c)).map((c) => CLAIM_LABELS[c]?.label ?? c).join("、") || "—"}</div>
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setStage("wallet")}>取消</button>
              <button className="btn primary" disabled={busy} onClick={handlePresent}>{busy ? "出示中…" : "同意並出示"}</button>
            </div>
          </div>
        </div>
      )}

      {/* 結果 */}
      {stage === "result" && result && (
        <section className="card result">
          <Outcome r={result} kind={requestKind} />
          <div className="checks">
            <Check ok={result.verify.checks.signature} label="簽章有效" />
            <Check ok={result.verify.checks.trustedIssuer} label="發證者受信任根背書" />
            <Check ok={result.verify.checks.notRevoked} label="憑證未被撤銷" />
            <Check
              ok={result.verify.checks.predicate}
              label={requestKind === "reputation" ? "繳費信譽等級 ≥ 2" : "KYC 等級 ≥ 2"}
            />
            {result.verify.checks.keyBinding !== undefined && (
              <Check ok={result.verify.checks.keyBinding} label="持有者金鑰綁定（KB，本機簽章）" />
            )}
          </div>

          <div className="seen">
            <h3>驗證方實際看到的欄位</h3>
            <div className="chips">
              {result.verify.disclosed.length === 0 && <span className="chip muted">（無，僅述詞）</span>}
              {result.verify.disclosed.map((c) => <span key={c} className="chip on">{CLAIM_LABELS[c]?.label ?? c}</span>)}
              {result.verify.withheld.map((c) => <span key={c} className="chip muted">🔒 {CLAIM_LABELS[c]?.label ?? c}</span>)}
            </div>
          </div>

          {result.risk && (
            <div className={`risk ${result.risk.decision}`}>
              <div className="risk-head">
                <span>AI 反詐風險</span>
                <span className="risk-score">{result.risk.risk ?? "—"}<small>/100</small></span>
              </div>
              <div className="risk-decision">{decisionLabel(result.risk.decision)}</div>
              {result.risk.confidence != null && (
                <div className={`conf ${result.risk.confidence_band ?? ""}`}>
                  <span>判斷信心</span>
                  <div className="conf-bar"><i style={{ width: `${Math.round((result.risk.confidence ?? 0) * 100)}%` }} /></div>
                  <b>{CONF_LABELS[result.risk.confidence_band ?? ""] ?? ""} {Math.round((result.risk.confidence ?? 0) * 100)}%</b>
                </div>
              )}
              {result.risk.reasons.length > 0 && (
                <ul className="reasons">
                  {result.risk.reasons.map((rc) => <li key={rc}>{REASON_LABELS[rc] ?? rc}</li>)}
                </ul>
              )}
              {result.risk.top_factors && result.risk.top_factors.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <h4 style={{ margin: "8px 0 4px", fontSize: 13, opacity: 0.8 }}>AI 判斷主要依據</h4>
                  <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                    {result.risk.top_factors.map((f) => (
                      <li key={f.feature} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                        <span>{f.label}</span>
                        <b style={{ fontVariantNumeric: "tabular-nums" }}>+{f.impact.toFixed(2)}</b>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <button className="btn ghost" onClick={() => setStage("wallet")}>完成 · 回錢包</button>
        </section>
      )}

      {metrics && <ModelTrust m={metrics} />}

      <footer>PoC · 僅測試網 · CHT 整合點為 mock · 持有者金鑰在本機（金鑰自主）｜<code>{shortDid(issuerDid)}</code></footer>
    </div>
  );
}

function ModelTrust({ m }: { m: ModelMetrics }) {
  const pct = (v?: number) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
  const ablation = m.cht_signal_ablation;
  const cal = m.calibration_quality;
  const baselines = m.baselines ?? {};
  const maxBaseline = Math.max(0.001, ...Object.values(baselines).map((b) => b.pr_auc));
  const BASE_LABELS: Record<string, string> = {
    rules_only: "規則 baseline",
    logistic_regression: "邏輯迴歸",
    lightgbm: "LightGBM（本系統）",
  };
  return (
    <section className="card trust">
      <div className="card-h"><h2>模型可信度報告</h2><span className="tag">out-of-time holdout</span></div>

      <div className="kpis">
        <div className="kpi"><b>{pct(m.holdout_pr_auc)}</b><span>PR-AUC（主指標）</span></div>
        <div className="kpi"><b>{pct(m.recall_at_fpr_1pct)}</b><span>誤殺 1% 下的攔截率</span></div>
        <div className="kpi"><b>{cal ? cal.ece.toFixed(3) : "—"}</b><span>校準誤差 ECE（越低越準）</span></div>
      </div>

      {ablation && (
        <div className="ablation">
          <h3>中華電信身分訊號的反詐增益</h3>
          <div className="ab-row">
            <span>無 CHT 訊號</span>
            <div className="ab-bar"><i style={{ width: `${(ablation.without_cht_pr_auc / Math.max(ablation.with_cht_pr_auc, 0.001)) * 100}%` }} /></div>
            <b>{pct(ablation.without_cht_pr_auc)}</b>
          </div>
          <div className="ab-row gain">
            <span>＋CHT 訊號</span>
            <div className="ab-bar"><i style={{ width: "100%" }} /></div>
            <b>{pct(ablation.with_cht_pr_auc)}</b>
          </div>
          <p className="lift">門號實名／裝置／地理／帳戶年齡等身分訊號，使反詐 PR-AUC 提升 <b>+{ablation.lift_pct}%</b>。</p>
        </div>
      )}

      {Object.keys(baselines).length > 0 && (
        <div className="ablation">
          <h3>與基線方法對照（PR-AUC）</h3>
          {Object.entries(baselines).map(([k, b]) => (
            <div key={k} className={`ab-row ${k === "lightgbm" ? "gain" : ""}`}>
              <span>{BASE_LABELS[k] ?? k}</span>
              <div className="ab-bar"><i style={{ width: `${(b.pr_auc / maxBaseline) * 100}%` }} /></div>
              <b>{pct(b.pr_auc)}</b>
            </div>
          ))}
          <p className="lift">LightGBM 另提供每筆 SHAP 可解釋、異常偵測與帳戶圖譜，為線性模型所無。</p>
        </div>
      )}

      <p className="trust-foot">
        資料：{m.source ?? "—"}（{m.rows?.toLocaleString() ?? "—"} 筆，詐欺 {m.fraud?.toLocaleString() ?? "—"} 筆）·
        時間切分驗證 · isotonic 機率校準
      </p>
    </section>
  );
}

function Outcome({ r, kind }: { r: VerifyResponse; kind: PresentationKind }) {
  const approveSub =
    kind === "reputation" ? "繳費信譽良好，無需聯徵即可核貸" : "已完成 KYC 且風險低";
  const map = {
    approve: { cls: "approve", icon: "✅", title: kind === "reputation" ? "驗證通過 · 貸款核准" : "驗證通過 · 交易放行", sub: approveSub },
    review: { cls: "review", icon: "⚠️", title: "需人工複核", sub: "憑證有效，但交易風險偏高" },
    reject: { cls: "reject", icon: "⛔", title: "交易已攔截", sub: r.verify.ok ? "AI 判定高風險（疑似人頭/盜用）" : `憑證驗證失敗：${r.verify.reason ?? ""}` },
  }[r.outcome];
  return (
    <div className={`outcome ${map.cls}`}>
      <span className="oc-icon">{map.icon}</span>
      <div><h2>{map.title}</h2><p>{map.sub}</p></div>
    </div>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return <div className={`chk ${ok ? "y" : "n"}`}>{ok ? "✓" : "✗"} {label}</div>;
}

function decisionLabel(d: string) {
  return d === "block" ? "決策：攔截 (block)" : d === "review" ? "決策：複核 (review)" : "決策：放行 (pass)";
}
function shortDid(did?: string) {
  if (!did) return "—";
  return did.length > 24 ? `${did.slice(0, 16)}…${did.slice(-6)}` : did;
}
function fmtClaim(claim: string, v: unknown) {
  if (claim === "reputationTier" && typeof v === "number") return TIER_LABELS[v] ?? String(v);
  if (claim === "onTimeRatio" && typeof v === "number") return `${Math.round(v * 100)}%`;
  if (typeof v === "boolean") return v ? "是" : "否";
  return String(v);
}
