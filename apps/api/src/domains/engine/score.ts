/**
 * Domain hygiene scoring (v2).
 *
 * Pure function: takes the structured `details` payload that the
 * engine just built and returns a `DomainScore` (percent + tier +
 * per-check breakdown + optional hard override). No I/O, no side
 * effects — every input is already in `details`.
 *
 * Design rules
 * ------------
 * 1. **Percentage only.** Letter grades (A-F) are US-centric and
 *    meaningless to non-US audiences. We expose a number between 0
 *    and 100 plus a non-letter `tier` enum (`excellent` / `good` /
 *    `fair` / `poor` / `critical`) that drives only color and copy.
 *
 * 2. **Auto-skip on no-MX.** A domain with no MX records doesn't
 *    handle email, so SPF/DMARC/DKIM are irrelevant. Instead of
 *    penalising it for those gaps, we drop the entire 33-pt email
 *    block from the rubric's `max`. A marketing-only domain that
 *    nails TLS + DNSSEC + CAA + HSTS therefore lands in `excellent`,
 *    not capped at 67% by missing email signals.
 *
 * 3. **Hard overrides clamp the percent.** TLS expired, WHOIS
 *    expired, or registry `*hold` status forces critical (cap at 20%).
 *    A domain with neither SPF nor DMARC (where MX is present) is
 *    capped at the top of `fair` (60%). The override is recorded in
 *    `score.hardOverride` so the UI can show *why* the cap kicked in
 *    rather than leaving the operator guessing.
 *
 * 4. **No retroactive re-grading.** The score carries a `version`
 *    integer. When the rubric changes, old rows keep their original
 *    version and stay graded under the rubric they were scored with.
 *    The UI surfaces the version in the "Why this score" panel.
 */

import type { DomainCheckDetails, DomainScore } from '@weavestream/shared';

export const DOMAIN_SCORE_VERSION = 2;

interface BreakdownItem {
  id: string;
  label: string;
  points: number;
  max: number;
  status: 'pass' | 'partial' | 'fail' | 'skip';
  evidence?: string;
}

// Tier thresholds (percentage). The plan locked these — keep in sync
// with the UI's tier→colour mapping in score-card.tsx.
function tierForPercent(percent: number): DomainScore['tier'] {
  if (percent >= 90) return 'excellent';
  if (percent >= 75) return 'good';
  if (percent >= 55) return 'fair';
  if (percent >= 35) return 'poor';
  return 'critical';
}

function makeItem(
  id: string,
  label: string,
  max: number,
  points: number,
  evidence?: string,
): BreakdownItem {
  const status: BreakdownItem['status'] =
    points >= max ? 'pass' : points > 0 ? 'partial' : 'fail';
  return { id, label, max, points: Math.max(0, points), status, evidence };
}

function skipItem(id: string, label: string, max: number, why: string): BreakdownItem {
  return { id, label, max, points: 0, status: 'skip', evidence: why };
}

// ---------------------------------------------------------------------
// Sub-scoring helpers (one per rubric line). Each returns the rubric
// item plus the maximum points it *contributes* to the denominator.
// Skipped items contribute 0/0 so the denominator shrinks.
// ---------------------------------------------------------------------

interface EmailBlockInputs {
  hasMx: boolean;
  spf: NonNullable<DomainCheckDetails['email']>['spf'] | undefined;
  dmarc: NonNullable<DomainCheckDetails['email']>['dmarc'] | undefined;
  dkim: NonNullable<DomainCheckDetails['email']>['dkim'] | undefined;
}

