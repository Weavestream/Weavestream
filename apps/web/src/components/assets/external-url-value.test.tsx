/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { ExternalUrlValue } from './external-url-value';

// Consumer-level regression coverage for the asset URL / VAULTWARDEN_LINK
// renderers (admin + portal asset detail pages). The full input matrix
// (control chars, every dangerous scheme, host:port shapes) is covered by
// the safeExternalHref spec in packages/shared — here we pin the rendering
// contract: sanitized href on the anchor, plain text on rejection, `—` on
// blank.
describe('ExternalUrlValue', () => {
  it('links a safe value through safeExternalHref with hardened anchor attrs', () => {
    render(<ExternalUrlValue url="example.com:8443" />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://example.com:8443/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(link).toHaveTextContent('example.com:8443');
  });

  it('renders a rejected scheme as plain text, never an anchor', () => {
    render(<ExternalUrlValue url="data:text/html,hi" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('data:text/html,hi')).toBeInTheDocument();
  });

  it('shows the Vaultwarden label instead of the URL in both branches', () => {
    const { rerender } = render(
      <ExternalUrlValue
        url="https://vault.example.com/item/1"
        label="Vault item"
      />,
    );
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      'https://vault.example.com/item/1',
    );
    expect(screen.getByText('Vault item')).toBeInTheDocument();

    rerender(<ExternalUrlValue url="data:text/html,hi" label="Legacy label" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Legacy label')).toBeInTheDocument();
  });

  it('renders — for a whitespace-only value', () => {
    render(<ExternalUrlValue url="   " />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
