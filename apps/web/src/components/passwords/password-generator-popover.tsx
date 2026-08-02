'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PASSWORD_GENERATOR_PRESET_DEFAULTS,
  passwordGeneratorPresetValues,
  passwordGeneratorSeparatorValues,
  type PasswordGeneratorDefaults,
  type PasswordGeneratorPreset,
  type PasswordGeneratorSeparator,
} from '@weavestream/shared';
import { Btn, Icon, useToast } from '../ui';
import { copyToClipboard } from '@weavestream/shared/browser';
import { generatePassword } from '@weavestream/shared/browser';

/**
 * Passphrase-generator popover anchored inside `SecretInput`.
 *
 * The popover opens pre-seeded with the workspace defaults provided by
 * the nearest admin settings row; changing any knob updates the
 * preview in real time without touching the admin-stored defaults. The
 * generator itself is a pure function — nothing in this popover ever
 * round-trips the plaintext through an API.
 *
 * "Use this password" lifts the preview value up through `onUse`; the
 * parent is expected to mirror it straight into the create/edit
 * dialog's password state.
 */
export function PasswordGeneratorPopover({
  defaults,
  onUse,
  onClose,
}: {
  defaults: PasswordGeneratorDefaults;
  onUse: (value: string) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [opts, setOpts] = useState<PasswordGeneratorDefaults>(defaults);
  const [preview, setPreview] = useState<string>('');
  const containerRef = useRef<HTMLDivElement | null>(null);

  const regenerate = useCallback(() => {
    setPreview(generatePassword(opts));
  }, [opts]);

  useEffect(() => {
    regenerate();
  }, [regenerate]);

  // Close on outside click (but only AFTER the popover has been
  // rendered; useEffect fires post-commit). Also closes on Escape so
  // keyboard users can dismiss without reaching for the mouse.
  useEffect(() => {
    function onDocPointer(e: PointerEvent) {
      if (!containerRef.current) return;
      if (e.target instanceof Node && containerRef.current.contains(e.target))
        return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('pointerdown', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const applyPreset = useCallback((preset: PasswordGeneratorPreset) => {
    setOpts({ preset, ...PASSWORD_GENERATOR_PRESET_DEFAULTS[preset] });
  }, []);

  async function handleCopy() {
    const ok = await copyToClipboard(preview);
    toast.push(ok ? 'Password copied' : 'Clipboard unavailable', ok ? 'ok' : 'danger');
  }

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Password generator"
      style={{
        position: 'absolute',
        top: 'calc(100% + 6px)',
        right: 0,
        zIndex: 30,
        width: 340,
        background: 'var(--panel)',
        border: '1px solid var(--line-2)',
        borderRadius: 8,
        boxShadow:
          '0 4px 14px rgba(0, 0, 0, 0.16), 0 2px 6px rgba(0, 0, 0, 0.08)',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <PresetSelector active={opts.preset} onChange={applyPreset} />

      <PreviewBlock value={preview} onRegenerate={regenerate} onCopy={handleCopy} />

      <Knobs opts={opts} onChange={setOpts} />

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 6,
          borderTop: '1px solid var(--line)',
          paddingTop: 10,
        }}
      >
        <Btn size="sm" kind="ghost" onClick={onClose}>
          Cancel
        </Btn>
        <Btn
          size="sm"
          kind="primary"
          onClick={() => onUse(preview)}
          disabled={preview.length === 0}
        >
          Use this password
        </Btn>
      </div>
    </div>
  );
}

const PRESET_LABELS: Record<PasswordGeneratorPreset, string> = {
  say: 'Easier to say',
  read: 'Easier to read',
  remember: 'Easier to remember',
};

function PresetSelector({
  active,
  onChange,
}: {
  active: PasswordGeneratorPreset;
  onChange: (preset: PasswordGeneratorPreset) => void;
}) {
  return (
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
      }}
    >
      {passwordGeneratorPresetValues.map((p) => {
        const isActive = p === active;
        return (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(p)}
            style={{
              flex: 1,
              padding: '5px 8px',
              borderRadius: 5,
              fontSize: 12,
              fontWeight: 500,
              color: isActive ? 'var(--text)' : 'var(--muted)',
              background: isActive ? 'var(--elev)' : 'transparent',
              border: '1px solid',
              borderColor: isActive ? 'var(--line-3)' : 'transparent',
              cursor: 'pointer',
              transition:
                'background 120ms ease, color 120ms ease, border-color 120ms ease',
            }}
          >
            {PRESET_LABELS[p]}
          </button>
        );
      })}
    </div>
  );
}

function PreviewBlock({
  value,
  onRegenerate,
  onCopy,
}: {
  value: string;
  onRegenerate: () => void;
  onCopy: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: 8,
        background: 'var(--panel-2)',
        border: '1px solid var(--line-2)',
        borderRadius: 6,
      }}
    >
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
        {value || '\u00a0'}
      </span>
      <IconBtn title="Regenerate" onClick={onRegenerate}>
        <Icon.refresh size={14} />
      </IconBtn>
      <IconBtn title="Copy" onClick={onCopy}>
        <Icon.copy size={14} />
      </IconBtn>
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        width: 26,
        height: 26,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px solid var(--line-2)',
        background: 'var(--elev)',
        borderRadius: 5,
        color: 'var(--muted)',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = 'var(--text)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = 'var(--muted)';
      }}
    >
      {children}
    </button>
  );
}

