# ───────────────────────────────────────────────────────────────────────
# apps/web — Next.js 15 (App Router), non-root runner
# ───────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat tini
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# ───── deps ─────
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/web/package.json ./apps/web/
COPY packages/config/package.json ./packages/config/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod=false

# ───── build ─────
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/config ./packages/config
COPY apps/web ./apps/web
# NEXT_PUBLIC_* is baked at build time, so the version must flow into
# this stage — not just the runner.
ARG WEAVESTREAM_VERSION=dev
ENV NEXT_TELEMETRY_DISABLED=1 \
    WEAVESTREAM_VERSION=${WEAVESTREAM_VERSION} \
    NEXT_PUBLIC_APP_VERSION=${WEAVESTREAM_VERSION}
RUN pnpm --filter @weavestream/web build

# ───── runner ─────
FROM node:20-alpine AS runner
RUN apk add --no-cache tini curl \
 && addgroup -S app && adduser -S app -G app

ARG WEAVESTREAM_VERSION=dev
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    WEAVESTREAM_VERSION=${WEAVESTREAM_VERSION} \
    NEXT_PUBLIC_APP_VERSION=${WEAVESTREAM_VERSION}
LABEL org.opencontainers.image.source="https://github.com/Weavestream/Weavestream" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${WEAVESTREAM_VERSION}"
WORKDIR /app
# Preserve pnpm's workspace layout — the apps/web/node_modules symlinks
# reach into /app/node_modules/.pnpm at the repo root.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/web/.next ./apps/web/.next
COPY --from=build /repo/apps/web/public ./apps/web/public
COPY --from=build /repo/apps/web/package.json ./apps/web/package.json
COPY --from=build /repo/apps/web/next.config.js ./apps/web/next.config.js
COPY --from=build /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=build /repo/package.json ./package.json

USER app
WORKDIR /app/apps/web
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3000/login >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]
