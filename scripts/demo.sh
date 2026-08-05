#!/usr/bin/env bash
# 一鍵起 ChainTrust Demo（macOS / Linux）
# 啟動 ai-service(:8000) + issuer-verifier(:3001) + wallet(:5173)
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AI="$ROOT/packages/ai-service"
PY="$AI/.venv/bin/python"

pids=()
cleanup() { echo "停止服務…"; for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

# issuer-verifier 的 mutating 端點是 fail-closed：未設 API_KEY 一律回 503。
# 產一把只活在本次 demo 行程環境的一次性金鑰，同時供 iv 驗證與 wallet 的
# vite proxy 注入（見 packages/wallet/vite.config.ts）。不寫檔、不入庫。
if [ -z "${API_KEY:-}" ]; then
  API_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  export API_KEY
  echo "[env] 已產生一次性 API_KEY（僅本次 demo 有效，未寫入任何檔案）"
else
  echo "[env] 使用既有的 API_KEY"
fi

if [ ! -x "$PY" ]; then
  echo "[!] 找不到 ai-service venv，請先： pnpm ai:setup && pnpm ai:train"
else
  [ -f "$AI/model.joblib" ] || (echo "[ai] 訓練模型…"; (cd "$AI" && "$PY" train.py))
  echo "[ai] http://localhost:8000"
  (cd "$AI" && "$PY" -m uvicorn app.main:app --port 8000) & pids+=($!)
fi

echo "[iv] http://localhost:3001"
pnpm --filter @chaintrust/issuer-verifier dev & pids+=($!)

sleep 3
echo "[wallet] http://localhost:5173  → 開啟瀏覽器"
pnpm --filter @chaintrust/wallet dev & pids+=($!)

wait
