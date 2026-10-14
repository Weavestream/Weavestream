'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { problemMessage } from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import { Toggle, useToast } from '../../../../components/ui';
import { SectionHeader } from './settings-form';

/**
 * An instance-wide access switch (API keys, remote AI connections).
 *
 * Saves on change rather than joining a Save/Reset form: the route requires
 * a fresh step-up (`apiFetch` prompts for it), and a security switch should
 * not sit as an unsaved edit next to cosmetic ones. Off refuses every
 * credential of that kind; it does not revoke, so turning it back on
 * restores them.
 */
export function AccessSwitch({
  enabled,
  route,
  title,
  description,
  label,
  onHelp,
  offHelp,
  turnedOn,
  turnedOff,
  failed,
  securityTab,
  securityText,
}: {
  enabled: boolean;
  route: string;
  title: string;
  description: string;
  label: string;
  onHelp: string;
  offHelp: string;
  turnedOn: string;
  turnedOff: string;
  failed: string;
  securityTab: string;
  securityText: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [value, setValue] = useState(enabled);
  const [pending, setPending] = useState(false);

  async function change(next: boolean) {
    if (pending) return;
    setPending(true);
    let res: Awaited<ReturnType<typeof apiFetch>>;
    try {
      res = await apiFetch(route, {
        method: 'PUT',
        body: JSON.stringify({ enabled: next }),
      });
    } catch {
      // The switch stays as it was; the server state is unknown, so say so.
      toast.push(`${failed} Weavestream could not be reached; reload to see the current state.`, 'danger');
      return;
    } finally {
      setPending(false);
    }
    if (!res.ok) {
      if (!res.stepUpCancelled) {
        toast.push(problemMessage(res.problem) ?? failed, 'danger');
      }
      return;
    }
    setValue(next);
    toast.push(next ? turnedOn : turnedOff, 'ok');
    router.refresh();
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionHeader label={title} help={description} />
      <div style={{ opacity: pending ? 0.6 : 1, pointerEvents: pending ? 'none' : undefined }}>
        <Toggle
          label={label}
          help={value ? onHelp : offHelp}
          checked={value}
          onChange={(next) => void change(next)}
        />
      </div>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
        {securityText} in the{' '}
        <Link
          href={`/admin/security?tab=${securityTab}`}
          style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}
        >
          Security center
        </Link>
        .
      </p>
    </section>
  );
}

/** Instance-wide switch for API key (Bearer token) access. */
export function ApiKeysSwitch({ enabled }: { enabled: boolean }) {
  return (
    <AccessSwitch
      enabled={enabled}
      route="/settings/api-keys"
      title="API keys"
      description="Let users create API keys for scripts and AI agents (MCP). A key acts as its owner, and is read-only unless the owner allows changes."
      label="Allow API keys"
      onHelp="On. Turning this off refuses every existing key at once and blocks new ones. Keys are not deleted."
      offHelp="Off. Every API key is refused, and no one can create a new key."
      turnedOn="API keys turned on. Users can create keys from their account page."
      turnedOff="API keys turned off. Existing keys are refused until you turn them back on."
      failed="Could not change the API key setting."
      securityTab="api-keys"
      securityText="See and revoke every user's keys"
    />
  );
}

/** Instance-wide switch for remote MCP connections from ChatGPT and Claude. */
export function McpRemoteSwitch({ enabled }: { enabled: boolean }) {
  return (
    <AccessSwitch
      enabled={enabled}
      route="/settings/mcp-remote"
      title="Remote AI connections (MCP)"
      description="Let users connect ChatGPT and Claude to Weavestream at /mcp. A connection signs in with the user's own login and MFA, acts as that user, and is read-only unless the user allows changes. It can never see passwords or delete anything."
      label="Allow remote AI connections"
      onHelp="On. Turning this off refuses every connection at once and blocks new ones. Connections are not deleted."
      offHelp="Off. Every remote AI connection is refused, and no one can connect a new one."
      turnedOn="Remote AI connections turned on. Users can connect ChatGPT or Claude to /mcp."
      turnedOff="Remote AI connections turned off. Existing connections are refused until you turn them back on."
      failed="Could not change the remote AI connection setting."
      securityTab="ai-connections"
      securityText="See and revoke every user's connections"
    />
  );
}