function scoreEmailBlock(inputs: EmailBlockInputs): {
  items: BreakdownItem[];
  total: number;
  max: number;
  skipped: boolean;
} {
  // Auto-skip per design rule #2.
  if (!inputs.hasMx) {
    return {
      items: [
        skipItem(
          'spf_present',
          'SPF record',
          10,
          'no MX records — email scoring skipped',
        ),
        skipItem('spf_enforcement', 'SPF enforcement', 5, 'no MX records'),
        skipItem('dmarc_present', 'DMARC record', 8, 'no MX records'),
        skipItem('dmarc_policy', 'DMARC policy', 8, 'no MX records'),
        skipItem('dkim_found', 'DKIM selector found', 2, 'no MX records'),
      ],
      total: 0,
      max: 0,
      skipped: true,
    };
  }

  const items: BreakdownItem[] = [];
  let total = 0;
  let max = 0;

  // SPF presence (10)
  {
    const m = 10;
    max += m;
    if (inputs.spf?.present) {
      const valid = inputs.spf.valid !== false;
      const pts = valid ? 10 : 5;
      total += pts;
      items.push(
        makeItem(
          'spf_present',
          'SPF record',
          m,
          pts,
          valid
            ? `v=spf1 record present`
            : `SPF record present but invalid (lookup count ${inputs.spf.lookupCount ?? 0})`,
        ),
      );
    } else {
      items.push(makeItem('spf_present', 'SPF record', m, 0, 'no SPF record at apex'));
    }
  }

  // SPF enforcement (5)
  {
    const m = 5;
    max += m;
    const all = inputs.spf?.all;
    let pts = 0;
    let evidence = 'no terminating mechanism';
    if (all === '-all') {
      pts = 5;
      evidence = 'hard fail (-all)';
    } else if (all === '~all') {
      pts = 2;
      evidence = 'soft fail (~all)';
    } else if (all === '?all') {
      pts = 0;
      evidence = 'neutral (?all)';
    } else if (all === '+all') {
      pts = 0;
      evidence = 'allow-anyone (+all) — actively harmful';
    }
    total += pts;
    items.push(makeItem('spf_enforcement', 'SPF enforcement', m, pts, evidence));
  }

  // DMARC presence (8)
  {
    const m = 8;
    max += m;
    if (inputs.dmarc?.present) {
      total += 8;
      items.push(
        makeItem('dmarc_present', 'DMARC record', m, 8, 'v=DMARC1 record present'),
      );
    } else {
      items.push(
        makeItem(
          'dmarc_present',
          'DMARC record',
          m,
          0,
          'no _dmarc.<host> TXT record',
        ),
      );
    }
  }

  // DMARC policy (8)
  {
    const m = 8;
    max += m;
    const policy = inputs.dmarc?.policy;
    let pts = 0;
    let evidence = 'no policy';
    if (policy === 'reject') {
      pts = 8;
      evidence = 'p=reject';
    } else if (policy === 'quarantine') {
      pts = 5;
      evidence = 'p=quarantine';
    } else if (policy === 'none') {
      pts = 2;
      evidence = 'p=none (monitoring only)';
    }
    total += pts;
    items.push(makeItem('dmarc_policy', 'DMARC policy', m, pts, evidence));
  }

  // DKIM (2) — informational. We award credit when at least one
  // selector resolves, but missing detection never costs points beyond
  // this small bucket because organisations can use selector strings
  // we never guess.
  {
    const m = 2;
    max += m;
    const found = inputs.dkim?.selectorsFound ?? [];
    if (found.length > 0) {
      total += 2;
      items.push(
        makeItem(
          'dkim_found',
          'DKIM selector found',
          m,
          2,
          `selector(s): ${found.join(', ')}`,
        ),
      );
    } else {
      items.push(
        makeItem(
          'dkim_found',
          'DKIM selector found',
          m,
          0,
          'no probed selector resolved — configure a selector override if you sign with a non-default name',
        ),
      );
    }
  }

  return { items, total, max, skipped: false };
}

interface TransportInputs {
  tls: DomainCheckDetails['tls'];
  http: DomainCheckDetails['http'];
  dns: DomainCheckDetails['dns'];
}

