import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Logger } from 'nestjs-pino';

/**
 * RFC 7807 Problem Details body.
 *
 * `detail` is always a short human-readable string so simple consumers
 * (`problem?.detail ?? problem?.title ?? 'fallback'`) keep working.
 * Structured payloads thrown by services (e.g. `{ error:
 * 'ValidationError', issues: [...] }`) are spread onto the response as
 * RFC 7807 extension members so callers that care about details can
 * branch on them — see asset-form.tsx / layout-builder.tsx
 * `handleApiError`.
 */
export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  // Extension members (RFC 7807 §3.2): `error`, `issues`, `slug`,
  // `affectedAssetCount`, `conflictingAssetId`, etc.
  [extension: string]: unknown;
}

const STATUS_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
};

@Catch()
export class ProblemExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let detail: string | undefined;
    let extensions: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        detail = payload;
      } else if (payload && typeof payload === 'object') {
        // Strip Nest's internal `statusCode` (it's duplicated in
        // `status` on the Problem body) and pull `message` out as the
        // human-readable `detail` string.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { statusCode: _drop, message, ...rest } = payload as Record<string, unknown>;
        if (typeof message === 'string') {
          detail = message;
        } else if (Array.isArray(message)) {
          detail = message.filter((m) => typeof m === 'string').join('; ');
        } else if (typeof rest['error'] === 'string') {
          // Structured payload with no `message` (e.g.
          // `{ error: 'ValidationError', issues: [...] }`). Surface a
          // stable short code as the detail so simple consumers still
          // have something to display.
          detail = String(rest['error']);
        }
        extensions = rest;
      }
    }

    // For client-sensitive statuses, avoid leaking server internals.
    if (status === 500) {
      detail = undefined;
      extensions = {};
      this.logger.error(
        { err: exception, path: req.originalUrl, method: req.method, requestId: req.id },
        'Unhandled exception',
      );
    } else if (status >= 400) {
      this.logger.warn(
        {
          status,
          path: req.originalUrl,
          method: req.method,
          requestId: req.id,
          detail,
          extensions,
        },
        'Handled exception',
      );
    }

    const body: ProblemDetail = {
      type: `https://weavestream.app/problems/${status}`,
      title: STATUS_TITLES[status] ?? 'Error',
      status,
      ...(detail ? { detail } : {}),
      instance: req.originalUrl,
      ...extensions,
    };

    res.status(status);
    res.setHeader('Content-Type', 'application/problem+json');
    res.json(body);
  }
}
