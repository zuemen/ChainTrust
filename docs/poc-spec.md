# ChainTrust PoC 技術規格（給開發者）

本檔定義 PoC 的可驗收行為、介面契約與里程碑驗收條件。實作以此為準，與 `architecture.md` 的 ADR 一致。

## 1. 環境需求

- Node ≥ 20（本機 v24）、pnpm 9
- Python ≥ 3.11（本機 3.13）
- Polygon Amoy 測試錢包私鑰（放 `packages/contracts/.env`，**勿入庫**）+ 水龍頭代幣

## 2. 套件介面契約

### 2.1 contracts

```solidity
interface IIssuerRegistry {
  function setTrustedIssuer(address issuer, bool trusted) external; // onlyOwner
  function isTrustedIssuer(address issuer) external view returns (bool);
  event IssuerTrustChanged(address indexed issuer, bool trusted);
}

interface IRevocationRegistry {
  function revoke(bytes32 credentialHash) external;   // only original issuer
  function unrevoke(bytes32 credentialHash) external; // only original issuer
  function isRevoked(bytes32 credentialHash) external view returns (bool);
  event CredentialRevoked(bytes32 indexed credentialHash, address indexed issuer);
  event CredentialUnrevoked(bytes32 indexed credentialHash, address indexed issuer);
}
```

### 2.2 issuer-verifier

- `createVeramoAgent()` → 回傳設定好 `did:key`/`did:ethr`、credential-w3c、SD-JWT、（離線）撤銷檢查的 agent。
- `issuer.ts`
  - `issueKYCCredential({ holderDid, subject })` → 簽發 `KYCCredential`（claims：`kycLevel`、`fullVerified`、`over18`、`credentialStatus`）。
  - `issueMobileRealNameCredential({ holderDid, subject })` → `MobileRealNameCredential`（claims：`msisdnVerified`、`carrier`、`realName`）。
- `verifier.ts`
  - `verifyCredential(agent, chain, vc)` → `{ ok, checks: { signature, trustedIssuer, notRevoked }, reason?, issuerAddress? }`。
  - 流程：驗章 → `IssuerRegistry.isTrustedIssuer(issuerAddr)` → `RevocationRegistry.isRevoked(hash)` →（M2.1）AI `/score`。
- `sdjwt.ts`（M2.0 選擇性揭露）
  - `issueKycSdJwt({issuer, holderDid, subject})` → SD-JWT VC，PII claim（`kycLevel`/`over18`/`country`/`fullName`/`birthDate`）皆為 salted、可選擇揭露；`credentialStatus` 常駐可見。
  - `presentKycMinimal(sdJwtVc, revealKeys)` → Holder 只揭露指定欄位（預設僅 `kycLevel`）。
  - `verifyKycSdJwtPresentation(chain, presentation, {minKycLevel})` → `{ ok, checks:{signature,trustedIssuer,notRevoked,predicate}, disclosed[], withheld[], payload }`；在缺完整 PII 下驗章，仍走 `isTrustedIssuer` + `isRevoked`，並評估 `kycLevel>=門檻` 述詞。
  - 簽/驗用 issuer 的 Secp256k1（ES256K，did:key 推導公鑰），實作於 `@sd-jwt/sd-jwt-vc`。
- `fraud.ts` + `verifyAndScore`（M2.1 整合）
  - `scoreTransaction(ctx, {baseUrl})` → 呼叫 ai-service `POST /score`；服務不可用時回 `decision:"review"` + `FRAUD_SERVICE_UNAVAILABLE`（不擋驗證）。
  - `verifyAndScore(agent, chain, vc, txContext)` → 憑證有效才評分；`outcome`：pass→`approve`、review→`review`、block→`reject`；憑證無效直接 `reject`。
  - server 端點：`POST /verify-and-score`（{vc, tx}）、`POST /score`（代理）。

### 2.3 ai-service（M2）

```
POST /score
  req:  { amount, channel, deviceNew, velocity24h, accountAgeDays, ... }
  resp: { riskScore: 0..1, decision: "allow"|"step_up"|"block", reasons: string[] }
```

### 2.4 wallet（M2）

- 掃碼/貼上出示請求 → 最小揭露同意（顯示將揭露欄位）→ 出示 → 顯示驗證結果 + 風險警示。

## 3. CHT 整合點（adapter + mock）

| Adapter | 介面 | mock 行為 |
| :-- | :-- | :-- |
| `PublicCaAdapter` | `anchorIssuerRoot()` | 直接回傳「已由 CHT 根背書」 |
| `MobileCardAdapter` | `verifyMsisdn(msisdn)` | 回傳固定已驗證門號身分 |
| `BaasAdapter`（程式碼為 `ChainGateway`，見 `src/chain/gateway.ts`） | 合約 provider 切換 | 預設指向 Amoy，落地切 CHT BaaS（Ethereum 相容，見 `docs/completeness-roadmap.md` §3.1） |
| `ThreatIntelAdapter` | `lookup(entity)` | 回傳 mock 情資命中分數 |

## 4. 里程碑驗收條件

### M1 身分層 ✅ 條件
1. `pnpm --filter @chaintrust/contracts test` 全綠：`IssuerRegistry`、`RevocationRegistry` 覆蓋權限/事件/查詢。
2. `scripts/deploy.ts` 能從 `.env` 讀私鑰部署 Amoy（無私鑰時給清楚錯誤訊息，不崩潰）。
3. e2e 腳本：簽發一張 `KYCCredential` → 驗證**通過**；撤銷後驗證**失敗**（`notRevoked=false`）。

### M2 反詐 + 錢包 ✅ 條件
4. `/score` 規則 baseline 可跑；`train.py` 產 `model.joblib`，`model.py` 自動載入；pytest 通過。
5. `verifier.ts` 驗證通過後呼叫 `/score`，回傳風險分數與決策。
6. 錢包完成一次「跨機構重用 KYC（最小揭露）」並在高風險交易顯示攔截警示。

### M3 串線 ✅ 條件
7. 單一指令（docker-compose 或腳本）起 contracts 本地節點 + ai-service + issuer-verifier + wallet。
8. README 操作步驟可現場照做跑完五步。

## 5. 測試策略

- 合約：Hardhat + chai，正常/權限/事件/邊界（重複撤銷、非 issuer 撤銷）。
- issuer-verifier：單元（issuer/verifier 純函式）+ e2e（簽發→驗證→撤銷→驗證失敗）。
- ai-service：pytest（規則邊界 + 模型載入 smoke）。

## 7. 現場 Demo 腳本

見 [`DEMO.md`](DEMO.md)：五步操作、講稿重點、`pnpm demo` / `docker compose up` 啟動、`pnpm smoke` 自動驗證、疑難排解。

## 6. 不做（PoC 範圍外）

- 正式 CHT API 串接（以 mock 代替）
- 主網部署
- 完整 StatusList2021（用簡化鏈上 RevocationRegistry）
- 多語系、正式 UI 設計系統
