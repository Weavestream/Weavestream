import { useMemo } from 'react';
import { computeLineDiff } from '@weavestream/shared';

/**
 * Mobile line-diff rendering over the shared bounded `computeLineDiff`.
 * `null` from the diff means the input exceeded the shared cell budget
 * (a newline-heavy body would freeze the phone in the O(n·m) table) —
 * render the proposed content with an explicit note instead. Styling is
 * mobile's own (tokens, mono, wrap); the ops are the shared contract.
 */
export function DiffView({ before, after }: { before: string; after: string }) {
  const ops = useMemo(
    () => computeLineDiff(before.split(/\r?\n/), after.split(/\r?\n/)),
    [before, after],
  );

  if (ops === null) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-[13px] text-muted">
          Change too large to diff — showing proposed content.
        </p>
        <ProposedBody markdown={after} />
      </div>
    );
  }

  if (before === after) {
    return <p className="text-[13px] text-muted">Article body unchanged.</p>;
  }

  return (
    <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-field bg-panel-2 p-2 font-mono text-[12.5px] leading-[1.5]">
      {ops.map((op, i) => (
        <div
          key={i}
          className={
            op.kind === 'add'
              ? 'bg-ok-soft px-1 text-text'
              : op.kind === 'del'
                ? 'bg-danger-soft px-1 text-text'
                : 'px-1 text-muted'
          }
        >
          <span className="text-dim">
            {op.kind === 'add' ? '+ ' : op.kind === 'del' ? '- ' : '  '}
          </span>
          {op.text}
        </div>
      ))}
    </pre>
  );
}

/** Plain proposed-content preview (creates, over-budget diffs). */
export function ProposedBody({ markdown }: { markdown: string }) {
  return (
    <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-field bg-panel-2 p-2 font-mono text-[12.5px] leading-[1.5] text-text">
      {markdown}
    </pre>
  );
}
