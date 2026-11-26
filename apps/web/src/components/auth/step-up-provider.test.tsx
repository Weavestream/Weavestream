/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { StepUpProvider } from './step-up-provider';
import { requestStepUp } from '../../lib/step-up';

const apiFetch = jest.fn();
jest.mock('../../lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

beforeEach(() => apiFetch.mockReset());

// requestStepUp keeps one module-level in-flight prompt, so every test must
// settle its dialog (Cancel) or the next test would join the stale one.
async function cancel() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  });
}

async function open(factor: 'mfa' | 'password' | 'sso') {
  render(<StepUpProvider>{null}</StepUpProvider>);
  let done!: Promise<boolean>;
  await act(async () => {
    done = requestStepUp(factor);
  });
  return { done };
}

describe('StepUpProvider sso factor', () => {
  it('explains the identity provider check and links to the step-up path', async () => {
    await open('sso');
    expect(screen.getByText(/Confirm it is you with your identity provider/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue to identity provider' })).toHaveAttribute(
      'href',
      '/api/v1/auth/sso/step-up',
    );
    await cancel();
  });

  it('shows no code input and never calls the verify endpoint', async () => {
    await open('sso');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByText(/Confirm it is you with your identity provider/), {
      key: 'Enter',
    });
    expect(apiFetch).not.toHaveBeenCalled();
    await cancel();
  });

  it('resolves false when cancelled', async () => {
    const { done } = await open('sso');
    await cancel();
    await expect(done).resolves.toBe(false);
  });

  it('still shows the password field for the password factor', async () => {
    await open('password');
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /identity provider/ })).not.toBeInTheDocument();
    await cancel();
  });
});