function scoreTransport(inputs: TransportInputs): {
  items: BreakdownItem[];
  total: number;
  max: number;
} {
  const items: BreakdownItem[] = [];
  let total = 0;
  let max = 0;

  // TLS validity + expiry tier (10)
  {
    const m = 10;
    max += m;
    const tls = inputs.tls;
    const days = tls?.cert?.daysUntilExpiry ?? null;
    let pts = 0;
    let evidence = 'no TLS cert';
    if (tls?.validTo) {
      if (days !== null && days > 30) {
        pts = 10;
        evidence = `valid until ${tls.validTo} (${days}d)`;
      } else if (days !== null && days > 14) {
        pts = 7;
        evidence = `expires in ${days}d`;
      } else if (days !== null && days > 0) {
        pts = 3;
        evidence = `expires in ${days}d — renew now`;
      } else {
        pts = 0;
        evidence = `expired ${days !== null ? Math.abs(days) : '?'}d ago`;
      }
    }
    total += pts;
    items.push(makeItem('tls_validity', 'TLS validity', m, pts, evidence));
  }

  // TLS modern crypto (3)
  {
    const m = 3;
    max += m;
    const cert = inputs.tls?.cert;
    let pts = 0;
    let evidence = 'no cert metadata';
    if (cert?.keyAlgo) {
      const sig = (cert.sigAlgo ?? '').toLowerCase();
      const weakSig = sig.includes('sha1') || sig.includes('md5');
      const keyBits = cert.keyBits ?? 0;
      const strongKey =
        (cert.keyAlgo === 'RSA' && keyBits >= 2048) ||
        (cert.keyAlgo === 'EC' && keyBits >= 256) ||
        cert.keyAlgo === 'ED25519';
      if (strongKey && !weakSig) {
        pts = 3;
        evidence = `${cert.keyAlgo}${keyBits ? `-${keyBits}` : ''} / ${cert.sigAlgo ?? '?'}`;
      } else {
        pts = 0;
        evidence = `weak crypto (${cert.keyAlgo}${keyBits ? `-${keyBits}` : ''} / ${cert.sigAlgo ?? '?'})`;
      }
    }
    total += pts;
    items.push(makeItem('tls_crypto', 'TLS modern crypto', m, pts, evidence));
  }

  // HTTP -> HTTPS redirect (5)
  {
    const m = 5;
    max += m;
    const http = inputs.http;
    if (http && http.redirectsToHttps) {
      total += 5;
      items.push(makeItem('http_redirect', 'HTTP→HTTPS redirect', m, 5, 'port 80 redirects to https'));
    } else {
      items.push(
        makeItem(
          'http_redirect',
          'HTTP→HTTPS redirect',
          m,
          0,
          http ? 'port 80 does not redirect to https' : 'no http response',
        ),
      );
    }
  }

  // HSTS (5) — RFC 6797 §12.5 recommends >=15552000 seconds (180d).
  {
    const m = 5;
    max += m;
    const hsts = inputs.http?.hsts;
    if (hsts?.present && (hsts.maxAge ?? 0) >= 15_552_000) {
      total += 5;
      items.push(
        makeItem(
          'hsts',
          'HSTS header',
          m,
          5,
          `max-age=${hsts.maxAge}${hsts.includeSubDomains ? ' includeSubDomains' : ''}${hsts.preload ? ' preload' : ''}`,
        ),
      );
    } else if (hsts?.present) {
      total += 2;
      items.push(
        makeItem(
          'hsts',
          'HSTS header',
          m,
          2,
          `max-age=${hsts.maxAge ?? 0} — below 180d recommendation`,
        ),
      );
    } else {
      items.push(makeItem('hsts', 'HSTS header', m, 0, 'no Strict-Transport-Security header'));
    }
  }

  // DNSSEC (8)
  {
    const m = 8;
    max += m;
    const dnssec = inputs.dns?.dnssec;
    if (dnssec?.signed) {
      total += 8;
      items.push(
        makeItem(
          'dnssec',
          'DNSSEC',
          m,
          8,
          dnssec.source === 'rdap'
            ? `registry reports delegation signed${dnssec.dsRecordCount ? ` (${dnssec.dsRecordCount} DS)` : ''}`
            : 'DNSKEY records present',
        ),
      );
    } else {
      items.push(
        makeItem(
          'dnssec',
          'DNSSEC',
          m,
          0,
          dnssec?.source === 'rdap'
            ? 'registry reports delegation NOT signed'
            : 'no DNSKEY records / no registry DS data',
        ),
      );
    }
  }

  // CAA (3)
  {
    const m = 3;
    max += m;
    const caa = inputs.dns?.caa ?? [];
    if (caa.length > 0) {
      total += 3;
      items.push(makeItem('caa', 'CAA records', m, 3, `${caa.length} record(s)`));
    } else {
      items.push(
        makeItem('caa', 'CAA records', m, 0, 'no CAA records — any CA may issue'),
      );
    }
  }

  // MX (3)
  {
    const m = 3;
    max += m;
    const mx = inputs.dns?.mx ?? [];
    if (mx.length > 0) {
      total += 3;
      items.push(makeItem('mx', 'MX records', m, 3, `${mx.length} mail exchanger(s)`));
    } else {
      items.push(makeItem('mx', 'MX records', m, 0, 'no MX records (informational)'));
    }
  }

  return { items, total, max };
}

