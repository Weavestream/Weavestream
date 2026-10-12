'use client';

import { useState, type ReactNode } from 'react';
import type { IntegrationSetupCheck, SetupGuideComputedValue, SetupGuideStep } from '@weavestream/shared';
import { copyToClipboard } from '@weavestream/shared/browser';
import { Btn, Icon, useToast } from '../ui';

/**
 * Numbered provider setup guide (driver `setupGuide`). Step bodies are
 * plain text with a tiny markdown subset (blank-line paragraphs, `- `
 * bullets, `**bold**`) rendered as React elements: never as HTML. A step
 * turns green when Check setup passes it and red with a fixed message when
 * it fails; a step the check cannot verify keeps its number and shows a note.
 */
export function SetupGuide({
  steps,
  redirectUri,
  scopeGroups,
  check,
  onCheck,
  checking = false,
  checkDisabledReason,
  defaultOpen = true,
}: {
  steps: SetupGuideStep[];
  redirectUri: string;
  /** Scopes to register, grouped (e.g. required vs. one driver only). */
  scopeGroups: ScopeGroup[];
  check: IntegrationSetupCheck | null;
  onCheck?: () => void;
  checking?: boolean;
  /** When set, Check setup is disabled and this explains why. */
  checkDisabledReason?: string | null;
  defaultOpen?: boolean;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(defaultOpen);
  const passed = new Set(check?.passedStepIds ?? []);
  const failedBy = new Map<string, string[]>();
  for (const f of check?.failures ?? []) {
    if (f.stepId) failedBy.set(f.stepId, [...(failedBy.get(f.stepId) ?? []), f.message]);
  }
  const general = (check?.failures ?? []).filter((f) => !f.stepId || !steps.some((s) => s.id === f.stepId));

  function computed(kind: SetupGuideComputedValue): string {
    if (kind === 'redirectUri') return redirectUri;
    if (kind === 'scopes') return scopeGroups.flatMap((g) => g.scopes).join(' ');
    try {
      return new URL(redirectUri).origin;
    } catch {
      return redirectUri;
    }
  }

  async function copy(value: string, label: string) {
    const ok = await copyToClipboard(value);
    toast.push(ok ? `${label} copied.` : `Could not copy the ${label.toLowerCase()}.`, ok ? 'ok' : 'danger');
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }} aria-label="Setup guide">
      <div style={headerRowStyle}>
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} style={toggleStyle}>
          <Icon.chevronD size={12} style={{ transform: open ? undefined : 'rotate(-90deg)' }} />
          Setup guide ({steps.length} steps)
        </button>
        {onCheck && (
          <Btn
            kind="outline"
            size="sm"
            icon={Icon.checkSquare}
            onClick={onCheck}
            loading={checking}
            disabled={checking || Boolean(checkDisabledReason)}
            title={checkDisabledReason ?? undefined}
          >
            Check setup
          </Btn>
        )}
      </div>
      {checkDisabledReason && onCheck && <p style={mutedStyle}>{checkDisabledReason}</p>}
      {check?.ok && <p style={{ ...mutedStyle, color: 'var(--ok)' }} role="status">Setup check passed.</p>}
      {general.map((f, i) => (
        <p key={i} style={dangerStyle} role="alert">
          {f.message}
        </p>
      ))}
      {open && (
        <ol style={listStyle}>
          {steps.map((step, index) => {
            const failures = failedBy.get(step.id);
            const notes = (check?.notes ?? []).filter((n) => n.stepId === step.id);
            const state = failures ? 'failed' : passed.has(step.id) ? 'passed' : 'todo';
            return (
              <li key={step.id} style={stepStyle} data-state={state}>
                <span style={badgeStyle(state)} aria-hidden="true">
                  {state === 'passed' ? <Icon.check size={12} stroke={2} /> : state === 'failed' ? <Icon.x size={12} stroke={2} /> : index + 1}
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, flex: 1 }}>
                  <h4 style={titleStyle}>
                    <span style={srOnlyStyle}>{`Step ${index + 1}${state === 'passed' ? ', passed' : state === 'failed' ? ', needs attention' : ''}: `}</span>
                    {step.title}
                  </h4>
                  {failures?.map((message, i) => (
                    <p key={i} style={dangerStyle} role="alert">
                      {message}
                    </p>
                  ))}
                  {notes.map((n, i) => (
                    <p key={i} style={mutedStyle}>
                      {n.message}
                    </p>
                  ))}
                  <GuideBody body={step.body} />
                  {step.copyValues?.map((cv) => {
                    // The provider console takes one scope at a time, so each gets its own copy button.
                    if ('computed' in cv && cv.computed === 'scopes') {
                      return <ScopeList key={cv.label} groups={scopeGroups} />;
                    }
                    const value = 'computed' in cv ? computed(cv.computed) : cv.value;
                    return (
                      <div key={cv.label} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span style={labelStyle}>{cv.label}</span>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                          <code style={codeStyle}>{value}</code>
                          <Btn kind="outline" size="sm" icon={Icon.copy} onClick={() => void copy(value, cv.label)} aria-label={`Copy ${cv.label.toLowerCase()}`}>
                            Copy
                          </Btn>
                        </div>
                      </div>
                    );
                  })}
                  {step.links && step.links.length > 0 && (
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      {step.links
                        .filter((l) => l.href.startsWith('https://'))
                        .map((l) => (
                          <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                            {l.label} <Icon.ext size={11} />
                          </a>
                        ))}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export type ScopeGroup = { label?: string; scopes: string[] };

/** One row per scope with its own Copy button, under an optional group label. */
export function ScopeList({ groups }: { groups: ScopeGroup[] }) {
  const toast = useToast();
  async function copy(scope: string) {
    const ok = await copyToClipboard(scope);
    toast.push(ok ? 'Scope copied.' : 'Could not copy the scope.', ok ? 'ok' : 'danger');
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {groups.map((group, gi) => (
        <div key={group.label ?? gi} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {group.label && <span style={labelStyle}>{group.label}</span>}
          <ul style={scopeListStyle} aria-label={group.label ?? 'Scopes'}>
            {group.scopes.map((scope) => (
              <li key={scope} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <code style={codeStyle}>{scope}</code>
                <Btn kind="outline" size="sm" icon={Icon.copy} onClick={() => void copy(scope)} aria-label={`Copy scope ${scope}`}>
                  Copy
                </Btn>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** `**bold**` spans inside one line, as React elements. */
function inline(text: string): ReactNode[] {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part));
}

function GuideBody({ body }: { body: string }) {
  return (
    <>
      {body.split(/\n{2,}/).map((para, i) => {
        const lines = para.split('\n');
        if (lines.every((l) => l.startsWith('- '))) {
          return (
            <ul key={i} style={bodyListStyle}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.slice(2))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} style={bodyStyle}>
            {lines.flatMap((l, j) => (j === 0 ? inline(l) : [<br key={`br${j}`} />, ...inline(l)]))}
          </p>
        );
      })}
    </>
  );
}

const srOnlyStyle: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
};
const headerRowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' };
const toggleStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0, border: 0, background: 'none', cursor: 'pointer',
  fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 600, color: 'var(--text)',
};
const listStyle: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 16 };
const stepStyle: React.CSSProperties = { display: 'flex', gap: 12, alignItems: 'flex-start' };
const titleStyle: React.CSSProperties = { margin: 0, fontSize: 13.5, fontWeight: 600, color: 'var(--text)' };
const bodyStyle: React.CSSProperties = { margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text)' };
const bodyListStyle: React.CSSProperties = { ...bodyStyle, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 };
const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--muted)' };
const mutedStyle: React.CSSProperties = { margin: 0, fontSize: 12.5, color: 'var(--muted)' };
const dangerStyle: React.CSSProperties = { margin: 0, fontSize: 12.5, color: 'var(--danger)', fontWeight: 500 };
const linkStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' };
const scopeListStyle: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 };
const codeStyle: React.CSSProperties = {
  flex: '1 1 240px', minWidth: 0, padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6,
  background: 'var(--panel-2)', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text)',
  overflowWrap: 'anywhere', whiteSpace: 'pre-wrap',
};

function badgeStyle(state: 'passed' | 'failed' | 'todo'): React.CSSProperties {
  const tone = state === 'passed' ? 'var(--ok)' : state === 'failed' ? 'var(--danger)' : 'var(--line)';
  return {
    flexShrink: 0, width: 24, height: 24, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 12, fontWeight: 600, border: `1.5px solid ${tone}`,
    background: state === 'todo' ? 'var(--panel-2)' : tone,
    color: state === 'todo' ? 'var(--text)' : 'var(--bg)',
  };
}
