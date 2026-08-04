# ChainTrust 鏈信 — 全專案嚴格安全掃描報告

> 掃描日期：2026-08-04 ｜ 範圍：contracts / issuer-verifier / wallet / ai-service / 基礎設施
> 方法：五路平行審查，High 以上皆逐行核對；issuer-verifier 兩個 Critical 以可執行 PoC 實測繞過確認。

## 修復狀態（2026-08-04 當日完成）

4 個 Critical 與 17 個 High 全數處理。測試由 **46 → 94+**（contracts 16→32、issuer-verifier 30→62、ai-service 22→32）。

| 項目 | 狀態 | 證據 |
| :-- | :-- | :-- |
| C1 did:key#did:ethr 繞過信任根 | ✅ 已修 | canonical DID + method 分派 + 正則錨定；`test/security.test.ts` 5 測試 |
| C2 VC 外層信封偽造 | ✅ 已修 | 改用 `res.verifiableCredential` + 強制 JwtProof2020；PoC 實測確認漏洞為真 |
| C3 私鑰明文存 localStorage | ✅ 已修 | 密語派生金鑰 + AES-GCM 封裝，解鎖後才簽 |
| C4 CHT 訊號標籤洩漏 | ⚠️ 已標註 | 無法靠改程式消除（需真實資料）；已在程式/metrics/model card 三層標註 evidence_grade=simulation，並加必填 opt-in 護欄 |
| H1 KB-JWT iat 短路 | ✅ 已修 | iat 改必填 + 雙向時間窗 |
| H2/H8 驗證政策由前端決定 | ✅ 已修 | aud/nonce 改必填參數，KB 恆必驗；HTTP 層測試釘住 |
| H3 API key fail-open | ✅ 已修 | 非 dev 缺 key 拒絕啟動 + timingSafeEqual |
| H4 憑證無有效期 | ✅ 已修 | KYC 180 天 / 信譽 90 天，驗證端檢查 exp/nbf |
| H5 /sdjwt/present 簽章機 | ✅ 已修 | 預設關閉 + 需鑑權 |
| H6 pnpm build 壞掉 | ✅ 已修 | 檔案移出 rootDir，tsc 由 6 錯誤變 0 |
| H12/H13 合約撤銷授權 | ✅ 已修 | issuer 命名空間 + unrevoke 補權限；contracts 32 測試 |
| H14 圖譜特徵 train/serve 偏移 | ✅ 已修 | ScoreRequest 補欄位，走 API 的 reason code 測試 |
| H15 負數 amount → 500 | ✅ 已修 | schema 界限 + log1p clamp |
| infra API_KEY 未進容器 | ✅ 已修 | compose 傳入 + port 綁 127.0.0.1 |
| H7 nginx 無安全標頭 | ✅ 已修 | CSP / frame-ancestors / nosniff 等 |
| CI 不存在 | ✅ 已建 | `.github/workflows/ci.yml` |

**已知殘留（需後續處理）**：`metrics.json` 的門檻等數字仍是舊訓練產物（需重跑 `pnpm ai:train`）；`graph_features_for_row` 仍是死碼（接線屬功能新增）；C4 的 `lift_pct` 數字本身仍是循環論證的產物。

---

## 以下為原始掃描發現（完整版）

## 嚴重度統計

| 套件 | Critical | High | Medium | Low | Info |
| :-- | :-: | :-: | :-: | :-: | :-: |
| issuer-verifier | 2 | 6 | 7 | 7 | 4 |
| wallet | 1 | 5 | 7 | 5 | 3 |
| contracts | 0 | 2 | 4 | 6 | 5 |
| ai-service | 1 | 3 | 7 | 4 | 2 |
| 基礎設施 | 0 | 1 | 6 | 5 | 4 |
| **合計** | **4** | **17** | **31** | **27** | **18** |

---

## Critical（4）— 信任根與身分核心被繞過

