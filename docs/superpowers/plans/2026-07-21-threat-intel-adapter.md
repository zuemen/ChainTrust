# ThreatIntelAdapter 接進 /score Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 `ThreatIntelAdapter`（CHT Security 情資 mock）從純文件概念變成實際接進 `/score` 評分流程的加權規則，命中時無論規則模式或模型模式都會實際推動 risk 分數與 decision。

**Architecture:** TS 端（`issuer-verifier`）在 `scoreTransaction()` 送出 `/score` 前，查一次 mock 情資，命中結果以 `threat_intel_hit: boolean` 併入 request body；Python 端（`ai-service`）把它變成新的 reason code + 固定權重（35 分），在規則模式下經由既有 `rule_risk()` 加總自動生效，在模型模式（目前 demo 走這條）下於 `score()` 內明確做後處理加成。

**Tech Stack:** TypeScript（issuer-verifier，vitest）、Python/FastAPI（ai-service，pytest）。不新增任何套件相依。

## Global Constraints

- 只用既有 mock 模式（ADR-007：CHT 整合點一律 adapter + mock），落地時只換實作、不動呼叫端。
- 不新增任何 npm/pip 套件相依，不需要新 ADR（本次變更屬於 ADR-007 既有範圍）。
- `WEIGHTS["THREAT_INTEL_HIT"] = 35`（固定值，不做嚴重度分級——已與使用者確認過 MVP 範圍）。
- 不把 `threat_intel_hit` 加進 `FEATURE_ORDER` 或重新訓練模型（會動到既有「保留 hard-mode 模型」決策，超出本次範圍）。
- TypeScript `strict` 開；不吞錯誤。程式碼識別字英文，註解可中文。
- Commit 用 Conventional Commits（`feat:`/`test:`/`docs:`）。每個套件改完先跑該套件 test 再 commit。
- 每個 public/external 函式都要有對應測試。
- ai-service 測試指令：`.venv\Scripts\python -m pytest -q`（於 `packages/ai-service` 目錄下執行，或用根目錄 `pnpm test:ai`）。
- issuer-verifier 測試指令：根目錄 `pnpm iv:test`（等同 `pnpm --filter @chaintrust/issuer-verifier test`，實際跑 `vitest run`）。

---

### Task 1: rules.py — THREAT_INTEL_HIT reason code + 權重

**Files:**
- Modify: `packages/ai-service/app/rules.py`
- Test: `packages/ai-service/tests/test_score.py`

**Interfaces:**
- Produces: `rules.REASON_LABELS["THREAT_INTEL_HIT"]: str`、`rules.WEIGHTS["THREAT_INTEL_HIT"]: int = 35`、`reason_codes(row)` 在 `row.get("threat_intel_hit")` 為真值時回傳的 list 含 `"THREAT_INTEL_HIT"`。Task 2 的 model.py 後處理會讀 `WEIGHTS["THREAT_INTEL_HIT"]`。

- [ ] **Step 1: 寫失敗測試**

在 `packages/ai-service/tests/test_score.py` 檔尾（`test_graph_apply_train_only_no_future_edges` 之後）新增：

```python
# ── P1：ThreatIntelAdapter 情資命中規則 ──
def test_threat_intel_hit_rule_and_weight():
    """情資命中：reason_codes 應含 THREAT_INTEL_HIT，rule_risk 應加總其權重（規則 baseline 自動生效）。"""
    from app.rules import reason_codes, rule_risk, WEIGHTS

    assert reason_codes({"threat_intel_hit": False}) == []
    assert "THREAT_INTEL_HIT" in reason_codes({"threat_intel_hit": True})

    risk, codes = rule_risk({"threat_intel_hit": True})
    assert risk == WEIGHTS["THREAT_INTEL_HIT"] == 35
    assert codes == ["THREAT_INTEL_HIT"]
```

- [ ] **Step 2: 執行測試確認失敗**

Run（於 `packages/ai-service` 目錄）: `.venv\Scripts\python -m pytest -q tests/test_score.py::test_threat_intel_hit_rule_and_weight -v`
Expected: FAIL — `assert "THREAT_INTEL_HIT" in reason_codes(...)` 失敗（回傳空 list，因為 `rules.py` 還不認得這個欄位）。

- [ ] **Step 3: 實作最小改動**

在 `packages/ai-service/app/rules.py` 的 `REASON_LABELS` dict（第 12-27 行）加一行，放在 `"MODEL_ANOMALY"` 之前或之後皆可，維持字典順序即可：

