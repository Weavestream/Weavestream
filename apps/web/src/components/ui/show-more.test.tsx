/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { ShowMore } from './show-more';

describe('ShowMore', () => {
  it('hides children until toggled and reflects state in the label', () => {
    render(
      <ShowMore>
        <div>hidden metadata</div>
      </ShowMore>,
    );
    expect(screen.queryByText('hidden metadata')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /show more/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(screen.getByText('hidden metadata')).toBeInTheDocument();
    const openToggle = screen.getByRole('button', { name: /show less/ });
    expect(openToggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(openToggle);
    expect(screen.queryByText('hidden metadata')).not.toBeInTheDocument();
  });

  it('signals hidden anomalies with an accessible dot only while collapsed', () => {
    render(
      <ShowMore attention="warn">
        <div>stale card</div>
      </ShowMore>,
    );
    expect(
      screen.getByRole('img', { name: 'attention needed' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /show more/ }));
    expect(
      screen.queryByRole('img', { name: 'attention needed' }),
    ).not.toBeInTheDocument();
  });
});
