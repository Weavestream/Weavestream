'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { problemMessage } from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import { Toggle, useToast } from '../../../../components/ui';
import { SectionHeader } from './settings-form';

/**
 * Instance-wide switch for API key (Bearer token) access.
 *
 * Saves on change rather than joining the Save/Reset form below it: the
 * route requires a fresh step-up (`apiFetch` prompts for it), and a
 * security switch should not sit as an unsaved edit next to cosmetic ones.
 * Off refuses every key and every new key; it does not revoke, so turning
 * it back on restores existing keys.
 */
export function ApiKeysSwitch({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [value, setValue] = useState(enabled);
  const [pending, setPending] = useState(false);

  async function change(next: boolean) {
    if (pending) return;
    setPending(true);
    const res = await apiFetch('/settings/api-keys', {
      method: 'PUT',
      body: JSON.stringify({ enabled: next }),
    });
    setPending(false);
    if (!res.ok) {
      if (!res.stepUpCancelled) {
        toast.push(problemMessage(res.problem) ?? 'Could not change the API key setting.', 'danger');
      }
      return;
    }
    setValue(next);
    toast.push(
      next
        ? 'API keys turned on. Users can create keys from their account page.'
        : 'API keys turned off. Existing keys are refused until you turn them back on.',
      'ok',
    );
    router.refresh();
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionHeader
        label="API keys"
        help="Let users create API keys for scripts and AI agents (MCP). A key acts as its owner, and is read-only unless the owner allows changes."
      />
      <div style={{ opacity: pending ? 0.6 : 1, pointerEvents: pending ? 'none' : undefined }}>
        <Toggle
          label="Allow API keys"
          help={
            value
              ? 'On. Turning this off refuses every existing key at once and blocks new ones. Keys are not deleted.'
              : 'Off. Every API key is refused, and no one can create a new key.'
          }
          checked={value}
          onChange={(next) => void change(next)}
        />
      </div>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
        See and revoke every user&apos;s keys in the{' '}
        <Link href="/admin/security?tab=api-keys" style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}>
          Security center
        </Link>
        .
      </p>
    </section>
  );
}
