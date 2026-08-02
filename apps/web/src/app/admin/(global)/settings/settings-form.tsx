'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  PASSWORD_GENERATOR_PRESET_DEFAULTS,
  passwordGeneratorPresetValues,
  passwordGeneratorSeparatorValues,
  type ArticleEditorMode,
  type PasswordGeneratorDefaults,
  type PasswordGeneratorPreset,
  type PasswordGeneratorSeparator,
} from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import {
  Btn,
  Field,
  Icon,
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
import { generatePassword } from '@weavestream/shared/browser';

/**
 * Settings form — one source of truth for `system_settings`. The preset
 * dropdown is a shortcut; operators can always fall back to "Custom" and
 * type a bespoke singular/plural/possessive. We keep the possessive
 * optional: if blank, the API stores `null` and `buildTerm` falls back
 * to `${singular}'s`.
 */
export function GeneralSettingsForm({ initial }: { initial: Settings }) {
  return <SettingsForm initial={initial} section="general" />;
}

export function SecuritySettingsForm({ initial }: { initial: Settings }) {
  return <SettingsForm initial={initial} section="security" />;
}

export function ArticleSettingsForm({ initial }: { initial: Settings }) {
  return <SettingsForm initial={initial} section="articles" />;
}

type SettingsSection = 'general' | 'security' | 'articles';

function SettingsForm({
  initial,
  section,
}: {
  initial: Settings;
  section: SettingsSection;
}) {
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

  const [generator, setGenerator] = useState<PasswordGeneratorDefaults>(
    initial.passwordGeneratorDefaults,
  );
  const [articleAutosaveEnabled, setArticleAutosaveEnabled] = useState(
    initial.articleAutosaveEnabled,
  );
  const [articleDefaultEditorMode, setArticleDefaultEditorMode] =
    useState<ArticleEditorMode>(initial.articleDefaultEditorMode);

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

  const generatorDirty = useMemo(
    () =>
      !shallowEqualGenerator(
        generator,
        baseline.current.passwordGeneratorDefaults,
      ),
    [generator],
  );

  const generalDirty =
    workspaceName.trim() !== baseline.current.workspaceName ||
    workspaceSubtitle.trim() !== baseline.current.workspaceSubtitle ||
    one.trim() !== baseline.current.tenantTermSingular ||
    other.trim() !== baseline.current.tenantTermPlural ||
    (possessive.trim() || null) !==
      (baseline.current.tenantTermPossessive ?? null);

  const articlesDirty =
    articleAutosaveEnabled !== baseline.current.articleAutosaveEnabled ||
    articleDefaultEditorMode !== baseline.current.articleDefaultEditorMode;

  const dirty =
    section === 'general'
      ? generalDirty
      : section === 'articles'
        ? articlesDirty
        : generatorDirty;

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
    const payload: Record<string, unknown> =
      section === 'general'
        ? {
            workspaceName: workspaceName.trim(),
            workspaceSubtitle: workspaceSubtitle.trim(),
            tenantTermSingular: one.trim(),
            tenantTermPlural: other.trim(),
            tenantTermPossessive:
              possessive.trim() === '' ? null : possessive.trim(),
          }
        : section === 'articles'
          ? { articleAutosaveEnabled, articleDefaultEditorMode }
          : { passwordGeneratorDefaults: generator };
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
    setGenerator(b.passwordGeneratorDefaults);
    setArticleAutosaveEnabled(b.articleAutosaveEnabled);
    setArticleDefaultEditorMode(b.articleDefaultEditorMode);
    setError(null);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      {section === 'general' && (
        <>
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

        </>
      )}

      {section === 'articles' && (
        <>
          <section
            style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
          >
            <SectionHeader
              label="Default editor format"
              help="Applied when an operator clicks New article. Each article remembers its own format after creation, so this only seeds the initial choice."
            />
            <EditorModePicker
              value={articleDefaultEditorMode}
              onChange={setArticleDefaultEditorMode}
            />
          </section>

          <section
            style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
          >
            <SectionHeader
              label="Autosave"
              help="Controls whether the article editor silently persists in-progress edits while typing."
            />
            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: 12,
                background: 'var(--panel-2)',
                border: '1px solid var(--line-2)',
                borderRadius: 6,
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={articleAutosaveEnabled}
                onChange={(e) => setArticleAutosaveEnabled(e.target.checked)}
                style={{ marginTop: 3, accentColor: 'var(--accent)' }}
              />
              <span
                style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
              >
                <span
                  style={{
                    fontSize: 13,
                    color: 'var(--text)',
                    fontWeight: 500,
                  }}
                >
                  Enable article autosave (drafts every ~4 s)
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: 'var(--muted)',
                    lineHeight: 1.5,
                  }}
                >
                  When on, the editor stores work-in-progress edits as a
                  single rolling draft version. Clicking Save promotes the
                  draft to a numbered version; Cancel discards the draft and
                  restores the article to its last saved version. Off by
                  default — operators must click Save to persist any change.
                </span>
              </span>
            </label>
          </section>
        </>
      )}

      {section === 'security' && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <SectionHeader
            label="Password generator defaults"
            help="Applied when operators open the generator inside the password dialog. Presets seed the knobs below; individual knobs can still be tweaked before saving."
          />
          <GeneratorEditor value={generator} onChange={setGenerator} />
        </section>
      )}

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

