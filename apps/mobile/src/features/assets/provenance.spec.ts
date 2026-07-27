import { provenanceDot, provenanceSummary } from './provenance';
import { makeProvenance } from './test-fixtures';

describe('provenanceDot', () => {
  it('is null when the asset is not integration-managed', () => {
    expect(provenanceDot([])).toBeNull();
  });

  it('blocked beats stale beats active', () => {
    expect(provenanceDot([makeProvenance({ state: 'active' })])).toBeNull();
    expect(
      provenanceDot([
        makeProvenance({ state: 'active' }),
        makeProvenance({ state: 'stale' }),
      ]),
    ).toBe('warn');
    expect(
      provenanceDot([
        makeProvenance({ state: 'stale' }),
        makeProvenance({ state: 'blocked' }),
      ]),
    ).toBe('danger');
  });
});

describe('provenanceSummary', () => {
  it('is null for empty provenance', () => {
    expect(provenanceSummary([])).toBeNull();
  });

  it('labels the worst state with the matching tone', () => {
    expect(provenanceSummary([makeProvenance({ state: 'active' })])).toEqual({
      label: 'Synced',
    });
    expect(provenanceSummary([makeProvenance({ state: 'stale' })])).toEqual({
      label: 'Sync stale',
      tone: 'warn',
    });
    expect(
      provenanceSummary([
        makeProvenance({ state: 'stale' }),
        makeProvenance({ state: 'blocked' }),
      ]),
    ).toEqual({ label: 'Sync blocked', tone: 'danger' });
  });
});
