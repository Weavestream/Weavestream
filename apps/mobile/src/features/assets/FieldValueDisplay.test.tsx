/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { AssetFieldRows } from './FieldValueDisplay';
import { makeAsset } from './test-fixtures';
import type { AssetFieldMeta } from './api';

const navigateMock = jest.fn();
jest.mock('../../lib/scoped-nav', () => ({
  useScopedNavigate: () => navigateMock,
}));

beforeEach(() => jest.clearAllMocks());

function fieldMeta(over: Partial<AssetFieldMeta> & { slug: string }): AssetFieldMeta {
  return {
    id: `f-${over.slug}`,
    name: over.slug,
    fieldType: 'TEXT',
    isPrimary: false,
    visibleToClients: true,
    options: {},
    ...over,
  };
}

describe('AssetFieldRows', () => {
  it('shows every label with an em-dash for empty values', () => {
    const asset = makeAsset({
      fields: [
        fieldMeta({ slug: 'hostname', name: 'Hostname' }),
        fieldMeta({ slug: 'mgmt_ip', name: 'Management IP', fieldType: 'IP_ADDRESS' }),
      ],
      fieldValues: { hostname: 'srv-01' },
    });
    render(<AssetFieldRows asset={asset} />);
    expect(screen.getByText('Hostname')).toBeInTheDocument();
    expect(screen.getByText('srv-01')).toBeInTheDocument();
    // Empty field: label still shown, value is the dash.
    expect(screen.getByText('Management IP')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('builds mailto/tel anchors and pins DATE to the stored calendar day', () => {
    const asset = makeAsset({
      fields: [
        fieldMeta({ slug: 'email', name: 'Email', fieldType: 'EMAIL' }),
        fieldMeta({ slug: 'phone', name: 'Phone', fieldType: 'PHONE' }),
        fieldMeta({ slug: 'installed', name: 'Installed', fieldType: 'DATE' }),
      ],
      fieldValues: {
        email: 'noc@example.com',
        phone: '+15551230000',
        installed: '2026-03-14',
      },
    });
    render(<AssetFieldRows asset={asset} />);
    expect(screen.getByRole('link', { name: 'noc@example.com' })).toHaveAttribute(
      'href',
      'mailto:noc@example.com',
    );
    expect(screen.getByRole('link', { name: '+15551230000' })).toHaveAttribute(
      'href',
      'tel:+15551230000',
    );
    // UTC-pinned: the day never shifts with the viewer's zone.
    expect(screen.getByText('Mar 14, 2026')).toBeInTheDocument();
  });

  it('renders unsafe URL values as plain text, never a raw href', () => {
    const asset = makeAsset({
      fields: [fieldMeta({ slug: 'admin_url', name: 'Admin URL', fieldType: 'URL' })],
      fieldValues: { admin_url: 'javascript:alert(1)' },
    });
    render(<AssetFieldRows asset={asset} />);
    expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('promotes scheme-less URLs via safeExternalHref with noopener', () => {
    const asset = makeAsset({
      fields: [fieldMeta({ slug: 'admin_url', name: 'Admin URL', fieldType: 'URL' })],
      fieldValues: { admin_url: 'switch.local:8443' },
    });
    render(<AssetFieldRows asset={asset} />);
    const link = screen.getByRole('link');
    // safeExternalHref canonicalises through `new URL`, hence the slash.
    expect(link).toHaveAttribute('href', 'https://switch.local:8443/');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('resolves DROPDOWN slugs to labels and renders MULTISELECT/TAGS pills', () => {
    const choices = {
      choices: [
        { slug: 'prod', label: 'Production' },
        { slug: 'dr', label: 'Disaster recovery' },
      ],
    };
    const asset = makeAsset({
      fields: [
        fieldMeta({ slug: 'env', name: 'Environment', fieldType: 'DROPDOWN', options: choices }),
        fieldMeta({ slug: 'roles', name: 'Roles', fieldType: 'MULTISELECT', options: choices }),
        fieldMeta({ slug: 'labels', name: 'Labels', fieldType: 'TAGS' }),
      ],
      fieldValues: {
        env: 'dr',
        roles: ['prod', 'legacy_slug'],
        labels: [{ id: 't1', name: 'noc' }],
      },
    });
    render(<AssetFieldRows asset={asset} />);
    expect(screen.getByText('Disaster recovery')).toBeInTheDocument();
    expect(screen.getByText('Production')).toBeInTheDocument(); // resolved pill
    expect(screen.getByText('legacy_slug')).toBeInTheDocument(); // raw fallback pill
    expect(screen.getByText('noc')).toBeInTheDocument();
  });

  it('ASSET_REFERENCE rows navigate; missing ids render inert with the id stub', () => {
    const refId = 'aaaaaaaa-0000-4000-8000-000000000001';
    const asset = makeAsset({
      fields: [fieldMeta({ slug: 'uplink', name: 'Uplink', fieldType: 'ASSET_REFERENCE' })],
      fieldValues: { uplink: [refId, 'bbbbbbbb-0000-4000-8000-000000000002'] },
      references: { [refId]: { id: refId, name: 'core-sw-01', archivedAt: null } },
    });
    render(<AssetFieldRows asset={asset} />);
    fireEvent.click(screen.getByRole('button', { name: /core-sw-01/ }));
    expect(navigateMock).toHaveBeenCalledWith({ to: `/assets/${refId}` });
    expect(screen.getByText('bbbbbbbb… (missing)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /bbbbbbbb/ })).not.toBeInTheDocument();
  });

  it('renders legacy {v,plain} RICH_TEXT through the tiptap walker', () => {
    const asset = makeAsset({
      fields: [fieldMeta({ slug: 'runbook', name: 'Runbook', fieldType: 'RICH_TEXT' })],
      fieldValues: {
        runbook: {
          v: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Reboot core first.' }] },
            ],
          },
          plain: 'Reboot core first.',
        },
      },
    });
    render(<AssetFieldRows asset={asset} />);
    expect(screen.getByText('Reboot core first.')).toBeInTheDocument();
  });

  it('FILE tiles link to downloadUrl; deleted uploads render inert with the filename kept', () => {
    const asset = makeAsset({
      fields: [fieldMeta({ slug: 'photos', name: 'Photos', fieldType: 'FILE' })],
      fieldValues: {
        photos: [
          {
            uploadId: 'u1',
            filename: 'rack.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 2048,
            isImage: true,
            thumbnailUrl: '/api/v1/companies/c/uploads/u1/image?v=thumb',
            downloadUrl: '/api/v1/companies/c/uploads/u1/download',
          },
          {
            uploadId: 'u2',
            filename: 'deleted.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            thumbnailUrl: null,
            downloadUrl: null,
          },
        ],
      },
    });
    render(<AssetFieldRows asset={asset} />);
    expect(screen.getByRole('link', { name: 'Open rack.jpg' })).toHaveAttribute(
      'href',
      '/api/v1/companies/c/uploads/u1/download',
    );
    expect(screen.getByText('deleted.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /deleted\.pdf/ })).not.toBeInTheDocument();
  });

  it('unknown field types render their raw value without crashing', () => {
    const asset = makeAsset({
      fields: [fieldMeta({ slug: 'mystery', name: 'Mystery', fieldType: 'FUTURE_TYPE' })],
      fieldValues: { mystery: { nested: ['x'] } },
    });
    render(<AssetFieldRows asset={asset} />);
    expect(screen.getByText('{"nested":["x"]}')).toBeInTheDocument();
  });
});
