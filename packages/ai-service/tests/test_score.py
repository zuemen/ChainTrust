"""固定向量回歸測試：人頭→block、正常→pass；門檻與規則 baseline 確定性。"""
from __future__ import annotations

import json
import os

from fastapi.testclient import TestClient

from app.main import app
from app.model import decide
from app.rules import rule_risk

client = TestClient(app)

HERE = os.path.dirname(__file__)
DEMO = os.path.join(os.path.dirname(HERE), "demo_data.json")


def _samples():
    with open(DEMO, encoding="utf-8") as f:
        return json.load(f)["samples"]


def test_root_info():
    """GET / 回服務資訊與端點清單（雲端探測/直開不再 404）。"""
    r = client.get("/")
    assert r.status_code == 200
    body = r.json()
    assert body["service"]
    assert "POST /score" in body["endpoints"]
    assert "GET /metrics" in body["endpoints"]


def test_favicon_no_content():
    r = client.get("/favicon.ico")
    assert r.status_code == 204


def test_docs_available():
    assert client.get("/docs").status_code == 200


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_metrics_endpoint():
    """/metrics 回評估報告（模型已訓練時含 PR-AUC / 校準 / 基線 / CHT 增益）。"""
    r = client.get("/metrics")
    assert r.status_code == 200
    body = r.json()
    assert "available" in body
    if body["available"]:
        m = body["metrics"]
        assert "holdout_pr_auc" in m
        assert "cht_signal_ablation" in m and "lift_pct" in m["cht_signal_ablation"]
        assert "calibration_quality" in m and "ece" in m["calibration_quality"]


def test_decision_thresholds():
    assert decide(0) == "pass"
    assert decide(39) == "pass"
    assert decide(40) == "review"
    assert decide(69) == "review"
    assert decide(70) == "block"
    assert decide(100) == "block"


def test_demo_samples_pass_and_block():
    """正常→pass、人頭→block（不論用 model 或 rules 都應成立）。"""
    for s in _samples():
        r = client.post("/score", json=s["ctx"])
        assert r.status_code == 200
        body = r.json()
        if s["expect"] in ("pass", "block"):
            assert body["decision"] == s["expect"], f"{s['label']}: {body}"


def test_mule_reasons():
    mule = next(s for s in _samples() if s["label"] == "mule_transfer_drain")
    body = client.post("/score", json=mule["ctx"]).json()
    assert body["decision"] == "block"
    assert "MULE_PATTERN" in body["reasons"]
    assert "NO_REALNAME" in body["reasons"]


def test_rules_baseline_deterministic():
    """規則 baseline（無模型退路）固定向量：人頭高分、正常 0 分。"""
    mule = next(s for s in _samples() if s["label"] == "mule_transfer_drain")["ctx"]
    normal = next(s for s in _samples() if s["label"] == "normal_payment")["ctx"]
    risk_m, codes_m = rule_risk(mule)
    risk_n, codes_n = rule_risk(normal)
    assert risk_m >= 70 and "MULE_PATTERN" in codes_m
    assert risk_n < 40 and codes_n == []


def test_top_factors_present_and_shaped():
    """可解釋輸出：人頭交易應回傳非空 top_factors，且每筆有 feature/label/impact。"""
    mule = next(s for s in _samples() if s["label"] == "mule_transfer_drain")
    body = client.post("/score", json=mule["ctx"]).json()
    tf = body.get("top_factors")
    assert isinstance(tf, list) and len(tf) >= 1
    first = tf[0]
    assert set(first.keys()) >= {"feature", "label", "impact"}
    assert isinstance(first["label"], str) and first["label"]


