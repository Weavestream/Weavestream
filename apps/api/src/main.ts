// SPDX-License-Identifier: AGPL-3.0-or-later

import './load-env.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { AppModule } from './app.module.js';
import { ProblemExceptionFilter } from './common/problem-exception.filter.js';
import { EnvService } from './config/env.service.js';
import { configureEgressGuard } from './common/egress/safe-fetch.js';
import { AuditLogService } from './audit/audit.service.js';
import { AUDIT_ACTIONS } from './audit/audit-actions.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const env = app.get(EnvService).values;

  // Trust N upstream hops from the configured topology. The Next.js
  // `web` container acts as the reverse proxy for browser → API traffic
  // (1 hop, default). A Traefik/Caddy edge or a CDN like Cloudflare in
  // front of compose adds more hops — set `TRUST_PROXY_HOPS=2` or `3`
  // accordingly. Express resolves `req.ip` to the (N+1)th entry from
  // the right of the verified `X-Forwarded-For` chain; every IP-based
  // control in the API (rate limiting, login lockouts, audit attribution)
  // reads from `req.ip` only, so this knob is the single source of
  // truth. Without it Express returns its own socket peer
  // (`192.168.160.x` in Docker) and collapses every SSR call into a
  // single throttler bucket. `X-Forwarded-Proto` is also respected so
  // `req.secure` is correct when the edge terminates TLS.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  // Phase 6 — wire the egress / SSRF guard. Every server-side outbound
  // HTTP call goes through `safeFetch`, which refuses to dial private
  // / loopback / link-local / metadata addresses unless the operator
  // has explicitly allow-listed them. Each refusal lands in the audit
  // log as `security.egress.blocked` so the Security Center can show
  // recent attempts.
  const audit = app.get(AuditLogService);
  configureEgressGuard({
    allowPrivateNetworks: env.EGRESS_ALLOW_PRIVATE_NETWORKS,
    allowedPrivateCidrs: env.EGRESS_ALLOWED_PRIVATE_CIDRS,
    onBlocked: (info) => {
      void audit
        .log({
          actorId: null,
          action: AUDIT_ACTIONS.security.egressBlocked,
          entityType: 'Egress',
          entityId: null,
          ip: '127.0.0.1',
          userAgent: 'system/egress-guard',
          before: null,
          after: {
            url: info.url,
            hostname: info.hostname,
            resolvedIps: info.resolvedIps,
            reason: info.reason,
            matchedCidr: info.matchedCidr,
          },
        })
        .catch((err: unknown) => {
          // Never let audit-log failures shadow the original block.
          // eslint-disable-next-line no-console
          console.error('Failed to audit egress block:', err);
        });
    },
  });

  // Use the `simple` query parser (Node's built-in `querystring`) instead
  // of Express's default `extended` parser (`qs`). The extended parser
  // turns `?foo[$ne]=x` into the object `{foo: {$ne: 'x'}}`, which would
  // pass straight through any controller that forwards a query value
  // into a Prisma `where` clause without explicit type checking — the
  // classic NoSQL/operator-injection vector. The simple parser keeps
  // every value as a string (or string array for repeated keys), which
  // is the only shape any of our callers ever send anyway. This is a
  // global belt for the per-controller braces (Zod schemas, ParseUUID,
  // ZodParam) and closes the class even for any future endpoint that
  // forgets to validate.
  app.set('query parser', 'simple');

  // The API only emits `application/json`; it never serves HTML, scripts,
  // styles, or framed content. A deny-all CSP is the correct posture here
  // and provides defense-in-depth if a response is ever mis-rendered as
  // HTML by a buggy client. The browser-facing CSP (with nonces and
  // strict-dynamic) is set on HTML responses by the Next.js proxy layer
  // in `apps/web/src/proxy.ts`.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'none'"],
          'form-action': ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cookieParser(env.COOKIE_SIGNING_KEY));
  app.use(compression());

  // Express's default JSON body limit (100 KB) is too small for the kinds
  // of payloads this API legitimately handles — e.g. a Tiptap article
  // converted from a half-MB Markdown source easily clears that bound,
  // and large rich-text asset fields hit it too. We cap at 2 MB which
  // mirrors the `MAX_MARKDOWN_SOURCE` ceiling (500 KB) plus headroom for
  // its verbose Tiptap representation, while still keeping the API
  // safely bounded against unbounded payloads.
  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '2mb' });

  app.enableCors({
    origin: [env.APP_URL],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-Id'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new ProblemExceptionFilter(app.get(Logger)));

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  // Exclude the entire /health/* tree from the /api/v1 prefix so that
  // /health (public liveness), /health/ready (authenticated readiness),
  // and /health/queues (audit.read-gated) all sit at top-level paths a
  // reverse proxy / orchestrator can hit without baking in a version.
  // Note: Express paths are matched as-is — `'health'` only excludes the
  // exact path, so we pass an explicit RouteInfo for the `:path*`
  // wildcard as well.
  app.setGlobalPrefix('api', {
    exclude: ['health', 'health/(.*)'],
  });

  await app.listen(4000, '0.0.0.0');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal boot error:', err);
  process.exit(1);
});
// 1777377169
// 1777377197
