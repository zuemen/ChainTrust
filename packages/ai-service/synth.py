"""合成 PaySim-like 資料產生器。

無 Kaggle PaySim 時的退路。

**標籤產生方式（H16：以下描述與 `generate()` 實作一致，請勿再寫成「logit + Bernoulli」）**：
`generate()` **先決定每一列屬於哪一類（正常 / 詐欺 A / 詐欺 B / 詐欺 C），再依該類的
分佈抽特徵，並把 `isFraud` 硬寫成 0 或 1**。沒有潛在風險 logit，也沒有 Bernoulli
抽樣決定標籤。唯一的標籤隨機性是**產生完之後**對約 1.5% 的列做隨機標籤翻轉
（`generate()` 尾端），用來避免資料完美可分。

也就是說：特徵是「以標籤為條件」抽出來的（label-conditioned），這是合成資料的
常態做法，但同時代表——

- 特徵與標籤的關聯強度是**我們自己設定的參數**，不是從真實世界量到的。
- 任何在這份資料上算出的「訊號增益 / 消融 lift」，量的是**我們注入了多少標籤資訊**，
  不是該訊號在真實金流中的價值。詳見 `augment_cht_signals()` 的 docstring 與
  `metrics.json` 的 `cht_signal_ablation.caveat`。

刻意設計的難度來源（讓 holdout PR-AUC 落在 ~0.85–0.92 而非 1.0）：詐欺與正常的特徵
分佈**高度重疊**（正常戶也會出現大額 / 新帳戶 / 未實名等單一風險邊際），加上 1.5%
標籤翻轉噪音。含時間欄 `step` 供 out-of-time 切分。

要換真資料：把 PaySim CSV 放到 data/paysim.csv，train.py 會優先使用。
"""
from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from app.featurize import featurize  # noqa: E402

TYPES = ["CASH_IN", "CASH_OUT", "DEBIT", "PAYMENT", "TRANSFER"]


