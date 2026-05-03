import {
  createCompanySchema,
  updateCompanySchema,
  companyTypeSchema,
} from '@weavestream/shared';

/**
 * Phase 9a schema coverage. We focus on the tricky bits:
 *   - empty-string → null preprocessing for optional text
 *   - email / phone / website shape constraints
 *   - at-least-one-field refinement on the update DTO
 *   - CompanyType enum coverage
 */

describe('companyTypeSchema', () => {
  it('accepts every documented value', () => {
    for (const v of ['CLIENT', 'PROSPECT', 'VENDOR', 'INTERNAL', 'PARTNER', 'OTHER']) {
      expect(companyTypeSchema.safeParse(v).success).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(companyTypeSchema.safeParse('RESELLER').success).toBe(false);
  });
});

describe('createCompanySchema', () => {
  it('defaults type to CLIENT when omitted', () => {
    const out = createCompanySchema.parse({ name: 'Acme', slug: 'acme' });
    expect(out.type).toBe('CLIENT');
  });

  it('accepts an explicit type', () => {
    const out = createCompanySchema.parse({
      name: 'Acme',
      slug: 'acme',
      type: 'VENDOR',
    });
    expect(out.type).toBe('VENDOR');
  });

  it('enforces slug format (kebab-case only)', () => {
    expect(
      createCompanySchema.safeParse({ name: 'Bad', slug: 'Bad_Slug' }).success,
    ).toBe(false);
    expect(
      createCompanySchema.safeParse({ name: 'OK', slug: 'ok-slug' }).success,
    ).toBe(true);
  });

  it('enforces slug max length of 40', () => {
    const over = 'a'.repeat(41);
    expect(createCompanySchema.safeParse({ name: 'X', slug: over }).success).toBe(
      false,
    );
  });
});

describe('updateCompanySchema', () => {
  it('rejects an empty patch', () => {
    expect(updateCompanySchema.safeParse({}).success).toBe(false);
  });

  it('normalises empty strings to null on nullable text fields', () => {
    const out = updateCompanySchema.parse({
      quickNotes: '',
      contactEmail: '   ',
      addressLine1: '',
    });
    expect(out.quickNotes).toBeNull();
    expect(out.contactEmail).toBeNull();
    expect(out.addressLine1).toBeNull();
  });

  it('passes through trimmed non-empty text', () => {
    const out = updateCompanySchema.parse({
      contactName: '  Jane Doe  ',
    });
    expect(out.contactName).toBe('Jane Doe');
  });

  it('validates email shape', () => {
    expect(
      updateCompanySchema.safeParse({ contactEmail: 'not-an-email' }).success,
    ).toBe(false);
    expect(
      updateCompanySchema.safeParse({ contactEmail: 'ops@example.com' }).success,
    ).toBe(true);
  });

  it('accepts bare hostnames and fully-qualified urls for website', () => {
    expect(
      updateCompanySchema.safeParse({ website: 'example.com' }).success,
    ).toBe(true);
    expect(
      updateCompanySchema.safeParse({ website: 'https://example.com/x' }).success,
    ).toBe(true);
  });

  it('accepts null for parentCompanyId (clears the relation)', () => {
    const out = updateCompanySchema.parse({ parentCompanyId: null });
    expect(out.parentCompanyId).toBeNull();
  });

  it('rejects malformed UUIDs on foreign keys', () => {
    expect(
      updateCompanySchema.safeParse({ parentCompanyId: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('accepts a valid UUID on foreign keys', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(
      updateCompanySchema.safeParse({ parentCompanyId: id }).success,
    ).toBe(true);
  });

  it('loose phone validation allows punctuation', () => {
    expect(
      updateCompanySchema.safeParse({ phone: '+1 (555) 867-5309' }).success,
    ).toBe(true);
  });

  it('phone rejects free-form text', () => {
    expect(
      updateCompanySchema.safeParse({ phone: 'call me maybe' }).success,
    ).toBe(false);
  });

  it('accepts a sticky note up to 300 characters', () => {
    expect(
      updateCompanySchema.safeParse({
        stickyNoteText: 'a'.repeat(300),
        stickyNoteSeverity: 'WARN',
      }).success,
    ).toBe(true);
  });

  it('rejects a sticky note over 300 characters', () => {
    expect(
      updateCompanySchema.safeParse({ stickyNoteText: 'a'.repeat(301) }).success,
    ).toBe(false);
  });

  it('accepts null sticky note (clearing the banner)', () => {
    const out = updateCompanySchema.parse({
      stickyNoteText: null,
      stickyNoteSeverity: null,
    });
    expect(out.stickyNoteText).toBeNull();
    expect(out.stickyNoteSeverity).toBeNull();
  });

  it('rejects an unknown severity', () => {
    expect(
      updateCompanySchema.safeParse({ stickyNoteSeverity: 'BOGUS' }).success,
    ).toBe(false);
  });
});