const SEPARATOR_LABELS: Record<PasswordGeneratorSeparator, string> = {
  space: 'space',
  hyphen: '-',
  underscore: '_',
  dot: '.',
  none: 'none',
};

function Knobs({
  opts,
  onChange,
}: {
  opts: PasswordGeneratorDefaults;
  onChange: (next: PasswordGeneratorDefaults) => void;
}) {
  const setField = <K extends keyof PasswordGeneratorDefaults>(
    k: K,
    v: PasswordGeneratorDefaults[K],
  ) => onChange({ ...opts, [k]: v });

  const separatorOptions = useMemo(
    () =>
      passwordGeneratorSeparatorValues.map((s) => ({
        value: s,
        label: SEPARATOR_LABELS[s],
      })),
    [],
  );

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <SliderRow
        label="Minimum length"
        value={opts.length}
        min={8}
        max={48}
        onChange={(v) => setField('length', v)}
      />
      <SliderRow
        label="Number of words"
        value={opts.words}
        min={2}
        max={8}
        onChange={(v) => setField('words', v)}
      />
      <div style={{ display: 'grid', gap: 5 }}>
        <KnobLabel>Separator</KnobLabel>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {separatorOptions.map((o) => {
            const active = o.value === opts.separator;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => setField('separator', o.value)}
                style={{
                  padding: '4px 10px',
                  borderRadius: 14,
                  fontSize: 12,
                  fontFamily:
                    o.value === 'none' || o.value === 'space'
                      ? 'var(--font-sans)'
                      : 'var(--font-mono)',
                  color: active ? 'var(--accent-fill-ink)' : 'var(--muted)',
                  background: active ? 'var(--accent-fill)' : 'var(--panel-2)',
                  border: '1px solid',
                  borderColor: active ? 'var(--accent-fill)' : 'var(--line-2)',
                  cursor: 'pointer',
                  minWidth: 28,
                  textAlign: 'center',
                }}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>
      <CheckRow
        label="Alternate case"
        checked={opts.alternateCase}
        onChange={(v) => setField('alternateCase', v)}
      />
      <CheckRow
        label="Include a number"
        checked={opts.includeNumber}
        onChange={(v) => setField('includeNumber', v)}
      />
    </div>
  );
}

function KnobLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: 'var(--muted)',
        letterSpacing: 0.6,
        textTransform: 'uppercase',
      }}
    >
      {children}
    </span>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: 'grid', gap: 5 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <KnobLabel>{label}</KnobLabel>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--text)',
          }}
        >
          {value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: 'var(--accent)' }}
      />
    </div>
  );
}

function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
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
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
