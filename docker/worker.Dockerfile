# ───────────────────────────────────────────────────────────────────────
# apps/worker — NestJS BullMQ consumer
#
# Structured identically to api.Dockerfile so Compose can run both from
# the same workspace install, but without HTTP exposure — the worker
# only consumes Redis queues and talks to Postgres + MinIO via the
# internal compose network.
# ───────────────────────────────────────────────────────────────────────
FROM node:25-alpine AS base
RUN apk add --no-cache libc6-compat openssl tini
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /repo

# ───── deps ─────
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* .npmrc* ./
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
COPY packages/config/package.json ./packages/config/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod=false

# ───── build ─────
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
RUN pnpm --filter @weavestream/db prisma:generate \
 && pnpm --filter @weavestream/shared build \
 && pnpm --filter @weavestream/db build \
 && pnpm --filter @weavestream/worker build

# Prune dev deps for the runner. CI=true tells pnpm 10 it's safe to
# remove/recreate node_modules non-interactively.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    CI=true pnpm install --frozen-lockfile --prod

# ───── runner ─────
FROM node:25-alpine AS runner
RUN apk add --no-cache libc6-compat openssl tini \
 && addgroup -S app && adduser -S app -G app

ARG WEAVESTREAM_VERSION=dev
ENV NODE_ENV=production \
    WEAVESTREAM_VERSION=${WEAVESTREAM_VERSION}
LABEL org.opencontainers.image.source="https://github.com/Weavestream/Weavestream" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${WEAVESTREAM_VERSION}"
WORKDIR /app

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/db/node_modules ./packages/db/node_modules
COPY --from=build /repo/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /repo/packages/db/dist ./packages/db/dist
COPY --from=build /repo/packages/db/package.json ./packages/db/package.json
COPY --from=build /repo/packages/db/prisma ./packages/db/prisma
COPY --from=build /repo/apps/worker/dist ./apps/worker/dist
COPY --from=build /repo/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /repo/apps/worker/node_modules ./apps/worker/node_modules

USER app
WORKDIR /app/apps/worker
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "process.exit(0)" || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/worker/src/main.js"]
