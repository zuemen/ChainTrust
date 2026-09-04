/**
 * Vercel 上的 /api 反向代理 —— 對應本機的 vite proxy 與 Docker 的 nginx。
 *
 * 為什麼需要這一層而不是直接讓瀏覽器打後端：
 *   1. **金鑰不進瀏覽器**。錢包是公開客戶端，打包進 JS bundle 或存在
 *      localStorage 的 X-API-Key 按 F12 就看得到，等於沒有金鑰。金鑰只存在
 *      Vercel 的環境變數裡，由這支 function 在伺服器端補上。
 *   2. **同源**。前端 api.ts 打的是相對路徑 /api，走同源就不需要放寬後端 CORS，
 *      CSP 也能維持 connect-src 'self'。
 *
 * 環境變數（Vercel → Settings → Environment Variables）：
 *   IV_URL   issuer-verifier 的公開網址，例如 https://chaintrust-iv.onrender.com
 *   API_KEY  issuer-verifier 的 mutating 端點金鑰（與後端那邊設的同一把）
 */

// 一律不轉發的請求標頭：hop-by-hop、以及會讓後端誤判來源／內容長度的標頭。
// X-API-Key 也在其中 —— 清掉瀏覽器自帶的同名標頭，避免前端偽造金鑰穿透代理
// （與 nginx.conf.template 的 proxy_set_header 行為一致）。
const STRIPPED = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "x-api-key",
]);

export default async function handler(req, res) {
  const target = process.env.IV_URL;
  if (!target) {
    res.status(500).json({ error: "iv_url_not_configured" });
    return;
  }

  // /api/sdjwt/verify?x=1 → /sdjwt/verify?x=1（與 vite proxy 的 rewrite 一致）
  const path = req.url.replace(/^\/api/, "") || "/";
  const url = new URL(path, target).toString();

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!STRIPPED.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
  }
  // fail-closed 的另一端：後端未設金鑰時會回 503，這裡若補一把假的只會變成
  // 更難懂的 401，所以沒設就不注入。
  if (process.env.API_KEY) headers["X-API-Key"] = process.env.API_KEY;

  // Vercel 會把 JSON body 解析成物件，轉發時要重新序列化。
  let body;
  if (req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined) {
    body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    headers["content-type"] = headers["content-type"] ?? "application/json";
  }

  try {
    const upstream = await fetch(url, { method: req.method, headers, body });
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      // 內容編碼由 fetch 解過了；安全標頭以 vercel.json 那一份為準（避免兩份
      // CSP 取交集，與 nginx 的 proxy_hide_header 同理）。
      const k = key.toLowerCase();
      if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) return;
      if (["content-security-policy", "x-frame-options"].includes(k)) return;
      res.setHeader(key, value);
    });
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) {
    console.error("[api-proxy] upstream error:", e);
    res.status(502).json({ error: "bad_gateway" });
  }
}