interface RegistrationInputs {
  whois: DomainCheckDetails['whois'];
  dns: DomainCheckDetails['dns'];
  now: Date;
}

function scoreRegistration(inputs: RegistrationInputs): {
  items: BreakdownItem[];
  total: number;
  max: number;
} {
  const items: BreakdownItem[] = [];
  let total = 0;
  let max = 0;
  const whois = inputs.whois;
  const noWhoisData =
    !whois || whois.source === 'none' || (!whois.expiresAt && !whois.registrar);

  // WHOIS expiry tier (5)
  {
    const m = 5;
    if (noWhoisData) {
      items.push(skipItem('whois_expiry', 'WHOIS expiry', m, 'no registry data'));
    } else {
      max += m;
      const expiresIso = whois?.expiresAt;
      let pts = 0;
      let evidence = 'no expiry date';
      if (expiresIso) {
        const expires = new Date(expiresIso);
        if (!Number.isNaN(expires.getTime())) {
          const days = Math.floor(
            (expires.getTime() - inputs.now.getTime()) / 86_400_000,
          );
          if (days > 30) {
            pts = 5;
            evidence = `${days}d until expiry`;
          } else if (days > 7) {
            pts = 2;
            evidence = `${days}d until expiry — renew soon`;
          } else if (days >= 0) {
            pts = 0;
            evidence = `${days}d until expiry — renew NOW`;
          } else {
            pts = 0;
            evidence = `expired ${Math.abs(days)}d ago`;
          }
        }
      }
      total += pts;
      items.push(makeItem('whois_expiry', 'WHOIS expiry', m, pts, evidence));
    }
  }

  // Domain lock (6)
  {
    const m = 6;
    if (noWhoisData) {
      items.push(skipItem('domain_lock', 'Domain lock', m, 'no registry data'));
    } else {
      max += m;
      if (whois?.locked) {
        total += 6;
        items.push(
          makeItem(
            'domain_lock',
            'Domain lock',
            m,
            6,
            (whois.statusCodes ?? []).join(', ') || 'transfer prohibited',
          ),
        );
      } else {
        items.push(
          makeItem(
            'domain_lock',
            'Domain lock',
            m,
            0,
            'no clientTransferProhibited — enable in your registrar',
          ),
        );
      }
    }
  }

  // NS match (4)
  {
    const m = 4;
    const ns = inputs.dns?.nsMatch;
    if (!ns) {
      items.push(skipItem('ns_match', 'DNS/Registry NS match', m, 'no NS data'));
    } else if (ns.match === 'unverifiable') {
      // Treat as not-applicable: don't penalise on opaque TLDs.
      items.push(
        skipItem(
          'ns_match',
          'DNS/Registry NS match',
          m,
          'registry did not return NS list (unverifiable)',
        ),
      );
    } else {
      max += m;
      if (ns.match === 'match') {
        total += 4;
        items.push(makeItem('ns_match', 'DNS/Registry NS match', m, 4, 'sets equal'));
      } else {
        items.push(
          makeItem(
            'ns_match',
            'DNS/Registry NS match',
            m,
            0,
            `dns=[${ns.dnsNs.join(',')}] vs registry=[${ns.whoisNs.join(',')}]`,
          ),
        );
      }
    }
  }

  return { items, total, max };
}

interface SanityInputs {
  dns: DomainCheckDetails['dns'];
  tls: DomainCheckDetails['tls'];
  whois: DomainCheckDetails['whois'];
}

