# ChainTrust 反詐模型 Model Card（模型治理）

> P1 待辦（`docs/completeness-roadmap.md` §4）：「Model card + 模型治理：訓練資料/限制/偏誤/重訓節奏/漂移監控」。供落地簡報、模型上線審查、與 `packages/ai-service` 開發者參考。所有數字取自現行已 commit 的 `model.joblib` 對應的 `metrics.json`（而非 `metrics.paysim-real.json`，見「訓練資料」一節說明兩者差異）。

## 1. 模型概述

- **用途**：`POST /score`（`packages/ai-service`）即時為交易/出示情境輸出風險分數，攔截人頭帳戶與身分盜用，供 issuer-verifier 的 `scoreTransaction()` 呼叫。
- **輸出**：`risk`（0-100）、`decision`（`pass`/`review`/`block`）、`reasons`（可解釋 reason codes）、`top_factors`。
- **決策門檻**（`app/model.py`）：`risk < 40 → pass`、`40 ≤ risk < 70 → review`、`risk ≥ 70 → block`。
- **現行版本**：committed 的 `packages/ai-service/model.joblib`，`source: "synthetic (PaySim-like)"`，即下文「合成 hard-mode」模型——**不是**用真實 PaySim 資料訓練的版本（那個版本已實測並主動棄用，見 §2）。
- **模式**：無模型檔時，`/score` 自動退回可解釋規則 baseline（`app/rules.py`），demo 仍可運作。

## 2. 訓練資料

### 2.1 合成資料（現行版本使用）

`packages/ai-service/synth.py::generate(n=40_000, fraud_ratio=0.08, seed=42)`，PaySim 風格欄位（`type/amount/oldbalanceOrg/newbalanceOrig/...`）加上 ChainTrust/CHT 增益訊號（`tx_count_1h/24h`、`device_changed`、`mobile_realname_verified`、`vc_age_days`、`account_age_days`、`cross_institution_presentations`、`payee_risk`、`geo_jump`）。實際切分後 40,000 筆、詐欺 3,712 筆（9.45%）。

混合三種詐欺原型（比例 35/40/25%）：

1. **身分型**：交易本身正常，只有 CHT 身分訊號（未實名＋裝置變更＋地理跳躍＋新帳戶）能抓到。
2. **交互型**：只有「大額 × 未實名 × 新帳戶」同時出現才是詐欺，單一條件都合法——刻意需要 GBM 的非線性能力才抓得到，不是規則能單獨判斷。
3. **金流/人頭環型**：透過 12 個合成 `MULE_COLL_*` 收款帳戶做資金匯聚（fan-in）與提領。

另外注入約 1.5% 隨機標籤翻轉，刻意避免完美可分——`synth.py` docstring 明言 holdout PR-AUC 設計上落在 0.85–0.92 區間，不是 1.0。

### 2.2 真 PaySim 資料（已實測、主動棄用）

2026-07-02 曾用 Kaggle `ealaxi/paysim1`（635 萬筆、詐欺 8,213 筆＝0.13%）實跑，結果存 `metrics.paysim-real.json`：PR-AUC 0.9978、ROC-AUC 0.9999。**判定不可用**：

> 「PaySim 模擬器的餘額欄位近乎決定性標記詐欺（詐欺列固定『轉出即歸零』），導致指標飽和（PR-AUC 0.998、ROC≈1.0、邏輯迴歸同分）且 CHT 訊號增益無從展現；該模型還把『已實名的過水帳戶』誤放行（背了模擬器 artifact、泛化更差）。因此 demo 模型維持合成 hard-mode 資料訓練——刻意去掉決定性金流訊號，才能誠實展示『金流訊號不足時，身分訊號的邊際價值（+16.45% PR-AUC）』。」
> —— `docs/DEMO.md`「資料與模型誠實聲明」

即真實 PaySim 上，金流餘額訊號強到讓任何模型（含邏輯迴歸）都能「作弊式」地逼近滿分，反而讓 ChainTrust 想展示的「身分訊號邊際價值」這個核心論點無法驗證，也讓模型在真實場景會誤判過水帳戶為安全（過度依賴模擬器 artifact，泛化差）。這是主動的資料選擇決策，不是「還沒跑真資料」的權宜之計。

## 3. 模型架構（`packages/ai-service/train.py`）

