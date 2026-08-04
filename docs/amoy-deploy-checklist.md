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
   - 將 **deployer 自身**設為受信任 issuer——`RevocationRegistry.revoke` 要求 `msg.sender` 受信任，
     而 issuer-verifier 的撤銷交易由 `CHAIN_PRIVATE_KEY`（= deployer）簽，**缺這步 e2e/server 的撤銷會 revert**。
   - （可選）`TRUST_ISSUER=0x...` 額外背書一個 issuer 位址（例如 server `/health` 回傳的 `issuerAddr`）。
   - `revoke` 一筆測試 hash → 確認 `isRevoked=true`。
   - `unrevoke` → 確認 `isRevoked=false`。
7. 切 issuer-verifier 到真鏈：在 `packages/issuer-verifier/.env` 設定（見 `.env.example`）：
   ```
   CHAIN_MODE=ethers
   AMOY_RPC_URL=https://rpc-amoy.polygon.technology
   CHAIN_PRIVATE_KEY=0x同一把測試私鑰   # 簽 setTrustedIssuer/revoke；不設則唯讀
   ```
   合約位址不用填——自動讀 `packages/contracts/deployments/amoy.json`。
8. 驗證端到端：`pnpm --filter @chaintrust/issuer-verifier e2e`（`CHAIN_MODE=ethers` 下每步真的上鏈，較慢屬正常）。
9. 到 PolygonScan Amoy 查交易：https://amoy.polygonscan.com/

## 注意

- 僅測試網、無真實資產；錢包保留少量 POL 當 gas 即可。
- `scripts/deploy.ts` 偵測不到私鑰時會給指引而非崩潰（已實作）。
- 部署位址記得回填到 `deployments/` 與 issuer-verifier 設定，決賽 Demo 才能展示「真的在鏈上」。