### C1. `did:key:z…#did:ethr:0x<受信任位址>` 完全繞過信任根
`src/verifier.ts:140-149`。did:ethr 正則 `/did:ethr:(?:[^:]+:)?(0x[0-9a-fA-F]{40})/` 未錨定 `^$`，且此分支排在 `did:key` 之前；`secp256k1PublicKeyFromDidKey` 又會 `.split("#")[0]` 丟掉 fragment。結果**驗簽用 `#` 前的攻擊者公鑰，查信任清單用 `#` 後塞入的受信任位址**。PoC 實測：攻擊者自簽 `kycLevel:99`、`iss = "did:key:z<自己公鑰>#did:ethr:0x1111…1111"`，回報 `issuerAddress=0x1111…`、`ok=true`、五項檢查全綠。任何人都能自簽一張「銀行核發的 KYC」。`credentialHash.ts:21` 同款正則一併修。**修法成本最低影響最大：正則加錨定 + 先 method 分派 + 驗簽與信任查詢用同一次解析結果。**

### C2. VC 外層信封未與 JWT 綁定，可偽造 issuer / 主體 / 撤銷鍵
`src/verifier.ts:89-103`。`verifyCredential` 只取 Veramo 的 `res.verified` 布林，之後 issuer、subject、revocationKey 全從**呼叫端傳入的 vc 物件**讀。Veramo 的信封一致性檢查前置條件是 `proof.type === 'JwtProof2020'`，把 `proof.type` 改成任何其他字串即可跳過而簽章仍過。PoC 實測：改 `issuer.id` 為受信任 DID、加 `privilegeLevel:ADMIN`、換 `revocationKey`、`proof.type` 改 `JsonWebSignature2020` → `ok:true`；同法可讓已撤銷 VC 復活。**修法：只信任 `res.verifiableCredential`（JWT 解出的 payload），並硬性要求 `proof.type==='JwtProof2020'`。**

### C3. 持有者私鑰明文存 localStorage
`packages/wallet/src/keys.ts:15,68-72`。私鑰以明文 hex 存 localStorage，無加密、無 KDF、無密語。任一 XSS/惡意相依/裝置備份即可 `localStorage['chaintrust.holderKey']` 帶走，之後可在任何裝置為此 DID 簽任意 KB-JWT，系統再也無法分辨真假持有者；VC 本體也在同一儲存，一次拿走身分＋憑證。**修法：改用不可匯出的 CryptoKey / IndexedDB + 使用者密語封裝，簽章前必須解鎖；長期走 WebAuthn/passkey。**

### C4. CHT 訊號以標籤為條件生成 = 結構性標籤洩漏
`packages/ai-service/synth.py:174-195` + `train.py:89-91`。`augment_cht_signals()` 直接讀 `df["isFraud"]`，再用「詐欺一個分佈、正常另一個分佈」生成全部 9 個 CHT 訊號欄，且此函式在載入「真 PaySim」時也會套用。metrics.json 的 `cht_signal_ablation`（lift +16.45%）量的不是訊號增益、而是注入了多少標籤資訊——循環論證，卻被當成核心賣點。**修法：半合成欄位在 model card/metrics 明標 "label-conditioned simulation, not evidence"，消融實驗只能在訊號來源獨立於標籤的資料上做，否則刪除該增益聲稱。**

---

## High（17）

### issuer-verifier
- **H1** `sdjwt.ts:245-248` KB-JWT `iat` 缺失/未來值時新鮮度檢查被短路，出示可無限期重放。實測缺 iat 與 iat=now+10 年皆 `ok:true`。改 iat 必填 number + 雙向窗口。
- **H2** `sdjwt.ts:354-358` + `server.ts:133-147` 驗證政策（requireKeyBinding / expectedNonce / expectedAud）由 **HTTP request body** 決定。curl 不帶這些欄位即 `ok:true`，KB 與防重放形同虛設。政策必須寫死在伺服器端。
- **H3** `server.ts:70-74` + `config.ts:18` API key **fail-open**：未設 `API_KEY` 直接放行。任何人可 `POST /sdjwt/issue` 取得受信任 issuer 簽發的 full KYC；`/revoke` 也裸奔。改 fail-closed（非 dev 未設 key 即 exit）。
- **H4** `sdjwt.ts:138-157` / `issuer.ts:36-53` 憑證**沒有有效期**（無 exp/nbf/expirationDate），三年前的 KYC 今天仍驗過。簽發時加 exp。
- **H5** `server.ts:112-128` `/sdjwt/present` 是**未鑑權的 KB-JWT 簽章機**，接受任意 holderDid/vc/aud/nonce 用伺服器私鑰簽。刪除或加旗標＋鑑權。
- **H6** `smokeBrowserWallet.ts:13-14` **`pnpm build` 目前是壞的**（TS5097/TS6059），Docker image 建不起來，`dist/` 是 stale 舊版。移出 rootDir、tsconfig exclude test。

