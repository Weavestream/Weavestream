/**
 * Email authentication sub-check — SPF, DMARC, DKIM.
 *
 * Pure module: takes a `DnsPort`, a hostname, the MX answer collected
 * by the main DNS sub-check, and an optional user-supplied list of
 * extra DKIM selectors. Returns a `SubCheckResult<EmailSubResult>`
 * suitable for folding into the engine's `details.email` blob.
 *
 * Auto-skip — when the domain has no MX records, the email block is
 * irrelevant for grading. The engine wires this to a `SKIP` so the
 * scoring rubric drops the entire 33-pt email section from the
 * denominator instead of penalising the domain. Marketing-only and
 * parked domains therefore don't suffer a score hit for not
 * implementing SPF/DMARC.
 *
 * Discovery strategy
 * -------------------
 * SPF lives in a TXT record at the apex whose body starts with
 * `v=spf1`. We never *send* mail — discovery is read-only. The parser
 * recognises the standard mechanism keywords plus the `all` qualifier
 * (`+`, `-`, `~`, `?`) so the rubric can distinguish hard-fail from
 * soft-fail policies. We also count DNS-lookup mechanisms
 * (`include`, `a`, `mx`, `ptr`, `exists`, `redirect`) so we can flag
 * records that exceed RFC 7208's 10-lookup limit.
 *
 * DMARC lives in a TXT record at `_dmarc.<host>`. We extract `p`,
 * `sp`, `pct`, `rua`, and `ruf` — enough for the rubric and for the
 * UI's "view raw record" affordance.
 *
 * DKIM has no fixed discovery key — selectors are organisation-chosen
 * strings. We probe a small, **provider-keyed** candidate list:
 *   - Google (MX `*.google.com`)        → `google`, `20161025`
 *   - Microsoft (MX `*.outlook.com`)    → `selector1`, `selector2`
 *   - Mailgun (MX `*.mailgun.org`)      → `k1`, `mailo`
 *   - SendGrid (MX `*.sendgrid.net`)    → `s1`, `s2`
 *   - Fallback (any MX)                 → `default`, `mail`
 * Plus any selectors the operator configured via
 * `dkimSelectorOverride`. Absence of a probed selector is treated as
 * "not detected" rather than "no DKIM" — the rubric awards no points
 * but never penalises, because customers can use selectors we don't
 * guess.
 *
 * Each probe has a hard per-query budget so a single slow TXT lookup
 * can't stall the engine's overall fan-out.
 */

import type {
  DkimProbeResult,
  DmarcRecordResult,
  DnsPort,
  EmailSubResult,
  SpfRecordResult,
  SubCheckResult,
} from './types.js';
import { safeResolve } from './dns-utils.js';

interface RunEmailCheckOptions {
  hostname: string;
  mxHosts: string[];
  dkimSelectorOverride?: string[];
}

const DKIM_DEFAULT_FALLBACK = ['default', 'mail'];
const MAX_TOTAL_SELECTORS = 12;

function flattenTxt(records: string[][]): string[] {
  // Each TXT record is a tuple of <=255 byte strings; the canonical
  // form is the concatenation (see RFC 6763 §6.3). The DNS sub-check
  // already produces joined strings, but `email-check` is also called
  // by tests with raw resolver shapes — accept both.
  return records.map((parts) => (Array.isArray(parts) ? parts.join('') : parts));
}

// ---------------------------------------------------------------------
// SPF parsing
// ---------------------------------------------------------------------

const SPF_ALL_TERMS = new Set(['+all', '-all', '~all', '?all', 'all']);