```python
    "CROSS_INST_REUSE": "跨機構頻繁出示",
    "THREAT_INTEL_HIT": "CHT Security 情資命中（通報詐欺/人頭帳戶）",
    "MODEL_ANOMALY": "模型偵測到異常樣態",
```

在 `WEIGHTS` dict（第 30-45 行）加一行，放在 `FAN_IN_COLLECTION`(30) 與 `MULE_RING`(40) 之間附近皆可（只要數值對即可，字典順序不影響邏輯）：

```python
    "FAN_IN_COLLECTION": 30,
    "THREAT_INTEL_HIT": 35,
    "PASS_THROUGH": 30,
```

在 `reason_codes()` 函式（第 48-97 行）的 `return codes` 之前加一段，放在 `CROSS_INST_REUSE` 判斷之後：

```python
    if float(row.get("cross_institution_presentations", 0) or 0) >= 8:
        codes.append("CROSS_INST_REUSE")
    if bool(row.get("threat_intel_hit", False)):
        codes.append("THREAT_INTEL_HIT")
    return codes
```

- [ ] **Step 4: 執行測試確認通過**

Run: `.venv\Scripts\python -m pytest -q tests/test_score.py::test_threat_intel_hit_rule_and_weight -v`
Expected: PASS

再跑一次全部既有測試，確認沒有回歸：
Run: `.venv\Scripts\python -m pytest -q`
Expected: 全部 PASS（含既有的 `test_rules_baseline_deterministic` 等）

- [ ] **Step 5: Commit**

```bash
git add packages/ai-service/app/rules.py packages/ai-service/tests/test_score.py
git commit -m "feat(ai-service): add THREAT_INTEL_HIT reason code + weight"
```

---

### Task 2: schemas.py + model.py — 情資命中的分數加成（模型模式後處理）

**Files:**
- Modify: `packages/ai-service/app/schemas.py`
- Modify: `packages/ai-service/app/model.py`
- Modify: `packages/ai-service/demo_data.json`
- Test: `packages/ai-service/tests/test_score.py`

**Interfaces:**
- Consumes: `rules.WEIGHTS["THREAT_INTEL_HIT"]`、`rules.REASON_LABELS["THREAT_INTEL_HIT"]`（Task 1 已加好）；`schemas.TopFactor(feature, label, impact)`（已存在）。
- Produces: `ScoreRequest.threat_intel_hit: bool = False`（Task 4 的 TS 端會送這個欄位名）。`/score` 回應在命中時 `risk` 會比未命中多 35（封頂 100），`reasons` 含 `"THREAT_INTEL_HIT"`，`top_factors[0].feature == "THREAT_INTEL_HIT"`。

- [ ] **Step 1: 在 demo_data.json 新增情境樣本**

在 `packages/ai-service/demo_data.json`，於現有最後一筆樣本 `fan_in_collection`（第 106-116 行）之後、`]` 之前，插入一筆新樣本（記得在 `fan_in_collection` 那筆的結尾 `}` 後加逗號）：

```json
    {
      "label": "threat_intel_hit_known_mule",
      "expect": "block",
      "comment": "CHT Security 情資命中：交易本身只到 review 等級（NO_REALNAME+DEVICE_CHANGE+GEO_JUMP=45），情資確認後加成 35 分升級為 block",
      "ctx": {
        "type": "TRANSFER", "amount": 15000, "oldbalanceOrg": 40000, "newbalanceOrig": 25000,
        "oldbalanceDest": 5000, "newbalanceDest": 20000, "tx_count_1h": 3, "tx_count_24h": 8,
        "device_changed": true, "mobile_realname_verified": false, "vc_age_days": 30,
        "account_age_days": 20, "cross_institution_presentations": 3, "payee_risk": 0.4, "geo_jump": true,
        "threat_intel_hit": true
      }
    }
```

這筆樣本已用目前 repo 裡已訓練好的 `model.joblib` 實測過（見下方 Step 2 的預期數字）：不含 `threat_intel_hit` 時 model 模式下 risk=45（review，reasons 含 `NO_REALNAME`/`DEVICE_CHANGE`/`GEO_JUMP`），是本次改動前的現況。

- [ ] **Step 2: 寫失敗測試**

在 `packages/ai-service/tests/test_score.py` 檔尾新增：