const EDITOR_MODE_OPTIONS: ReadonlyArray<{
  id: ArticleEditorMode;
  label: string;
  help: string;
}> = [
  {
    id: 'tiptap',
    label: 'WYSIWYG',
    help: 'Rich-text editor with toolbar — what most operators expect.',
  },
  {
    id: 'markdown',
    label: 'Markdown',
    help: 'Source editor with live preview — better for technical teams.',
  },
];

/**
 * Segmented control mirroring the password-generator preset picker so
 * the two article-settings sections feel visually consistent. Selected
 * tile uses the accent colour; helper copy under each label tells the
 * admin which UX their operators will land in on "New article".
 */
function EditorModePicker({
  value,
  onChange,
}: {
  value: ArticleEditorMode;
  onChange: (next: ArticleEditorMode) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Default article editor format"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 10,
      }}
    >
      {EDITOR_MODE_OPTIONS.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.id)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 4,
              textAlign: 'left',
              padding: '12px 14px',
              borderRadius: 6,
              border: '1px solid',
              borderColor: active ? 'var(--accent)' : 'var(--line-2)',
              background: active ? 'var(--accent-soft)' : 'var(--panel-2)',
              color: 'var(--text)',
              cursor: 'pointer',
              transition:
                'background 120ms ease, border-color 120ms ease, color 120ms ease',
            }}
          >
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: active ? 'var(--accent)' : 'var(--text)',
              }}
            >
              {opt.label}
            </span>
            <span
              style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}
            >
              {opt.help}
            </span>
          </button>
        );
      })}
    </div>
  );
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

function shallowEqualGenerator(
  a: PasswordGeneratorDefaults,
  b: PasswordGeneratorDefaults,
): boolean {
  return (
    a.preset === b.preset &&
    a.length === b.length &&
    a.words === b.words &&
    a.separator === b.separator &&
    a.alternateCase === b.alternateCase &&
    a.includeNumber === b.includeNumber
  );
}

const GENERATOR_PRESET_LABELS: Record<PasswordGeneratorPreset, string> = {
  say: 'Easier to say',
  read: 'Easier to read',
  remember: 'Easier to remember',
};

const GENERATOR_SEPARATOR_LABELS: Record<PasswordGeneratorSeparator, string> = {
  space: 'space',
  hyphen: '-',
  underscore: '_',
  dot: '.',
  none: 'none',
};

/**
 * Admin editor for the workspace-wide password generator defaults.
 *
 * Mirrors the popover UX so admins see exactly what operators will get:
 * a segmented preset picker, the five shared knobs, and a live-regenerating
 * preview using `generatePassword`. Changing a preset re-seeds the knobs
 * from `PASSWORD_GENERATOR_PRESET_DEFAULTS`; tweaking a knob manually
 * keeps the preset label — it just means "this is the baseline preset
 * with these overrides".
 */
