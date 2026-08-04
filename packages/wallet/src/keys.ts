/**
 * 持有者金鑰與加密保險庫（瀏覽器端）— T2「金鑰自主」強化。
 *
 * 自主權身分（SSI）的核心主張是「金鑰在使用者手上」。本模組讓 holder 的
 * Secp256k1 金鑰對在瀏覽器端生成與保存，DID 由公鑰在本地推導，
 * KB-JWT（key binding）也在本地簽——伺服器從此拿不到持有者私鑰。
 *
 * 安全模型（2026-08 修補 C3 / H10 / M-備份 / M-刪除）：
 *  1. 私鑰**預設**以使用者密語封裝後才落地：
 *     PBKDF2-SHA256（310,000 迭代）→ AES-GCM-256 封裝，存 localStorage。
 *     解鎖後明文私鑰只存在 module-scope 記憶體（`session`），鎖定即清零。
 *  2. 「demo 快速模式」為**必須明確選擇**的例外，會在 UI 全程標示「未加密」。
 *  3. 不再匯出通用 `sign(data)` 簽章 oracle；只匯出 `getKeyBindingSigner()`，
 *     被簽的位元組固定以 KB-JWT header（`{"alg":"ES256K","typ":"kb+jwt"}`）
 *     的 base64url 開頭作為 domain 標籤，呼叫端無法控制 header，
 *     也無法讓錢包簽任意內容。格式與 issuer-verifier 的 KB 驗證完全相容。
 *  4. VC 與私鑰同存於同一個保險庫，一起被密語加密（PII 不再明文落地）。
 *  5. 提供以密語加密的備份匯出／匯入；任何刪除動作都由呼叫端明確觸發。
 *
 * 落地版應再進一步走 WebAuthn / passkey / Secure Enclave；介面不變。
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import type { JwkEc, KeyBindingSigner } from "./sdjwt.ts";
import type { MobileVc } from "./api.ts";

// ── 儲存鍵（唯一真實來源，禁止在其他檔案硬寫字串）──────────────
export const STORAGE_KEYS = {
  /** v2：身分紀錄（DID + 受保護的私鑰） */
  identity: "chaintrust.identity.v2",
  /** v2：憑證保險庫（KYC / 門號 / 信譽 VC） */
  vault: "chaintrust.vault.v2",
  // v1 舊格式（僅供一次性接手，接手後移除；憑證不會被丟棄）
  legacyPrivateKey: "chaintrust.holderKey",
  legacyHolderDid: "chaintrust.holder",
  legacyKycVc: "chaintrust.vc",
  legacyMobileVc: "chaintrust.mobileVc",
  legacyRepVc: "chaintrust.repvc",
} as const;

/** PBKDF2 迭代數（OWASP 2023 建議 PBKDF2-HMAC-SHA256 ≥ 600k；此處取 310k 以兼顧行動裝置 demo 體感） */
const PBKDF2_ITERATIONS = 310_000;
const MIN_PASSPHRASE_LENGTH = 8;
const BACKUP_FORMAT = "chaintrust-wallet-backup";

/** 私鑰保護方式：passphrase = 已加密（預設路徑）；demo-plaintext = 明文（僅供展示） */
export type IdentityProtection = "passphrase" | "demo-plaintext";

export interface HolderIdentity {
  did: string;
  protection: IdentityProtection;
  /** 本機金鑰的公開座標，用來比對憑證 cnf.jwk 是否真的綁定這台裝置 */
  publicJwk: JwkEc;
}

export interface WalletVault {
  kycVc: string | null;
  repVc: string | null;
  mobileVc: MobileVc | null;
}

export const EMPTY_VAULT: WalletVault = { kycVc: null, repVc: null, mobileVc: null };

// ── base58btc（Bitcoin 字母表）編碼：與 server 端 decode 鏡像 ──
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58btcEncode(bytes: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  // 前導 0 byte → 前導 '1'
  let prefix = "";
  for (const b of bytes) {
    if (b !== 0) break;
    prefix += "1";
  }
  return prefix + digits.reverse().map((d) => B58[d]).join("");
}

