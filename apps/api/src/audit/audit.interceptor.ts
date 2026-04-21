import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable, tap } from 'rxjs';
import { AuditLogService } from './audit.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

export const AUDIT_KEY = 'audit_action';
export const Audit = (action: string, entityType: string = 'Route') =>
  SetMetadata(AUDIT_KEY, { action, entityType });

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditLogService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<{ action: string; entityType: string }>(
      AUDIT_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!meta) return next.handle();

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    const ip = req.ip ?? '0.0.0.0';
    const ua = (req.headers['user-agent'] ?? 'unknown').toString();

    return next.handle().pipe(
      tap({
        next: async () => {
          await this.audit.log({
            actorId: req.user?.id ?? null,
            action: meta.action,
            entityType: meta.entityType,
            entityId: null,
            ip,
            userAgent: ua,
            before: null,
            after: null,
          });
        },
      }),
    );
  }
}
