/** Supported API surface for `apps/worker`: domain monitoring. See `runtime.ts`. */
export { DomainsModule } from '../domains/domains.module.js';
export { DomainsService, type AuditMeta } from '../domains/domains.service.js';
export { createDefaultPorts, deriveDomainStatus, runDomainCheck } from '../domains/engine/index.js';
export { runHttpCheck } from '../domains/engine/http-check.js';
