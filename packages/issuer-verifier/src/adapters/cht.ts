/**
 * 中華電信整合點 — adapter + mock（ADR-007）。
 * 正式落地時以對應 CHT 產品替換實作，呼叫端不變。
 *
 * 各 adapter 對應的真實 CHT 產品、來源與落地待確認事項，見
 * `docs/completeness-roadmap.md` §3.1「Mock → 真實產品對應表」（2026-07-21 調研）。
 */

export interface PublicCaAdapter {
  /**
   * 由 CHT PublicCA 根背書某 Issuer（PoC：mock 直接回傳已背書）。
   * 目標產品：中華電信通用憑證管理中心／HiPKI（`publicca.hinet.net`）。
   * 預期 API 形態：憑證簽發／背書 REST API，輸入待背書之 Issuer 位址或憑證請求，
   * 輸出憑證鏈／根授權識別。落地前需確認 HiPKI／ePKI 根憑證信任事件（見 roadmap）
   * 是否影響此處「Issuer 根背書」用途。
   */
  anchorIssuerRoot(issuerAddress: string): Promise<{ anchored: boolean; rootAuthority: string }>;
}

export interface MobileCardAdapter {
  /**
   * 門號電子卡驗證（PoC：mock 回傳固定已驗證身分）。
   * 目標產品：「MID+（MID Plus）」行動身分認證服務 ＋ GSMA Open Gateway
   * Number Verification／Know Your Customer Match API。
   * 預期 API 形態：以門號＋（選填）姓名/證號輸入，回傳門號驗證結果與身分比對結果；
   * 落地需確認是否僅限 CHT 門號或可跨電信查詢、呼叫時延是否符合即時攔截需求。
   */
  verifyMsisdn(msisdn: string): Promise<{
    verified: boolean;
    carrier: string;
    realName: string;
    msisdnMasked: string;
  }>;
}

export interface BillingSummary {
  /** 門號在網月數 */
  tenureMonths: number;
  /** 近 24 期準時繳費比例 0..1 */
  onTimeRatio: number;
  /** 近 12 個月逾繳次數 */
  latePayments12m: number;
  /** 月均帳單金額區間（避免揭露精確消費額） */
  avgMonthlyBillBand: string;
  carrier: string;
}

export interface BillingHistoryAdapter {
  /**
   * 電信繳費紀錄摘要（普惠金融：替代信用資料）。
   * PoC：mock 回傳多年準時繳費的 thin-file 使用者。
   * 目標產品：`tenureMonths` 部分對應 GSMA Open Gateway 的 Know Your Customer
   * Tenure（用戶合約在網時長）API；`onTimeRatio`/`avgMonthlyBillBand` 等帳務明細
   * 目前查無對應公開 API，需洽 CHT 帳務系統／業務窗口，且須當事人同意（個資法）、
   * 僅輸出摘要不輸出明細。
   */
  getBillingSummary(msisdn: string): Promise<BillingSummary>;
}

export interface ThreatIntelAdapter {
  /**
   * 情資命中查詢（PoC：mock 比對小型內建黑名單）。
   * 目標產品：GSMA Open Gateway 防詐 API（SIM Swap／Scam Signal／Call Forwarding
   * Signal／Device ID）＋ 子公司中華資安國際 CHT Security（`chtsecurity.com`）
   * 威脅情資／曝險評級服務（HorusEyes）。
   * 預期 API 形態：以門號或帳戶識別碼查詢，回傳風險旗標／情資命中類別；落地需
   * 確認能否單筆交易同步查詢、是否開放第三方交易風控用途（目前查到的多是企業
   * 自身資安監控情境）。
   */
  lookup(entityId: string): Promise<{ hit: boolean; source: string }>;
}

export class MockPublicCaAdapter implements PublicCaAdapter {
  async anchorIssuerRoot(issuerAddress: string) {
    return { anchored: true, rootAuthority: "CHT-PublicCA (mock)", ...{ issuerAddress } };
  }
}

export class MockBillingHistoryAdapter implements BillingHistoryAdapter {
  async getBillingSummary(_msisdn: string): Promise<BillingSummary> {
    // 典型普惠對象：無聯徵信用紀錄（學生/新住民/自由工作者），但有多年電信準時繳費史
    return {
      tenureMonths: 78,
      onTimeRatio: 0.98,
      latePayments12m: 0,
      avgMonthlyBillBand: "NT$1,000–1,999",
      carrier: "中華電信 (mock)",
    };
  }
}

export class MockMobileCardAdapter implements MobileCardAdapter {
  async verifyMsisdn(msisdn: string) {
    const masked = msisdn.replace(/(\d{4})\d{3}(\d{3})/, "$1***$2");
    return {
      verified: true,
      carrier: "中華電信 (mock)",
      realName: "王小明",
      msisdnMasked: masked || "0912***678",
    };
  }
}

export class MockThreatIntelAdapter implements ThreatIntelAdapter {
  private static readonly BLOCKLIST = new Set([
    "TWQ-DEMO-MULE-001",
    "TWQ-DEMO-MULE-002",
  ]);

  async lookup(entityId: string) {
    return {
      hit: MockThreatIntelAdapter.BLOCKLIST.has(entityId),
      source: "CHT Security 情資 (mock)",
    };
  }
}
