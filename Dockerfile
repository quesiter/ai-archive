FROM node:24-bookworm-slim AS builder
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/extension apps/extension
COPY apps/openclaw-sync/package.json apps/openclaw-sync/package.json
COPY pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY docs docs
COPY apps/server apps/server
COPY apps/web apps/web
COPY release release
RUN pnpm --filter @ai-archive/contracts build \
  && pnpm --filter @ai-archive/web build \
  && pnpm --filter @ai-archive/server build \
  && pnpm --filter @ai-archive/server deploy --prod --legacy /prod/server

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /prod/server/package.json ./apps/server/package.json
COPY --from=builder /prod/server/node_modules ./apps/server/node_modules
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/server/migrations ./apps/server/migrations
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY --from=builder /app/release ./release
RUN chmod -R a+rX \
      /app/apps/server/node_modules \
      /app/apps/server/dist \
      /app/apps/server/migrations \
      /app/apps/web/dist \
      /app/release \
  && rm -rf /usr/local/lib/node_modules/npm \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/corepack \
      /usr/local/bin/pnpm \
      /usr/local/bin/pnpx \
  && mkdir -p /data/imports/inbox /data/imports/processed /data/imports/failed /data/restores \
  && chown -R node:node /data
WORKDIR /app/apps/server
ENV WEB_DIST=/app/apps/web/dist
ENV COMPONENT_RELEASE_DIR=/app/release
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