// ── 編碼工具 ─────────────────────────────────────────────
function b64u(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uJson(obj: unknown): string {
  return b64u(new TextEncoder().encode(JSON.stringify(obj)));
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** 由壓縮公鑰（33B）推 did:key：multicodec secp256k1-pub = 0xe7 0x01 */
export function didKeyFromCompressedPublicKey(pub: Uint8Array): string {
  const prefixed = new Uint8Array(2 + pub.length);
  prefixed[0] = 0xe7;
  prefixed[1] = 0x01;
  prefixed.set(pub, 2);
  return "did:key:z" + base58btcEncode(prefixed);
}

function didFromPrivateKey(priv: Uint8Array): string {
  return didKeyFromCompressedPublicKey(secp256k1.getPublicKey(priv, true));
}

function publicJwkFromPrivateKey(priv: Uint8Array): JwkEc {
  const uncompressed = secp256k1.getPublicKey(priv, false); // 65B：0x04 | x(32) | y(32)
  return {
    kty: "EC",
    crv: "secp256k1",
    x: b64u(uncompressed.slice(1, 33)),
    y: b64u(uncompressed.slice(33, 65)),
  };
}

// ── WebCrypto（PBKDF2 + AES-GCM）────────────────────────────
interface EncryptedBlob {
  alg: "AES-GCM";
  iv: string; // base64
  ct: string; // base64
}

interface KdfParams {
  name: "PBKDF2";
  hash: "SHA-256";
  iterations: number;
  salt: string; // base64
}

/** 加密保護是否可用（WebCrypto 需要安全脈絡：https 或 localhost） */
export function encryptionAvailable(): boolean {
  return typeof globalThis.crypto?.subtle?.deriveKey === "function";
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) {
    throw new Error(
      "此環境不支援 WebCrypto（需 https 或 localhost 等安全脈絡），無法以密語加密金鑰。"
    );
  }
  return s;
}

/** WebCrypto 的 BufferSource 需要以一般 ArrayBuffer 為底的檢視（非 SharedArrayBuffer） */
function bs(bytes: Uint8Array) {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

async function deriveVaultKey(passphrase: string, kdf: KdfParams): Promise<CryptoKey> {
  if (kdf.name !== "PBKDF2" || kdf.hash !== "SHA-256") {
    throw new Error(`不支援的金鑰派生參數：${kdf.name}/${kdf.hash}`);
  }
  const base = await subtle().importKey("raw", bs(utf8ToBytes(passphrase)), "PBKDF2", false, [
    "deriveKey",
  ]);
  return subtle().deriveKey(
    { name: "PBKDF2", salt: bs(b64ToBytes(kdf.salt)), iterations: kdf.iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false, // 不可匯出：即使拿到 CryptoKey 也帶不走原始金鑰
    ["encrypt", "decrypt"]
  );
}

function newKdfParams(): KdfParams {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: bytesToB64(salt) };
}

async function aesEncrypt(key: CryptoKey, plaintext: string): Promise<EncryptedBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv: bs(iv) },
    key,
    bs(new TextEncoder().encode(plaintext))
  );
  return { alg: "AES-GCM", iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ct)) };
}

async function aesDecrypt(key: CryptoKey, blob: EncryptedBlob): Promise<string> {
  const pt = await subtle().decrypt(
    { name: "AES-GCM", iv: bs(b64ToBytes(blob.iv)) },
    key,
    bs(b64ToBytes(blob.ct))
  );
  return new TextDecoder().decode(new Uint8Array(pt));
}

// ── 儲存結構 ─────────────────────────────────────────────
interface StoredIdentity {
  v: 2;
  did: string;
  protection: IdentityProtection;
  kdf: KdfParams | null;
  /** protection=passphrase → EncryptedBlob；demo-plaintext → 私鑰 hex（明文，僅展示用） */
  privateKey: EncryptedBlob | string;
  createdAt: number;
}

interface StoredVault {
  v: 2;
  protection: IdentityProtection;
  data: EncryptedBlob | WalletVault;
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // 隱私模式 / 停用儲存
  }
}
function writeLocal(key: string, value: string): void {
  localStorage.setItem(key, value);
}
function removeLocal(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 忽略：本來就讀不到 */
  }
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readStoredIdentity(): StoredIdentity | null {
  const rec = parseJson<StoredIdentity>(readLocal(STORAGE_KEYS.identity));
  if (!rec || rec.v !== 2 || typeof rec.did !== "string") return null;
  if (rec.protection !== "passphrase" && rec.protection !== "demo-plaintext") return null;
  return rec;
}