# ── A1：AML/反詐樣態特徵 ──
def test_pattern_features():
    from app.featurize import featurize
    # 過水：大額 TRANSFER 清空 → pass_through=1、drain_ratio≈1
    f = featurize({"type": "TRANSFER", "amount": 300000, "oldbalanceOrg": 310000, "newbalanceOrig": 0})
    assert f["pass_through"] == 1.0
    assert f["drain_ratio"] >= 0.9
    # 結構化：49000 落在 50000 下方 5% 帶
    assert featurize({"type": "TRANSFER", "amount": 49000})["near_threshold"] == 1.0
    assert featurize({"type": "TRANSFER", "amount": 12000})["near_threshold"] == 0.0
    # 整數金額 / velocity_ratio
    assert featurize({"amount": 5000})["round_amount"] == 1.0
    assert featurize({"amount": 5123})["round_amount"] == 0.0
    assert featurize({"tx_count_1h": 6, "tx_count_24h": 12})["velocity_ratio"] == 0.5


# ── A3：對齊 AML 樣態的 reason codes ──
def test_pattern_reason_codes():
    from app.rules import reason_codes
    pt = next(s for s in _samples() if s["label"] == "pass_through_mule")["ctx"]
    codes = reason_codes(pt)
    assert "PASS_THROUGH" in codes
    assert "FAN_IN_COLLECTION" in codes and "MULE_RING" in codes  # account_graph_risk=0.7
    st = next(s for s in _samples() if s["label"] == "structuring_smurf")["ctx"]
    assert "STRUCTURING" in reason_codes(st)


# ── 台灣脈絡：警示帳戶每日限額（≤1 萬）規避 ──
def test_taiwan_watchlist_limit_evasion():
    """新制警示帳戶每日轉帳/提領 ≤ NT$1 萬；貼門檻下方的多筆小額（9,900）應觸發 STRUCTURING。"""
    from app.featurize import featurize
    from app.rules import rule_risk

    ctx = next(s for s in _samples() if s["label"] == "watchlist_limit_evasion")["ctx"]
    # 9,900 落在 10,000 門檻下方 5% 帶
    assert featurize(ctx)["near_threshold"] == 1.0
    # 規則 baseline 確定性：block 等級且含結構化/高頻
    risk, codes = rule_risk(ctx)
    assert risk >= 70
    assert "STRUCTURING" in codes and "VELOCITY" in codes
    # /score（模型或規則）皆應攔截
    body = client.post("/score", json=ctx).json()
    assert body["decision"] == "block"
    assert "STRUCTURING" in body["reasons"]


# ── A2：圖譜人頭環偵測 ──
def test_account_graph():
    import pandas as pd
    from app.graph import compute_account_graph, add_graph_features

    # 6 來源匯入水房 COLL 後 COLL 提領 → 聚合戶
    rows = [{"type": "TRANSFER", "nameOrig": f"C{i}", "nameDest": "COLL"} for i in range(6)]
    rows.append({"type": "CASH_OUT", "nameOrig": "COLL", "nameDest": "M1"})
    df = pd.DataFrame(rows)
    g = compute_account_graph(df)
    assert g.fan_in["COLL"] == 6
    assert g.is_collection["COLL"] == 1
    assert g.risk_of("COLL") >= 0.6

    out = add_graph_features(df)
    assert "payee_fan_in" in out.columns and "account_graph_risk" in out.columns
    # 匯入 COLL 的那幾筆，payee_fan_in 應為 6
    assert out[out["nameDest"] == "COLL"]["payee_fan_in"].max() == 6


def test_graph_features_absent_when_no_accounts():
    import pandas as pd
    from app.graph import add_graph_features
    out = add_graph_features(pd.DataFrame([{"type": "PAYMENT", "amount": 100}]))
    assert out["payee_fan_in"].iloc[0] == 0.0
    assert out["account_graph_risk"].iloc[0] == 0.0


# ── 信心值（confidence）──
def test_prob_confidence_monotonic():
    from app.model import prob_confidence
    assert prob_confidence(0.5) <= 0.01          # 最不確定
    assert prob_confidence(0.99) > prob_confidence(0.7) > prob_confidence(0.55)
    assert prob_confidence(0.01) > prob_confidence(0.3)   # 對「正常」也可以很有信心
    assert 0.0 <= prob_confidence(0.5) <= 1.0


