'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../lib/api';
import { Btn, Field, Input, Toggle, useToast } from '../../components/ui';
import { isOperator } from '../../lib/roles';
import type { Me } from '../../lib/server-api';
import { TimezonePicker } from './timezone-picker';

export function ProfileForm({ me }: { me: Me }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(me.name);
  const [timezone, setTimezone] = useState(me.timezone ?? '');
  // Search defaults are an operator affordance — the ⌘K palette
  // they tune is only reachable from operator shells. Hiding the
  // block for clients keeps /me focused on "your account" rather
  // than knobs that don't affect anything they can see.
  const showSearchDefaults = isOperator(me.role);
  const [defaultComprehensive, setDefaultComprehensive] = useState(
    me.searchDefaults?.defaultComprehensive ?? false,
  );
  const [defaultGlobal, setDefaultGlobal] = useState(
    me.searchDefaults?.defaultGlobal ?? false,
  );
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    // A null `searchDefaults` cell on the backend is cheaper than a
    // row storing `{false,false}`, so we collapse the baseline back
    // into null whenever both toggles are off. Users still see the
    // same UX — the server fills defaults back in on read.
    const bothOff = !defaultComprehensive && !defaultGlobal;
    const res = await apiFetch('/me', {
      method: 'PATCH',
      body: JSON.stringify({
        name,
        timezone: timezone.trim() || null,
        // Omit `searchDefaults` entirely when the section is hidden so
        // we don't silently overwrite whatever the server has on file
        // for a client who never saw the toggles.
        ...(showSearchDefaults
          ? {
              searchDefaults: bothOff
                ? null
                : { defaultComprehensive, defaultGlobal },
            }
          : {}),
      }),
    });
    setPending(false);
    if (!res.ok) {
      toast.push('Could not save.', 'danger');
      return;
    }
    toast.push('Profile updated.', 'ok');
    router.refresh();
  }

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 20 }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 14,
        }}
      >
        <Field label="Email" help="Contact an admin to change your email.">
          <Input value={me.email} disabled />
        </Field>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field
          label="Timezone"
          help={
            timezone.trim()
              ? 'Used for the timestamps you see across the app.'
              : 'Not set — timestamps display in UTC. Pick your timezone so times match your local clock.'
          }
        >
          <TimezonePicker value={timezone} onChange={setTimezone} />
        </Field>
      </div>
      {showSearchDefaults && (
        <div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--muted)',
              letterSpacing: 0.6,
              textTransform: 'uppercase',
              marginBottom: 10,
            }}
          >
            Search defaults
          </div>
          <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--dim)' }}>
            Baseline behaviour for the ⌘K command palette. You can override
            either toggle per-search inside the palette itself.
          </p>
          <div style={{ display: 'grid', gap: 10, maxWidth: 560 }}>
            <Toggle
              label="Default to comprehensive"
              help="Match partial words so short queries surface longer stems."
              checked={defaultComprehensive}
              onChange={setDefaultComprehensive}
            />
            <Toggle
              label="Default to global"
              help="Search every company you can access, even when viewing one."
              checked={defaultGlobal}
              onChange={setDefaultGlobal}
            />
          </div>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Btn type="submit" kind="primary" loading={pending}>
          Save profile
        </Btn>
      </div>
    </form>
  );
}