function scoreSanity(inputs: SanityInputs): {
  items: BreakdownItem[];
  total: number;
  max: number;
} {
  const items: BreakdownItem[] = [];
  let total = 0;
  let max = 0;

  // Address records present (5)
  {
    const m = 5;
    max += m;
    const hasAddr =
      (inputs.dns?.a?.length ?? 0) > 0 || (inputs.dns?.aaaa?.length ?? 0) > 0;
    if (hasAddr) {
      total += 5;
      items.push(makeItem('addr', 'A/AAAA records', m, 5, 'address records present'));
    } else {
      items.push(makeItem('addr', 'A/AAAA records', m, 0, 'no A or AAAA records'));
    }
  }

  // TLS trust verdict (5)
  {
    const m = 5;
    max += m;
    const tls = inputs.tls;
    if (!tls) {
      items.push(skipItem('tls_authorized', 'TLS trust', m, 'no TLS check'));
    } else if (tls.authorized) {
      total += 5;
      items.push(
        makeItem(
          'tls_authorized',
          'TLS trust',
          m,
          5,
          'Node validator accepted cert + hostname',
        ),
      );
    } else {
      items.push(
        makeItem(
          'tls_authorized',
          'TLS trust',
          m,
          0,
          tls.authorizationError ?? 'TLS validator rejected the cert',
        ),
      );
    }
  }

  // WHOIS data resolved at all (5)
  {
    const m = 5;
    const whois = inputs.whois;
    if (!whois || whois.source === 'none') {
      // SKIP rather than penalise — `.gov` etc.
      items.push(skipItem('whois_resolved', 'Registry data resolved', m, 'no RDAP/WHOIS for this TLD'));
    } else {
      max += m;
      total += 5;
      items.push(
        makeItem(
          'whois_resolved',
          'Registry data resolved',
          m,
          5,
          `via ${whois.source}`,
        ),
      );
    }
  }

  return { items, total, max };
}

// ---------------------------------------------------------------------
// Top-level scorer
// ---------------------------------------------------------------------

export function computeScore(
  details: DomainCheckDetails,
  now: Date = new Date(),
): DomainScore | null {
  // Defensive: if the engine bailed out before producing any sub-check
  // data we have nothing to score. The caller writes NULL.
  if (!details.dns && !details.tls && !details.whois) return null;

  const email = scoreEmailBlock({
    hasMx: !!details.email?.hasMx,
    spf: details.email?.spf,
    dmarc: details.email?.dmarc,
    dkim: details.email?.dkim,
  });
  const transport = scoreTransport({
    tls: details.tls,
    http: details.http,
    dns: details.dns,
  });
  const registration = scoreRegistration({
    whois: details.whois,
    dns: details.dns,
    now,
  });
  const sanity = scoreSanity({
    dns: details.dns,
    tls: details.tls,
    whois: details.whois,
  });

  const items = [
    ...email.items,
    ...transport.items,
    ...registration.items,
    ...sanity.items,
  ];
  const total = email.total + transport.total + registration.total + sanity.total;
  const max = email.max + transport.max + registration.max + sanity.max;

  let percent = max > 0 ? Math.round((total / max) * 100) : 0;

  // ---- Hard overrides (applied AFTER normalisation) ----------------
  let hardOverride: DomainScore['hardOverride'] = null;

  // Force-critical (cap at 20%) when the domain is fundamentally
  // broken at the registration / cert level.
  const tlsExpired =
    details.tls?.validTo && new Date(details.tls.validTo).getTime() <= now.getTime();
  const whoisExpired =
    details.whois?.expiresAt &&
    new Date(details.whois.expiresAt).getTime() <= now.getTime();
  const onHold = details.whois?.hold === true;
  if (tlsExpired || whoisExpired || onHold) {
    const reasons: string[] = [];
    if (tlsExpired) reasons.push('TLS certificate expired');
    if (whoisExpired) reasons.push('WHOIS domain expired');
    if (onHold) reasons.push('registry hold status active');
    hardOverride = { kind: 'force_critical', reason: reasons.join('; ') };
    percent = Math.min(percent, 20);
  } else if (
    // Cap at fair (60%) when MX is present but neither SPF nor DMARC
    // exists. We deliberately ignore the no-MX case (auto-skip
    // already handled it).
    details.email?.hasMx &&
    details.email.spf?.present === false &&
    details.email.dmarc?.present === false
  ) {
    hardOverride = {
      kind: 'cap_fair',
      reason: 'mail-enabled domain with neither SPF nor DMARC',
    };
    percent = Math.min(percent, 60);
  }

  return {
    version: DOMAIN_SCORE_VERSION,
    total,
    max,
    percent,
    tier: tierForPercent(percent),
    breakdown: items,
    hardOverride,
  };
}
