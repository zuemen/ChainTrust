import { defineConfig } from "vitest/config";

// Veramo agent + SD-JWT 相依在冷啟動時載入較久（server.test.ts 的 beforeAll
// 要動態 import 整個 server.ts），預設 10s hook timeout 在較慢的機器／CI 上
// 會誤判為失敗。放寬到 30s，不改變任何測試語意。
export default defineConfig({
  test: {
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
