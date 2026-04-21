#!/usr/bin/env ts-node
/**
 * Regenerates `docs/permissions.md` from the single source of truth
 * (`apps/api/src/rbac/permissions.ts`). Run with:
 *
 *   pnpm --filter @weavestream/api exec ts-node ../../scripts/gen-permissions-docs.ts
 *
 * The output is committed; this script exists so the doc cannot drift
 * from the matrix.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PERMISSIONS,
  ACTION_HUMAN_LABELS,
  ActionValues,
} from '../apps/api/src/rbac/permissions.js';

const USER_ROLES = ['SUPER_ADMIN', 'OPERATOR', 'CONTRACTOR', 'CLIENT_USER'] as const;
const MEMBERSHIP_ROLES = [
  'OPERATOR_FULL',
  'OPERATOR_READONLY',
  'CLIENT_ADMIN',
  'CLIENT_VIEWER',
] as const;

function cell(allowed: boolean, extra = ''): string {
  return allowed ? `✓${extra}` : '—';
}

const lines: string[] = [];
lines.push('# Permission matrix');
lines.push('');
lines.push(
  'Generated from `apps/api/src/rbac/permissions.ts`. Do not hand-edit.',
);
lines.push('');
lines.push(
  'Legend: ✓ = allowed, ✓† = allowed with non-expired membership required, — = denied.',
);
lines.push('');

// Section: global actions
lines.push('## Global actions');
lines.push('');
lines.push('| Action | Description | ' + USER_ROLES.join(' | ') + ' |');
lines.push(
  '| --- | --- | ' + USER_ROLES.map(() => '---').join(' | ') + ' |',
);
for (const action of ActionValues) {
  const rule = PERMISSIONS[action];
  if (rule.scope !== 'global') continue;
  const cells = USER_ROLES.map((r) =>
    r === 'SUPER_ADMIN' || rule.allowGlobal.includes(r) ? cell(true) : cell(false),
  );
  lines.push(
    `| \`${action}\` | ${ACTION_HUMAN_LABELS[action]} | ${cells.join(' | ')} |`,
  );
}
lines.push('');

// Section: company actions × global role
lines.push('## Company-scoped actions by global role');
lines.push('');
lines.push(
  'A ✓ means the global role is permitted in any company (given a matching live membership when required).',
);
lines.push('');
lines.push('| Action | Description | ' + USER_ROLES.join(' | ') + ' |');
lines.push(
  '| --- | --- | ' + USER_ROLES.map(() => '---').join(' | ') + ' |',
);
for (const action of ActionValues) {
  const rule = PERMISSIONS[action];
  if (rule.scope !== 'company') continue;
  const cells = USER_ROLES.map((r) => {
    if (r === 'SUPER_ADMIN') return cell(true);
    if (!rule.allowGlobal.includes(r)) return cell(false);
    return cell(true, rule.requireNonExpiredMembership ? '†' : '');
  });
  lines.push(
    `| \`${action}\` | ${ACTION_HUMAN_LABELS[action]} | ${cells.join(' | ')} |`,
  );
}
lines.push('');

// Section: company actions × membership role
lines.push('## Company-scoped actions by membership role');
lines.push('');
lines.push(
  'Memberships grant access regardless of global role (e.g. an OPERATOR_FULL membership lets an otherwise-unprivileged user manage assets in that single company).',
);
lines.push('');
lines.push('| Action | ' + MEMBERSHIP_ROLES.join(' | ') + ' |');
lines.push('| --- | ' + MEMBERSHIP_ROLES.map(() => '---').join(' | ') + ' |');
for (const action of ActionValues) {
  const rule = PERMISSIONS[action];
  if (rule.scope !== 'company') continue;
  const cells = MEMBERSHIP_ROLES.map((r) =>
    rule.allowMembership.includes(r)
      ? cell(true, rule.requireNonExpiredMembership ? '†' : '')
      : cell(false),
  );
  lines.push(`| \`${action}\` | ${cells.join(' | ')} |`);
}
lines.push('');

// Notes
lines.push('## Notes');
lines.push('');
for (const action of ActionValues) {
  const rule = PERMISSIONS[action];
  if (rule.note) lines.push(`- \`${action}\`: ${rule.note}`);
}
lines.push('');

const outPath = resolve(process.cwd(), 'docs/permissions.md');
writeFileSync(outPath, lines.join('\n'));
process.stdout.write(`wrote ${outPath}\n`);
