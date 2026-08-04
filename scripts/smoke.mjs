#!/usr/bin/env node
/**
 * ChainTrust 五步 Demo 線跨服務 smoke 驗證。
 * 需先啟動 issuer-verifier(:3001) 與 ai-service(:8000)（例如 `pnpm demo`）。
 * 驗證：跨機構重用 KYC（最小揭露）+ 持有者金鑰綁定 + 高風險交易攔截。
 *
 * 金鑰自主：本腳本在本機自行產生持有者 secp256k1 金鑰並推導 did:key，
 * 出示時以該私鑰簽 KB-JWT——與錢包在瀏覽器端的行為一致，伺服器不代管持有者金鑰。
 * 只用 Node 內建 crypto，不依賴任何 workspace 套件（避免與前端改動耦合）。
 *
 * 用法：node scripts/smoke.mjs   或   pnpm smoke
 */
import { generateKeyPairSync, sign as nodeSign, createHash } from "node:crypto";

const IV = process.env.IV_URL ?? "http://localhost:3001";
const AI = process.env.AI_URL ?? "http://localhost:8000";
// issuer-verifier 的 mutating 端點（/sdjwt/issue、/revoke…）採 fail-closed：
// 未設 API_KEY 時一律回 503，設了就必須帶對 X-API-Key。
const API_KEY = process.env.API_KEY ?? "";

const NORMAL_TX = { type: "PAYMENT", amount: 1280, oldbalanceOrg: 52000, newbalanceOrig: 50720, mobile_realname_verified: true, account_age_days: 900, payee_risk: 0.05, tx_count_1h: 1, tx_count_24h: 4 };
const MULE_TX = { type: "TRANSFER", amount: 920000, oldbalanceOrg: 1000000, newbalanceOrig: 0, mobile_realname_verified: false, tx_count_1h: 8, tx_count_24h: 41, device_changed: true, geo_jump: true, account_age_days: 2, payee_risk: 0.92, cross_institution_presentations: 13 };

let failed = false;
const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => { console.error(`  ✘ ${m}`); failed = true; };

// ── 持有者金鑰（等同錢包的 keys.ts，但只用 Node 內建 crypto）──────────
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btcEncode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}

/** 由 JWK 座標組壓縮公鑰（33 bytes：parity prefix + x） */
function compressedPubKey(jwk) {
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const prefix = (y[y.length - 1] & 1) === 0 ? 0x02 : 0x03;
  return Buffer.concat([Buffer.from([prefix]), x]);
}

function createHolder() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const jwk = publicKey.export({ format: "jwk" });
  const compressed = compressedPubKey(jwk);
  // did:key = "did:key:z" + base58btc(multicodec secp256k1-pub 0xe701 + 壓縮公鑰)
  const did = "did:key:z" + base58btcEncode(Buffer.concat([Buffer.from([0xe7, 0x01]), compressed]));

  /** ES256K 簽章：對 sha256(utf8(data)) 簽，輸出 base64url(r||s)，s 正規化為 low-s */
  const signES256K = (data) => {
    const raw = nodeSign("sha256", Buffer.from(data, "utf-8"), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
    const r = raw.subarray(0, 32);
    let s = BigInt("0x" + raw.subarray(32).toString("hex"));
    // 驗證端（ethers）只接受 canonical low-s，Node 約半數會產出 high-s
    if (s > SECP256K1_N / 2n) s = SECP256K1_N - s;
    const sBuf = Buffer.from(s.toString(16).padStart(64, "0"), "hex");
    return Buffer.concat([r, sBuf]).toString("base64url");
  };

  return { did, signES256K };
}

// ── SD-JWT 處理 ───────────────────────────────────────────────
function b64urlToStr(s) {
  return Buffer.from(s, "base64url").toString("utf-8");
}
const b64uJson = (o) => Buffer.from(JSON.stringify(o), "utf-8").toString("base64url");

function parseSdJwt(compact) {
  const segs = compact.split("~");
  const jwt = segs[0];
  const payload = JSON.parse(b64urlToStr(jwt.split(".")[1]));
  const disclosures = segs.slice(1).filter(Boolean).map((raw) => {
    const arr = JSON.parse(b64urlToStr(raw));
    return arr.length >= 3 ? { raw, claim: arr[1] } : { raw, claim: "(el)" };
  });
  return { jwt, payload, disclosures };
}

function buildCore(parsed, reveal) {
  const kept = parsed.disclosures.filter((d) => reveal.includes(d.claim)).map((d) => d.raw);
  return [parsed.jwt, ...kept].join("~") + "~";
}

/** 最小揭露 core + 持有者私鑰簽的 KB-JWT（sd_hash 綁定出示內容，防轉手/竄改） */
function buildPresentationWithKb(holder, parsed, reveal, { aud, nonce }) {
  const core = buildCore(parsed, reveal);
  const sdHash = createHash("sha256").update(Buffer.from(core, "utf-8")).digest("base64url");
  const header = { alg: "ES256K", typ: "kb+jwt" };
  const payload = { aud, nonce, iat: Math.floor(Date.now() / 1000), sd_hash: sdHash };
  const signingInput = `${b64uJson(header)}.${b64uJson(payload)}`;
  return `${core}${signingInput}.${holder.signES256K(signingInput)}`;
}