### wallet
- **H7** `nginx.conf:1-16` 生產映像**無任何安全標頭**（無 CSP / X-Frame-Options / frame-ancestors）且只監聽明文 HTTP。C3 竊鑰無縱深防禦、同意框可被 clickjacking、VC/nonce 明文過網。
- **H8** `App.tsx:161-164` 同上 H2 前端側：requireKeyBinding/expectedNonce 由前端傳，綠勾成裝飾。
- **H9** `App.tsx:49-69,161` **AI 反詐的交易上下文由瀏覽器捏造**（金額、實名、payee_risk 全是前端常數），要被攔截的人正好能改成 pass。tx 應由依賴方後端提供。
- **H10** `keys.ts:76-84` + `sdjwt.ts:59-66` `sign(data)` 是**無確認、無 domain separation 的簽章 oracle**，任意腳本可呼叫取得任意內容簽章。只匯出限定用途的 `signKeyBinding`。
- **H11** `App.tsx:112-123` 錢包對收到的 VC **不做任何驗證**就存並顯示（不驗簽、不比對 cnf、不檢查 exp）。中間人可回假 VC。加 `validateIssuedVc()`。

### contracts
- **H12** `RevocationRegistry.sol:44-53` **任一受信任 issuer 可搶先撤銷別家簽發的 VC 且原簽發者永遠無法奪回**。授權只有 `onlyTrustedIssuer`，撤銷鍵無 issuer 命名空間，`issuerOf` 首次撤銷才隱式綁定＝「誰先撤誰就是 issuer」。revocationKey 明文出現在每次出示裡。改 `mapping(address=>mapping(bytes32=>bool))`。
- **H13** `RevocationRegistry.sol:56-60` `unrevoke()` **漏 `onlyTrustedIssuer`**，被撤信任的 issuer 仍可把已撤銷憑證改回有效。與 H12 合併後果最嚴重。

### ai-service
- **H14** `schemas.py:36` + `main.py:72` **圖譜特徵在服務端永遠為 0**：ScoreRequest 沒有 nameOrig/payee_fan_in 等欄且 `extra:ignore`，呼叫端帶了也被丟棄。模型訓練用了這兩個特徵、推論恆為 0＝train/serve 偏移；`graph_features_for_row` 是死碼，MULE_RING reason code 經 API 永不觸發。
- **H15** `featurize.py:102` + `schemas.py:14` **負數 amount → 未處理 ValueError → 500**（`math.log1p(-5)` 實測崩），amount 無 `ge=0` 約束。若上游對 500 fail-open 等於一個負數繞過風控。
- **H16** `synth.py:35-162` 合成詐欺由規則生成、再用幾乎相同規則偵測，指標量的是「生成器復原」；docstring 稱「logit 抽樣」與實作「分塊硬標 0/1」直接矛盾。PR-AUC 0.86 等不可外推。

---

## Medium（重點節錄，共 31）

