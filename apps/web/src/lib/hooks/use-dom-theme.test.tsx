/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';
import { applyDomTheme, useDomTheme } from './use-dom-theme';

/**
 * Stands in for one mounted theme reader — an `AppearanceRow` inside a
 * `ProfileMenu`, or a `ThemeToggle`. The point of every test here is
 * that several of these coexist: the shell mounts the action cluster
 * twice (desktop `TopBar` + `MobileShellChrome`), hiding one with CSS
 * rather than unmounting it.
 */
function Probe({ id }: { id: string }) {
  return <output aria-label={id}>{useDomTheme()}</output>;
}

function reading(id: string): string | null {
  return screen.getByLabelText(id).textContent;
}

describe('useDomTheme', () => {
  beforeEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it('reads the applied theme from <html data-theme>', () => {
    document.documentElement.dataset.theme = 'light';
    render(<Probe id="a" />);
    expect(reading('a')).toBe('light');
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['unrecognised', 'sepia'],
  ])('defaults to dark when the attribute is %s', (_label, value) => {
    if (value === undefined) {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = value;
    }
    render(<Probe id="a" />);
    expect(reading('a')).toBe('dark');
  });

  it('keeps every mounted reader in step when one of them applies a theme', async () => {
    document.documentElement.dataset.theme = 'dark';
    render(
      <>
        <Probe id="desktop" />
        <Probe id="mobile" />
      </>,
    );
    expect(reading('desktop')).toBe('dark');
    expect(reading('mobile')).toBe('dark');

    // The flip a user performs in whichever cluster their viewport is
    // showing. The other one is mounted the whole time — before this
    // hook it held the sample it took when its popover opened, so
    // crossing the breakpoint revealed a row labelled with the old
    // theme whose next click computed the flip from that stale value
    // and appeared to do nothing.
    await act(async () => {
      applyDomTheme('light');
    });

    expect(reading('desktop')).toBe('light');
    expect(reading('mobile')).toBe('light');
  });

  it('follows writes made by anything else on the page', async () => {
    document.documentElement.dataset.theme = 'dark';
    render(<Probe id="a" />);

    // `ThemePreferenceWatcher` (OS light/dark flip) and the `/me`
    // appearance form's live preview both set the attribute directly
    // rather than going through `applyDomTheme`.
    await act(async () => {
      document.documentElement.dataset.theme = 'light';
    });

    expect(reading('a')).toBe('light');
  });

  it('stops observing once the last reader unmounts', async () => {
    document.documentElement.dataset.theme = 'dark';
    const disconnect = jest.spyOn(MutationObserver.prototype, 'disconnect');
    const { unmount } = render(<Probe id="a" />);

    await act(async () => {
      unmount();
    });

    expect(disconnect).toHaveBeenCalled();
    disconnect.mockRestore();
  });
});
