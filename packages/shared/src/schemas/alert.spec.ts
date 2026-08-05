import {
  MAX_ALERT_RECIPIENTS,
  alertConfigInputSchema,
  securityAlertSelectorValues,
} from './alert.js';
import { ipRuleBlockedReportSchema } from './ip-rule.js';

// Minimal valid RECORD_EVENT envelope — only `recipientEmails` varies
// across the cases below, so any failure is attributable to the cap.
function base(recipientEmails: unknown) {
  return {
    name: 'Test alert',
    type: 'RECORD_EVENT' as const,
    recipientEmails,
    recordEntityTypes: ['all' as const],
    recordActions: ['all' as const],
  };
}

function emails(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `u${i}@example.com`);
}

describe('recipientEmailsSchema — recipient cap (WS-031)', () => {
  it('accepts exactly MAX_ALERT_RECIPIENTS distinct recipients (array)', () => {
    const res = alertConfigInputSchema.safeParse(
      base(emails(MAX_ALERT_RECIPIENTS)),
    );
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.recipientEmails).toHaveLength(MAX_ALERT_RECIPIENTS);
    }
  });

  it('rejects >MAX_ALERT_RECIPIENTS distinct recipients (array branch)', () => {
    const res = alertConfigInputSchema.safeParse(
      base(emails(MAX_ALERT_RECIPIENTS + 1)),
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => /too many recipients/i.test(i.message))).toBe(
        true,
      );
    }
  });

  it('rejects >MAX_ALERT_RECIPIENTS distinct recipients (delimited-string branch)', () => {
    const res = alertConfigInputSchema.safeParse(
      base(emails(MAX_ALERT_RECIPIENTS + 1).join(', ')),
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => /too many recipients/i.test(i.message))).toBe(
        true,
      );
    }
  });

  it('counts distinct recipients, not raw parts — duplicates that dedupe under the cap pass', () => {
    const distinct = emails(MAX_ALERT_RECIPIENTS); // 100 unique
    const withDupes = [...distinct, ...distinct]; // 200 entries → 100 distinct
    const res = alertConfigInputSchema.safeParse(base(withDupes));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.recipientEmails).toHaveLength(MAX_ALERT_RECIPIENTS);
    }
  });

  it('rejects a payload exceeding the raw-parts ceiling before per-email validation', () => {
    // 501 junk tokens — over MAX_RAW_RECIPIENT_PARTS (500). Bounds work.
    const junk = Array.from({ length: 501 }, (_, i) => `x${i}`);
    const res = alertConfigInputSchema.safeParse(base(junk));
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => /too many recipients/i.test(i.message))).toBe(
        true,
      );
    }
  });

  it('rejects an oversized raw string before splitting', () => {
    // A single string longer than MAX_RECIPIENT_INPUT_LENGTH (50_000).
    const huge = 'a@example.com,'.repeat(4000); // ~56 KB
    const res = alertConfigInputSchema.safeParse(base(huge));
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => /too long/i.test(i.message))).toBe(true);
    }
  });
});

// Reserved-selector security configs ride on RECORD_EVENT (the AlertType
// enum is frozen in Postgres). The superRefine branch must hold the full
// invariant — sole selector, global scope, recordActions ['all'] — for
// every write, including the API's PATCH merge-then-revalidate path.
describe('security alert selectors', () => {
  const SELECTOR = 'security:sign-in-failures' as const;

  function securityBase(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Security: sign-ins',
      type: 'RECORD_EVENT' as const,
      recipientEmails: ['sec@example.com'],
      recordEntityTypes: [SELECTOR],
      recordActions: ['all' as const],
      ...overrides,
    };
  }

  it('accepts a well-formed config for every selector', () => {
    for (const selector of securityAlertSelectorValues) {
      const res = alertConfigInputSchema.safeParse(
        securityBase({ recordEntityTypes: [selector] }),
      );
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.recordEntityTypes).toEqual([selector]);
        expect(res.data.companyId).toBeNull();
      }
    }
  });

  it('rejects mixing a selector with real entity types', () => {
    const res = alertConfigInputSchema.safeParse(
      securityBase({ recordEntityTypes: ['asset', SELECTOR] }),
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(
        res.error.issues.some((i) => /cannot be combined/i.test(i.message)),
      ).toBe(true);
    }
  });

  it('rejects a company-scoped security config', () => {
    const res = alertConfigInputSchema.safeParse(
      securityBase({ companyId: '3b2f8b1a-6a86-4a5e-9c3e-27e0f5a0c111' }),
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => /global/i.test(i.message))).toBe(true);
    }
  });

  it("rejects recordActions other than exactly ['all']", () => {
    for (const recordActions of [['created'], ['all', 'created'], []]) {
      const res = alertConfigInputSchema.safeParse(
        securityBase({ recordActions }),
      );
      expect(res.success).toBe(false);
    }
  });

  it('enforces the invariant regardless of declared type (leftover selector on a type flip)', () => {
    // A stale client flipping type but still sending the selector with a
    // company: the reserved branch rejects it even though WEBSITE_DOWN
    // itself has no per-type requirements.
    const res = alertConfigInputSchema.safeParse(
      securityBase({
        type: 'WEBSITE_DOWN',
        companyId: '3b2f8b1a-6a86-4a5e-9c3e-27e0f5a0c111',
      }),
    );
    expect(res.success).toBe(false);
  });

  it('accepts the enabled-toggle PATCH merge shape (regression)', () => {
    // `update()` merges the stored row with the patch and re-parses the
    // full envelope — a routine enable/disable toggle must survive.
    const res = alertConfigInputSchema.safeParse(
      securityBase({ enabled: false }),
    );
    expect(res.success).toBe(true);
  });

  it('does not disturb ordinary RECORD_EVENT configs', () => {
    const res = alertConfigInputSchema.safeParse(base(['ops@example.com']));
    expect(res.success).toBe(true);
  });
});

describe('ipRuleBlockedReportSchema', () => {
  it('accepts a minimal report including the 0.0.0.0 sentinel', () => {
    expect(
      ipRuleBlockedReportSchema.safeParse({ ip: '0.0.0.0', cidr: '10.0.0.0/8' })
        .success,
    ).toBe(true);
  });

  it('accepts optional priority, path, and userAgent', () => {
    const res = ipRuleBlockedReportSchema.safeParse({
      ip: '203.0.113.9',
      cidr: '203.0.113.0/24',
      priority: 5,
      path: '/admin',
      userAgent: 'Mozilla/5.0',
    });
    expect(res.success).toBe(true);
  });

  it('rejects oversized fields', () => {
    expect(
      ipRuleBlockedReportSchema.safeParse({ ip: 'x'.repeat(65), cidr: '10.0.0.0/8' })
        .success,
    ).toBe(false);
    expect(
      ipRuleBlockedReportSchema.safeParse({
        ip: '203.0.113.9',
        cidr: '10.0.0.0/8',
        path: 'p'.repeat(501),
      }).success,
    ).toBe(false);
    expect(
      ipRuleBlockedReportSchema.safeParse({
        ip: '203.0.113.9',
        cidr: '10.0.0.0/8',
        userAgent: 'u'.repeat(501),
      }).success,
    ).toBe(false);
  });

  it('rejects missing ip or cidr', () => {
    expect(ipRuleBlockedReportSchema.safeParse({ cidr: '10.0.0.0/8' }).success).toBe(false);
    expect(ipRuleBlockedReportSchema.safeParse({ ip: '1.2.3.4' }).success).toBe(false);
  });
});
