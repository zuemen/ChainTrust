import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// /api 代理到 issuer-verifier（避免 CORS）。可用 IV_URL 覆寫。
const IV_URL = process.env.IV_URL ?? "http://localhost:3001";

/**
 * mutating 端點（/sdjwt/issue、/issue/mobile、/sdjwt/issue-reputation）的 API 金鑰
 * 由「代理層」注入，**不進瀏覽器**。
 *
 * 錢包是公開客戶端（public client）：任何打包進前端 bundle 或存在 localStorage 的
 * 金鑰，使用者按 F12 就看得到，等於沒有金鑰。所以 api.ts 一律不帶 X-API-Key，
 * 改由 dev 的 vite proxy（本檔）與 prod 的 nginx（nginx.conf.template）補上。
 *
 * 未設 API_KEY 時不注入 —— issuer-verifier 是 fail-closed（未設定金鑰回 503），
 * 這裡若補一個假的反而會變成 401，錯誤訊息更難懂。
 */
const API_KEY = process.env.API_KEY ?? "";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: IV_URL,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
        // http-proxy 的 headers：附加到「送往 target 的請求」，瀏覽器端看不到。
        ...(API_KEY ? { headers: { "X-API-Key": API_KEY } } : {}),
      },
    },
  },
});