def generate(n: int = 40_000, fraud_ratio: float = 0.08, seed: int = 42) -> pd.DataFrame:
    """混合模型合成資料。詐欺含三種樣態，刻意讓 CHT 身分訊號帶獨立資訊、並含非線性交互。

    - 正常戶：交易與身分訊號皆乾淨；含「大額但已實名」與「未實名但小額」兩種安全干擾項。
    - 詐欺 A（身分型，~35%）：**交易表面正常**，僅靠 CHT 身分訊號（未實名＋換裝置＋異地＋新帳戶）
      才攔得到 → 移除 CHT 訊號後這類完全漏接（消融會顯示明顯 PR-AUC 下降）。
    - 詐欺 B（交互型，~40%）：**大額 × 未實名**才可疑（單看大額或單看未實名都不可疑，
      因正常戶兩者各自都有）→ 線性模型抓不到、需要 GBM 的交互結構。
    - 詐欺 C（金流型，~25%）：人頭環清空（高 drain＋水房 fan-in＋CASH_OUT），靠交易/圖譜訊號。
    """
    rng = np.random.default_rng(seed)
    n_fraud = int(n * fraud_ratio)
    n_legit = n - n_fraud
    n_a = int(n_fraud * 0.35)
    n_b = int(n_fraud * 0.40)
    n_c = n_fraud - n_a - n_b

    COLL = [f"MULE_COLL_{i}" for i in range(12)]
    def cust() -> str: return f"C{int(rng.integers(0, 900_000))}"
    def merch() -> str: return f"M{int(rng.integers(0, 90_000))}"

    def base() -> dict:
        return {"step": int(rng.integers(0, 720))}

    rows: list[dict] = []

    # ── 正常戶（含安全干擾項：大額/新帳戶/未實名各自單獨出現都安全，逼模型學「三者同時」）──
    for _ in range(n_legit):
        r = base()
        t = str(rng.choice(TYPES, p=[0.20, 0.20, 0.05, 0.42, 0.13]))
        # 邊際干擾：每個風險邊際各自獨立出現在正常戶（安全），唯獨「三者同時」才是詐欺
        big = rng.random() < 0.18                       # 合法大額
        young = rng.random() < 0.15                     # 合法新戶（新申辦的優質客戶）
        unverified = rng.random() < 0.25                # 合法未實名（尚未綁門號電子卡）
        old_org = float(abs(rng.lognormal(11.0 if big else 8.8, 1.0)))
        drain = float(rng.uniform(0.0, 0.5)) if rng.random() < 0.9 else float(rng.uniform(0.5, 0.9))
        amount = old_org * drain
        r.update({
            "type": t, "nameOrig": cust(), "nameDest": merch() if t == "PAYMENT" else cust(),
            "amount": amount, "oldbalanceOrg": old_org, "newbalanceOrig": max(0.0, old_org - amount),
            "oldbalanceDest": float(abs(rng.lognormal(8.0, 1.2))),
            "newbalanceDest": float(abs(rng.lognormal(8.0, 1.2))) + amount,
            "tx_count_1h": int(rng.integers(0, 5)), "tx_count_24h": int(rng.integers(0, 15)),
            "device_changed": int(rng.random() < 0.08),
            "mobile_realname_verified": 0 if unverified else 1,
            "vc_age_days": int(rng.integers(0, 60) if young else rng.integers(60, 1000)),
            "account_age_days": int(rng.integers(0, 40) if young else rng.integers(40, 2000)),
            "cross_institution_presentations": int(rng.integers(0, 7)),
            "payee_risk": float(np.clip(rng.normal(0.18, 0.12), 0, 1)),
            "geo_jump": int(rng.random() < 0.06), "isFraud": 0,
        })
        rows.append(r)

    # ── 詐欺 A：身分型（交易看似正常，靠 CHT 身分訊號攔截）──
    for _ in range(n_a):
        r = base()
        t = str(rng.choice(TYPES, p=[0.10, 0.15, 0.05, 0.45, 0.25]))
        old_org = float(abs(rng.lognormal(8.8, 1.0)))
        drain = float(rng.uniform(0.1, 0.6))            # 與正常重疊
        amount = old_org * drain
        r.update({
            "type": t, "nameOrig": cust(), "nameDest": merch() if t == "PAYMENT" else cust(),
            "amount": amount, "oldbalanceOrg": old_org, "newbalanceOrig": max(0.0, old_org - amount),
            "oldbalanceDest": float(abs(rng.lognormal(8.0, 1.2))),
            "newbalanceDest": float(abs(rng.lognormal(8.0, 1.2))) + amount,
            "tx_count_1h": int(rng.integers(1, 8)), "tx_count_24h": int(rng.integers(5, 35)),
            "device_changed": int(rng.random() < 0.75),
            "mobile_realname_verified": int(rng.random() < 0.10),   # 幾乎都未實名（CHT 強訊號）
            "vc_age_days": int(rng.integers(0, 60)), "account_age_days": int(rng.integers(0, 40)),
            "cross_institution_presentations": int(rng.integers(6, 18)),
            "payee_risk": float(np.clip(rng.normal(0.35, 0.18), 0, 1)),
            "geo_jump": int(rng.random() < 0.70), "isFraud": 1,
        })
        rows.append(r)

    # ── 詐欺 B：交互型（大額 × 新帳戶 × 未實名「三者同時」才是詐欺；任一單獨皆見於正常戶）──
    for _ in range(n_b):
        r = base()
        t = str(rng.choice(TYPES, p=[0.05, 0.30, 0.02, 0.18, 0.45]))
        old_org = float(abs(rng.lognormal(11.2, 0.8)))  # 大額（與合法大額同分佈）
        drain = float(rng.uniform(0.5, 1.0))
        amount = old_org * drain
        r.update({
            "type": t, "nameOrig": cust(), "nameDest": merch() if t == "PAYMENT" else cust(),
            "amount": amount, "oldbalanceOrg": old_org, "newbalanceOrig": max(0.0, old_org - amount) * float(rng.uniform(0, 0.2)),
            "oldbalanceDest": float(abs(rng.lognormal(7.2, 1.4))),
            "newbalanceDest": float(abs(rng.lognormal(7.2, 1.4))) + amount * float(rng.uniform(0, 0.6)),
            "tx_count_1h": int(rng.integers(1, 10)), "tx_count_24h": int(rng.integers(8, 45)),
            "device_changed": int(rng.random() < 0.40),
            "mobile_realname_verified": 0,                          # 未實名
            "vc_age_days": int(rng.integers(0, 40)), "account_age_days": int(rng.integers(0, 40)),  # 新帳戶
            "cross_institution_presentations": int(rng.integers(3, 15)),
            "payee_risk": float(np.clip(rng.normal(0.4, 0.2), 0, 1)),
            "geo_jump": int(rng.random() < 0.4), "isFraud": 1,
        })
        rows.append(r)

    # ── 詐欺 C：金流型（人頭環清空，靠交易/圖譜）──
    for _ in range(n_c):
        r = base()
        t = "CASH_OUT" if rng.random() < 0.5 else "TRANSFER"
        old_org = float(abs(rng.lognormal(10.5, 0.9)))
        amount = old_org * float(rng.uniform(0.85, 1.0))
        if t == "TRANSFER":
            n_orig, n_dest = cust(), COLL[int(rng.integers(0, len(COLL)))]
        else:
            n_orig, n_dest = COLL[int(rng.integers(0, len(COLL)))], merch()
        r.update({
            "type": t, "nameOrig": n_orig, "nameDest": n_dest,
            "amount": amount, "oldbalanceOrg": old_org,
            "newbalanceOrig": max(0.0, old_org - amount) * float(rng.uniform(0, 0.05)),
            "oldbalanceDest": float(abs(rng.lognormal(7.0, 1.4))),
            "newbalanceDest": float(abs(rng.lognormal(7.0, 1.4))) + amount * float(rng.uniform(0, 0.5)),
            "tx_count_1h": int(rng.integers(2, 12)), "tx_count_24h": int(rng.integers(10, 55)),
            "device_changed": int(rng.random() < 0.5),
            "mobile_realname_verified": int(rng.random() < 0.3),
            "vc_age_days": int(rng.integers(0, 90)), "account_age_days": int(rng.integers(0, 60)),
            "cross_institution_presentations": int(rng.integers(3, 18)),
            "payee_risk": float(np.clip(rng.normal(0.6, 0.2), 0, 1)),
            "geo_jump": int(rng.random() < 0.45), "isFraud": 1,
        })
        rows.append(r)

    df = pd.DataFrame(rows)
    # 標籤雜訊：翻轉 ~1.5%，避免完美可分（更貼近真實）
    flip = rng.random(len(df)) < 0.015
    df.loc[flip, "isFraud"] = 1 - df.loc[flip, "isFraud"]
    return df.sample(frac=1.0, random_state=seed).reset_index(drop=True)


