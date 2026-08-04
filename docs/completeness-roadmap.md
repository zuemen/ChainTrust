# ChainTrust 完整度分析與落地路線圖

> 目的：盤點 PoC 現況，檢視「普惠金融、防詐、區塊鏈、AI」四大主軸是否都講得清楚，
> 並以「與中華電信合作落地」為目標列出待補清單。
> 撰於 2026-07-02，基於 docs/ 全部文件 + 程式碼實況（全測試綠：合約 16、pytest 19、iv e2e 全過）。

---

## 1. 現況總評（Scorecard）

| 主軸 | 完成度 | 一句話評語 |
| :-- | :--: | :-- |
| 防詐（AI 反詐） | ★★★★☆ | 最強的一軸：樣態特徵（過水/拆分/水房）、校準、PR-AUC、CHT 訊號 ablation（+16.45%）都有，但資料是半合成 |
| 區塊鏈 | ★★★☆☆ | 合約設計扎實（撤銷權綁信任根），但 Demo 預設跑 InMemory、尚未真部署 Amoy；「為什麼需要鏈」的論述待強化 |
| AI（工程成熟度） | ★★★★☆ | 訓練/評估紀律好（out-of-time、校準、誠實聲明），但有一個未解釋的訊號：LR 的 PR-AUC（0.8732）> LightGBM（0.8611） |
| 普惠金融 | ★☆☆☆☆ | **最大缺口**：README 列為三大價值之一（「無信用紀錄者累積可攜財務信譽」），但 docs 與程式碼**完全沒有**對應實作或說明 |
| 落地性（CHT 合作） | ★★☆☆☆ | adapter 介面乾淨，但 mock 極薄；缺「CHT 真實產品對應表」、法規對應、商業模式、試點設計 |

**整體**：五步 Demo 線（M1–M3）已完整打通，作為比賽 PoC 是成熟的。
要往「電信合作落地」走，缺的不是更多程式碼，而是**普惠金融的實作補位**與**落地論述的工程化**（把 mock 變成有真實產品名稱、API 規格、法規依據的整合計畫）。

---

## 2. 四大主軸解釋力檢視

### 2.1 防詐 — 講得最清楚，剩「真資料」與「跨機構」兩塊

**已有（可直接寫進簡報）**
- 樣態特徵對齊 FATF/Europol/AML 語言：`pass_through`（過水）、`near_threshold`（結構化拆分）、`fan_in`（水房聚合戶，`app/graph.py`）。
- Reason codes 中文化、SHAP top_factors、錢包顯示「AI 判斷主要依據」→ 可解釋性完整。
- 評估紀律：PR-AUC 主指標、out-of-time 切分、isotonic 校準（ECE 0.001）、recall@FPR=1% = 0.85。
- **CHT 訊號 ablation**：無 CHT 訊號 PR-AUC 0.739 → 有 0.861（+16.45%）。這是「為什麼要跟電信合作」最硬的量化證據。

**缺口**
1. **資料真實性**：目前 40,000 筆全合成（PaySim-like），詐欺率 9.45% 遠高於真實世界（<1%）。真 PaySim 尚未實跑。
2. **跨機構情資已接進 `/score`**（2026-07-21，見 §5 執行日誌）；「聯邦學習護城河」仍只出現在簡報論點，零程式碼。
3. **台灣政策對齊未成文**：打詐綱領、詐欺犯罪危害防制條例（2024）、警示帳戶新制（每日轉帳/提領 ≤1 萬）散落在 claude-code-prompt-v3.md 的背景資料，沒有進正式文件與 demo 情境。

### 2.2 區塊鏈 — 設計對，但「為什麼要鏈」還沒講死

**已有**
- `IssuerRegistry`（信任根背書）+ `RevocationRegistry`（撤銷權綁定信任根，杜絕第三方惡意撤銷）— 這個設計比多數 PoC 認真。
- ADR 明確：Amoy testnet → CHT BaaS 遷移路徑，合約介面不變。

