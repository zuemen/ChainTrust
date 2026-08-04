import { describe, it, expect } from "vitest";
import { MockThreatIntelAdapter } from "../src/adapters/cht.js";

describe("MockThreatIntelAdapter (P1: ThreatIntelAdapter 接進 /score)", () => {
  it("命中內建黑名單 → hit:true", async () => {
    const adapter = new MockThreatIntelAdapter();
    const result = await adapter.lookup("TWQ-DEMO-MULE-001");
    expect(result.hit).toBe(true);
    expect(result.source).toContain("CHT Security");
  });

  it("非黑名單 ID → hit:false", async () => {
    const adapter = new MockThreatIntelAdapter();
    const result = await adapter.lookup("some-normal-account-id");
    expect(result.hit).toBe(false);
  });
});
