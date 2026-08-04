# ThreatIntelAdapter 接進 /score — 設計

> P1 待辦（`docs/completeness-roadmap.md` §4）：「情資命中作為特徵或 override 規則，讓『CHT Security 情資』不再只是空介面」。

## 背景

現況調查發現這個 adapter 目前**完全不存在**——`docs/poc-spec.md` 稱它 `ThreatIntelAdapter`，`docs/ai-fraud-spec.md` 稱它 `FraudIntelAdapter`，兩份文件互相矛盾，實作端（`packages/issuer-verifier/src/adapters/cht.ts`）連介面都沒有。本設計統一命名為 **`ThreatIntelAdapter`**，並補齊介面、mock 實作、與 `/score` 的實際串接。

## 架構總覽

在 TS 端（`issuer-verifier`）比照現有 `MobileCardAdapter` 的模式：`scoreTransaction()` 送出 `/score` 請求前，先查一次情資，命中結果以布林欄位併入送給 Python AI 服務的 request body。Python 端讓這個欄位變成一條新的可解釋規則，且**無論規則模式或模型模式，命中都會實際推動 risk 分數與 decision**，不只是顯示用文字。

## 資料流

```
呼叫端（server.ts /present、/score 或 verifier.ts）→ scoreTransaction(ctx)
  → ctx.payee_account_id 存在時，呼叫 ThreatIntelAdapter.lookup(id)
  → 命中則把 threat_intel_hit=true 併入送往 /score 的 body
  → POST /score（Python ai-service）
     → rules.py: reason_codes() 命中就加 "THREAT_INTEL_HIT"
     → 規則模式（無模型時）：rule_risk() 本來就會加總 WEIGHTS，自動生效，無需額外改動
     → 模型模式（目前 demo 走這條）：risk = 0.7*p_fraud + 0.3*anomaly_norm 算完後，
       若 codes 含 THREAT_INTEL_HIT，再加 35 分（封頂 100），decision 用加成後的分數重算
     → top_factors 手動補一筆 THREAT_INTEL_HIT，確保模型模式下 SHAP 沒算到的訊號也顯示出來
```

## 元件變更

### 1. `packages/issuer-verifier/src/adapters/cht.ts`（新增介面＋mock）

```ts
export interface ThreatIntelAdapter {
  /** 情資命中查詢（PoC：mock 比對小型內建黑名單） */
  lookup(entityId: string): Promise<{ hit: boolean; source: string }>;
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
```

與其他 mock adapter（如 `MockMobileCardAdapter` 永遠回固定值）不同，這裡刻意做成「查表」而非「永遠回同一值」——因為 demo 需要同時展示命中／未命中兩條路徑。落地時替換實作即可，呼叫端不變（ADR-007）。

### 2. `packages/issuer-verifier/src/fraud.ts`

- `TxContext` 新增 `payee_account_id?: string`（收款方帳戶識別碼；目前 `TxContext` 完全沒有任何收款方識別欄位，這是新概念）。
- `scoreTransaction(ctx, opts)` 新增 `opts?.threatIntelAdapter`（預設 `new MockThreatIntelAdapter()`，比照現有 `fetchImpl` 的 DI 風格，方便測試替換）。若 `ctx.payee_account_id` 存在，呼叫後把 `threat_intel_hit` 併入送給 `/score` 的 body。

### 3. `packages/ai-service/app/schemas.py`

- `ScoreRequest` 新增 `threat_intel_hit: bool = False`（註解：來自 CHT Security 情資 mock，TS 端於送出 /score 前查詢 `ThreatIntelAdapter`）。

### 4. `packages/ai-service/app/rules.py`

- `REASON_LABELS["THREAT_INTEL_HIT"] = "CHT Security 情資命中（通報詐欺/人頭帳戶）"`
- `WEIGHTS["THREAT_INTEL_HIT"] = 35`（落在 `FAN_IN_COLLECTION`=30 與 `MULE_RING`=40 之間——外部確認情資是強訊號，但不到滿分／hard override）
- `reason_codes()` 新增一行判斷：`if bool(row.get("threat_intel_hit", False)): codes.append("THREAT_INTEL_HIT")`

### 5. `packages/ai-service/app/model.py`

- `score()` 的 model 分支，`codes = reason_codes(row)`（含 `MODEL_ANOMALY` 補注邏輯）之後、組 `ScoreResponse` 之前，插入：
  - 若 `"THREAT_INTEL_HIT" in codes`：`risk = max(0, min(100, risk + WEIGHTS["THREAT_INTEL_HIT"]))`
  - 同步把 `THREAT_INTEL_HIT` 手動塞進 `top`（`TopFactor(feature="THREAT_INTEL_HIT", label=REASON_LABELS[...], impact=float(WEIGHTS[...]))`）列表最前面，裁到前 3。
- `confidence`（`prob_confidence`）維持只反映模型對原始交易的把握度，不因情資覆蓋而改變——刻意設計：情資命中視為獨立佐證訊號疊加在模型判斷之上，不修改模型本身對原始特徵的確定性。

## 錯誤處理

`ThreatIntelAdapter.lookup()` 目前是 mock，不會丟例外。比照 `scoreTransaction()` 現有「服務不可用不擋流程」精神，程式碼註解會標明：落地接真實 API 時，查詢失敗應視為 `hit:false`（fail-open，不阻斷驗證流程，只是拿不到加分），這次 mock 階段不需要額外 try/catch。

## 測試

- **ai-service（pytest）**：`demo_data.json` 新增情境 `threat_intel_hit_known_mule`（`threat_intel_hit: true`，其餘欄位偏中性，驗證單靠情資命中就能把 decision 推到 block/review）；`test_score.py` 新增測試檢查 `reasons` 含 `THREAT_INTEL_HIT`，且加分後 risk 確實比不含情資命中時高。
- **issuer-verifier（vitest）**：`MockThreatIntelAdapter` 命中／未命中各一則單元測試；`scoreTransaction()` 用 `fetchImpl` 攔截，驗證 `payee_account_id` 命中黑名單時，送往 `/score` 的 body 確實含 `threat_intel_hit:true`；未命中或未提供 `payee_account_id` 時不含該欄位或為 `false`。

## 文件同步

- `docs/poc-spec.md`、`docs/ai-fraud-spec.md` 統一命名為 `ThreatIntelAdapter`（目前兩份文件用字不一致）。
- `docs/completeness-roadmap.md` P1 該項目打勾，執行日誌加一行。

## 範圍外（明確不做）

- 不做嚴重度分級／多級 override（已與使用者確認，MVP 只要單一加權規則）。
- 不把 `threat_intel_hit` 加進 `FEATURE_ORDER`／重新訓練模型（會牽動既有「保留 hard-mode 模型」決策，且需要重新產生訓練資料，超出本次範圍）。
- 不新增 ADR——本次變更屬於 ADR-007（CHT 整合點一律 adapter + mock）既有範圍內的具體實作，不是新的重量級相依。
