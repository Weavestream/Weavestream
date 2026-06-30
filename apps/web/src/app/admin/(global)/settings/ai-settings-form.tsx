'use client';

import { useEffect, useRef, useState } from 'react';
import type { AiSettings } from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import { Btn, Field, Input, Select, Tag, useToast } from '../../../../components/ui';

export function AiSettingsForm({ initial }: { initial: AiSettings }) {
  const toast = useToast();
  const baseline = useRef(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [defaultModel, setDefaultModel] = useState(initial.defaultModel ?? '');
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    initial.maxOutputTokens != null ? String(initial.maxOutputTokens) : '',
  );
  const [contextWindowTokens, setContextWindowTokens] = useState(
    initial.contextWindowTokens != null
      ? String(initial.contextWindowTokens)
      : '',
  );
  const [models, setModels] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Discovered model list is tied to the *saved* baseUrl/key — invalidate
  // it whenever the user edits either field so a stale dropdown can't
  // claim to know what the new endpoint will return.
  useEffect(() => {
    setModels(null);
  }, [baseUrl, apiKey, clearApiKey]);

  const dirty =
    enabled !== baseline.current.enabled ||
    clean(baseUrl) !== baseline.current.baseUrl ||
    clean(defaultModel) !== baseline.current.defaultModel ||
    numOrNull(maxOutputTokens) !== baseline.current.maxOutputTokens ||
    numOrNull(contextWindowTokens) !== baseline.current.contextWindowTokens ||
    apiKey.length > 0 ||
    clearApiKey;

  async function save() {
    setError(null);
    setPending(true);
    const payload: Record<string, unknown> = {
      enabled,
      baseUrl: clean(baseUrl),
      defaultModel: clean(defaultModel),
      maxOutputTokens: numOrNull(maxOutputTokens),
      contextWindowTokens: numOrNull(contextWindowTokens),
    };
    if (apiKey) payload.apiKey = apiKey;
    if (clearApiKey) payload.clearApiKey = true;

    const res = await apiFetch<AiSettings>('/settings/ai', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    setPending(false);
    if (!res.ok || !res.data) {
      setError(problemText(res.problem, 'Could not save AI settings.'));
      return;
    }
    baseline.current = res.data;
    setApiKey('');
    setClearApiKey(false);
    toast.push('AI settings saved.', 'ok');
  }

  async function testConnection() {
    setError(null);
    setTesting(true);
    // Test against the in-flight form values when the user has unsaved
    // changes, so they can verify before committing. The endpoint falls
    // back to the saved (decrypted) API key when none is typed.
    const payload: Record<string, unknown> = {};
    const url = clean(baseUrl);
    if (url) payload.baseUrl = url;
    if (apiKey) payload.apiKey = apiKey;
    const res = await apiFetch<{ ok: true; models: string[] }>('/settings/ai/test', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setTesting(false);
    if (!res.ok || !res.data) {
      setModels(null);
      setError(problemText(res.problem, 'Could not reach the LLM endpoint.'));
      return;
    }
    setModels(res.data.models);
    if (!defaultModel && res.data.models[0]) {
      setDefaultModel(res.data.models[0]);
    }
    toast.push(`Connected — ${res.data.models.length} model${res.data.models.length === 1 ? '' : 's'} found.`, 'ok');
  }

  function reset() {
    const b = baseline.current;
    setEnabled(b.enabled);
    setBaseUrl(b.baseUrl ?? '');
    setApiKey('');
    setClearApiKey(false);
    setDefaultModel(b.defaultModel ?? '');
    setMaxOutputTokens(b.maxOutputTokens != null ? String(b.maxOutputTokens) : '');
    setContextWindowTokens(
      b.contextWindowTokens != null ? String(b.contextWindowTokens) : '',
    );
    setModels(null);
    setError(null);
  }

  const hasDiscoveredModels = models !== null && models.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          color: 'var(--text)',
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Enable AI integration
      </label>

      <Field
        label="Base URL"
        htmlFor="ai-base-url"
        help="Root URL of your OpenAI-compatible endpoint. Include the /v1 suffix."
      >
        <Input
          id="ai-base-url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://localhost:11434/v1"
          maxLength={2048}
          autoComplete="off"
        />
      </Field>

      <Field
        label="API key"
        htmlFor="ai-api-key"
        help={
          baseline.current.apiKeyConfigured
            ? 'API key is configured. Enter a new value to replace it.'
            : 'Optional — leave blank for local servers like Ollama or LMStudio.'
        }
      >
        <Input
          id="ai-api-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="new-password"
          maxLength={1024}
          placeholder={baseline.current.apiKeyConfigured ? 'Configured' : ''}
        />
      </Field>

      {baseline.current.apiKeyConfigured && (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
            color: 'var(--text-2)',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={clearApiKey}
            disabled={apiKey.length > 0}
            onChange={(e) => setClearApiKey(e.target.checked)}
          />
          Clear saved API key
        </label>
      )}

      <Field
        label="Default model"
        htmlFor="ai-default-model"
        help={
          hasDiscoveredModels
            ? 'Pick from the models reported by your endpoint.'
            : 'Run "Test connection" to discover available models, or type a name manually.'
        }
      >
        {hasDiscoveredModels ? (
          <Select
            id="ai-default-model"
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
          >
            <option value="">— None —</option>
            {models!.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            id="ai-default-model"
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            placeholder="llama3:latest"
            maxLength={120}
            autoComplete="off"
          />
        )}
      </Field>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 16,
        }}
      >
        <Field
          label="Max output tokens"
          htmlFor="ai-max-output-tokens"
          help="Ceiling on the model's reply / reserved room for a full article rewrite. Blank uses a safe default."
        >
          <Input
            id="ai-max-output-tokens"
            type="number"
            inputMode="numeric"
            min={256}
            max={200000}
            value={maxOutputTokens}
            onChange={(e) => setMaxOutputTokens(e.target.value)}
            placeholder="8192 (default)"
            autoComplete="off"
          />
        </Field>

        <Field
          label="Context window tokens"
          htmlFor="ai-context-window-tokens"
          help="Total context window of your model; sizes the prompt budget so the reply fits. Blank uses a safe default."
        >
          <Input
            id="ai-context-window-tokens"
            type="number"
            inputMode="numeric"
            min={1024}
            max={2000000}
            value={contextWindowTokens}
            onChange={(e) => setContextWindowTokens(e.target.value)}
            placeholder="32768 (default)"
            autoComplete="off"
          />
        </Field>
      </div>

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto',
          gap: 10,
          alignItems: 'center',
          padding: 14,
          background: 'var(--panel-2)',
          border: '1px solid var(--line-2)',
          borderRadius: 6,
        }}
      >
        <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
          {!enabled
            ? 'Enable AI integration before testing.'
            : !clean(baseUrl)
              ? 'Enter a base URL to test the connection.'
              : dirty
                ? 'Tests with the current form values — save afterwards to keep them.'
                : 'Hits {baseUrl}/models to verify the connection and list available models.'}
        </div>
        <Btn
          kind="outline"
          onClick={testConnection}
          loading={testing}
          disabled={!enabled || !clean(baseUrl)}
        >
          Test connection
        </Btn>
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
        <Btn kind="primary" onClick={save} loading={pending} disabled={!dirty}>
          Save AI settings
        </Btn>
      </div>
    </div>
  );
}

function clean(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Empty input → null (reset to server default); otherwise the parsed
// integer. NaN also collapses to null so a stray "abc" doesn't post.
function numOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function problemText(problem: unknown, fallback: string): string {
  if (problem && typeof problem === 'object') {
    const p = problem as { title?: unknown; detail?: unknown };
    if (typeof p.detail === 'string') return p.detail;
    if (typeof p.title === 'string') return p.title;
  }
  return fallback;
}