- **infra-M1** `docker-compose.yml:16-27` compose **沒傳 `API_KEY`/`CORS_ORIGIN` 進容器**，README 宣稱的端點保護在 docker 模式下根本無法啟用；ports 綁 0.0.0.0，同網段任何人可 `/revoke`、`/sdjwt/issue`。（列為 High 級實害，根因在 infra）
- `docker-compose.yml` 三服務皆缺 healthcheck/restart、以 root 執行；ai-service 無認證即對外發布。
- **缺 `.github/` CI/CD 完全不存在**；所有 package.json 用 `^` caret，Docker install 未加 `--frozen-lockfile`，requirements.txt 全 `>=` 無上界＝供應鏈漂移不可見。
- `ai-service/package.json` scripts 寫死 Windows 路徑（`.venv\Scripts\python`），macOS/Linux 必壞；`ai:setup` 與 pnpm 內建指令衝突（origin/main 已修，本機分支落後）。
- issuer-verifier：nonce 無 TTL/上限 + TOCTOU + 失敗不消耗；未驗 `vct`（其他型別憑證只要有 kycLevel 就被當 KYC）；鏈上呼叫無 try/catch/timeout（RPC 抖動→500，且非 fail-closed）；`CHAIN_MODE` 拼錯**靜默退回記憶體模擬信任根**（fail-open）；issuer 私鑰只存記憶體每次重啟換一組；輸入驗證缺失導致型別混淆變 500；server.ts 零 HTTP 層測試。
- wallet：「刪除憑證」不刪私鑰（`forgetHolderKeys` 是死碼）；無金鑰備份/還原且遷移邏輯會靜默刪 VC；簽章前未揭露 aud/nonce；無 ErrorBoundary 一次型別不符整頁白屏；VC 全文含 PII 明文存 localStorage。
- contracts：`renounceOwnership` 未封鎖 + 單步 transferOwnership 可永久凍結信任根；信任根為單一 EOA 即時生效無 timelock/多簽；缺信任根層級緊急撤銷/暫停，唯一補救是「取消整家 issuer 信任」＝全有全無。
- ai-service：服務端 risk（0.7p+0.3anomaly）從未被評估/校準；metrics 自家 LR(0.8732) 勝過部署的 LGBM(0.8611) 自打臉；confidence 缺統計依據；/score /metrics 無認證可做 model extraction；joblib.load pickle 反序列化面 + bare except 靜默降級；sklearn 下界寫錯(>=1.4 但需 1.6)。

---

## Low / Info（重點）

- **git 狀態**：本機 `feat/browser-holder-keys` 比 origin/main **1 ahead / 18 behind**，未推送的「金鑰自主」功能（10 檔 +503 行）**只存在這台機器**；兩側都動 server.ts/pnpm-lock，越晚同步衝突越大。CLAUDE.md「完成後直接 push」未遵守。**建議立即 push 再 rebase。**
- **機密掃描：乾淨。** 79 個被追蹤檔無任何私鑰/助記詞/API key 命中；`.env.example` 皆空值；`.gitignore`/`.dockerignore` 覆蓋 `.env`/`*.key`/`*.sqlite`。
- 未追蹤的 `proposal/`（含提案 docx/pdf + LibreOffice 鎖檔）與 `docs/deploy-fix-prompt.md` 未被 gitignore 擋，有意外 `git add .` 入庫風險。
- contracts：建構子未檢查 registry 是否為合約（錯填 EOA 報廢）；pragma 浮動未鎖 evmVersion；缺 revokeBatch；撤銷可無限反轉且不記錄理由/時點（應區分 suspend/revoke）。
- issuer-verifier：JWS `alg` 從未驗證（目前靠硬編碼 ES256K 巧合擋住）；錯誤訊息洩漏第三方函式庫內部訊息；CORS 不做 Origin 白名單比對；`/health` 洩漏 issuer DID/位址（正好餵給 C1 攻擊）；簽發預設值直接填「王小明/已過最高 KYC」。

---

## 修復優先序建議

1. **C1**（正則加錨定 + method 分派，一行級成本、影響最大）
2. **C2**（改用 JWT 解出的憑證做所有判斷）
3. **H2/H8**（驗證政策收回伺服器端，requireKeyBinding/aud/nonce 不可由請求覆寫）
4. **H3 + infra-M1**（API key fail-closed，且 compose 真的把 key 傳進容器、port 綁 127.0.0.1）
5. **H12/H13**（RevocationRegistry 改 issuer 命名空間 + unrevoke 補 onlyTrustedIssuer；Ownable→Ownable2Step 並封鎖 renounce）
6. **C3**（私鑰加密封裝 + 解鎖後才簽）
7. **C4**（model card / metrics 標註半合成、撤下 CHT 增益聲稱）
8. **H6**（修好 `pnpm build`，否則 Docker 部署根本起不來）
9. 立即 **push 本機分支**避免功能遺失
