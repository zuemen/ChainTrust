/**
 * 真實 HTTP 冒煙測試：直接 import 錢包的 keys.ts / sdjwt.ts（noble 實作），
 * 對啟動中的 issuer-verifier 完整跑：本機金鑰 → 簽發 → nonce → KB 出示 → 驗證 → 雙簽發者。
 */
// node 環境 shim：keys.ts 用到 localStorage / btoa / atob
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

import { createDemoIdentity, getKeyBindingSigner } from "../../wallet/src/keys.ts";
import { parseSdJwt, buildPresentationWithKeyBinding } from "../../wallet/src/sdjwt.ts";

const BASE = "http://localhost:3001";
async function post(path: string, body: unknown) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: authed({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path} ${r.status}: ${JSON.stringify(j)}`);
  return j;
}
const assert = (cond: unknown, msg: string) => {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✔ " + msg);
};

const API_KEY = process.env.API_KEY ?? "";
const authed = (extra: Record<string, string> = {}) =>
  API_KEY ? { ...extra, "X-API-Key": API_KEY } : extra;

const health = await (await fetch(BASE + "/health")).json();
assert(health.ok, "伺服器連線");
// issuer 詳情已收斂到需鑑權的 /info（/health 只回存活狀態 + 主 issuer DID）
const info = await (await fetch(BASE + "/info", { headers: authed() })).json();
assert(info.ok, `取得 issuer 資訊（chainMode=${info.chainMode}）`);
assert(info.chtIssuerDid && info.chtIssuerDid !== info.issuerDid, "雙簽發者：銀行 A 與中華電信為不同 DID");

// 1) 本機金鑰（伺服器沒有這把私鑰）
const keys = await createDemoIdentity();
assert(keys.did.startsWith("did:key:z"), `瀏覽器端金鑰生成，DID=${keys.did.slice(0, 24)}…`);

// 2) 簽發（holderDid 必填——伺服器不再代建）
const bad = await fetch(BASE + "/sdjwt/issue", {
  method: "POST", headers: authed({ "Content-Type": "application/json" }), body: "{}",
});
assert(bad.status === 400, "缺 holderDid 的簽發請求被拒（伺服器不再代管金鑰）");
const { vc } = await post("/sdjwt/issue", { holderDid: keys.did });
assert(typeof vc === "string" && vc.includes("~"), "SD-JWT KYC 憑證簽發成功");

// 3) nonce → 本機簽 KB → 驗證（KB 由伺服器端政策強制必驗）
const { nonce, aud } = await post("/sdjwt/nonce", {});
const parsed = parseSdJwt(vc);
// 簽章器由已解鎖的錢包提供（H10：不再有全域 sign oracle）
const presentation = buildPresentationWithKeyBinding(parsed, ["kycLevel"], { aud, nonce }, getKeyBindingSigner());
const res = await post("/sdjwt/verify", {
  presentation,
  tx: { type: "PAYMENT", amount: 1280, mobile_realname_verified: true, account_age_days: 900 },
  nonce,
});
assert(res.verify.ok === true, `驗證通過：${JSON.stringify(res.verify.checks)}`);
assert(res.verify.checks.keyBinding === true, "KB（本機簽章）檢查通過");
assert(res.verify.disclosed.length === 1 && res.verify.disclosed[0] === "kycLevel", "最小揭露：只揭露 kycLevel");

// 4) nonce 一次性：重放同一出示應被拒
const replay = await post("/sdjwt/verify", {
  presentation, tx: {}, nonce,
});
assert(replay.verify.ok === false && String(replay.verify.reason).includes("nonce"), "重放同一 nonce 被拒");

// 5) 雙簽發者：中華電信門號電子卡
const mob = await post("/issue/mobile", { holderDid: keys.did, msisdn: "0912345678" });
const mobIssuer = typeof mob.vc.issuer === "string" ? mob.vc.issuer : mob.vc.issuer.id;
assert(mobIssuer === info.chtIssuerDid, "門號實名憑證由第二簽發者（中華電信）簽發");
assert(mob.vc.credentialSubject.msisdnVerified === true, `門號實名驗證通過（${mob.vc.credentialSubject.msisdnMasked}）`);

console.log("\n✅ 冒煙測試全數通過：金鑰自主 + KB + nonce 防重放 + 雙簽發者");
process.exit(0);
