import express from "express";
import { createVeramoAgent, resolveIssuerDid } from "./agent.js";
import {
  InMemoryChainGateway,
  EthersChainGateway,
  loadDeployment,
  type ChainGateway,
} from "./chain/gateway.js";
import { issueKYCCredential, issueMobileRealNameCredential, revocationKeyOf } from "./issuer.js";
import { verifyCredential, verifyAndScore } from "./verifier.js";
import {
  issueKycSdJwt,
  issueReputationSdJwt,
  presentKycWithKeyBinding,
  verifyKycSdJwtPresentation,
  verifyReputationSdJwtPresentation,
  isValidHolderDid,
} from "./sdjwt.js";
import { randomUUID, timingSafeEqual } from "crypto";
import { scoreTransaction, fetchMetrics, warmUpFraudService } from "./fraud.js";
import { issuerAddressFromIdentifier } from "./credentialHash.js";
import { TX_SCENARIOS, isScenarioId, type ScenarioId } from "./scenarios.js";
import { config } from "./config.js";
import type { IIdentifier } from "@veramo/core";

/**
 * Issuer/Verifier HTTP 服務（PoC）。
 * 啟動時建立一個示範 Issuer DID 並由（記憶體）信任根背書，方便前端/curl 直接試。
 */
/** 以指定私鑰建立 ethers 閘道（無私鑰＝唯讀）。 */
function ethersGateway(privateKey?: string): EthersChainGateway {
  // 部署檔網路名不再寫死 "amoy"：切到 CHT BaaS 或其他測試網時，
  // 讀到另一條鏈的合約位址只會靜默回 false，不會有人發現。
  const net = config.deploymentNetwork;
  const dep = loadDeployment(net);
  if (!dep) throw new Error(`CHAIN_MODE=ethers 但缺 deployments/${net}.json`);
  return new EthersChainGateway({
    rpcUrl: config.amoyRpcUrl,
    issuerRegistry: dep.contracts.IssuerRegistry,
    revocationRegistry: dep.contracts.RevocationRegistry,
    privateKey,
    expectedChainId: config.ethrChainId,
  });
}

async function buildChain(): Promise<ChainGateway> {
  // 主閘道以信任根 owner 金鑰簽（setTrustedIssuer）；撤銷另由各發證者自己的金鑰送出，見 buildRevokers
  if (config.chainMode === "ethers") return ethersGateway(config.chainPrivateKey);
  return new InMemoryChainGateway();
}

/** 發證者識別：bank = 銀行 A（KYC）、cht = 中華電信（門號實名、繳費信譽） */
type IssuerKey = "bank" | "cht";
type Revoker = (credentialHash: string) => Promise<void>;

/**
 * 每個發證者各自的撤銷器。
 *
 * RevocationRegistry 以 msg.sender 為撤銷命名空間（H12 修正），驗證端以「憑證簽發者位址」查詢，
 * 所以撤銷交易**必須**由簽發該憑證的那把金鑰送出。舊版一律用 CHAIN_PRIVATE_KEY 送，
 * 撤銷寫進部署者的格子，驗證端查發證者的格子——撤銷永遠不生效；memory 模式則因為從沒
 * 呼叫 setRevokeAs() 直接回 500。
 */
function buildRevokers(
  chain: ChainGateway,
  issuers: Record<IssuerKey, { addr: string; privateKey?: string }>
): Record<IssuerKey, Revoker | null> {
  if (chain instanceof InMemoryChainGateway) {
    const asIssuer = (addr: string): Revoker => async (hash) => {
      // setRevokeAs 與 revoke 之間沒有 await，同步完成，不會被其他請求插隊
      chain.setRevokeAs(addr);
      await chain.revoke(hash);
    };
    return { bank: asIssuer(issuers.bank.addr), cht: asIssuer(issuers.cht.addr) };
  }
  const forKey = (k: IssuerKey): Revoker | null => {
    const key = issuers[k].privateKey;
    if (!key) return null;
    const g = key === config.chainPrivateKey ? chain : ethersGateway(key);
    return (hash) => g.revoke(hash);
  };
  return { bank: forKey("bank"), cht: forKey("cht") };
}

