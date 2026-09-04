"""訓練 LightGBM + IsolationForest，存 model.joblib（含 feature_list）。

資料優先序：data/paysim.csv（真 PaySim，會自動補增益欄）→ 否則合成資料。
時間切分（依 step）train/val/test，印 holdout AUC / PR-AUC / 人頭召回。
"""
from __future__ import annotations

import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")  # 避免 Windows cp950 主控台對 CJK 崩潰
except Exception:
    pass

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.frozen import FrozenEstimator
from sklearn.ensemble import IsolationForest
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    matthews_corrcoef,
    precision_recall_curve,
    precision_score,
    recall_score,
    roc_auc_score,
    roc_curve,
)
import lightgbm as lgb

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)

from app.featurize import FEATURE_ORDER, featurize  # noqa: E402
from app.graph import compute_account_graph, apply_graph_features  # noqa: E402
from app.model import BLOCK_MIN, PASS_MAX  # noqa: E402
from app.rules import rule_risk  # noqa: E402

DATA_CSV = os.path.join(HERE, "data", "paysim.csv")
MODEL_OUT = os.path.join(HERE, "model.joblib")

# 服務端 risk 分數的混合權重（必須與 app/model.py::score() 一致）
RISK_W_P_FRAUD = 0.7
RISK_W_ANOMALY = 0.3

# C4：是否允許把「以 isFraud 為條件」的模擬 CHT 訊號注入真實資料。
# 預設 **關閉** —— 那是結構性標籤洩漏，只能用於明示的 demo 情境。
ALLOW_LABEL_CONDITIONED_CHT = os.environ.get("CHT_LABEL_CONDITIONED_SIM", "0") == "1"


def fit_calibrated_lgbm(Xtr, ytr, Xva, yva):
    """訓練 LightGBM 並用驗證集做 isotonic 校準，回傳 (raw_clf, calibrated)。"""
    pos = max(1, int(ytr.sum()))
    neg = max(1, len(ytr) - pos)
    clf = lgb.LGBMClassifier(
        n_estimators=400, learning_rate=0.05, num_leaves=31,
        subsample=0.9, colsample_bytree=0.9,
        scale_pos_weight=neg / pos, random_state=42, verbose=-1,
    )
    clf.fit(
        Xtr, ytr, eval_set=[(Xva, yva)], eval_metric="auc",
        callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(0)],
    )
    calibrated = CalibratedClassifierCV(FrozenEstimator(clf), method="isotonic")
    calibrated.fit(Xva, yva)
    return clf, calibrated


def expected_calibration_error(y, p, bins: int = 10) -> tuple[float, list[dict]]:
    """ECE（期望校準誤差）+ 可靠度曲線資料（每桶平均預測 vs 實際詐欺率）。"""
    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    edges = np.linspace(0.0, 1.0, bins + 1)
    ece = 0.0
    curve: list[dict] = []
    for i in range(bins):
        lo, hi = edges[i], edges[i + 1]
        mask = (p >= lo) & (p < hi) if i < bins - 1 else (p >= lo) & (p <= hi)
        cnt = int(mask.sum())
        if cnt == 0:
            continue
        conf = float(p[mask].mean())
        acc = float(y[mask].mean())
        ece += abs(conf - acc) * cnt / len(p)
        curve.append({"pred_mean": round(conf, 4), "frac_fraud": round(acc, 4), "count": cnt})
    return float(ece), curve

