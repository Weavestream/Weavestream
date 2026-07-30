/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { IdentityCard } from './IdentityCard';

/**
 * One block, two surfaces: tappable at the top of More (the way into the
 * profile), inert at the top of the profile itself (context for what you are
 * about to change). The semantics have to follow the role — a focusable,
 * `active:`-styled element that does nothing is a worse lie than no
 * affordance — so the element type is asserted, not just the text.
 */
describe('IdentityCard', () => {
  it('is a button with a chevron when it has a destination', () => {
    const onClick = jest.fn();
    render(
      <IdentityCard
        name="Ada Lovelace"
        email="ada@example.com"
        userRole="OPERATOR"
        onClick={onClick}
      />,
    );

    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('Ada Lovelace');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalled();
  });

  it('renders nothing focusable when inert', () => {
    render(
      <IdentityCard name="Ada Lovelace" email="ada@example.com" userRole="OPERATOR" />,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('shows the email as context alongside the role', () => {
    render(<IdentityCard name="Ada Lovelace" email="ada@example.com" userRole="OPERATOR" />);

    // Email is here so the technician knows WHICH account — deliberately
    // with no copy about whether it can be changed.
    expect(screen.getByText(/ada@example\.com/)).toBeInTheDocument();
  });

  it('prints the email once when it is standing in for a missing name', () => {
    // MoreTab falls back to the email when the account has no name; showing
    // it again on the meta line would read as a rendering bug.
    render(
      <IdentityCard
        name="ada@example.com"
        email="ada@example.com"
        userRole="CLIENT_USER"
      />,
    );

    expect(screen.getAllByText(/ada@example\.com/)).toHaveLength(1);
  });

  it('survives a session with no role or email', () => {
    render(<IdentityCard name="Signed in" email={undefined} userRole={undefined} />);

    expect(screen.getByText('Signed in')).toBeInTheDocument();
  });
});
