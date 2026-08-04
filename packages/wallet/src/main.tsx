import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.tsx";
import {
  exportEncryptedBackup,
  forgetHolderKeys,
  isUnlocked,
  passphraseProblem,
} from "./keys.ts";
import "./styles.css";

/**
 * 降級 UI：任何未攔截的 render 例外都會走到這裡。
 * 最重要的是——使用者在這個狀態下仍然拿得回自己的金鑰（匯出加密備份），
 * 不會因為某個後端欄位缺失導致整頁白屏而把身分鎖死在瀏覽器裡。
 */
function Fallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const [passphrase, setPassphrase] = React.useState("");
  const [msg, setMsg] = React.useState("");
  const unlocked = isUnlocked();
  const problem = passphrase ? passphraseProblem(passphrase) : null;

  async function handleExport() {
    setMsg("");
    try {
      const json = await exportEncryptedBackup(passphrase);
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `chaintrust-wallet-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMsg("備份已下載。");
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  function handleReset() {
    if (!window.confirm("這會永久刪除本機私鑰與所有憑證，且無法復原。確定要繼續嗎？")) return;
    forgetHolderKeys();
    window.location.reload();
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="logo">鏈</span>
          <div><h1>ChainTrust 錢包</h1><p>畫面發生錯誤 · 降級模式</p></div>
        </div>
      </header>

      <section className="card">
        <div className="card-h"><h2>畫面無法正常顯示</h2><span className="tag danger">降級模式</span></div>
        <p>錢包畫面遇到未預期的錯誤（通常是後端回傳的欄位缺失或格式不符）。
          你的金鑰與憑證仍安全存在本機，可以先匯出備份再重試。</p>
        <pre className="errbox">{error.message || String(error)}</pre>

        {unlocked ? (
          <>
            <div className="field">
              <label>備份密語（至少 8 字元）</label>
              <input className="input" type="password" value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)} />
              {problem && <p className="field-err">{problem}</p>}
            </div>
            <div className="key-actions">
              <button className="btn primary" disabled={!passphrase || !!problem} onClick={handleExport}>
                匯出加密備份
              </button>
              <button className="btn ghost" onClick={onRetry}>重試</button>
              <button className="btn ghost" onClick={() => window.location.reload()}>重新載入</button>
              <button className="btn danger" onClick={handleReset}>重設此裝置身分</button>
            </div>
          </>
        ) : (
          <>
            <p className="hint">錢包目前為鎖定狀態，需先重新載入並解鎖才能匯出備份。</p>
            <div className="key-actions">
              <button className="btn primary" onClick={() => window.location.reload()}>重新載入</button>
              <button className="btn danger" onClick={handleReset}>重設此裝置身分</button>
            </div>
          </>
        )}
        {msg && <p className="hint">{msg}</p>}
      </section>
    </div>
  );
}

interface BoundaryState {
  error: Error | null;
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, BoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    // 不吞錯誤：仍然留下完整堆疊供排錯
    console.error("[ChainTrust wallet] 未攔截的畫面錯誤", error, info.componentStack);
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return <Fallback error={this.state.error} onRetry={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root 掛載點");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
