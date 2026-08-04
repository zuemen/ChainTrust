# 鏈信 ChainTrust — 自主權金融身分錢包

SSI（自主權身分）× AI 反詐 × 區塊鏈，建構於**中華電信信任根**（PublicCA／門號電子卡）。 參賽：2026 中華電信智慧創新應用大賽 · 智慧金融組（校園組）。

## 這是什麼

一個金融級的**自主權身分錢包**：用 DID／可驗證憑證（VC）做到「**一次 KYC、跨機構重用**」，內建 **AI 反詐引擎**即時阻斷人頭帳戶與身分盜用，並以中華電信 PublicCA／門號電子卡作為「信任根」。

三個核心價值：

- **一次 KYC、跨機構重用** — 用 SD-JWT 最小揭露，免重複驗證、不外洩明文個資。
- **AI 即時反詐** — 交易／出示情境即時風險評分，攔截人頭帳戶與盜用。
- **普惠財務信譽** — 無信用紀錄者也能累積可攜、可驗證的財務信譽。

## 架構一覽

```
Issuers（CHT門號電子卡 / 銀行KYC） ──簽發VC──▶ Holder 錢包 ──出示(最小揭露)──▶ Verifier（銀行/商家）
        ▲ 由 CHT PublicCA 根背書                                              │ 驗章+查信任+查撤銷+AI風險
        └──── IssuerRegistry / RevocationRegistry（鏈上）◀───────────────────┘
                         AI 反詐引擎（FastAPI）即時風險分數
   PoC 鏈：Polygon Amoy testnet　｜　落地鏈：中華電信 BaaS
```

詳見 [`docs/architecture.md`](docs/architecture.md)。

## Monorepo 結構

| 套件 | 技術 | 職責 |
| :---- | :---- | :---- |
| `packages/contracts` | Solidity / Hardhat | `IssuerRegistry`（信任根背書）、`RevocationRegistry`（撤銷登記） |
| `packages/issuer-verifier` | TypeScript / Veramo / Express | 簽發 VC（Issuer）、驗證出示（Verifier） |
| `packages/ai-service` | Python / FastAPI / LightGBM | AI 反詐風險評分 `/score` |
| `packages/wallet` | React / Vite PWA | Holder 錢包：持有、出示、最小揭露、防詐警示 |

## 快速開始

```shell
# 0. 安裝 workspace 相依（根目錄）
pnpm install

# 1. AI 反詐服務：建 venv + 訓練模型（首次）
pnpm ai:setup
pnpm ai:train          # 印 holdout AUC，產 model.joblib

# 2. 一鍵起整個 Demo（ai-service + issuer-verifier + wallet）
pnpm demo              # Windows；macOS/Linux 用： bash scripts/demo.sh
# → 瀏覽器開 http://localhost:5173

# 或用 Docker（需 Docker Desktop 運行中）
docker compose up --build

# 自動驗證五步 Demo 線（服務啟動後）
pnpm smoke
```

現場操作腳本見 [`docs/DEMO.md`](docs/DEMO.md)。

> **注意**：`model.joblib`／`metrics.json` 不入庫，首次須 `pnpm ai:train` 產生（未訓練時 `/score` 自動退回規則 baseline）。即使用真 PaySim，電信／裝置／地理訊號為**半合成注入**；模型品質以 **PR-AUC** 為準。mutating 端點可用 `API_KEY` 保護、CORS 由 `CORS_ORIGIN` 收斂（見 `.env.example`）。

各套件單獨啟動：

```shell
pnpm contracts:test    # 合約測試（16）
pnpm iv:e2e            # 身分層 e2e（M1+M2.0）
pnpm iv:dev            # issuer-verifier :3001
pnpm ai:dev            # AI 反詐 :8000
pnpm wallet:dev        # 錢包 :5173
pnpm test             # 跑所有 JS/TS 套件測試
```

### Demo 操作（五步 Demo 線）

1. 錢包向 **銀行 A** 申請 KYC 憑證（SD-JWT VC）。
2. **銀行 B / 商家** 發出出示請求（要求 KYC 等級 ≥ 2）。
3. 選交易情境（正常 / 高風險大額轉帳）。
4. **最小揭露同意**：只揭露 `kycLevel`，姓名/生日等個資留在錢包。
5. 驗證方驗章 → 查信任 → 查撤銷 → AI 反詐評分 →
   正常交易 **放行**；高風險交易 **攔截** 並列出風險原因。

## 文件

