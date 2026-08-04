# ChainTrust 系統設計與架構決策（ADR）

## 1. 系統總覽

ChainTrust 是一個 SSI 金融身分錢包 PoC，由四個信任角色與一條鏈上信任根組成：

```
┌─────────────┐   簽發 VC    ┌──────────────┐   出示(最小揭露)   ┌──────────────┐
│  Issuers    │ ──────────▶ │ Holder 錢包   │ ───────────────▶ │  Verifier     │
│ CHT門號電子卡 │             │ (did:key)     │                  │ 銀行 / 商家    │
│ 銀行 KYC     │             │ React PWA     │                  │               │
│ (did:key)   │             └──────────────┘                  └──────┬───────┘
└──────┬──────┘                                                       │
       │ 由 CHT PublicCA 根背書                          驗章+查信任+查撤銷+AI風險
       │                                                              │
       ▼                                                              ▼
┌────────────────────────────────────────────┐          ┌──────────────────────┐
│ 鏈上：IssuerRegistry / RevocationRegistry    │◀─────────│ AI 反詐引擎 (FastAPI)  │
│ Polygon Amoy testnet（落地：CHT BaaS）        │          │ /score 即時風險分數     │
└────────────────────────────────────────────┘          └──────────────────────┘
```

### 信任流程（端到端五步）

1. **建立信任根**：管理者（代表 CHT PublicCA）在 `IssuerRegistry` 把銀行/CHT 的 Issuer DID 標記為可信。
2. **簽發**：Issuer 用 Veramo 簽發 `KYCCredential`（含 `credentialStatus` 指向 `RevocationRegistry`），交給 Holder 錢包。
3. **出示**：Holder 以 SD-JWT 選擇性揭露，只交出 Verifier 需要的欄位（如「已通過 KYC」「年齡≥18」）。
4. **驗證**：Verifier 驗章 → 查 `IssuerRegistry.isTrustedIssuer` → 查 `RevocationRegistry.isRevoked`。
5. **反詐**：驗證通過後呼叫 AI `/score`，回傳風險分數與決策（放行／加強驗證／攔截）。

### 為什麼需要鏈？（而不是中心化資料庫）

鏈上只放兩樣東西：**信任旗標**（IssuerRegistry）與**撤銷雜湊**（RevocationRegistry），個資零上鏈。選擇鏈而非任一機構的資料庫，理由有三：

1. **跨機構中立性**：信任根與撤銷狀態是「機構之間」的共識，不該由任一銀行持有——若由銀行 A 維運，競爭者銀行 B 沒有查詢與信任它的理由。鏈是所有 Verifier 都能無條件查詢的中立公證層（落地時為 CHT BaaS 聯盟鏈，中華電信作為中立電信方主持節點，正是其天然角色）。
2. **不可竄改稽核**：背書（`IssuerTrustChanged`）與撤銷（`CredentialRevoked`）都是鏈上事件，留下可回溯、不可事後竄改的事證。金融爭議（「這張憑證當時到底有沒有效？」）可以用鏈上狀態在特定區塊高度重建。
3. **可攜性與抗單點**：使用者換錢包、換機構，憑證的信任狀態不跟任何單一服務商綁定；任一參與方退出也不影響其餘機構繼續驗證。

反過來說，凡是**不需要**跨機構共識的資料（個資、繳費明細、交易脈絡）一律不上鏈——留在使用者錢包（SD-JWT disclosure）或機構內部。這條「鏈上最小化」原則與最小揭露原則互為表裡。

## 2. 元件職責

| 套件 | 職責 | 對外介面 |
| :-- | :-- | :-- |
| `packages/contracts` | 鏈上信任根與撤銷登記 | `IssuerRegistry`, `RevocationRegistry` |
| `packages/issuer-verifier` | Veramo agent、簽發、驗證、串 AI | `issuer.ts`, `verifier.ts`, Express API |
| `packages/ai-service` | 風險評分 | `POST /score` |
| `packages/wallet` | Holder 持有/出示/最小揭露/警示 | React PWA |

## 3. 鏈上合約設計