def load_data() -> tuple[pd.DataFrame, str, dict]:
    """回傳 (df, source 字串, cht_signal_provenance)。

    `cht_signal_provenance` 會寫進 metrics.json，讓「這些 CHT 欄位是哪來的」永遠有紀錄。
    """
    if os.path.exists(DATA_CSV):
        df = pd.read_csv(DATA_CSV)
        from synth import augment_cht_signals, fill_neutral_cht_signals, CHT_SIGNAL_COLS
        missing = [c for c in CHT_SIGNAL_COLS if c not in df.columns]
        if not missing:
            provenance = {
                "mode": "real",
                "label_conditioned": False,
                "evidence_grade": "observational",
                "note": "資料源本身即含 CHT 增益欄位，未做任何注入。",
            }
        elif ALLOW_LABEL_CONDITIONED_CHT:
            # C4：只有在明示 CHT_LABEL_CONDITIONED_SIM=1 時才走這條路。
            df = augment_cht_signals(df, allow_label_conditioning=True)
            provenance = {
                "mode": "label_conditioned_simulation",
                "label_conditioned": True,
                "evidence_grade": "simulation",
                "note": (
                    "CHT 欄位以 isFraud 為條件生成（結構性標籤洩漏）。任何基於這些欄位的"
                    "消融 lift 只反映注入的標籤資訊量，不可外推為真實世界效益。"
                ),
                "columns": missing,
            }
            print(
                "[train] ⚠ CHT_LABEL_CONDITIONED_SIM=1：以 isFraud 為條件注入 CHT 訊號"
                "（結構性標籤洩漏，僅供 demo，消融結果不可對外宣稱為真實增益）"
            )
        else:
            df = fill_neutral_cht_signals(df)
            provenance = {
                "mode": "neutral_placeholder",
                "label_conditioned": False,
                "evidence_grade": "none",
                "note": (
                    "資料源缺 CHT 欄位，改以與標籤獨立的分佈補齊（期望增益為 0），"
                    "以避免標籤洩漏。要跑舊的 demo 模擬請設 CHT_LABEL_CONDITIONED_SIM=1。"
                ),
                "columns": missing,
            }
            print("[train] 資料源缺 CHT 欄位 → 以標籤無關的中性值補齊（不注入標籤資訊）")
        if "step" not in df.columns:
            df["step"] = np.arange(len(df))
        return df, f"PaySim ({DATA_CSV}) + CHT 欄位:{provenance['mode']}", provenance

    from synth import generate
    provenance = {
        "mode": "fully_synthetic",
        "label_conditioned": True,
        "evidence_grade": "simulation",
        "note": (
            "整份資料由 synth.py::generate() 產生：先決定每列是正常/詐欺 A/B/C，"
            "再依該類分佈抽特徵並硬寫 isFraud（尾端另做 ~1.5% 隨機標籤翻轉）。"
            "特徵與標籤的關聯強度是設定出來的參數，非真實世界觀測。"
        ),
    }
    return generate(), "synthetic (PaySim-like)", provenance


def to_matrix(df: pd.DataFrame) -> np.ndarray:
    feats = [featurize(r) for r in df.to_dict("records")]
    return np.array([[f[name] for name in FEATURE_ORDER] for f in feats], dtype=float)