function GeneratorEditor({
  value,
  onChange,
}: {
  value: PasswordGeneratorDefaults;
  onChange: (next: PasswordGeneratorDefaults) => void;
}) {
  const [preview, setPreview] = useState<string>('');

  const regenerate = useCallback(() => {
    setPreview(generatePassword(value));
  }, [value]);

  useEffect(() => {
    regenerate();
  }, [regenerate]);

  const setField = <K extends keyof PasswordGeneratorDefaults>(
    k: K,
    v: PasswordGeneratorDefaults[K],
  ) => onChange({ ...value, [k]: v });

  const applyPreset = (preset: PasswordGeneratorPreset) =>
    onChange({ preset, ...PASSWORD_GENERATOR_PRESET_DEFAULTS[preset] });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div
        role="radiogroup"
        aria-label="Generator preset"
        style={{
          display: 'inline-flex',
          padding: 3,
          gap: 2,
          background: 'var(--panel-2)',
          border: '1px solid var(--line-2)',
          borderRadius: 8,
          alignSelf: 'flex-start',
        }}
      >
        {passwordGeneratorPresetValues.map((p) => {
          const active = p === value.preset;
          return (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => applyPreset(p)}
              style={{
                padding: '6px 12px',
                borderRadius: 5,
                fontSize: 12,
                fontWeight: 500,
                color: active ? 'var(--text)' : 'var(--muted)',
                background: active ? 'var(--elev)' : 'transparent',
                border: '1px solid',
                borderColor: active ? 'var(--line-3)' : 'transparent',
                cursor: 'pointer',
                transition:
                  'background 120ms ease, color 120ms ease, border-color 120ms ease',
              }}
            >
              {GENERATOR_PRESET_LABELS[p]}
            </button>
          );
        })}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 16,
        }}
      >
        <Field
          label="Minimum length"
          help={`Current floor: ${value.length} chars.`}
        >
          <input
            type="range"
            min={8}
            max={48}
            value={value.length}
            onChange={(e) => setField('length', Number(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--accent)' }}
          />
        </Field>
        <Field
          label="Number of words"
          help={`Current: ${value.words} words.`}
        >
          <input
            type="range"
            min={2}
            max={8}
            value={value.words}
            onChange={(e) => setField('words', Number(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--accent)' }}
          />
        </Field>
      </div>

      <Field label="Separator">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {passwordGeneratorSeparatorValues.map((s) => {
            const active = s === value.separator;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setField('separator', s)}
                style={{
                  padding: '5px 12px',
                  borderRadius: 16,
                  fontSize: 12,
                  fontFamily:
                    s === 'none' || s === 'space'
                      ? 'var(--font-sans)'
                      : 'var(--font-mono)',
                  color: active ? 'var(--accent-fill-ink)' : 'var(--muted)',
                  background: active ? 'var(--accent-fill)' : 'var(--panel-2)',
                  border: '1px solid',
                  borderColor: active ? 'var(--accent-fill)' : 'var(--line-2)',
                  cursor: 'pointer',
                  minWidth: 36,
                  textAlign: 'center',
                }}
              >
                {GENERATOR_SEPARATOR_LABELS[s]}
              </button>
            );
          })}
        </div>
      </Field>

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
            color: 'var(--text)',
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <input
            type="checkbox"
            checked={value.alternateCase}
            onChange={(e) => setField('alternateCase', e.target.checked)}
          />
          Alternate case
        </label>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
            color: 'var(--text)',
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <input
            type="checkbox"
            checked={value.includeNumber}
            onChange={(e) => setField('includeNumber', e.target.checked)}
          />
          Include a number
        </label>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: 12,
          background: 'var(--panel-2)',
          border: '1px solid var(--line-2)',
          borderRadius: 6,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--muted)',
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
          }}
        >
          Sample
        </span>
        <span
          style={{
            flex: 1,
            fontFamily:
              'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace',
            fontSize: 13,
            color: 'var(--text)',
            overflowX: 'auto',
            whiteSpace: 'nowrap',
            userSelect: 'all',
          }}
        >
          {preview || '\u00a0'}
        </span>
        <button
          type="button"
          onClick={regenerate}
          title="Regenerate sample"
          aria-label="Regenerate sample"
          style={{
            width: 28,
            height: 28,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px solid var(--line-2)',
            background: 'var(--elev)',
            borderRadius: 5,
            color: 'var(--muted)',
            cursor: 'pointer',
          }}
        >
          <Icon.refresh size={14} />
        </button>
      </div>
    </div>
  );
}
