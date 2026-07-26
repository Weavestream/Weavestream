/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { GeneratorSheet } from './GeneratorSheet';

jest.mock('../../lib/api', () => ({ apiFetch: jest.fn() }));
jest.mock('@weavestream/shared/browser', () => {
  const actual = jest.requireActual('@weavestream/shared/browser');
  return { ...actual, generatePassword: jest.fn() };
});

const { apiFetch } = jest.requireMock('../../lib/api') as { apiFetch: jest.Mock };
const { generatePassword } = jest.requireMock('@weavestream/shared/browser') as {
  generatePassword: jest.Mock;
};

function renderSheet(onUse = jest.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(
    <Wrapper>
      <GeneratorSheet open onClose={jest.fn()} onUse={onUse} />
    </Wrapper>,
  );
  return onUse;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Settings request fails → the sheet must still work on the shared
  // fallback defaults (server closet, flaky radio).
  apiFetch.mockRejectedValue(new Error('offline'));
  let n = 0;
  generatePassword.mockImplementation(() => `phrase-${++n}`);
});

describe('GeneratorSheet', () => {
  it('settles after real settings load — no reseed loop', async () => {
    // Regression: useGeneratorDefaults used to re-parse per render,
    // returning a new object identity every time; the reseed effect
    // depends on it, so the sheet spun in a setState→render loop the
    // moment the settings request succeeded. (The original tests only
    // covered the FAILED settings path, where the stable module
    // constant masked the bug.)
    apiFetch.mockResolvedValue({
      passwordGeneratorDefaults: {
        preset: 'read',
        length: 24,
        words: 5,
        separator: 'dot',
        alternateCase: false,
        includeNumber: true,
      },
    });
    renderSheet();

    // Open seeds from the fallback, then reseeds ONCE when the server
    // values land.
    await screen.findByText('phrase-2');
    expect(generatePassword).toHaveBeenLastCalledWith(
      expect.objectContaining({ preset: 'read', length: 24, words: 5 }),
    );

    // Let any further renders settle: the count must not move again.
    await new Promise((r) => setTimeout(r, 25));
    expect(generatePassword).toHaveBeenCalledTimes(2);
  });

  it('generates on open using the fallback defaults when settings are unreachable', async () => {
    renderSheet();
    expect(await screen.findByText('phrase-1')).toBeInTheDocument();
    expect(generatePassword).toHaveBeenCalledWith(
      expect.objectContaining({ preset: 'say', length: 20, words: 4 }),
    );
  });

  it('switching preset reseeds the knobs from the preset defaults', async () => {
    renderSheet();
    await screen.findByText('phrase-1');
    fireEvent.click(screen.getByRole('radio', { name: 'Remember' }));
    expect(generatePassword).toHaveBeenLastCalledWith(
      expect.objectContaining({ preset: 'remember', length: 12, words: 3 }),
    );
    expect(screen.getByText('phrase-2')).toBeInTheDocument();
  });

  it('regenerate produces a new phrase with the same knobs', async () => {
    renderSheet();
    await screen.findByText('phrase-1');
    fireEvent.click(screen.getByRole('button', { name: 'Generate another' }));
    expect(screen.getByText('phrase-2')).toBeInTheDocument();
  });

  it('knob changes regenerate; Use hands the current preview to the form', async () => {
    const onUse = renderSheet();
    await screen.findByText('phrase-1');
    fireEvent.click(screen.getByRole('button', { name: '_' })); // underscore chip
    expect(generatePassword).toHaveBeenLastCalledWith(
      expect.objectContaining({ separator: 'underscore' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use this password' }));
    expect(onUse).toHaveBeenCalledWith('phrase-2');
  });
});