export function parseSpfRecord(record: string): SpfRecordResult {
  const trimmed = record.trim();
  const terms = trimmed.split(/\s+/);
  const mechanisms: string[] = [];
  let allQualifier: SpfRecordResult['all'] = null;
  let lookupCount = 0;
  let valid = true;

  if (!terms[0] || terms[0].toLowerCase() !== 'v=spf1') {
    // We only ever invoke this with records that already start with
    // `v=spf1`, but be defensive — caller can pass anything.
    return {
      present: true,
      record: trimmed,
      mechanisms: [],
      all: null,
      lookupCount: 0,
      valid: false,
    };
  }

  for (let i = 1; i < terms.length; i++) {
    const term = terms[i]!;
    const lower = term.toLowerCase();
    if (SPF_ALL_TERMS.has(lower)) {
      allQualifier = (lower === 'all' ? '+all' : lower) as SpfRecordResult['all'];
      mechanisms.push(lower);
      continue;
    }
    // Strip qualifier prefix when counting mechanism kinds.
    const stripped = lower.startsWith('+') || lower.startsWith('-') || lower.startsWith('~') || lower.startsWith('?')
      ? lower.slice(1)
      : lower;
    mechanisms.push(lower);

    // RFC 7208 §4.6.4 — DNS-lookup mechanisms count towards the 10-
    // lookup limit. We don't recursively count nested `include`
    // chains (that requires walking other domains' SPF records); the
    // surface-level count is a reasonable proxy and matches what most
    // mail-deliverability tools report.
    if (
      stripped.startsWith('include:') ||
      stripped === 'a' ||
      stripped.startsWith('a:') ||
      stripped === 'mx' ||
      stripped.startsWith('mx:') ||
      stripped === 'ptr' ||
      stripped.startsWith('ptr:') ||
      stripped.startsWith('exists:') ||
      stripped.startsWith('redirect=')
    ) {
      lookupCount += 1;
    }
  }

  if (lookupCount > 10) valid = false;
  // A record with no terminating `all` mechanism is technically valid
  // but defaults to `?all` (neutral) — flag it so the rubric can
  // award only partial credit.
  return {
    present: true,
    record: trimmed,
    mechanisms,
    all: allQualifier,
    lookupCount,
    valid,
  };
}

// ---------------------------------------------------------------------
// DMARC parsing
// ---------------------------------------------------------------------

export function parseDmarcRecord(record: string): DmarcRecordResult {
  const trimmed = record.trim();
  const parts = trimmed.split(/;\s*/).filter(Boolean);
  const tags = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const val = part.slice(eq + 1).trim();
    tags.set(key, val);
  }
  if (tags.get('v')?.toLowerCase() !== 'dmarc1') {
    return {
      present: true,
      policy: null,
      subdomainPolicy: null,
      pct: null,
      rua: [],
      ruf: [],
      raw: trimmed,
    };
  }
  const policy = normaliseDmarcPolicy(tags.get('p'));
  const subdomainPolicy = normaliseDmarcPolicy(tags.get('sp'));
  const pctRaw = tags.get('pct');
  const pct = pctRaw && /^\d+$/.test(pctRaw) ? parseInt(pctRaw, 10) : null;
  const rua = splitAddrList(tags.get('rua'));
  const ruf = splitAddrList(tags.get('ruf'));
  return {
    present: true,
    policy,
    subdomainPolicy,
    pct,
    rua,
    ruf,
    raw: trimmed,
  };
}

function normaliseDmarcPolicy(
  v: string | undefined,
): 'none' | 'quarantine' | 'reject' | null {
  if (!v) return null;
  const lower = v.toLowerCase();
  if (lower === 'none' || lower === 'quarantine' || lower === 'reject') {
    return lower;
  }
  return null;
}