// ── HTTP ─────────────────────────────────────────────────────
function authHeaders(extra = {}) {
  return API_KEY ? { ...extra, "X-API-Key": API_KEY } : { ...extra };
}
function hint(status) {
  if (status === 503) {
    return "（服務端未設 API_KEY，簽發端點 fail-closed → 請在服務端與本地都設同一個 API_KEY）";
  }
  if (status === 401 || status === 403) {
    return API_KEY
      ? "（已帶 X-API-Key 仍被拒 → 金鑰與服務端 API_KEY 不一致）"
      : "（服務端設了 API_KEY，但本地環境沒有 → 執行前先 set/export API_KEY=<同一個值>，或用 .env）";
  }
  return "";
}
async function jget(url) {
  const r = await fetch(url, { headers: authHeaders() });
  if (!r.ok) throw new Error(`${url} ${r.status}${hint(r.status)}`);
  return r.json();
}
async function jpost(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${url} ${r.status}: ${await r.text()}${hint(r.status)}`);
  return r.json();
}

/** 每次出示都向驗證方要一個新的一次性 nonce（nonce 用過即失效） */
async function freshChallenge() {
  const c = await jpost(`${IV}/sdjwt/nonce`, {});
  return { aud: c.aud, nonce: c.nonce };
}

async function main() {
  console.log("=== ChainTrust 五步 Demo 線 smoke ===");
  console.log(API_KEY ? "（已帶 X-API-Key）" : "（未設 API_KEY：簽發端點會 fail-closed 回 503）");

  console.log("\n[健康檢查]");
  try { const h = await jget(`${IV}/health`); ok(`issuer-verifier 連線（issuer ${String(h.issuerDid).slice(0, 24)}…）`); }
  catch (e) { bad(`issuer-verifier 未連線：${e.message}（先跑 pnpm demo）`); return finish(); }
  try { const a = await jget(`${AI}/health`); a.model_loaded ? ok("ai-service 連線（模型已載入）") : bad("ai-service 連線但模型未載入（跑 pnpm ai:train）"); }
  catch (e) { bad(`ai-service 未連線：${e.message}`); }

  console.log("\n[金鑰自主] 本機產生持有者金鑰（伺服器不代管）");
  const holder = createHolder();
  ok(`holder DID = ${holder.did.slice(0, 32)}…`);

  console.log("\n[步驟1-2] 銀行A 簽發 KYC 憑證 → 錢包持有");
  const issued = await jpost(`${IV}/sdjwt/issue`, {
    holderDid: holder.did,
    subject: { kycLevel: 2, fullName: "王小明", birthDate: "1990-01-01", country: "TW", over18: true },
  });
  const parsed = parseSdJwt(issued.vc);
  const held = parsed.disclosures.map((d) => d.claim);
  held.length === 5 ? ok(`憑證含 5 個可選擇揭露欄位：${held.join(", ")}`) : bad(`可揭露欄位數不符：${held.join(", ")}`);
  parsed.payload.exp ? ok(`憑證有有效期（exp=${new Date(parsed.payload.exp * 1000).toISOString().slice(0, 10)}）`) : bad("憑證缺 exp（永不過期）");

  console.log("\n[步驟3-4] 最小揭露：只揭露 kycLevel，並以本機私鑰簽 KB-JWT");

  console.log("\n[步驟5a] 正常交易 → 應放行且驗證方看不到 PII");
  const ch1 = await freshChallenge();
  const presA = buildPresentationWithKb(holder, parsed, ["kycLevel"], ch1);
  const a = await jpost(`${IV}/sdjwt/verify`, { presentation: presA, tx: NORMAL_TX, nonce: ch1.nonce });
  a.verify?.checks?.keyBinding === true ? ok("持有者金鑰綁定通過（KB）") : bad(`keyBinding=${a.verify?.checks?.keyBinding}（reason: ${a.verify?.reason}）`);
  a.outcome === "approve" ? ok(`outcome=approve（risk=${a.risk?.risk} ${a.risk?.decision}）`) : bad(`outcome=${a.outcome}（期望 approve；reason: ${a.verify?.reason}）`);
  const seen = Object.keys(a.verify?.payload ?? {});
  (!seen.includes("fullName") && !seen.includes("birthDate")) ? ok("驗證方看不到 fullName/birthDate（最小揭露成立）") : bad(`驗證方看到 PII：${seen.join(",")}`);
  a.verify?.disclosed?.length === 1 && a.verify.disclosed[0] === "kycLevel" ? ok("揭露欄位僅 kycLevel") : bad(`揭露欄位：${a.verify?.disclosed?.join(",")}`);

  console.log("\n[步驟5b] 高風險人頭交易（同一張憑證）→ 應攔截");
  const ch2 = await freshChallenge();
  const presB = buildPresentationWithKb(holder, parsed, ["kycLevel"], ch2);
  const b = await jpost(`${IV}/sdjwt/verify`, { presentation: presB, tx: MULE_TX, nonce: ch2.nonce });
  (b.outcome === "reject" && b.risk?.decision === "block") ? ok(`outcome=reject / block（risk=${b.risk?.risk}）`) : bad(`outcome=${b.outcome} decision=${b.risk?.decision}（期望 reject/block）`);
  b.risk?.reasons?.includes("MULE_PATTERN") ? ok(`風險原因含 MULE_PATTERN（${b.risk.reasons.join(", ")}）`) : bad(`風險原因：${b.risk?.reasons?.join(",")}`);

  console.log("\n[防重放] 重放先前用過的出示 → 應被擋");
  const replay = await jpost(`${IV}/sdjwt/verify`, { presentation: presA, tx: NORMAL_TX, nonce: ch1.nonce });
  replay.outcome === "reject" ? ok(`重放被擋（reason: ${replay.verify?.reason}）`) : bad(`重放竟通過：outcome=${replay.outcome}`);

  finish();
}
function finish() {
  console.log("\n" + (failed ? "❌ smoke 失敗" : "✅ 五步 Demo 線全數通過"));
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("smoke 例外：", e); process.exit(1); });
