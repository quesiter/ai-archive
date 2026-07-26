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
COPY apps/server apps/server
COPY apps/web apps/web
RUN pnpm --filter @ai-archive/contracts build \
  && pnpm --filter @ai-archive/web build \
  && pnpm --filter @ai-archive/server build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/contracts ./packages/contracts
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/server/migrations ./apps/server/migrations
COPY --from=builder /app/apps/web/dist ./apps/web/dist
WORKDIR /app/apps/server
ENV WEB_DIST=/app/apps/web/dist
EXPOSE 8080
CMD ["node", "dist/index.js"]
