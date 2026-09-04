import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  parseSdJwt,
  buildPresentationWithKeyBinding,
  validateIssuedVc,
  type ParsedSdJwt,
  type VcValidation,
} from "./sdjwt.ts";
import {
  EMPTY_VAULT,
  adoptLegacyIdentity,
  createDemoIdentity,
  createEncryptedIdentity,
  encryptionAvailable,
  exportEncryptedBackup,
  forgetHolderKeys,
  getKeyBindingSigner,
  hasLegacyIdentity,
  hasStoredIdentity,
  importEncryptedBackup,
  loadVault,
  lockWallet,
  passphraseProblem,
  saveVault,
  setPassphrase,
  storedIdentityInfo,
  unlockDemoIdentity,
  unlockWithPassphrase,
  type HolderIdentity,
  type WalletVault,
} from "./keys.ts";

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

const VCT_BY_KIND: Record<PresentationKind, string> = {
  kyc: "KYCCredential",
  reputation: "FinancialReputationCredential",
};

type Stage = "wallet" | "consent" | "result";
type LockState = "loading" | "setup" | "locked" | "unlocked";
type PromptKind = "protect" | "export" | "import" | "reset";
interface PromptState {
  kind: PromptKind;
  file?: File;
}

// ── 型別守衛：後端欄位缺失不得讓整頁白屏 ─────────────────────
function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function fixed(v: unknown, digits: number, fallback = "—"): string {
  const n = asNum(v);
  return n === null ? fallback : n.toFixed(digits);
}
function pct(v: unknown, digits = 1): string {
  const n = asNum(v);
  return n === null ? "—" : `${(n * 100).toFixed(digits)}%`;
}
function ratio(v: unknown, base: unknown): number {
  const n = asNum(v);
  const b = asNum(base);
  if (n === null || b === null || b <= 0) return 0;
  return Math.max(0, Math.min(100, (n / b) * 100));
}
function list<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "發生未預期的錯誤";
}