function splitAddrList(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------
// DKIM probing — provider detection + selector list
// ---------------------------------------------------------------------

interface ProviderProfile {
  provider: DkimProbeResult['provider'];
  matches: (mxHost: string) => boolean;
  selectors: string[];
}

const PROVIDER_PROFILES: ProviderProfile[] = [
  {
    provider: 'google',
    matches: (mx) =>
      mx.endsWith('google.com') ||
      mx.endsWith('googlemail.com') ||
      mx.endsWith('aspmx.l.google.com'),
    selectors: ['google', '20161025'],
  },
  {
    provider: 'microsoft',
    matches: (mx) =>
      mx.endsWith('outlook.com') ||
      mx.endsWith('protection.outlook.com'),
    selectors: ['selector1', 'selector2'],
  },
  {
    provider: 'mailgun',
    matches: (mx) => mx.endsWith('mailgun.org') || mx.endsWith('mailgun.com'),
    selectors: ['k1', 'mailo'],
  },
  {
    provider: 'sendgrid',
    matches: (mx) => mx.endsWith('sendgrid.net'),
    selectors: ['s1', 's2'],
  },
];

function detectProvider(
  mxHosts: string[],
): { provider: DkimProbeResult['provider']; selectors: string[] } {
  const lowered = mxHosts.map((m) => m.toLowerCase().replace(/\.$/, ''));
  for (const profile of PROVIDER_PROFILES) {
    if (lowered.some(profile.matches)) {
      return { provider: profile.provider, selectors: profile.selectors };
    }
  }
  return { provider: 'unknown', selectors: [] };
}

async function probeDkimSelector(
  dns: DnsPort,
  hostname: string,
  selector: string,
): Promise<boolean> {
  const qname = `${selector}._domainkey.${hostname}`;
  const res = await safeResolve(() => dns.resolveTxt(qname), [] as string[][]);
  if (res.error || res.value.length === 0) return false;
  // A DKIM record body starts with `v=DKIM1` or has a `p=` (public
  // key) tag. Some providers omit `v=DKIM1` (technically out-of-spec
  // but seen in the wild) — accept either signal.
  const joined = flattenTxt(res.value).join(' ');
  return /v=dkim1/i.test(joined) || /\bp=/.test(joined);
}

// ---------------------------------------------------------------------
// Engine entry point
// ---------------------------------------------------------------------

export async function runEmailAuthCheck(
  dns: DnsPort,
  opts: RunEmailCheckOptions,
): Promise<SubCheckResult<EmailSubResult>> {
  const { hostname, mxHosts } = opts;
  const hasMx = mxHosts.length > 0;
  // Auto-skip per plan: when there is no MX, we don't even probe.
  // Callers wrap this in their fan-out and read `status === 'SKIP'`
  // to drop the email block from the scoring denominator.
  if (!hasMx) {
    return {
      status: 'SKIP',
      data: {
        hasMx: false,
        spf: null,
        dmarc: null,
        dkim: null,
      },
      error: null,
    };
  }

  const apexTxt = safeResolve(
    () => dns.resolveTxt(hostname),
    [] as string[][],
  );
  const dmarcTxt = safeResolve(
    () => dns.resolveTxt(`_dmarc.${hostname}`),
    [] as string[][],
  );

  const { provider, selectors: providerSelectors } = detectProvider(mxHosts);

  // Compose the final selector list. We hard-cap the total to keep the
  // fan-out manageable; user-supplied overrides take priority because
  // they're the operator's authoritative signal.
  const overrideSelectors = (opts.dkimSelectorOverride ?? []).map((s) =>
    s.toLowerCase(),
  );
  const allSelectors = Array.from(
    new Set([
      ...overrideSelectors,
      ...providerSelectors,
      ...DKIM_DEFAULT_FALLBACK,
    ]),
  ).slice(0, MAX_TOTAL_SELECTORS);

  const dkimProbes = allSelectors.map(async (selector) => ({
    selector,
    found: await probeDkimSelector(dns, hostname, selector),
  }));

  const [apex, dmarc, dkimResults] = await Promise.all([
    apexTxt,
    dmarcTxt,
    Promise.all(dkimProbes),
  ]);

  // ---- SPF ----------------------------------------------------------
  let spf: SpfRecordResult | null = null;
  const apexJoined = flattenTxt(apex.value);
  const spfRecord = apexJoined.find((r) => /^v=spf1(\s|$)/i.test(r));
  if (spfRecord) {
    spf = parseSpfRecord(spfRecord);
  } else {
    spf = {
      present: false,
      record: null,
      mechanisms: [],
      all: null,
      lookupCount: 0,
      valid: false,
    };
  }

  // ---- DMARC --------------------------------------------------------
  let dmarcResult: DmarcRecordResult | null = null;
  const dmarcJoined = flattenTxt(dmarc.value);
  const dmarcRecord = dmarcJoined.find((r) => /^v=dmarc1(\s|$|;)/i.test(r));
  if (dmarcRecord) {
    dmarcResult = parseDmarcRecord(dmarcRecord);
  } else {
    dmarcResult = {
      present: false,
      policy: null,
      subdomainPolicy: null,
      pct: null,
      rua: [],
      ruf: [],
      raw: null,
    };
  }

  // ---- DKIM ---------------------------------------------------------
  const dkim: DkimProbeResult = {
    selectorsChecked: dkimResults.map((r) => r.selector),
    selectorsFound: dkimResults.filter((r) => r.found).map((r) => r.selector),
    provider,
  };

  // The aggregate `status` is informational — the rubric reads the
  // sub-fields directly. We mark OK when SPF + DMARC are both
  // present, WARN when either is missing.
  const status: SubCheckResult<EmailSubResult>['status'] =
    spf.present && dmarcResult.present
      ? 'OK'
      : spf.present || dmarcResult.present
        ? 'WARN'
        : 'WARN';

  const errors: string[] = [];
  if (!spf.present) errors.push('no spf record');
  if (!dmarcResult.present) errors.push('no dmarc record');

  return {
    status,
    data: {
      hasMx: true,
      spf,
      dmarc: dmarcResult,
      dkim,
    },
    error: errors.length === 0 ? null : errors.join('; '),
  };
}