def main() -> None:
    df, source, cht_provenance = load_data()
    print(f"[train] 資料來源：{source}  rows={len(df)}  fraud={int(df['isFraud'].sum())}")

    # 依時間切分（out-of-time），避免洩漏
    df = df.sort_values("step").reset_index(drop=True)
    n = len(df)
    tr_end, va_end = int(n * 0.7), int(n * 0.85)
    train, val, test = df[:tr_end], df[tr_end:va_end], df[va_end:]

    # A2：帳戶圖譜「只用訓練期邊」建立，再套用到 val/test → 不用未來邊（避免時間洩漏）
    graph = compute_account_graph(train)
    train = apply_graph_features(train, graph)
    val = apply_graph_features(val, graph)
    test = apply_graph_features(test, graph)

    Xtr, ytr = to_matrix(train), train["isFraud"].to_numpy()
    Xva, yva = to_matrix(val), val["isFraud"].to_numpy()
    Xte, yte = to_matrix(test), test["isFraud"].to_numpy()

    # 機率校準（isotonic）：用驗證集校準已訓練的 LGBM，使風險分數有意義
    # sklearn>=1.6：以 FrozenEstimator 包裝已訓練模型（取代舊 cv="prefit"）
    clf, calibrated = fit_calibrated_lgbm(Xtr, ytr, Xva, yva)

    def proba_of(X: np.ndarray) -> np.ndarray:
        return calibrated.predict_proba(X)[:, 1]

    # 用驗證集挑最大化 F1 的門檻（基於校準後機率）。
    # 先前是 np.linspace(0.05, 0.95) 的固定網格，最佳值一路落在網格**下界 0.05**，
    # 代表真正的最佳門檻可能更低卻被網格擋住（回報的 0.05 是人為邊界，不是最佳解）。
    # 改由 PR 曲線直接求 F1 最大點：門檻候選＝資料中實際出現的所有分數切點，無網格邊界問題。
    proba_va = proba_of(Xva)
    prec_c, rec_c, thr_c = precision_recall_curve(yva, proba_va)
    # precision_recall_curve 回傳 len(thr)=len(prec)-1（最後一點對應 recall=0，無對應門檻）
    denom = prec_c[:-1] + rec_c[:-1]
    f1_c = np.divide(
        2 * prec_c[:-1] * rec_c[:-1], denom, out=np.zeros_like(denom), where=denom > 0
    )
    best_thr = float(thr_c[int(np.argmax(f1_c))]) if len(thr_c) else 0.5
    best_f1_va = float(f1_c.max()) if len(f1_c) else 0.0

    # ── 評估（主指標 PR-AUC；極不平衡下勿看 accuracy）──
    proba = proba_of(Xte)
    pr_auc = average_precision_score(yte, proba)
    roc = roc_auc_score(yte, proba)
    recall = recall_score(yte, (proba >= best_thr).astype(int))
    mcc = matthews_corrcoef(yte, (proba >= best_thr).astype(int))
    # recall @ FPR=1%
    fpr, tpr, _ = roc_curve(yte, proba)
    idx = np.where(fpr <= 0.01)[0]
    recall_at_fpr1 = float(tpr[idx[-1]]) if len(idx) else 0.0
    # precision @ top-100
    k = min(100, len(proba))
    topk = np.argsort(proba)[::-1][:k]
    precision_at_100 = float(yte[topk].mean()) if k else 0.0

    print(f"[train] holdout PR-AUC（主指標）= {pr_auc:.4f}")
    print(f"[train] holdout ROC-AUC        = {roc:.4f}")
    print(f"[train] recall@FPR=1%          = {recall_at_fpr1:.4f}")
    print(f"[train] precision@100          = {precision_at_100:.4f}")
    print(f"[train] MCC@thr={best_thr:.2f}        = {mcc:.4f}")
    print(f"[train] 人頭召回@thr={best_thr:.2f}    = {recall:.4f}")
    if roc >= 0.999:
        print("[train] ⚠ ROC-AUC≈1.0：極可能資料洩漏或過擬，請以 PR-AUC 與 out-of-time 為準")

    # ── 校準品質（ECE + Brier + 可靠度曲線）：證明「風險分數＝真實詐欺機率」 ──
    ece, reliability = expected_calibration_error(yte, proba, bins=10)
    brier = float(brier_score_loss(yte, proba))
    print(f"[train] 校準 ECE={ece:.4f}  Brier={brier:.4f}（越低越準）")

    # ── 基線對照：規則 baseline vs Logistic Regression vs LightGBM（證明模型選型有依據）──
    rules_score = np.array([rule_risk(r)[0] / 100.0 for r in test.to_dict("records")])
    rules_pr = float(average_precision_score(yte, rules_score))
    rules_roc = float(roc_auc_score(yte, rules_score))

    lr = make_pipeline(
        StandardScaler(),
        LogisticRegression(max_iter=1000, class_weight="balanced", random_state=42),
    )
    lr.fit(Xtr, ytr)
    lr_proba = lr.predict_proba(Xte)[:, 1]
    lr_pr = float(average_precision_score(yte, lr_proba))
    lr_roc = float(roc_auc_score(yte, lr_proba))
    print(f"[train] 基線 PR-AUC  rules={rules_pr:.4f}  LR={lr_pr:.4f}  LGBM={pr_auc:.4f}")

    # ── CHT 訊號增益消融：移除中華電信門號實名/裝置/地理等訊號後重訓，量化能力提升 ──
    from synth import CHT_SIGNAL_COLS
    cht_cols = [c for c in CHT_SIGNAL_COLS if c in FEATURE_ORDER]
    keep_idx = [i for i, name in enumerate(FEATURE_ORDER) if name not in cht_cols]
    _, ablate_cal = fit_calibrated_lgbm(Xtr[:, keep_idx], ytr, Xva[:, keep_idx], yva)
    ablate_proba = ablate_cal.predict_proba(Xte[:, keep_idx])[:, 1]
    ablate_pr = float(average_precision_score(yte, ablate_proba))
    lift = float(pr_auc) - ablate_pr
    lift_pct = round(100.0 * lift / ablate_pr, 2) if ablate_pr > 0 else 0.0
    print(f"[train] CHT 訊號增益：無 CHT PR-AUC={ablate_pr:.4f} → 全特徵={pr_auc:.4f}（+{lift:.4f}, +{lift_pct}%）")
    if cht_provenance.get("label_conditioned", True):
        print(
            "[train] ⚠ 上述 CHT 增益為 label-conditioned simulation："
            "CHT 欄位以 isFraud 為條件生成，此 lift 量的是注入的標籤資訊量，"
            "**不是**真實世界增益，簡報請勿當作效益證據（metrics.json 已標 evidence_grade=simulation）"
        )

    # IsolationForest 只用「正常樣本」訓練 → 訓練集裡按定義沒有污染，
    # 先前用 contamination=ytr.mean()（整體詐欺率）與實際餵進去的資料自相矛盾。改用 "auto"。
    iso = IsolationForest(n_estimators=200, contamination="auto", random_state=42)
    iso.fit(Xtr[ytr == 0])
    raw = -iso.score_samples(Xtr)
    amin, amax = float(np.percentile(raw, 1)), float(np.percentile(raw, 99))

    # ── 服務端「混合風險分數」的評估（補上 train/serve 指標落差）──
    # app/model.py 回給呼叫端的是 risk = 100*(0.7*p_fraud + 0.3*anomaly_norm)，
    # 但上面所有指標與校準都算在 p_fraud 上，決策門檻卻是套在混合分數上。
    # 這裡直接在 holdout 上重算一次「服務端真正會用的分數」，讓落差可被量化而非只靠註記。
    _rng_span = amax - amin if amax > amin else 1.0
    anomaly_te = np.clip((-iso.score_samples(Xte) - amin) / _rng_span, 0.0, 1.0)
    blended = RISK_W_P_FRAUD * proba + RISK_W_ANOMALY * anomaly_te
    blended_pr = float(average_precision_score(yte, blended))
    blended_roc = float(roc_auc_score(yte, blended))
    # 服務端實際決策門檻（app/model.py::decide()）：risk>=70 block、>=40 review
    blk = (blended * 100 >= BLOCK_MIN).astype(int)
    rev = (blended * 100 >= PASS_MAX).astype(int)
    serving_block = {
        "recall": round(float(recall_score(yte, blk, zero_division=0)), 4),
        "precision": round(float(precision_score(yte, blk, zero_division=0)), 4),
    }
    serving_review_or_block = {
        "recall": round(float(recall_score(yte, rev, zero_division=0)), 4),
        "precision": round(float(precision_score(yte, rev, zero_division=0)), 4),
    }
    print(
        f"[train] 服務端混合分數 PR-AUC={blended_pr:.4f}（vs p_fraud {pr_auc:.4f}）"
        f"  risk>=70 recall={serving_block['recall']:.4f} precision={serving_block['precision']:.4f}"
    )

    joblib.dump(
        {
            "lgbm": clf, "calibrator": calibrated, "iso": iso,
            "feature_list": FEATURE_ORDER,
            "anomaly_min": amin, "anomaly_max": amax,
            "source": source, "holdout_pr_auc": float(pr_auc), "holdout_auc": float(roc),
        },
        MODEL_OUT,
    )
    print(f"[train] 已存 {MODEL_OUT}")

    # 指標與特徵重要度 → metrics.json（簡報圖表用）
    pred_te = (proba >= best_thr).astype(int)
    tp = int(((pred_te == 1) & (yte == 1)).sum())
    fp = int(((pred_te == 1) & (yte == 0)).sum())
    fn = int(((pred_te == 0) & (yte == 1)).sum())
    tn = int(((pred_te == 0) & (yte == 0)).sum())
    importances = sorted(
        (
            {"feature": FEATURE_ORDER[i], "importance": int(clf.feature_importances_[i])}
            for i in range(len(FEATURE_ORDER))
        ),
        key=lambda d: d["importance"],
        reverse=True,
    )[:12]
    metrics = {
        "source": source,
        "rows": int(len(df)),
        "fraud": int(df["isFraud"].sum()),
        "primary_metric": "PR-AUC",
        "fraud_prevalence": round(float(yte.mean()), 4),  # PR-AUC 的隨機基準線
        "holdout_pr_auc": round(float(pr_auc), 4),
        "holdout_roc_auc": round(float(roc), 4),
        "holdout_auc": round(float(roc), 4),  # 向後相容
        "recall_at_fpr_1pct": round(float(recall_at_fpr1), 4),
        "precision_at_100": round(float(precision_at_100), 4),
        "mcc": round(float(mcc), 4),
        "threshold": round(float(best_thr), 4),
        "threshold_selection": {
            "method": "max-F1 on validation PR curve (sklearn precision_recall_curve)",
            "note": (
                "候選門檻＝驗證集分數的實際切點，沒有網格下界；先前的 linspace(0.05,0.95) "
                "會把最佳解卡在邊界 0.05。"
            ),
            "val_best_f1": round(float(best_f1_va), 4),
            "applies_to": "p_fraud（校準後機率），非服務端回傳的混合 risk 分數",
        },
        "recall_at_threshold": round(float(recall), 4),
        "confusion_at_threshold": {"tp": tp, "fp": fp, "fn": fn, "tn": tn},
        "calibration": "isotonic",
        "calibration_quality": {
            "ece": round(ece, 4),
            "brier": round(brier, 4),
            "reliability_curve": reliability,
        },
        "baselines": {
            "rules_only": {"pr_auc": round(rules_pr, 4), "roc_auc": round(rules_roc, 4)},
            "logistic_regression": {"pr_auc": round(lr_pr, 4), "roc_auc": round(lr_roc, 4)},
            "lightgbm": {"pr_auc": round(float(pr_auc), 4), "roc_auc": round(float(roc), 4)},
        },
        "cht_signal_ablation": {
            "without_cht_pr_auc": round(ablate_pr, 4),
            "with_cht_pr_auc": round(float(pr_auc), 4),
            "lift_pr_auc": round(lift, 4),
            "lift_pct": lift_pct,
            "signals": cht_cols,
            # ── C4 誠實度標註（勿刪；前端/簡報引用 lift_pct 時必須一併呈現）──
            "evidence_grade": cht_provenance.get("evidence_grade", "simulation"),
            "label_conditioned": bool(cht_provenance.get("label_conditioned", True)),
            "caveat": (
                "label-conditioned synthetic signals; not evidence of real-world lift"
                if cht_provenance.get("label_conditioned", True)
                else "CHT columns are label-independent; lift here is a null/sanity baseline"
            ),
            "caveat_zh": (
                "這 9 個 CHT 欄位是以 isFraud 標籤為條件生成的（synth.py），"
                "消融量到的是「注入了多少標籤資訊」，屬循環論證，"
                "不能當作中華電信訊號在真實世界的效益證據。"
                if cht_provenance.get("label_conditioned", True)
                else "CHT 欄位與標籤獨立，此消融結果為對照基準線。"
            ),
            "data_provenance": cht_provenance,
        },
        "data_honesty": {
            "synthetic_only": bool(
                cht_provenance.get("mode") in ("fully_synthetic", "label_conditioned_simulation")
            ),
            "evidence_grade": cht_provenance.get("evidence_grade", "simulation"),
            "label_generation": (
                "synth.py::generate() 先決定每列類別（正常/詐欺 A/B/C）再依該類分佈抽特徵、"
                "硬寫 isFraud 為 0/1；唯一標籤隨機性是尾端 ~1.5% 隨機翻轉。"
                "並非「潛在風險 logit + Bernoulli 抽樣」。"
            ),
            "extrapolation": (
                "synthetic-only：本檔所有指標僅描述這份合成/半合成資料上的表現，"
                "不可外推至真實金融交易分佈，亦不可作為上線效益承諾。"
            ),
            "no_real_world_validation": True,
        },
        # ── train/serve 指標落差（Medium）──
        "risk_score_composition": {
            "serving_formula": (
                f"risk = round(100 * ({RISK_W_P_FRAUD} * p_fraud + {RISK_W_ANOMALY} * anomaly_norm))"
            ),
            "metrics_computed_on": "p_fraud（校準後 LightGBM 機率）",
            "decision_thresholds_applied_to": (
                f"混合 risk 分數（app/model.py::decide()：<{PASS_MAX} pass、"
                f"{PASS_MAX}-{BLOCK_MIN - 1} review、>={BLOCK_MIN} block）"
            ),
            "gap": (
                "本檔上方的 PR-AUC / ROC-AUC / ECE / Brier / threshold 都算在 p_fraud 上，"
                "但服務端拿來做決策的是混合分數；IsolationForest 那 30% 未被上方指標與校準涵蓋。"
                "下方 blended_risk_evaluation 為混合分數的直接評估，兩者請一併看。"
            ),
            "blended_risk_evaluation": {
                "pr_auc": round(blended_pr, 4),
                "roc_auc": round(blended_roc, 4),
                "pr_auc_delta_vs_p_fraud": round(blended_pr - float(pr_auc), 4),
                "at_serving_block_threshold": serving_block,
                "at_serving_review_threshold": serving_review_or_block,
                "note": "混合分數未經校準，數值不應被解讀為詐欺機率。",
            },
        },
        "split": "out-of-time (by step)",
        "top_feature_importances": importances,
    }
    with open(os.path.join(HERE, "metrics.json"), "w", encoding="utf-8") as mf:
        json.dump(metrics, mf, ensure_ascii=False, indent=2)
    print("[train] 已存 metrics.json")

    if pr_auc < 0.70:
        print(f"[train] ⚠ PR-AUC<0.70（{pr_auc:.4f}），資料訊號可能不足")


if __name__ == "__main__":
    main()
