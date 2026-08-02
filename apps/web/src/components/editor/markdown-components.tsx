'use client';

import { useEffect, useRef, useState, type ComponentProps } from 'react';
import type { Components } from 'react-markdown';
import { mermaidSourceFromPre } from '@weavestream/shared';
import { copyToClipboard } from '@weavestream/shared/browser';
import { Icon } from '../ui';
import { MermaidBlock } from './mermaid-block';

/**
 * The react-markdown component map shared by the article read view and
 * the editor's live preview, so the two cannot drift.
 *
 * ## Why this hangs off `pre` and not `code`
 *
 * react-markdown v10 removed the `inline` prop, so a `code` override
 * cannot tell a fence from an inline span without reading the hast node
 * anyway — and returning flow content (a `<figure>`) from `code` would
 * nest it inside `<pre>`, which is invalid HTML and produces a hydration
 * warning. Overriding `pre` sidesteps both.
 *
 * The fence-recognition rule itself lives in `@weavestream/shared`
 * (`mermaidSourceFromPre`), shared with `apps/mobile` and with the PDF
 * export's own parser — three surfaces that must agree on what counts as
 * a diagram, and previously did not.
 */
export function markdownComponents(opts: { showDiagramErrors?: boolean }): Components {
  return {
    pre: ({ node, children, ...rest }) => {
      const source = mermaidSourceFromPre(node);
      if (source === null) {
        return <CopyableCodeBlock {...rest}>{children}</CopyableCodeBlock>;
      }
      return <MermaidBlock source={source} showDiagramErrors={opts.showDiagramErrors} />;
    },
  };
}

function CopyableCodeBlock({ children, ...rest }: ComponentProps<'pre'>) {
  const preRef = useRef<HTMLPreElement | null>(null);
  const resetTimerRef = useRef<number | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    },
    [],
  );

  async function copyCode() {
    const source = (preRef.current?.textContent ?? '').replace(/\n$/, '');
    const copied = await copyToClipboard(source);
    setCopyState(copied ? 'copied' : 'failed');
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1500);
  }

  const copyLabel =
    copyState === 'copied' ? 'Code copied' : copyState === 'failed' ? 'Copy failed' : 'Copy code';

  return (
    <div className="sd-code-block">
      <button
        type="button"
        className="sd-code-copy"
        data-copy-state={copyState}
        aria-label={copyLabel}
        aria-live="polite"
        title={copyLabel}
        onClick={() => void copyCode()}
      >
        {copyState === 'copied' ? <Icon.check size={12} /> : <Icon.copy size={12} />}
      </button>
      <pre {...rest} ref={preRef}>
        {children}
      </pre>
    </div>
  );
}