**缺口**
1. **尚未真的上鏈**：Demo 預設 InMemory 閘道，`amoy-deploy-checklist.md` 是待辦不是已辦。評審/合作方問「鏈上證據呢？」目前只能給本機輸出。
2. **「為什麼不用中心化資料庫？」沒有標準答案**。建議論述三點：
   - **跨機構中立性**：信任根與撤銷狀態不該由任一銀行持有（否則競爭對手不會查）；鏈是機構間的中立公證層。
   - **不可竄改稽核**：撤銷/背書事件留鏈上事證，金融爭議可回溯。
   - **可攜性**：使用者換機構、換錢包，信任狀態不跟任何單一服務商綁定。
3. **撤銷隱私**：`RevocationRegistry` 以 credentialHash 查詢，驗證方查詢行為本身可被關聯分析（誰在何時驗了哪張證）。ADR-005 已提 StatusList2021 留作落地優化，應寫明這是隱私動機而不只是相容性動機。
4. **金鑰自持與復原**：e2e 註明「PoC：holder 金鑰在 server agent」——這與 SSI「自主權」主張直接矛盾，是落地前必須解的架構債。金鑰復原（丟手機怎麼辦）完全沒著墨——**而這正是電信的差異化機會**（門號 + SIM 綁定復原）。

### 2.3 AI — 工程成熟，剩模型本身的兩個疑點

**已有**：見 2.1；另外 `model.py` 無模型時退回規則 baseline 的降級設計、`FRAUD_SERVICE_UNAVAILABLE` 不擋驗證流程，都是正確的工程判斷。

**缺口**
1. ~~**Logistic Regression 打贏 LightGBM**（PR-AUC 0.8732 vs 0.8611）：暗示合成資料的詐欺樣態過於線性可分。~~ **已解答**（見 `docs/model-card.md` §4）：真 PaySim 資料上 LR 與 LightGBM 幾乎同分，證明這不是「合成資料太假」，而是 PaySim 資料家族本身金流訊號線性可分性偏強，跟合成與否無關。
2. ~~**沒有模型治理文件**~~ **已補**：`docs/model-card.md`（訓練資料、架構、指標、限制、偏誤聲明、重訓節奏建議、漂移監控建議）。（2026-07-21）
3. **對抗性視角缺席**：詐團會適應（例如刻意避開 near_threshold 帶）。至少要在文件裡承認並給出「規則+模型+情資三層互補」的回應。

### 2.4 普惠金融 — 目前只是一句口號，需要從零補

README 寫「**普惠財務信譽** — 無信用紀錄者也能累積可攜、可驗證的財務信譽」，但：
- 沒有任何 VC 類型承載「財務信譽」（只有 `KYCCredential`、`MobileRealNameCredential`）。
- Demo 五步完全沒有普惠情境。
- docs/ 沒有任何一份文件解釋這件事怎麼運作。

**為什麼值得補**：這一軸恰好是「電信才做得到」的差異化——
- 目標族群：學生、新住民、移工、自由工作者（thin-file：沒有聯徵信用紀錄，但有多年電信繳費紀錄）。
- **電信繳費紀錄 = 替代信用資料**（telco data for credit scoring 是國際上成熟的普惠金融題型）。
- 敘事閉環：CHT 門號實名（信任根）→ 繳費紀錄簽成 VC（替代信用）→ 錢包最小揭露出示給銀行 → AI 反詐確保這條普惠通道不被人頭帳戶濫用。**四大主軸在這個情境裡全部串起來**。

---

## 3. 落地性（CHT 合作）差距分析

### 3.1 Mock → 真實產品對應表（2026-07-21 調研更新，落地簡報必備）