- **分類器**：`LightGBM`（`n_estimators=400, learning_rate=0.05, num_leaves=31, subsample=0.9, colsample_bytree=0.9, scale_pos_weight=neg/pos`），early stopping 50 輪（驗證集 AUC）。
- **校準**：`CalibratedClassifierCV(..., method="isotonic")`，在驗證集上 fit，讓 `p_fraud` 是有意義的機率而非單純排序分數。
- **異常分數**：`IsolationForest(n_estimators=200)`，只用正常樣本訓練，`contamination` 依實際詐欺率夾在 `[0.01, 0.2]`。
- **最終風險分數**：`risk = round(100 × (0.7 × p_fraud + 0.3 × anomaly_norm))`（`app/model.py`）。
- **切分方法**：依 `step`（時間序）做 out-of-time 切分（70/15/15 train/val/test），不 shuffle，避免時間洩漏。
- **防洩漏措施**：帳戶圖譜特徵（`payee_fan_in`/`account_graph_risk`）只用**訓練期**的邊建圖，套用到 val/test 時不納入未來邊；`train.py` 對 ROC-AUC ≥ 0.999 會自動印警告（「極可能資料洩漏或過擬」）。
- **特徵**（29 個，`app/featurize.py::FEATURE_ORDER`）：原始金流欄位（`amount`/餘額四項/`errorBalance*`）、交易類型 one-hot、速度（`tx_count_1h/24h`）、CHT 增益訊號（`device_changed`/`mobile_realname_verified`/`vc_age_days`/`account_age_days`/`cross_institution_presentations`/`payee_risk`/`geo_jump`）、工程特徵（`amount_log`/`drain_ratio`/`pass_through`/`near_threshold`/`round_amount`/`velocity_ratio`）、圖譜特徵（`payee_fan_in`/`account_graph_risk`）。
- **可解釋輸出**：`top_factors` 優先用 LightGBM SHAP 貢獻（`pred_contrib`），無法取得時退回規則權重排序（見 `app/rules.py::WEIGHTS`）。

## 4. 指標（現行合成 hard-mode 模型，`metrics.json`）

| 指標 | 數值 |
| :-- | :-- |
| Holdout PR-AUC（主指標，極度不平衡不看 accuracy） | 0.8611 |
| Holdout ROC-AUC | 0.9271 |
| ECE（期望校準誤差） | 0.001 |
| Brier score | 0.016 |
| Recall @ FPR 1% | 0.8501 |
| MCC | 0.9023 |
| 決策門檻（best-F1 grid search） | 0.05 |
| 混淆矩陣（門檻下） | TP 482 / FP 12 / FN 85 / TN 5421 |

**CHT 增益訊號消融**（拿掉 `tx_count_*`/`device_changed`/`mobile_realname_verified`/`vc_age_days`/`account_age_days`/`cross_institution_presentations`/`payee_risk`/`geo_jump` 這 9 個訊號重訓）：PR-AUC 0.7394 → 0.8611，**+16.45%**。這是「一次 KYC、身分可攜」論點的量化證據。

**已知異常，需要在簡報上主動說明**：baseline 邏輯迴歸（PR-AUC 0.8732）在合成資料上贏過 LightGBM（0.8611）與規則 baseline（0.8362）。這**不是**「合成資料太假」的證據——真 PaySim 資料上 LR 與 LightGBM 幾乎同分（見 §2.2），說明這是 PaySim 資料家族本身金流訊號強度普遍偏線性可分，跟合成與否無關。維持 LightGBM 上線是為了模型架構要能捕捉「交互型」詐欺原型（單一特徵不觸發、組合才觸發），這類樣態邏輯迴歸原理上就抓不到，即使當前資料集上分數略低。

## 5. 已知限制

1. **合成資料非真實分佈**：詐欺原型、金額分佈、帳戶行為皆為人工設計，即使刻意加入 1.5% 標籤噪音避免完美可分，仍無法代表台灣真實金融交易的統計特性。
2. **未經真實交易驗證**：模型從未在真實生產流量上跑過（PoC 階段無正式部署）。
3. **PaySim 系真實資料不可用的結論範圍有限**：只驗證了「PaySim 模擬器」這個特定資料源不適合本專案的論點展示需求；不能推論成「所有真實金流資料都無法展現 CHT 訊號價值」——換一個真實資料源（如有機會取得 CHT/銀行的匿名化交易樣本）結論可能不同。
4. **`payee_risk`/`account_graph_risk` 目前無真實資料源**：demo 情境靠手動指定或合成圖譜計算，落地需要真實的收款方風險評分/圖譜服務銜接。
5. **決策門檻（40/70）未經真實成本效益校準**：目前是 best-F1 grid search 在合成驗證集上的結果，落地需要用真實誤判成本（false block 的客訴/流失成本 vs false pass 的詐欺損失）重新校準。

