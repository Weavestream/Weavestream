'use client';

import {
  forwardRef,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type InputHTMLAttributes,
} from 'react';
import type { PasswordGeneratorDefaults } from '@weavestream/shared';
import { Input, Icon } from '../ui';
import { PasswordGeneratorPopover } from './password-generator-popover';

export interface SecretInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /**
   * When true, render an inline eye toggle that temporarily strips the
   * `-webkit-text-security` style so the user can eyeball the value
   * they just typed or pasted. We deliberately never flip `type` to
   * `password` — doing so would trigger Safari's "save this password?"
   * and password-manager autosave flows, which is the exact hostile
   * behaviour this component was built to avoid.
   */
  allowReveal?: boolean;
  /**
   * When provided, render an inline generator button that opens a
   * popover seeded with these defaults. The popover calls
   * `onGenerate(plaintext)` with the final value; the parent is
   * responsible for forwarding that value into its controlled state
   * (typically via the same setter driving the `value` prop).
   */
  generatorDefaults?: PasswordGeneratorDefaults;
  onGenerate?: (value: string) => void;
}

/**
 * A masked text input that renders as `type="text"` but visually looks
 * like a password field (via `-webkit-text-security: disc`).
 *
 * Why: Safari/iCloud Keychain, 1Password, LastPass, Bitwarden and co.
 * all detect `type="password"` inputs and pop "save this password?"
 * prompts. Inside our credentials vault that prompt is hostile — the
 * user doesn't want their browser to vault a password they just saved
 * to Weavestream. Using `type="text"` with `-webkit-text-security`
 * keeps the dots in the UI but stops the browsers' heuristics from
 * firing. We also stamp common ignore attributes (`autoComplete=off`,
 * `data-lpignore`, `data-1p-ignore`, `data-bwignore`) for the
 * manager-specific opt-outs.
 *
 * Two optional props layer on top of that baseline:
 *   - `allowReveal`         → eye-toggle that strips text-security so
 *                             the user can verify what they typed before
 *                             saving. `type` is never mutated.
 *   - `generatorDefaults` + `onGenerate` → wand button that opens the
 *                             passphrase generator popover.
 */
export const SecretInput = forwardRef<HTMLInputElement, SecretInputProps>(
  function SecretInput(
    {
      style,
      name,
      allowReveal,
      generatorDefaults,
      onGenerate,
      ...rest
    },
    ref,
  ) {
    // A stable but unique name keeps browsers from trying to correlate
    // the field with a remembered credential set.
    const fallbackId = useId();
    const [revealed, setRevealed] = useState(false);
    const [genOpen, setGenOpen] = useState(false);
    const anchorRef = useRef<HTMLDivElement | null>(null);

    const hasToolbar =
      Boolean(allowReveal) || Boolean(generatorDefaults && onGenerate);
    // Reserve ~32px per toolbar button so the rendered dots don't slide
    // under the eye/wand icons. 10px default right pad + 26px per slot.
    const reservedRight = hasToolbar
      ? 10 +
        (allowReveal ? 26 : 0) +
        (generatorDefaults && onGenerate ? 26 : 0)
      : 10;

    const secretStyle: CSSProperties = {
      fontFamily:
        'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace',
      letterSpacing: revealed ? 0 : 2,
      paddingRight: reservedRight,
      ...style,
    };
    if (!revealed) {
      (secretStyle as unknown as Record<string, string>).WebkitTextSecurity =
        'disc';
      (secretStyle as unknown as Record<string, string>).textSecurity = 'disc';
    }

    const input = (
      <Input
        ref={ref}
        type="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-lpignore="true"
        data-1p-ignore=""
        data-bwignore=""
        data-form-type="other"
        name={name ?? `ws-secret-${fallbackId}`}
        style={secretStyle}
        {...rest}
      />
    );

    if (!hasToolbar) return input;

    return (
      <div ref={anchorRef} style={{ position: 'relative' }}>
        {input}
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: 4,
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 2,
          }}
        >
          {allowReveal && (
            <ToolButton
              aria-label={revealed ? 'Hide password' : 'Show password'}
              title={revealed ? 'Hide' : 'Reveal'}
              onClick={() => setRevealed((v) => !v)}
            >
              {revealed ? <Icon.eyeOff size={14} /> : <Icon.eye size={14} />}
            </ToolButton>
          )}
          {generatorDefaults && onGenerate && (
            <ToolButton
              aria-label="Generate a password"
              title="Generate"
              onClick={() => setGenOpen((v) => !v)}
              active={genOpen}
            >
              <Icon.sparkles size={14} />
            </ToolButton>
          )}
        </div>
        {generatorDefaults && onGenerate && genOpen && (
          <PasswordGeneratorPopover
            defaults={generatorDefaults}
            onUse={(value) => {
              onGenerate(value);
              setGenOpen(false);
            }}
            onClose={() => setGenOpen(false)}
          />
        )}
      </div>
    );
  },
);

function ToolButton({
  children,
  onClick,
  title,
  active,
  'aria-label': ariaLabel,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
  'aria-label': string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      tabIndex={-1}
      style={{
        width: 24,
        height: 24,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 0,
        background: active ? 'var(--line-2)' : 'transparent',
        borderRadius: 4,
        color: active ? 'var(--text)' : 'var(--muted)',
        cursor: 'pointer',
        padding: 0,
        transition: 'color 120ms ease, background 120ms ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = 'var(--text)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = active
          ? 'var(--text)'
          : 'var(--muted)';
      }}
    >
      {children}
    </button>
  );
}
