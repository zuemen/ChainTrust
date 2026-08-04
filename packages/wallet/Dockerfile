# context = repo root（見 docker-compose.yml）
# ---------- build ----------
FROM node:20-slim AS build

# pnpm 版本鎖死，跟 root package.json 的 packageManager / pnpm-lock.yaml(v9) 對齊，
# 避免 corepack 抓到不同版本產生非預期的解析結果。
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
# 用 node 內建的非 root 使用者建置，避免 root 產物與 root 快取
COPY --chown=node:node . /repo
USER node

# --frozen-lockfile：鎖定 pnpm-lock.yaml，任何相依漂移直接失敗（供應鏈防護）
# 註：這裡沒有 --ignore-scripts —— vite 依賴 esbuild 的 postinstall 安裝平台二進位檔，
#     關掉會讓 `vite build` 直接掛掉。build stage 的產物只有 dist/ 靜態檔會進最終映像。
RUN pnpm install --frozen-lockfile --filter @chaintrust/wallet... \
  && pnpm --filter @chaintrust/wallet build

# ---------- runtime ----------
# nginx-unprivileged：master + worker 全部以非 root（uid 101 / nginx）執行，
# 監聽 8080（見 nginx.conf）。官方 nginx 映像的 master 仍是 root。
FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY packages/wallet/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/packages/wallet/dist /usr/share/nginx/html

USER 101
EXPOSE 8080
