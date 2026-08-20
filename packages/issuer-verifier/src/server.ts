import express from "express";
import { createVeramoAgent, createIssuerDid, createHolderDid } from "./agent.js";
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
} from "./sdjwt.js";
import { randomUUID, timingSafeEqual } from "crypto";
import { scoreTransaction, fetchMetrics } from "./fraud.js";
import { issuerAddressFromIdentifier } from "./credentialHash.js";
import { config } from "./config.js";

/**
 * Issuer/Verifier HTTP 服務（PoC）。
 * 啟動時建立一個示範 Issuer DID 並由（記憶體）信任根背書，方便前端/curl 直接試。
 */
async function buildChain(): Promise<ChainGateway> {
  if (config.chainMode === "ethers") {
    const dep = loadDeployment("amoy");
    if (!dep) throw new Error("CHAIN_MODE=ethers 但缺 deployments/amoy.json");
    return new EthersChainGateway({
      rpcUrl: config.amoyRpcUrl,
      issuerRegistry: dep.contracts.IssuerRegistry,
      revocationRegistry: dep.contracts.RevocationRegistry,
      privateKey: config.chainPrivateKey,
    });
  }
  return new InMemoryChainGateway();
}

async function main() {
  const agent = createVeramoAgent();
  const chain = await buildChain();
  const issuer = await createIssuerDid(agent);
  const issuerAddr = issuerAddressFromIdentifier(issuer);
  // 自動背書示範 issuer：金鑰僅存記憶體，重啟後 issuer 位址必變，須重新背書。
  // memory 模式直接設；ethers 模式需 CHAIN_PRIVATE_KEY 為 IssuerRegistry owner（PoC 中即 deployer）。
  if (config.chainMode === "memory") {
    await chain.setTrustedIssuer(issuerAddr, true);
  } else if (config.chainPrivateKey) {
    try {
      await chain.setTrustedIssuer(issuerAddr, true);
      console.log(`[issuer-verifier] 已於鏈上背書示範 issuer ${issuerAddr}`);
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

  app.get("/health", (_req, res) => {
    res.json({ ok: true, chainMode: config.chainMode, issuerDid: issuer.did, issuerAddr });
  });

  // ── SD-JWT（M2.0/M2.2 錢包用）──
  // 簽發 SD-JWT KYCCredential 給 holder（缺 holderDid 則自動建一個）
  app.post("/sdjwt/issue", requireApiKey, async (req, res) => {
    try {
      let { holderDid, subject } = req.body ?? {};
      if (!holderDid) holderDid = (await createHolderDid(agent, `holder-${Date.now()}`)).did;
      const vc = await issueKycSdJwt({ issuer, holderDid, subject }, agent);
      res.json({ vc, holderDid, issuerDid: issuer.did });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // 普惠金融：以電信繳費紀錄簽發 FinancialReputationCredential（SD-JWT）
  app.post("/sdjwt/issue-reputation", requireApiKey, async (req, res) => {
    try {
      let { holderDid, msisdn } = req.body ?? {};
      if (!holderDid) holderDid = (await createHolderDid(agent, `holder-${Date.now()}`)).did;
      const vc = await issueReputationSdJwt({ issuer, holderDid, msisdn }, agent);
      res.json({ vc, holderDid, issuerDid: issuer.did });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // 階段 B：驗證方核發一次性 nonce（防重放）。aud = 本驗證方識別。
  const VERIFIER_AUD = config.verifierAud;
  const issuedNonces = new Set<string>();
  app.post("/sdjwt/nonce", (_req, res) => {
    const nonce = randomUUID();
    issuedNonces.add(nonce);
    res.json({ nonce, aud: VERIFIER_AUD });
  });

  // 階段 B：持有者端出示（PoC：holder 金鑰在 server agent），帶 key binding
  app.post("/sdjwt/present", async (req, res) => {
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

  // 驗證 SD-JWT 出示（含 key binding）+ AI 風險評分 → 綜合 outcome
  app.post("/sdjwt/verify", async (req, res) => {
    try {
      const { presentation, tx, kind, requireKeyBinding, expectedNonce } = req.body ?? {};
      if (!presentation) return res.status(400).json({ error: "缺 presentation" });
      // 若帶 expectedNonce，驗其為本方核發且未用過（一次性）
      if (expectedNonce != null && !issuedNonces.has(expectedNonce)) {
        return res.json({
          verify: { ok: false, checks: {}, disclosed: [], withheld: [], reason: "nonce 無效或已使用" },
          outcome: "reject",
        });
      }
      const kbOpts = {
        requireKeyBinding: requireKeyBinding === true,
        expectedAud: requireKeyBinding === true ? VERIFIER_AUD : undefined,
        expectedNonce: expectedNonce ?? undefined,
      };
      // kind=reputation → 普惠信譽述詞（reputationTier>=2）；預設 KYC 述詞（kycLevel>=2）
      const verify =
        kind === "reputation"
          ? await verifyReputationSdJwtPresentation(chain, presentation, { minTier: 2, ...kbOpts })
          : await verifyKycSdJwtPresentation(chain, presentation, { minKycLevel: 2, ...kbOpts });
      if (verify.ok && expectedNonce != null) issuedNonces.delete(expectedNonce); // 消耗 nonce
      let risk;
      let outcome: "approve" | "review" | "reject" = "reject";
      if (verify.ok) {
        risk = await scoreTransaction(tx ?? {});
        outcome = risk.decision === "block" ? "reject" : risk.decision === "review" ? "review" : "approve";
      }
      res.json({ verify, risk, outcome });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // 建立一個新的 Holder DID（demo 用）
  app.post("/holder", async (_req, res) => {
    const holder = await createHolderDid(agent, `holder-${Date.now()}`);
    res.json({ did: holder.did });
  });

  // 簽發 KYC VC
  app.post("/issue/kyc", requireApiKey, async (req, res) => {
    try {
      const { holderDid, subject } = req.body ?? {};
      if (!holderDid) return res.status(400).json({ error: "缺 holderDid" });
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
      const vc = await issueMobileRealNameCredential(agent, {
        issuerDid: issuer.did,
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

  // 撤銷 VC（dev：記憶體或具私鑰的 ethers 模式）
  app.post("/revoke", requireApiKey, async (req, res) => {
    try {
      const { revocationKey } = req.body ?? {};
      if (!revocationKey) return res.status(400).json({ error: "缺 revocationKey" });
      await chain.revoke(revocationKey);
      res.json({ revoked: true, revocationKey });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  app.listen(config.port, () => {
    console.log(`[issuer-verifier] 服務啟動 http://localhost:${config.port}`);
    console.log(`[issuer-verifier] chainMode=${config.chainMode} issuer=${issuer.did}`);
    console.log(`[issuer-verifier] CORS=${config.corsOrigin}`);
    if (!config.apiKey) {
      console.warn("[issuer-verifier] ⚠ 未設 API_KEY：mutating 端點未保護（dev 模式）。正式請設 .env API_KEY");
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
