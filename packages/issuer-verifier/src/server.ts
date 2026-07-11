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
import { issueKycSdJwt, presentKycWithKeyBinding, verifyKycSdJwtPresentation } from "./sdjwt.js";
import { randomUUID } from "crypto";
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
  // 第二發證者：中華電信門號電子卡（雙簽發者＝多機構信任網路最小示範）
  const issuerCht = await createIssuerDid(agent, "issuer-cht-mobile");
  const issuerChtAddr = issuerAddressFromIdentifier(issuerCht);
  // 記憶體模式下自動背書兩個示範 issuer；
  // ethers 模式請依 docs/amoy-deploy-checklist.md 於鏈上 IssuerRegistry 背書兩個位址。
  if (config.chainMode === "memory") {
    await chain.setTrustedIssuer(issuerAddr, true);
    await chain.setTrustedIssuer(issuerChtAddr, true);
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

  // mutating 端點守門：設了 API_KEY 才強制檢查 X-API-Key（dev 未設則放行）
  const requireApiKey: express.RequestHandler = (req, res, next) => {
    if (!config.apiKey) return next();
    if (req.header("X-API-Key") === config.apiKey) return next();
    return res.status(401).json({ error: "unauthorized" });
  };

  app.get("/health", (_req, res) => {
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
      const vc = await issueKycSdJwt({ issuer, holderDid, subject }, agent);
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

  // 【LEGACY，僅供 e2e 腳本】伺服器代簽 KB 的出示。
  // 錢包已改為瀏覽器端本機金鑰簽 KB（packages/wallet/src/keys.ts），此端點不再被前端使用。
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
      const { presentation, tx, requireKeyBinding, expectedNonce } = req.body ?? {};
      if (!presentation) return res.status(400).json({ error: "缺 presentation" });
      // 若帶 expectedNonce，驗其為本方核發且未用過（一次性）
      if (expectedNonce != null && !issuedNonces.has(expectedNonce)) {
        return res.json({
          verify: { ok: false, checks: {}, disclosed: [], withheld: [], reason: "nonce 無效或已使用" },
          outcome: "reject",
        });
      }
      const verify = await verifyKycSdJwtPresentation(chain, presentation, {
        minKycLevel: 2,
        requireKeyBinding: requireKeyBinding === true,
        expectedAud: requireKeyBinding === true ? VERIFIER_AUD : undefined,
        expectedNonce: expectedNonce ?? undefined,
      });
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
