"""API 契約：ScoreRequest / ScoreResponse（勿改既有欄位名，呼叫端依賴）。"""
from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field

TxType = Literal["CASH_IN", "CASH_OUT", "DEBIT", "PAYMENT", "TRANSFER"]
Decision = Literal["pass", "review", "block"]


# 金額/餘額上界：模擬幣單位下的荒謬值直接擋掉（同時排除 inf/NaN 溢位造成的 500）
_MONEY_MAX = 1e15
# 計數類上界：velocity / 出示次數 / 天數等
_COUNT_MAX = 1_000_000


class ScoreRequest(BaseModel):
    """交易／出示情境。金額與餘額用模擬幣單位；增益訊號多來自 CHT mock。

    所有數值欄位都有界限驗證（H15）：負數金額會在 pydantic 層被擋成 422，
    而不是在 `featurize()` 的 `math.log1p()` 炸成 500。
    """

    amount: float = Field(default=0.0, ge=0, le=_MONEY_MAX)
    type: TxType = "PAYMENT"

    # 帳戶餘額（PaySim 原生）
    oldbalanceOrg: float = Field(default=0.0, ge=0, le=_MONEY_MAX)
    newbalanceOrig: float = Field(default=0.0, ge=0, le=_MONEY_MAX)
    oldbalanceDest: float = Field(default=0.0, ge=0, le=_MONEY_MAX)
    newbalanceDest: float = Field(default=0.0, ge=0, le=_MONEY_MAX)

    # 速度（velocity）
    tx_count_1h: int = Field(default=0, ge=0, le=_COUNT_MAX)
    tx_count_24h: int = Field(default=0, ge=0, le=_COUNT_MAX)

    # ChainTrust 增益訊號
    device_changed: bool = False
    mobile_realname_verified: bool = True  # 來自 CHT 門號電子卡 mock（強訊號）
    vc_age_days: int = Field(default=365, ge=0, le=_COUNT_MAX)
    cross_institution_presentations: int = Field(default=0, ge=0, le=_COUNT_MAX)
    payee_risk: float = Field(default=0.0, ge=0, le=1)  # 0..1
    threat_intel_hit: bool = False  # 來自 CHT Security 情資 mock（TS 端於送出 /score 前查詢 ThreatIntelAdapter）
    geo_jump: bool = False
    account_age_days: int = Field(default=365, ge=0, le=_COUNT_MAX)

    # ── A2：帳戶圖譜訊號（H14）──
    # 這兩欄在 FEATURE_ORDER 內、模型訓練時有用到；先前 schema 沒宣告 + extra="ignore"，
    # 導致呼叫端帶了也被丟棄、服務端恆為 0（train/serve 偏移），
    # 且 rules.py 的 FAN_IN_COLLECTION / MULE_RING reason code 經 API 永不觸發。
    # 由呼叫端（issuer-verifier / 錢包）從圖譜服務查得後帶入；未帶則維持 0（無圖譜訊號）。
    payee_fan_in: int = Field(
        default=0, ge=0, le=_COUNT_MAX, description="收款方相異匯入來源數（fan-in）"
    )
    account_graph_risk: float = Field(
        default=0.0, ge=0, le=1, description="轉出帳戶的圖譜風險 0..1（人頭環/聚合戶）"
    )

    model_config = {"extra": "ignore"}


class TopFactor(BaseModel):
    """單一可解釋因素：feature 識別字、中文標籤、推升風險的貢獻值。"""
    feature: str
    label: str
    impact: float


class ScoreResponse(BaseModel):
    risk: int = Field(ge=0, le=100, description="0-100 風險分數")
    decision: Decision
    reasons: list[str] = Field(default_factory=list)
    source: Literal["model", "rules"] = "rules"
    p_fraud: float | None = None
    anomaly: float | None = None
    # 本筆判斷的信心 0-1（模型模式＝二分類確定度；規則模式＝距決策門檻的裕度）
    confidence: float | None = None
    # 信心等級（high/medium/low），供前端/agent 直接呈現「高信心攔截」等用語
    confidence_band: Literal["high", "medium", "low"] | None = None
    # 可解釋：本筆判斷的前幾大推升因素
    top_factors: list[TopFactor] = Field(default_factory=list)
