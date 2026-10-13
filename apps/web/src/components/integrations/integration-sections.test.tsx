/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import type { AssetIntegrationSection } from '@weavestream/shared';
import { IntegrationSections, meterState } from './integration-sections';

function entry(rows: AssetIntegrationSection['section']['groups'][number]['rows']): AssetIntegrationSection {
  return {
    integrationId: '00000000-0000-4000-8000-000000000001',
    driver: 'google-workspace',
    integrationName: 'Example Workspace',
    lastSyncedAt: new Date().toISOString(),
    section: {
      title: 'Google Workspace',
      groups: [{ key: 'storage', title: 'Storage', icon: 'google-drive', rows }],
    },
  };
}

describe('IntegrationSections', () => {
  it('renders nothing without sections', () => {
    const { container } = render(<IntegrationSections sections={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the panel header, group icon and values formatted by kind', () => {
    const { container } = render(
      <IntegrationSections
        sections={[
          entry([
            { label: 'Status', kind: 'badge', value: 'Active', tone: 'success' },
            { label: 'Admin', kind: 'boolean', value: false },
            { label: 'Drive', kind: 'bytes', value: 1536 },
            { label: 'Created', kind: 'date', value: '2026-07-01' },
            { label: 'Console', kind: 'link', value: 'https://admin.example.com/u/1', text: 'Open' },
            { label: 'Groups', kind: 'list', value: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
            { label: 'Note', kind: 'text', value: '<b>not html</b>' },
          ]),
        ]}
      />,
    );
    expect(screen.getByText('Google Workspace')).toBeInTheDocument();
    expect(screen.getByText(/^synced /)).toBeInTheDocument();
    expect(container.querySelector('img[src="/integrations/drivers/google-workspace.svg"]')).not.toBeNull();
    expect(container.querySelector('img[src="/integrations/icons/google-drive.svg"]')).not.toBeNull();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('no')).toBeInTheDocument();
    expect(screen.getByText('1.5 KB')).toBeInTheDocument();
    expect(screen.getByText('Jul 1, 2026')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open/ })).toHaveAttribute('href', 'https://admin.example.com/u/1');
    expect(screen.getByText('+2 more')).toBeInTheDocument();
    // List items are wrapping lines in a list (not nowrap tags), so long text stays inside the card.
    const item = screen.getByText('a');
    expect(item.tagName).toBe('LI');
    expect(item.style.overflowWrap).toBe('anywhere');
    // Text stays text: no element is created from the value.
    expect(screen.getByText('<b>not html</b>')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
  });

  it.each([
    [12.4 * 1024, 30 * 1024, 'ok', '12.40 GB of 30.00 GB (41%)'],
    [24 * 1024, 30 * 1024, 'warn', '24.00 GB of 30.00 GB (80%)'],
    [29 * 1024, 30 * 1024, 'danger', '29.00 GB of 30.00 GB (97%)'],
  ])('renders an accessible usage meter (%s MB used)', (used, total, tone, text) => {
    render(<IntegrationSections sections={[entry([{ label: 'Mailbox', kind: 'meter', used, total, unit: 'mb' }])]} />);
    const meter = screen.getByRole('meter', { name: 'Mailbox' });
    expect(meter).toHaveAttribute('aria-valuemin', '0');
    expect(meter).toHaveAttribute('aria-valuemax', '100');
    expect(meter).toHaveAttribute('aria-valuetext', text);
    expect(meter).toHaveAttribute('data-tone', tone);
    // The percentage is always visible as text, never colour alone.
    expect(within(meter.parentElement!).getByText(text)).toBeInTheDocument();
  });

  it('clamps aria-valuenow for an over-quota meter but keeps the real percent in text', () => {
    render(<IntegrationSections sections={[entry([{ label: 'Seats', kind: 'meter', used: 12, total: 10, unit: 'count' }])]} />);
    const meter = screen.getByRole('meter', { name: 'Seats' });
    expect(meter).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('12 of 10 (120%)')).toBeInTheDocument();
  });

  it('switches tone at exactly 80% and 95%', () => {
    expect(meterState(79, 100).tone).toBe('ok');
    expect(meterState(80, 100).tone).toBe('warn');
    expect(meterState(94, 100).tone).toBe('warn');
    expect(meterState(95, 100).tone).toBe('danger');
  });

  it('inverts the tone for a higher-is-better coverage meter', () => {
    expect(meterState(100, 100, true).tone).toBe('ok');
    expect(meterState(80, 100, true).tone).toBe('ok');
    expect(meterState(79, 100, true).tone).toBe('warn');
    expect(meterState(50, 100, true).tone).toBe('warn');
    expect(meterState(49, 100, true).tone).toBe('danger');
    render(<IntegrationSections sections={[entry([{ label: '2SV', kind: 'meter', used: 10, total: 10, unit: 'count', higherIsBetter: true }])]} />);
    expect(screen.getByRole('meter', { name: '2SV' })).toHaveAttribute('data-tone', 'ok');
  });

  it('tags a section whose binding is no longer active', () => {
    render(<IntegrationSections sections={[{ ...entry([{ label: 'Plan', kind: 'text', value: 'x' }]), active: false }]} />);
    expect(screen.getByText('No longer in Example Workspace')).toBeInTheDocument();
  });

  it('shows no tag on an active binding', () => {
    render(<IntegrationSections sections={[{ ...entry([{ label: 'Plan', kind: 'text', value: 'x' }]), active: true }]} />);
    expect(screen.queryByText(/No longer in/)).toBeNull();
  });
});
