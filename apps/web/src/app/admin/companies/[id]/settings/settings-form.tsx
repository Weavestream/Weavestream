'use client';

import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../../../lib/api';
import {
  Btn,
  Dialog,
  Field,
  Icon,
  Input,
  Panel,
  Select,
  Textarea,
  useToast,
} from '../../../../../components/ui';
import type {
  CompanyDetail,
  CompanyParentRef,
  CompanyType,
} from '../../../../../lib/server-api';
import { capitalize } from '../../../../../lib/term';
import { useTerm } from '../../../../../lib/term-context';
import {
  companyTypeOptions,
  slugify,
} from '../../../../../lib/company-format';
import { LogoUploadField } from './logo-upload';
import { ParentCompanyPicker } from './parent-company-picker';

type StickyNoteSeverity = 'INFO' | 'WARN' | 'CRITICAL';

type Draft = {
  name: string;
  slug: string;
  type: CompanyType;
  notes: string;
  quickNotes: string;
  parent: CompanyParentRef | null;

  contactName: string;
  contactTitle: string;
  contactEmail: string;
  contactPhone: string;
  generalEmail: string;
  phone: string;
  fax: string;
  website: string;

  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;

  stickyNoteText: string;
  stickyNoteSeverity: StickyNoteSeverity;
};

function fromCompany(c: CompanyDetail): Draft {
  return {
    name: c.name,
    slug: c.slug,
    type: c.type,
    notes: c.notes ?? '',
    quickNotes: c.quickNotes ?? '',
    parent: c.parent,
    contactName: c.contactName ?? '',
    contactTitle: c.contactTitle ?? '',
    contactEmail: c.contactEmail ?? '',
    contactPhone: c.contactPhone ?? '',
    generalEmail: c.generalEmail ?? '',
    phone: c.phone ?? '',
    fax: c.fax ?? '',
    website: c.website ?? '',
    addressLine1: c.addressLine1 ?? '',
    addressLine2: c.addressLine2 ?? '',
    city: c.city ?? '',
    region: c.region ?? '',
    postalCode: c.postalCode ?? '',
    country: c.country ?? '',
    stickyNoteText: c.stickyNoteText ?? '',
    // Default severity to INFO when none is set on the row — the
    // dropdown always needs a defined value, and the API ignores
    // severity until text is non-empty.
    stickyNoteSeverity: c.stickyNoteSeverity ?? 'INFO',
  };
}

/**
 * Full company settings form. Editing a ~20-field company in a modal
 * doesn't scale, so this lives on its own route. All fields are
 * buffered locally; `Save changes` PATCHes once with only the keys that
 * actually changed — keeps the audit log noise to a minimum and lets
 * the API ignore no-op updates.
 */
