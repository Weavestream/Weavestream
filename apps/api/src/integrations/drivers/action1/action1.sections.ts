import type { IntegrationSection, IntegrationSectionGroup } from '@weavestream/shared';
import {
  badge,
  date,
  datetime,
  enumLabel,
  fin,
  group,
  list,
  obj,
  str,
  strings,
  text,
  type Row,
} from '../section-rows.js';

/**
 * Pure builders for the Action1 section on the asset page
 * (integrationSectionSchema). Action1 keeps its own field mapping, so the
 * section leaves out the facts operators map to layout fields (name, OS,
 * platform, manufacturer, CPU, RAM, disk, serial, IP and MAC) and shows
 * the live state around them.
 *
 * Everything comes from the endpoint record the sync already reads
 * (`/endpoints/managed/{orgId}?fields=*`): the section costs no extra
 * request. Every field is optional: a missing value drops its row, an
 * unknown shape is ignored, and an unknown enum value is shown as plain
 * text with a neutral tone.
 */

export const SECTION_TITLE = 'Action1';

type Obj = Record<string, unknown>;
type Tone = 'neutral' | 'success' | 'warning' | 'danger';

/** A known enum value with its words and tone; anything else as sent, neutral. */
function enumBadge(label: string, value: unknown, known: Readonly<Record<string, [string, Tone]>>): Row {
  const s = str(value);
  if (!s) return null;
  const [words, tone] = known[s] ?? [s === s.toUpperCase() ? enumLabel(s)! : s, 'neutral'];
  return badge(label, words, tone);
}

const AGENT_STATUS: Readonly<Record<string, [string, Tone]>> = {
  Connected: ['Connected', 'success'],
  Disconnected: ['Disconnected', 'neutral'],
  'Pending Uninstall': ['Pending uninstall', 'warning'],
};

/** Action1's own buckets for the time since `last_seen`. */
const CHECK_IN: Readonly<Record<string, [string, Tone]>> = {
  SUCCESS: ['Within 7 days', 'success'],
  WARNING: ['8 to 30 days ago', 'warning'],
  ERROR: ['Over 30 days ago', 'danger'],
};

const REBOOT: Readonly<Record<string, [string, Tone]>> = {
  Yes: ['Yes', 'warning'],
  No: ['No', 'success'],
};

function statusRows(e: Obj): Row[] {
  const name = str(e.name);
  const deviceName = str(e.device_name);
  const subscription = str(e.subscription_status);
  return [
    enumBadge('Agent', e.status, AGENT_STATUS),
    enumBadge('Check-in', e.online_status, CHECK_IN),
    datetime('Last seen', str(e.last_seen)),
    datetime('Last boot', str(e.last_boot_time)),
    enumBadge('Reboot pending', e.reboot_required, REBOOT),
    // An account name only; Action1 sends no contact details on the endpoint.
    text('Logged-in user', str(e.user)),
    text('Agent version', str(e.agent_version)),
    date('Agent installed', str(e.agent_install_date)),
    // Active is the normal state; only a lapsed or unknown subscription is called out.
    subscription && subscription !== 'Active'
      ? enumBadge('Subscription', subscription, { Inactive: ['Inactive', 'warning'] })
      : null,
    // Renamed in Action1: the name the device reports is worth knowing.
    deviceName && deviceName.toLowerCase() !== name?.toLowerCase() ? text('Device name', deviceName) : null,
  ];
}

/** A count Action1 could have sent: a whole number, zero or more. */
function count(value: unknown): number | undefined {
  const n = fin(value);
  return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Critical and other counts in one badge: any critical is danger, any
 * other a warning. Both counts must be valid, so a missing one never reads
 * as zero; otherwise Action1's summary status stands in (UNDEFINED, not
 * yet calculated, shows nothing).
 */
function countsRow(label: string, counts: unknown, status: unknown, known: Readonly<Record<string, [string, Tone]>>): Row {
  const c = obj(counts);
  const critical = count(c?.critical);
  const other = count(c?.other);
  if (critical !== undefined && other !== undefined) {
    const tone: Tone = critical > 0 ? 'danger' : other > 0 ? 'warning' : 'success';
    return badge(label, `${critical} critical, ${other} other`, tone);
  }
  return str(status) === 'UNDEFINED' ? null : enumBadge(label, status, known);
}

const UPDATE_STATUS: Readonly<Record<string, [string, Tone]>> = {
  SUCCESS: ['None missing', 'success'],
  WARNING: ['Non-critical missing', 'warning'],
  ERROR: ['Critical missing', 'danger'],
};

const VULNERABILITY_STATUS: Readonly<Record<string, [string, Tone]>> = {
  SUCCESS: ['None found', 'success'],
  WARNING: ['Non-critical found', 'warning'],
  ERROR: ['Critical found', 'danger'],
};

function securityRows(e: Obj): Row[] {
  return [countsRow('Vulnerabilities', e.vulnerabilities, e.vulnerability_status, VULNERABILITY_STATUS)];
}

function updateRows(e: Obj): Row[] {
  return [countsRow('Missing updates', e.missing_updates, e.update_status, UPDATE_STATUS)];
}

function hardwareRows(e: Obj): Row[] {
  return [
    text('Architecture', str(e.architecture)),
    text('Video card', str(e.video)),
    text('Network adapter', str(e.NIC)),
    text('Wi-Fi adapter', str(e.WiFi)),
  ];
}

function directoryRows(e: Obj): Row[] {
  const groups = strings(e.AD_security_groups);
  return [
    text('Organizational unit', str(e.AD_organization_unit)),
    groups.length > 0 ? list('Security groups', groups) : null,
  ];
}

/**
 * The section for one endpoint record (dates already normalised to ISO),
 * or undefined when Action1 sent nothing it shows.
 */
export function buildEndpointSection(endpoint: Obj): IntegrationSection | undefined {
  const groups: IntegrationSectionGroup[] = [
    group('status', 'Status', 'action1', statusRows(endpoint)),
    group('security', 'Security', undefined, securityRows(endpoint)),
    group('updates', 'Updates', undefined, updateRows(endpoint)),
    group('hardware', 'Hardware detail', undefined, hardwareRows(endpoint)),
    group('directory', 'Active Directory', undefined, directoryRows(endpoint)),
  ].filter((g) => g.rows.length > 0);
  // The square mark: the driver logo is a wide wordmark that does not fit the 16px header.
  return groups.length > 0 ? { title: SECTION_TITLE, icon: 'action1', groups } : undefined;
}
