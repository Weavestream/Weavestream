import {
  activeChoiceCard,
  alertKindLabel,
  ALERT_CHOICE_CARDS,
  emptyDraft,
  payloadRecordActions,
  securitySelectorOfConfig,
  selectAlertChoice,
  type DraftState,
} from './alert-choice';

/**
 * Wizard type-transition invariants: a security choice sets the exact
 * reserved shape; switching away strips the selector so it can never
 * ride into another type's payload (`toPayload` always sends
 * `recordEntityTypes`, and the server rejects hybrids).
 */

const SELECTOR = 'security:ip-blocked' as const;

function securityDraft(): DraftState {
  return selectAlertChoice(emptyDraft(), { kind: 'security', selector: SELECTOR });
}

describe('selectAlertChoice', () => {
  it('ordinary → security sets the full invariant in one transition', () => {
    const draft = {
      ...emptyDraft(),
      type: 'RECORD_EVENT' as const,
      recordEntityTypes: ['asset' as const, 'password' as const],
      recordActions: ['created' as const],
      company: { id: 'c-1', name: 'Acme', slug: 'acme', archivedAt: null },
    };
    const next = selectAlertChoice(draft, { kind: 'security', selector: SELECTOR });
    expect(next.type).toBe('RECORD_EVENT');
    expect(next.recordEntityTypes).toEqual([SELECTOR]);
    expect(next.recordActions).toEqual(['all']);
    expect(next.company).toBeNull();
    // Unrelated fields survive.
    expect(next.name).toBe(draft.name);
    expect(next.recipientEmails).toBe(draft.recipientEmails);
  });

  it('security → WEBSITE_DOWN strips the selector and restores a picker-safe default', () => {
    const next = selectAlertChoice(securityDraft(), {
      kind: 'type',
      type: 'WEBSITE_DOWN',
    });
    expect(next.type).toBe('WEBSITE_DOWN');
    expect(next.recordEntityTypes).toEqual(['all']);
    expect(next.recordEntityTypes.some((v) => v.startsWith('security:'))).toBe(false);
  });

  it('security → ordinary RECORD_EVENT strips the selector', () => {
    const next = selectAlertChoice(securityDraft(), {
      kind: 'type',
      type: 'RECORD_EVENT',
    });
    expect(next.type).toBe('RECORD_EVENT');
    expect(next.recordEntityTypes).toEqual(['all']);
    expect(next.recordActions).toEqual(['all']);
    expect(securitySelectorOfConfig(next)).toBeNull();
  });

  it('security → security swaps the selector cleanly', () => {
    const next = selectAlertChoice(securityDraft(), {
      kind: 'security',
      selector: 'security:sign-in-failures',
    });
    expect(next.recordEntityTypes).toEqual(['security:sign-in-failures']);
  });

  it('ordinary → ordinary preserves real entity-type selections', () => {
    const draft = {
      ...emptyDraft(),
      type: 'RECORD_EVENT' as const,
      recordEntityTypes: ['asset' as const, 'domain' as const],
      recordActions: ['deleted' as const],
    };
    const next = selectAlertChoice(draft, { kind: 'type', type: 'SINGLE_EXPIRATION' });
    expect(next.recordEntityTypes).toEqual(['asset', 'domain']);
    expect(next.recordActions).toEqual(['deleted']);
  });
});

describe('securitySelectorOfConfig / alertKindLabel', () => {
  it('detects only the exact reserved shape', () => {
    expect(securitySelectorOfConfig(securityDraft())).toBe(SELECTOR);
    // Type gate: a leftover selector under another type is NOT security.
    expect(
      securitySelectorOfConfig({
        type: 'WEBSITE_DOWN',
        recordEntityTypes: [SELECTOR],
      }),
    ).toBeNull();
    // Sole-element gate.
    expect(
      securitySelectorOfConfig({
        type: 'RECORD_EVENT',
        recordEntityTypes: ['asset', SELECTOR],
      }),
    ).toBeNull();
    expect(
      securitySelectorOfConfig({ type: 'RECORD_EVENT', recordEntityTypes: ['all'] }),
    ).toBeNull();
  });

  it('labels security configs by kind and ordinary configs by type', () => {
    expect(alertKindLabel(securityDraft())).toBe('IP blocked or rate limited');
    expect(
      alertKindLabel({ type: 'RECORD_EVENT', recordEntityTypes: ['all'] }),
    ).toBe('Record created/updated/deleted');
    expect(
      alertKindLabel({ type: 'WEBSITE_DOWN', recordEntityTypes: [] }),
    ).toBe('Website down');
  });
});

describe('payloadRecordActions', () => {
  it("strips actions PASSWORD_EVENT cannot carry, keeping the server-accepted 'all'", () => {
    const strip = (recordActions: DraftState['recordActions']) =>
      payloadRecordActions({ type: 'PASSWORD_EVENT', recordActions });
    // A legacy config (or a RECORD_EVENT draft switched to
    // PASSWORD_EVENT) can carry 'deleted', which the dialog hides —
    // sending it makes the server reject an off-screen checkbox.
    expect(strip(['created', 'deleted'])).toEqual(['created']);
    expect(strip(['all', 'deleted'])).toEqual(['all']);
    // Nothing left → the server's on-screen "pick at least one action"
    // error, never the off-screen 'deleted' rejection.
    expect(strip(['deleted'])).toEqual([]);
  });

  it('passes every other type through untouched', () => {
    expect(
      payloadRecordActions({ type: 'RECORD_EVENT', recordActions: ['deleted'] }),
    ).toEqual(['deleted']);
  });
});

describe('wizard cards', () => {
  it('offers all five types plus the three security kinds', () => {
    expect(ALERT_CHOICE_CARDS).toHaveLength(8);
    const labels = ALERT_CHOICE_CARDS.map((c) => c.label);
    expect(labels).toContain('Repeated failed sign-ins');
    expect(labels).toContain('IP blocked or rate limited');
    expect(labels).toContain('Suspicious account behavior');
  });

  it('activeChoiceCard resolves the current draft to its card', () => {
    expect(activeChoiceCard(securityDraft())?.label).toBe('IP blocked or rate limited');
    expect(activeChoiceCard(emptyDraft())?.label).toBe('Single expiration');
  });
});