// ── 解鎖中的 session（唯一持有明文私鑰的地方）────────────────
interface Session {
  did: string;
  priv: Uint8Array;
  publicJwk: JwkEc;
  /** demo-plaintext 模式為 null */
  vaultKey: CryptoKey | null;
  protection: IdentityProtection;
}

let session: Session | null = null;

function requireSession(): Session {
  if (!session) throw new Error("錢包尚未解鎖：請先輸入密語解鎖後再操作。");
  return session;
}

function snapshot(s: Session): HolderIdentity {
  return { did: s.did, protection: s.protection, publicJwk: s.publicJwk };
}

// ── 對外查詢 ─────────────────────────────────────────────
export function hasStoredIdentity(): boolean {
  return readStoredIdentity() !== null;
}

/** 未解鎖也能讀到的公開資訊（DID / 保護方式），供鎖定畫面顯示 */
export function storedIdentityInfo(): { did: string; protection: IdentityProtection } | null {
  const rec = readStoredIdentity();
  return rec ? { did: rec.did, protection: rec.protection } : null;
}

export function isUnlocked(): boolean {
  return session !== null;
}

export function getUnlockedIdentity(): HolderIdentity | null {
  return session ? snapshot(session) : null;
}

/** 密語強度檢查：回傳錯誤訊息或 null（供 UI 即時提示） */
export function passphraseProblem(passphrase: string): string | null {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `密語至少需 ${MIN_PASSPHRASE_LENGTH} 個字元`;
  }
  return null;
}

function assertPassphrase(passphrase: string): void {
  const problem = passphraseProblem(passphrase);
  if (problem) throw new Error(problem);
}

// ── 建立 / 解鎖 / 鎖定 ────────────────────────────────────

/** 建立**加密**身分（預設路徑）：金鑰在本機生成，以密語封裝後落地。 */
export async function createEncryptedIdentity(passphrase: string): Promise<HolderIdentity> {
  if (hasStoredIdentity()) throw new Error("此裝置已有身分，請先解鎖或重設身分。");
  assertPassphrase(passphrase);
  const priv = secp256k1.utils.randomPrivateKey();
  const kdf = newKdfParams();
  const key = await deriveVaultKey(passphrase, kdf);
  const rec: StoredIdentity = {
    v: 2,
    did: didFromPrivateKey(priv),
    protection: "passphrase",
    kdf,
    privateKey: await aesEncrypt(key, bytesToHex(priv)),
    createdAt: Date.now(),
  };
  writeLocal(STORAGE_KEYS.identity, JSON.stringify(rec));
  session = {
    did: rec.did,
    priv,
    publicJwk: publicJwkFromPrivateKey(priv),
    vaultKey: key,
    protection: "passphrase",
  };
  await saveVault(EMPTY_VAULT);
  return snapshot(session);
}

/**
 * 建立**未加密**的 demo 身分（例外路徑）。
 * 呼叫端必須在 UI 明確標示「未加密，僅供展示」——私鑰以明文存於瀏覽器。
 */
export async function createDemoIdentity(): Promise<HolderIdentity> {
  if (hasStoredIdentity()) throw new Error("此裝置已有身分，請先解鎖或重設身分。");
  const priv = secp256k1.utils.randomPrivateKey();
  const rec: StoredIdentity = {
    v: 2,
    did: didFromPrivateKey(priv),
    protection: "demo-plaintext",
    kdf: null,
    privateKey: bytesToHex(priv),
    createdAt: Date.now(),
  };
  writeLocal(STORAGE_KEYS.identity, JSON.stringify(rec));
  session = {
    did: rec.did,
    priv,
    publicJwk: publicJwkFromPrivateKey(priv),
    vaultKey: null,
    protection: "demo-plaintext",
  };
  await saveVault(EMPTY_VAULT);
  return snapshot(session);
}