| Adapter（現況 mock） | 對應真實 CHT 產品（已查證） | 落地仍需確認 |
| :-- | :-- | :-- |
| `PublicCaAdapter` | 中華電信通用憑證管理中心／HiPKI（`publicca.hinet.net`）：OV SSL、電子識別證、RA 系統等 PKI 服務，經濟部依電子簽章法核定 | **時效性風險**：HiPKI／ePKI 根憑證已被 Google Chrome（139 版起）撤銷信任，2026-08-01 起中華電信需暫停簽發 TLS 憑證——需釐清此事件是否波及我們要用的「Issuer 根背書」用途（非瀏覽器 TLS 信任鏈），以及 CHT 重建信任的時程與說法 |
| `MobileCardAdapter` | 「MID+（MID Plus）」行動身分認證服務（2026-07-01 甫與 TWCA 聯合發表）＋ GSMA Open Gateway API：Number Verification（門號驗證）、Know Your Customer Match（身分比對）——中華電信 2024-06 加入 GSMA Open Gateway，截至 2026 年中已取得 11 項官方永久認證 | 實際費率、能否驗證非 CHT 門號（跨電信）、API 呼叫時延是否符合即時交易攔截需求 |
| `BaasAdapter`（現行程式碼實際是 `packages/issuer-verifier/src/chain/gateway.ts` 的 `ChainGateway`，非同名檔案，文件與程式碼命名不一致） | 中華電信「區塊鏈即服務平台」（BaaS）：雲端 REST API，支援 **Ethereum 與 Hyperledger**，機房在 hicloud（資料主權在台灣），支援 HSM 金鑰整合、公私鏈錨定技術 | 合約部署模式（現有 Solidity 合約能否直接部署）、費率、公鏈 vs 需自建授權鏈。**加分發現**：中華電信研究院（CHTTL）已有獨立「DID 身分認證技術」研發項目，明確遵循 **W3C DID 標準**、目標「確保揭露個資最小化」——與本專案架構選型（did:key/did:ethr + SD-JWT）高度一致，落地簡報可引用作為技術路線背書 |
| `ThreatIntelAdapter` | 同一批 GSMA Open Gateway 防詐 API（SIM Swap 偵測、Scam Signal、Call Forwarding Signal、Device ID）＋ 子公司**中華資安國際 CHT Security Co., Ltd.**（`chtsecurity.com`）威脅情資、CHTTL「資安威脅情資技術」（大數據＋AI 產出自主情資）、曝險評級服務 HorusEyes | 情資／API 回傳格式、即時性（能否單筆交易同步查詢）、能否用於外部交易風控——目前查到的多是企業自身資安監控情境（SOC/MDR），不確定是否開放第三方交易評分用途 |
| （未有 adapter） Hami Pay | 中華電信 NFC 電子錢包，綁信用卡／悠遊卡／一卡通／icash2.0，**全台任何電信門號皆可用**（非 CHT 用戶限定） | 沒查到公開商家/開發者串接 API 文件；支付情境整合點在哪一步（出示後扣款？）仍待業務窗口確認 |
| （未有 adapter） **電信繳費紀錄**（普惠信譽用） | 部分對應 GSMA Open Gateway 的 **Know Your Customer Tenure**（用戶合約在網時長）API | 「準時繳費比例」「月均帳單區間」等帳務明細目前查無對應公開 API；個資法下的當事人同意機制仍需洽談 |

**來源**（2026-07-21 查證）：中華電信官方新聞稿〈中華電信攜手臺灣網路認證公司打造數位信任新基石〉（cht.com.tw，2026-07-01）；`secure365.hinet.net` BaaS 產品頁；`chttl.com.tw`（中華電信研究院）區塊鏈與資安技術頁；`chtsecurity.com`；`publicca.hinet.net`；iThome〈臺灣首度引爆憑證信任危機〉。以上為公開網頁資訊整理，實際 API 規格/費率/SLA 仍需業務窗口正式確認。

### 3.2 法規與生態對應（目前零著墨）

- **電子簽章法**（2024 修正）：SD-JWT VC 簽章的法律效力定位；PublicCA 作為憑證機構的角色。
- **個資法**：電信資料轉為 VC 需當事人同意的流程設計；最小揭露正好是合規賣點，要正式論述。
- **金管會**：是否走監理沙盒？開放銀行第三階段（交易面資料）與本案的關係。
- **數發部「數位憑證皮夾」**：政府正在推國家級 DID 皮夾。ChainTrust 若對齊其標準（W3C VC、OID4VC/OpenID4VP），就從「自建錢包」升級成「數位皮夾生態的金融應用」——這是落地敘事的大槓桿，也可能是 CHT 想聽的答案（電信在國家數位身分基建中的角色）。
- **標準化**：SD-JWT VC（IETF draft）、OpenID4VC 出示協定。現在自定 API 出示格式，落地要向標準靠攏才有跨錢包互通性。

