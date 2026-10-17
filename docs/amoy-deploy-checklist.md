# Amoy 測試網部署清單（你自己跑）

> **安全第一**：私鑰只放你電腦上的 `packages/contracts/.env`（已 gitignore）。
> **絕不要把私鑰貼到聊天室或傳給任何人，包括我。** 我不經手任何金鑰；部署由你在本機執行。

## 步驟

1. 用 MetaMask 另開一個**只用於測試網**的錢包（別用有真錢的帳戶）。
2. 切到 Polygon Amoy（chainId `80002`），到水龍頭領測試幣 POL：
   - https://faucet.polygon.technology/ （選 Amoy）
3. 在 `packages/contracts/.env` 設定：
   ```
   DEPLOYER_PRIVATE_KEY=0x你的測試私鑰
   AMOY_RPC_URL=https://rpc-amoy.polygon.technology
   ```
4. 部署：
   ```bash
   pnpm --filter @chaintrust/contracts deploy:amoy
   # 或：cd packages/contracts && npx hardhat run scripts/deploy.ts --network amoy
   ```
5. 記下 `packages/contracts/deployments/amoy.json` 內的 `IssuerRegistry` 與 `RevocationRegistry` 位址（此檔請入庫，issuer-verifier 依它讀合約位址）。
6. 煙霧測試（會發真交易、花少量 gas）：
   ```bash
   pnpm --filter @chaintrust/contracts smoke:amoy
   ```
   腳本做四件事，並逐步印出 PolygonScan 交易連結（Demo 的「真的在鏈上」事證）：
   - 將 **deployer 自身**設為受信任 issuer。原因：issuer-verifier 在 ethers 模式下，若沒另設
     `ISSUER_PRIVATE_KEY`，就**以 `CHAIN_PRIVATE_KEY`（= deployer）作為銀行 A 的發證者金鑰**——
     憑證由它簽、撤銷交易也由它送。`RevocationRegistry` 以 `msg.sender` 為撤銷命名空間且要求它受信任，
     所以 deployer 必須先受信任，簽發→撤銷→驗證才會對上同一個位址。
   - （可選）`TRUST_ISSUER=0x...` 額外背書一個 issuer 位址，例如你另設的 `CHT_ISSUER_PRIVATE_KEY`
     對應位址（server 啟動後由需鑑權的 `/info` 回傳 `chtIssuerAddr`）。
     > server 啟動時若 `CHAIN_PRIVATE_KEY` 是 IssuerRegistry owner，會自動背書兩個發證者，這步通常可省。
   - `revoke` 一筆測試 hash → 確認 `isRevoked=true`。
   - `unrevoke` → 確認 `isRevoked=false`。
7. 切 issuer-verifier 到真鏈：在 `packages/issuer-verifier/.env` 設定（見 `.env.example`）：
   ```
   CHAIN_MODE=ethers
   AMOY_RPC_URL=https://rpc-amoy.polygon.technology
   CHAIN_PRIVATE_KEY=0x同一把測試私鑰   # 信任根 owner；未設 ISSUER_PRIVATE_KEY 時也兼任銀行 A 發證者（簽憑證＋送撤銷）
   # CHT_ISSUER_PRIVATE_KEY=0x另一把     # 選填：中華電信發證者；設了才能上鏈撤銷它簽的憑證（該位址需有少量 POL 付 gas）
   ```
   合約位址不用填——自動讀 `packages/contracts/deployments/amoy.json`。
8. 驗證端到端：`pnpm --filter @chaintrust/issuer-verifier e2e`（`CHAIN_MODE=ethers` 下每步真的上鏈，較慢屬正常）。
   > 2026-10-17 已在本地 hardhat 鏈完整演練：deploy → smoke → ethers 模式 e2e 全數通過，HTTP 層
   > 簽發→驗證通過→`/revoke`→驗證失敗 也走通。演練中修掉兩個只在真鏈才會出現的 bug：撤銷寫錯命名空間、
   > 連發交易撞 nonce。
9. 到 PolygonScan Amoy 查交易：https://amoy.polygonscan.com/

## 注意

- 僅測試網、無真實資產；錢包保留少量 POL 當 gas 即可。
- `scripts/deploy.ts` 偵測不到私鑰時會給指引而非崩潰（已實作）。
- 部署位址記得回填到 `deployments/` 與 issuer-verifier 設定，決賽 Demo 才能展示「真的在鏈上」。
