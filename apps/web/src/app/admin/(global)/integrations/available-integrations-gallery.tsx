import type { DriverDescriptor } from '@weavestream/shared';
import { Panel } from '../../../../components/ui';

const TILE_BG = '#212121';
const LABEL_COLOR = '#3b82f6';
const TILE_SIZE = 128;
const TILE_RADIUS = 28;

/**
 * Non-interactive gallery of integration drivers the platform supports.
 * Tile background and label colors are fixed so vendor marks stay legible
 * in both app color themes.
 */
export function AvailableIntegrationsGallery({
  drivers,
}: {
  drivers: DriverDescriptor[];
}) {
  const sorted = [...drivers].sort((a, b) => a.label.localeCompare(b.label));

  if (sorted.length === 0) return null;

  return (
    <Panel title="Available integrations">
      <p
        style={{
          margin: '0 0 16px',
          fontSize: 12.5,
          color: 'var(--muted)',
          maxWidth: 560,
        }}
      >
        Connectors you can add from <strong>New integration</strong>. 
      </p>
      <ul
        role="list"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 28,
          listStyle: 'none',
          margin: 0,
          padding: 0,
        }}
      >
        {sorted.map((d) => (
          <li
            key={d.key}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
              width: TILE_SIZE,
              textAlign: 'center',
            }}
          >
            <div
              aria-hidden
              style={{
                width: TILE_SIZE,
                height: TILE_SIZE,
                borderRadius: TILE_RADIUS,
                background: TILE_BG,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 16,
                boxSizing: 'border-box',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- public SVG wordmarks; next/image SVG needs config */}
              <img
                src={`/integrations/drivers/${d.key}.svg`}
                alt=""
                width={200}
                height={60}
                style={{
                  width: '100%',
                  height: 'auto',
                  maxHeight: 52,
                  objectFit: 'contain',
                  display: 'block',
                }}
              />
            </div>
            <span
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: LABEL_COLOR,
                lineHeight: 1.25,
              }}
            >
              {d.label}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
