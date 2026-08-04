/**
 * HTTP 層測試 —— server.ts 先前零覆蓋，而 API key 守門、nonce 一次性、
 * 驗證政策強制這三道防線全都住在這一層，只測函式層會完全看不到它們被繞過。
 *
 * 重點釘住的攻擊情境：
 *   - 未帶 X-API-Key 不得簽發憑證（fail-closed，未設 API_KEY 時回 503 而非放行）
 *   - 不帶 nonce / 帶偽造 nonce 的出示一律 reject（修復前這樣就能跳過 KB 與防重放）
 *   - 同一個 nonce 不得使用兩次，驗證失敗的 nonce 也要被消耗
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const ORIGINAL_API_KEY = process.env.API_KEY;
const TEST_KEY = "test-api-key-abc123";

let app: Express;

beforeAll(async () => {
  process.env.API_KEY = TEST_KEY;
  process.env.CHAIN_MODE = "memory";
  // config 在 import 時就固定，因此必須先設環境變數再動態載入
  const { createApp } = await import("../src/server.js");
  ({ app } = await createApp());
});

afterAll(() => {
  if (ORIGINAL_API_KEY === undefined) delete process.env.API_KEY;
  else process.env.API_KEY = ORIGINAL_API_KEY;
});

describe("API key 守門", () => {
  it("/health 公開可讀", async () => {
    const r = await request(app).get("/health");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it("/info 未帶金鑰回 401", async () => {
    const r = await request(app).get("/info");
    expect(r.status).toBe(401);
  });

  it("/info 帶正確金鑰可讀", async () => {
    const r = await request(app).get("/info").set("X-API-Key", TEST_KEY);
    expect(r.status).toBe(200);
    expect(r.body.issuerAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("未帶金鑰不得簽發 KYC 憑證（修復前未設 API_KEY 就完全放行）", async () => {
    const r = await request(app)
      .post("/sdjwt/issue")
      .send({ holderDid: "did:key:zQ3shabc", subject: { kycLevel: 99 } });
    expect(r.status).toBe(401);
    expect(r.body.vc).toBeUndefined();
  });

  it("錯誤金鑰回 401", async () => {
    const r = await request(app)
      .post("/sdjwt/issue")
      .set("X-API-Key", "wrong-key-same-length!!")
      .send({ holderDid: "did:key:zQ3shabc" });
    expect(r.status).toBe(401);
  });

  it("未帶金鑰不得撤銷憑證", async () => {
    const r = await request(app)
      .post("/revoke")
      .send({ revocationKey: "0x" + "11".repeat(32) });
    expect(r.status).toBe(401);
  });
});

describe("輸入驗證：型別錯誤應回 400 而非 500", () => {
  it("/sdjwt/verify 缺 presentation 回 400", async () => {
    const r = await request(app).post("/sdjwt/verify").send({});
    expect(r.status).toBe(400);
  });

  it("/sdjwt/verify presentation 傳物件回 400（修復前會 500）", async () => {
    const r = await request(app).post("/sdjwt/verify").send({ presentation: { evil: true } });
    expect(r.status).toBe(400);
  });

  it("/sdjwt/verify 不合法 kind 回 400", async () => {
    const r = await request(app)
      .post("/sdjwt/verify")
      .send({ presentation: "abc~", kind: "admin" });
    expect(r.status).toBe(400);
  });

  it("/revoke 非 bytes32 的 revocationKey 回 400", async () => {
    const r = await request(app)
      .post("/revoke")
      .set("X-API-Key", TEST_KEY)
      .send({ revocationKey: "not-a-hash" });
    expect(r.status).toBe(400);
  });
});

describe("nonce 一次性與驗證政策強制", () => {
  it("/sdjwt/nonce 回傳 nonce 與 aud", async () => {
    const r = await request(app).post("/sdjwt/nonce").send({});
    expect(r.status).toBe(200);
    expect(typeof r.body.nonce).toBe("string");
    expect(typeof r.body.aud).toBe("string");
  });

  it("不帶 nonce 的出示一律 reject（修復前這樣就跳過 KB 與防重放）", async () => {
    const r = await request(app)
      .post("/sdjwt/verify")
      .send({ presentation: "fake~presentation~" });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe("reject");
    expect(r.body.verify.ok).toBe(false);
    expect(r.body.verify.reason).toMatch(/nonce/);
  });

  it("偽造的 nonce 被拒（非本方核發）", async () => {
    const r = await request(app)
      .post("/sdjwt/verify")
      .send({ presentation: "fake~presentation~", nonce: "attacker-made-up-nonce" });
    expect(r.body.verify.reason).toMatch(/nonce/);
  });

  it("同一個 nonce 不得使用兩次，且驗證失敗也會消耗（不可重試）", async () => {
    const { body } = await request(app).post("/sdjwt/nonce").send({});
    const nonce = body.nonce as string;

    // 第一次：nonce 有效，但出示本身是垃圾 → 驗證失敗
    const first = await request(app)
      .post("/sdjwt/verify")
      .send({ presentation: "garbage~", nonce });
    expect(first.body.verify.ok).toBe(false);
    expect(first.body.verify.reason).not.toMatch(/nonce 無效/);

    // 第二次：同一個 nonce 已被消耗 → 應以 nonce 理由被擋
    const second = await request(app)
      .post("/sdjwt/verify")
      .send({ presentation: "garbage~", nonce });
    expect(second.body.verify.reason).toMatch(/nonce/);
  });
});

describe("端到端：真實憑證走完整 HTTP 流程", () => {
  it("簽發 → 取 nonce → 出示 → 驗證通過", async () => {
    const { ensureTestHolder } = await import("./helpers/holder.js");
    const holder = await ensureTestHolder();

    const issued = await request(app)
      .post("/sdjwt/issue")
      .set("X-API-Key", TEST_KEY)
      .send({ holderDid: holder.did, subject: { kycLevel: 2 } });
    expect(issued.status).toBe(200);

    const { body: challenge } = await request(app).post("/sdjwt/nonce").send({});
    const presentation = await holder.present(issued.body.vc, ["kycLevel"], {
      aud: challenge.aud,
      nonce: challenge.nonce,
    });

    const verified = await request(app)
      .post("/sdjwt/verify")
      .send({ presentation, nonce: challenge.nonce, tx: { amount: 1280, type: "PAYMENT" } });

    expect(verified.body.verify.ok).toBe(true);
    expect(verified.body.verify.checks.keyBinding).toBe(true);
    expect(verified.body.verify.checks.credentialType).toBe(true);
  });

  it("同一份出示重放（換新 nonce）會因 KB 的 nonce 不符被擋", async () => {
    const { ensureTestHolder } = await import("./helpers/holder.js");
    const holder = await ensureTestHolder();

    const issued = await request(app)
      .post("/sdjwt/issue")
      .set("X-API-Key", TEST_KEY)
      .send({ holderDid: holder.did, subject: { kycLevel: 2 } });
    const { body: c1 } = await request(app).post("/sdjwt/nonce").send({});
    const presentation = await holder.present(issued.body.vc, ["kycLevel"], {
      aud: c1.aud,
      nonce: c1.nonce,
    });
    await request(app).post("/sdjwt/verify").send({ presentation, nonce: c1.nonce });

    // 攻擊者側錄了這份出示，用一個全新的 nonce 想重放
    const { body: c2 } = await request(app).post("/sdjwt/nonce").send({});
    const replay = await request(app)
      .post("/sdjwt/verify")
      .send({ presentation, nonce: c2.nonce });
    expect(replay.body.verify.ok).toBe(false);
    expect(replay.body.verify.reason).toMatch(/nonce|key binding/);
  });
});
