import 'reflect-metadata';
import { MODULE_METADATA, OPTIONAL_DEPS_METADATA } from '@nestjs/common/constants.js';
import { IntegrationsCoreModule } from './integrations-core.module.js';
import { IntegrationsModule } from './integrations.module.js';
import { IntegrationsService } from './integrations.service.js';
import { IntegrationOAuthService } from './oauth/integration-oauth.service.js';

/**
 * Unit specs construct `IntegrationsService` by hand, so they cannot see Nest
 * wiring. When `IntegrationOAuthService` lived only in the API-side
 * `IntegrationsModule`, the core module could not resolve it and an
 * `@Optional()` injection quietly became undefined: deletes skipped grant
 * revocation. These specs pin the wiring from the real module metadata.
 */
describe('IntegrationsCoreModule wiring', () => {
  const providersOf = (mod: object): unknown[] =>
    Reflect.getMetadata(MODULE_METADATA.PROVIDERS, mod) ?? [];

  it('provides and exports IntegrationOAuthService beside IntegrationsService', () => {
    expect(providersOf(IntegrationsCoreModule)).toEqual(
      expect.arrayContaining([IntegrationsService, IntegrationOAuthService]),
    );
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, IntegrationsCoreModule)).toContain(
      IntegrationOAuthService,
    );
  });

  it('does not register a second instance in the API module', () => {
    expect(providersOf(IntegrationsModule)).not.toContain(IntegrationOAuthService);
  });

  it('injects IntegrationOAuthService into IntegrationsService as a required dependency', () => {
    const params: unknown[] = Reflect.getMetadata('design:paramtypes', IntegrationsService);
    const index = params.indexOf(IntegrationOAuthService);
    expect(index).toBeGreaterThanOrEqual(0);
    const optional: number[] = Reflect.getMetadata(OPTIONAL_DEPS_METADATA, IntegrationsService) ?? [];
    expect(optional).not.toContain(index);
  });
});
