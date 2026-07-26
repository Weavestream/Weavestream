/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { ShowMore } from './ShowMore';

describe('ShowMore', () => {
  it('hides content until toggled, and flips the label', () => {
    render(
      <ShowMore>
        <div>hidden metadata</div>
      </ShowMore>,
    );
    expect(screen.queryByText('hidden metadata')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: /show more/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(screen.getByText('hidden metadata')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show less/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('shows the attention dot ONLY while collapsed — the doctrine rule', () => {
    render(
      <ShowMore dot="danger">
        <div>expiry rows</div>
      </ShowMore>,
    );
    // Collapsed: dot + screen-reader text present.
    expect(screen.getByText(/needs review/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button'));
    // Open: the content itself is the signal; the dot must go.
    expect(screen.queryByText(/needs review/i)).not.toBeInTheDocument();
  });

  it('renders no dot when there is nothing to flag', () => {
    render(
      <ShowMore>
        <div>rows</div>
      </ShowMore>,
    );
    expect(screen.queryByText(/needs review/i)).not.toBeInTheDocument();
  });
});
