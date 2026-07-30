# Mermaid corpus

The `.mmd` files here are the input set that `SVG_TAGS`, `SVG_ATTRS` and
`FOREIGN_HTML_TAGS` in `../../diagram-svg.ts` are derived from, and that
`../../diagram-svg.spec.ts` runs against.

## Why it is not "one diagram per type"

The allowlist in `diagram-svg.ts` is explicit, so anything Mermaid emits
that is not on it is **silently stripped** — a blanked label, a missing
arrowhead, an unstyled cluster, with no error anywhere. One diagram per
type would exercise almost none of the optional output that carries the
unusual elements and attributes. So the corpus deliberately covers the
*features*, not just the types:

| Feature | File |
| --- | --- |
| Flowchart shapes, subgraphs, styled edges, `classDef`/`class` | `flowchart-full.mmd` |
| Multi-line and markdown labels, unicode, long text wrapping | `labels.mmd` |
| `accTitle` / `accDescr` (the accessible name) | `accessibility.mmd` |
| `click` link and callback directives | `links.mmd` |
| Sequence: notes, loops, activations, autonumber | `sequence-full.mmd` |
| Class diagram: annotations, generics, relations | `class-full.mmd` |
| State: composite states, notes, choice | `state-full.mmd` |
| ER: attributes, keys, comments | `er-full.mmd` |
| Gantt: sections, milestones, `crit`/`done`/`active` | `gantt-full.mmd` |
| Pie, quadrant, journey (categorical ramps) | `categorical.mmd` |
| Git graph: branches, merges, cherry-picks, tags | `gitgraph-full.mmd` |
| `%%{init}%%` front-matter directives | `init-directive.mmd` |

Add a file whenever a customer diagram turns up something these miss.

## Regenerating after a Mermaid upgrade

Checked-in SVG snapshots cannot notice a Mermaid upgrade on their own —
this package deliberately has no Mermaid dependency, and Mermaid cannot
run under jest anyway (it needs `getBBox`, which is the whole reason for
the runtime seam in each app). So the generator lives in the package that
*does* have Mermaid, and renders through a real browser:

```bash
pnpm --filter @weavestream/web mermaid:corpus
```

That writes `*.svg` next to each `*.mmd` here. CI runs the same command
and fails if the result differs from what is committed, so a Mermaid
version bump cannot land on stale fixtures.

When the diff is non-empty after an upgrade, read it before accepting it:
a new element or attribute means the allowlist needs widening
**deliberately**, and a disappearing one usually means a diagram feature
changed shape.