/** 以密語解鎖（同一分頁 session 內只需一次）。 */
export async function unlockWithPassphrase(passphrase: string): Promise<HolderIdentity> {
  const rec = readStoredIdentity();
  if (!rec) throw new Error("此裝置尚未建立身分。");
  if (rec.protection !== "passphrase" || !rec.kdf || typeof rec.privateKey === "string") {
    throw new Error("此身分未以密語加密，請改用快速模式開啟。");
  }
  const key = await deriveVaultKey(passphrase, rec.kdf);
  let hex: string;
  try {
    hex = await aesDecrypt(key, rec.privateKey);
  } catch {
    // AES-GCM 認證失敗 → 密語錯誤或資料被竄改，兩者都不該再往下走
    throw new Error("密語錯誤，無法解鎖錢包。");
  }
  const priv = hexToBytes(hex.trim());
  const did = didFromPrivateKey(priv);
  if (did !== rec.did) throw new Error("金鑰資料毀損：解出的 DID 與紀錄不符。");
  session = { did, priv, publicJwk: publicJwkFromPrivateKey(priv), vaultKey: key, protection: "passphrase" };
  return snapshot(session);
}

/** 開啟未加密的 demo 身分（不需密語；僅適用 protection=demo-plaintext）。 */
export async function unlockDemoIdentity(): Promise<HolderIdentity> {
  const rec = readStoredIdentity();
  if (!rec) throw new Error("此裝置尚未建立身分。");
  if (rec.protection !== "demo-plaintext" || typeof rec.privateKey !== "string") {
    throw new Error("此身分已加密，請輸入密語解鎖。");
  }
  const priv = hexToBytes(rec.privateKey.trim());
  const did = didFromPrivateKey(priv);
  if (did !== rec.did) throw new Error("金鑰資料毀損：解出的 DID 與紀錄不符。");
  session = { did, priv, publicJwk: publicJwkFromPrivateKey(priv), vaultKey: null, protection: "demo-plaintext" };
  return snapshot(session);
}

/** 鎖定錢包：清除記憶體中的明文私鑰（不動已落地的加密資料）。 */
export function lockWallet(): void {
  if (session) session.priv.fill(0);
  session = null;
}

/**
 * 為既有身分（含 demo 明文身分）設定／更換密語，並同步重新加密保險庫。
 * 需已解鎖。
 */
export async function setPassphrase(passphrase: string): Promise<HolderIdentity> {
  const s = requireSession();
  assertPassphrase(passphrase);
  const rec = readStoredIdentity();
  if (!rec) throw new Error("找不到身分紀錄。");
  const vault = await loadVault(); // 先以舊保護方式讀出，再換鑰重寫
  const kdf = newKdfParams();
  const key = await deriveVaultKey(passphrase, kdf);
  const next: StoredIdentity = {
    ...rec,
    protection: "passphrase",
    kdf,
    privateKey: await aesEncrypt(key, bytesToHex(s.priv)),
  };
  writeLocal(STORAGE_KEYS.identity, JSON.stringify(next));
  session = { ...s, vaultKey: key, protection: "passphrase" };
  await saveVault(vault);
  return snapshot(session);
}

/**
 * 重設此裝置身分：刪除私鑰、保險庫與所有舊格式殘留。
 * **不可復原**——呼叫端必須先取得使用者明確確認並提示先做備份。
 */
export function forgetHolderKeys(): void {
  lockWallet();
  for (const key of Object.values(STORAGE_KEYS)) removeLocal(key);
}

// ── 保險庫（憑證）──────────────────────────────────────────
function normalizeVault(raw: unknown): WalletVault {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    kycVc: typeof o.kycVc === "string" ? o.kycVc : null,
    repVc: typeof o.repVc === "string" ? o.repVc : null,
    mobileVc:
      o.mobileVc && typeof o.mobileVc === "object" ? (o.mobileVc as MobileVc) : null,
  };
}

export async function loadVault(): Promise<WalletVault> {
  const s = requireSession();
  const rec = parseJson<StoredVault>(readLocal(STORAGE_KEYS.vault));
  if (!rec || rec.v !== 2) return { ...EMPTY_VAULT };
  if (rec.protection === "demo-plaintext") return normalizeVault(rec.data);
  if (!s.vaultKey) throw new Error("保險庫為加密狀態，但目前 session 沒有金鑰。請重新解鎖。");
  const json = await aesDecrypt(s.vaultKey, rec.data as EncryptedBlob);
  return normalizeVault(JSON.parse(json));
}

