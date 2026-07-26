import { useEffect, useState } from 'react';
import {
  PASSWORD_GENERATOR_PRESET_DEFAULTS,
  type PasswordGeneratorDefaults,
  type PasswordGeneratorPreset,
  type PasswordGeneratorSeparator,
} from '@weavestream/shared';
import { generatePassword } from '@weavestream/shared/browser';
import { Icon } from '../../components/Icon';
import { Sheet } from '../../components/Sheet';
import { Button, Chip, SectionLabel } from '../../components/primitives';
import { useGeneratorDefaults } from './queries';

const PRESET_LABEL: Record<PasswordGeneratorPreset, string> = {
  say: 'Say',
  read: 'Read',
  remember: 'Remember',
};

const SEPARATOR_LABEL: Record<PasswordGeneratorSeparator, string> = {
  space: 'space',
  hyphen: '-',
  underscore: '_',
  dot: '.',
  none: 'none',
};

/**
 * The passphrase generator as a bottom sheet — desktop's popover
 * (`password-generator-popover.tsx`) re-laid for touch, driving the
 * SAME promoted `generatePassword`. Knobs seed from the workspace
 * defaults (`GET /settings`, shared fallback offline); switching
 * preset reseeds them from the per-preset recommendations, matching
 * desktop. The plaintext exists only in local state until "Use this
 * password" hands it to the form.
 */
export function GeneratorSheet({
  open,
  onClose,
  onUse,
}: {
  open: boolean;
  onClose: () => void;
  onUse: (password: string) => void;
}) {
  const defaults = useGeneratorDefaults();
  const [opts, setOpts] = useState<PasswordGeneratorDefaults>(defaults);
  const [preview, setPreview] = useState('');

  // Reseed from workspace defaults on every opening — a half-tweaked
  // knob set from the previous visit is not a preference.
  useEffect(() => {
    if (open) {
      setOpts(defaults);
      setPreview(generatePassword(defaults));
    }
    // `defaults` is a stable parse of the settings query; regenerating
    // when it refines from fallback → server values while open is fine.
  }, [open, defaults]);

  function update(patch: Partial<PasswordGeneratorDefaults>) {
    setOpts((prev) => {
      const next = { ...prev, ...patch };
      setPreview(generatePassword(next));
      return next;
    });
  }

  function selectPreset(preset: PasswordGeneratorPreset) {
    const next = { preset, ...PASSWORD_GENERATOR_PRESET_DEFAULTS[preset] };
    setOpts(next);
    setPreview(generatePassword(next));
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Generate password"
      footer={
        <Button kind="primary" onClick={() => onUse(preview)} disabled={!preview}>
          Use this password
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Preset segmented control */}
        <div className="flex gap-1 rounded-field bg-panel p-1" role="radiogroup" aria-label="Preset">
          {(Object.keys(PRESET_LABEL) as PasswordGeneratorPreset[]).map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={opts.preset === p}
              onClick={() => selectPreset(p)}
              className={
                'h-10 flex-1 rounded-seg text-[15px] font-medium ' +
                (opts.preset === p
                  ? 'bg-surface text-text shadow-seg'
                  : 'text-muted active:bg-panel-2')
              }
            >
              {PRESET_LABEL[p]}
            </button>
          ))}
        </div>

        {/* Preview */}
        <div className="flex items-center gap-2 rounded-field border border-line bg-surface p-4">
          <span className="min-w-0 flex-1 break-all font-mono text-[17px] text-text">
            {preview}
          </span>
          <button
            type="button"
            aria-label="Generate another"
            onClick={() => setPreview(generatePassword(opts))}
            className="flex h-tap w-11 shrink-0 items-center justify-center rounded-pill bg-panel text-text-2 active:bg-panel-2"
          >
            <Icon name="refresh" size={21} />
          </button>
        </div>

        {/* Knobs */}
        <label className="flex flex-col gap-1.5">
          <span className="flex justify-between font-mono text-section uppercase tracking-[0.1em] text-muted">
            Minimum length <span>{opts.length}</span>
          </span>
          <input
            type="range"
            min={8}
            max={48}
            value={opts.length}
            onChange={(e) => update({ length: Number(e.target.value) })}
            className="h-tap w-full accent-accent"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="flex justify-between font-mono text-section uppercase tracking-[0.1em] text-muted">
            Words <span>{opts.words}</span>
          </span>
          <input
            type="range"
            min={2}
            max={8}
            value={opts.words}
            onChange={(e) => update({ words: Number(e.target.value) })}
            className="h-tap w-full accent-accent"
          />
        </label>

        <div className="flex flex-col gap-2">
          <SectionLabel>Separator</SectionLabel>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(SEPARATOR_LABEL) as PasswordGeneratorSeparator[]).map(
              (s) => (
                <Chip
                  key={s}
                  active={opts.separator === s}
                  onClick={() => update({ separator: s })}
                >
                  {SEPARATOR_LABEL[s]}
                </Chip>
              ),
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Chip
            active={opts.alternateCase}
            onClick={() => update({ alternateCase: !opts.alternateCase })}
          >
            Capitalize words
          </Chip>
          <Chip
            active={opts.includeNumber}
            onClick={() => update({ includeNumber: !opts.includeNumber })}
          >
            Include a number
          </Chip>
        </div>
      </div>
    </Sheet>
  );
}
