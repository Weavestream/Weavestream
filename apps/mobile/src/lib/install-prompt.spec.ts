/** @jest-environment jsdom */
import {
  canPromptInstall,
  isIosSafariInstallTarget,
  isStandalone,
  promptInstall,
  subscribeInstallAvailability,
} from './install-prompt';

function fakeBeforeInstallPrompt(): Event & {
  prompt: jest.Mock;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  defaultPrevented: boolean;
} {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  return Object.assign(event, {
    prompt: jest.fn().mockResolvedValue(undefined),
    userChoice: Promise.resolve({ outcome: 'accepted' as const }),
  });
}

function setUserAgent(ua: string, platform = '', maxTouchPoints = 0): void {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', {
    value: maxTouchPoints,
    configurable: true,
  });
}

describe('install prompt capture', () => {
  it('captures beforeinstallprompt (module-eval listener) and consumes it once', async () => {
    expect(canPromptInstall()).toBe(false);

    const event = fakeBeforeInstallPrompt();
    window.dispatchEvent(event);
    // Chrome's mini-infobar suppressed; the More tab owns the timing.
    expect(event.defaultPrevented).toBe(true);
    expect(canPromptInstall()).toBe(true);

    await promptInstall();
    expect(event.prompt).toHaveBeenCalledTimes(1);
    // Single-use, consumed regardless of choice.
    expect(canPromptInstall()).toBe(false);
    await promptInstall(); // no stashed event — a no-op, not a crash
    expect(event.prompt).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers on capture and on appinstalled', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeInstallAvailability(listener);

    window.dispatchEvent(fakeBeforeInstallPrompt());
    expect(listener).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('appinstalled'));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(canPromptInstall()).toBe(false);

    unsubscribe();
    window.dispatchEvent(fakeBeforeInstallPrompt());
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('isStandalone', () => {
  it('detects the display-mode media query and the iOS legacy flag', () => {
    const matchMedia = jest.fn().mockReturnValue({ matches: false });
    Object.defineProperty(window, 'matchMedia', {
      value: matchMedia,
      configurable: true,
    });
    expect(isStandalone()).toBe(false);

    matchMedia.mockReturnValue({ matches: true });
    expect(isStandalone()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith('(display-mode: standalone)');

    matchMedia.mockReturnValue({ matches: false });
    Object.defineProperty(navigator, 'standalone', {
      value: true,
      configurable: true,
    });
    expect(isStandalone()).toBe(true);
    Object.defineProperty(navigator, 'standalone', {
      value: undefined,
      configurable: true,
    });
  });
});

describe('isIosSafariInstallTarget', () => {
  it('matches iPhone Safari and iPadOS-13+ masquerading as MacIntel', () => {
    setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
    );
    expect(isIosSafariInstallTarget()).toBe(true);

    // iPadOS 13+ reports MacIntel; touch points give it away.
    setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/604.1',
      'MacIntel',
      5,
    );
    expect(isIosSafariInstallTarget()).toBe(true);
  });

  it('rejects desktop macOS and non-Safari iOS browsers', () => {
    setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/604.1',
      'MacIntel',
      0,
    );
    expect(isIosSafariInstallTarget()).toBe(false);

    // Chrome on iOS cannot install PWAs — only Safari's Share sheet can.
    setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) CriOS/120.0 Mobile/15E148 Safari/604.1',
    );
    expect(isIosSafariInstallTarget()).toBe(false);

    setUserAgent(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
    );
    expect(isIosSafariInstallTarget()).toBe(false);
  });
});
