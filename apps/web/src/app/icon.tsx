import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageResponse } from 'next/og';

/**
 * Phase 9b.2 — 32×32 favicon rendered from the brand mark at
 * `public/brand/logo-mark.svg`. Single source of truth: swapping the
 * SVG file updates the tab icon on next request, no code change. The
 * renderer (Satori) supports `<img>` with SVG data URLs.
 */

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';
export const dynamic = 'force-static';

export default async function Icon() {
  const svg = await readFile(
    path.join(process.cwd(), 'public/brand/logo-mark.svg'),
    'utf-8',
  );
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString(
    'base64',
  )}`;
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
        }}
      >
        <img src={dataUrl} width={32} height={32} alt="" />
      </div>
    ),
    { ...size },
  );
}
