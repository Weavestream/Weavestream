export { runDomainCheck, deriveDomainStatus } from './engine.js';
export { createDefaultPorts } from './default-ports.js';
export { computeScore, DOMAIN_SCORE_VERSION } from './score.js';
export type {
  CaaRecord,
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
  EmailSubResult,
  SpfRecordResult,
  DmarcRecordResult,
  DkimProbeResult,
  DnssecSubResult,
  NsMatchSubResult,
  HttpEngineSubResult,
} from './types.js';
