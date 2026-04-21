# ───────────────────────────────────────────────────────────────────────
# apps/api — NestJS
# Multi-stage: deps → build → runner. Runner is distroless-style minimal
# node:20-alpine with a non-root user.
# ───────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS base
# `vips` is sharp's runtime dependency. `vips-dev` + `build-base` +
# `python3` + `node-gyp` are only needed at build time so sharp can
# compile its native bindings from source when pnpm's prebuilt binary
# resolution skips the current arch (the current lockfile, generated
# on darwin-arm64, does not always hydrate @img/sharp-linuxmusl-*
# under pnpm 9's optional-dep filtering). The runner stage installs
# just `vips` so the final image stays slim.
RUN apk add --no-cache \
      libc6-compat openssl tini \
      vips vips-dev build-base python3
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && npm install -g node-gyp

WORKDIR /repo

# ───── deps ─────
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
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

# Prune dev deps for the runner.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ───── runner ─────
FROM node:20-alpine AS runner
# `vips` (not `vips-dev`) — runtime only. sharp's compiled bindings
# come over from the build stage via node_modules.
RUN apk add --no-cache libc6-compat openssl tini curl vips \
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

USER app
WORKDIR /app/apps/api
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:4000/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