function downloadJson(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function App() {
  // 身分 / 保險庫
  const [lockState, setLockState] = useState<LockState>("loading");
  const [identity, setIdentity] = useState<HolderIdentity | null>(null);
  const [vault, setVault] = useState<WalletVault>(EMPTY_VAULT);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // 服務 / 展示
  const [issuerDid, setIssuerDid] = useState<string>("");
  const [online, setOnline] = useState<boolean | null>(null);
  const [scenario, setScenario] = useState<keyof typeof SCENARIOS>("normal");
  const [requestKind, setRequestKind] = useState<PresentationKind>("kyc");
  const [reveal, setReveal] = useState<Set<string>>(new Set([REQUIRED_BY_KIND.kyc]));
  const [stage, setStage] = useState<Stage>("wallet");
  const [challenge, setChallenge] = useState<{ nonce: string; aud: string } | null>(null);
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const [notice, setNotice] = useState<string>("");
  const [metrics, setMetrics] = useState<ModelMetrics | null>(null);

  // 後端連線與模型報告（與鎖定狀態無關）
  useEffect(() => {
    health().then((h) => { setOnline(h.ok); setIssuerDid(h.issuerDid); }).catch(() => setOnline(false));
    getMetrics().then((m) => { if (m.available && m.metrics) setMetrics(m.metrics); }).catch(() => {});
  }, []);

  // 開機：決定 setup / locked / unlocked（ref 守衛避免 StrictMode 重複執行遷移）
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    (async () => {
      try {
        // 舊版（明文金鑰）原樣接手，一個憑證都不刪
        if (!hasStoredIdentity() && hasLegacyIdentity()) {
          const { identity: id, didMismatch } = await adoptLegacyIdentity();
          setIdentity(id); setVault(await loadVault()); setLockState("unlocked");
          setNotice(
            didMismatch
              ? "偵測到舊版未加密金鑰，已原樣接手（憑證一張都沒刪）。注意：舊紀錄的持有者 DID 與本機金鑰不符，相關憑證可能無法通過 key binding——是否刪除由你決定。"
              : "偵測到舊版未加密金鑰，已原樣接手。你的私鑰目前尚未加密，建議立即設定密語保護。"
          );
          return;
        }
        const info = storedIdentityInfo();
        if (!info) { setLockState("setup"); return; }
        if (info.protection === "demo-plaintext") {
          const id = await unlockDemoIdentity();
          setIdentity(id); setVault(await loadVault()); setLockState("unlocked");
          return;
        }
        setLockState("locked");
      } catch (e: unknown) {
        setError(errMsg(e));
        setLockState(hasStoredIdentity() ? "locked" : "setup");
      }
    })();
  }, []);

  // ── 憑證解析＋驗證（存入前已驗過，載入時再驗一次以偵測換機/竄改）──
  const parsed: ParsedSdJwt | null = useMemo(() => {
    if (!vault.kycVc) return null;
    try { return parseSdJwt(vault.kycVc); } catch { return null; }
  }, [vault.kycVc]);

  const parsedRep: ParsedSdJwt | null = useMemo(() => {
    if (!vault.repVc) return null;
    try { return parseSdJwt(vault.repVc); } catch { return null; }
  }, [vault.repVc]);

  const kycCheck: VcValidation | null = useMemo(() => {
    if (!identity || !vault.kycVc) return null;
    return validateIssuedVc(vault.kycVc, identity, { expectedVct: VCT_BY_KIND.kyc });
  }, [identity, vault.kycVc]);

  const repCheck: VcValidation | null = useMemo(() => {
    if (!identity || !vault.repVc) return null;
    return validateIssuedVc(vault.repVc, identity, { expectedVct: VCT_BY_KIND.reputation });
  }, [identity, vault.repVc]);

  const activeParsed = requestKind === "reputation" ? parsedRep : parsed;
  const activeCheck = requestKind === "reputation" ? repCheck : kycCheck;
  const requiredClaim = REQUIRED_BY_KIND[requestKind];

  // ── 身分：建立 / 解鎖 / 保護 / 備份 / 重設 ────────────────
  async function afterUnlock(id: HolderIdentity): Promise<void> {
    setIdentity(id);
    setVault(await loadVault());
    setLockState("unlocked");
  }

  async function handleCreateEncrypted(passphrase: string) {
    setBusy(true); setError("");
    try {
      await afterUnlock(await createEncryptedIdentity(passphrase));
      setNotice("已建立加密身分：私鑰以密語（PBKDF2 + AES-GCM）封裝後才存入本機。");
    } catch (e: unknown) { setError(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function handleCreateDemo() {
    setBusy(true); setError("");
    try {
      await afterUnlock(await createDemoIdentity());
      setNotice("已建立 Demo 身分：私鑰以明文存於此瀏覽器，僅供展示，請勿放入真實個資。");
    } catch (e: unknown) { setError(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function handleUnlock(passphrase: string) {
    setBusy(true); setError("");
    try { await afterUnlock(await unlockWithPassphrase(passphrase)); setNotice(""); }
    catch (e: unknown) { setError(errMsg(e)); }
    finally { setBusy(false); }
  }

  function handleLock() {
    lockWallet();
    setIdentity(null); setVault(EMPTY_VAULT); setResult(null); setStage("wallet");
    setLockState(storedIdentityInfo() ? "locked" : "setup");
  }

  async function handlePromptSubmit(passphrase: string) {
    if (!prompt) return;
    setBusy(true); setError("");
    try {
      if (prompt.kind === "protect") {
        const id = await setPassphrase(passphrase);
        setIdentity(id);
        setNotice("已完成加密：私鑰與憑證都改以密語封裝。請牢記密語——遺失無法救回，請立即匯出備份。");
      } else if (prompt.kind === "export") {
        const json = await exportEncryptedBackup(passphrase);
        downloadJson(`chaintrust-wallet-backup-${new Date().toISOString().slice(0, 10)}.json`, json);
        setNotice("備份已下載（以你輸入的密語加密）。請存放在安全的地方。");
      } else if (prompt.kind === "import") {
        if (!prompt.file) throw new Error("請先選擇備份檔。");
        const id = await importEncryptedBackup(await prompt.file.text(), passphrase);
        await afterUnlock(id);
        setNotice("已從備份還原身分與憑證。");
      }
      setPrompt(null);
    } catch (e: unknown) { setError(errMsg(e)); }
    finally { setBusy(false); }
  }

  function handleResetIdentity() {
    forgetHolderKeys();
    setIdentity(null); setVault(EMPTY_VAULT); setResult(null); setStage("wallet");
    setPrompt(null); setLockState("setup");
    setNotice("已重設此裝置身分：私鑰與所有憑證都已從本機刪除。");
  }

  // ── 憑證：申請 / 刪除 ────────────────────────────────────
  async function persistVault(next: WalletVault) {
    await saveVault(next);
    setVault(next);
  }

  async function handleIssue() {
    if (!identity) return;
    setBusy(true); setError("");
    try {
      // 金鑰自主：金鑰對在瀏覽器生成，DID 由本機公鑰推導，私鑰永不離開此裝置。
      const r = await issueKyc(identity.did);
      const check = validateIssuedVc(r.vc, identity, { expectedVct: VCT_BY_KIND.kyc });
      if (!check.ok) throw new Error(`憑證未通過錢包驗證，已拒絕存入：${check.errors.join("；")}`);
      await persistVault({ ...vault, kycVc: r.vc });
      setNotice("");
    } catch (e: unknown) { setError(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function handleIssueMobile() {
    if (!identity) return;
    setBusy(true); setError("");
    try {
      const r = await issueMobile(identity.did, "0912345678");
      const subjectId = r.vc?.credentialSubject?.id;
      if (subjectId !== identity.did) {
        throw new Error("門號憑證的持有者與本機金鑰不符，已拒絕存入。");
      }
      if (r.vc.credentialSubject.msisdnVerified !== true) {
        throw new Error("門號憑證未通過實名驗證，已拒絕存入。");
      }
      await persistVault({ ...vault, mobileVc: r.vc });
    } catch (e: unknown) { setError(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function handleIssueRep() {
    if (!identity) return;
    setBusy(true); setError("");
    try {
      const r = await issueReputation(identity.did);
      const check = validateIssuedVc(r.vc, identity, { expectedVct: VCT_BY_KIND.reputation });
      if (!check.ok) throw new Error(`憑證未通過錢包驗證，已拒絕存入：${check.errors.join("；")}`);
      await persistVault({ ...vault, repVc: r.vc });
    } catch (e: unknown) { setError(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function handleDeleteCredential(which: "kyc" | "rep" | "mobile", label: string) {
    if (!window.confirm(`確定要刪除「${label}」嗎？\n\n只會刪除這張憑證，本機金鑰與其他憑證不受影響。可重新申請。`)) return;
    setBusy(true); setError("");
    try {
      const next: WalletVault =
        which === "kyc" ? { ...vault, kycVc: null }
        : which === "rep" ? { ...vault, repVc: null }
        : { ...vault, mobileVc: null };
      await persistVault(next);
      setResult(null); setStage("wallet");
    } catch (e: unknown) { setError(errMsg(e)); }
    finally { setBusy(false); }
  }

  // ── 出示：先取 nonce，再進同意階段（what-you-see-is-what-you-sign）──
  async function openConsent(kind: PresentationKind) {
    setBusy(true); setError("");
    try {
      const c = await getNonce();
      setChallenge(c);
      setRequestKind(kind);
      setReveal(new Set([REQUIRED_BY_KIND[kind]]));
      setResult(null);
      setStage("consent");
    } catch (e: unknown) { setError(errMsg(e)); }
    finally { setBusy(false); }
  }

  function toggleReveal(claim: string) {
    if (claim === requiredClaim) return; // 必需，不可取消
    setReveal((prev) => {
      const next = new Set(prev);
      if (next.has(claim)) next.delete(claim);
      else next.add(claim);
      return next;
    });
  }

  async function handlePresent() {
    if (!activeParsed || !challenge) return;
    setBusy(true); setError("");
    try {
      if (activeCheck && !activeCheck.ok) {
        throw new Error(`憑證未通過本機驗證，已停止出示：${activeCheck.errors.join("；")}`);
      }
      // 全程瀏覽器端：最小揭露 + 本機私鑰簽 KB-JWT（防出示被轉手）
      // 簽章器由此處注入，錢包鎖定後立即失效
      const signer = getKeyBindingSigner();
      const presentation = buildPresentationWithKeyBinding(activeParsed, [...reveal], challenge, signer);
      // KB 必驗與 aud 由驗證方伺服器強制，前端只回傳挑戰 nonce
      const tx = requestKind === "reputation" ? MICROLOAN_TX : SCENARIOS[scenario].tx;
      const res = await verifyPresentation(presentation, tx, requestKind, { nonce: challenge.nonce });
      setResult(res); setStage("result");
    } catch (e: unknown) { setError(errMsg(e)); }
    finally { setBusy(false); setChallenge(null); }
  }

  const disclosableClaims = activeParsed?.disclosures.map((d) => d.claim) ?? [];
  const mobileVc = vault.mobileVc;

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

      {error && <div className="banner err">⚠ {error} <button className="banner-x" onClick={() => setError("")}>✕</button></div>}
      {notice && <div className="banner info">ℹ {notice} <button className="banner-x" onClick={() => setNotice("")}>✕</button></div>}
      {online === false && (
        <div className="banner warn">
          後端未連線。請先啟動 issuer-verifier（<code>pnpm iv:dev</code>）與 ai-service。
        </div>
      )}

      {lockState === "loading" && (
        <section className="card"><p className="hint">正在讀取本機金鑰…</p></section>
      )}

      {lockState === "setup" && (
        <SetupGate busy={busy} onCreate={handleCreateEncrypted} onDemo={handleCreateDemo}
          onImport={(f) => setPrompt({ kind: "import", file: f })} />
      )}

      {lockState === "locked" && (
        <UnlockGate busy={busy} did={storedIdentityInfo()?.did ?? ""} onUnlock={handleUnlock}
          onImport={(f) => setPrompt({ kind: "import", file: f })}
          onReset={() => setPrompt({ kind: "reset" })} />
      )}

      {lockState === "unlocked" && identity && (
        <>
          {identity.protection === "demo-plaintext" && (
            <div className="banner danger">
              🔓 <b>未加密的 Demo 模式</b>：私鑰以明文存在這個瀏覽器，任何同源腳本或裝置備份都能帶走。僅供展示，請勿放入真實個資。
              <button className="btn tiny" onClick={() => setPrompt({ kind: "protect" })}>立即設定密語加密</button>
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
                  <div className="cred-row"><span>持有者</span><code title={identity.did}>{shortDid(identity.did)}</code></div>
                </div>
                <ValidationBox check={kycCheck} />
                <p className="hint">🔒 以下欄位只存在你的錢包，出示時由你決定揭露哪些：</p>
                <div className="chips">
                  {parsed.disclosures.map((d) => (
                    <span key={d.claim} className={`chip ${CLAIM_LABELS[d.claim]?.pii ? "pii" : ""}`}>
                      {CLAIM_LABELS[d.claim]?.label ?? d.claim}：<b>{fmtClaim(d.claim, d.value)}</b>
                    </span>
                  ))}
                </div>
                <button className="btn ghost" disabled={busy} onClick={() => handleDeleteCredential("kyc", "KYC 憑證")}>刪除憑證</button>
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
                <button className="btn ghost" disabled={busy} onClick={() => handleDeleteCredential("mobile", "門號實名憑證")}>刪除憑證</button>
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
                <ValidationBox check={repCheck} />
                <p className="hint">🔒 繳費明細只存在你的錢包，出示時預設只揭露信譽等級：</p>
                <div className="chips">
                  {parsedRep.disclosures.map((d) => (
                    <span key={d.claim} className={`chip ${CLAIM_LABELS[d.claim]?.pii ? "pii" : ""}`}>
                      {CLAIM_LABELS[d.claim]?.label ?? d.claim}：<b>{fmtClaim(d.claim, d.value)}</b>
                    </span>
                  ))}
                </div>
                <button className="btn ghost" disabled={busy} onClick={() => handleDeleteCredential("rep", "繳費信譽憑證")}>刪除憑證</button>
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
            <button className="btn primary" disabled={busy || !parsed || !online || kycCheck?.ok === false}
              onClick={() => openConsent("kyc")}>
              檢視將揭露的資料 →
            </button>
          </section>

          {/* 出示請求：微型貸款（普惠金融） */}
          <section className="card">
            <div className="card-h"><h2>出示請求</h2><span className="tag">來自：微型貸款平台（普惠金融）</span></div>
            <p>對方要求證明：<b>繳費信譽等級 ≥ 2</b> —— <b>無需聯徵紀錄</b>。<br />
              你只揭露信譽等級，在網月數、繳費比例等明細<b>留在錢包</b>。</p>
            {!parsedRep && <p className="hint">先在上方申請「繳費信譽憑證」。</p>}
            <button className="btn primary" disabled={busy || !parsedRep || !online || repCheck?.ok === false}
              onClick={() => openConsent("reputation")}>
              檢視將揭露的資料 →
            </button>
          </section>

          {/* 裝置身分與金鑰 */}
          <section className="card">
            <div className="card-h">
              <h2>裝置身分與金鑰</h2>
              <span className={`tag ${identity.protection === "passphrase" ? "ok" : "danger"}`}>
                {identity.protection === "passphrase" ? "🔐 已以密語加密" : "🔓 未加密（Demo）"}
              </span>
            </div>
            <div className="cred">
              <div className="cred-row"><span>持有者 DID（實際簽章金鑰）</span><code title={identity.did}>{shortDid(identity.did)}</code></div>
              <div className="cred-row"><span>金鑰保護</span><b>{identity.protection === "passphrase" ? "PBKDF2-SHA256 310k + AES-GCM-256" : "無（明文）"}</b></div>
              <div className="cred-row"><span>憑證儲存</span><b>{identity.protection === "passphrase" ? "與私鑰同庫加密" : "明文"}</b></div>
            </div>
            <p className="hint">
              私鑰只在解鎖後存在於分頁記憶體，重新整理頁面即需再次解鎖。
              備份為以密語加密的 JSON——沒有密語，撿到檔案的人也還原不了。
            </p>
            <div className="key-actions">
              {identity.protection !== "passphrase" && (
                <button className="btn primary" disabled={busy} onClick={() => setPrompt({ kind: "protect" })}>設定密語加密</button>
              )}
              <button className="btn ghost" disabled={busy} onClick={() => setPrompt({ kind: "export" })}>匯出加密備份</button>
              <button className="btn ghost" disabled={busy} onClick={() => fileRef.current?.click()}>從備份還原</button>
              {identity.protection === "passphrase" && (
                <button className="btn ghost" disabled={busy} onClick={handleLock}>鎖定錢包</button>
              )}
              <button className="btn danger" disabled={busy} onClick={() => setPrompt({ kind: "reset" })}>重設此裝置身分（含金鑰）</button>
            </div>
            <input ref={fileRef} type="file" accept="application/json" style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) setPrompt({ kind: "import", file: f });
              }} />
          </section>
        </>
      )}

      {/* 最小揭露同意（含 what-you-see-is-what-you-sign 揭露） */}
      {lockState === "unlocked" && identity && stage === "consent" && activeParsed && challenge && (
        <div className="modal-bg" onClick={() => { setStage("wallet"); setChallenge(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>最小揭露同意</h2>
            <p className="hint">驗證方只會看到你<b>勾選</b>的欄位，其餘個資不會離開錢包。</p>

            <div className="signing-target">
              <div className="st-title">你即將以本機私鑰簽署一份出示證明，對象與挑戰碼如下：</div>
              <div className="st-row"><span>出示對象（aud）</span><code>{challenge.aud}</code></div>
              <div className="st-row"><span>一次性挑戰碼（nonce）</span><code title={challenge.nonce}>{challenge.nonce.slice(0, 16)}…</code></div>
              <div className="st-row"><span>簽章金鑰（你的 DID）</span><code title={identity.did}>{shortDid(identity.did)}</code></div>
              <div className="st-row"><span>簽章用途</span><b>僅限 KB-JWT（key binding）</b></div>
            </div>

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
              <button className="btn ghost" onClick={() => { setStage("wallet"); setChallenge(null); }}>取消</button>
              <button className="btn primary" disabled={busy} onClick={handlePresent}>{busy ? "出示中…" : "同意並簽署出示"}</button>
            </div>
          </div>
        </div>
      )}

      {/* 結果 */}
      {lockState === "unlocked" && stage === "result" && result && (
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
              {list<string>(result.verify.disclosed).length === 0 && <span className="chip muted">（無，僅述詞）</span>}
              {list<string>(result.verify.disclosed).map((c) => <span key={c} className="chip on">{CLAIM_LABELS[c]?.label ?? c}</span>)}
              {list<string>(result.verify.withheld).map((c) => <span key={c} className="chip muted">🔒 {CLAIM_LABELS[c]?.label ?? c}</span>)}
            </div>
          </div>

          {result.risk && (
            <div className={`risk ${result.risk.decision}`}>
              <div className="risk-head">
                <span>AI 反詐風險</span>
                <span className="risk-score">{asNum(result.risk.risk) ?? "—"}<small>/100</small></span>
              </div>
              <div className="risk-decision">{decisionLabel(result.risk.decision)}</div>
              {asNum(result.risk.confidence) !== null && (
                <div className={`conf ${result.risk.confidence_band ?? ""}`}>
                  <span>判斷信心</span>
                  <div className="conf-bar"><i style={{ width: `${Math.round((asNum(result.risk.confidence) ?? 0) * 100)}%` }} /></div>
                  <b>{CONF_LABELS[result.risk.confidence_band ?? ""] ?? ""} {Math.round((asNum(result.risk.confidence) ?? 0) * 100)}%</b>
                </div>
              )}
              {list<string>(result.risk.reasons).length > 0 && (
                <ul className="reasons">
                  {list<string>(result.risk.reasons).map((rc) => <li key={rc}>{REASON_LABELS[rc] ?? rc}</li>)}
                </ul>
              )}
              {list<{ feature: string; label: string; impact: number }>(result.risk.top_factors).length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <h4 style={{ margin: "8px 0 4px", fontSize: 13, opacity: 0.8 }}>AI 判斷主要依據</h4>
                  <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                    {list<{ feature: string; label: string; impact: number }>(result.risk.top_factors).map((f) => (
                      <li key={String(f.feature)} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                        <span>{String(f.label ?? f.feature)}</span>
                        <b style={{ fontVariantNumeric: "tabular-nums" }}>+{fixed(f.impact, 2)}</b>
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

      {/* 密語對話框 / 重設確認 */}
      {prompt && prompt.kind !== "reset" && (
        <PassphraseDialog
          kind={prompt.kind}
          fileName={prompt.file?.name}
          busy={busy}
          onCancel={() => setPrompt(null)}
          onSubmit={handlePromptSubmit}
        />
      )}
      {prompt?.kind === "reset" && (
        <ResetDialog busy={busy} onCancel={() => setPrompt(null)} onConfirm={handleResetIdentity} />
      )}

      <footer>PoC · 僅測試網 · CHT 整合點為 mock · 持有者金鑰在本機（金鑰自主）｜<code>{shortDid(issuerDid)}</code></footer>
    </div>
  );
}

// ── 建立身分（首次進入）──────────────────────────────────
function SetupGate({
  busy, onCreate, onDemo, onImport,
}: {
  busy: boolean;
  onCreate: (p: string) => void;
  onDemo: () => void;
  onImport: (f: File) => void;
}) {
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [showDemo, setShowDemo] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const canEncrypt = encryptionAvailable();
  const problem = p1 ? passphraseProblem(p1) : null;
  const mismatch = p2.length > 0 && p1 !== p2;
  const ready = canEncrypt && !!p1 && !problem && !mismatch && p1 === p2;

  return (
    <section className="card gate">
      <div className="card-h"><h2>建立你的裝置身分</h2><span className="tag">金鑰自主</span></div>
      <p>金鑰對會在<b>這台裝置的瀏覽器</b>內生成，私鑰永遠不會送到伺服器。
        設定一組密語後，私鑰會以 <b>PBKDF2-SHA256（310,000 迭代）+ AES-GCM-256</b> 加密後才寫入本機儲存。</p>

      {!canEncrypt && (
        <div className="banner warn">
          目前環境無法使用 WebCrypto（需 https 或 localhost），無法建立加密身分。
          請改以 https 開啟，或使用下方的 Demo 快速模式（未加密）。
        </div>
      )}

      <div className="field">
        <label>設定密語（至少 8 字元）</label>
        <input className="input" type="password" autoComplete="new-password" value={p1}
          disabled={!canEncrypt} onChange={(e) => setP1(e.target.value)} placeholder="例如：一段你記得住的長句子" />
        {problem && <p className="field-err">{problem}</p>}
      </div>
      <div className="field">
        <label>再輸入一次</label>
        <input className="input" type="password" autoComplete="new-password" value={p2}
          disabled={!canEncrypt} onChange={(e) => setP2(e.target.value)} />
        {mismatch && <p className="field-err">兩次輸入不一致</p>}
      </div>
      <p className="hint">⚠ 密語只存在你腦中，遺失<b>無法救回</b>。建立後請立即到「裝置身分與金鑰」匯出加密備份。</p>

      <div className="key-actions">
        <button className="btn primary" disabled={busy || !ready} onClick={() => onCreate(p1)}>
          {busy ? "建立中…" : "建立加密身分（建議）"}
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => fileRef.current?.click()}>從備份還原</button>
      </div>

      <div className="demo-escape">
        {!showDemo ? (
          <button className="btn link" onClick={() => setShowDemo(true)}>評審／展示用：不設密語的快速模式 →</button>
        ) : (
          <div className="banner danger">
            🔓 <b>Demo 快速模式：未加密，僅供展示</b><br />
            私鑰會以<b>明文</b>存在瀏覽器 localStorage。任一 XSS、惡意相依或裝置備份都能把身分整把帶走，
            之後可在任何裝置永久冒用。<b>請勿放入真實個資</b>。之後隨時可在錢包內補設密語加密。
            <div className="key-actions">
              <button className="btn danger" disabled={busy} onClick={onDemo}>我了解風險，建立未加密的 Demo 身分</button>
              <button className="btn ghost" onClick={() => setShowDemo(false)}>返回</button>
            </div>
          </div>
        )}
      </div>

      <input ref={fileRef} type="file" accept="application/json" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onImport(f); }} />
    </section>
  );
}

// ── 解鎖（已有加密身分）─────────────────────────────────
function UnlockGate({
  busy, did, onUnlock, onImport, onReset,
}: {
  busy: boolean;
  did: string;
  onUnlock: (p: string) => void;
  onImport: (f: File) => void;
  onReset: () => void;
}) {
  const [p, setP] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <section className="card gate">
      <div className="card-h"><h2>解鎖錢包</h2><span className="tag ok">🔐 已加密</span></div>
      <div className="cred">
        <div className="cred-row"><span>此裝置身分</span><code title={did}>{shortDid(did)}</code></div>
      </div>
      <p className="hint">解鎖一次後，本分頁內的所有操作都不需再輸入密語；關閉或重新整理頁面才需再解鎖。</p>
      <form
        className="field"
        onSubmit={(e) => { e.preventDefault(); if (p) onUnlock(p); }}
      >
        <label>密語</label>
        <input className="input" type="password" autoComplete="current-password" autoFocus value={p}
          onChange={(e) => setP(e.target.value)} />
        <div className="key-actions">
          <button className="btn primary" type="submit" disabled={busy || !p}>{busy ? "解鎖中…" : "解鎖"}</button>
          <button className="btn ghost" type="button" disabled={busy} onClick={() => fileRef.current?.click()}>從備份還原</button>
          <button className="btn danger" type="button" disabled={busy} onClick={onReset}>忘記密語 · 重設身分</button>
        </div>
      </form>
      <input ref={fileRef} type="file" accept="application/json" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onImport(f); }} />
    </section>
  );
}

// ── 密語對話框（加密 / 匯出 / 匯入共用）──────────────────
const PROMPT_COPY: Record<Exclude<PromptKind, "reset">, { title: string; desc: string; cta: string; confirm: boolean }> = {
  protect: {
    title: "設定密語加密",
    desc: "設定後，私鑰與所有憑證都會以 PBKDF2 + AES-GCM 封裝才寫入本機。密語遺失無法救回。",
    cta: "加密並保存",
    confirm: true,
  },
  export: {
    title: "匯出加密備份",
    desc: "備份檔含私鑰與憑證，會以你在此輸入的密語加密（可與解鎖密語不同）。請妥善保管檔案與密語。",
    cta: "產生並下載備份",
    confirm: true,
  },
  import: {
    title: "從備份還原",
    desc: "還原會以備份內容【覆寫】此裝置目前的金鑰與憑證。請先確認你不再需要目前的身分。",
    cta: "解密並還原",
    confirm: false,
  },
};

function PassphraseDialog({
  kind, fileName, busy, onCancel, onSubmit,
}: {
  kind: Exclude<PromptKind, "reset">;
  fileName?: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (p: string) => void;
}) {
  const copy = PROMPT_COPY[kind];
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const problem = p1 ? passphraseProblem(p1) : null;
  const mismatch = copy.confirm && p2.length > 0 && p1 !== p2;
  const ready = !!p1 && !problem && (!copy.confirm || p1 === p2);
  return (
    <div className="modal-bg" onClick={onCancel}>
      <form className="modal" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (ready) onSubmit(p1); }}>
        <h2>{copy.title}</h2>
        <p className="hint">{copy.desc}</p>
        {fileName && <p className="hint">備份檔：<code>{fileName}</code></p>}
        <div className="field">
          <label>密語</label>
          <input className="input" type="password" autoFocus value={p1} onChange={(e) => setP1(e.target.value)} />
          {problem && <p className="field-err">{problem}</p>}
        </div>
        {copy.confirm && (
          <div className="field">
            <label>再輸入一次</label>
            <input className="input" type="password" value={p2} onChange={(e) => setP2(e.target.value)} />
            {mismatch && <p className="field-err">兩次輸入不一致</p>}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn ghost" type="button" onClick={onCancel}>取消</button>
          <button className="btn primary" type="submit" disabled={busy || !ready}>{busy ? "處理中…" : copy.cta}</button>
        </div>
      </form>
    </div>
  );
}

// ── 重設身分確認 ────────────────────────────────────────
function ResetDialog({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const [ack, setAck] = useState(false);
  return (
    <div className="modal-bg" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>重設此裝置身分</h2>
        <div className="banner danger">
          這會<b>永久刪除</b>本機私鑰與所有憑證（KYC、門號實名、繳費信譽）。
          沒有備份就<b>無法復原</b>，且舊憑證因綁定舊金鑰而永久失效，必須重新申請。
        </div>
        <label className="ack">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          我已匯出備份，或願意永久失去這個身分與所有憑證。
        </label>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onCancel}>取消</button>
          <button className="btn danger" disabled={busy || !ack} onClick={onConfirm}>永久刪除金鑰與憑證</button>
        </div>
      </div>
    </div>
  );
}

// ── 憑證驗證結果顯示 ────────────────────────────────────
function ValidationBox({ check }: { check: VcValidation | null }) {
  if (!check) return null;
  if (!check.ok) {
    return (
      <div className="banner danger">
        ⛔ <b>這張憑證未通過錢包驗證，請勿信任其內容：</b>
        <ul className="vlist">{check.errors.map((m) => <li key={m}>{m}</li>)}</ul>
      </div>
    );
  }
  return (
    <div className="validation ok">
      ✓ 已在本機驗證：發證者簽章、欄位摘要、<b>cnf 綁定本機金鑰</b>、時效
      {check.warnings.length > 0 && (
        <ul className="vlist muted">{check.warnings.map((m) => <li key={m}>· {m}</li>)}</ul>
      )}
    </div>
  );
}

function ModelTrust({ m }: { m: ModelMetrics }) {
  const ablation = m.cht_signal_ablation;
  const cal = m.calibration_quality;
  const baselines = m.baselines ?? {};
  const baseEntries = Object.entries(baselines).filter(([, b]) => asNum(b?.pr_auc) !== null);
  const maxBaseline = Math.max(0.001, ...baseEntries.map(([, b]) => asNum(b.pr_auc) ?? 0));
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
        <div className="kpi"><b>{fixed(cal?.ece, 3)}</b><span>校準誤差 ECE（越低越準）</span></div>
      </div>

      {ablation && (
        <div className="ablation">
          <h3>
            中華電信身分訊號的反詐增益
            {ablation.evidence_grade === "simulation" && <span className="tag warn">模擬推估</span>}
          </h3>
          <div className="ab-row">
            <span>無 CHT 訊號</span>
            <div className="ab-bar"><i style={{ width: `${ratio(ablation.without_cht_pr_auc, ablation.with_cht_pr_auc)}%` }} /></div>
            <b>{pct(ablation.without_cht_pr_auc)}</b>
          </div>
          <div className="ab-row gain">
            <span>＋CHT 訊號</span>
            <div className="ab-bar"><i style={{ width: "100%" }} /></div>
            <b>{pct(ablation.with_cht_pr_auc)}</b>
          </div>
          <p className="lift">門號實名／裝置／地理／帳戶年齡等身分訊號，使反詐 PR-AUC 提升 <b>+{fixed(ablation.lift_pct, 1)}%</b>。</p>
          {/* 誠實度：這個增益來自以標籤為條件生成的合成訊號，不是真實效度證據。
              數字若只在 metrics.json 裡標註而不呈現在畫面上，等於沒有標註。 */}
          {typeof ablation.caveat_zh === "string" && ablation.caveat_zh.length > 0 && (
            <p className="caveat">⚠ {ablation.caveat_zh}</p>
          )}
        </div>
      )}

      {baseEntries.length > 0 && (
        <div className="ablation">
          <h3>與基線方法對照（PR-AUC）</h3>
          {baseEntries.map(([k, b]) => (
            <div key={k} className={`ab-row ${k === "lightgbm" ? "gain" : ""}`}>
              <span>{BASE_LABELS[k] ?? k}</span>
              <div className="ab-bar"><i style={{ width: `${ratio(b.pr_auc, maxBaseline)}%` }} /></div>
              <b>{pct(b.pr_auc)}</b>
            </div>
          ))}
          <p className="lift">LightGBM 另提供每筆 SHAP 可解釋、異常偵測與帳戶圖譜，為線性模型所無。</p>
        </div>
      )}

      <p className="trust-foot">
        資料：{m.source ?? "—"}（{asNum(m.rows)?.toLocaleString() ?? "—"} 筆，詐欺 {asNum(m.fraud)?.toLocaleString() ?? "—"} 筆）·
        時間切分驗證 · isotonic 機率校準
      </p>
    </section>
  );
}

function Outcome({ r, kind }: { r: VerifyResponse; kind: PresentationKind }) {
  const approveSub =
    kind === "reputation" ? "繳費信譽良好，無需聯徵即可核貸" : "已完成 KYC 且風險低";
  const map: Record<string, { cls: string; icon: string; title: string; sub: string }> = {
    approve: { cls: "approve", icon: "✅", title: kind === "reputation" ? "驗證通過 · 貸款核准" : "驗證通過 · 交易放行", sub: approveSub },
    review: { cls: "review", icon: "⚠️", title: "需人工複核", sub: "憑證有效，但交易風險偏高" },
    reject: { cls: "reject", icon: "⛔", title: "交易已攔截", sub: r.verify.ok ? "AI 判定高風險（疑似人頭/盜用）" : `憑證驗證失敗：${r.verify.reason ?? ""}` },
  };
  const o = map[r.outcome] ?? { cls: "review", icon: "❔", title: "未知結果", sub: `伺服器回傳未預期的 outcome：${String(r.outcome)}` };
  return (
    <div className={`outcome ${o.cls}`}>
      <span className="oc-icon">{o.icon}</span>
      <div><h2>{o.title}</h2><p>{o.sub}</p></div>
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
