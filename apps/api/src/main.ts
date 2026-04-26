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

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const env = app.get(EnvService).values;

  // Trust a single upstream hop (the Next.js `web` container acts as the
  // reverse proxy for browser → API traffic; a Traefik/Caddy edge may
  // sit in front of it in production). Without this Express returns its
  // own socket peer (`192.168.160.x` in Docker) for `req.ip`, which
  // collapses every SSR call into a single throttler bucket and was the
  // root cause of the intermittent 429-as-404 bug. `1` is the safe
  // default for our topology; bump to `2` behind a double-proxy setup.
  // `X-Forwarded-Proto` is also respected so `req.secure` is correct
  // when the edge terminates TLS.
  app.set('trust proxy', 1);

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

  app.use(
    helmet({
      contentSecurityPolicy: false, // API returns JSON only; web layer sets CSP
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
  app.setGlobalPrefix('api', { exclude: ['health'] });

  await app.listen(4000, '0.0.0.0');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal boot error:', err);
  process.exit(1);
});