export async function saveVault(vault: WalletVault): Promise<void> {
  const s = requireSession();
  const clean = normalizeVault(vault);
  const rec: StoredVault =
    s.protection === "passphrase" && s.vaultKey
      ? { v: 2, protection: "passphrase", data: await aesEncrypt(s.vaultKey, JSON.stringify(clean)) }
      : { v: 2, protection: "demo-plaintext", data: clean };
  writeLocal(STORAGE_KEYS.vault, JSON.stringify(rec));
}

// ── 舊格式（v1）接手：不刪任何憑證 ─────────────────────────
export function hasLegacyIdentity(): boolean {
  return readLocal(STORAGE_KEYS.legacyPrivateKey) !== null;
}

/**
 * 接手 v1 的明文金鑰與憑證：原樣搬進新結構（保護等級維持 demo-plaintext，
 * 不會憑空「升級」也不會刪除使用者的憑證）。呼叫端應提示使用者設定密語。
 *
 * 回傳 `didMismatch`：舊的 `chaintrust.holder` 與本機金鑰推導出的 DID 不符時為 true。
 * 這種情況**不再自動刪除憑證**——交由使用者在 UI 上決定。
 */
export async function adoptLegacyIdentity(): Promise<{
  identity: HolderIdentity;
  didMismatch: boolean;
}> {
  const hex = readLocal(STORAGE_KEYS.legacyPrivateKey);
  if (!hex) throw new Error("找不到舊版金鑰。");
  const priv = hexToBytes(hex.trim());
  const did = didFromPrivateKey(priv);
  const rec: StoredIdentity = {
    v: 2,
    did,
    protection: "demo-plaintext",
    kdf: null,
    privateKey: bytesToHex(priv),
    createdAt: Date.now(),
  };
  writeLocal(STORAGE_KEYS.identity, JSON.stringify(rec));
  session = { did, priv, publicJwk: publicJwkFromPrivateKey(priv), vaultKey: null, protection: "demo-plaintext" };

  const legacyHolder = readLocal(STORAGE_KEYS.legacyHolderDid);
  const vault: WalletVault = {
    kycVc: readLocal(STORAGE_KEYS.legacyKycVc),
    repVc: readLocal(STORAGE_KEYS.legacyRepVc),
    mobileVc: parseJson<MobileVc>(readLocal(STORAGE_KEYS.legacyMobileVc)),
  };
  await saveVault(vault);

  // 憑證已安全搬入新保險庫後，才清掉 v1 的重複明文副本
  removeLocal(STORAGE_KEYS.legacyPrivateKey);
  removeLocal(STORAGE_KEYS.legacyHolderDid);
  removeLocal(STORAGE_KEYS.legacyKycVc);
  removeLocal(STORAGE_KEYS.legacyMobileVc);
  removeLocal(STORAGE_KEYS.legacyRepVc);

  return {
    identity: snapshot(session),
    didMismatch: legacyHolder !== null && legacyHolder !== did,
  };
}

// ── 備份／還原（以密語加密的 JSON）──────────────────────────
interface BackupFile {
  format: typeof BACKUP_FORMAT;
  v: 2;
  did: string;
  createdAt: string;
  kdf: KdfParams;
  blob: EncryptedBlob;
}

interface BackupPayload {
  did: string;
  privateKeyHex: string;
  vault: WalletVault;
}

/** 匯出加密備份（私鑰＋憑證），回傳可直接存檔的 JSON 字串。需已解鎖。 */
export async function exportEncryptedBackup(passphrase: string): Promise<string> {
  const s = requireSession();
  assertPassphrase(passphrase);
  const vault = await loadVault();
  const kdf = newKdfParams();
  const key = await deriveVaultKey(passphrase, kdf);
  const payload: BackupPayload = { did: s.did, privateKeyHex: bytesToHex(s.priv), vault };
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    v: 2,
    did: s.did,
    createdAt: new Date().toISOString(),
    kdf,
    blob: await aesEncrypt(key, JSON.stringify(payload)),
  };
  return JSON.stringify(file, null, 2);
}