### IssuerRegistry
- `mapping(address => bool) trustedIssuer`（以 issuer 鏈上位址索引；位址由 did:key Secp256k1 公鑰推導，亦相容 did:ethr）。
- `setTrustedIssuer(address issuer, bool trusted)` — 僅 owner（代表 CHT PublicCA 根）。
- `isTrustedIssuer(address) view returns (bool)`。
- 事件：`IssuerTrustChanged(address indexed issuer, bool trusted)`。

### RevocationRegistry
- 撤銷以 `bytes32 credentialHash`（VC id 的 keccak256 雜湊）為鍵。
- 建構子帶入 `IssuerRegistry` 位址；**撤銷權綁定信任根**：僅受 `IssuerRegistry` 背書的簽發者可 `revoke`，首位撤銷者被記為 `issuerOf`，之後僅其可 `revoke/unrevoke`。未受信任的任意第三方無法撤銷 → 杜絕「知道 revocationKey 即可惡意撤銷他人有效憑證」。
- `isRevoked(bytes32) view returns (bool)`。
- 事件：`CredentialRevoked` / `CredentialUnrevoked(bytes32 indexed hash, address indexed issuer)`。
- 殘留風險與後續：受信任簽發者集合內仍可能搶綁尚未撤銷之 hash；未來以「簽發時由 issuer 簽章綁定」強化。

## 4. 架構決策（ADR）

### ADR-001 Monorepo 用 pnpm workspace
**決策**：採 pnpm workspace 管理四套件。**理由**：跨套件型別/設定共用、單一 lockfile、`pnpm -r` 一次測全部。**取捨**：團隊需安裝 pnpm（已具備 0.31）。

### ADR-002 PoC 鏈用 Polygon Amoy
**決策**：PoC 部署 Polygon Amoy（chainId 80002）。**理由**：EVM 相容、水龍頭易取得、與 did:ethr 相容。**落地**：以相同合約介面遷移至 CHT BaaS，呼叫端不變。

### ADR-003 DID 方法：Holder 與 Issuer 皆 did:key(Secp256k1)
**決策**：Holder 與 Issuer 皆用 `did:key`（Secp256k1）。Issuer 的鏈上信任位址由其公鑰推導（`computeAddress(pubkey)`）並登記於 `IssuerRegistry`，亦相容 `did:ethr`。**理由**：did:key 離線可生成、錢包友善；以公鑰推導位址即可對應鏈上信任查詢，issuer 無需先上鏈。**取捨**：實作以 did:key 為主（與 `agent.ts` 一致）。

### ADR-004 選擇性揭露用 SD-JWT
**決策**：VC 採 SD-JWT（`@veramo/credential-w3c` + SD-JWT plugin）。**理由**：金融個資需最小揭露，Verifier 只拿必要欄位，明文不落鏈。**取捨**：較 JWT-VC 複雜，但符合 PoC 核心價值。

### ADR-005 撤銷用鏈上 RevocationRegistry（非 StatusList2021）
**決策**：PoC 以自建鏈上 `RevocationRegistry`（mapping 查詢），且**撤銷權綁定 `IssuerRegistry` 信任根**（僅受背書簽發者可撤銷並綁定 `issuerOf`）。**理由**：Demo 可即時鏈上撤銷、查詢直觀，並避免任意第三方惡意撤銷；StatusList2021 與「簽發時簽章綁定」留作落地優化。

### ADR-006 AI 反詐先規則 baseline，後 ML
**決策**：`/score` 先以可解釋規則（金額/頻率/裝置/人頭特徵）跑通，再以 `train.py`（LightGBM + IsolationForest）訓練 `model.joblib`，`model.py` 自動載入。**理由**：先打通 Demo 線、模型可後補且向後相容。

### ADR-007 CHT 整合點一律 adapter + mock
**決策**：PublicCA 根背書、門號電子卡、BaaS、CHT Security 情資、Hami Pay 皆以介面 + mock 實作。**理由**：賽時無正式 API，落地時替換實作不動呼叫端。

## 5. 安全與隱私護欄

- 僅 testnet；私鑰/助記詞/`.env`/Veramo `*.sqlite` 一律 `.gitignore`，不入庫。
- 明文個資不落鏈；鏈上只存信任旗標與撤銷雜湊。
- 最小揭露：SD-JWT 只揭露 Verifier 所需 claim。
- 不可否認：簽發/出示/驗證留可稽核紀錄（jsonl），不含明文個資。
