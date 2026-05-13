import type { DomainCheck, MonitoredDomain } from './server-api';

/**
 * Project a `MonitoredDomain` (and optionally its most recent
 * `DomainCheck`) to a markdown blob suitable for inlining in the chat
 * system prompt. Mirrors the fields shown on the admin domain detail
 * page ([page.tsx](apps/web/src/app/admin/companies/[id]/domains/[domainId]/page.tsx))
 * — identity, status / score, enabled checks, WHOIS / DNS / email
 * auth / TLS / HTTP evidence, and the score breakdown.
 *
 * Skips null/empty entries so legacy v1 rows (or partial v2 results)
 * round-trip cleanly without emitting placeholder lines.
 *
 * Read-only context: the server never proposes domain tool calls and
 * the chat tool set has no `update_domain` / `create_domain` entries.
 * The `DomainsService` already strips non-`visibleToClients` rows for
 * CLIENT_USER actors, so whatever the client fetched here already
 * matches the requester's permissions — no extra masking needed.
 */
export function domainToMarkdown(
  domain: MonitoredDomain,
  latestCheck: DomainCheck | null = null,
): { markdown: string; hostname: string } {
  const lines: string[] = [];

  lines.push(`**Hostname:** ${domain.hostname}`);
  lines.push(`**Status:** ${domain.latestStatus}`);
  if (domain.latestScore !== null) {
    lines.push(`**Score:** ${domain.latestScore}%`);
  }
  if (domain.archivedAt) {
    lines.push(`**Archived:** ${domain.archivedAt}`);
  }
  lines.push(
    `**Visibility:** ${domain.visibleToClients ? 'client-visible' : 'internal'}`,
  );

  const enabled = [
    domain.checkWhois && 'WHOIS',
    domain.checkDns && 'DNS',
    domain.checkTls && 'TLS',
  ].filter(Boolean);
  lines.push(`**Checks enabled:** ${enabled.length > 0 ? enabled.join(', ') : 'none'}`);
  lines.push(`**Alert threshold:** ${domain.alertThresholdDays} days`);

  if (domain.whoisExpiresAt) {
    lines.push(
      `**WHOIS expires:** ${domain.whoisExpiresAt}${withRelativeDays(domain.whoisExpiresAt)}`,
    );
  }
  if (domain.tlsExpiresAt) {
    lines.push(
      `**TLS expires:** ${domain.tlsExpiresAt}${withRelativeDays(domain.tlsExpiresAt)}`,
    );
  }
  if (domain.lastCheckedAt) {
    lines.push(`**Last checked:** ${domain.lastCheckedAt}`);
  }
  if (domain.dkimSelectorOverride) {
    lines.push(`**DKIM selector override:** ${domain.dkimSelectorOverride}`);
  }

  if (latestCheck) {
    lines.push('');
    lines.push(
      `**Latest check:** ${latestCheck.checkedAt}${
        latestCheck.schemaVersion ? ` (rubric v${latestCheck.schemaVersion})` : ''
      }`,
    );
    const cells = [
      latestCheck.whoisStatus ? `WHOIS: ${latestCheck.whoisStatus}` : null,
      latestCheck.dnsStatus ? `DNS: ${latestCheck.dnsStatus}` : null,
      latestCheck.tlsStatus ? `TLS: ${latestCheck.tlsStatus}` : null,
    ].filter((s): s is string => s !== null);
    if (cells.length > 0) {
      lines.push(`- **Check results:** ${cells.join(' · ')}`);
    }
    if (latestCheck.error) {
      lines.push(`- **Error:** ${latestCheck.error}`);
    }

    const d = latestCheck.details ?? {};

    if (d.whois) {
      const parts: string[] = [];
      if (d.whois.registrar) parts.push(`registrar ${d.whois.registrar}`);
      if (d.whois.registeredAt) parts.push(`registered ${d.whois.registeredAt}`);
      if (d.whois.expiresAt) parts.push(`expires ${d.whois.expiresAt}`);
      if (d.whois.source) parts.push(`source ${d.whois.source}`);
      if (d.whois.locked !== undefined) {
        parts.push(`locked ${d.whois.locked ? 'yes' : 'no'}`);
      }
      if (d.whois.hold) parts.push('hold ACTIVE');
      if (d.whois.statusCodes && d.whois.statusCodes.length > 0) {
        parts.push(`status codes ${d.whois.statusCodes.join(', ')}`);
      }
      if (d.whois.whoisNs && d.whois.whoisNs.length > 0) {
        parts.push(`whois NS ${truncateList(d.whois.whoisNs, 6)}`);
      }
      if (parts.length > 0) lines.push(`- **WHOIS:** ${parts.join('; ')}`);
    }

    if (d.dns) {
      const parts: string[] = [];
      if (d.dns.a && d.dns.a.length > 0) {
        parts.push(`A (${d.dns.a.length}) ${truncateList(d.dns.a, 4)}`);
      }
      if (d.dns.aaaa && d.dns.aaaa.length > 0) {
        parts.push(`AAAA (${d.dns.aaaa.length}) ${truncateList(d.dns.aaaa, 4)}`);
      }
      if (d.dns.mx && d.dns.mx.length > 0) {
        const mx = d.dns.mx
          .slice(0, 4)
          .map((m) => `${m.preference} ${m.exchange}`)
          .join(', ');
        parts.push(
          `MX (${d.dns.mx.length}) ${mx}${d.dns.mx.length > 4 ? ', …' : ''}`,
        );
      }
      if (d.dns.ns && d.dns.ns.length > 0) {
        parts.push(`NS (${d.dns.ns.length}) ${truncateList(d.dns.ns, 4)}`);
      }
      if (d.dns.caa && d.dns.caa.length > 0) {
        const caa = d.dns.caa
          .slice(0, 4)
          .map((c) => `${c.tag} ${c.value}`)
          .join(', ');
        parts.push(`CAA (${d.dns.caa.length}) ${caa}`);
      }
      if (d.dns.dnssec) {
        parts.push(
          `DNSSEC ${d.dns.dnssec.signed ? 'signed' : 'unsigned'} (${d.dns.dnssec.source})`,
        );
      }
      if (d.dns.nsMatch) {
        parts.push(`NS match: ${d.dns.nsMatch.match}`);
      }
      if (parts.length > 0) lines.push(`- **DNS:** ${parts.join('; ')}`);
    }

    if (d.email) {
      const parts: string[] = [];
      parts.push(`hasMx ${d.email.hasMx ? 'yes' : 'no'}`);
      if (d.email.spf) {
        const spf: string[] = [`present ${d.email.spf.present ? 'yes' : 'no'}`];
        if (d.email.spf.all) spf.push(`all=${d.email.spf.all}`);
        spf.push(`valid ${d.email.spf.valid ? 'yes' : 'no'}`);
        if (d.email.spf.lookupCount !== undefined) {
          spf.push(`lookups ${d.email.spf.lookupCount}`);
        }
        parts.push(`SPF { ${spf.join(', ')} }`);
      }
      if (d.email.dmarc) {
        const dmarc: string[] = [
          `present ${d.email.dmarc.present ? 'yes' : 'no'}`,
        ];
        if (d.email.dmarc.policy) dmarc.push(`policy=${d.email.dmarc.policy}`);
        if (d.email.dmarc.subdomainPolicy) {
          dmarc.push(`sp=${d.email.dmarc.subdomainPolicy}`);
        }
        if (d.email.dmarc.pct !== null && d.email.dmarc.pct !== undefined) {
          dmarc.push(`pct=${d.email.dmarc.pct}`);
        }
        parts.push(`DMARC { ${dmarc.join(', ')} }`);
      }
      if (d.email.dkim) {
        const dkim: string[] = [];
        if (d.email.dkim.selectorsFound.length > 0) {
          dkim.push(`found ${d.email.dkim.selectorsFound.join(', ')}`);
        } else {
          dkim.push('found none');
        }
        if (d.email.dkim.selectorsChecked.length > 0) {
          dkim.push(`checked ${d.email.dkim.selectorsChecked.join(', ')}`);
        }
        if (d.email.dkim.provider) dkim.push(`provider ${d.email.dkim.provider}`);
        parts.push(`DKIM { ${dkim.join(', ')} }`);
      }
      lines.push(`- **Email auth:** ${parts.join('; ')}`);
    }

    if (d.tls) {
      const parts: string[] = [];
      if (d.tls.issuer) parts.push(`issuer ${d.tls.issuer}`);
      if (d.tls.validFrom) parts.push(`validFrom ${d.tls.validFrom}`);
      if (d.tls.validTo) parts.push(`validTo ${d.tls.validTo}`);
      if (d.tls.protocol) parts.push(`protocol ${d.tls.protocol}`);
      if (d.tls.authorized !== null && d.tls.authorized !== undefined) {
        parts.push(`trusted ${d.tls.authorized ? 'yes' : 'no'}`);
      }
      if (d.tls.authorizationError) {
        parts.push(`authError ${d.tls.authorizationError}`);
      }
      if (d.tls.cert) {
        const cert: string[] = [];
        if (d.tls.cert.keyAlgo) cert.push(`key ${d.tls.cert.keyAlgo}`);
        if (d.tls.cert.keyBits) cert.push(`${d.tls.cert.keyBits}b`);
        if (d.tls.cert.sigAlgo) cert.push(`sig ${d.tls.cert.sigAlgo}`);
        if (
          d.tls.cert.daysUntilExpiry !== null &&
          d.tls.cert.daysUntilExpiry !== undefined
        ) {
          cert.push(`daysUntilExpiry ${d.tls.cert.daysUntilExpiry}`);
        }
        if (d.tls.cert.mustStaple) cert.push('mustStaple');
        if (d.tls.cert.ocspStapled) cert.push('ocspStapled');
        if (cert.length > 0) parts.push(`cert { ${cert.join(', ')} }`);
      }
      if (parts.length > 0) lines.push(`- **TLS:** ${parts.join('; ')}`);
    }

    if (d.http) {
      const parts: string[] = [];
      parts.push(`redirectsToHttps ${d.http.redirectsToHttps ? 'yes' : 'no'}`);
      if (d.http.finalStatus !== null && d.http.finalStatus !== undefined) {
        parts.push(`finalStatus ${d.http.finalStatus}`);
      }
      if (d.http.finalUrl) parts.push(`finalUrl ${d.http.finalUrl}`);
      if (d.http.hsts) {
        const hsts: string[] = [
          `present ${d.http.hsts.present ? 'yes' : 'no'}`,
        ];
        if (d.http.hsts.maxAge !== null && d.http.hsts.maxAge !== undefined) {
          hsts.push(`maxAge ${d.http.hsts.maxAge}`);
        }
        if (d.http.hsts.includeSubDomains) hsts.push('includeSubDomains');
        if (d.http.hsts.preload) hsts.push('preload');
        parts.push(`HSTS { ${hsts.join(', ')} }`);
      }
      if (d.http.error) parts.push(`error ${d.http.error}`);
      lines.push(`- **HTTP:** ${parts.join('; ')}`);
    }

    if (d.score) {
      lines.push('');
      lines.push(
        `**Score breakdown (${d.score.percent}% / tier ${d.score.tier}):**`,
      );
      for (const item of d.score.breakdown) {
        const ev = item.evidence ? ` — ${item.evidence}` : '';
        lines.push(
          `- ${item.label} (${item.id}): ${item.points}/${item.max} · ${item.status}${ev}`,
        );
      }
      if (d.score.hardOverride) {
        lines.push(
          `- Hard override: ${d.score.hardOverride.kind} — ${d.score.hardOverride.reason}`,
        );
      }
    }
  }

  return { markdown: lines.join('\n'), hostname: domain.hostname };
}

function truncateList(items: string[], max: number): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')}, …`;
}

function withRelativeDays(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const days = Math.round((ms - Date.now()) / 86_400_000);
  if (days === 0) return ' (today)';
  if (days < 0) return ` (${Math.abs(days)}d overdue)`;
  return ` (in ${days}d)`;
}
