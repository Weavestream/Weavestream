export { runDomainCheck, deriveDomainStatus } from './engine.js';
export { createDefaultPorts } from './default-ports.js';
export type {
  Clock,
  DnsPort,
  TlsPort,
  Whois43Port,
  EnginePorts,
  EngineRunOptions,
  DomainCheckResult,
  SubCheckResult,
  WhoisSubResult,
  DnsSubResult,
  TlsSubResult,
  TlsCertificateInfo,
} from './types.js';