### 3.3 商業模式（目前零著墨）

至少要能回答：誰付錢？建議準備：
- **B2B2C**：銀行/支付業者按驗證次數付費（省下的是每次重複 KYC 的成本，市場上單次 eKYC 成本可查證引用）。
- CHT 的收入：門號認證 API 調用費 + BaaS 節點費 + 情資訂閱。
- 使用者免費（普惠前提）。

### 3.4 試點設計（目前零著墨）

落地提案要有最小試點：一家銀行（發證+驗證）× CHT Mobile ID（信任根）× 限定情境（例如線上開戶的二次驗證），定義成功指標（KYC 時間縮短 %、詐阻率、用戶完成率）。

---

## 4. 待辦清單（優先序）

### P0 — 比賽決賽前必補（直接影響評審觀感）

- [x] **普惠金融實作補位**：新增 `FinancialReputationCredential`（mock 電信繳費紀錄 adapter → 簽發信譽 VC → 錢包出示給「微型貸款」情境），Demo 加第 6 步。四大主軸缺一軸的問題就此解決。（2026-07-02）
- [ ] **真部署 Polygon Amoy**：照 `amoy-deploy-checklist.md` 執行，Demo 附 PolygonScan 連結，回答「真的在鏈上嗎」。
  **（2026-07-02 準備工作已完成，只差有測試幣的私鑰）**：`smoke:amoy` 腳本已就緒（deployer 自我背書→revoke→unrevoke→印 PolygonScan 連結）、server 於 ethers 模式自動背書示範 issuer、localhost 鏈已演練 deploy+smoke 全流程。接手者只需：①測試錢包領 Amoy POL ②建兩個 `.env`（見 checklist 步驟 3、7）③依序跑 `deploy:amoy`→`smoke:amoy`→`CHAIN_MODE=ethers` e2e ④回填 PolygonScan 連結至 DEMO.md。**注意**：撤銷交易的 msg.sender 必須受信任，`smoke:amoy` 的 deployer 自我背書是 e2e/server 撤銷能走通的前置，勿跳過。
- [x] **「為什麼要鏈」一頁論述**（中立性/稽核/可攜，見 2.2）進 architecture.md 或簡報。（2026-07-02，architecture.md §1）
- [x] **真 PaySim 重訓**：已實跑（635 萬筆、詐欺率 0.13%），指標存 `metrics.paysim-real.json`。**發現**：PaySim 餘額欄位近決定性 → 指標飽和（PR-AUC 0.998、LR≈LGBM 同分），CHT 增益歸零、且該模型誤放行已實名過水帳戶（背 artifact、泛化差）。2.3 疑點解答：合成資料上 LR 贏 LGBM 不是資料太假，而是 PaySim 家族本身金流訊號過強；demo 維持合成 hard-mode 模型以誠實展示身分訊號邊際價值。（2026-07-02）
- [x] **台灣防詐政策對齊一節**：打詐綱領/警示帳戶新制/165 統計寫進 ai-fraud-spec.md，demo_data.json 加「警示帳戶每日限額規避」案例。（2026-07-02）
- [x] **文件小修**：README「合約測試（12）」→ 16；poc-spec 環境版本（Python 3.11→3.13、pnpm 0.31→9）；DEMO.md「AUC≈0.92」改以 PR-AUC 敘述。（2026-07-02）

### P1 — 落地提案必備（給 CHT 看的版本）

