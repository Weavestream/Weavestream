/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { SetupGuideStep } from '@weavestream/shared';
import { ToastProvider } from '../ui';
import { SetupGuide } from './setup-guide';

const copyToClipboard = jest.fn();
jest.mock('@weavestream/shared/browser', () => ({
  copyToClipboard: (...a: unknown[]) => copyToClipboard(...a),
}));

const REDIRECT = 'https://ws.example.test/api/v1/admin/integrations/oauth/callback';
const steps: SetupGuideStep[] = [
  {
    id: 'apis',
    title: 'Turn on the APIs',
    body: 'Press **Enable** on each.\n\n- First API\n- Second API\n\n<img src=x onerror=alert(1)>',
    links: [
      { label: 'API library', href: 'https://console.example.test/apis' },
      // Defence in depth: the schema forbids it, the renderer drops it too.
      { label: 'Bad link', href: 'javascript:alert(1)' },
    ],
  },
  {
    id: 'client',
    title: 'Create the client',
    body: 'Paste the redirect URI.',
    copyValues: [
      { label: 'Authorized redirect URI', computed: 'redirectUri' },
      { label: 'Origin', computed: 'authorizedOrigin' },
      { label: 'Scopes', computed: 'scopes' },
    ],
  },
];

function renderGuide(props: Partial<Parameters<typeof SetupGuide>[0]> = {}) {
  render(
    <ToastProvider>
      <SetupGuide steps={steps} redirectUri={REDIRECT} scopeGroups={[{ scopes: ['openid', 'email.read'] }]} check={null} {...props} />
    </ToastProvider>,
  );
}

beforeEach(() => copyToClipboard.mockReset().mockResolvedValue(true));

describe('SetupGuide', () => {
  it('renders numbered steps with bold, bullets and plain-text markup (never HTML)', () => {
    const { container } = render(
      <ToastProvider>
        <SetupGuide steps={steps} redirectUri={REDIRECT} scopeGroups={[]} check={null} />
      </ToastProvider>,
    );
    expect(screen.getByText('Enable').tagName).toBe('STRONG');
    expect(screen.getByText('First API').tagName).toBe('LI');
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('opens https links in a new tab with noopener noreferrer and drops other schemes', () => {
    renderGuide();
    const link = screen.getByRole('link', { name: /API library/ });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('link', { name: /Bad link/ })).toBeNull();
  });

  it('copies computed values', async () => {
    renderGuide();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy authorized redirect uri' }));
    });
    expect(copyToClipboard).toHaveBeenLastCalledWith(REDIRECT);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy origin' }));
    });
    expect(copyToClipboard).toHaveBeenLastCalledWith('https://ws.example.test');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy scope openid' }));
    });
    expect(copyToClipboard).toHaveBeenLastCalledWith('openid');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy scope email.read' }));
    });
    expect(copyToClipboard).toHaveBeenLastCalledWith('email.read');
  });

  it('marks passed steps green and failed steps with their fixed message', () => {
    renderGuide({
      check: {
        ok: false,
        passedStepIds: ['client'],
        failures: [
          { stepId: 'apis', message: 'The Admin SDK API is not enabled.' },
          { stepId: null, message: 'Google is rate limiting requests right now.' },
        ],
      },
    });
    const items = screen.getAllByRole('listitem').filter((li) => li.hasAttribute('data-state'));
    expect(items.map((li) => li.getAttribute('data-state'))).toEqual(['failed', 'passed']);
    expect(screen.getByText('The Admin SDK API is not enabled.')).toBeInTheDocument();
    expect(screen.getByText('Google is rate limiting requests right now.')).toBeInTheDocument();
  });

  it('leaves an unverified step neither passed nor failed and shows its note', () => {
    renderGuide({
      check: { ok: true, passedStepIds: ['apis'], failures: [], notes: [{ stepId: 'client', message: 'Redirect URI is confirmed on the first successful connect.' }] },
    });
    const items = screen.getAllByRole('listitem').filter((li) => li.hasAttribute('data-state'));
    expect(items.map((li) => li.getAttribute('data-state'))).toEqual(['passed', 'todo']);
    expect(screen.getByText('Redirect URI is confirmed on the first successful connect.')).toBeInTheDocument();
  });

  it('runs Check setup, and disables it with a reason when not ready', () => {
    const onCheck = jest.fn();
    renderGuide({ onCheck });
    fireEvent.click(screen.getByRole('button', { name: /Check setup/ }));
    expect(onCheck).toHaveBeenCalledTimes(1);
  });

  it('explains why Check setup is disabled', () => {
    renderGuide({ onCheck: jest.fn(), checkDisabledReason: 'Connect first.' });
    expect(screen.getByRole('button', { name: /Check setup/ })).toBeDisabled();
    expect(screen.getByText('Connect first.')).toBeInTheDocument();
  });

  it('collapses and expands', () => {
    renderGuide({ defaultOpen: false });
    expect(screen.queryByText('Turn on the APIs')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Setup guide/ }));
    expect(screen.getByText('Turn on the APIs')).toBeInTheDocument();
  });
});
