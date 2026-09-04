# 部署到 Vercel（線上 Demo）

> 目的：給評審一個「打開連結就能玩」的線上錢包，取代「請看我的截圖」。
> 本機／Docker 的跑法不受影響，見 [`README.md`](../README.md) 與 [`DEMO.md`](./DEMO.md)。

## 架構：為什麼不是「整包丟 Vercel」

Vercel 適合托管靜態前端 + 短生命週期的 Serverless Function。ChainTrust 有三個元件，
只有一個適合放上去：

| 元件 | 技術 | 放哪 | 原因 |
| :-- | :-- | :-- | :-- |
| `packages/wallet` | React + Vite（靜態 SPA） | **Vercel** | 純靜態產物，`vite build` 後只有 ~230 KB |
| `packages/issuer-verifier` | Express + Veramo | **Render / Railway / Fly.io** | 長駐服務：Veramo agent、一次性 nonce 都存在行程記憶體裡，Serverless 每次冷啟動會清空 |
| `packages/ai-service` | FastAPI + LightGBM | **Render / Railway / Fly.io** | 映像建置時要 `python train.py` 產 `model.joblib`，且需 `libgomp`；兩者都超出 Vercel Python runtime 的範圍 |

兩個後端都已經有 Dockerfile，任何吃 Docker 的 PaaS 都能直接部署。

### `/api` 為什麼要經過 Serverless Function

錢包前端（`src/api.ts`）一律打相對路徑 `/api/*`，**從不自己帶 `X-API-Key`**。
這是刻意的：錢包是公開客戶端（public client），任何打包進 JS bundle 或存在
localStorage 的金鑰，使用者按 F12 就看得到，等於沒有金鑰。

所以金鑰一律由「代理層」在伺服器端注入，三種環境各有一份，行為一致：

| 環境 | 代理層 | 檔案 |
| :-- | :-- | :-- |
| 本機 dev | vite proxy | `packages/wallet/vite.config.ts` |
| Docker | nginx | `packages/wallet/nginx.conf.template` |
| **Vercel** | **Serverless Function** | **`packages/wallet/api/proxy.js`** |

> **為什麼 Vercel 這一份是 `proxy.js` + 顯式 rewrite，而不是 `api/[...path].js`**：
> 實測 Vercel 對 `api/[...path].js` 只產生「單層動態段」的路由 —— `/api/health` 進得來，
> `/api/sdjwt/issue` 會被平台直接回 `NOT_FOUND`（根本沒進 function）。所以改由 `vercel.json`
> 的 rewrite 明確把 `/api/:path*` 導到 `api/proxy.js`，原始路徑用 `__p` 查詢參數夾帶。
> 本機 vite proxy 與 Docker nginx 不受影響。

這一層同時做三件事：去掉 `/api` 前綴、注入 `X-API-Key`、**清掉瀏覽器自帶的同名標頭**
（避免前端偽造金鑰穿透代理）。走同源代理的附帶好處是後端 CORS 不必放寬，
CSP 也能維持 `connect-src 'self'`。

```
瀏覽器 ──/api/sdjwt/issue──▶ Vercel Function ──+X-API-Key──▶ issuer-verifier ──▶ ai-service
        （同源，無金鑰）        （注入金鑰）           (Render)              (Render)
```

---

## 步驟

### 步驟 0：先產生一把 API 金鑰

```shell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

記下來，後面三個地方會用到同一把。**不要寫進任何檔案、不要 commit。**

### 步驟 1：部署 ai-service（先部署，因為 issuer-verifier 要它的網址）

以 Render 為例（Railway/Fly.io 同理）：

1. Render → New → **Web Service** → 連上 `zuemen/ChainTrust-`
2. Runtime 選 **Docker**
   - Dockerfile Path：`packages/ai-service/Dockerfile`
   - Docker Build Context Directory：`.`（**必須是 repo 根目錄**，Dockerfile 第一行有註明）
3. Instance Type 至少 **512 MB**（映像建置時要跑 LightGBM 訓練）
4. Deploy。完成後記下網址，例如 `https://chaintrust-ai.onrender.com`
5. 驗證：`curl https://chaintrust-ai.onrender.com/health` → `{"ok":true,"model_loaded":true}`

> `model_loaded` 若是 `false`，代表建置時的訓練沒成功，`/score` 會退回規則 baseline
> ——demo 仍能跑，但風險分數與簡報裡的 PR-AUC 對不上。

### 步驟 2：部署 issuer-verifier

