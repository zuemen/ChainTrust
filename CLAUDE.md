# CLAUDE.md — ChainTrust 鏈信 開發脈絡與規範

> 給 Claude Code 的專案說明。動工前先讀本檔、`docs/architecture.md`、`docs/poc-spec.md`。

## 一句話定位

SSI（自主權身分）金融身分錢包 + AI 反詐 PoC。核心 Demo 線：**一次 KYC、跨機構重用（最小揭露）** + **高風險交易即時攔截**。參賽 2026 中華電信智慧創新應用大賽 · 智慧金融組（校園組）。

## 開發優先序（唯一準則）

以「**五步 Demo 線**」為唯一優先：先把一條端到端線打通，再加分支。每個里程碑結束後**暫停並回報**，等使用者確認再繼續。

- **M1 身分層**：合約（IssuerRegistry / RevocationRegistry）+ Veramo 簽發/驗證 + e2e。
- **M2 反詐 + 錢包**：AI `/score`（規則 baseline → LightGBM/IsolationForest）+ 錢包出示最小揭露 + 風險攔截。
- **M3 串線**：單一指令端到端 Demo + README 操作步驟。

## 護欄（硬性規定）

1. **只用 testnet**（Polygon Amoy, chainId 80002）。**絕不**提交任何私鑰、助記詞、`.env`、`*.sqlite`（Veramo 金鑰庫）。`.gitignore` 已涵蓋，新增敏感檔前先確認被忽略。
2. **CHT 整合點一律 adapter + mock**。所有「中華電信整合點」（PublicCA 根背書、門號電子卡、BaaS、CHT Security 情資、Hami Pay）以 `adapters/` 介面 + mock 實作，正式落地時替換實作、不動呼叫端。
3. **不新增未列於 `docs/architecture.md` ADR 的重量級相依**。需要新相依先補一條 ADR。
4. **個資最小揭露**：VC 採 SD-JWT 選擇性揭露，驗證端只拿到必要欄位，明文個資不落鏈、不外洩。

## 技術選型（詳見 architecture.md ADR）

| 層 | 選型 |
| :-- | :-- |
| Monorepo | pnpm workspace |
| 合約 | Solidity ^0.8.24 + Hardhat + OpenZeppelin（Ownable）|
| DID/VC | Veramo：`did:key`(Holder) + `did:ethr`(Issuer)，credential-w3c + SD-JWT |
| Issuer/Verifier 服務 | TypeScript + Express |
| AI 反詐 | Python + FastAPI；baseline 規則 → LightGBM + IsolationForest（`model.joblib`）|
| 錢包 | React + Vite PWA |
| PoC 鏈 | Polygon Amoy testnet（落地：CHT BaaS）|

## 撰碼慣例

- 程式碼、識別字用**英文**；註解可用**中文**。
- Commit 用 **Conventional Commits**（`feat:`/`fix:`/`docs:`/`test:`/`chore:`…）。
- 每個套件改完先跑該套件 `build`/`test` 再 commit。
- 合約：每個 public/external 函式都要有對應測試；事件命名 `XxxRegistered`/`XxxRevoked`。
- TypeScript：`strict` 開；不吞錯誤，驗證失敗要回明確原因碼。

## 與使用者互動

- 一律用**中文**回答。
- 操作直接執行、不逐步詢問確認；里程碑結束才暫停回報。
- 任何階段完成後直接 push 到 `origin`（`https://github.com/zuemen/ChainTrust`；repo 已由 `ChainTrust-` 改名，舊網址會轉址）。

## 目錄速查

```
packages/contracts        # Hardhat：IssuerRegistry / RevocationRegistry
packages/issuer-verifier  # Veramo agent + issuer.ts / verifier.ts + e2e
packages/ai-service       # FastAPI /score（M2）
packages/wallet           # React PWA 錢包（M2）
docs/                     # architecture.md（ADR）、poc-spec.md
```