- [`docs/architecture.md`](docs/architecture.md) — 系統設計與架構決策（ADR）
- [`docs/poc-spec.md`](docs/poc-spec.md) — PoC 技術規格（給開發者）
- [`docs/DEMO.md`](docs/DEMO.md) — 現場 Demo 操作腳本
- [`docs/ai-fraud-spec.md`](docs/ai-fraud-spec.md) — AI 反詐模組規格
- [`docs/model-card.md`](docs/model-card.md) — 反詐模型 Model Card（訓練資料/限制/偏誤/治理）
- [`docs/amoy-deploy-checklist.md`](docs/amoy-deploy-checklist.md) — Amoy 測試網部署清單
- [`docs/completeness-roadmap.md`](docs/completeness-roadmap.md) — 完整度分析、P0/P1/P2 待辦、逐項執行日誌
- [`CLAUDE.md`](CLAUDE.md) — 專案脈絡與開發規範（給 Claude Code）

## 最近更新（2026-07-21）

> 完整的完整度分析、P0/P1/P2 待辦與逐項執行日誌（含日期）見 [`docs/completeness-roadmap.md`](docs/completeness-roadmap.md) §5。

- **反詐情資接進 `/score`**：新增 `ThreatIntelAdapter`/`MockThreatIntelAdapter`（`packages/issuer-verifier/src/adapters/cht.ts`），`scoreTransaction()` 依收款方識別碼查詢情資後併入請求；AI 服務新增 `THREAT_INTEL_HIT` 加權規則，規則模式與模型模式命中都會實際推動風險分數與決策。
- **模型 Model Card + 治理文件**：新增 [`docs/model-card.md`](docs/model-card.md)——訓練資料、架構、指標、限制、**偏誤聲明**（反詐特徵可能懲罰無聯徵薄檔用戶，與普惠金融目標用戶重疊，此前未被記錄）、重訓節奏與漂移監控建議、人工審核責任分工。
- **CHT 產品對應表補實查**：`docs/completeness-roadmap.md` §3.1 換成有來源、有日期的真實 CHT 產品調研（含 2026-07-01 甫發布的 MID+/GSMA Open Gateway 新聞稿），4 個 adapter 介面與 `ChainGateway` 加上目標產品與預期 API 形態的檔頭註記。發現 CHT 研究院已有遵循 W3C DID 標準的研發項目（與本專案架構高度一致），以及 HiPKI/ePKI 根憑證即將被 Chrome 撤銷信任的時效性風險。
- **普惠金融線補位**：`FinancialReputationCredential` —— 電信繳費史（CHT adapter mock）→ 可攜財務信譽 VC（SD-JWT）→ 錢包「繳費信譽憑證」卡 + 「微型貸款平台」出示情境（只揭露信譽等級、無需聯徵）。
- **真 PaySim 實測（重要發現）**：635 萬筆、詐欺率 0.13%。PaySim 餘額欄位近決定性 → 指標飽和，CHT 增益歸零、且誤放行已實名過水帳戶。**demo 模型維持合成 hard-mode 訓練**，詳見 [`docs/model-card.md`](docs/model-card.md) 與 [`docs/DEMO.md`](docs/DEMO.md) 誠實聲明。
- 測試現況：合約 16、issuer-verifier 26、ai-service 22 全綠；e2e 含普惠步驟 [9][10] 全過。

## 狀態

PoC 開發中。所有「中華電信整合點」目前為 **mock**，正式落地時以對應的 CHT 產品（PublicCA／門號電子卡／BaaS／CHT Security 情資／Hami Pay）替換。**僅使用 testnet，請勿提交任何私鑰或機密。**

開發進度：

- [x] **M1 身分層** — IssuerRegistry / RevocationRegistry + Veramo 簽發/驗證 + e2e
- [x] **M2.0 SD-JWT** — 選擇性揭露（最小揭露）
- [x] **M2.1 AI 反詐** — `/score`（LightGBM+IsolationForest）+ verifier 整合
- [x] **M2.2 錢包** — 出示最小揭露同意 + 風險攔截 UI
- [x] **M3 串線** — `pnpm demo` / `docker compose up` 一鍵啟動 + `pnpm smoke` 跨服務驗證 + [`docs/DEMO.md`](docs/DEMO.md)
- [x] **普惠金融** — `FinancialReputationCredential`：電信繳費史 → 可攜財務信譽（SD-JWT 最小揭露）→ 無聯徵核貸情境

## 授權

MIT，見 [`LICENSE`](LICENSE)。
