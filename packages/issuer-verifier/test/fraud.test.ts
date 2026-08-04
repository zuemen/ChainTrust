import { describe, it, expect } from "vitest";
import { scoreTransaction } from "../src/fraud.js";
import { MockThreatIntelAdapter } from "../src/adapters/cht.js";

function mockFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response) as unknown as typeof fetch;
}

/** 跟 mockFetch 一樣回固定回應，但額外記錄每次呼叫送出的 request body，供斷言送了什麼欄位。 */
function capturingFetch(status: number, body: unknown): { fetchImpl: typeof fetch; calls: any[] } {
  const calls: any[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    calls.push(init?.body ? JSON.parse(init.body as string) : undefined);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("fraud /score 客戶端 (M2.1)", () => {
  it("回傳服務的 risk/decision/reasons", async () => {
    const r = await scoreTransaction(
      { type: "TRANSFER", amount: 920000 },
      {
        baseUrl: "http://x",
        fetchImpl: mockFetch(200, {
          risk: 88,
          decision: "block",
          reasons: ["MULE_PATTERN", "NO_REALNAME"],
          source: "model",
        }),
      }
    );
    expect(r.decision).toBe("block");
    expect(r.risk).toBe(88);
    expect(r.reasons).toContain("MULE_PATTERN");
  });

  it("服務非 2xx → review + 標記不可用", async () => {
    const r = await scoreTransaction({}, { baseUrl: "http://x", fetchImpl: mockFetch(500, {}) });
    expect(r.decision).toBe("review");
    expect(r.source).toBe("unavailable");
    expect(r.reasons[0]).toContain("FRAUD_HTTP_500");
  });

  it("連線失敗 → review + FRAUD_SERVICE_UNAVAILABLE（不擋驗證）", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await scoreTransaction({}, { baseUrl: "http://x", fetchImpl: failing });
    expect(r.decision).toBe("review");
    expect(r.reasons).toContain("FRAUD_SERVICE_UNAVAILABLE");
  });

  it("payee_account_id 命中情資黑名單 → 送往 /score 的 body 含 threat_intel_hit:true", async () => {
    const { fetchImpl, calls } = capturingFetch(200, { risk: 0, decision: "pass", reasons: [], source: "rules" });
    await scoreTransaction(
      { type: "TRANSFER", amount: 1000, payee_account_id: "TWQ-DEMO-MULE-001" },
      { baseUrl: "http://x", fetchImpl, threatIntelAdapter: new MockThreatIntelAdapter() }
    );
    expect(calls[0].threat_intel_hit).toBe(true);
  });

  it("payee_account_id 未命中 → threat_intel_hit:false", async () => {
    const { fetchImpl, calls } = capturingFetch(200, { risk: 0, decision: "pass", reasons: [], source: "rules" });
    await scoreTransaction(
      { type: "TRANSFER", amount: 1000, payee_account_id: "normal-account" },
      { baseUrl: "http://x", fetchImpl, threatIntelAdapter: new MockThreatIntelAdapter() }
    );
    expect(calls[0].threat_intel_hit).toBe(false);
  });

  it("未提供 payee_account_id → 不查詢情資，body 不含 threat_intel_hit", async () => {
    const { fetchImpl, calls } = capturingFetch(200, { risk: 0, decision: "pass", reasons: [], source: "rules" });
    await scoreTransaction(
      { type: "TRANSFER", amount: 1000 },
      { baseUrl: "http://x", fetchImpl, threatIntelAdapter: new MockThreatIntelAdapter() }
    );
    expect(calls[0].threat_intel_hit).toBeUndefined();
  });
});