export function CompanySettingsForm({
  company,
}: {
  company: CompanyDetail;
}) {
  const router = useRouter();
  const toast = useToast();
  const term = useTerm();
  const initial = useMemo(() => fromCompany(company), [company]);
  const [draft, setDraft] = useState<Draft>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [slugTouched, setSlugTouched] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    // Clear a field-level validation error the moment the user edits
    // that field — don't leave stale red messages hanging around.
    if (fieldErrors[key as string]) {
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next[key as string];
        return next;
      });
    }
  }

  const dirty = useMemo(() => computePatch(initial, draft), [initial, draft]);
  const hasChanges = Object.keys(dirty).length > 0;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!hasChanges) return;
    setError(null);
    setFieldErrors({});
    setPending(true);
    const res = await apiFetch(`/companies/${company.id}`, {
      method: 'PATCH',
      body: JSON.stringify(dirty),
    });
    setPending(false);
    if (!res.ok) {
      handleApiError(res.problem);
      return;
    }
    toast.push(`${capitalize(term.one)} updated.`, 'ok');
    router.push(`/admin/companies/${company.id}`);
    router.refresh();
  }

  function handleApiError(problem: unknown) {
    // RFC 7807 extension members: structured validation errors come back
    // as `{ error: 'ValidationError', issues: [{ path, message }] }` —
    // surface them inline on the matching field rather than dumping
    // "Validation Error" at the bottom of the form (which leaves the
    // user guessing which field was wrong).
    const p = problem as
      | {
          detail?: string;
          title?: string;
          error?: string;
          issues?: Array<{ path: string; message: string }>;
        }
      | undefined;
    if (p?.issues && Array.isArray(p.issues) && p.issues.length > 0) {
      const byField: Record<string, string> = {};
      const orphans: string[] = [];
      for (const iss of p.issues) {
        // Map the API's `parentCompanyId` onto the `parent` draft key so
        // the error renders on the picker row.
        const key = iss.path === 'parentCompanyId' ? 'parent' : iss.path;
        if (key && key in initial) {
          byField[key] = humanizeIssue(iss.message);
        } else {
          orphans.push(
            `${prettyFieldName(iss.path)}: ${humanizeIssue(iss.message)}`,
          );
        }
      }
      setFieldErrors(byField);
      const fieldCount = Object.keys(byField).length;
      setError(
        orphans.length > 0
          ? orphans.join('; ')
          : fieldCount === 1
            ? 'Fix the highlighted field and try again.'
            : `Fix the ${fieldCount} highlighted fields and try again.`,
      );
      return;
    }
    setError(
      p?.detail ?? p?.title ?? 'Could not save changes. Please try again.',
    );
  }

  function reset() {
    setDraft(initial);
    setSlugTouched(false);
    setError(null);
    setFieldErrors({});
  }

  function leave() {
    router.push(`/admin/companies/${company.id}`);
  }

  /**
   * Cancel goes back to the company without saving. Clean forms leave
   * straight away; a dirty one confirms first, because Cancel sits next
   * to Revert and the save bar has just told the operator how many
   * changes they are holding. Discarding those silently on a misclick
   * is the one failure this button can cause.
   */
  function onCancel() {
    if (!hasChanges) {
      leave();
      return;
    }
    setConfirmLeave(true);
  }

  return (
    <form
      onSubmit={onSubmit}
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      {/* -------- Identity ---------- */}
      <Panel title="Identity">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <LogoUploadField company={company} />
          <TwoUp>
            <Field label="Name" htmlFor="c-name" error={fieldErrors.name}>
              <Input
                id="c-name"
                value={draft.name}
                onChange={(e) => {
                  const next = e.target.value;
                  set('name', next);
                  if (!slugTouched) set('slug', slugify(next));
                }}
                required
              />
            </Field>
            <Field
              label="URL slug"
              htmlFor="c-slug"
              error={fieldErrors.slug}
              help="Lower-case letters, numbers, and hyphens."
            >
              <Input
                id="c-slug"
                value={draft.slug}
                onChange={(e) => {
                  set('slug', e.target.value.toLowerCase());
                  setSlugTouched(true);
                }}
                style={{ fontFamily: 'var(--font-mono)' }}
              />
            </Field>
          </TwoUp>
          <TwoUp>
            <Field label="Type" htmlFor="c-type" error={fieldErrors.type}>
              <Select
                id="c-type"
                value={draft.type}
                onChange={(e) => set('type', e.target.value as CompanyType)}
              >
                {companyTypeOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label={`Parent ${term.one.toLowerCase()}`}
              error={fieldErrors.parent}
              help="Create a hierarchy — e.g. parent organisation with child sites."
            >
              <ParentCompanyPicker
                currentCompanyId={company.id}
                value={draft.parent}
                onChange={(next) => set('parent', next)}
              />
            </Field>
          </TwoUp>
        </div>
      </Panel>

      {/* -------- Contact ---------- */}
      <Panel title="Contact">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <TwoUp>
            <Field
              label="Primary contact name"
              htmlFor="c-contact-name"
              error={fieldErrors.contactName}
            >
              <Input
                id="c-contact-name"
                value={draft.contactName}
                onChange={(e) => set('contactName', e.target.value)}
              />
            </Field>
            <Field
              label="Contact title"
              htmlFor="c-contact-title"
              error={fieldErrors.contactTitle}
            >
              <Input
                id="c-contact-title"
                value={draft.contactTitle}
                onChange={(e) => set('contactTitle', e.target.value)}
              />
            </Field>
          </TwoUp>
          <TwoUp>
            <Field
              label="Contact email"
              htmlFor="c-contact-email"
              error={fieldErrors.contactEmail}
            >
              <Input
                id="c-contact-email"
                type="email"
                value={draft.contactEmail}
                onChange={(e) => set('contactEmail', e.target.value)}
              />
            </Field>
            <Field
              label="Contact phone"
              htmlFor="c-contact-phone"
              error={fieldErrors.contactPhone}
            >
              <Input
                id="c-contact-phone"
                type="tel"
                value={draft.contactPhone}
                onChange={(e) => set('contactPhone', e.target.value)}
              />
            </Field>
          </TwoUp>
          <TwoUp>
            <Field
              label="General email"
              htmlFor="c-general-email"
              error={fieldErrors.generalEmail}
            >
              <Input
                id="c-general-email"
                type="email"
                value={draft.generalEmail}
                onChange={(e) => set('generalEmail', e.target.value)}
                placeholder="hello@example.com"
              />
            </Field>
            <Field
              label="Website"
              htmlFor="c-website"
              error={fieldErrors.website}
            >
              <Input
                id="c-website"
                value={draft.website}
                onChange={(e) => set('website', e.target.value)}
                placeholder="https://example.com"
              />
            </Field>
          </TwoUp>
          <TwoUp>
            <Field label="Phone" htmlFor="c-phone" error={fieldErrors.phone}>
              <Input
                id="c-phone"
                type="tel"
                value={draft.phone}
                onChange={(e) => set('phone', e.target.value)}
              />
            </Field>
            <Field label="Fax" htmlFor="c-fax" error={fieldErrors.fax}>
              <Input
                id="c-fax"
                type="tel"
                value={draft.fax}
                onChange={(e) => set('fax', e.target.value)}
              />
            </Field>
          </TwoUp>
        </div>
      </Panel>

      {/* -------- Address ---------- */}
      <Panel title="Address">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field
            label="Street address"
            htmlFor="c-addr1"
            error={fieldErrors.addressLine1}
          >
            <Input
              id="c-addr1"
              value={draft.addressLine1}
              onChange={(e) => set('addressLine1', e.target.value)}
              placeholder="123 Main Street"
            />
          </Field>
          <Field
            label="Address line 2"
            htmlFor="c-addr2"
            error={fieldErrors.addressLine2}
          >
            <Input
              id="c-addr2"
              value={draft.addressLine2}
              onChange={(e) => set('addressLine2', e.target.value)}
              placeholder="Suite 400"
            />
          </Field>
          <TwoUp>
            <Field label="City" htmlFor="c-city" error={fieldErrors.city}>
              <Input
                id="c-city"
                value={draft.city}
                onChange={(e) => set('city', e.target.value)}
              />
            </Field>
            <Field
              label="State / region"
              htmlFor="c-region"
              error={fieldErrors.region}
            >
              <Input
                id="c-region"
                value={draft.region}
                onChange={(e) => set('region', e.target.value)}
              />
            </Field>
          </TwoUp>
          <TwoUp>
            <Field
              label="Postal code"
              htmlFor="c-postal"
              error={fieldErrors.postalCode}
            >
              <Input
                id="c-postal"
                value={draft.postalCode}
                onChange={(e) => set('postalCode', e.target.value)}
              />
            </Field>
            <Field
              label="Country"
              htmlFor="c-country"
              error={fieldErrors.country}
            >
              <Input
                id="c-country"
                value={draft.country}
                onChange={(e) => set('country', e.target.value)}
              />
            </Field>
          </TwoUp>
        </div>
      </Panel>

      {/* -------- Notes ---------- */}
      <Panel title="Notes">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field
            label="Quick notes"
            htmlFor="c-quick-notes"
            error={fieldErrors.quickNotes}
            help="Short reminders shown on the company home page header."
          >
            <Textarea
              id="c-quick-notes"
              value={draft.quickNotes}
              onChange={(e) => set('quickNotes', e.target.value)}
              placeholder="Primary tech lead, preferred maintenance windows, …"
            />
          </Field>
          <Field
            label="Internal notes"
            htmlFor="c-notes"
            error={fieldErrors.notes}
            help="Longer context. Visible only to operators."
          >
            <Textarea
              id="c-notes"
              value={draft.notes}
              onChange={(e) => set('notes', e.target.value)}
              style={{ minHeight: 120 }}
            />
          </Field>
        </div>
      </Panel>

      {/* -------- Sticky note ---------- */}
      <Panel title="Sticky note">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field
            label="Severity"
            htmlFor="c-sticky-severity"
            error={fieldErrors.stickyNoteSeverity}
            help="Drives the banner colour. Critical notes also stay pinned while scrolling."
            style={{ maxWidth: 220 }}
          >
            <Select
              id="c-sticky-severity"
              value={draft.stickyNoteSeverity}
              onChange={(e) =>
                set('stickyNoteSeverity', e.target.value as StickyNoteSeverity)
              }
            >
              <option value="INFO">Info</option>
              <option value="WARN">Warning</option>
              <option value="CRITICAL">Critical</option>
            </Select>
          </Field>
          <Field
            label="Message"
            htmlFor="c-sticky-text"
            error={fieldErrors.stickyNoteText}
            help="Shown as a coloured banner on every admin page for this company. Leave blank to hide. Max 300 characters."
          >
            <Textarea
              id="c-sticky-text"
              value={draft.stickyNoteText}
              onChange={(e) => set('stickyNoteText', e.target.value)}
              maxLength={300}
              placeholder="Heads-up for anyone working this account…"
            />
          </Field>
        </div>
      </Panel>

      {/* -------- Save bar ---------- */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 10,
          boxShadow: 'var(--shadow-1)',
        }}
      >
        <span
          style={{
            fontSize: 12,
            color: error ? 'var(--danger)' : 'var(--muted)',
            fontFamily: 'var(--font-mono)',
            flex: 1,
            minWidth: 150,
          }}
        >
          {hasChanges
            ? error
              ? error
              : `${Object.keys(dirty).length} unsaved change${
                  Object.keys(dirty).length === 1 ? '' : 's'
                }`
            : 'All changes saved'}
        </span>
        <Btn kind="ghost" type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </Btn>
        <Btn
          kind="ghost"
          type="button"
          onClick={reset}
          disabled={!hasChanges || pending}
          icon={Icon.x}
        >
          Revert
        </Btn>
        <Btn
          kind="primary"
          type="submit"
          loading={pending}
          disabled={!hasChanges}
          icon={Icon.check}
        >
          Save changes
        </Btn>
      </div>

      <Dialog
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title="Discard unsaved changes?"
        footer={
          <>
            <Btn
              kind="ghost"
              type="button"
              onClick={() => setConfirmLeave(false)}
            >
              Keep editing
            </Btn>
            <Btn kind="danger" type="button" onClick={leave}>
              Discard changes
            </Btn>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          {Object.keys(dirty).length} unsaved change
          {Object.keys(dirty).length === 1 ? '' : 's'} will be lost. This
          doesn't touch anything already saved.
        </p>
      </Dialog>
    </form>
  );
}

