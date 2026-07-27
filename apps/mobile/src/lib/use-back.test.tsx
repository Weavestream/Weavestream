/**
 * @jest-environment jsdom
 */
/**
 * The bug this pins: detail → More tab → Passwords tab re-pushes the
 * detail, whose previous history entry is now MORE — so a blind
 * `history.back()` sent the "‹ Passwords" chevron to the More screen.
 * The chevron may pop history only when the entry carries the
 * `upIsBack` stamp (pushed straight from its parent); anything else
 * navigates structurally to the fallback, filters included.
 */
import { useBackLabel, useBackOr } from './use-back';

const backMock = jest.fn();
const navigateMock = jest.fn();
let canGoBack = true;
let locationState: Record<string, unknown> = {};

jest.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { back: backMock } }),
  useCanGoBack: () => canGoBack,
  useLocation: () => ({ state: locationState }),
}));
jest.mock('./scoped-nav', () => {
  const actual = jest.requireActual('./scoped-nav');
  return { ...actual, useScopedNavigate: () => navigateMock };
});

import { renderHook } from '@testing-library/react';

beforeEach(() => {
  jest.clearAllMocks();
  canGoBack = true;
  locationState = {};
});

describe('useBackOr', () => {
  it('pops history when the entry was pushed straight from its parent', () => {
    locationState = { upIsBack: true };
    const { result } = renderHook(() => useBackOr('/passwords'));
    result.current();
    expect(backMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('navigates structurally when the entry is unstamped — the cross-tab case', () => {
    // This IS the reported flow: the re-pushed detail after a tab
    // round-trip has no stamp, and its previous entry is another tab.
    locationState = {};
    const { result } = renderHook(() =>
      useBackOr('/passwords', { folder: 'f1' }),
    );
    result.current();
    expect(backMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/passwords',
      replace: true,
      search: { folder: 'f1' },
    });
  });

  it('falls back structurally when there is no history to pop at all', () => {
    locationState = { upIsBack: true };
    canGoBack = false;
    const { result } = renderHook(() => useBackOr('/passwords'));
    result.current();
    expect(backMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/passwords',
      replace: true,
      search: undefined,
    });
  });
});

describe('useBackLabel', () => {
  it('shows the stamped label only when the chevron will really pop', () => {
    // A search result stamped this entry: pop goes to Search, so the
    // chevron must say so.
    locationState = { upIsBack: true, backLabel: 'Search' };
    const { result } = renderHook(() => useBackLabel('Passwords'));
    expect(result.current).toBe('Search');
  });

  it('shows the structural label when the entry cannot pop', () => {
    // Same stamp, but no history to pop — useBackOr would navigate
    // structurally to the list, so "Search" would be a lie.
    locationState = { upIsBack: true, backLabel: 'Search' };
    canGoBack = false;
    const { result } = renderHook(() => useBackLabel('Passwords'));
    expect(result.current).toBe('Passwords');
  });

  it('shows the structural label on an unstamped entry (cold deep link)', () => {
    locationState = {};
    const { result } = renderHook(() => useBackLabel('Passwords'));
    expect(result.current).toBe('Passwords');
  });

  it('ignores a label without the upIsBack stamp', () => {
    // A backLabel that somehow survived without its positional partner
    // must not relabel a structural navigation.
    locationState = { backLabel: 'Search' };
    const { result } = renderHook(() => useBackLabel('Passwords'));
    expect(result.current).toBe('Passwords');
  });
});
