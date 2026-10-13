import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { EnvService } from '../../config/env.service.js';

/**
 * The OAuth callback is a browser navigation from the provider, so a
 * guard rejection (session expired during the round-trip, missing
 * permission, non-interactive session) must land the browser on a page,
 * never on a JSON problem body. 401 goes to the login page; anything else
 * to the integrations list with the generic failure flag.
 */
@Catch()
@Injectable()
export class OAuthCallbackRedirectFilter implements ExceptionFilter {
  private readonly logger = new Logger(OAuthCallbackRedirectFilter.name);

  constructor(private readonly env: EnvService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    if (status >= 500) {
      this.logger.error({ err: (exception as Error)?.message }, 'OAuth callback failed');
    }
    const base = this.env.values.APP_URL.replace(/\/+$/, '');
    res.redirect(
      302,
      status === HttpStatus.UNAUTHORIZED
        ? `${base}/login`
        : `${base}/admin/integrations?oauth=failed`,
    );
  }
}
