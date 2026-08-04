# ChainTrust Demo 腳本（現場操作）

五步 Demo 線：**一次 KYC、跨機構重用（最小揭露）** + **AI 即時反詐攔截**。

## 啟動（擇一）

**方式 A：本機（已驗證）**
```shell
pnpm install
pnpm ai:setup && pnpm ai:train     # 首次：建 venv + 訓練模型（印 holdout PR-AUC，主指標）
pnpm demo                          # 同時起 ai(:8000)+iv(:3001)+wallet(:5173)
```
**方式 B：Docker（需 Docker Desktop 運行中）**
```shell
docker compose up --build          # → http://localhost:5173
```

開瀏覽器：**http://localhost:5173**

> 一鍵自動驗證（不開瀏覽器也能證明五步通）：另開終端機 `pnpm smoke`。

## 現場操作（5 步，約 90 秒）

| 步 | 操作 | 講稿重點 |
| :- | :- | :- |
| 1 | 點「向銀行 A 申請 KYC 憑證」 | 使用者在**銀行 A** 完成一次 KYC，拿到一張可驗證憑證（SD-JWT VC），存在**自己的錢包**，不是銀行的資料庫。 |
| 2 | 看「出示請求」卡（來自銀行 B / 商家） | 換到**銀行 B**，對方只需要確認「已完成 KYC（等級≥2）」——**不需要**姓名、生日。一次 KYC、跨機構重用。 |
| 3 | 選交易情境：先選「正常交易」 | 待會用同一張憑證跑兩種交易，展示 AI 反詐。 |
| 4 | 點「檢視將揭露的資料」→ 同意畫面 | **最小揭露**：只勾 `kycLevel`，姓名/生日/國籍**留在錢包不外洩**。畫面明列「將揭露 / 不會揭露」。點「同意並出示」。 |
| 5 | 看結果 | 四項檢查全綠（簽章 / 信任根 / 未撤銷 / kycLevel≥2）；「驗證方實際看到的欄位」只有 KYC 等級，PII 顯示 🔒；AI 風險 **pass（綠）放行**。 |
| 再 | 回錢包，改選「高風險大額轉帳」再出示一次 | **同一張憑證、同樣只揭露 kycLevel**，但因金流像人頭、未實名、新帳戶、裝置/地理異常 → AI 風險 **block（紅）⛔ 交易已攔截**，並列出風險原因。 |
| 6 | 點「向中華電信申請 繳費信譽憑證」→ 對「微型貸款平台」出示 | **普惠金融**：沒有聯徵紀錄的學生/新住民/自由工作者，用**多年電信準時繳費史**換一張可攜的財務信譽 VC。出示時只揭露「信譽等級」，在網月數、繳費比例等明細**留在錢包**→ 無需聯徵即可核貸。 |

## 一句話收尾

> 個資留在使用者錢包、跨機構免重複 KYC，且每筆交易即時反詐——以中華電信 PublicCA／門號電子卡為信任根。

## 三大價值對應畫面

- **一次 KYC、跨機構重用** → 步驟 1（銀行 A 發證）→ 步驟 2（銀行 B 直接驗證）。
- **最小揭露** → 步驟 4 同意畫面 + 步驟 5「驗證方實際看到的欄位」。
- **AI 即時反詐** → 正常放行 vs 人頭攔截的對比。
- **普惠財務信譽** → 步驟 6：電信繳費史 → 信譽 VC → 無聯徵核貸（明細不出錢包）。

## 疑難排解

| 現象 | 解法 |
| :- | :- |
| 錢包顯示「服務未連線」 | 確認 `pnpm iv:dev`、ai-service 已啟動；或直接 `pnpm demo`。 |
| AI 風險顯示「反詐服務暫時無法連線」 | ai-service 沒起或沒訓練：`pnpm ai:setup && pnpm ai:train`。 |
| 想重來 | 結果頁「完成·回錢包」；或刪除憑證重新申請。 |

## 資料與模型誠實聲明（簡報用）

- **模型需先訓練**：`model.joblib` 與 `metrics.json` 不入庫，首次請跑 `pnpm ai:train` 產生；未訓練時 `/score` 會自動退回**可解釋規則 baseline**（demo 仍可跑）。
- **半合成資料**：無 Kaggle 時用合成 PaySim-like 資料。即使改用**真 PaySim**，其交易詐欺訊號為真，但電信/裝置/地理（門號實名、device_changed、geo_jump…）為**與 isFraud 相關的半合成注入**（PaySim 無這些欄位，見 `synth.py: augment_cht_signals`）。
- **真 PaySim 實測結果（2026-07 已跑，見 `metrics.paysim-real.json`）**：635 萬筆、詐欺率 0.13%（真實比例）。但 PaySim 模擬器的餘額欄位**近乎決定性**標記詐欺（詐欺列固定「轉出即歸零」），導致指標飽和（PR-AUC 0.998、ROC≈1.0、邏輯迴歸同分）且 **CHT 訊號增益無從展現**；該模型還把「已實名的過水帳戶」誤放行（背了模擬器 artifact、泛化更差）。因此 **demo 模型維持合成 hard-mode 資料訓練**——刻意去掉決定性金流訊號，才能誠實展示「金流訊號不足時，身分訊號的邊際價值（+16.45% PR-AUC）」。
- **指標以 PR-AUC 為準**（極度不平衡，勿看 accuracy）；ROC-AUC≈1.0 會被視為洩漏並警示。`metrics.json` 另含 recall@FPR1%/precision@100/MCC/混淆矩陣。
- **安全**：mutating 端點（`/issue/*`、`/sdjwt/issue`、`/revoke`）可設 `API_KEY` 強制 `X-API-Key`；CORS 由 `CORS_ORIGIN` 收斂（見 `.env.example`）。

## 進階（落地說明）

- 目前 PoC 用 **InMemory** 鏈閘道；要接 Polygon Amoy 真合約，見 `docs/amoy-deploy-checklist.md`（私鑰只放本機 `.env`，絕不入庫）。
- 所有「中華電信整合點」為 mock（`packages/issuer-verifier/src/adapters/cht.ts`），落地時替換實作、呼叫端不變。
