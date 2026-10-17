import {
  createAgent,
  type TAgent,
  type IDIDManager,
  type IKeyManager,
  type IResolver,
  type ICredentialPlugin,
} from "@veramo/core";
import { DIDManager, MemoryDIDStore } from "@veramo/did-manager";
import {
  KeyManager,
  MemoryKeyStore,
  MemoryPrivateKeyStore,
} from "@veramo/key-manager";
import { KeyManagementSystem } from "@veramo/kms-local";
import { EthrDIDProvider } from "@veramo/did-provider-ethr";
import { KeyDIDProvider } from "@veramo/did-provider-key";
import { DIDResolverPlugin } from "@veramo/did-resolver";
import { Resolver } from "did-resolver";
import { getResolver as ethrDidResolver } from "ethr-did-resolver";
import { getResolver as keyDidResolver } from "key-did-resolver";
import { CredentialPlugin } from "@veramo/credential-w3c";
import { SigningKey } from "ethers";
import { config } from "./config.js";

type ChainTrustPlugins = IDIDManager & IKeyManager & IResolver & ICredentialPlugin;
/** 設定完成的 agent 型別：方法為單參數（context 由 agent 自動注入） */
export type ChainTrustAgent = TAgent<ChainTrustPlugins>;

const KMS = "local";

/**
 * 建立 Veramo agent：
 * - did:key（Holder，離線可解析）+ did:ethr（Issuer，位址對應 IssuerRegistry）
 * - credential-w3c（簽發/驗證 W3C VC，JWT/ES256K）
 * 金鑰僅存記憶體（MemoryPrivateKeyStore），不落地、不入庫。
 */
export function createVeramoAgent() {
  const ethrNetworks = [
    {
      name: config.ethrNetwork,
      chainId: config.ethrChainId,
      rpcUrl: config.amoyRpcUrl,
    },
  ];

  return createAgent<ChainTrustPlugins>({
    plugins: [
      new KeyManager({
        store: new MemoryKeyStore(),
        kms: {
          [KMS]: new KeyManagementSystem(new MemoryPrivateKeyStore()),
        },
      }),
      new DIDManager({
        store: new MemoryDIDStore(),
        defaultProvider: "did:key",
        providers: {
          "did:key": new KeyDIDProvider({ defaultKms: KMS }),
          "did:ethr": new EthrDIDProvider({
            defaultKms: KMS,
            networks: ethrNetworks,
          }),
        },
      }),
      new DIDResolverPlugin({
        resolver: new Resolver({
          ...keyDidResolver(),
          ...ethrDidResolver({ networks: ethrNetworks }),
        }),
      }),
      new CredentialPlugin(),
    ],
  });
}

/** 建立 Issuer DID（did:key + Secp256k1，可離線解析且能推導 ETH 位址） */
export async function createIssuerDid(agent: ChainTrustAgent, alias = "issuer") {
  return agent.didManagerCreate({
    alias,
    provider: "did:key",
    options: { keyType: "Secp256k1" },
  });
}

// ── 固定金鑰的發證者 ────────────────────────────────────────
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
  let prefix = "";
  for (const b of bytes) {
    if (b !== 0) break;
    prefix += "1";
  }
  return prefix + digits.reverse().map((d) => B58[d]).join("");
}

/** 檢查並正規化 Secp256k1 私鑰（0x 前綴可有可無，必須是 32 bytes hex） */
function normalizePrivateKey(raw: string): string {
  const hex = raw.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("發證者私鑰格式不合法：需為 32 bytes 的 hex（可帶 0x 前綴）");
  }
  return hex.toLowerCase();
}

/** 由 Secp256k1 私鑰推 did:key（multicodec 0xe701 + 壓縮公鑰，base58btc） */
export function didKeyFromSecp256k1PrivateKey(privateKey: string): string {
  const sk = new SigningKey("0x" + normalizePrivateKey(privateKey));
  const compressed = Buffer.from(sk.compressedPublicKey.slice(2), "hex");
  return "did:key:z" + base58btcEncode(new Uint8Array([0xe7, 0x01, ...compressed]));
}

/**
 * 取得發證者 DID：有提供私鑰就匯入（DID 固定），沒有就隨機產生一把（只存記憶體）。
 *
 * 為什麼要能固定：
 *  1. **鏈上撤銷**：RevocationRegistry 以「送交易者位址」作為撤銷命名空間（H12 修正），
 *     驗證端則以「憑證簽發者位址」查詢。兩者必須是同一把金鑰，撤銷才會生效——
 *     隨機產生的 Veramo 金鑰無法拿去簽以太坊交易，撤銷會寫進別人的格子裡、永遠查不到。
 *  2. **重啟不失效**：隨機金鑰每次重啟都換，已發出的憑證全部變成「發證者未受信任」。
 *     免費 PaaS 閒置就休眠，demo 中途睡一次，評審手上的憑證就作廢。
 */
export async function resolveIssuerDid(
  agent: ChainTrustAgent,
  alias: string,
  privateKey?: string
) {
  if (!privateKey) return createIssuerDid(agent, alias);
  const hex = normalizePrivateKey(privateKey);
  const sk = new SigningKey("0x" + hex);
  const publicKeyHex = sk.compressedPublicKey.slice(2);
  return agent.didManagerImport({
    did: didKeyFromSecp256k1PrivateKey(hex),
    provider: "did:key",
    alias,
    keys: [
      {
        kid: publicKeyHex,
        kms: KMS,
        type: "Secp256k1",
        privateKeyHex: hex,
        publicKeyHex,
      },
    ],
  } as Parameters<ChainTrustAgent["didManagerImport"]>[0]);
}

/** 建立 Holder DID（did:key，錢包持有者） */
export async function createHolderDid(agent: ChainTrustAgent, alias = "holder") {
  return agent.didManagerCreate({
    alias,
    provider: "did:key",
    options: { keyType: "Secp256k1" },
  });
}
