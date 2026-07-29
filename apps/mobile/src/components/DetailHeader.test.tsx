/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { DetailHeader } from './DetailHeader';

/**
 * Phase 5b: when the chevron will NOT pop history (a cold deep link),
 * it goes to the launcher and says "Home" — the deep link's record may
 * belong to any org, so a wrong-org list is never a safe fallback.
 * Popping behavior stays byte-identical to pre-5b.
 */

let willPop = true;
const backOrCalls: Array<[string, unknown]> = [];

jest.mock('../lib/use-back', () => ({
  useWillPop: () => willPop,
  useBackOr: (to: string, search?: unknown) => {
    backOrCalls.push([to, search]);
    return jest.fn();
  },
  useBackLabel: (label: string) => `stamped:${label}`,
}));

beforeEach(() => {
  backOrCalls.length = 0;
});

describe('DetailHeader back fallback', () => {
  it('keeps the structural target and honest label when history will pop', () => {
    willPop = true;
    render(
      <DetailHeader backLabel="Passwords" backTo="/passwords" backSearch={{ folder: 'f1' }} />,
    );

    expect(screen.getByRole('button')).toHaveTextContent('stamped:Passwords');
    expect(backOrCalls[0]).toEqual(['/passwords', { folder: 'f1' }]);
  });

  it('falls back to the launcher labeled "Home" when there is no history to pop', () => {
    willPop = false;
    render(
      <DetailHeader backLabel="Passwords" backTo="/passwords" backSearch={{ folder: 'f1' }} />,
    );

    expect(screen.getByRole('button')).toHaveTextContent('Home');
    expect(backOrCalls[0]).toEqual(['/app', undefined]);
  });
});
