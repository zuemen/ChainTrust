import { describe, it, expect } from "vitest";
import { scoreTransaction, fetchMetrics, warmUpFraudService } from "../src/fraud.js";
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

/**
 * 冷啟動回歸測試。
 *
 * 免費方案的 PaaS 閒置會休眠，冷啟動實測約 33–50 秒。舊版把逾時寫死 5 秒，
 * 每次請求都在容器開機完成前就 abort —— 服務一旦睡著就再也醒不過來，
 * 反詐功能會永久停在「不可用」。以下釘住三件事：逾時可調、逾時原因可辨識、
 * 有一條專門的長逾時暖機路徑。
 */
describe("AI 服務冷啟動韌性", () => {
  /** 模擬「回應比逾時慢」的服務。 */
  function slowFetch(delayMs: number): typeof fetch {
    return ((_url: string, init?: RequestInit) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(
          () => resolve({ ok: true, status: 200, json: async () => ({ available: true }) } as Response),
          delayMs
        );
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;
  }

  it("逾時可由呼叫端調長：慢回應在短逾時下失敗、長逾時下成功", async () => {
    const short = await fetchMetrics({ baseUrl: "http://x", timeoutMs: 20, fetchImpl: slowFetch(120) });
    expect(short.available).toBe(false);

    const long = await fetchMetrics({ baseUrl: "http://x", timeoutMs: 400, fetchImpl: slowFetch(120) });
    expect(long.available).toBe(true);
  });

  it("不可用時回報原因，區分逾時與連不上（部署排查用）", async () => {
    const timedOut = await fetchMetrics({ baseUrl: "http://x", timeoutMs: 20, fetchImpl: slowFetch(120) });
    expect(timedOut.reason).toBe("timeout");

    const dead = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect((await fetchMetrics({ baseUrl: "http://x", fetchImpl: dead })).reason).toBe("unreachable");

    expect((await fetchMetrics({ baseUrl: "http://x", fetchImpl: mockFetch(502, {}) })).reason).toBe("http_502");
  });

  it("暖機成功回 true、失敗回 false 且不拋錯（純盡力而為）", async () => {
    expect(await warmUpFraudService({ baseUrl: "http://x", fetchImpl: mockFetch(200, {}) })).toBe(true);

    const dead = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await warmUpFraudService({ baseUrl: "http://x", fetchImpl: dead })).toBe(false);
  });
});
