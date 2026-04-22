/**
 * Predefined "starter" asset-layout templates.
 *
 * These are **not** a persisted concept — there is no `layout_templates`
 * table. A template is simply a code-defined bundle of layout metadata +
 * default fields that the Create Layout flow can pre-seed into the layout
 * builder. Once the user hits Save in the builder, the layout is a
 * first-class `AssetLayout` like any other and the template bond is gone.
 *
 * Field shapes conform to `saveAssetFieldsSchema` in
 * `schemas/asset-field.ts`, so the builder's existing Save path can
 * serialize them verbatim without a second validator.
 *
 * Mapping rules baked into these templates:
 *   - "Checkbox" => BOOLEAN
 *   - "Rich Text" => RICH_TEXT
 *   - "Asset Link" => TEXT (deliberate: cross-layout linking is resolved
 *     after the target layouts exist; keeping it TEXT lets a template
 *     stand on its own without implicit dependencies)
 *   - Confidential/secret fields are intentionally omitted — there is no
 *     dedicated CONFIDENTIAL_TEXT type today and we don't want to ship
 *     templates that quietly persist secrets in plaintext.
 *   - Where the source spec says "Text" but semantics are clearly typed
 *     (Email / Phone / URL / IP / Number), we upgrade to the matching
 *     typed field so the form renders the right input and the detail
 *     view gets the right affordances.
 */

import type { FieldType } from '../schemas/field-types.js';

/**
 * A single field definition inside a template. Mirrors the subset of
 * `saveAssetFieldsSchema` fields that make sense on a blank layout —
 * `position` is assigned by array order when the builder seeds its
 * local state, and `id` is intentionally absent because template rows
 * are always created fresh.
 */
export interface LayoutTemplateField {
  name: string;
  slug: string;
  fieldType: FieldType;
  isPrimary?: boolean;
  isRequired?: boolean;
  visibleToClients?: boolean;
  showInTable?: boolean;
  options?: Record<string, unknown>;
}

/**
 * Top-level template bundle shown on the create-layout picker.
 *
 * `id` is a stable identifier passed as a query param to the builder
 * (`?template=<id>`); it must stay URL-safe and immutable so a direct
 * link to "new layout from template" keeps working across releases.
 *
 * `suggestedSlug`, `icon`, and `color` are pre-filled into the create
 * dialog's inputs so the user can accept sensible defaults or edit them
 * before the layout is persisted.
 */
export interface LayoutTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  suggestedSlug: string;
  fields: readonly LayoutTemplateField[];
}

function dropdown(
  choices: ReadonlyArray<{ label: string; slug: string }>,
  allowOther = false,
): Record<string, unknown> {
  return { choices, allowOther };
}

const EXPIRY_DATE = { isExpiry: true } as const;

