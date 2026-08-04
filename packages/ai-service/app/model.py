"""模型載入與評分；無模型時自動退回規則 baseline。

評分輸出含 top_factors（可解釋）：模型模式用 LightGBM 的 SHAP 貢獻（pred_contrib，
不需額外相依），規則模式用觸發規則的權重排序。
"""
from __future__ import annotations

import math
import os
from typing import Any, Mapping

from .featurize import FEATURE_ORDER, vectorize, feature_label
from .rules import rule_risk, reason_codes, WEIGHTS, REASON_LABELS
from .schemas import ScoreResponse, TopFactor

# 決策門檻（與 docs/ai-fraud-spec.md 一致）
PASS_MAX = 40   # risk < 40 → pass
BLOCK_MIN = 70  # risk >= 70 → block；中間為 review

MODEL_PATH = os.environ.get(
    "MODEL_PATH",
    os.path.join(os.path.dirname(os.path.dirname(__file__)), "model.joblib"),
)

_bundle: dict[str, Any] | None = None
_load_attempted = False


def _load() -> dict[str, Any] | None:
    global _bundle, _load_attempted
    if _load_attempted:
        return _bundle
    _load_attempted = True
    try:
        import joblib  # 延遲匯入，無 ML 相依也能用規則
        if os.path.exists(MODEL_PATH):
            _bundle = joblib.load(MODEL_PATH)
    except Exception:
        _bundle = None
    return _bundle


def model_loaded() -> bool:
    return _load() is not None


def decide(risk: int) -> str:
    if risk >= BLOCK_MIN:
        return "block"
    if risk >= PASS_MAX:
        return "review"
    return "pass"


def prob_confidence(p_fraud: float) -> float:
    """模型確定度 ∈[0,1]：用二分類熵的補數。p 越接近 0 或 1 越確定，0.5 最不確定。"""
    p = min(1.0 - 1e-9, max(1e-9, float(p_fraud)))
    entropy = -(p * math.log2(p) + (1.0 - p) * math.log2(1.0 - p))  # 0..1
    return round(1.0 - entropy, 4)


def rule_confidence(risk: int) -> float:
    """規則模式信心：以風險分數距最近決策門檻（0/40/70/100）的裕度衡量。"""
    boundaries = (0, PASS_MAX, BLOCK_MIN, 100)
    nearest = min(abs(risk - b) for b in boundaries)
    # 一個 band 內最大裕度約 15 分（70→100 帶較寬，取 15 為基準），夾在 0..1
    return round(min(1.0, nearest / 15.0), 4)


def confidence_band(conf: float) -> str:
    if conf >= 0.75:
        return "high"
    if conf >= 0.4:
        return "medium"
    return "low"


def _top_factors_from_model(bundle: dict, x: list[list[float]], k: int = 3) -> list[TopFactor]:
    """用 LightGBM SHAP 貢獻取「推升風險」前 k 大特徵（log-odds 空間，正值=更像詐欺）。"""
    try:
        import numpy as np
        booster = bundle["lgbm"].booster_
        contrib = booster.predict(np.asarray(x, dtype=float), pred_contrib=True)[0]
        order = bundle.get("feature_list", FEATURE_ORDER)
        pairs = [(order[i], float(contrib[i])) for i in range(len(order))]
        pairs.sort(key=lambda p: p[1], reverse=True)
        return [
            TopFactor(feature=f, label=feature_label(f), impact=round(v, 4))
            for f, v in pairs[:k]
            if v > 0
        ]
    except Exception:
        return []


def _top_factors_from_rules(codes: list[str], k: int = 3) -> list[TopFactor]:
    ranked = sorted(codes, key=lambda c: WEIGHTS.get(c, 0), reverse=True)[:k]
    return [
        TopFactor(feature=c, label=REASON_LABELS.get(c, c), impact=float(WEIGHTS.get(c, 0)))
        for c in ranked
    ]


def score(row: Mapping[str, Any]) -> ScoreResponse:
    bundle = _load()
    if bundle is None:
        risk, codes = rule_risk(row)
        conf = rule_confidence(risk)
        return ScoreResponse(
            risk=risk,
            decision=decide(risk),
            reasons=codes,
            source="rules",
            confidence=conf,
            confidence_band=confidence_band(conf),
            top_factors=_top_factors_from_rules(codes),
        )

    feature_order = bundle.get("feature_list", FEATURE_ORDER)
    x = [vectorize(row, feature_order)]

    # p_fraud 優先用校準後機率（isotonic），使風險分數有意義；缺則用原始 LGBM
    estimator = bundle.get("calibrator") or bundle["lgbm"]
    p_fraud = float(estimator.predict_proba(x)[0][1])

    iso = bundle.get("iso")
    anomaly_norm = 0.0
    if iso is not None:
        raw = -float(iso.score_samples(x)[0])  # 越大越異常
        amin = float(bundle.get("anomaly_min", 0.0))
        amax = float(bundle.get("anomaly_max", 1.0))
        rng = amax - amin if amax > amin else 1.0
        anomaly_norm = max(0.0, min(1.0, (raw - amin) / rng))

    risk = int(round(100 * (0.7 * p_fraud + 0.3 * anomaly_norm)))
    risk = max(0, min(100, risk))

    # reason codes：規則映射（可解釋）；模型判高風險但規則無觸發時補 MODEL_ANOMALY
    codes = reason_codes(row)
    if not codes and risk >= PASS_MAX:
        codes = ["MODEL_ANOMALY"]

    # 情資命中：獨立於模型判斷之外的加成（ADR-007 CHT Security 情資 mock）。
    # 規則模式（bundle is None 分支）不需要這段，因為 rule_risk() 已經把 WEIGHTS 加總進去了。
    if "THREAT_INTEL_HIT" in codes:
        risk = max(0, min(100, risk + WEIGHTS["THREAT_INTEL_HIT"]))

    # top_factors：優先用模型 SHAP 貢獻；取不到則退回規則權重
    top = _top_factors_from_model(bundle, x)
    if not top:
        top = _top_factors_from_rules(codes)
    if "THREAT_INTEL_HIT" in codes:
        top = [
            TopFactor(
                feature="THREAT_INTEL_HIT",
                label=REASON_LABELS["THREAT_INTEL_HIT"],
                impact=float(WEIGHTS["THREAT_INTEL_HIT"]),
            )
        ] + top
        top = top[:3]

    conf = prob_confidence(p_fraud)
    return ScoreResponse(
        risk=risk,
        decision=decide(risk),
        reasons=codes,
        source="model",
        p_fraud=round(p_fraud, 4),
        anomaly=round(anomaly_norm, 4),
        confidence=conf,
        confidence_band=confidence_band(conf),
        top_factors=top,
    )