/**
 * 建立 express app（不 listen）。抽出來讓 HTTP 層可被測試覆蓋：
 * API key 守門、nonce 一次性、驗證政策強制等都在這一層，先前完全沒有自動化測試。
 */
export async function createApp(): Promise<{ app: express.Express; issuer: IIdentifier; chain: ChainGateway }> {
  const agent = createVeramoAgent();
  const chain = await buildChain();
  // 發證者金鑰：有設 ISSUER_PRIVATE_KEY / CHT_ISSUER_PRIVATE_KEY 就固定（重啟不換 DID），
  // 沒設就隨機產生（只存記憶體，重啟必換）。
  const issuer = await resolveIssuerDid(agent, "issuer", config.issuerPrivateKey);
  const issuerAddr = issuerAddressFromIdentifier(issuer);
  // 第二發證者：中華電信（門號實名、繳費信譽）——雙簽發者＝多機構信任網路最小示範
  const issuerCht = await resolveIssuerDid(agent, "issuer-cht-mobile", config.chtIssuerPrivateKey);
  const issuerChtAddr = issuerAddressFromIdentifier(issuerCht);
  console.log(
    `[issuer-verifier] 發證者 DID：銀行 A ${config.issuerPrivateKey ? "固定" : "隨機（重啟會換）"}、` +
      `中華電信 ${config.chtIssuerPrivateKey ? "固定" : "隨機（重啟會換）"}`
  );
  const revokers = buildRevokers(chain, {
    bank: { addr: issuerAddr, privateKey: config.issuerPrivateKey },
    cht: { addr: issuerChtAddr, privateKey: config.chtIssuerPrivateKey },
  });
  // 自動背書示範 issuer（信任根狀態在 memory 模式只存記憶體，每次啟動都要重設）。
  // memory 模式直接設；ethers 模式需 CHAIN_PRIVATE_KEY 為 IssuerRegistry owner（PoC 中即 deployer）。
  if (config.chainMode === "memory") {
    await chain.setTrustedIssuer(issuerAddr, true);
    await chain.setTrustedIssuer(issuerChtAddr, true);
  } else if (config.chainPrivateKey) {
    try {
      await chain.setTrustedIssuer(issuerAddr, true);
      await chain.setTrustedIssuer(issuerChtAddr, true);
      console.log(`[issuer-verifier] 已於鏈上背書示範 issuer ${issuerAddr} / ${issuerChtAddr}`);
    } catch (e) {
      console.warn(
        `[issuer-verifier] 鏈上背書示範 issuer 失敗（CHAIN_PRIVATE_KEY 非 IssuerRegistry owner？）。` +
          `驗證將因 trustedIssuer=false 失敗，可改用 smoke:amoy 的 TRUST_ISSUER=${issuerAddr} 手動背書。`,
        e
      );
    }
  } else {
    console.warn(
      `[issuer-verifier] CHAIN_MODE=ethers 且未設 CHAIN_PRIVATE_KEY（唯讀）：` +
        `示範 issuer ${issuerAddr} 未受鏈上信任，簽發後驗證會失敗；撤銷端點亦不可用。`
    );
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // CORS：由 env CORS_ORIGIN 收斂（預設僅錢包前端），不再用萬用 *
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", config.corsOrigin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // 500 統一處理：記錄完整錯誤、對外只回通用碼（不外洩內部訊息）
  const serverError = (res: express.Response, e: unknown) => {
    console.error("[issuer-verifier] internal error:", e);
    res.status(500).json({ error: "internal_error" });
  };

  // mutating 端點守門（fail-closed）。
  //
  // 舊版是「沒設 API_KEY 就放行」，只要部署時忘了設環境變數，/issue/kyc、
  // /sdjwt/issue、/revoke 等端點就完全公開 —— 任何人都能簽發假 KYC 憑證，
  // 或撤銷他人的有效憑證。現在改為：沒有 API_KEY 就停用這些端點，除非在
  // 離線 PoC（CHAIN_MODE=memory）下明確設定 ALLOW_UNAUTHENTICATED_DEV=true。
  const devBypass = config.allowUnauthenticatedDev && config.chainMode === "memory";
  if (!config.apiKey) {
    if (devBypass) {
      console.warn(
        "[issuer-verifier] 警告：未設 API_KEY 且 ALLOW_UNAUTHENTICATED_DEV=true，" +
          "簽發／撤銷端點目前無需驗證。僅限本機開發，切勿用於任何對外部署。"
      );
    } else {
      console.warn(
        "[issuer-verifier] 未設定 API_KEY：簽發／撤銷端點已停用（回 503）。" +
          "請設定 API_KEY，或在本機 PoC 下設 ALLOW_UNAUTHENTICATED_DEV=true。"
      );
    }
  }

  const requireApiKey: express.RequestHandler = (req, res, next) => {
    if (!config.apiKey) {
      if (devBypass) return next();
      return res.status(503).json({ error: "issuing_disabled_no_api_key" });
    }
    const provided = req.header("X-API-Key") ?? "";
    // 定長比較，避免以回應時間逐字元猜測金鑰
    const a = Buffer.from(provided);
    const b = Buffer.from(config.apiKey);
    if (a.length === b.length && timingSafeEqual(a, b)) return next();
    return res.status(401).json({ error: "unauthorized" });
  };

  // /health：存活狀態 + issuer DID。
  //
  // issuer DID 是刻意公開的：SSI 的信任根本來就該可公開查核（等同 CA 憑證），
  // 且 C1/C2 修復後，知道受信任 issuer 是誰並不能幫助攻擊者偽造憑證。
  // 但第二發證者位址、chainMode 等營運細節仍收斂到需鑑權的 /info。
  app.get("/health", (_req, res) => {
    res.json({ ok: true, issuerDid: issuer.did });
  });

  app.get("/info", requireApiKey, (_req, res) => {
    res.json({
      ok: true,
      chainMode: config.chainMode,
      issuerDid: issuer.did,
      issuerAddr,
      chtIssuerDid: issuerCht.did,
      chtIssuerAddr: issuerChtAddr,
    });
  });

  // ── SD-JWT（M2.0/M2.2 錢包用）──
  // 簽發 SD-JWT KYCCredential。holderDid 必填且由錢包在瀏覽器端推導（金鑰自主）；
  // 伺服器不再代建持有者 DID。
  app.post("/sdjwt/issue", requireApiKey, async (req, res) => {
    try {
      const { holderDid, subject } = req.body ?? {};
      if (!holderDid) return res.status(400).json({ error: "缺 holderDid（請由錢包本機金鑰推導）" });
      if (!isValidHolderDid(holderDid))
        return res.status(400).json({ error: "holderDid 不是合法的 did:key（Secp256k1）" });
      const vc = await issueKycSdJwt({ issuer, holderDid, subject }, agent);
      res.json({ vc, holderDid, issuerDid: issuer.did });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // 普惠金融：以電信繳費紀錄簽發 FinancialReputationCredential（SD-JWT）
  app.post("/sdjwt/issue-reputation", requireApiKey, async (req, res) => {
    try {
      // holderDid 必填，與 /sdjwt/issue 一致。
      // 舊版在缺 holderDid 時由伺服器代建 DID —— 那條路徑等於伺服器代管持有者私鑰，
      // 與「金鑰自主」的主張直接矛盾，也是稽核列出的殘留代管路徑，此處一併關閉。
      const { holderDid, msisdn } = req.body ?? {};
      if (!holderDid) return res.status(400).json({ error: "缺 holderDid（請由錢包本機金鑰推導）" });
      if (!isValidHolderDid(holderDid))
        return res.status(400).json({ error: "holderDid 不是合法的 did:key（Secp256k1）" });
      // 繳費信譽來自電信帳務 → 由中華電信發證者簽（錢包畫面也標示「發證方：中華電信」）。
      // 舊版誤用銀行 A 的 issuer，與 KYC 憑證顯示同一個 DID，和畫面敘述矛盾。
      const vc = await issueReputationSdJwt({ issuer: issuerCht, holderDid, msisdn }, agent);
      res.json({ vc, holderDid, issuerDid: issuerCht.did });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // 階段 B：驗證方核發一次性 nonce（防重放）。aud = 本驗證方識別。
  //
  // 舊版是永不清理、無上限的 Set：任何人迴圈打未鑑權的 /sdjwt/nonce 即可耗盡記憶體，
  // 且舊 nonce 永久有效。改為帶到期時間的 Map + 容量上限 + 惰性清掃。
  const VERIFIER_AUD = config.verifierAud;
  const NONCE_TTL_MS = 5 * 60_000;
  const NONCE_MAX = 10_000;
  const issuedNonces = new Map<string, number>();

  const sweepNonces = () => {
    const now = Date.now();
    for (const [n, exp] of issuedNonces) if (exp <= now) issuedNonces.delete(n);
  };
  /** 原子取用：檢查與刪除一次完成，避免兩個併發請求帶同一 nonce 同時通過（TOCTOU） */
  const consumeNonce = (nonce: unknown): boolean => {
    if (typeof nonce !== "string") return false;
    const exp = issuedNonces.get(nonce);
    if (exp == null) return false;
    issuedNonces.delete(nonce); // 無論後續驗證成敗都消耗，失敗的 nonce 不可重試
    return exp > Date.now();
  };

  app.post("/sdjwt/nonce", (_req, res) => {
    sweepNonces();
    if (issuedNonces.size >= NONCE_MAX) {
      return res.status(429).json({ error: "too_many_pending_nonces" });
    }
    const nonce = randomUUID();
    issuedNonces.set(nonce, Date.now() + NONCE_TTL_MS);
    res.json({ nonce, aud: VERIFIER_AUD });
  });

  // 【LEGACY，預設關閉】伺服器代簽 KB 的出示。
  //
  // 這是一台簽章機：接受任意 holderDid/vc/aud/nonce，用伺服器持有的私鑰簽 KB-JWT。
  // 未鑑權開放時，任何人只要知道一個伺服器代管的 holder DID，就能對任何驗證方
  // 索取合法 KB-JWT —— 正好把 key binding 要防的「出示被轉手」還原回去。
  // 錢包已改為瀏覽器端本機金鑰簽 KB（packages/wallet/src/keys.ts），前端不再使用此端點。
  if (config.enableLegacyPresent) {
    console.warn(
      "[issuer-verifier] ENABLE_LEGACY_PRESENT=1：/sdjwt/present 已啟用（伺服器代簽），僅供 e2e，勿用於正式環境"
    );
    app.post("/sdjwt/present", requireApiKey, async (req, res) => {
      try {
        const { vc, holderDid, revealKeys, aud, nonce } = req.body ?? {};
        if (!vc || !holderDid) return res.status(400).json({ error: "缺 vc 或 holderDid" });
        const holder = await agent.didManagerGet({ did: holderDid });
        const presentation = await presentKycWithKeyBinding(
          agent,
          holder,
          vc,
          revealKeys ?? ["kycLevel"],
          { aud: aud ?? VERIFIER_AUD, nonce: nonce ?? "" }
        );
        res.json({ presentation });
      } catch (e: any) {
        serverError(res, e);
      }
    });
  }

  // 驗證 SD-JWT 出示（含 key binding）+ AI 風險評分 → 綜合 outcome
  app.post("/sdjwt/verify", async (req, res) => {
    try {
      const { presentation, kind, scenario } = req.body ?? {};
      if (typeof presentation !== "string" || presentation.length === 0) {
        return res.status(400).json({ error: "缺 presentation（需為字串）" });
      }
      if (kind != null && kind !== "kyc" && kind !== "reputation") {
        return res.status(400).json({ error: "kind 僅接受 kyc 或 reputation" });
      }
      // 交易脈絡由驗證方決定，不收出示者自己報的數值（H9）。見 src/scenarios.ts。
      if ((req.body ?? {}).tx !== undefined) {
        return res.status(400).json({
          error: "不接受 tx：交易脈絡由驗證方伺服器決定，請改傳 scenario（normal / mule / microloan）",
        });
      }
      if (scenario != null && !isScenarioId(scenario)) {
        return res.status(400).json({ error: `scenario 僅接受：${Object.keys(TX_SCENARIOS).join(" / ")}` });
      }
      const scenarioId: ScenarioId = scenario ?? (kind === "reputation" ? "microloan" : "normal");
      // nonce 為必要項且必須是本方核發、未過期、未用過。
      //
      // 舊版把 requireKeyBinding / expectedNonce / expectedAud 交給 request body 決定：
      // 攻擊者只要不傳這些欄位，KB 必驗與 nonce 防重放就整段被跳過，
      // 任何側錄到的出示都能無限重放。驗證政策現在完全由伺服器決定。
      const nonce = (req.body ?? {}).nonce;
      if (!consumeNonce(nonce)) {
        return res.json({
          verify: { ok: false, checks: {}, disclosed: [], withheld: [], reason: "nonce 無效、已過期或已使用" },
          outcome: "reject",
        });
      }
      const kbOpts = { expectedAud: VERIFIER_AUD, expectedNonce: nonce as string };
      // kind=reputation → 普惠信譽述詞（reputationTier>=2）；預設 KYC 述詞（kycLevel>=2）
      const verify =
        kind === "reputation"
          ? await verifyReputationSdJwtPresentation(chain, presentation, { minTier: 2, ...kbOpts })
          : await verifyKycSdJwtPresentation(chain, presentation, { minKycLevel: 2, ...kbOpts });
      let risk;
      let outcome: "approve" | "review" | "reject" = "reject";
      if (verify.ok) {
        risk = await scoreTransaction({ ...TX_SCENARIOS[scenarioId] });
        outcome = risk.decision === "block" ? "reject" : risk.decision === "review" ? "review" : "approve";
      }
      res.json({ verify, risk, outcome, scenario: scenarioId });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // （已移除）POST /holder：未鑑權即可在伺服器端產生持有者金鑰——既與「金鑰自主、伺服器不代管」
  // 的主張矛盾，也讓任何人迴圈呼叫就能無限增長記憶體。錢包一律在瀏覽器端自產金鑰。

  // 簽發 KYC VC
  app.post("/issue/kyc", requireApiKey, async (req, res) => {
    try {
      const { holderDid, subject } = req.body ?? {};
      if (!holderDid) return res.status(400).json({ error: "缺 holderDid" });
      if (!isValidHolderDid(holderDid))
        return res.status(400).json({ error: "holderDid 不是合法的 did:key（Secp256k1）" });
      const vc = await issueKYCCredential(agent, { issuerDid: issuer.did, holderDid, subject });
      res.json({ vc, revocationKey: revocationKeyOf(vc) });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // 簽發 門號實名 VC
  app.post("/issue/mobile", requireApiKey, async (req, res) => {
    try {
      const { holderDid, msisdn } = req.body ?? {};
      if (!holderDid || !msisdn) return res.status(400).json({ error: "缺 holderDid 或 msisdn" });
      if (!isValidHolderDid(holderDid))
        return res.status(400).json({ error: "holderDid 不是合法的 did:key（Secp256k1）" });
      const vc = await issueMobileRealNameCredential(agent, {
        issuerDid: issuerCht.did, // 第二發證者：中華電信門號電子卡
        holderDid,
        msisdn,
      });
      res.json({ vc, revocationKey: revocationKeyOf(vc) });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // 驗證 VC
  app.post("/verify", async (req, res) => {
    try {
      const { vc } = req.body ?? {};
      if (!vc) return res.status(400).json({ error: "缺 vc" });
      const result = await verifyCredential(agent, chain, vc);
      res.json(result);
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // 驗證 + AI 風險評分（M2.1 整合）：{ vc, tx } → { 驗證結果 + risk + outcome }
  app.post("/verify-and-score", async (req, res) => {
    try {
      const { vc, tx } = req.body ?? {};
      if (!vc) return res.status(400).json({ error: "缺 vc" });
      const result = await verifyAndScore(agent, chain, vc, tx ?? {});
      res.json(result);
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // 純風險評分代理（轉呼叫 ai-service /score）
  app.post("/score", async (req, res) => {
    try {
      res.json(await scoreTransaction(req.body ?? {}));
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // AI 模型評估報告代理（PR-AUC / 校準 / 基線 / CHT 增益）→ 前端可信度報告
  app.get("/metrics", async (_req, res) => {
    try {
      res.json(await fetchMetrics());
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // 撤銷 VC。issuer 指定由哪個發證者撤銷（預設 bank）——撤銷只對「該發證者簽發的憑證」生效。
  app.post("/revoke", requireApiKey, async (req, res) => {
    try {
      const { revocationKey, issuer: who = "bank" } = req.body ?? {};
      if (typeof revocationKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(revocationKey)) {
        return res.status(400).json({ error: "revocationKey 需為 0x 開頭的 bytes32" });
      }
      if (who !== "bank" && who !== "cht") {
        return res.status(400).json({ error: "issuer 僅接受 bank 或 cht" });
      }
      const revoke = revokers[who as IssuerKey];
      if (!revoke) {
        return res.status(501).json({
          error: "revocation_unavailable_for_issuer",
          detail:
            who === "bank"
              ? "未設定 ISSUER_PRIVATE_KEY（或 CHAIN_PRIVATE_KEY），無法以發證者身分送出撤銷交易"
              : "未設定 CHT_ISSUER_PRIVATE_KEY，無法以中華電信發證者身分送出撤銷交易",
        });
      }
      await revoke(revocationKey);
      res.json({
        revoked: true,
        revocationKey,
        issuer: who,
        issuerAddr: who === "bank" ? issuerAddr : issuerChtAddr,
      });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  return { app, issuer, chain };
}

async function main() {
  // fail-closed：非開發環境缺 API_KEY 直接拒絕啟動，而不是靜默放行簽發／撤銷端點。
  if (config.nodeEnv !== "development" && !config.apiKey) {
    console.error(
      `[issuer-verifier] NODE_ENV=${config.nodeEnv} 但未設 API_KEY：` +
        "簽發與撤銷端點將無保護，拒絕啟動。請設定 API_KEY 環境變數。"
    );
    process.exit(1);
  }
  const { app, issuer } = await createApp();

  // AI 服務暖機：不阻塞啟動（免費方案冷啟動要數十秒，await 它會拖垮自己的
  // 健康檢查）。純盡力而為，失敗只記一行日誌。
  if (config.aiWarmupTimeoutMs > 0) {
    void warmUpFraudService().then((ok) => {
      console.log(`[issuer-verifier] AI 服務暖機${ok ? "成功" : "未成功（將於首次評分時重試）"}：${config.aiServiceUrl}`);
    });
  }
  // 選用的 keepalive：demo 進行中避免 AI 服務因閒置而休眠。
  if (config.aiKeepaliveMs > 0) {
    setInterval(() => void warmUpFraudService({ timeoutMs: 20000 }), config.aiKeepaliveMs).unref();
    console.log(`[issuer-verifier] AI 服務 keepalive 已啟用：每 ${config.aiKeepaliveMs} ms`);
  }

  app.listen(config.port, () => {
    console.log(`[issuer-verifier] 服務啟動 http://localhost:${config.port}`);
    console.log(`[issuer-verifier] chainMode=${config.chainMode} issuer=${issuer.did}`);
    console.log(`[issuer-verifier] CORS=${config.corsOrigin}`);
    if (!config.apiKey) {
      const bypass = config.allowUnauthenticatedDev && config.chainMode === "memory";
      console.warn(
        bypass
          ? "[issuer-verifier] ⚠ 未設 API_KEY 且 ALLOW_UNAUTHENTICATED_DEV=true：簽發/撤銷端點無需驗證，僅限本機 PoC"
          : "[issuer-verifier] ⚠ 未設 API_KEY：簽發/撤銷端點一律回 503（fail-closed）。請設 .env API_KEY 才能使用"
      );
    }
  });
}

// 僅在直接執行時啟動伺服器；被 import（測試）時不啟動
if (process.env.VITEST !== "true") {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