```python
def test_threat_intel_hit_boosts_risk_and_reason():
    """情資命中：模型模式下應把 review 等級交易升級為 block，且加分獨立於模型判斷之外（可與 rules.WEIGHTS 對上）。"""
    from app.rules import WEIGHTS

    hit_ctx = next(s for s in _samples() if s["label"] == "threat_intel_hit_known_mule")["ctx"]
    base_ctx = {k: v for k, v in hit_ctx.items() if k != "threat_intel_hit"}

    base = client.post("/score", json=base_ctx).json()
    hit = client.post("/score", json=hit_ctx).json()

    assert base["decision"] == "review"
    assert "THREAT_INTEL_HIT" not in base["reasons"]

    assert hit["decision"] == "block"
    assert "THREAT_INTEL_HIT" in hit["reasons"]
    assert hit["risk"] == base["risk"] + WEIGHTS["THREAT_INTEL_HIT"]
    assert hit["top_factors"][0]["feature"] == "THREAT_INTEL_HIT"
```

- [ ] **Step 3: 執行測試確認失敗**

Run: `.venv\Scripts\python -m pytest -q tests/test_score.py::test_threat_intel_hit_boosts_risk_and_reason -v`
Expected: FAIL — `hit["decision"]` 會是 `"review"` 而非 `"block"`（因為 `ScoreRequest` 目前用 `extra: "ignore"` 會直接丟掉 `threat_intel_hit` 欄位，`model.py` 也還沒讀它）。

同時跑一次既有的 `test_demo_samples_pass_and_block`，確認它現在也會因為新樣本而失敗（新樣本的 `expect: "block"` 對不上目前實際回傳的 `"review"`）：
Run: `.venv\Scripts\python -m pytest -q tests/test_score.py::test_demo_samples_pass_and_block -v`
Expected: FAIL

- [ ] **Step 4: 實作最小改動**

在 `packages/ai-service/app/schemas.py` 的 `ScoreRequest`（第 27-34 行「ChainTrust 增益訊號」區塊）加一行，放在 `payee_risk` 之後：

```python
    payee_risk: float = 0.0  # 0..1
    threat_intel_hit: bool = False  # 來自 CHT Security 情資 mock（TS 端於送出 /score 前查詢 ThreatIntelAdapter）
    geo_jump: bool = False
```

在 `packages/ai-service/app/model.py` 的 `score()` 函式（model 分支），把第 138-146 行：

```python
    # reason codes：規則映射（可解釋）；模型判高風險但規則無觸發時補 MODEL_ANOMALY
    codes = reason_codes(row)
    if not codes and risk >= PASS_MAX:
        codes = ["MODEL_ANOMALY"]

    # top_factors：優先用模型 SHAP 貢獻；取不到則退回規則權重
    top = _top_factors_from_model(bundle, x)
    if not top:
        top = _top_factors_from_rules(codes)
```

改為：

```python
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
```

（`WEIGHTS`、`REASON_LABELS`、`TopFactor` 在 `model.py` 頂部已經匯入，不需要新增 import。）

- [ ] **Step 5: 執行測試確認通過**

Run: `.venv\Scripts\python -m pytest -q tests/test_score.py::test_threat_intel_hit_boosts_risk_and_reason tests/test_score.py::test_demo_samples_pass_and_block -v`
Expected: 兩個測試都 PASS

