import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageResponse } from 'next/og';

/**
 * Phase 9b.2 — 180×180 apple-touch-icon. Matches the favicon: reads
 * `public/brand/logo-mark.svg` so updating the brand file propagates
 * to iOS home-screen shortcuts too.
 */

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';
export const dynamic = 'force-static';

export default async function AppleIcon() {
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
        <img src={dataUrl} width={180} height={180} alt="" />
      </div>
    ),
    { ...size },
  );
}
