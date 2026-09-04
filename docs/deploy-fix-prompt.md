# 部署修正 — ai-service 404 / 雲端上線

## 診斷

- `GET /` 404 是正常的：FastAPI 只有 `/health`、`/score`(POST)、`/metrics`、`/docs`，沒有根路由。先測 `/health` 與 `/docs`，若有回應代表服務是活的，只是首頁不存在。
- Vercel serverless 不適合此服務：`lightgbm/scikit-learn/scipy/pandas` 易超過 250MB 函式上限；且 `model.joblib` 被 gitignore，不會進 Vercel 部署 → 只能跑規則 baseline。
- 已有的 `packages/ai-service/Dockerfile` 在 build 時 `python train.py` 產生模型 → 用容器平台（Render／Railway／Fly）最順、模型完整。

## 建議架構

- 錢包 wallet（靜態 React）→ **Vercel**
- ai-service（FastAPI＋ML）→ **Render／Railway／Fly**（用現有 Dockerfile）
- issuer-verifier（Node）→ 同容器平台，或 demo 時本機

## 貼進 Claude Code 的修正 prompt

```text
延續 ChainTrust。維持護欄（testnet only、不提交私鑰/.env、註解可中文、Conventional Commits、每改完跑該套件測試）。
目標：修好 ai-service 的雲端部署（目前部到 Vercel 出現 404）。分 A→B 兩段，每段暫停回報。

A. 服務本身小修（packages/ai-service）：
  1. app/main.py 新增 GET "/"：回傳服務資訊與端點清單（/health、/score(POST)、/metrics、/docs），HTTP 200。
  2. 加 CORS（fastapi.middleware.cors.CORSMiddleware）：允許錢包來源，來源用 env ALLOWED_ORIGINS（預設含 http://localhost:5173 與 https://*.vercel.app）。
  3. 加 GET "/favicon.ico" 回 204，消除 favicon 404 雜訊。
  4. 確認 schemas.ScoreResponse 已含 confidence / confidence_band（model.py 會用到），缺則補上並加 pytest。
  驗收：pnpm test:ai 綠；本機 uvicorn app.main:app 起來，curl / 、/health、/docs 都 200。暫停回報。

B. 改用容器平台部署（推薦 Render，用現有 Dockerfile，模型完整）：
  1. Dockerfile 末行 CMD 綁定平台注入的埠：改成
     CMD ["sh","-c","uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
  2. 新增 render.yaml（services: 一個 type: web、runtime/env: docker、dockerfilePath: packages/ai-service/Dockerfile、dockerContext: .、healthCheckPath: /health）。
  3. 新增 packages/ai-service/DEPLOY.md：Render 步驟（連 GitHub repo → New Web Service → Docker → healthcheck /health），附 Railway/Fly 備選；說明 build 時會自動 train 出 model.joblib。
  4. 錢包改用 env 指 AI 服務位址（VITE_AI_SERVICE_URL，預設本機），雲端填 Render URL；issuer-verifier 的 AI_SERVICE_URL 也可由 env 指。
  驗收：docker build 成功、容器啟動後 curl /health 與 /score（人頭樣本回 block）正常。暫停回報。

可選 C（若一定要用 Vercel）：改走「規則模式」精簡版 —— 新增 api/index.py 匯出 ASGI app、vercel.json 把所有路由 rewrite 到該函式，並用只含 fastapi+pydantic 的精簡 requirements（不裝 lightgbm/sklearn）；體積小、可上線，但只有規則 baseline、無訓練模型。

開始前先用一段話覆述 A 段計畫。
```

## 注意

- 容器平台會注入 `PORT` 環境變數，所以 Dockerfile 一定要綁 `${PORT}`（Render/Railway 必需）。
- 決賽 demo 想穩：ai-service 上 Render、錢包上 Vercel、issuer-verifier 上 Render 或本機；三者用 env 串接。