再跑一次全部測試確認沒有回歸：
Run: `.venv\Scripts\python -m pytest -q`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add packages/ai-service/app/schemas.py packages/ai-service/app/model.py packages/ai-service/demo_data.json packages/ai-service/tests/test_score.py
git commit -m "feat(ai-service): wire threat_intel_hit into /score risk scoring"
```

---

### Task 3: TS ThreatIntelAdapter 介面 + Mock 實作

**Files:**
- Modify: `packages/issuer-verifier/src/adapters/cht.ts`
- Test: `packages/issuer-verifier/test/adapters.test.ts`（新檔）

**Interfaces:**
- Produces: `interface ThreatIntelAdapter { lookup(entityId: string): Promise<{ hit: boolean; source: string }> }`、`class MockThreatIntelAdapter implements ThreatIntelAdapter`。Task 4 的 `fraud.ts` 會 `import { ThreatIntelAdapter, MockThreatIntelAdapter } from "./adapters/cht.js"`。

- [ ] **Step 1: 寫失敗測試**

新增 `packages/issuer-verifier/test/adapters.test.ts`：

```ts
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
```

- [ ] **Step 2: 執行測試確認失敗**

Run（於 `packages/issuer-verifier` 目錄）: `pnpm test -- test/adapters.test.ts`
Expected: FAIL — `MockThreatIntelAdapter` 不存在，TypeScript 編譯/import 錯誤。

- [ ] **Step 3: 實作最小改動**

在 `packages/issuer-verifier/src/adapters/cht.ts`，於 `BillingHistoryAdapter` interface（第 33-40 行）之後、`MockPublicCaAdapter` class（第 42 行）之前，插入新 interface：

```ts
export interface ThreatIntelAdapter {
  /** 情資命中查詢（PoC：mock 比對小型內建黑名單；落地：CHT Security 情資 API） */
  lookup(entityId: string): Promise<{ hit: boolean; source: string }>;
}
```

於檔案最後（`MockMobileCardAdapter` class 之後）新增 mock 實作：

```ts
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
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm test -- test/adapters.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/issuer-verifier/src/adapters/cht.ts packages/issuer-verifier/test/adapters.test.ts
git commit -m "feat(issuer-verifier): add ThreatIntelAdapter interface + mock impl"
```

---

### Task 4: fraud.ts — scoreTransaction() 接上 ThreatIntelAdapter

**Files:**
- Modify: `packages/issuer-verifier/src/fraud.ts`
- Test: `packages/issuer-verifier/test/fraud.test.ts`

**Interfaces:**
- Consumes: `ThreatIntelAdapter`、`MockThreatIntelAdapter`（Task 3 已產出，從 `./adapters/cht.js` import）。
- Produces: `TxContext.payee_account_id?: string`；`scoreTransaction(ctx, opts)` 的 `opts` 新增可選 `threatIntelAdapter?: ThreatIntelAdapter`；命中時送往 `/score` 的 POST body 會多一個 `threat_intel_hit: true` 欄位。這是本 P1 子任務的最後一棒，之後不再有下游任務依賴這裡的產出。

- [ ] **Step 1: 寫失敗測試**

在 `packages/issuer-verifier/test/fraud.test.ts`，先把 `mockFetch` 旁邊加一個能記錄送出 body 的輔助函式，並新增測試案例。把整個檔案內容改成：

```ts
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
```

- [ ] **Step 2: 執行測試確認失敗**

Run（於 `packages/issuer-verifier` 目錄）: `pnpm test -- test/fraud.test.ts`
Expected: FAIL — TypeScript 編譯錯誤（`TxContext` 沒有 `payee_account_id`、`scoreTransaction` 的 `opts` 沒有 `threatIntelAdapter`），新增的三個測試案例失敗。

- [ ] **Step 3: 實作最小改動**

在 `packages/issuer-verifier/src/fraud.ts` 檔首加入 import（放在既有 `import { config } from "./config.js";` 之後）：

```ts
import { config } from "./config.js";
import { MockThreatIntelAdapter, type ThreatIntelAdapter } from "./adapters/cht.js";
```

`TxContext` interface（第 4-20 行）加一個欄位，放在 `payee_risk` 之後：

```ts
  payee_risk?: number;
  payee_account_id?: string;
  geo_jump?: boolean;
