/**
 * @jest-environment jsdom
 */
/**
 * The step-up host's teardown contract.
 *
 * Unregistering the callbacks is not enough on its own. If the host
 * unmounts with a prompt open — a hard navigation, or the session gate
 * flipping to its error branch — the resolver it owns is left unsettled.
 * The request that triggered the prompt then awaits a promise nobody will
 * resolve, and because the coordinator's shared `pending` never clears,
 * *every later* step-up joins that same dead promise. The symptom is an
 * app that stops being able to reveal anything, with nothing in the
 * console.
 */
import '@testing-library/jest-dom';
import { act, render } from '@testing-library/react';
import { StepUpHost } from './StepUpHost';
import {
  hasPendingStepUp,
  hasStepUpOpener,
  registerStepUpOpener,
  requestStepUp,
} from '../lib/step-up';

jest.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: '/passwords', search: {}, state: {} }),
}));
jest.mock('../lib/api', () => ({
  apiFetch: jest.fn(),
  ApiError: class extends Error {},
}));

beforeEach(() => registerStepUpOpener(null, null));
afterEach(() => registerStepUpOpener(null, null));

describe('StepUpHost teardown', () => {
  it('settles a pending prompt when it unmounts', async () => {
    const { unmount } = render(<StepUpHost />);
    let inflight!: Promise<boolean>;
    act(() => {
      inflight = requestStepUp('mfa');
    });
    expect(hasPendingStepUp()).toBe(true);

    unmount();

    // Resolved `false` — the same outcome as Cancel, which is the honest
    // reading: the prompt is gone without being completed.
    await expect(inflight).resolves.toBe(false);
    expect(hasPendingStepUp()).toBe(false);
    expect(hasStepUpOpener()).toBe(false);
  });

  it('leaves the coordinator usable for the next host', async () => {
    // The failure mode this guards is cumulative: a stranded `pending`
    // poisons every subsequent attempt, not just the one that was open.
    const first = render(<StepUpHost />);
    let abandoned!: Promise<boolean>;
    act(() => {
      abandoned = requestStepUp('mfa');
    });
    first.unmount();
    await expect(abandoned).resolves.toBe(false);

    render(<StepUpHost />);
    let second!: Promise<boolean>;
    act(() => {
      second = requestStepUp('password');
    });

    expect(hasPendingStepUp()).toBe(true);
    // A real prompt this time, not the dead promise from before.
    expect(second).not.toBe(abandoned);
  });

  it('unmounting with nothing pending is harmless', async () => {
    const { unmount } = render(<StepUpHost />);
    unmount();

    expect(hasPendingStepUp()).toBe(false);
    expect(hasStepUpOpener()).toBe(false);
    // With no host, a request resolves false immediately rather than hanging.
    await expect(requestStepUp('mfa')).resolves.toBe(false);
  });
});
