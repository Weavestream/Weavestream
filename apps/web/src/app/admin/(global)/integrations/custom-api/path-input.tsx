'use client';

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { CustomApiTestKey } from '@weavestream/shared';
import { Field, Input } from '../../../../../components/ui';
import { canonicalPath } from './definition-draft';

type PathTarget = {
  /** Called by a path input when it gets focus. */
  focus: (write: (path: string) => void) => void;
  /** Writes a path into the last focused path input; false when none was focused. */
  write: (path: string) => boolean;
};

/**
 * The last path input the admin focused. A click on a key in a Test key
 * list writes that key's path into it (the click itself moves focus to
 * the key button, so "the input that has focus" is the last one).
 */
const PathTargetContext = createContext<PathTarget | null>(null);

export function PathTargetProvider({ children }: { children: ReactNode }) {
  const lastRef = useRef<((path: string) => void) | null>(null);
  const value = useMemo<PathTarget>(
    () => ({
      focus: (write) => {
        lastRef.current = write;
      },
      write: (path) => {
        if (!lastRef.current) return false;
        lastRef.current(path);
        return true;
      },
    }),
    [],
  );
  return <PathTargetContext.Provider value={value}>{children}</PathTargetContext.Provider>;
}

/** Writes a path into the last focused path input; false when none was focused. */
export function usePathTarget(): (path: string) => boolean {
  const target = useContext(PathTargetContext);
  return (path) => target?.write(path) ?? false;
}

/** The Test sample for a path, from the first record's key list. */
export function sampleFor(keys: CustomApiTestKey[] | undefined, path: string): string | null | undefined {
  if (!keys || !path) return undefined;
  const wanted = canonicalPath(path);
  if (!wanted) return undefined;
  const key = keys.find((k) => k.path === wanted);
  if (!key) return null;
  return key.masked ? '••••' : (key.sample ?? 'null');
}

export function PathInput({
  id,
  label,
  value,
  onChange,
  error,
  help,
  placeholder,
  sample,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  error?: string;
  help?: string;
  placeholder?: string;
  /** The value Test found at this path: undefined before a Test, null when the path found nothing. */
  sample?: string | null;
}) {
  const target = useContext(PathTargetContext);
  // The key list may write into this input long after it was focused:
  // always call the latest onChange, which sees the latest draft.
  const latestRef = useRef(onChange);
  useEffect(() => {
    latestRef.current = onChange;
  });
  const hint =
    sample === undefined
      ? help
      : sample === null
        ? 'Test found no value at this path in the first record.'
        : `First record: ${sample}`;
  return (
    <Field label={label} htmlFor={id} error={error} help={hint}>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        style={{ fontFamily: 'var(--font-mono)' }}
        onFocus={() => {
          target?.focus((path) => latestRef.current(path));
        }}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}
