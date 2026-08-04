# ChainTrust AI 反詐模組規格（M2.1）

> 供 `docs/m2-prompt.md` 與決賽簡報「技術成熟度／數據」使用。

## 目標

即時為交易／出示情境輸出風險分數，攔截人頭帳戶與身分盜用。

## API 契約（已定，勿改呼叫端）

`POST /score`：輸入 `ScoreRequest`（見 `packages/ai-service/app/schemas.py`），
輸出 `{ risk: 0-100, decision: pass|review|block, reasons: [...] }`。
門檻：`pass < 40`、`review 40–69`、`block >= 70`。

## 資料集

- **主：PaySim**（Kaggle `ealaxi/paysim1`）— 行動金流模擬，含 `TRANSFER → CASH_OUT` 詐欺鏈，最貼近人頭帳戶樣態。
- **輔：IEEE-CIS Fraud Detection**（Kaggle）— 交易詐欺標註，特徵豐富。
- 人頭標記：用 PaySim `isFraud` ＋「TRANSFER 後快速 CASH_OUT」鏈推導。

## 特徵（featurize 必須與訓練一致）

`amount`、`type` one-hot、`tx_count_1h/24h`（velocity）、餘額差（`oldbalanceOrg-newbalanceOrig`…）、
`device_changed`、`mobile_realname_verified`（來自 CHT mock，**強訊號**）、`vc_age_days`、
`cross_institution_presentations`、`payee_risk`、`geo_jump`、`account_age_days`。

## 模型

- **LightGBM** 二元分類（詐欺機率）— 主力；不平衡用 `scale_pos_weight`。
- **IsolationForest** 異常分數 — 補無標籤新樣態。
- 融合：`risk = clip(round(100 * (0.7 * p_fraud + 0.3 * anomaly_norm)), 0, 100)`。
- reason codes：規則 ＋ 前幾大特徵貢獻（SHAP 可選）映射，如 `MULE_PATTERN`、`VELOCITY`、`NO_REALNAME`、`DEVICE_CHANGE`、`GEO_JUMP`。

## `train.py` 流程

load → clean → featurize → 時間切 train/val/test → LightGBM fit（early stopping）→
eval（AUC、PR-AUC、人頭召回）→ IsolationForest fit（正常樣本）→ 存 `model.joblib`（含 feature_list ＋ scaler）。

## 服務（`model.py`）

載入 `model.joblib`；對進來的 ctx 用**同一個 featurize 函式**；無模型時退回現有規則 baseline（已實作，保證 Demo 可跑）。

## 驗收

- holdout **AUC > 0.90**、人頭召回可展示。
- `/score`：人頭樣本 → `block` ＋ reasons；正常 → `pass`。
- pytest：固定向量回歸測試。

## 台灣防詐政策對齊

本模組的樣態設計對齊台灣現行防詐制度，簡報與落地提案可直接引用：

- **打詐綱領（行政院「新世代打擊詐欺策略行動綱領」）**：識詐、堵詐、阻詐、懲詐四面向中，本系統落在「**阻詐**」（金流面即時攔截）與「堵詐」（門號實名信任根杜絕人頭門號開戶）。
- **詐欺犯罪危害防制條例（2024）**：課予金融機構與電信事業防詐義務——本案「銀行 Verifier + 電信信任根」的雙主體架構正對應條例的兩大義務主體。
- **警示帳戶新制**：警示／衍生管制帳戶每日轉帳、提領各以 NT$1 萬為限。詐團以「多筆 9,900」規避 → `STRUCTURING_THRESHOLDS` 已含 10,000 門檻，`near_threshold` 特徵 + `STRUCTURING` reason code 直接命中此樣態（見 `demo_data.json: watchlist_limit_evasion`）。
- **165 打詐儀錶板**：財損統計可佐證題目重要性；落地時可用其公開統計校準情境權重。
- **機房／水房分工**：`FAN_IN_COLLECTION`（聚合戶）與 `MULE_RING`（圖譜人頭環）對應水房提領層；`PASS_THROUGH` 對應過水帳戶層。

## 跨機構情資（差異化，PoC mock → 落地）

`ThreatIntelAdapter`：PoC mock 比對小型內建黑名單，已接進 `/score`（命中 +35 分，見 `packages/ai-service/app/rules.py` 的 `THREAT_INTEL_HIT`）；落地接中華電信 CHT Security 情資。
未來以**聯邦學習／隱私計算**跨行共享風險訊號而不交換明文（簡報的護城河論點）。

## 決賽簡報要展示

AUC／PR 曲線、混淆矩陣、一筆人頭交易被**即時攔截**（risk ＋ reasons）、與規則 baseline 對比。

## Demo 資料

備 6–8 筆腳本化交易（正常 × 人頭），存 `packages/ai-service/demo_data.json` 供 live demo。
