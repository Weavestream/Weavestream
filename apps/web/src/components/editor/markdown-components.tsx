'use client';

import type { Components } from 'react-markdown';
import { mermaidSourceFromPre } from '@weavestream/shared';
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
export function markdownComponents(opts: {
  showDiagramErrors?: boolean;
}): Components {
  return {
    pre: ({ node, children, ...rest }) => {
      const source = mermaidSourceFromPre(node);
      if (source === null) return <pre {...rest}>{children}</pre>;
      return (
        <MermaidBlock
          source={source}
          showDiagramErrors={opts.showDiagramErrors}
        />
      );
    },
  };
}
