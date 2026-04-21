'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../../lib/api';
import {
  Btn,
  Field,
  Input,
  Select,
  Tag,
  useToast,
} from '../../../../components/ui';
import {
  DEFAULT_TERM,
  TERM_PRESETS,
  buildTerm,
  lower,
  type TermPresetId,
} from '../../../../lib/term';
import type { Settings } from '../../../../lib/server-api';

/**
 * Settings form — one source of truth for `system_settings`. The preset
 * dropdown is a shortcut; operators can always fall back to "Custom" and
 * type a bespoke singular/plural/possessive. We keep the possessive
 * optional: if blank, the API stores `null` and `buildTerm` falls back
 * to `${singular}'s`.
 */
export function SettingsForm({ initial }: { initial: Settings }) {
  const router = useRouter();
  const toast = useToast();

  const [workspaceName, setWorkspaceName] = useState(initial.workspaceName);
  const [workspaceSubtitle, setWorkspaceSubtitle] = useState(
    initial.workspaceSubtitle,
  );

  const initialPreset = detectPreset(
    initial.tenantTermSingular,
    initial.tenantTermPlural,
    initial.tenantTermPossessive,
  );
  const [presetId, setPresetId] = useState<TermPresetId>(initialPreset);
  const [one, setOne] = useState(initial.tenantTermSingular);
  const [other, setOther] = useState(initial.tenantTermPlural);
  // Possessive is stored as `null` when cleared; we render an empty
  // string in the input so users can see the computed fallback.
  const [possessive, setPossessive] = useState(
    initial.tenantTermPossessive ?? '',
  );

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Baseline for the "Reset" button. The server version only changes on
  // a successful save; router.refresh() re-renders the server page and
  // will remount this form with fresh props, which is what we want.
  const baseline = useRef(initial);

  const previewTerm = useMemo(
    () =>
      buildTerm({
        tenantTermSingular: one.trim() || DEFAULT_TERM.one,
        tenantTermPlural: other.trim() || DEFAULT_TERM.other,
        tenantTermPossessive: possessive.trim() || null,
      }),
    [one, other, possessive],
  );

  const dirty =
    workspaceName.trim() !== baseline.current.workspaceName ||
    workspaceSubtitle.trim() !== baseline.current.workspaceSubtitle ||
    one.trim() !== baseline.current.tenantTermSingular ||
    other.trim() !== baseline.current.tenantTermPlural ||
    (possessive.trim() || null) !==
      (baseline.current.tenantTermPossessive ?? null);

  function applyPreset(id: TermPresetId) {
    setPresetId(id);
    if (id === 'custom') return;
    const preset = TERM_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setOne(preset.one);
    setOther(preset.other);
    setPossessive(preset.possessive);
  }

  function onCustomChange(
    field: 'one' | 'other' | 'possessive',
    value: string,
  ) {
    if (field === 'one') setOne(value);
    if (field === 'other') setOther(value);
    if (field === 'possessive') setPossessive(value);
    // Any manual edit drops the preset into "custom" so the dropdown
    // can't mislead you into thinking the preset is still applied.
    setPresetId('custom');
  }

  async function submit() {
    setError(null);
    setPending(true);
    const payload: Record<string, string | null> = {
      workspaceName: workspaceName.trim(),
      workspaceSubtitle: workspaceSubtitle.trim(),
      tenantTermSingular: one.trim(),
      tenantTermPlural: other.trim(),
      tenantTermPossessive: possessive.trim() === '' ? null : possessive.trim(),
    };
    const res = await apiFetch<Settings>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    setPending(false);
    if (!res.ok || !res.data) {
      const problem = res.problem as { title?: string; detail?: string } | undefined;
      setError(problem?.detail ?? problem?.title ?? 'Could not save settings.');
      return;
    }
    baseline.current = res.data;
    toast.push('Settings saved.', 'ok');
    router.refresh();
  }

  function reset() {
    const b = baseline.current;
    setWorkspaceName(b.workspaceName);
    setWorkspaceSubtitle(b.workspaceSubtitle);
    setOne(b.tenantTermSingular);
    setOther(b.tenantTermPlural);
    setPossessive(b.tenantTermPossessive ?? '');
    setPresetId(
      detectPreset(
        b.tenantTermSingular,
        b.tenantTermPlural,
        b.tenantTermPossessive,
      ),
    );
    setError(null);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SectionHeader
          label="Workspace"
          help="The name and subtitle shown in the sidebar chip, above every admin page."
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 16,
          }}
        >
          <Field label="Workspace name" htmlFor="s-ws-name">
            <Input
              id="s-ws-name"
              value={workspaceName}
              onChange={(e) => setWorkspaceName(e.target.value)}
              placeholder="My Company"
              maxLength={60}
            />
          </Field>
          <Field
            label="Subtitle"
            htmlFor="s-ws-sub"
            help="Shown in a smaller, muted font under the workspace name."
          >
            <Input
              id="s-ws-sub"
              value={workspaceSubtitle}
              onChange={(e) => setWorkspaceSubtitle(e.target.value)}
              placeholder="workspace"
              maxLength={60}
            />
          </Field>
        </div>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SectionHeader
          label="Tenant terminology"
          help={`Replaces the word "Company" everywhere in the UI. URL paths, API routes, and database columns are untouched.`}
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 16,
          }}
        >
          <Field label="Preset" htmlFor="s-preset">
            <Select
              id="s-preset"
              value={presetId}
              onChange={(e) => applyPreset(e.target.value as TermPresetId)}
            >
              {TERM_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.one} / {p.other}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </Select>
          </Field>
          <Field label="Singular" htmlFor="s-one">
            <Input
              id="s-one"
              value={one}
              onChange={(e) => onCustomChange('one', e.target.value)}
              placeholder="Company"
              maxLength={40}
            />
          </Field>
          <Field label="Plural" htmlFor="s-other">
            <Input
              id="s-other"
              value={other}
              onChange={(e) => onCustomChange('other', e.target.value)}
              placeholder="Companies"
              maxLength={40}
            />
          </Field>
        </div>
        <Field
          label="Possessive (optional)"
          htmlFor="s-possessive"
          help={`Used in phrases like "this ${lower(previewTerm.one)}'s members." Leave blank to auto-generate as "${previewTerm.one}'s".`}
        >
          <Input
            id="s-possessive"
            value={possessive}
            onChange={(e) => onCustomChange('possessive', e.target.value)}
            placeholder={`${previewTerm.one}'s`}
            maxLength={40}
          />
        </Field>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SectionHeader
          label="Preview"
          help="Sample copy rendered with your current terminology."
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr',
            gap: 8,
            padding: 16,
            background: 'var(--panel-2)',
            border: '1px solid var(--line-2)',
            borderRadius: 6,
            fontSize: 13,
            color: 'var(--text-2)',
            lineHeight: 1.55,
          }}
        >
          <PreviewLine>
            Sidebar nav: <strong>{previewTerm.other}</strong>
          </PreviewLine>
          <PreviewLine>
            Button: <strong>New {lower(previewTerm.one)}</strong>
          </PreviewLine>
          <PreviewLine>
            Dialog: <strong>Create {lower(previewTerm.one)}</strong>
          </PreviewLine>
          <PreviewLine>
            Empty state:{' '}
            <span>
              No {lower(previewTerm.other)} yet — add one to get started.
            </span>
          </PreviewLine>
          <PreviewLine>
            Possessive:{' '}
            <span>Updating this {lower(previewTerm.possessive)} details…</span>
          </PreviewLine>
        </div>
      </section>

      {error && (
        <Tag tone="danger" style={{ alignSelf: 'flex-start' }}>
          {error}
        </Tag>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 10,
          borderTop: '1px solid var(--line)',
          paddingTop: 16,
        }}
      >
        <Btn kind="ghost" onClick={reset} disabled={!dirty || pending}>
          Reset
        </Btn>
        <Btn
          kind="primary"
          onClick={submit}
          loading={pending}
          disabled={!dirty}
        >
          Save changes
        </Btn>
      </div>
    </div>
  );
}

function SectionHeader({ label, help }: { label: string; help?: string }) {
  return (
    <header style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <h3
        style={{
          margin: 0,
          fontFamily: 'var(--font-display)',
          fontSize: 14,
          fontWeight: 600,
          letterSpacing: -0.2,
          color: 'var(--text)',
        }}
      >
        {label}
      </h3>
      {help && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>{help}</p>
      )}
    </header>
  );
}

function PreviewLine({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}

function detectPreset(
  one: string,
  other: string,
  possessive: string | null,
): TermPresetId {
  const match = TERM_PRESETS.find(
    (p) =>
      p.one === one &&
      p.other === other &&
      (possessive === null || p.possessive === possessive),
  );
  return match ? match.id : 'custom';
}