export const LAYOUT_TEMPLATES: readonly LayoutTemplate[] = [
  {
    id: 'server',
    name: 'Server / Network Device',
    description: 'Domain controllers, file servers, hypervisors, appliances.',
    icon: 'server',
    color: 'var(--info)',
    suggestedSlug: 'server',
    fields: [
      { name: 'Hostname', slug: 'hostname', fieldType: 'TEXT', isPrimary: true, isRequired: true, showInTable: true },
      {
        name: 'Role',
        slug: 'role',
        fieldType: 'DROPDOWN',
        showInTable: true,
        options: dropdown([
          { label: 'Domain Controller', slug: 'domain_controller' },
          { label: 'File Server', slug: 'file_server' },
          { label: 'App Server', slug: 'app_server' },
          { label: 'Web Server', slug: 'web_server' },
          { label: 'Database', slug: 'database' },
          { label: 'Hypervisor', slug: 'hypervisor' },
          { label: 'Other', slug: 'other' },
        ]),
      },
      { name: 'IP Address', slug: 'ip_address', fieldType: 'IP_ADDRESS', showInTable: true, options: { version: 'any', allowCidr: false } },
      { name: 'Operating System', slug: 'operating_system', fieldType: 'TEXT' },
      { name: 'RAM', slug: 'ram', fieldType: 'TEXT' },
      { name: 'CPU', slug: 'cpu', fieldType: 'TEXT' },
      { name: 'Warranty Expiry', slug: 'warranty_expiry', fieldType: 'DATE', showInTable: true, options: EXPIRY_DATE },
      { name: 'Management URL', slug: 'management_url', fieldType: 'URL' },
      { name: 'Configuration Notes', slug: 'configuration_notes', fieldType: 'RICH_TEXT' },
      { name: 'Notes', slug: 'notes', fieldType: 'RICH_TEXT' },
    ],
  },
  {
    id: 'workstation',
    name: 'Workstation / Computer',
    description: 'End-user laptops and desktops with assignment + warranty tracking.',
    icon: 'laptop',
    color: '#60a5fa',
    suggestedSlug: 'workstation',
    fields: [
      { name: 'Hostname', slug: 'hostname', fieldType: 'TEXT', isPrimary: true, isRequired: true, showInTable: true },
      {
        name: 'Brand',
        slug: 'brand',
        fieldType: 'DROPDOWN',
        showInTable: true,
        options: dropdown([
          { label: 'Dell', slug: 'dell' },
          { label: 'HP', slug: 'hp' },
          { label: 'Lenovo', slug: 'lenovo' },
          { label: 'Apple', slug: 'apple' },
          { label: 'Microsoft', slug: 'microsoft' },
          { label: 'ASUS', slug: 'asus' },
          { label: 'Acer', slug: 'acer' },
          { label: 'Other', slug: 'other' },
        ]),
      },
      { name: 'Model', slug: 'model', fieldType: 'TEXT' },
      { name: 'Serial / Service Tag', slug: 'serial_tag', fieldType: 'TEXT', showInTable: true },
      { name: 'Operating System', slug: 'operating_system', fieldType: 'TEXT' },
      { name: 'RAM', slug: 'ram', fieldType: 'TEXT' },
      { name: 'Storage', slug: 'storage', fieldType: 'TEXT' },
      { name: 'Assigned User', slug: 'assigned_user', fieldType: 'TEXT', showInTable: true },
      { name: 'Location', slug: 'location', fieldType: 'TEXT' },
      { name: 'Warranty Expiry', slug: 'warranty_expiry', fieldType: 'DATE', showInTable: true, options: EXPIRY_DATE },
      { name: 'Notes', slug: 'notes', fieldType: 'RICH_TEXT' },
    ],
  },
  {
    id: 'active_directory',
    name: 'Active Directory / Identity',
    description: 'Domain topology, FSMO roles, Entra sync posture.',
    icon: 'shield',
    color: '#c084fc',
    suggestedSlug: 'active_directory',
    fields: [
      { name: 'Domain Name (FQDN)', slug: 'domain_fqdn', fieldType: 'TEXT', isPrimary: true, isRequired: true, showInTable: true },
      { name: 'Short Name / NetBIOS', slug: 'netbios_name', fieldType: 'TEXT', showInTable: true },
      { name: 'Primary Domain Controller', slug: 'primary_domain_controller', fieldType: 'TEXT', showInTable: true },
      { name: 'DNS Servers', slug: 'dns_servers', fieldType: 'TEXT' },
      { name: 'FSMO Roles', slug: 'fsmo_roles', fieldType: 'RICH_TEXT' },
      { name: 'Entra Sync Enabled', slug: 'entra_sync_enabled', fieldType: 'BOOLEAN', showInTable: true },
      { name: 'MFA Enforced', slug: 'mfa_enforced', fieldType: 'BOOLEAN', showInTable: true },
      { name: 'Notes', slug: 'notes', fieldType: 'RICH_TEXT' },
    ],
  },
  {
    id: 'backup',
    name: 'Backup / DR',
    description: 'Backup jobs, retention, recovery objectives, verification cadence.',
    icon: 'box',
    color: 'var(--ok)',
    suggestedSlug: 'backup',
    fields: [
      { name: 'Backup Target', slug: 'backup_target', fieldType: 'TEXT', isPrimary: true, isRequired: true, showInTable: true },
      {
        name: 'Backup Type',
        slug: 'backup_type',
        fieldType: 'DROPDOWN',
        showInTable: true,
        options: dropdown([
          { label: 'Full', slug: 'full' },
          { label: 'Incremental', slug: 'incremental' },
          { label: 'Differential', slug: 'differential' },
          { label: 'Image', slug: 'image' },
          { label: 'Snapshot', slug: 'snapshot' },
        ]),
      },
      {
        name: 'Backup Technology',
        slug: 'backup_technology',
        fieldType: 'DROPDOWN',
        showInTable: true,
        options: dropdown([
          { label: 'Veeam', slug: 'veeam' },
          { label: 'Datto', slug: 'datto' },
          { label: 'Acronis', slug: 'acronis' },
          { label: 'Cove', slug: 'cove' },
          { label: 'Azure Backup', slug: 'azure_backup' },
          { label: 'AWS Backup', slug: 'aws_backup' },
          { label: 'Other', slug: 'other' },
        ]),
      },
      { name: 'Backup Frequency', slug: 'backup_frequency', fieldType: 'TEXT' },
      { name: 'Retention Policy', slug: 'retention_policy', fieldType: 'TEXT' },
      { name: 'Offsite Provider', slug: 'offsite_provider', fieldType: 'TEXT' },
      { name: 'Last Verification Date', slug: 'last_verification_date', fieldType: 'DATE', showInTable: true, options: { isExpiry: false } },
      { name: 'Next Verification Due', slug: 'next_verification_due', fieldType: 'DATE', showInTable: true, options: EXPIRY_DATE },
      { name: 'Recovery Time Objective', slug: 'recovery_time_objective', fieldType: 'TEXT' },
      { name: 'Recovery Point Objective', slug: 'recovery_point_objective', fieldType: 'TEXT' },
      { name: 'Notes', slug: 'notes', fieldType: 'RICH_TEXT' },
    ],
  },
  {
    id: 'network',
    name: 'Network / LAN',
    description: 'Site networking: ISP, WAN/LAN addressing, VLANs, VPN.',
    icon: 'network',
    color: 'var(--info)',
    suggestedSlug: 'network',
    fields: [
      { name: 'Site Name', slug: 'site_name', fieldType: 'TEXT', isPrimary: true, isRequired: true, showInTable: true },
      { name: 'ISP Provider', slug: 'isp_provider', fieldType: 'TEXT', showInTable: true },
      { name: 'WAN IP', slug: 'wan_ip', fieldType: 'IP_ADDRESS', showInTable: true, options: { version: 'any', allowCidr: false } },
      { name: 'Firewall / Router', slug: 'firewall_router', fieldType: 'TEXT', showInTable: true },
      { name: 'LAN Subnet', slug: 'lan_subnet', fieldType: 'IP_ADDRESS', showInTable: true, options: { version: 'any', allowCidr: true } },
      { name: 'DHCP Server', slug: 'dhcp_server', fieldType: 'TEXT' },
      { name: 'DHCP Scope', slug: 'dhcp_scope', fieldType: 'TEXT' },
      { name: 'VLAN Info', slug: 'vlan_info', fieldType: 'RICH_TEXT' },
      { name: 'VPN Details', slug: 'vpn_details', fieldType: 'RICH_TEXT' },
      { name: 'Notes', slug: 'notes', fieldType: 'RICH_TEXT' },
    ],
  },
  {
    id: 'application',
    name: 'Application / Software',
    description: 'SaaS and on-prem apps with licensing, vendor, renewal tracking.',
    icon: 'doc',
    color: 'var(--warn)',
    suggestedSlug: 'application',
    fields: [
      { name: 'Application Name', slug: 'application_name', fieldType: 'TEXT', isPrimary: true, isRequired: true, showInTable: true },
      {
        name: 'Category',
        slug: 'category',
        fieldType: 'DROPDOWN',
        showInTable: true,
        options: dropdown([
          { label: 'Cloud', slug: 'cloud' },
          { label: 'On-Prem', slug: 'on_prem' },
          { label: 'Client-Server', slug: 'client_server' },
          { label: 'SaaS', slug: 'saas' },
          { label: 'Mobile', slug: 'mobile' },
        ]),
      },
      { name: 'Version', slug: 'version', fieldType: 'TEXT' },
      { name: 'Vendor', slug: 'vendor', fieldType: 'TEXT', showInTable: true },
      { name: 'License Type', slug: 'license_type', fieldType: 'TEXT' },
      { name: 'License Count', slug: 'license_count', fieldType: 'NUMBER', showInTable: true },
      { name: 'Renewal Date', slug: 'renewal_date', fieldType: 'DATE', showInTable: true, options: EXPIRY_DATE },
      { name: 'Admin URL', slug: 'admin_url', fieldType: 'URL' },
      { name: 'Business Impact', slug: 'business_impact', fieldType: 'RICH_TEXT' },
      { name: 'New User Setup Steps', slug: 'new_user_setup_steps', fieldType: 'RICH_TEXT' },
      { name: 'Notes', slug: 'notes', fieldType: 'RICH_TEXT' },
    ],
  },
  {
    id: 'site',
    name: 'Site / Location',
    description: 'Physical sites with contacts, hours, and vendor handoffs.',
    icon: 'building',
    color: 'var(--muted)',
    suggestedSlug: 'site',
    fields: [
      { name: 'Address', slug: 'address', fieldType: 'TEXT', isPrimary: true, isRequired: true, showInTable: true },
      { name: 'Primary Contact', slug: 'primary_contact', fieldType: 'TEXT', showInTable: true },
      { name: 'Front Desk Phone', slug: 'front_desk_phone', fieldType: 'PHONE', showInTable: true },
      { name: 'Hours of Operation', slug: 'hours_of_operation', fieldType: 'TEXT' },
      { name: 'ISP Info', slug: 'isp_info', fieldType: 'TEXT' },
      { name: 'Key Vendor Contacts', slug: 'key_vendor_contacts', fieldType: 'RICH_TEXT' },
      { name: 'Notes', slug: 'notes', fieldType: 'RICH_TEXT' },
    ],
  },
  {
    id: 'contact',
    name: 'Contact / User',
    description: 'People records: email, phone, department, workstation assignment.',
    icon: 'person',
    color: '#f472b6',
    suggestedSlug: 'contact',
    fields: [
      { name: 'Full Name', slug: 'full_name', fieldType: 'TEXT', isPrimary: true, isRequired: true, showInTable: true },
      { name: 'Title', slug: 'title', fieldType: 'TEXT', showInTable: true },
      { name: 'Department', slug: 'department', fieldType: 'TEXT', showInTable: true },
      { name: 'Email', slug: 'email', fieldType: 'EMAIL', showInTable: true },
      { name: 'Phone (Office)', slug: 'phone_office', fieldType: 'PHONE' },
      { name: 'Phone (Mobile)', slug: 'phone_mobile', fieldType: 'PHONE' },
      {
        name: 'Status',
        slug: 'status',
        fieldType: 'DROPDOWN',
        showInTable: true,
        options: dropdown([
          { label: 'Active', slug: 'active' },
          { label: 'Offboarded', slug: 'offboarded' },
        ]),
      },
      { name: 'Assigned Workstation', slug: 'assigned_workstation', fieldType: 'TEXT' },
      { name: 'Notes', slug: 'notes', fieldType: 'RICH_TEXT' },
    ],
  },
  {
    id: 'vendor',
    name: 'Vendor',
    description: 'Vendor accounts, renewal cadence, and primary contacts.',
    icon: 'globe',
    color: '#facc15',
    suggestedSlug: 'vendor',
    fields: [
      { name: 'Vendor Name', slug: 'vendor_name', fieldType: 'TEXT', isPrimary: true, isRequired: true, showInTable: true },
      { name: 'Service Type', slug: 'service_type', fieldType: 'TEXT', showInTable: true },
      { name: 'Account Number', slug: 'account_number', fieldType: 'TEXT' },
      { name: 'Website', slug: 'website', fieldType: 'URL' },
      { name: 'Primary Contact Name', slug: 'primary_contact_name', fieldType: 'TEXT', showInTable: true },
      { name: 'Contact Email', slug: 'contact_email', fieldType: 'EMAIL' },
      { name: 'Contact Phone', slug: 'contact_phone', fieldType: 'PHONE' },
      { name: 'Contract Value', slug: 'contract_value', fieldType: 'TEXT' },
      { name: 'Renewal Date', slug: 'renewal_date', fieldType: 'DATE', showInTable: true, options: EXPIRY_DATE },
      { name: 'Notes', slug: 'notes', fieldType: 'RICH_TEXT' },
    ],
  },
];

const TEMPLATES_BY_ID: Record<string, LayoutTemplate> = Object.fromEntries(
  LAYOUT_TEMPLATES.map((t) => [t.id, t]),
);

/** Look a template up by its stable id. Returns `undefined` for unknown ids. */
export function getLayoutTemplate(id: string): LayoutTemplate | undefined {
  return TEMPLATES_BY_ID[id];
}
