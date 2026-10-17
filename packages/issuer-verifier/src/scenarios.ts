import type { TxContext } from "./fraud.js";

/**
 * 交易情境（由驗證方伺服器持有，不接受瀏覽器傳入的交易內容）。
 *
 * 為什麼放在伺服器：AI 反詐要評的是「這筆交易」，而交易內容（金額、餘額、收款方…）
 * 本來就該來自依賴方（銀行 B / 貸款平台）自己的交易系統，不是由出示憑證的人自己報。
 * 舊版由錢包把整包 tx 送上來，等於讓「會被攔截的人」自己決定要被評成什麼樣子——
 * 改成 pass 的數值就能放行（2026-08 稽核 H9）。
 *
 * PoC 沒有真的交易系統，所以用固定情境代表「依賴方查到的交易脈絡」；
 * 錢包只能選情境 ID，不能捏造數值。落地時把這裡換成依賴方交易系統的查詢即可。
 */
export const TX_SCENARIOS = {
  /** 正常小額消費：已實名、老帳戶 */
  normal: {
    type: "PAYMENT",
    amount: 1280,
    oldbalanceOrg: 52000,
    newbalanceOrig: 50720,
    mobile_realname_verified: true,
    account_age_days: 900,
    payee_risk: 0.05,
    tx_count_1h: 1,
    tx_count_24h: 4,
  },
  /** 高風險大額轉帳（疑似人頭）：轉出清空、未實名、新帳戶、裝置／地理異常 */
  mule: {
    type: "TRANSFER",
    amount: 920000,
    oldbalanceOrg: 1000000,
    newbalanceOrig: 0,
    mobile_realname_verified: false,
    tx_count_1h: 8,
    tx_count_24h: 41,
    device_changed: true,
    geo_jump: true,
    account_age_days: 2,
    payee_risk: 0.92,
    cross_institution_presentations: 13,
  },
  /** 普惠情境：微型貸款撥款（小額、已實名，AI 照常把關普惠通道不被人頭濫用） */
  microloan: {
    type: "CASH_IN",
    amount: 30000,
    oldbalanceOrg: 8000,
    newbalanceOrig: 38000,
    mobile_realname_verified: true,
    account_age_days: 540,
    payee_risk: 0.02,
    tx_count_1h: 1,
    tx_count_24h: 2,
  },
} as const satisfies Record<string, TxContext>;

export type ScenarioId = keyof typeof TX_SCENARIOS;

export function isScenarioId(v: unknown): v is ScenarioId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(TX_SCENARIOS, v);
}
