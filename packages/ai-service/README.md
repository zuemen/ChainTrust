# @chaintrust/ai-service — AI 反詐 /score

FastAPI 服務，依 `docs/ai-fraud-spec.md`。LightGBM + IsolationForest 融合風險分數，
無模型時自動退回可解釋規則 baseline（保證 Demo 可跑）。

## 版本

`requirements.txt` **全部釘死精確版本**、Python 3.13（與 Dockerfile、CI 相同）。用範圍版本時，
套件一升級本機／CI／Docker 就會訓練出不同模型、指標與 demo 判定跟著漂移。要升級請改
`requirements.txt` → `python train.py` → pytest 綠 → 連同新的 `metrics.json` 一起 commit。

## 快速開始

```bash
cd packages/ai-service
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # Windows
# source .venv/bin/activate && pip install -r requirements.txt  # macOS/Linux

python train.py          # 訓練並印 holdout AUC，產 model.joblib
python -m pytest -q      # 測試
python -m uvicorn app.main:app --reload --port 8000
```

## /score

```bash
curl -X POST http://localhost:8000/score -H "Content-Type: application/json" \
  -d '{"type":"TRANSFER","amount":920000,"oldbalanceOrg":1000000,"newbalanceOrig":0,
       "mobile_realname_verified":false,"tx_count_1h":8,"account_age_days":2,"payee_risk":0.92}'
# => {"risk":..,"decision":"block","reasons":["MULE_PATTERN","NO_REALNAME",...],"source":"model"}
```

決策門檻：`pass < 40`、`review 40–69`、`block >= 70`。

規則保底：`risk = max(模型分數, rule_floor)`——人頭金流／人頭環／反覆拆分至少 block，
過水／快速資金移動／聚合戶至少 review；身分類訊號不納入。回應的 `rule_floor_applied` 標示是否生效。

## 資料

預設用合成 PaySim-like 資料（`synth.py`）。要用真 PaySim：把 Kaggle `ealaxi/paysim1`
的 CSV 放到 `data/paysim.csv`，`train.py` 會優先採用並自動補增益欄。
`model.joblib` 與 `data/` 不入庫（見 `.gitignore`），由 `train.py` 重建。

## demo_data.json

腳本化交易（正常 × 人頭）供 live demo 與回歸測試。
