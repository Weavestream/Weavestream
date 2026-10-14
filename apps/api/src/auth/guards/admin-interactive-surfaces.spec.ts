import { ForbiddenException, type Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeySurfaceGuard } from './api-key-surface.guard.js';
import { AiSettingsController } from '../../ai/ai-settings.controller.js';
import { EmailSettingsController } from '../../email/email-settings.controller.js';
import { AlertsController } from '../../alerts/alerts.controller.js';

/**
 * Instance-admin surfaces that hold or exercise instance credentials, or pick
 * outbound destinations, are interactive-only as a whole. A write-enabled key
 * or connection passes the method-based read-only check, so the class-level
 * `@InteractiveOnly()` is the only thing keeping it out — these specs pin
 * that with the real Reflector metadata rather than a stub.
 */
const CASES: Array<[Type<unknown>, string, string, string]> = [
  [AiSettingsController, 'test', 'POST', '/api/v1/settings/ai/test'],
  [AiSettingsController, 'get', 'GET', '/api/v1/settings/ai'],
  [EmailSettingsController, 'test', 'POST', '/api/v1/settings/email/test'],
  [AlertsController, 'create', 'POST', '/api/v1/alerts'],
  [AlertsController, 'list', 'GET', '/api/v1/alerts'],
];

function ctx(controller: Type<unknown>, handler: string, method: string, path: string, user: object) {
  const req = { method, path, user };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => (controller.prototype as Record<string, unknown>)[handler],
    getClass: () => controller,
  } as never;
}

describe('admin surfaces refuse API keys and AI connections', () => {
  const guard = new ApiKeySurfaceGuard(new Reflector());
  const writeKey = { id: 'u-1', apiKeyId: 'k-1', apiKeyAllowWrite: true, apiKeyAllowPasswordReveal: false };
  const writeConnection = { ...writeKey, mcpConnectionId: 'c-1' };

  it.each(CASES)('%p.%s refuses a write-enabled API key', (controller, handler, method, path) => {
    expect(() => guard.canActivate(ctx(controller, handler, method, path, writeKey))).toThrow(
      ForbiddenException,
    );
  });

  it.each(CASES)('%p.%s refuses a write-granted AI connection', (controller, handler, method, path) => {
    expect(() =>
      guard.canActivate(ctx(controller, handler, method, path, writeConnection)),
    ).toThrow(ForbiddenException);
  });

  it.each(CASES)('%p.%s still admits an interactive session', (controller, handler, method, path) => {
    expect(guard.canActivate(ctx(controller, handler, method, path, { id: 'u-1' }))).toBe(true);
  });
});
