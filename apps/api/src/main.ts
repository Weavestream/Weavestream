// SPDX-License-Identifier: AGPL-3.0-or-later
import './load-env.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { AppModule } from './app.module.js';
import { ProblemExceptionFilter } from './common/problem-exception.filter.js';
import { EnvService } from './config/env.service.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const env = app.get(EnvService).values;

  app.use(
    helmet({
      contentSecurityPolicy: false, // API returns JSON only; web layer sets CSP
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cookieParser(env.COOKIE_SIGNING_KEY));
  app.use(compression());

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
