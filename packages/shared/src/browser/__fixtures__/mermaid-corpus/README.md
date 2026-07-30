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
with `--check`, so a Mermaid version bump cannot land on stale fixtures.

When the writer reports a vocabulary change, read it before committing:
a new element, attribute or CSS function means the allowlist needs
widening **deliberately**, and a disappearing one usually means a diagram
feature changed shape.

### What `--check` compares, and why it is not the bytes

It compares the **vocabulary** — the element names, attribute names and
CSS function names — not the rendered SVG byte for byte. The bytes are
not reproducible, in two independent ways:

- **Fonts.** Mermaid sizes every node by measuring its label, against
  `"trebuchet ms", verdana, arial, sans-serif`. Those fonts are on macOS
  and not on the CI runner, so widths, viewBoxes and path coordinates all
  shift. Every fixture has text, so a dev-machine render failed CI on all
  twelve at once — which reads like mass staleness rather than a font
  difference.
- **The clock.** `gantt` draws a `class="today"` rule at the current
  date. `normalize()` in the writer pins it for this reason; before that
  it drifted daily on every machine.

Neither moves what these fixtures are for. `diagram-svg.spec.ts` reads
names out of them and never reads a coordinate, so the geometry was never
load-bearing — forcing a different font across the corpus changes the
bytes of all twelve files and the vocabulary of none.

The fixtures stay real Mermaid renders (the writer commits whatever came
out, geometry included); it is only the *gate* that ignores geometry.