## 6. 偏誤聲明

**反詐特徵與普惠金融目標用戶重疊，存在未解決的張力。** 本專案另一條產品線（`docs/completeness-roadmap.md` §2.4「普惠金融」、`FinancialReputationCredential`）鎖定的目標用戶，正是「無聯徵信用紀錄的薄檔（thin-file）族群」——學生、新住民、自由工作者。

問題在於：反詐模型目前排名前列的風險特徵中，`account_age_days`（重要度 278，全模型第 2 高）、`vc_age_days`（重要度 271，第 3 高）直接對應「新帳戶」與「證件核發時間短」；規則層的 `NEW_ACCOUNT`（`account_age_days < 7`）、`NO_REALNAME`（`mobile_realname_verified = false`）reason code 也是同樣邏輯。**這些正是薄檔族群天生就會踩到的訊號**——一個剛申辦門號、剛開戶的新住民，即使完全合法，也會因為「新」而被反詐模型加分。

這在現行系統裡不是致命缺陷（`NEW_ACCOUNT`/`NO_REALNAME` 各只加 10-25 分，遠低於 `MULE_PATTERN`45/`MULE_RING`40 這類實際金流樣態訊號，且決策是加權而非單一規則 override），但目前**沒有任何文件承認或量化過這個張力**，也沒有做過「薄檔合法用戶的誤判率是否顯著高於一般用戶」的分群測試。落地前應該：

- 用（若拿得到）真實資料做分群校準測試：比較新帳戶/未實名族群與一般族群的 false positive rate 是否有顯著差距。
- 若確認存在不成比例的誤判，考慮讓 `FinancialReputationCredential`（電信繳費信譽憑證）反向抵銷這類特徵的風險分數——用「薄檔但有信譽」取代「薄檔即風險」。

## 7. 治理：重訓節奏與漂移監控（PoC 階段建議，尚未實作）

現況：**完全沒有重訓排程或漂移偵測機制**——訓練是一次性手動執行 `pnpm ai:train`。以下是 PoC 走向落地時的建議起點，不是已上線的系統：

- **重訓觸發**：兩個條件任一成立即重訓——(a) 定期，建議每季一次；(b) 事件驅動，偵測到下方漂移指標超過門檻時提前觸發。
- **漂移監控（建議用 PSI，Population Stability Index）**：對 `FEATURE_ORDER` 中排名前幾的特徵（`drain_ratio`/`account_age_days`/`vc_age_days`/`payee_risk`）定期比較近期線上流量分布 vs 訓練集分布，`PSI > 0.2` 視為顯著漂移、觸發重訓與人工複查。
- **標籤延遲問題**：詐欺判定通常有延遲（人工申訴、警示帳戶通報），重訓資料需保留至少一段觀察窗（例如 30-60 天）才能標記為確定的 fraud/legit，避免用未成熟標籤重訓。
- **模型版本紀錄**：目前 `model.joblib` 沒有版本號或訓練資料指紋，落地應在 `metrics.json` 加入 `trained_at`/`data_hash`/`git_commit` 欄位，便於稽核追溯。

## 8. 人工審核與責任分工

- **`block`**：現行設計為自動攔截（`decision: "block"`），交易不放行。落地應明訂：誰負責複核誤判申訴？申訴 SLA 多久？
- **`review`**：目前是「需要人工複核」的中間態，但 PoC 階段**沒有實際的人工複核佇列/工作流**——這是純技術輸出，落地前需要指定複核團隊與流程。
- **模型判斷 vs 規則判斷的責任邊界**：`source: "model"` 時的決策依據是 LightGBM/IsolationForest 的統計判斷（不透明，靠 SHAP `top_factors` 盡量解釋）；`source: "rules"` 時（無模型時的退路）是完全可讀的規則加總。金融場景審查若要求「決策可解釋」，`rules` 模式的可稽核性明顯優於 `model` 模式，這點應在上線審查時主動提出。
