"""可解釋規則 baseline — 無模型時的退路，也用來產生 reason codes。

reason code 對齊 FATF/Europol money mule 與 AML 交易監控樣態（過水/結構化/快速資金移動/聚合戶/人頭環）。
"""
from __future__ import annotations

from typing import Any, Mapping

from .featurize import featurize

# reason code 對照
REASON_LABELS = {
    "MULE_PATTERN": "人頭金流樣態（大額轉出後帳戶清空）",
    "PASS_THROUGH": "過水帳戶（資金進來即清空轉出）",
    "STRUCTURING": "結構化拆分（金額壓在通報門檻下）",
    "RAPID_MOVEMENT": "快速資金移動（高頻＋大額清空）",
    "FAN_IN_COLLECTION": "聚合戶（多來源匯入單一帳戶）",
    "MULE_RING": "人頭環（帳戶圖譜高風險）",
    "NO_REALNAME": "未通過門號實名（CHT 電子卡）",
    "VELOCITY": "短時間高頻交易",
    "DEVICE_CHANGE": "裝置變更",
    "GEO_JUMP": "地理位置跳躍",
    "NEW_ACCOUNT": "新開帳戶",
    "HIGH_PAYEE_RISK": "收款方高風險",
    "CROSS_INST_REUSE": "跨機構頻繁出示",
    "THREAT_INTEL_HIT": "CHT Security 情資命中（通報詐欺/人頭帳戶）",
    "MODEL_ANOMALY": "模型偵測到異常樣態",
}

# 規則風險權重（也用於 top_factors 排序）
WEIGHTS = {
    "MULE_PATTERN": 45,
    "MULE_RING": 40,
    "FAN_IN_COLLECTION": 30,
    "THREAT_INTEL_HIT": 35,
    "PASS_THROUGH": 30,
    "MODEL_ANOMALY": 30,
    "RAPID_MOVEMENT": 25,
    "STRUCTURING": 25,
    "NO_REALNAME": 25,
    "VELOCITY": 20,
    "HIGH_PAYEE_RISK": 15,
    "DEVICE_CHANGE": 10,
    "GEO_JUMP": 10,
    "NEW_ACCOUNT": 10,
    "CROSS_INST_REUSE": 10,
}


def reason_codes(row: Mapping[str, Any]) -> list[str]:
    """依情境列出觸發的 reason code（不含分數）。"""
    codes: list[str] = []
    amount = float(row.get("amount", 0) or 0)
    old_org = float(row.get("oldbalanceOrg", 0) or 0)
    new_org = float(row.get("newbalanceOrig", 0) or 0)
    tx_type = str(row.get("type", "PAYMENT")).upper()
    tx_24h = float(row.get("tx_count_24h", 0) or 0)

    # 衍生樣態特徵（與訓練共用 featurize，確保一致）
    f = featurize(row)

    mule = (
        tx_type in ("TRANSFER", "CASH_OUT")
        and amount >= 50_000
        and old_org >= 50_000
        and new_org <= 0.01 * old_org
    )
    if mule:
        codes.append("MULE_PATTERN")
    # 過水：進來即清空（drain_ratio>=0.9 的對外移轉）
    if f["pass_through"] >= 1.0:
        codes.append("PASS_THROUGH")
    # 結構化拆分：金額貼近通報門檻下方
    if f["near_threshold"] >= 1.0:
        codes.append("STRUCTURING")
    # 快速資金移動（RMF）：短時爆量 + 帳戶幾乎清空
    if f["velocity_ratio"] >= 0.5 and f["drain_ratio"] >= 0.8 and tx_24h >= 10:
        codes.append("RAPID_MOVEMENT")
    # 圖譜：聚合戶 / 人頭環
    if float(row.get("payee_fan_in", 0) or 0) >= 5 or f["account_graph_risk"] >= 0.4:
        codes.append("FAN_IN_COLLECTION")
    if f["account_graph_risk"] >= 0.6:
        codes.append("MULE_RING")

    if not bool(row.get("mobile_realname_verified", True)):
        codes.append("NO_REALNAME")
    if float(row.get("tx_count_1h", 0) or 0) >= 5 or tx_24h >= 20:
        codes.append("VELOCITY")
    if bool(row.get("device_changed", False)):
        codes.append("DEVICE_CHANGE")
    if bool(row.get("geo_jump", False)):
        codes.append("GEO_JUMP")
    if float(row.get("account_age_days", 365) or 365) < 7:
        codes.append("NEW_ACCOUNT")
    if float(row.get("payee_risk", 0) or 0) >= 0.7:
        codes.append("HIGH_PAYEE_RISK")
    if float(row.get("cross_institution_presentations", 0) or 0) >= 8:
        codes.append("CROSS_INST_REUSE")
    if bool(row.get("threat_intel_hit", False)):
        codes.append("THREAT_INTEL_HIT")
    return codes


def rule_risk(row: Mapping[str, Any]) -> tuple[int, list[str]]:
    """規則風險分數（0-100）＋ reason codes。"""
    codes = reason_codes(row)
    score = sum(WEIGHTS.get(c, 0) for c in codes)
    risk = max(0, min(100, int(round(score))))
    return risk, codes