- [x] **CHT 產品對應表**（3.1 表格）補上實際產品調研結果（2026-07-21，含 2026-07-01 甫發布的 MID+/Open Gateway 新聞稿），每個 adapter 檔案頭已註記目標產品與預期 API 形態（`packages/issuer-verifier/src/adapters/cht.ts`、`src/chain/gateway.ts`）。
- [x] **`ThreatIntelAdapter` 接進 `/score`**：情資命中作為加權規則（+35 分），模型模式下由 `model.py` 後處理加成、規則模式下由 `rule_risk()` 自動加總。（2026-07-21）
- [ ] **聯邦學習最小 PoC**：兩個模擬銀行節點不交換明文、只交換梯度/模型更新（如 Flower 框架），支撐「跨機構風險共享」護城河論點。需先補 ADR。
- [ ] **金鑰自持**：Holder 金鑰移到錢包端（瀏覽器 WebCrypto / passkey），KB-JWT 在 client 簽；並設計「門號綁定金鑰復原」流程——把架構債轉成 CHT 差異化賣點。
- [ ] **法規對應文件**：電子簽章法/個資法/金管會沙盒/數發部數位皮夾各一段（3.2），必要處標注「待法務確認」。
- [ ] **對齊 OID4VC/OpenID4VP**：出示流程向標準協定靠攏（至少文件層面規劃遷移路徑）。
- [ ] **商業模式 + 試點設計一頁**（3.3、3.4）。
- [x] **Model card + 模型治理**：訓練資料/限制/偏誤/重訓節奏/漂移監控，見 `docs/model-card.md`。新發現：反詐特徵（`NEW_ACCOUNT`/`NO_REALNAME`/低 `vc_age_days`）與普惠金融目標的薄檔用戶重疊，已明確揭露為待解決張力。（2026-07-21）

### P2 — 長期（正式產品化）

- [ ] StatusList2021 取代鏈上明查撤銷（隱私動機）。
- [ ] 簽發時 issuer 簽章綁定 revocation hash（解 ADR-005 殘留的搶綁風險）。
- [ ] CI（GitHub Actions：contracts test + iv test/e2e + pytest + smoke）。
- [ ] 對抗性測試集（規避 near_threshold、慢速過水等）與紅隊演練文件。
- [ ] 多語系、正式 UI 設計系統、無障礙。
- [ ] CHT BaaS 實際遷移演練（合約不變、只換 provider 的證明）。

---

## 5. 執行日誌

