'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  AiProbeResult,
  AiProvider,
  AiReasoningEffort,
  AiSettings,
  AiTestResult,
} from '@weavestream/shared';
import { problemMessage } from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import {
  Btn,
  Field,
  Input,
  Select,
  ShowMore,
  Tag,
  useToast,
} from '../../../../components/ui';

type ModelEntry = AiTestResult['models'][number];

const PROVIDERS: Array<{ value: AiProvider; label: string; urlPlaceholder: string }> = [
  { value: 'openai', label: 'OpenAI', urlPlaceholder: 'https://api.openai.com/v1' },
  { value: 'anthropic', label: 'Anthropic', urlPlaceholder: 'https://api.anthropic.com/v1' },
  {
    value: 'openai_compatible',
    label: 'OpenAI-compatible (Ollama, LM Studio, vLLM, routers)',
    urlPlaceholder: 'http://localhost:11434/v1',
  },
];

const REASONING: Array<{ value: AiReasoningEffort; label: string }> = [
  { value: 'default', label: 'Provider default' },
  { value: 'off', label: 'Off / lowest' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

/** Below this, a reasoning model can spend the whole reply budget on thinking. */
const REASONING_OUTPUT_HINT_TOKENS = 16_384;
/** Mirrors the API's DEFAULT_MAX_OUTPUT_TOKENS for a blank field. */
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

export function AiSettingsForm({ initial }: { initial: AiSettings }) {
  const toast = useToast();
  const baseline = useRef(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [provider, setProvider] = useState<AiProvider>(initial.provider);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [defaultModel, setDefaultModel] = useState(initial.defaultModel ?? '');
  const [backgroundModel, setBackgroundModel] = useState(initial.backgroundModel ?? '');
  const [reasoningEffort, setReasoningEffort] = useState<AiReasoningEffort>(
    initial.reasoningEffort,
  );
  const [workspaceId, setWorkspaceId] = useState(initial.anthropicWorkspaceId ?? '');
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    initial.maxOutputTokens != null ? String(initial.maxOutputTokens) : '',
  );
  const [contextWindowTokens, setContextWindowTokens] = useState(
    initial.contextWindowTokens != null
      ? String(initial.contextWindowTokens)
      : '',
  );
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(
    initial.allowPrivateNetwork,
  );
  const [autoSummaries, setAutoSummaries] = useState(initial.autoSummaries);
  const [models, setModels] = useState<ModelEntry[] | null>(null);
  const [probe, setProbe] = useState<AiProbeResult | null>(null);
  const [pending, setPending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Discovered model list is tied to the *saved* baseUrl/key — invalidate
  // it whenever the user edits either field so a stale dropdown can't
  // claim to know what the new endpoint will return.
  useEffect(() => {
    setModels(null);
    setProbe(null);
  }, [baseUrl, apiKey, clearApiKey, provider, workspaceId]);

  const dirty =
    enabled !== baseline.current.enabled ||
    provider !== baseline.current.provider ||
    clean(baseUrl) !== baseline.current.baseUrl ||
    clean(defaultModel) !== baseline.current.defaultModel ||
    clean(backgroundModel) !== baseline.current.backgroundModel ||
    reasoningEffort !== baseline.current.reasoningEffort ||
    clean(workspaceId) !== baseline.current.anthropicWorkspaceId ||
    numOrNull(maxOutputTokens) !== baseline.current.maxOutputTokens ||
    numOrNull(contextWindowTokens) !== baseline.current.contextWindowTokens ||
    allowPrivateNetwork !== baseline.current.allowPrivateNetwork ||
    autoSummaries !== baseline.current.autoSummaries ||
    apiKey.length > 0 ||
    clearApiKey;

  async function save() {
    setError(null);
    setPending(true);
    const payload: Record<string, unknown> = {
      enabled,
      provider,
      baseUrl: clean(baseUrl),
      defaultModel: clean(defaultModel),
      backgroundModel: clean(backgroundModel),
      reasoningEffort,
      anthropicWorkspaceId: clean(workspaceId),
      maxOutputTokens: numOrNull(maxOutputTokens),
      contextWindowTokens: numOrNull(contextWindowTokens),
      allowPrivateNetwork,
      autoSummaries,
    };
    if (apiKey) payload.apiKey = apiKey;
    if (clearApiKey) payload.clearApiKey = true;

    const res = await apiFetch<AiSettings>('/settings/ai', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    setPending(false);
    if (!res.ok || !res.data) {
      setError(problemMessage(res.problem) ?? 'Could not save AI settings.');
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
    // changes, so they can verify before committing. When no key is typed,
    // the endpoint falls back to the saved key only if the base URL still
    // matches the saved one; a changed URL must bring its own key.
    const payload: Record<string, unknown> = {};
    const url = clean(baseUrl);
    if (url) payload.baseUrl = url;
    if (apiKey) payload.apiKey = apiKey;
    // Always send the checkbox state and provider so an unsaved change is
    // honoured by the test (the server treats any provided field as an
    // override).
    payload.allowPrivateNetwork = allowPrivateNetwork;
    payload.provider = provider;
    const ws = clean(workspaceId);
    if (ws && provider === 'anthropic') payload.anthropicWorkspaceId = ws;
    // The reply check uses the selected model; without one it is skipped.
    const model = clean(defaultModel);
    if (model) payload.model = model;
    const res = await apiFetch<AiTestResult>('/settings/ai/test', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setTesting(false);
    if (!res.ok || !res.data) {
      setModels(null);
      setProbe(null);
      setError(problemMessage(res.problem) ?? 'Could not reach the LLM endpoint.');
      return;
    }
    setModels(res.data.models);
    setProbe(res.data.probe);
    if (!defaultModel && res.data.models[0]) {
      setDefaultModel(res.data.models[0].id);
    }
    toast.push(`Connected — ${res.data.models.length} model${res.data.models.length === 1 ? '' : 's'} found.`, 'ok');
  }

  function reset() {
    const b = baseline.current;
    setEnabled(b.enabled);
    setProvider(b.provider);
    setBaseUrl(b.baseUrl ?? '');
    setApiKey('');
    setClearApiKey(false);
    setDefaultModel(b.defaultModel ?? '');
    setBackgroundModel(b.backgroundModel ?? '');
    setReasoningEffort(b.reasoningEffort);
    setWorkspaceId(b.anthropicWorkspaceId ?? '');
    setMaxOutputTokens(b.maxOutputTokens != null ? String(b.maxOutputTokens) : '');
    setContextWindowTokens(
      b.contextWindowTokens != null ? String(b.contextWindowTokens) : '',
    );
    setAllowPrivateNetwork(b.allowPrivateNetwork);
    setAutoSummaries(b.autoSummaries);
    setModels(null);
    setProbe(null);
    setError(null);
  }

  const hasDiscoveredModels = models !== null && models.length > 0;
  const providerInfo = PROVIDERS.find((p) => p.value === provider) ?? PROVIDERS[2]!;
  const effectiveMaxOutput = numOrNull(maxOutputTokens) ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const showOutputHint =
    (reasoningEffort !== 'off' || provider === 'anthropic') &&
    effectiveMaxOutput < REASONING_OUTPUT_HINT_TOKENS;

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
        label="Provider"
        htmlFor="ai-provider"
        help="Decides how Weavestream talks to the endpoint. Use OpenAI-compatible for local servers and routers."
      >
        <Select
          id="ai-provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value as AiProvider)}
        >
          {PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Base URL"
        htmlFor="ai-base-url"
        help="Root URL of the endpoint. Include the /v1 suffix."
      >
        <Input
          id="ai-base-url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={providerInfo.urlPlaceholder}
          maxLength={2048}
          autoComplete="off"
        />
      </Field>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
            checked={allowPrivateNetwork}
            onChange={(e) => setAllowPrivateNetwork(e.target.checked)}
          />
          Allow private-network addresses (local Ollama, LM Studio, LAN servers)
        </label>
        {allowPrivateNetwork && (
          <div
            style={{
              fontSize: 12.5,
              lineHeight: 1.5,
              color: 'var(--warn)',
              background: 'var(--warn-soft)',
              border: '1px solid var(--warn)',
              borderRadius: 6,
              padding: '8px 12px',
            }}
          >
            This relaxes server-side request protections so the AI endpoint may
            resolve to loopback or LAN addresses. Only enable it if the LLM
            server is on a network you control. Link-local and cloud-metadata
            addresses remain blocked.
          </div>
        )}
      </div>

      {/* Separate explicit opt-in, default OFF (CLAUDE.md §7): enabling
          AI chat must never silently start proactive article egress. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
            checked={autoSummaries}
            onChange={(e) => setAutoSummaries(e.target.checked)}
          />
          Use AI to create auto summaries
        </label>
        <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--muted)' }}>
          Sends article titles and content to your configured AI endpoint
          whenever articles are created or edited. Summaries appear in article
          lists; articles without one show a plain excerpt. Existing articles
          are not summarized until their next edit.
        </div>
      </div>

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
        <ModelPicker
          id="ai-default-model"
          value={defaultModel}
          onChange={setDefaultModel}
          models={models}
          emptyLabel="— None —"
          placeholder="llama3:latest"
        />
      </Field>

      <Field
        label="Background model"
        htmlFor="ai-background-model"
        help="Used for chat titles, the short line shown before an article proposal, and article summaries. Leave empty to use the default model."
      >
        <ModelPicker
          id="ai-background-model"
          value={backgroundModel}
          onChange={setBackgroundModel}
          models={models}
          emptyLabel="— Same as default model —"
          placeholder="Same as default model"
        />
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

      {showOutputHint && (
        <Tag tone="warn" style={{ alignSelf: 'flex-start', whiteSpace: 'normal' }}>
          Reasoning models spend output tokens on thinking; 16k or more avoids
          cut-off tool calls.
        </Tag>
      )}

      <ShowMore moreLabel="Advanced" lessLabel="Hide advanced">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 16,
          }}
        >
          <Field
            label="Reasoning effort"
            htmlFor="ai-reasoning-effort"
            help="How much the default model reasons in chat. Provider default sends no setting. Others apply only where the model supports them; titles and summaries always use the lowest setting."
          >
            <Select
              id="ai-reasoning-effort"
              value={reasoningEffort}
              onChange={(e) => setReasoningEffort(e.target.value as AiReasoningEffort)}
            >
              {REASONING.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>

          {provider === 'anthropic' && (
            <Field
              label="Anthropic workspace ID"
              htmlFor="ai-anthropic-workspace"
              help="Only needed for keys that are not scoped to a workspace."
            >
              <Input
                id="ai-anthropic-workspace"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                placeholder="wrkspc_…"
                maxLength={128}
                autoComplete="off"
              />
            </Field>
          )}
        </div>
      </ShowMore>

      <section
        style={{
          padding: 14,
          background: 'var(--panel-2)',
          border: '1px solid var(--line-2)',
          borderRadius: 6,
          fontSize: 13,
          lineHeight: 1.5,
          color: 'var(--text-2)',
        }}
      >
        AI chat sends conversation text and attached context to the endpoint
        configured here — including article content, asset field values,
        domain details, and ticket bodies with internal notes. Choose a
        provider you trust to handle this data; Weavestream does not proxy or
        filter these requests.
      </section>

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
                : 'Lists the available models, then sends one short prompt to the default model.'}
          {probe && (
            <div style={{ marginTop: 6 }}>
              <Tag tone={probe.status === 'ok' ? 'ok' : probe.status === 'skipped' ? 'default' : 'warn'}>
                {probeMessage(probe)}
              </Tag>
            </div>
          )}
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

function ModelPicker({
  id,
  value,
  onChange,
  models,
  emptyLabel,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  models: ModelEntry[] | null;
  emptyLabel: string;
  placeholder: string;
}) {
  if (models && models.length > 0) {
    return (
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{emptyLabel}</option>
        {/* Keep a saved model the list no longer reports selectable. */}
        {value && !models.some((m) => m.id === value) && (
          <option value={value}>{value}</option>
        )}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label ? `${m.label} (${m.id})` : m.id}
          </option>
        ))}
      </Select>
    );
  }
  return (
    <Input
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      maxLength={120}
      autoComplete="off"
    />
  );
}

/** Fixed server codes only (`AiProbeResult.reason`) — never upstream text. */
function probeMessage(probe: AiProbeResult): string {
  if (probe.status === 'ok') return 'Test reply OK.';
  if (probe.status === 'skipped') return 'Select a model, then test again to check a reply.';
  const reason = probe.reason ?? '';
  if (reason === 'empty') return 'The model replied with no text.';
  if (reason === 'truncated') return 'The model used its whole budget before replying.';
  if (reason === 'refused') return 'The model declined the test prompt.';
  if (reason === 'timeout') return 'The model did not reply in time.';
  if (reason === 'invalid-response') return 'The endpoint sent a reply that was not valid JSON.';
  if (reason === 'transport') return 'Could not reach the endpoint for the test reply.';
  if (reason.startsWith('http:')) return `Test reply failed: ${reason.slice(5)}.`;
  return 'Test reply failed.';
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
