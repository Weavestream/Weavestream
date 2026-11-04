/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { PasswordAccessField } from './password-access-field';

function renderField(props: Partial<Parameters<typeof PasswordAccessField>[0]> = {}) {
  return render(
    <PasswordAccessField
      id="pa"
      value="inherit"
      onChange={() => undefined}
      userRole="CONTRACTOR"
      expiresAtLocal=""
      {...props}
    />,
  );
}

describe('PasswordAccessField', () => {
  it('offers the 3 values', () => {
    renderField();
    const select = screen.getByLabelText('Password access');
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Use global policy',
      'Allow',
      'Deny',
    ]);
  });

  it('is hidden for client users', () => {
    const { container } = renderField({ userRole: 'CLIENT_USER' });
    expect(container).toBeEmptyDOMElement();
  });

  it('warns that a deny ends when the membership expires', () => {
    renderField({ value: 'deny', expiresAtLocal: '2027-01-01T09:00' });
    expect(screen.getByText(/When this membership expires/)).toBeInTheDocument();
  });

  it('does not warn for a deny without expiry, or an allow with expiry', () => {
    const { rerender } = renderField({ value: 'deny' });
    expect(screen.queryByText(/When this membership expires/)).toBeNull();
    rerender(
      <PasswordAccessField
        id="pa"
        value="allow"
        onChange={() => undefined}
        userRole="CONTRACTOR"
        expiresAtLocal="2027-01-01T09:00"
      />,
    );
    expect(screen.queryByText(/When this membership expires/)).toBeNull();
  });

  it('notes the role effect for an operator override', () => {
    renderField({ value: 'allow', userRole: 'OPERATOR' });
    expect(screen.getByText(/also sets their role in this company/)).toBeInTheDocument();
  });
});
