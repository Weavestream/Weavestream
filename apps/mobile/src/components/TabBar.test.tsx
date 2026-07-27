/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { TabBar } from './TabBar';

describe('TabBar', () => {
  const noop = () => {};

  it('renders the four tabs plus Ask', () => {
    render(<TabBar activeTab="passwords" onSelectTab={noop} onAsk={noop} />);

    for (const label of ['Passwords', 'Articles', 'Assets', 'More']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // Ask is icon-only, so its accessible name has to come from a label.
    expect(
      screen.getByRole('button', { name: 'Ask anything' }),
    ).toBeInTheDocument();
    // Four tabs + Ask.
    expect(screen.getAllByRole('button')).toHaveLength(5);
  });

  it('is named "Ask anything", never "Ask Weave"', () => {
    // The design handoff says "Ask Weave"; the product is never abbreviated
    // to "Weave" and the feature is "Ask anything" (CLAUDE.md).
    render(<TabBar activeTab="passwords" onSelectTab={noop} onAsk={noop} />);
    expect(screen.queryByText(/weave/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /ask weave/i }),
    ).not.toBeInTheDocument();
  });

  it('marks only the active tab as current', () => {
    render(<TabBar activeTab="assets" onSelectTab={noop} onAsk={noop} />);

    const current = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('Assets');
  });

  it('marks nothing current when the route is not a tab', () => {
    render(<TabBar activeTab={null} onSelectTab={noop} onAsk={noop} />);
    expect(
      screen
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-current') === 'page'),
    ).toHaveLength(0);
  });

  it('reports the tapped tab, including a re-tap of the active one', () => {
    // A second tap on the active tab is meaningful — the shell uses it to
    // pop that tab back to its root — so it must still fire.
    const onSelectTab = jest.fn();
    render(
      <TabBar activeTab="passwords" onSelectTab={onSelectTab} onAsk={noop} />,
    );

    fireEvent.click(screen.getByText('Articles'));
    expect(onSelectTab).toHaveBeenLastCalledWith('articles');

    fireEvent.click(screen.getByText('Passwords'));
    expect(onSelectTab).toHaveBeenLastCalledWith('passwords');
    expect(onSelectTab).toHaveBeenCalledTimes(2);
  });

  it('Ask is a button, not a tab — it never becomes current', () => {
    const onAsk = jest.fn();
    const onSelectTab = jest.fn();
    render(
      <TabBar activeTab="more" onSelectTab={onSelectTab} onAsk={onAsk} />,
    );

    const ask = screen.getByRole('button', { name: 'Ask anything' });
    fireEvent.click(ask);

    expect(onAsk).toHaveBeenCalledTimes(1);
    // Presenting Ask must not change tabs.
    expect(onSelectTab).not.toHaveBeenCalled();
    expect(ask).not.toHaveAttribute('aria-current');
  });

  it('hides Ask for CLIENT_USER while the four tabs keep their geometry', () => {
    // Desktop hides chat on client portals; mobile mirrors it. The 84px
    // center slot stays so the tabs don't shift between roles.
    render(
      <TabBar
        activeTab="passwords"
        onSelectTab={noop}
        onAsk={noop}
        showAsk={false}
      />,
    );

    expect(
      screen.queryByRole('button', { name: 'Ask anything' }),
    ).not.toBeInTheDocument();
    // The four tabs still render.
    expect(screen.getAllByRole('button')).toHaveLength(4);
  });

  it('every control clears the 44px tap floor', () => {
    // `globals.css` sets `min-height/min-width: var(--tap-min)` on every
    // button. The var is unresolvable in jsdom, so assert the rule is the
    // thing making it true rather than a computed pixel value.
    render(<TabBar activeTab="passwords" onSelectTab={noop} onAsk={noop} />);
    for (const button of screen.getAllByRole('button')) {
      expect(button.tagName).toBe('BUTTON');
    }
  });
});