/**
 * Zod's default strings ("Invalid email", "String must contain at most
 * 200 character(s)") are fine for inline display; we only tweak the
 * ones that sound like they were translated from a robot.
 */
function humanizeIssue(message: string): string {
  if (!message) return 'Invalid value';
  if (/invalid_string|invalid string/i.test(message)) return 'Invalid value';
  return message;
}

/**
 * Fallback when an API `path` doesn't match a draft key. Splits
 * `camelCase` / `dotted.path` into something a human can read.
 */
function prettyFieldName(path: string): string {
  if (!path) return 'Field';
  const last = path.split('.').pop()!;
  return last
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function TwoUp({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 12,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Build the minimal PATCH payload. Empty strings become `null` so the
 * API clears the column. `parent` is lifted into `parentCompanyId`;
 * `logoUploadId` is handled inline by the logo uploader so we don't
 * send it here.
 */
function computePatch(initial: Draft, draft: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const textKeys: Array<keyof Draft> = [
    'name',
    'slug',
    'notes',
    'quickNotes',
    'contactName',
    'contactTitle',
    'contactEmail',
    'contactPhone',
    'generalEmail',
    'phone',
    'fax',
    'website',
    'addressLine1',
    'addressLine2',
    'city',
    'region',
    'postalCode',
    'country',
  ];
  for (const k of textKeys) {
    const before = (initial[k] as string) ?? '';
    const after = (draft[k] as string) ?? '';
    if (before === after) continue;
    // Required fields can't be emptied; for those we send the literal
    // string. All other blanks map to null so the column clears out.
    if (k === 'name' || k === 'slug') {
      out[k] = after;
    } else {
      out[k] = after.trim() === '' ? null : after;
    }
  }
  if (initial.type !== draft.type) out.type = draft.type;
  const parentBefore = initial.parent?.id ?? null;
  const parentAfter = draft.parent?.id ?? null;
  if (parentBefore !== parentAfter) out.parentCompanyId = parentAfter;

  // Sticky note: send text on change. Severity rides along whenever
  // the text is non-empty AND either changed or the text just turned
  // on (so a fresh banner picks up the chosen colour). When text is
  // cleared, the API reconciler will null severity itself, so we
  // don't send it.
  const stickyTextBefore = initial.stickyNoteText;
  const stickyTextAfter = draft.stickyNoteText;
  const stickyTextChanged = stickyTextBefore !== stickyTextAfter;
  const stickySevChanged =
    initial.stickyNoteSeverity !== draft.stickyNoteSeverity;
  if (stickyTextChanged) {
    out.stickyNoteText =
      stickyTextAfter.trim() === '' ? null : stickyTextAfter;
  }
  if (
    draft.stickyNoteText.trim() !== '' &&
    (stickySevChanged || (stickyTextChanged && stickyTextBefore.trim() === ''))
  ) {
    out.stickyNoteSeverity = draft.stickyNoteSeverity;
  }
  return out;
}
