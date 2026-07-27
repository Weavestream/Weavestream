#!/usr/bin/env node
/**
 * Generate `src/components/icon-paths.ts` from `@material-symbols/svg-400`.
 *
 * The design handoff specifies Material Symbols Rounded, weight 400,
 * optical size 24, unfilled. We ship **paths, not the font**:
 *
 *   - Subsetting the webfont needs `fonttools` (Python), which is not in
 *     this toolchain, and the unsubset font is 300 KB+.
 *   - `font-src` inherits `default-src 'self'` under the `/m` CSP, so a
 *     CDN is impossible regardless.
 *   - A webfont icon FOITs on a bad radio, which would blank the tab bar
 *     — the exact condition this app is built for.
 *
 * So `@material-symbols/svg-400` is a **devDependency**: it is read at
 * generation time and the extracted paths are committed. Nothing from it
 * reaches the runtime bundle. Licence: Apache-2.0 (compatible with
 * AGPL-3.0); see `node_modules/@material-symbols/svg-400/LICENSE`.
 *
 * Run: `pnpm --filter @weavestream/mobile gen:icons`
 * A missing glyph is a hard error, so a package bump that renames one
 * fails here instead of silently shipping a blank icon.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../src/components/icon-paths.ts');

/** Every glyph the app uses, mapped to its file in the package.
 *
 * Keys keep the design handoff's Material names so a spec table can be
 * cross-referenced against a call site without a translation step. Two
 * of the handoff's names no longer exist in the current package and are
 * mapped to their replacements — recorded here rather than silently
 * renamed at the call sites:
 *
 *   expand_more   → keyboard_arrow_down  (upstream rename; same chevron)
 *   auto_awesome  → wand_stars           (upstream removed the 4-point
 *                                         sparkle; wand_stars is
 *                                         Google's current AI-feature
 *                                         glyph in the rounded set)
 */
const GLYPHS = {
  // Tab bar
  lock: 'lock',
  description: 'description',
  dns: 'dns',
  more_horiz: 'more_horiz',
  auto_awesome: 'wand_stars',
  // Navigation + disclosure
  chevron_right: 'chevron_right',
  chevron_left: 'chevron_left',
  expand_more: 'keyboard_arrow_down',
  close: 'close',
  cancel: 'cancel',
  // Actions
  search: 'search',
  add: 'add',
  content_copy: 'content_copy',
  visibility: 'visibility',
  visibility_off: 'visibility_off',
  edit: 'edit',
  archive: 'archive',
  casino: 'casino',
  open_in_new: 'open_in_new',
  mic: 'mic',
  logout: 'logout',
  refresh: 'refresh',
  // Ask anything (Phase 3)
  arrow_upward: 'arrow_upward',
  stop: 'stop',
  // Install UI (Phase 3). `install_mobile` is absent from this package
  // version; `add_home` (add-to-home-screen) is the closest current
  // glyph — recorded here per the expand_more/auto_awesome convention.
  install_mobile: 'add_home',
  ios_share: 'ios_share',
  // Status
  check_circle: 'check_circle',
  error: 'error',
  wifi_off: 'wifi_off',
  // Content types + More tab
  folder: 'folder',
  create_new_folder: 'create_new_folder',
  home: 'home',
  star: 'star',
  history: 'history',
  dashboard: 'dashboard',
  lan: 'lan',
  language: 'language',
  photo_library: 'photo_library',
  photo_camera: 'photo_camera',
  // Layout icons (Phase 2c) — AssetLayout.icon keys are the DESKTOP
  // icon-set names (ICON_CHOICES in the layout builder); LayoutTile
  // maps them onto these Material glyphs. `server`→dns, `network`→lan,
  // `globe`→language, `doc`→description, `folder`/`home` are already
  // above; the rest land here.
  laptop_mac: 'laptop_mac',
  package_2: 'package_2',
  person: 'person',
  apartment: 'apartment',
  key: 'key',
  shield: 'shield',
  sell: 'sell',
  schedule: 'schedule',
  image: 'image',
  settings: 'settings',
};

/** Material Symbols draws on a 960-unit grid with a raised baseline. */
const EXPECTED_VIEWBOX = '0 -960 960 960';

function pkgDir() {
  // Resolve through the package's own manifest so this keeps working
  // under pnpm's symlinked store layout.
  return dirname(require.resolve('@material-symbols/svg-400/package.json'));
}

/** Pull the `d` of every `<path>`, plus the declared viewBox. */
function parse(svg, name) {
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1];
  if (viewBox !== EXPECTED_VIEWBOX) {
    throw new Error(
      `${name}: viewBox is "${viewBox}", expected "${EXPECTED_VIEWBOX}" — ` +
        'the Icon component hardcodes the grid',
    );
  }
  const ds = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
  if (ds.length === 0) throw new Error(`${name}: no <path d="…"> found`);
  return ds;
}

async function main() {
  const rounded = join(pkgDir(), 'rounded');
  const entries = [];

  for (const [name, file] of Object.entries(GLYPHS)) {
    let svg;
    try {
      svg = await readFile(join(rounded, `${file}.svg`), 'utf8');
    } catch {
      throw new Error(
        `glyph "${file}" is missing from @material-symbols/svg-400/rounded — ` +
          'it was probably renamed upstream; update the GLYPHS map',
      );
    }
    entries.push([name, parse(svg, file), file]);
  }

  entries.sort((a, b) => a[0].localeCompare(b[0]));

  const version = JSON.parse(
    await readFile(join(pkgDir(), 'package.json'), 'utf8'),
  ).version;

  const body = entries
    .map(([name, ds, file]) => {
      const note = name === file ? '' : ` // ${file}`;
      const paths = ds.map((d) => `    '${d}',`).join('\n');
      return `  ${name}: [${note}\n${paths}\n  ],`;
    })
    .join('\n');

  const out = `/* GENERATED FILE — do not edit by hand.
 *
 * Source: @material-symbols/svg-400@${version}, \`rounded\` variant
 * (weight 400, optical size 24, unfilled), Apache-2.0.
 * Regenerate: \`pnpm --filter @weavestream/mobile gen:icons\`
 *
 * Paths are committed so the icon font never reaches the bundle — see
 * scripts/gen-icons.mjs for why.
 */

/** Material Symbols' grid: 960 units wide, baseline-raised origin. */
export const ICON_VIEWBOX = '${EXPECTED_VIEWBOX}';

export const ICON_PATHS = {
${body}
} as const;

export type IconName = keyof typeof ICON_PATHS;
`;

  await writeFile(OUT, out, 'utf8');
  console.log(
    `[icons] wrote ${entries.length} glyphs → src/components/icon-paths.ts ` +
      `(@material-symbols/svg-400@${version})`,
  );
}

main().catch((err) => {
  console.error('[icons] generation failed:', err.message);
  process.exit(1);
});
