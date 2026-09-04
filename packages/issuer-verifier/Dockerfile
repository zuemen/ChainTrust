# context = repo root（見 docker-compose.yml）
FROM node:20-slim

# pnpm 版本鎖死，跟 root package.json 的 packageManager / pnpm-lock.yaml(v9) 對齊
ARG PNPM_VERSION=9.0.0
# COREPACK_HOME 放共用路徑並開放讀取，否則 root 準備好的 pnpm，
# 切到 node 使用者後會找不到而重新下載（等於沒鎖版本）。
ENV COREPACK_HOME=/opt/corepack
RUN mkdir -p /opt/corepack \
  && corepack enable \
  && corepack prepare pnpm@${PNPM_VERSION} --activate \
  && chmod -R a+rwX /opt/corepack

# /repo 目錄本身也要屬於 node（只 COPY --chown 的話目錄仍是 root，pnpm 寫暫存檔會 EACCES）
RUN mkdir -p /repo && chown node:node /repo
WORKDIR /repo

# 複製 workspace（.dockerignore 已排除 node_modules/dist/*.sqlite）
# 直接給 node 使用者，之後所有安裝/建置都不以 root 執行
COPY --chown=node:node . /repo
USER node

# --frozen-lockfile：鎖定 pnpm-lock.yaml，相依漂移直接失敗
# --ignore-scripts：不執行相依套件的 pre/post install 腳本（供應鏈防護）。
#   本套件的相依（veramo / ethers / express / sd-jwt）皆為純 JS，
#   建置只用 tsc、執行只用 node dist/server.js，不需要任何 install 腳本。
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @chaintrust/issuer-verifier... \
  && pnpm --filter @chaintrust/issuer-verifier build

WORKDIR /repo/packages/issuer-verifier

# ⚠ 刻意不在映像裡預設 CHAIN_MODE。
#   CHAIN_MODE=memory 是「自蓋章的模擬信任根」——issuer 註冊表與撤銷狀態只存在
#   本進程記憶體，重啟即消失，任何人都能宣稱自己是可信 issuer。只適合離線 demo/e2e。
#   要跑真實信任根請設 CHAIN_MODE=ethers（見 docker-compose.yml / .env.example）。
#   應用端的預設值由 src/config.ts 決定，這裡不覆寫，才不會讓「模擬信任根」變成沉默的預設。
#
# ⚠ 同樣不預設 API_KEY。未設 API_KEY 時 /revoke、/sdjwt/issue 無保護，
#   請由 compose / .env 注入。
ENV AI_SERVICE_URL=http://ai-service:8000
ENV PORT=3001

EXPOSE 3001
CMD ["node", "dist/server.js"]
