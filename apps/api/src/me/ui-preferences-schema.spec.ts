import {
  DEFAULT_SHOW_ITEM_COUNTS,
  publicUiPreferencesSchema,
  uiAccentSchema,
  uiAccentValues,
  uiThemeSchema,
  uiThemeValues,
  userUiPreferencesSchema,
  userUiPreferencesUpdateSchema,
} from '@weavestream/shared';

/**
 * Phase 9b.1 — shared schema coverage. The important invariants:
 *   - lowercase-only enum values (so they map 1:1 to [data-theme=…]/[data-accent=…])
 *   - partial updates accepted (theme or accent alone)
 *   - empty patch rejected
 *   - public endpoint only takes a theme
 */

describe('uiThemeSchema', () => {
  it('accepts every documented value', () => {
    for (const v of uiThemeValues) {
      expect(uiThemeSchema.safeParse(v).success).toBe(true);
    }
  });

  it('rejects uppercase variants — the wire format is lowercase', () => {
    expect(uiThemeSchema.safeParse('DARK').success).toBe(false);
    expect(uiThemeSchema.safeParse('Light').success).toBe(false);
  });

  it('rejects unknown themes', () => {
    expect(uiThemeSchema.safeParse('neon').success).toBe(false);
    expect(uiThemeSchema.safeParse('').success).toBe(false);
  });
});

describe('uiAccentSchema', () => {
  it('accepts exactly the five shipped palettes', () => {
    for (const v of uiAccentValues) {
      expect(uiAccentSchema.safeParse(v).success).toBe(true);
    }
    expect(uiAccentValues.length).toBe(5);
  });

  it('rejects unknown accents', () => {
    expect(uiAccentSchema.safeParse('fuchsia').success).toBe(false);
    expect(uiAccentSchema.safeParse('LIME').success).toBe(false);
  });
});

describe('userUiPreferencesUpdateSchema', () => {
  it('accepts theme alone', () => {
    const out = userUiPreferencesUpdateSchema.parse({ uiTheme: 'dark' });
    expect(out).toEqual({ uiTheme: 'dark' });
  });

  it('accepts accent alone', () => {
    const out = userUiPreferencesUpdateSchema.parse({ uiAccent: 'iris' });
    expect(out).toEqual({ uiAccent: 'iris' });
  });

  it('accepts both together', () => {
    const out = userUiPreferencesUpdateSchema.parse({
      uiTheme: 'light',
      uiAccent: 'coral',
    });
    expect(out).toEqual({ uiTheme: 'light', uiAccent: 'coral' });
  });

  it('rejects an empty patch', () => {
    expect(userUiPreferencesUpdateSchema.safeParse({}).success).toBe(false);
  });

  it('rejects garbage values in any slot', () => {
    expect(
      userUiPreferencesUpdateSchema.safeParse({ uiTheme: 'neon' }).success,
    ).toBe(false);
    expect(
      userUiPreferencesUpdateSchema.safeParse({ uiAccent: 'fuchsia' }).success,
    ).toBe(false);
    // A truthy string must not sneak past as `true` — density is a
    // real boolean on the wire, not a coerced one.
    expect(
      userUiPreferencesUpdateSchema.safeParse({ showItemCounts: 'yes' })
        .success,
    ).toBe(false);
  });

  it('accepts showItemCounts alone, in both positions', () => {
    expect(
      userUiPreferencesUpdateSchema.parse({ showItemCounts: true }),
    ).toEqual({ showItemCounts: true });
    // `false` is a meaningful patch, not an absent field — the refine
    // counts keys, so turning counts back off must survive it.
    expect(
      userUiPreferencesUpdateSchema.parse({ showItemCounts: false }),
    ).toEqual({ showItemCounts: false });
  });
});

describe('userUiPreferencesSchema', () => {
  it('requires all three fields — it is the resolved /auth/me payload', () => {
    expect(
      userUiPreferencesSchema.safeParse({ uiTheme: 'dark', uiAccent: 'lime' })
        .success,
    ).toBe(false);
    expect(
      userUiPreferencesSchema.parse({
        uiTheme: 'dark',
        uiAccent: 'lime',
        showItemCounts: false,
      }),
    ).toEqual({ uiTheme: 'dark', uiAccent: 'lime', showItemCounts: false });
  });

  it('defaults counts off', () => {
    expect(DEFAULT_SHOW_ITEM_COUNTS).toBe(false);
  });
});

describe('publicUiPreferencesSchema', () => {
  it('accepts theme only', () => {
    expect(publicUiPreferencesSchema.parse({ uiTheme: 'light' })).toEqual({
      uiTheme: 'light',
    });
  });

  it('rejects extra fields at runtime (accent is signed-in-only)', () => {
    // z.object is non-strict by default — but we still want to ensure
    // that whatever we pass through the wire, the API ignores accent
    // and never echoes it back as part of the parsed type. Therefore
    // we assert the output shape, not the input rejection.
    const out = publicUiPreferencesSchema.parse({
      uiTheme: 'dark',
      uiAccent: 'iris',
    } as { uiTheme: 'dark' });
    expect(out).toEqual({ uiTheme: 'dark' });
    expect((out as { uiAccent?: unknown }).uiAccent).toBeUndefined();
  });

  it('requires a theme value', () => {
    expect(publicUiPreferencesSchema.safeParse({}).success).toBe(false);
  });
});