def test_confidence_band_thresholds():
    from app.model import confidence_band
    assert confidence_band(0.9) == "high"
    assert confidence_band(0.5) == "medium"
    assert confidence_band(0.1) == "low"


def test_score_returns_confidence():
    """/score 每筆都附 confidence(0-1) 與 confidence_band，供前端/agent 呈現信心。"""
    mule = next(s for s in _samples() if s["label"] == "mule_transfer_drain")
    body = client.post("/score", json=mule["ctx"]).json()
    assert 0.0 <= body["confidence"] <= 1.0
    assert body["confidence_band"] in ("high", "medium", "low")


# ── 評估工具：ECE（期望校準誤差）──
def test_expected_calibration_error():
    import sys, os
    sys.path.insert(0, os.path.dirname(HERE))
    from train import expected_calibration_error
    # 完美校準：預測機率＝實際頻率 → ECE≈0
    y = [0, 0, 1, 1]
    p = [0.0, 0.0, 1.0, 1.0]
    ece, curve = expected_calibration_error(y, p, bins=10)
    assert ece < 1e-6 and isinstance(curve, list)
    # 反向預測 → ECE 應很大
    ece_bad, _ = expected_calibration_error([0, 1], [1.0, 0.0], bins=10)
    assert ece_bad > 0.9


def test_graph_apply_train_only_no_future_edges():
    """以訓練期圖譜套用到測試列：fan_in 來自訓練邊，不因測試列新增而改變（防時間洩漏）。"""
    import pandas as pd
    from app.graph import compute_account_graph, apply_graph_features

    train = pd.DataFrame([{"type": "TRANSFER", "nameOrig": f"C{i}", "nameDest": "COLL"} for i in range(6)])
    graph = compute_account_graph(train)
    # 測試列也匯入 COLL，但不應讓 fan_in 變大（圖譜只由 train 建）
    test = pd.DataFrame([{"type": "TRANSFER", "nameOrig": "Cx", "nameDest": "COLL"}])
    out = apply_graph_features(test, graph)
    assert out["payee_fan_in"].iloc[0] == 6  # 僅來自訓練期的 6 個來源
    # 測試列的新對手 Cx 不在訓練圖 → 該帳戶風險為 0
    assert out["account_graph_risk"].iloc[0] == 0.0


# ── P1：ThreatIntelAdapter 情資命中規則 ──
def test_threat_intel_hit_rule_and_weight():
    """情資命中：reason_codes 應含 THREAT_INTEL_HIT，rule_risk 應加總其權重（規則 baseline 自動生效）。"""
    from app.rules import reason_codes, rule_risk, WEIGHTS

    assert reason_codes({"threat_intel_hit": False}) == []
    assert "THREAT_INTEL_HIT" in reason_codes({"threat_intel_hit": True})

    risk, codes = rule_risk({"threat_intel_hit": True})
    assert risk == WEIGHTS["THREAT_INTEL_HIT"] == 35
    assert codes == ["THREAT_INTEL_HIT"]


def test_threat_intel_hit_boosts_risk_and_reason():
    """情資命中：模型模式下應把 pass 等級交易升級為 review，且加分獨立於模型判斷之外（可與 rules.WEIGHTS 對上）。"""
    from app.rules import WEIGHTS

    hit_ctx = next(s for s in _samples() if s["label"] == "threat_intel_hit_known_mule")["ctx"]
    base_ctx = {k: v for k, v in hit_ctx.items() if k != "threat_intel_hit"}

    base = client.post("/score", json=base_ctx).json()
    hit = client.post("/score", json=hit_ctx).json()

    assert base["decision"] == "pass"
    assert "THREAT_INTEL_HIT" not in base["reasons"]

    assert hit["decision"] == "review"
    assert "THREAT_INTEL_HIT" in hit["reasons"]
    assert hit["risk"] == base["risk"] + WEIGHTS["THREAT_INTEL_HIT"]
    assert hit["top_factors"][0]["feature"] == "THREAT_INTEL_HIT"
