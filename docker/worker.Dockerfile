# ───────────────────────────────────────────────────────────────────────
# apps/worker — NestJS BullMQ consumer
#
# Structured identically to api.Dockerfile so Compose can run both from
# the same workspace install, but without HTTP exposure — the worker
# only consumes Redis queues, talks to Postgres on the internal compose
# network, and shares a host-bind-mounted file storage directory with
# the api container.
# ───────────────────────────────────────────────────────────────────────
FROM node:26-alpine AS base
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

# Prune dev deps for the runner. CI=true tells pnpm it may
# remove/recreate node_modules non-interactively.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    CI=true pnpm install --frozen-lockfile --prod

# ───── runner ─────
FROM node:26-alpine AS runner
# `postgresql16-client` ships `pg_dump` for the scheduled Postgres
# export feature. Pinned to the same major as the `postgres:16-alpine`
# image used by the database service in compose.yml so the dump format
# stays compatible with the running server. Available in alpine 3.20+,
# which `node:24-alpine` is built on.
RUN apk add --no-cache libc6-compat openssl tini su-exec postgresql16-client \
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

# Entrypoint runs as root just long enough to chown the host
# bind-mounted storage + backup dirs to `app`, then drops to that
# unprivileged user via `su-exec`. Without this, host directories
# created by Docker (root:root) or by the operator's host user are
# unwritable from inside the container and `pg_dump` / file uploads
# fail with EACCES on the first write.
COPY docker/worker-entrypoint.sh /usr/local/bin/worker-entrypoint.sh
RUN chmod +x /usr/local/bin/worker-entrypoint.sh
WORKDIR /app/apps/worker
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "process.exit(0)" || exit 1
ENTRYPOINT ["/usr/local/bin/worker-entrypoint.sh"]
CMD ["node", "dist/worker/src/main.js"]
