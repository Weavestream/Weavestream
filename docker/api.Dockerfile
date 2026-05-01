# ───────────────────────────────────────────────────────────────────────
# apps/api — NestJS
# Multi-stage: deps → build → runner. Runner is distroless-style minimal
# node:24-alpine with a non-root user.
# ───────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS base
# Only runtime packages here. Sharp ships prebuilt musl binaries that
# pnpm hydrates from its store (@img/sharp-linuxmusl-*). Intentionally
# NOT installing vips-dev / build-base / python3: their presence makes
# sharp's install/check.js see a "global libvips" and attempt a source
# rebuild via node-gyp, which fails because node-addon-api isn't in
# our dep tree. Omitting them lets sharp use its vendored libvips.
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
RUN pnpm --filter @weavestream/db prisma:generate \
 && pnpm --filter @weavestream/shared build \
 && pnpm --filter @weavestream/db build \
 && pnpm --filter @weavestream/api build

# Prune dev deps for the runner. CI=true tells pnpm 10 it's safe to
# remove/recreate node_modules non-interactively (ERR_PNPM_ABORTED_REMOVE_
# MODULES_DIR_NO_TTY otherwise).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    CI=true pnpm install --frozen-lockfile --prod

# ───── runner ─────
FROM node:24-alpine AS runner
# Sharp's prebuilt binary bundles its own libvips, so no system `vips`
# package is needed at runtime — just libc6-compat + openssl + tini.
RUN apk add --no-cache libc6-compat openssl tini su-exec curl \
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
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules

# Entrypoint runs as root just long enough to chown the host
# bind-mounted file-storage dir to `app`, then drops to that
# unprivileged user via `su-exec`. The backup directory is mounted
# read-only and intentionally not touched here.
COPY docker/api-entrypoint.sh /usr/local/bin/api-entrypoint.sh
RUN chmod +x /usr/local/bin/api-entrypoint.sh
WORKDIR /app/apps/api
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:4000/health || exit 1
ENTRYPOINT ["/usr/local/bin/api-entrypoint.sh"]
CMD ["node", "dist/main.js"]
