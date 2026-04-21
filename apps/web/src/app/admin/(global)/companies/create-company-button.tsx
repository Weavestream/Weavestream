'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createCompanySchema } from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import {
  Btn,
  Dialog,
  Field,
  Icon,
  Input,
  Select,
  Textarea,
  useToast,
} from '../../../../components/ui';
import { lower } from '../../../../lib/term';
import { useTerm } from '../../../../lib/term-context';
import { companyTypeOptions, slugify } from '../../../../lib/company-format';
import type { CompanyType } from '../../../../lib/server-api';

/**
 * Create dialog for companies. Kept deliberately lean: name, slug,
 * type, and optional notes. All Phase 9a extras (contact, address,
 * parent, logo) live on the dedicated Settings page that opens right
 * after creation.
 */
export function CreateCompanyButton() {
  const router = useRouter();
  const toast = useToast();
  const term = useTerm();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [type, setType] = useState<CompanyType>('CLIENT');
  const [notes, setNotes] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function reset() {
    setName('');
    setSlug('');
    setType('CLIENT');
    setNotes('');
    setSlugTouched(false);
    setError(null);
  }

  async function submit() {
    setError(null);
    const parsed = createCompanySchema.safeParse({
      name,
      slug,
      type,
      notes: notes.trim() || undefined,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the fields above.');
      return;
    }
    setPending(true);
    const res = await apiFetch<{ id: string }>('/companies', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
    });
    setPending(false);
    if (!res.ok || !res.data) {
      const problem = res.problem as { title?: string; detail?: string } | undefined;
      setError(
        problem?.detail ?? problem?.title ?? `Could not create ${lower(term.one)}.`,
      );
      return;
    }
    toast.push(`Created ${parsed.data.name}`, 'ok');
    setOpen(false);
    reset();
    // Land on the Settings page so operators can fill out the
    // remaining fields without an extra click.
    router.push(`/admin/companies/${res.data.id}/settings`);
    router.refresh();
  }

  return (
    <>
      <Btn kind="primary" size="md" icon={Icon.plus} onClick={() => setOpen(true)}>
        New {lower(term.one)}
      </Btn>
      <Dialog
        open={open}
        onClose={() => {
          if (!pending) {
            setOpen(false);
            reset();
          }
        }}
        title={`Create ${lower(term.one)}`}
        footer={
          <>
            <Btn
              kind="ghost"
              onClick={() => {
                setOpen(false);
                reset();
              }}
              disabled={pending}
            >
              Cancel
            </Btn>
            <Btn kind="primary" onClick={submit} loading={pending}>
              Create
            </Btn>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Name" htmlFor="name">
            <Input
              id="name"
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
              placeholder="Acme Industries"
            />
          </Field>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 160px',
              gap: 12,
            }}
          >
            <Field
              label="URL slug"
              htmlFor="slug"
              help="Lower-case letters, numbers, and hyphens."
            >
              <Input
                id="slug"
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value.toLowerCase());
                  setSlugTouched(true);
                }}
                style={{ fontFamily: 'var(--font-mono)' }}
                placeholder="acme-industries"
              />
            </Field>
            <Field label="Type" htmlFor="type">
              <Select
                id="type"
                value={type}
                onChange={(e) => setType(e.target.value as CompanyType)}
              >
                {companyTypeOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field
            label="Internal notes"
            htmlFor="notes"
            help="Visible only to operators. More fields after you create."
            error={error ?? undefined}
          >
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Point of contact, billing notes…"
            />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
