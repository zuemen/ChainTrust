"""特徵工程 — 訓練與服務必須共用同一套，確保一致。"""
from __future__ import annotations

import math
from typing import Any, Mapping

TX_TYPES = ["CASH_IN", "CASH_OUT", "DEBIT", "PAYMENT", "TRANSFER"]

# 結構化/拆分常見通報門檻（新制人頭帳戶每日 ≤ 1 萬；AML 申報門檻 50 萬等）
STRUCTURING_THRESHOLDS = [10_000, 30_000, 50_000, 500_000]

# 固定特徵順序（model.joblib 會一併存 feature_list 以防漂移）
# 註：AML/反詐樣態特徵（A1）與圖譜特徵（A2）附加在尾端，利於與舊模型相容。
FEATURE_ORDER: list[str] = [
    "amount",
    "oldbalanceOrg",
    "newbalanceOrig",
    "oldbalanceDest",
    "newbalanceDest",
    "errorBalanceOrig",
    "errorBalanceDest",
    "tx_count_1h",
    "tx_count_24h",
    "vc_age_days",
    "account_age_days",
    "cross_institution_presentations",
    "payee_risk",
    "device_changed",
    "mobile_realname_verified",
    "geo_jump",
    *[f"type_{t}" for t in TX_TYPES],
    # ── A1：AML/反詐樣態特徵 ──
    "amount_log",
    "drain_ratio",
    "pass_through",
    "near_threshold",
    "round_amount",
    "velocity_ratio",
    # ── A2：圖譜人頭環特徵（由 graph.py 提供，缺則 0）──
    "payee_fan_in",
    "account_graph_risk",
]


def _num(v: Any, default: float = 0.0) -> float:
    try:
        if isinstance(v, bool):
            return 1.0 if v else 0.0
        if v is None:
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def featurize(row: Mapping[str, Any]) -> dict[str, float]:
    """把一筆 ctx（dict 或 pandas row）轉成特徵字典。容忍缺欄位（給預設）。"""
    amount = _num(row.get("amount"))
    old_org = _num(row.get("oldbalanceOrg"))
    new_org = _num(row.get("newbalanceOrig"))
    old_dest = _num(row.get("oldbalanceDest"))
    new_dest = _num(row.get("newbalanceDest"))

    # PaySim 經典強特徵：帳務不一致
    error_org = old_org - amount - new_org
    error_dest = old_dest + amount - new_dest

    tx_type = str(row.get("type", "PAYMENT")).upper()
    tx_1h = _num(row.get("tx_count_1h"))
    tx_24h = _num(row.get("tx_count_24h"))

    # ── A1：AML/反詐樣態特徵 ──
    drain_ratio = (old_org - new_org) / max(old_org, 1.0)
    pass_through = 1.0 if (tx_type in ("TRANSFER", "CASH_OUT") and drain_ratio >= 0.9) else 0.0
    # 結構化拆分：金額落在通報門檻下方 5% 帶
    near_threshold = 0.0
    for thr in STRUCTURING_THRESHOLDS:
        if thr * 0.95 <= amount < thr:
            near_threshold = 1.0
            break
    round_amount = 1.0 if (amount > 0 and amount % 1000 == 0) else 0.0
    velocity_ratio = tx_1h / max(tx_24h, 1.0)

    feats: dict[str, float] = {
        "amount": amount,
        "oldbalanceOrg": old_org,
        "newbalanceOrig": new_org,
        "oldbalanceDest": old_dest,
        "newbalanceDest": new_dest,
        "errorBalanceOrig": error_org,
        "errorBalanceDest": error_dest,
        "tx_count_1h": tx_1h,
        "tx_count_24h": tx_24h,
        "vc_age_days": _num(row.get("vc_age_days"), 365.0),
        "account_age_days": _num(row.get("account_age_days"), 365.0),
        "cross_institution_presentations": _num(row.get("cross_institution_presentations")),
        "payee_risk": _num(row.get("payee_risk")),
        "device_changed": _num(row.get("device_changed")),
        "mobile_realname_verified": _num(row.get("mobile_realname_verified"), 1.0),
        "geo_jump": _num(row.get("geo_jump")),
        # A1
        # H15 雙保險：log1p(x<0) 會丟 ValueError（x<-1）或回 NaN。schema 已擋負數，
        # 但 featurize 也被 train.py / rules.py 直接呼叫（繞過 pydantic），故在此 clamp。
        "amount_log": math.log1p(max(0.0, amount)),
        "drain_ratio": drain_ratio,
        "pass_through": pass_through,
        "near_threshold": near_threshold,
        "round_amount": round_amount,
        "velocity_ratio": velocity_ratio,
        # A2（圖譜：由 graph.py 注入；/score 時可由呼叫端帶入，缺則 0）
        "payee_fan_in": _num(row.get("payee_fan_in")),
        "account_graph_risk": _num(row.get("account_graph_risk")),
    }
    for t in TX_TYPES:
        feats[f"type_{t}"] = 1.0 if tx_type == t else 0.0
    return feats


def vectorize(row: Mapping[str, Any], feature_order: list[str] | None = None) -> list[float]:
    order = feature_order or FEATURE_ORDER
    feats = featurize(row)
    return [float(feats.get(name, 0.0)) for name in order]


# 特徵 → 中文標籤（供 /score 可解釋輸出）
FEATURE_LABELS: dict[str, str] = {
    "amount": "交易金額",
    "oldbalanceOrg": "轉出前餘額",
    "newbalanceOrig": "轉出後餘額",
    "oldbalanceDest": "收款前餘額",
    "newbalanceDest": "收款後餘額",
    "errorBalanceOrig": "轉出帳務不一致",
    "errorBalanceDest": "收款帳務不一致",
    "tx_count_1h": "1 小時交易頻率",
    "tx_count_24h": "24 小時交易頻率",
    "vc_age_days": "憑證年齡",
    "account_age_days": "帳戶年齡",
    "cross_institution_presentations": "跨機構出示次數",
    "payee_risk": "收款方風險",
    "device_changed": "裝置變更",
    "mobile_realname_verified": "門號實名（中華電信）",
    "geo_jump": "地理位置跳躍",
    "type_CASH_IN": "交易類型：存入",
    "type_CASH_OUT": "交易類型：提領",
    "type_DEBIT": "交易類型：扣款",
    "type_PAYMENT": "交易類型：支付",
    "type_TRANSFER": "交易類型：轉帳",
    # A1：AML/反詐樣態
    "amount_log": "金額（對數）",
    "drain_ratio": "帳戶清空比例",
    "pass_through": "過水（進來即清空）",
    "near_threshold": "金額貼近通報門檻（疑似拆分）",
    "round_amount": "整數金額",
    "velocity_ratio": "短時交易爆量比",
    # A2：圖譜
    "payee_fan_in": "收款方匯入來源數（fan-in）",
    "account_graph_risk": "帳戶圖譜風險（人頭環/聚合戶）",
}


def feature_label(name: str) -> str:
    return FEATURE_LABELS.get(name, name)
