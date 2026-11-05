'use client';

import { useState } from 'react';
import { CUSTOM_API_LIMITS, customApiDefinitionSchema } from '@weavestream/shared';
import { Btn, Dialog, Field, Textarea } from '../../../../../components/ui';
import type { CustomApiDraft } from './definition-draft';

type ParseResult = { ok: true; definition: CustomApiDraft } | { ok: false; errors: string[] };

/**
 * Parses an imported definition in the browser with the shared schema.
 * Returns the file's own JSON (not the parsed output with defaults), so
 * what is saved is what the admin imported. Nothing is saved here.
 */
export function parseDefinitionImport(text: string): ParseResult {
  if (new TextEncoder().encode(text).byteLength > CUSTOM_API_LIMITS.definitionBytes) {
    return { ok: false, errors: ['The file is larger than 64 KiB.'] };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['This is not valid JSON.'] };
  }
  const parsed = customApiDefinitionSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) =>
        issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
      ),
    };
  }
  return { ok: true, definition: json as CustomApiDraft };
}

/** `File.text()`, with a `FileReader` fallback for older engines (jsdom). */
function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsText(file);
  });
}

/** Paste or pick a definition file; a valid one is handed to `onImport`. */
export function ImportDefinitionForm({
  onImport,
  onCancel,
}: {
  onImport: (definition: CustomApiDraft) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  async function pickFile(file: File | undefined) {
    if (!file) return;
    if (file.size > CUSTOM_API_LIMITS.definitionBytes) {
      setErrors(['The file is larger than 64 KiB.']);
      return;
    }
    try {
      setText(await readText(file));
      setErrors([]);
    } catch {
      setErrors(['Could not read the file.']);
    }
  }

  function submit() {
    const result = parseDefinitionImport(text);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    onImport(result.definition);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Field label="Definition file" htmlFor="ca-import-file">
        <input
          id="ca-import-file"
          type="file"
          accept="application/json,.json"
          onChange={(e) => void pickFile(e.target.files?.[0])}
          style={{ fontSize: 12.5 }}
        />
      </Field>
      <Field label="Or paste the definition" htmlFor="ca-import-text" help="JSON, at most 64 KiB. It holds no secrets: enter the credentials yourself.">
        <Textarea
          id="ca-import-text"
          rows={8}
          value={text}
          spellCheck={false}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      {errors.length > 0 && (
        <ul role="alert" style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--danger)' }}>
          {errors.slice(0, 20).map((error, index) => (
            <li key={index}>{error}</li>
          ))}
          {errors.length > 20 && <li>{errors.length - 20} more problems.</li>}
        </ul>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <Btn kind="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Btn>
        <Btn kind="primary" size="sm" onClick={submit} disabled={text.trim() === ''}>
          Import
        </Btn>
      </div>
    </div>
  );
}

/** Import on the Credentials tab: fills the form. The admin still selects Save changes. */
export function ImportDefinitionDialog({
  open,
  onClose,
  onImport,
}: {
  open: boolean;
  onClose: () => void;
  onImport: (definition: CustomApiDraft) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title="Import definition" width={560}>
      {open && (
        <ImportDefinitionForm
          onCancel={onClose}
          onImport={(definition) => {
            onImport(definition);
            onClose();
          }}
        />
      )}
    </Dialog>
  );
}