1. Render → New → Web Service → 同一個 repo
2. Runtime **Docker**
   - Dockerfile Path：`packages/issuer-verifier/Dockerfile`
   - Docker Build Context Directory：`.`
3. Environment Variables：

   | Key | Value | 說明 |
   | :-- | :-- | :-- |
   | `API_KEY` | 步驟 0 產生的金鑰 | **必填**。缺了會拒絕啟動（非 development 環境 fail-closed） |
   | `NODE_ENV` | `production` | |
   | `CHAIN_MODE` | `memory`（或部署 Amoy 後改 `ethers`） | 見 `docs/amoy-deploy-checklist.md` |
   | `AI_SERVICE_URL` | 步驟 1 的網址 | |
   | `CORS_ORIGIN` | 步驟 3 拿到的 Vercel 網址 | 先填佔位、步驟 3 後回來改 |

4. Deploy，記下網址，例如 `https://chaintrust-iv.onrender.com`
5. 驗證：`curl https://chaintrust-iv.onrender.com/health` → `{"ok":true,"issuerDid":"did:key:..."}`

### 步驟 3：部署錢包到 Vercel

1. Vercel → **Add New → Project** → Import `zuemen/ChainTrust-`
2. **Root Directory 設為 `packages/wallet`**（這一步最容易漏；設錯會找不到 `vercel.json` 與 `api/`）
3. Framework Preset 會自動偵測為 **Vite**；Build/Output 由 `packages/wallet/vercel.json` 指定，不用手動改
4. Environment Variables（**Production 與 Preview 都要加**）：

   | Key | Value |
   | :-- | :-- |
   | `IV_URL` | 步驟 2 的網址，例如 `https://chaintrust-iv.onrender.com` |
   | `API_KEY` | 步驟 0 產生的**同一把**金鑰 |

5. Deploy。拿到網址，例如 `https://chaintrust.vercel.app`
6. **回到步驟 2 把 `CORS_ORIGIN` 改成這個網址**並重新部署 issuer-verifier

### 步驟 4：驗收（照五步 Demo 線走一次）

```shell
# 1. 前端活著
curl -I https://chaintrust.vercel.app

# 2. 代理透傳 GET（不需金鑰）
curl https://chaintrust.vercel.app/api/health

# 3. 代理注入金鑰後的 mutating 端點（holderDid 由瀏覽器金鑰推導，這裡用假的會回 400，
#    回 400 就代表金鑰已通過、只是 DID 格式不合 —— 這正是我們要看到的）
curl -X POST https://chaintrust.vercel.app/api/sdjwt/issue \
  -H "Content-Type: application/json" -d '{"holderDid":"did:key:bogus"}'
#    → 400 {"error":"holderDid 不是合法的 did:key（Secp256k1）"}  ✅ 金鑰有效
#    → 401 unauthorized                                        ❌ Vercel 的 API_KEY 沒設或不一致
#    → 503 issuing_disabled_no_api_key                         ❌ 後端 API_KEY 沒設
#    → 500 iv_url_not_configured                               ❌ Vercel 的 IV_URL 沒設
```

然後開瀏覽器把 [`DEMO.md`](./DEMO.md) 的五步走一遍（申請 KYC → 出示 → 正常放行 →
高風險攔截 → 普惠信譽出示）。

---

## 常見卡點

**Render 免費方案會休眠**：閒置 15 分鐘後停機，下一個請求要等 ~50 秒冷啟動。
現場 demo 前先打一次 `/health` 暖機，或當天升到付費方案。

**Vercel Function 的 10 秒上限**：`/api/*` 是 Serverless Function，Hobby 方案預設
10 秒逾時。issuer-verifier 冷啟動慢時第一次請求可能吃掉這 10 秒 —— 同上，先暖機。

**Root Directory 設錯**：症狀是部署成功但所有 `/api` 回 404（因為 `api/` 沒被當成
Function 目錄）。回 Vercel → Settings → General → Root Directory 改成 `packages/wallet`。

**改了環境變數沒生效**：Vercel 的環境變數要**重新 Deploy** 才會套用，改完記得
Redeploy（Deployments → 最新那筆 → Redeploy）。

**CSP 擋掉東西**：`vercel.json` 的 CSP 是照 `nginx.conf.template` 抄的（錢包的 holder
私鑰存在瀏覽器裡，CSP 是 XSS 竊鑰的最後一道防線）。若要加外部資源，改
`vercel.json` 的 `Content-Security-Policy`，不要整條拿掉。
