import {
  MAX_ALERT_RECIPIENTS,
  alertConfigInputSchema,
} from './alert.js';

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