| 日期 | 階段 | 內容 |
| :-- | :-- | :-- |
| 2026-07-21 | P1（CHT 產品對應表） | §3.1 表格改用實際查證的 CHT 產品（來源與日期見表格下方）：`MobileCardAdapter`→MID+（2026-07-01 甫發表）＋GSMA Open Gateway；`ThreatIntelAdapter`→同批 Open Gateway 防詐 API＋中華資安國際/CHTTL 威脅情資；`BaasAdapter`→CHT BaaS（Ethereum/Hyperledger、hicloud）；`BillingHistoryAdapter`部分對應 KYC Tenure API。**加分發現**：CHTTL 已有遵循 W3C DID 標準的 DID 研發項目，與本專案架構高度一致。**風險發現**：HiPKI/ePKI 根憑證 2026-08-01 起被 Chrome 撤銷信任，`PublicCaAdapter` 落地前需先釐清影響範圍。Hami Pay 無公開開發者 API、電信繳費明細無公開 API，兩者維持誠實保留。已將調研結果寫進 4 個 adapter 介面（`cht.ts`）與 `ChainGateway`（`gateway.ts`）的檔頭註記；順帶修正 `poc-spec.md` 的 `BaasAdapter`/程式碼命名不一致問題。 |
| 2026-07-21 | P1（Model Card） | 新增 `docs/model-card.md`：現行合成 hard-mode 模型的完整治理文件（訓練資料含真 PaySim 棄用理由、LightGBM+IsolationForest 架構、指標、5 項限制、偏誤聲明、重訓/漂移監控建議、人工審核責任分工）。**新發現並主動揭露**：`account_age_days`(重要度全模型#2)、`vc_age_days`(#3) 等反詐特徵會懲罰無聯徵薄檔用戶，與普惠金融目標用戶重疊，此張力此前未被任何文件記錄；順帶修正 §2.3「缺口」清單裡兩則已過時的描述（LR>LGBM 誤解、model card 缺口）。 |
| 2026-07-21 | P1（ThreatIntelAdapter） | 情資命中接進 `/score`：新增 TS `ThreatIntelAdapter`/`MockThreatIntelAdapter`（`packages/issuer-verifier/src/adapters/cht.ts`），`scoreTransaction()` 依 `payee_account_id` 查詢後把 `threat_intel_hit` 併入請求；Python 端新增 `THREAT_INTEL_HIT` reason code（權重 35），規則模式自動加總、模型模式於 `model.py` 後處理加成，兩端測試全綠（ai-service 22、issuer-verifier 26）。設計文件見 `docs/superpowers/specs/2026-07-21-threat-intel-adapter-design.md`。 |
| 2026-07-02 | P0-6（準備） | Amoy 部署前置完成（commit `884abde`）：新增 `smoke:amoy` 煙霧腳本（deployer 自我背書解決 RevocationRegistry 撤銷授權前置、印 PolygonScan 事證連結）、server ethers 模式自動背書示範 issuer（記憶體金鑰重啟必換位址）、checklist 更新為 9 步、localhost 演練通過、全測試綠（合約 16／iv 21／e2e）。**尚待**：持有測試幣私鑰者執行實際部署（見 P0 清單內交接註記） |
| 2026-07-02 | P0-1 | 文件小修完成：README 測試數 12→16、poc-spec 環境版本更新、DEMO 改 PR-AUC 敘述；一併修正 `pnpm ai:setup` 撞 pnpm 內建指令的問題（root package.json 加 `run`） |
| 2026-07-02 | P0-5 | 真 PaySim 重訓完成：Kaggle CLI（KGAT token）下載 `ealaxi/paysim1`（178MB→6,362,620 筆、fraud 8,213=0.13%）。實測 PR-AUC 0.9978/ROC 0.9999（train.py 自動警告疑似洩漏）、LR 0.9980≈LGBM、CHT ablation -0.1%、已實名過水案例誤判 pass → 判定為 PaySim 模擬器 artifact（詐欺列餘額決定性歸零）。決策：demo 模型維持合成 hard-mode（20 pytest 全綠），真資料指標歸檔 `metrics.paysim-real.json`；另修 .gitignore `data/` 樣式改 `**/data/` 堵住大檔/資料入庫漏洞 |
| 2026-07-02 | P0-4 | 台灣防詐政策對齊：ai-fraud-spec.md 新增政策對照（打詐綱領阻詐定位、詐欺犯罪危害防制條例雙義務主體、警示帳戶 1 萬限額、機房/水房分工對應 reason codes）；demo_data.json 加 `watchlist_limit_evasion`（9,900×高頻規避），模型 97/block、規則 85/block 雙路徑驗證；pytest 19→20 綠 |
| 2026-07-02 | P0-3 | architecture.md §1 加「為什麼需要鏈？」：跨機構中立性（CHT BaaS 中立節點角色）、不可竄改稽核（鏈上事件重建歷史狀態）、可攜抗單點；並明文「鏈上最小化」原則 |
| 2026-07-02 | P0-2 | 普惠金融端到端完成：`BillingHistoryAdapter`（mock 電信繳費摘要）→ `issueReputationSdJwt`（tier 規則透明：3/2/1）→ SD-JWT 驗證邏輯泛化（KYC/信譽共用述詞注入）→ server `/sdjwt/issue-reputation` + `/sdjwt/verify?kind=reputation` → 錢包「繳費信譽憑證」卡 + 「微型貸款平台」出示情境。測試 16→21 綠、e2e 加步驟 [9][10]（含信譽不足負向案例）、wallet/iv build 綠 |

## 6. 誠實聲明（沿用並強化）

DEMO.md 的誠實聲明是本專案的信用資產，落地談判時同樣適用：
1. 半合成資料的界線講清楚（交易訊號真、電信訊號為相關性注入）。
2. 指標以 PR-AUC 為準，ROC-AUC≈1 視為洩漏警訊。
3. 所有 CHT 整合點目前為 mock——這不是弱點，而是「介面已就緒、等真 API 即插即換」的合作邀請。