# 真 PaySim 缺少的 ChainTrust/CHT 增益欄位清單。
CHT_SIGNAL_COLS = [
    "tx_count_1h", "tx_count_24h", "device_changed", "mobile_realname_verified",
    "vc_age_days", "account_age_days", "cross_institution_presentations",
    "payee_risk", "geo_jump",
]

# 呼叫端誤用時的統一錯誤訊息（C4）
_LABEL_CONDITIONING_REFUSAL = (
    "augment_cht_signals() 只能產生「以 isFraud 標籤為條件」的模擬訊號，"
    "套在真實資料上等同結構性標籤洩漏。若確定是 demo/簡報用途，請明示 "
    "allow_label_conditioning=True；若要在真實資料上補欄位，請改用 "
    "fill_neutral_cht_signals()。"
)


def augment_cht_signals(
    df: pd.DataFrame,
    seed: int = 42,
    *,
    allow_label_conditioning: bool,
) -> pd.DataFrame:
    """【DEMO ONLY／標籤洩漏】以 `isFraud` 為條件生成 9 個 CHT 增益訊號欄位。

    ⚠️ **這個函式會讀 `df["isFraud"]`，並依標籤從兩組不同分佈抽樣特徵。**
    也就是說它把答案（標籤）直接編碼進特徵裡：

    - 產出的欄位對 `isFraud` 的預測力，**完全等於我們在下面硬寫的分佈差距**
      （例如 `device_changed` 詐欺 58% vs 正常 8%），不是任何真實世界的觀測。
    - 因此在這些欄位上做「消融實驗」（`train.py` 的 `cht_signal_ablation`）**不是**
      在量測中華電信訊號的真實增益，而是在量**我們注入了多少標籤資訊**——循環論證。
      任何以此為據的「+X% PR-AUC lift」都必須標註為 `evidence_grade: "simulation"`，
      **不可以**當成真實世界效益的證據對外簡報。
    - 這也不是可修的 bug：要證明 CHT 訊號的真實增益，唯一辦法是取得**真實**同時
      含金流與電信/裝置/地理訊號的資料集，這超出 PoC 範圍。

    合法用途只有一個：讓 demo pipeline 在沒有真實 CHT 欄位時仍能跑完、產生可視化。

    Args:
        df: 需含 `isFraud` 欄（缺則全部視為非詐欺，等同無訊號）。
        seed: 亂數種子。
        allow_label_conditioning: **必填**。呼叫端必須明示知道自己在注入標籤資訊；
            傳 False（或忘了傳而踩到 TypeError）即拒絕執行。這個參數存在的目的，
            就是讓「在真實資料上不小心套用」變成一件做不到的事。

    Raises:
        ValueError: `allow_label_conditioning` 為 False。
    """
    if not allow_label_conditioning:
        raise ValueError(_LABEL_CONDITIONING_REFUSAL)

    rng = np.random.default_rng(seed)
    n = len(df)
    f = (df["isFraud"].to_numpy() == 1) if "isFraud" in df.columns else np.zeros(n, dtype=bool)

    def by_label(p_fraud: float, p_legit: float) -> np.ndarray:
        return np.where(f, rng.random(n) < p_fraud, rng.random(n) < p_legit).astype(int)

    df = df.copy()
    df["device_changed"] = by_label(0.58, 0.08)
    df["mobile_realname_verified"] = by_label(0.22, 0.92)
    df["geo_jump"] = by_label(0.50, 0.06)
    df["payee_risk"] = np.clip(
        np.where(f, rng.normal(0.68, 0.17, n), rng.normal(0.18, 0.14, n)), 0, 1
    )
    df["account_age_days"] = np.where(f, rng.integers(0, 45, n), rng.integers(30, 2000, n))
    df["vc_age_days"] = np.where(f, rng.integers(0, 75, n), rng.integers(20, 1000, n))
    df["cross_institution_presentations"] = np.where(f, rng.integers(3, 18, n), rng.integers(0, 7, n))
    df["tx_count_1h"] = np.where(f, rng.integers(2, 12, n), rng.integers(0, 5, n))
    df["tx_count_24h"] = np.where(f, rng.integers(10, 55, n), rng.integers(0, 15, n))
    return df


