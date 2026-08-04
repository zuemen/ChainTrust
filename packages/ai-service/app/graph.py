"""帳戶圖譜人頭環偵測（A2）。

對齊 AML 樣態：
- Fan-in 聚合戶（水房）：多來源匯入單一帳戶後集中提領（CASH_OUT）。
- 跨帳戶 velocity：單帳戶看不出、帳戶群才看得出的累積樣態。

有真 PaySim（含 nameOrig/nameDest）時建有向圖計算每帳戶 fan_in/fan_out/is_collection，
並把 payee_fan_in / account_graph_risk 併入每筆交易特徵。
合成資料（synth.py 模擬 nameOrig/nameDest 與聚合戶）也適用，離線即可訓練/示範。
缺帳戶欄位時所有圖譜特徵為 0（featurize 預設），不影響其餘特徵。
"""
from __future__ import annotations

from collections import defaultdict
from typing import Mapping

import pandas as pd

# fan-in 達此門檻且該帳戶有提領 → 視為水房聚合戶
FAN_IN_COLLECTION_MIN = 5


class AccountGraph:
    def __init__(self) -> None:
        self.fan_in: dict[str, int] = {}
        self.fan_out: dict[str, int] = {}
        self.is_collection: dict[str, int] = {}

    def risk_of(self, account: str | None) -> float:
        """單一帳戶的圖譜風險（0..1）：聚合戶權重最高，輔以 fan_in/fan_out。"""
        if account is None:
            return 0.0
        fi = self.fan_in.get(account, 0)
        fo = self.fan_out.get(account, 0)
        coll = self.is_collection.get(account, 0)
        risk = 0.5 * coll + 0.3 * min(fi, 10) / 10 + 0.2 * min(fo, 10) / 10
        return float(min(1.0, risk))


def _has_account_cols(df: pd.DataFrame) -> bool:
    return "nameOrig" in df.columns and "nameDest" in df.columns


def compute_account_graph(df: pd.DataFrame) -> AccountGraph:
    """由交易建有向圖，計算每帳戶 fan_in（相異匯入對手）/fan_out/is_collection。"""
    g = AccountGraph()
    if not _has_account_cols(df):
        return g

    in_set: dict[str, set] = defaultdict(set)
    out_set: dict[str, set] = defaultdict(set)
    cashout_accts: set[str] = set()

    types = df["type"].astype(str).str.upper().to_numpy()
    origs = df["nameOrig"].astype(str).to_numpy()
    dests = df["nameDest"].astype(str).to_numpy()
    for o, d, t in zip(origs, dests, types):
        out_set[o].add(d)
        in_set[d].add(o)
        if t == "CASH_OUT":
            cashout_accts.add(o)

    g.fan_in = {a: len(s) for a, s in in_set.items()}
    g.fan_out = {a: len(s) for a, s in out_set.items()}
    # 聚合戶：高 fan_in 後集中提領
    accounts = set(g.fan_in) | set(g.fan_out)
    g.is_collection = {
        a: 1 if (g.fan_in.get(a, 0) >= FAN_IN_COLLECTION_MIN and a in cashout_accts) else 0
        for a in accounts
    }
    return g


def apply_graph_features(df: pd.DataFrame, graph: AccountGraph) -> pd.DataFrame:
    """以「既有圖譜」把 payee_fan_in / account_graph_risk 併入每筆交易。

    重點：圖譜可只由訓練期資料建立（見 train.py），再套用到 val/test，
    避免用到未來邊造成時間洩漏（out-of-time 正確性）。
    """
    df = df.copy()
    if not _has_account_cols(df):
        df["payee_fan_in"] = 0.0
        df["account_graph_risk"] = 0.0
        return df
    df["payee_fan_in"] = df["nameDest"].astype(str).map(lambda d: float(graph.fan_in.get(d, 0)))
    df["account_graph_risk"] = df["nameOrig"].astype(str).map(graph.risk_of)
    return df


def add_graph_features(df: pd.DataFrame) -> pd.DataFrame:
    """便利函式：以自身建圖並併入特徵（單一 df 情境；訓練請用 train-only 圖譜 + apply）。"""
    return apply_graph_features(df, compute_account_graph(df))


def graph_features_for_row(row: Mapping, graph: AccountGraph | None) -> dict[str, float]:
    """/score 用：若有 graph 與帳戶名則回傳特徵，否則沿用 row 帶進來的值。

    現況（2026-08-04）：`app/main.py` **沒有**呼叫這個函式——服務端沒有常駐的帳戶圖譜，
    `payee_fan_in` / `account_graph_risk` 改由呼叫端（issuer-verifier / 錢包）自行從
    圖譜服務查得後放進 `ScoreRequest`，`featurize()` 直接讀 row（等同這裡 `graph is None` 的分支）。
    保留本函式是為了日後服務端若載入常駐圖譜時可直接接上；在那之前它不在 /score 路徑上。
    """
    if graph is None:
        return {"payee_fan_in": float(row.get("payee_fan_in", 0) or 0),
                "account_graph_risk": float(row.get("account_graph_risk", 0) or 0)}
    dest = row.get("nameDest")
    orig = row.get("nameOrig")
    return {
        "payee_fan_in": float(graph.fan_in.get(str(dest), 0)) if dest is not None else 0.0,
        "account_graph_risk": graph.risk_of(str(orig)) if orig is not None else 0.0,
    }
