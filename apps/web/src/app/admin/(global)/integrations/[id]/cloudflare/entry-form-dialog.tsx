'use client';

import { useEffect, useState } from 'react';
import { parseIpEntry, type CloudflareIpEntryDto } from '@weavestream/shared';
import { Btn, Dialog, Field, Input, Tag, Textarea } from '../../../../../../components/ui';

/**
 * Add or edit a single IP entry. Validates the IP / CIDR client-side
 * via the shared `parseIpEntry` so feedback is immediate; the server
 * re-validates the canonicalised form before pushing to Cloudflare.
 */
export function EntryFormDialog({
  open,
  initial,
  onClose,
  onSubmit,
  submitting,
  error,
}: {
  open: boolean;
  initial: CloudflareIpEntryDto | null;
  onClose: () => void;
  onSubmit: (input: { ip: string; description: string }) => Promise<void> | void;
  submitting: boolean;
  error: string | null;
}) {
  const [ip, setIp] = useState(initial?.ip ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setIp(initial?.ip ?? '');
      setDescription(initial?.description ?? '');
      setLocalError(null);
    }
  }, [open, initial]);

  function submit(): void {
    const parsed = parseIpEntry(ip);
    if (!parsed) {
      setLocalError(
        'Enter a valid IPv4 or IPv6 address or CIDR range (e.g. 203.0.113.42 or 2001:db8::/32).',
      );
      return;
    }
    setLocalError(null);
    void onSubmit({ ip: parsed.canonical, description: description.trim() });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? `Edit ${initial.ip}` : 'Add IP entry'}
      width={460}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn kind="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Btn>
          <Btn kind="primary" onClick={submit} loading={submitting}>
            {initial ? 'Save' : 'Add entry'}
          </Btn>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field
          label="IP / CIDR"
          htmlFor="cf-entry-ip"
          help="IPv4, IPv6, or CIDR range. Single addresses (203.0.113.42) and ranges (203.0.113.0/24) are both accepted."
        >
          <Input
            id="cf-entry-ip"
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field
          label="Description"
          htmlFor="cf-entry-desc"
          help="Stored in Weavestream only — Cloudflare's per-item comment is left empty."
        >
          <Textarea
            id="cf-entry-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={1000}
          />
        </Field>
        {(localError ?? error) && <Tag tone="danger">{localError ?? error}</Tag>}
      </div>
    </Dialog>
  );
}