/**
 * 匯入加密備份：**覆寫**本機身分與保險庫。
 * 呼叫端必須先確認使用者理解覆寫後果（現有金鑰會被取代）。
 */
export async function importEncryptedBackup(
  json: string,
  passphrase: string
): Promise<HolderIdentity> {
  const file = parseJson<BackupFile>(json);
  if (!file || file.format !== BACKUP_FORMAT || file.v !== 2 || !file.kdf || !file.blob) {
    throw new Error("這不是有效的 ChainTrust 錢包備份檔。");
  }
  const key = await deriveVaultKey(passphrase, file.kdf);
  let plain: string;
  try {
    plain = await aesDecrypt(key, file.blob);
  } catch {
    throw new Error("密語錯誤或備份檔已毀損，無法還原。");
  }
  const payload = parseJson<BackupPayload>(plain);
  if (!payload || typeof payload.privateKeyHex !== "string") {
    throw new Error("備份內容格式不符。");
  }
  const priv = hexToBytes(payload.privateKeyHex.trim());
  const did = didFromPrivateKey(priv);
  if (did !== file.did) throw new Error("備份檔內容與宣告的 DID 不符，已拒絕還原。");

  // 還原後一律以同一組密語加密落地（備份是加密的，還原也不該退回明文）
  const kdf = newKdfParams();
  const vaultKey = await deriveVaultKey(passphrase, kdf);
  const rec: StoredIdentity = {
    v: 2,
    did,
    protection: "passphrase",
    kdf,
    privateKey: await aesEncrypt(vaultKey, bytesToHex(priv)),
    createdAt: Date.now(),
  };
  writeLocal(STORAGE_KEYS.identity, JSON.stringify(rec));
  session = { did, priv, publicJwk: publicJwkFromPrivateKey(priv), vaultKey, protection: "passphrase" };
  await saveVault(normalizeVault(payload.vault));
  return snapshot(session);
}

// ── 限定用途的簽章器（取代原本的通用 sign oracle）──────────────
/**
 * KB-JWT 固定 header——同時是簽章的 **domain separation 標籤**。
 * 每一次簽章的位元組都必然以 base64url(KB_HEADER) + "." 開頭，
 * 呼叫端無從變更，因此本錢包的私鑰只能產生 KB-JWT，不可能被誘導去簽
 * 交易、登入挑戰或任何其他格式的訊息。
 */
const KB_HEADER = Object.freeze({ alg: "ES256K", typ: "kb+jwt" });
const KB_HEADER_B64U = b64uJson(KB_HEADER);

/**
 * 取得「只能簽 key binding」的簽章器。由呼叫端注入給 sdjwt.ts，
 * 讓出示流程可被攔截、可測試，而不是任何同源腳本都能拿到簽章能力。
 */
export function getKeyBindingSigner(): KeyBindingSigner {
  const s = requireSession();
  const boundDid = s.did;
  return {
    did: boundDid,
    attach(core: string, kb: { aud: string; nonce: string }): string {
      // 每次簽章都重新取 session：錢包一旦鎖定，先前取得的簽章器立即失效
      const cur = requireSession();
      if (cur.did !== boundDid) throw new Error("簽章器已失效：目前解鎖的身分已變更。");
      if (typeof core !== "string" || !core.endsWith("~")) {
        throw new Error("拒絕簽章：core 不是合法的 SD-JWT 出示內容。");
      }
      if (!kb || typeof kb.aud !== "string" || typeof kb.nonce !== "string" || !kb.aud || !kb.nonce) {
        throw new Error("拒絕簽章：缺少驗證方 aud 或一次性 nonce。");
      }
      const payload = {
        iat: Math.floor(Date.now() / 1000),
        aud: kb.aud,
        nonce: kb.nonce,
        // sd_hash 由本模組自 core 計算，呼叫端無法塞入任意雜湊
        sd_hash: b64u(sha256(utf8ToBytes(core))),
      };
      const signingInput = `${KB_HEADER_B64U}.${b64uJson(payload)}`;
      const digest = sha256(utf8ToBytes(signingInput));
      const sig = secp256k1.sign(digest, cur.priv, { lowS: true });
      return core + `${signingInput}.${b64u(sig.toCompactRawBytes())}`;
    },
  };
}
