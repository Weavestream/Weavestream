'use client';

import { useRef, useState } from 'react';
import type {
  AiProbeResult,
  AiProvider,
  AiReasoningEffort,
  AiSettings,
  AiTestResult,
} from '@weavestream/shared';
import {
  AI_CONTEXT_WINDOW_TOKENS_RANGE,
  AI_DEFAULT_CONTEXT_WINDOW_TOKENS,
  AI_DEFAULT_MAX_OUTPUT_TOKENS,
  AI_MAX_OUTPUT_TOKENS_RANGE,
  aiOutputTokenCap,
  problemMessage,
  stripTrailingSlashes,
} from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import {
  Btn,
  Checkbox,
  Icon,
  Field,
  Input,
  Select,
  RadioOption,
  Tag,
  Toggle,
  useToast,
} from '../../../../components/ui';
import styles from './ai-settings-form.module.css';

type ModelEntry = AiTestResult['models'][number];

const PROVIDERS: Array<{
  value: AiProvider;
  label: string;
  hint: string;
  defaultUrl: string;
}> = [
  {
    value: 'openai',
    label: 'OpenAI',
    hint: 'Connect directly to OpenAI',
    defaultUrl: 'https://api.openai.com/v1',
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    hint: 'Connect directly to Anthropic',
    defaultUrl: 'https://api.anthropic.com/v1',
  },
  {
    value: 'openai_compatible',
    label: 'OpenAI-compatible',
    hint: 'Local servers and API routers',
    defaultUrl: '',
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
const TOKEN_STEPS = [
  256, 512, 1_024, 2_048, 4_096, 8_192, 16_384, 32_768, 65_536, 128_000, 200_000, 262_144, 524_288,
  1_000_000, 2_000_000,
];
const TOKEN_FORMATTER = new Intl.NumberFormat('en-US');

export function AiSettingsForm({ initial }: { initial: AiSettings }) {
  const toast = useToast();
  const [baseline, setBaseline] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [provider, setProvider] = useState<AiProvider>(initial.provider);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl ?? '');
  const [customEndpoint, setCustomEndpoint] = useState(hasCustomEndpoint(initial));
  const [advancedOpen, setAdvancedOpen] = useState(hasCustomEndpoint(initial));
  const endpointDrafts = useRef<
    Partial<
      Record<AiProvider, { url: string; custom: boolean; model: string; backgroundModel: string }>
    >
  >({});
  const [editingApiKey, setEditingApiKey] = useState(false);
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
    initial.contextWindowTokens != null ? String(initial.contextWindowTokens) : '',
  );
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(initial.allowPrivateNetwork);
  const [autoSummaries, setAutoSummaries] = useState(initial.autoSummaries);
  const [discovery, setDiscovery] = useState<{
    connection: string;
    models: ModelEntry[];
    probe: AiProbeResult;
    model: string | null;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerInfo = PROVIDERS.find((p) => p.value === provider) ?? PROVIDERS[2]!;
  const effectiveBaseUrl =
    customEndpoint || provider === 'openai_compatible' ? clean(baseUrl) : providerInfo.defaultUrl;

  const connection = JSON.stringify([
    effectiveBaseUrl,
    apiKey,
    clearApiKey,
    provider,
    workspaceId,
    allowPrivateNetwork,
  ]);
  const models = discovery?.connection === connection ? discovery.models : null;
  const probe =
    discovery?.connection === connection && discovery.model === clean(defaultModel)
      ? discovery.probe
      : null;
  const endpointChanged =
    stripTrailingSlashes(effectiveBaseUrl ?? '') !== stripTrailingSlashes(baseline.baseUrl ?? '');
  const missingEndpoint = !effectiveBaseUrl && (enabled || customEndpoint);
  // The server binds the saved key to its endpoint: a new endpoint must
  // bring its own key or remove the saved one.
  const keyNeedsAttention =
    baseline.apiKeyConfigured &&
    endpointChanged &&
    Boolean(effectiveBaseUrl) &&
    !apiKey &&
    !clearApiKey;

  const explicitOutput = numOrNull(maxOutputTokens);
  const explicitContext = numOrNull(contextWindowTokens);
  const requestedOutput = explicitOutput ?? AI_DEFAULT_MAX_OUTPUT_TOKENS;
  const outputCap = aiOutputTokenCap(explicitContext ?? AI_DEFAULT_CONTEXT_WINDOW_TOKENS);
  const effectiveMaxOutput = Math.min(requestedOutput, outputCap);
  // Mirrors the update schema: 2 explicit limits must leave room for a prompt.
  const outputExceedsContext =
    explicitOutput !== null && explicitContext !== null && explicitOutput >= explicitContext;
  const showOutputHint =
    (reasoningEffort !== 'off' || provider === 'anthropic') &&
    effectiveMaxOutput < REASONING_OUTPUT_HINT_TOKENS;
  const saveBlocker = missingEndpoint
    ? 'Enter an endpoint URL to save.'
    : keyNeedsAttention
      ? 'Enter a key for the new endpoint, or remove the saved key.'
      : outputExceedsContext
        ? 'Max output tokens must be less than the context window.'
        : null;

  const dirty =
    enabled !== baseline.enabled ||
    provider !== baseline.provider ||
    endpointChanged ||
    clean(defaultModel) !== baseline.defaultModel ||
    clean(backgroundModel) !== baseline.backgroundModel ||
    reasoningEffort !== baseline.reasoningEffort ||
    clean(workspaceId) !== baseline.anthropicWorkspaceId ||
    numOrNull(maxOutputTokens) !== baseline.maxOutputTokens ||
    numOrNull(contextWindowTokens) !== baseline.contextWindowTokens ||
    allowPrivateNetwork !== baseline.allowPrivateNetwork ||
    autoSummaries !== baseline.autoSummaries ||
    apiKey.length > 0 ||
    clearApiKey;

  async function save() {
    setError(null);
    setPending(true);
    const payload: Record<string, unknown> = {
      enabled,
      provider,
      baseUrl: effectiveBaseUrl,
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
    setBaseline(res.data);
    setApiKey('');
    setClearApiKey(false);
    setEditingApiKey(false);
    if (apiKey || clearApiKey) setDiscovery(null);
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
    const url = effectiveBaseUrl;
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
      setDiscovery(null);
      setError(problemMessage(res.problem) ?? 'Could not reach the LLM endpoint.');
      return;
    }
    setDiscovery({
      connection,
      models: res.data.models,
      probe: res.data.probe,
      model: model ?? res.data.models[0]?.id ?? null,
    });
    if (!defaultModel && res.data.models[0]) {
      setDefaultModel(res.data.models[0].id);
    }
    toast.push(
      `Connected — ${res.data.models.length} model${res.data.models.length === 1 ? '' : 's'} found.`,
      'ok',
    );
  }

  function reset() {
    const b = baseline;
    setEnabled(b.enabled);
    setProvider(b.provider);
    setBaseUrl(b.baseUrl ?? '');
    setCustomEndpoint(hasCustomEndpoint(b));
    setAdvancedOpen(hasCustomEndpoint(b));
    endpointDrafts.current = {};
    setEditingApiKey(false);
    setApiKey('');
    setClearApiKey(false);
    setDefaultModel(b.defaultModel ?? '');
    setBackgroundModel(b.backgroundModel ?? '');
    setReasoningEffort(b.reasoningEffort);
    setWorkspaceId(b.anthropicWorkspaceId ?? '');
    setMaxOutputTokens(b.maxOutputTokens != null ? String(b.maxOutputTokens) : '');
    setContextWindowTokens(b.contextWindowTokens != null ? String(b.contextWindowTokens) : '');
    setAllowPrivateNetwork(b.allowPrivateNetwork);
    setAutoSummaries(b.autoSummaries);
    setDiscovery(null);
    setError(null);
  }

  const hasDiscoveredModels = models !== null && models.length > 0;
  function changeProvider(next: AiProvider) {
    endpointDrafts.current[provider] = {
      url: baseUrl,
      custom: customEndpoint,
      model: defaultModel,
      backgroundModel,
    };
    const draft = endpointDrafts.current[next];
    setProvider(next);
    setBaseUrl(draft?.url ?? '');
    setCustomEndpoint(draft?.custom ?? false);
    setDefaultModel(draft?.model ?? '');
    setBackgroundModel(draft?.backgroundModel ?? '');
    if (draft?.custom) setAdvancedOpen(true);
    setApiKey('');
    setClearApiKey(false);
    setEditingApiKey(false);
    setError(null);
    setDiscovery(null);
  }

  return (
    <fieldset className={styles.form} disabled={pending || testing} aria-label="AI settings">
      <div className={styles.formContent} tabIndex={0} role="region" aria-label="AI settings form">
        <header className={styles.header}>
          <div>
            <h2>AI integration</h2>
            <p>Connect a provider to power Ask anything and article summaries.</p>
          </div>
          <Toggle
            label="Enable AI integration"
            help={
              enabled
                ? 'On. Uses the provider configured below for Ask anything.'
                : 'Off. Ask anything and automatic article summaries are disabled.'
            }
            checked={enabled}
            onChange={setEnabled}
          />
        </header>

        <section className={styles.section} aria-labelledby="ai-connection-heading">
          <div className={styles.sectionHeading}>
            <Icon.plug size={16} />
            <h3 id="ai-connection-heading">Connection</h3>
          </div>
          <fieldset className={styles.providers}>
            <legend>Provider</legend>
            <div className={styles.providerGrid}>
              {PROVIDERS.map((p) => (
                <RadioOption
                  key={p.value}
                  name="ai-provider"
                  checked={provider === p.value}
                  onChange={() => changeProvider(p.value)}
                  hideIndicator
                  className={styles.providerCard}
                  label={
                    <span className={styles.providerLabel}>
                      {p.value === 'openai_compatible' ? (
                        <Icon.server size={24} />
                      ) : (
                        <span
                          aria-hidden="true"
                          className={`${styles.providerLogo} ${p.value === 'openai' ? styles.openaiLogo : styles.anthropicLogo}`}
                        />
                      )}
                      <span>{p.label}</span>
                    </span>
                  }
                  hint={p.hint}
                />
              ))}
            </div>
          </fieldset>

          {provider === 'openai_compatible' ? (
            <Field
              label="Endpoint URL"
              labelVariant="plain"
              htmlFor="ai-base-url"
              help="Include /v1. Works with Ollama, LM Studio, vLLM, and compatible routers."
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
          ) : (
            <div className={styles.endpoint}>
              <span>{customEndpoint ? 'Custom endpoint' : 'Endpoint'}</span>
              <code>{effectiveBaseUrl || 'Enter a custom endpoint in Advanced'}</code>
              {customEndpoint && (
                <Tag tone="accent" mono={false}>
                  Override
                </Tag>
              )}
            </div>
          )}

          {(provider === 'openai_compatible' || customEndpoint || allowPrivateNetwork) && (
            <div className={styles.customEndpoint}>
              <Checkbox
                label="Allow private-network addresses"
                checked={allowPrivateNetwork}
                onChange={setAllowPrivateNetwork}
                hint="For local Ollama, LM Studio, or servers on your LAN."
              />
              {allowPrivateNetwork && (
                <p className={styles.warning}>
                  This relaxes server-side request protections for loopback and LAN addresses. Only
                  enable it for a network you control. Link-local and cloud-metadata addresses
                  remain blocked.
                </p>
              )}
            </div>
          )}

          <div className={styles.keyHeader}>
            <span className={styles.fieldLabel}>API key</span>
            {baseline.apiKeyConfigured && !apiKey && !clearApiKey && (
              <Tag tone="default" mono={false}>
                Saved
              </Tag>
            )}
            {apiKey && (
              <Tag tone="accent" mono={false}>
                Replacement pending
              </Tag>
            )}
            {clearApiKey && (
              <Tag tone="warn" mono={false}>
                Removal pending
              </Tag>
            )}
            {baseline.apiKeyConfigured && (
              <div className={styles.keyActions}>
                {!clearApiKey && (
                  <Btn
                    type="button"
                    kind="ghost"
                    onClick={() => {
                      setEditingApiKey((v) => !v);
                      setApiKey('');
                    }}
                  >
                    {editingApiKey ? 'Cancel replacement' : 'Replace key'}
                  </Btn>
                )}
                <Btn
                  type="button"
                  kind={clearApiKey ? 'ghost' : 'danger'}
                  onClick={() => {
                    setClearApiKey((v) => !v);
                    setApiKey('');
                    setEditingApiKey(false);
                  }}
                >
                  {clearApiKey ? 'Undo removal' : 'Remove key'}
                </Btn>
              </div>
            )}
          </div>
          {(!baseline.apiKeyConfigured || editingApiKey) && !clearApiKey && (
            <Field
              htmlFor="ai-api-key"
              label={editingApiKey ? 'New API key' : undefined}
              labelVariant="plain"
              help={
                provider === 'openai_compatible'
                  ? 'Optional for servers that do not require authentication.'
                  : 'Enter an API key from your provider.'
              }
            >
              <Input
                id="ai-api-key"
                aria-label={editingApiKey ? undefined : 'API key'}
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="new-password"
                maxLength={1024}
              />
            </Field>
          )}
          {keyNeedsAttention && (
            <p className={styles.warning}>
              The endpoint has changed. Enter a key for this endpoint, or remove the saved key,
              before you test or save.
            </p>
          )}

          <div className={styles.testRow}>
            <div className={styles.testCopy}>
              <p>
                {clearApiKey
                  ? 'Save the key removal before testing.'
                  : !enabled
                    ? 'Enable AI integration to test the connection.'
                    : !effectiveBaseUrl
                      ? 'Enter an endpoint URL before testing or saving.'
                      : dirty
                        ? 'Tests your current settings. Save afterwards to keep them.'
                        : 'Discover models and check a reply from your selected model.'}
              </p>
              {models !== null && (
                <div className={styles.testResults} role="status">
                  <Tag tone="ok" mono={false}>
                    {models.length} model{models.length === 1 ? '' : 's'} found
                  </Tag>
                  {probe && (
                    <Tag
                      tone={
                        probe.status === 'ok'
                          ? 'ok'
                          : probe.status === 'skipped'
                            ? 'default'
                            : 'warn'
                      }
                      mono={false}
                      style={{ height: 'auto', minHeight: 20, whiteSpace: 'normal' }}
                    >
                      {probeMessage(probe)}
                    </Tag>
                  )}
                </div>
              )}
            </div>
            <Btn
              type="button"
              kind="outline"
              size="md"
              icon={Icon.refresh}
              onClick={testConnection}
              loading={testing}
              disabled={!enabled || !effectiveBaseUrl || clearApiKey || pending}
            >
              Test connection
            </Btn>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="ai-models-heading">
          <div className={styles.sectionHeading}>
            <Icon.sparkles size={16} />
            <h3 id="ai-models-heading">Models</h3>
          </div>
          <div className={styles.twoColumns}>
            <Field
              label="Default model"
              labelVariant="plain"
              htmlFor="ai-default-model"
              help={
                hasDiscoveredModels
                  ? 'Choose a model for Ask anything.'
                  : 'Test the connection to discover models, or enter a model ID.'
              }
            >
              <ModelPicker
                id="ai-default-model"
                value={defaultModel}
                onChange={setDefaultModel}
                models={models}
                emptyLabel="— None —"
                placeholder={
                  provider === 'anthropic'
                    ? 'Enter a Claude model ID'
                    : provider === 'openai'
                      ? 'Enter an OpenAI model ID'
                      : 'llama3:latest'
                }
              />
            </Field>
            <Field
              label="Background model"
              labelVariant="plain"
              htmlFor="ai-background-model"
              help="Used for titles, proposal introductions, and summaries. Defaults to your main model."
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
          </div>
        </section>

        <section className={styles.section} aria-labelledby="ai-features-heading">
          <div className={styles.sectionHeading}>
            <Icon.doc size={16} />
            <h3 id="ai-features-heading">Features</h3>
          </div>
          <Checkbox
            label="Automatic article summaries"
            checked={autoSummaries}
            onChange={setAutoSummaries}
            hint="Sends article titles and content to your AI endpoint when articles are created or edited. Existing articles are summarized on their next edit."
          />
        </section>

        <details
          className={styles.advanced}
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
        >
          <summary>
            <Icon.chevron size={12} />
            <span>Advanced</span>
            {(showOutputHint || outputExceedsContext) && (
              <Tag tone="warn" mono={false}>
                Review settings
              </Tag>
            )}
          </summary>
          <div className={styles.advancedContent}>
            {provider !== 'openai_compatible' && (
              <div className={styles.customEndpoint}>
                <Checkbox
                  label="Use a custom endpoint"
                  checked={customEndpoint}
                  onChange={setCustomEndpoint}
                  hint="Override the provider URL for a proxy or API gateway."
                />
                {customEndpoint && (
                  <Field
                    label="Custom endpoint URL"
                    labelVariant="plain"
                    htmlFor="ai-custom-base-url"
                    help="Include the /v1 suffix. Requests and credentials go to this endpoint."
                  >
                    <Input
                      id="ai-custom-base-url"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder={providerInfo.defaultUrl}
                      maxLength={2048}
                      autoComplete="off"
                    />
                  </Field>
                )}
              </div>
            )}
            <div className={styles.twoColumns}>
              <TokenSlider
                id="ai-max-output-tokens"
                label="Max output tokens"
                help="Maximum reply size. The server caps replies at half the context window."
                value={maxOutputTokens}
                onChange={setMaxOutputTokens}
                defaultValue={AI_DEFAULT_MAX_OUTPUT_TOKENS}
                min={AI_MAX_OUTPUT_TOKENS_RANGE.min}
                max={AI_MAX_OUTPUT_TOKENS_RANGE.max}
              />
              <TokenSlider
                id="ai-context-window-tokens"
                label="Context window tokens"
                help="Total model context, including the prompt and reply."
                value={contextWindowTokens}
                onChange={setContextWindowTokens}
                defaultValue={AI_DEFAULT_CONTEXT_WINDOW_TOKENS}
                min={AI_CONTEXT_WINDOW_TOKENS_RANGE.min}
                max={AI_CONTEXT_WINDOW_TOKENS_RANGE.max}
              />
            </div>
            {outputExceedsContext ? (
              <p className={styles.warning} role="alert">
                Max output tokens must be less than the context window.
              </p>
            ) : (
              requestedOutput > outputCap && (
                <p className={styles.hint}>
                  Replies are capped at {TOKEN_FORMATTER.format(outputCap)} tokens, half the context
                  window.
                </p>
              )
            )}
            {showOutputHint && (
              <p className={styles.warning}>
                Reasoning models use output tokens for thinking. A budget of 16k or more helps avoid
                cut-off tool calls.
              </p>
            )}
            <div className={styles.twoColumns}>
              <Field
                label="Reasoning effort"
                labelVariant="plain"
                htmlFor="ai-reasoning-effort"
                help="Applies where supported. Titles and summaries use the lowest setting."
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
                  labelVariant="plain"
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
          </div>
        </details>

        <aside className={styles.privacy}>
          <Icon.shield size={16} />
          <div>
            <p>
              Conversations and attached context are sent directly to your configured AI endpoint.
            </p>
            <details>
              <summary>What data is shared?</summary>
              <p>
                This can include article content, asset field values, domain details, and ticket
                bodies with internal notes. Choose a provider you trust with this data. Weavestream
                does not proxy or filter these requests.
              </p>
            </details>
          </div>
        </aside>

        {error && (
          <div
            role="alert"
            className={styles.warning}
            style={{ color: 'var(--danger)', background: 'var(--danger-soft)' }}
          >
            {error}
          </div>
        )}
      </div>
      <footer className={styles.footer}>
        <span>{!dirty ? 'All changes saved' : (saveBlocker ?? 'Unsaved changes')}</span>
        <div>
          <Btn
            type="button"
            kind="ghost"
            size="md"
            onClick={reset}
            disabled={!dirty || pending || testing}
          >
            Reset
          </Btn>
          <Btn
            type="button"
            kind="primary"
            size="md"
            onClick={save}
            loading={pending}
            disabled={!dirty || testing || saveBlocker !== null}
          >
            Save AI settings
          </Btn>
        </div>
      </footer>
    </fieldset>
  );
}

function TokenSlider({
  id,
  label,
  help,
  value,
  onChange,
  defaultValue,
  min,
  max,
}: {
  id: string;
  label: string;
  help: string;
  value: string;
  onChange: (value: string) => void;
  defaultValue: number;
  min: number;
  max: number;
}) {
  const tokens = numOrNull(value) ?? defaultValue;
  const [startingTokens] = useState(tokens);
  const stops = [
    ...new Set([
      ...TOKEN_STEPS.filter((step) => step >= min && step <= max),
      startingTokens,
      tokens,
    ]),
  ].sort((a, b) => a - b);
  const formatted = TOKEN_FORMATTER.format(tokens);
  return (
    <Field label={label} labelVariant="plain" htmlFor={id} help={help}>
      <div className={styles.sliderValue}>
        <output htmlFor={id}>{formatted} tokens</output>
        {value === '' ? (
          <Tag mono={false}>Default</Tag>
        ) : (
          <Btn
            type="button"
            kind="ghost"
            aria-label={`Use default for ${label}`}
            onClick={() => onChange('')}
          >
            Use default
          </Btn>
        )}
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={stops.length - 1}
        step={1}
        value={stops.indexOf(tokens)}
        aria-valuetext={`${formatted} tokens${value === '' ? ' (default)' : ''}`}
        onChange={(e) => onChange(String(stops[Number(e.target.value)]))}
        className={styles.tokenSlider}
      />
      <div className={styles.sliderBounds} aria-hidden="true">
        <span>{TOKEN_FORMATTER.format(min)}</span>
        <span>{TOKEN_FORMATTER.format(max)}</span>
      </div>
    </Field>
  );
}

function hasCustomEndpoint(settings: AiSettings): boolean {
  const defaultUrl = PROVIDERS.find((p) => p.value === settings.provider)?.defaultUrl;
  return (
    settings.provider !== 'openai_compatible' &&
    Boolean(settings.baseUrl) &&
    settings.baseUrl!.replace(/\/+$/, '') !== defaultUrl
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
        {value && !models.some((m) => m.id === value) && <option value={value}>{value}</option>}
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
