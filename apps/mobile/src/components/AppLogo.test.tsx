/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import { AppLogo } from './AppLogo';

describe('AppLogo', () => {
  it('renders both theme variants so CSS can pick one pre-hydration', () => {
    // The stamped shell resolves the visible wordmark purely via the
    // .m-logo--* rules (including the system-pref media block), so both
    // <img>s must be present in the markup before any JS runs. jsdom
    // cannot evaluate the media query — the class contract is the
    // testable surface.
    const { container } = render(<AppLogo />);
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toHaveClass('m-logo--light');
    expect(imgs[1]).toHaveClass('m-logo--dark');
  });

  it('names both variants — display:none removes the hidden one from the a11y tree', () => {
    const { container } = render(<AppLogo />);
    for (const img of Array.from(container.querySelectorAll('img'))) {
      expect(img).toHaveAttribute('alt', 'Weavestream');
    }
  });

  it('sizes by height only, never squashing the non-square artwork', () => {
    const { container } = render(<AppLogo height={24} />);
    for (const img of Array.from(container.querySelectorAll('img'))) {
      expect(img.style.height).toBe('24px');
      expect(img.style.width).toBe('auto');
    }
  });
});
