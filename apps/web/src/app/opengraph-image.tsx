import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageResponse } from 'next/og';

/**
 * Phase 9b.1 — 1200×630 Open Graph / link-preview image. Kept
 * intentionally minimal: the product is internal, so OG previews mostly
 * appear in password managers and Slack unfurls of the login URL.
 *
 * The mark is read from `public/brand/logo-mark-dark.svg` (the variant
 * drawn for a dark background), so swapping that file updates this
 * image too — same single source as the sidebar and favicon.
 */

export const alt = 'Weavestream';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const dynamic = 'force-static';

export default async function OpengraphImage() {
  const svg = await readFile(
    path.join(process.cwd(), 'public/brand/logo-mark-dark.svg'),
    'utf-8',
  );
  const markUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString(
    'base64',
  )}`;
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0a0a',
          color: '#ededed',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          gap: 28,
        }}
      >
        <img src={markUrl} width={163} height={168} alt="" />
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 4,
            fontSize: 96,
            fontWeight: 700,
          }}
        >
          <span style={{ color: '#b4e55a', fontStyle: 'italic' }}>Weave</span>
          <span style={{ color: '#8a8a8a', fontWeight: 400 }}>stream</span>
        </div>
        <div style={{ color: '#8a8a8a', fontSize: 28, letterSpacing: 1 }}>
          IT documentation
        </div>
      </div>
    ),
    { ...size },
  );
}