def fill_neutral_cht_signals(df: pd.DataFrame, seed: int = 42) -> pd.DataFrame:
    """在**不看標籤**的前提下補齊缺少的 CHT 欄位（真實資料的正確作法）。

    每一欄都從一個**與 `isFraud` 獨立**的分佈抽樣（或給常數預設），因此這些欄位
    對標籤的期望增益為 0。用意是讓 `FEATURE_ORDER` 維度完整、pipeline 跑得起來，
    同時讓消融實驗誠實地顯示「沒有真實 CHT 資料時，這些欄位帶不來任何增益」。

    只補 `df` 中缺少的欄位；已存在的欄位（例如資料源本來就有）一律不動。
    """
    rng = np.random.default_rng(seed)
    n = len(df)
    df = df.copy()
    neutral = {
        "device_changed": lambda: (rng.random(n) < 0.10).astype(int),
        "mobile_realname_verified": lambda: (rng.random(n) < 0.85).astype(int),
        "geo_jump": lambda: (rng.random(n) < 0.08).astype(int),
        "payee_risk": lambda: np.clip(rng.normal(0.2, 0.12, n), 0, 1),
        "account_age_days": lambda: rng.integers(0, 2000, n),
        "vc_age_days": lambda: rng.integers(0, 1000, n),
        "cross_institution_presentations": lambda: rng.integers(0, 10, n),
        "tx_count_1h": lambda: rng.integers(0, 6, n),
        "tx_count_24h": lambda: rng.integers(0, 20, n),
    }
    for col, gen in neutral.items():
        if col not in df.columns:
            df[col] = gen()
    return df