```

`scoreTransaction()` 函式簽名與內容（第 44-74 行）改為：

```ts
export async function scoreTransaction(
  ctx: TxContext,
  opts?: {
    baseUrl?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    threatIntelAdapter?: ThreatIntelAdapter;
  }
): Promise<RiskAssessment> {
  const baseUrl = opts?.baseUrl ?? config.aiServiceUrl;
  const doFetch = opts?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 5000);
  try {
    let body: TxContext & { threat_intel_hit?: boolean } = ctx;
    if (ctx.payee_account_id) {
      const adapter = opts?.threatIntelAdapter ?? new MockThreatIntelAdapter();
      const intel = await adapter.lookup(ctx.payee_account_id);
      body = { ...ctx, threat_intel_hit: intel.hit };
    }
    const res = await doFetch(`${baseUrl}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { risk: null, decision: "review", reasons: [`FRAUD_HTTP_${res.status}`], source: "unavailable" };
    }
    const responseBody = (await res.json()) as RiskAssessment;
    return responseBody;
  } catch (e: any) {
    return {
      risk: null,
      decision: "review",
      reasons: ["FRAUD_SERVICE_UNAVAILABLE"],
      source: "unavailable",
    };
  } finally {
    clearTimeout(timer);
  }
}
```

（注意：原本的區域變數 `body` 名稱跟 fetch 回應解析用的變數衝突，上面已把回應那個改名為 `responseBody`，避免遮蔽。）

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm test -- test/fraud.test.ts`
Expected: PASS（全部 6 個測試案例）

再跑整個套件的測試確認沒有回歸：
Run（於根目錄）: `pnpm iv:test`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/issuer-verifier/src/fraud.ts packages/issuer-verifier/test/fraud.test.ts
git commit -m "feat(issuer-verifier): wire ThreatIntelAdapter into scoreTransaction"
```

---

### Task 5: 文件同步（命名統一 + roadmap 打勾）

**Files:**
- Modify: `docs/poc-spec.md`
- Modify: `docs/ai-fraud-spec.md`
- Modify: `docs/completeness-roadmap.md`

**Interfaces:** 無程式碼介面，純文件。

- [ ] **Step 1: 統一命名（poc-spec.md 已經是對的，不用改；改 ai-fraud-spec.md）**

`docs/ai-fraud-spec.md` 第 61 行，把：

```
`FraudIntelAdapter`：PoC 用合成黑名單；落地接中華電信 CHT Security 情資。
```

改為：

```
`ThreatIntelAdapter`：PoC mock 比對小型內建黑名單，已接進 `/score`（命中 +35 分，見 `packages/ai-service/app/rules.py` 的 `THREAT_INTEL_HIT`）；落地接中華電信 CHT Security 情資。
```

- [ ] **Step 2: roadmap 缺口敘述與對應表更新**

`docs/completeness-roadmap.md` 第 36 行，把：

```
2. **跨機構情資只有一句話**：`ThreatIntelAdapter` 有介面但未接進 `/score` 評分流程；「聯邦學習護城河」只出現在簡報論點，零程式碼。
```

改為：

```
2. **跨機構情資已接進 `/score`**（2026-07-21，見 §5 執行日誌）；「聯邦學習護城河」仍只出現在簡報論點，零程式碼。
```

第 126 行，把：

```
- [ ] **`ThreatIntelAdapter` 接進 `/score`**：情資命中作為特徵或 override 規則，讓「CHT Security 情資」不再只是空介面。
```

改為：

```
- [x] **`ThreatIntelAdapter` 接進 `/score`**：情資命中作為加權規則（+35 分），模型模式下由 `model.py` 後處理加成、規則模式下由 `rule_risk()` 自動加總。（2026-07-21）
```

- [ ] **Step 3: 執行日誌加一行**

在 `docs/completeness-roadmap.md` 的「## 5. 執行日誌」表格（第 145 行之後的表格，最後一行是 P0-6 那行）新增一行：

```
| 2026-07-21 | P1（ThreatIntelAdapter） | 情資命中接進 `/score`：新增 TS `ThreatIntelAdapter`/`MockThreatIntelAdapter`（`packages/issuer-verifier/src/adapters/cht.ts`），`scoreTransaction()` 依 `payee_account_id` 查詢後把 `threat_intel_hit` 併入請求；Python 端新增 `THREAT_INTEL_HIT` reason code（權重 35），規則模式自動加總、模型模式於 `model.py` 後處理加成，兩端測試全綠。設計文件見 `docs/superpowers/specs/2026-07-21-threat-intel-adapter-design.md`。 |
```

- [ ] **Step 4: 檢查沒有遺漏的舊命名**

Run（於根目錄）: `grep -rn "FraudIntelAdapter" docs/`
Expected: 沒有任何輸出（全部統一成 `ThreatIntelAdapter`）。

- [ ] **Step 5: Commit**

```bash
git add docs/poc-spec.md docs/ai-fraud-spec.md docs/completeness-roadmap.md
git commit -m "docs(roadmap): ThreatIntelAdapter 接進 /score 完成，統一命名並打勾 P1"
```

---

### Task 6: 全套驗證 + push

**Files:** 無新變更，純驗證與收尾。

- [ ] **Step 1: 跑 ai-service 全部測試**

Run（於根目錄）: `pnpm test:ai`
Expected: 全部 PASS

- [ ] **Step 2: 跑 issuer-verifier 全部測試**

Run（於根目錄）: `pnpm iv:test`
Expected: 全部 PASS

- [ ] **Step 3: issuer-verifier 型別檢查/build**

Run（於根目錄）: `pnpm iv:build`
Expected: 成功（無 TypeScript 型別錯誤，確認 `TxContext`/`scoreTransaction` 的型別改動沒有破壞既有呼叫端如 `server.ts`、`verifier.ts`——它們用可選欄位/可選 opts，理論上向後相容，但仍要跑 build 確認）。

- [ ] **Step 4: 確認 git 狀態乾淨、push**

Run: `git status`
Expected: `nothing to commit, working tree clean`

Run: `git push origin we1n`
Expected: push 成功
