'use client';

import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { Icon } from './icon';
import { Select } from './form';

/**
 * Reusable numbered-page pagination. Works with either server-rendered
 * URL navigation (provide `buildHref`) or a client component (provide
 * `onPageChange`). At least one must be supplied.
 *
 * Renders "Showing X–Y of N" on the left and a windowed list of page
 * numbers (first, last, current ±2, ellipses between gaps) with Prev /
 * Next controls on the right. Hides entirely when `total <= pageSize`.
 */
export type PaginationProps = {
  page: number;
  pageSize: number;
  total: number;
  buildHref?: (page: number, pageSize: number) => string;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
  style?: CSSProperties;
};

export function Pagination({
  page,
  pageSize,
  total,
  buildHref,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions,
  style,
}: PaginationProps) {
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const safePage = Math.min(Math.max(page, 1), totalPages);
  if (total === 0) return null;
  if (totalPages <= 1 && !pageSizeOptions) return null;

  const from = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const to = Math.min(safePage * pageSize, total);
  const window = buildPageWindow(safePage, totalPages);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '10px 14px',
        borderTop: '1px solid var(--line)',
        flexWrap: 'wrap',
        ...style,
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 11.5,
          fontFamily: 'var(--font-mono)',
          color: 'var(--dim)',
        }}
      >
        <span>
          Showing {from.toLocaleString()}–{to.toLocaleString()} of{' '}
          {total.toLocaleString()}
        </span>
        {pageSizeOptions && pageSizeOptions.length > 0 && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span style={{ color: 'var(--muted)' }}>per page</span>
            <Select
              value={pageSize}
              onChange={(e) => onPageSizeChange?.(Number(e.target.value))}
              style={{ width: 64, height: 26, padding: '0 6px', fontSize: 12 }}
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </span>
        )}
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <PageButton
            disabled={safePage <= 1}
            buildHref={buildHref}
            onPageChange={onPageChange}
            page={safePage - 1}
            pageSize={pageSize}
            aria-label="Previous page"
          >
            <span style={{ transform: 'rotate(180deg)', display: 'inline-flex' }}>
              <Icon.chevron size={11} />
            </span>
            <span style={{ marginLeft: 4 }}>Prev</span>
          </PageButton>
          {window.map((item, idx) =>
            item === 'gap' ? (
              <span
                key={`gap-${idx}`}
                style={{
                  padding: '0 4px',
                  color: 'var(--dim)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                }}
              >
                …
              </span>
            ) : (
              <PageButton
                key={item}
                active={item === safePage}
                buildHref={buildHref}
                onPageChange={onPageChange}
                page={item}
                pageSize={pageSize}
                aria-label={`Page ${item}`}
                aria-current={item === safePage ? 'page' : undefined}
              >
                {item}
              </PageButton>
            ),
          )}
          <PageButton
            disabled={safePage >= totalPages}
            buildHref={buildHref}
            onPageChange={onPageChange}
            page={safePage + 1}
            pageSize={pageSize}
            aria-label="Next page"
          >
            <span style={{ marginRight: 4 }}>Next</span>
            <Icon.chevron size={11} />
          </PageButton>
        </div>
      )}
    </div>
  );
}

function PageButton({
  page,
  pageSize,
  active,
  disabled,
  buildHref,
  onPageChange,
  children,
  ...aria
}: {
  page: number;
  pageSize: number;
  active?: boolean;
  disabled?: boolean;
  buildHref?: (page: number, pageSize: number) => string;
  onPageChange?: (page: number) => void;
  children: ReactNode;
  'aria-label'?: string;
  'aria-current'?: 'page';
}) {
  const baseStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 28,
    height: 28,
    padding: '0 8px',
    fontSize: 12,
    fontFamily: 'var(--font-mono)',
    fontWeight: active ? 600 : 500,
    background: active ? 'var(--accent-fill)' : 'transparent',
    color: active
      ? 'var(--accent-fill-ink)'
      : disabled
        ? 'var(--dim)'
        : 'var(--text-2)',
    border: `1px solid ${active ? 'transparent' : 'var(--line-2)'}`,
    borderRadius: 5,
    cursor: disabled ? 'not-allowed' : active ? 'default' : 'pointer',
    opacity: disabled && !active ? 0.5 : 1,
    textDecoration: 'none',
    transition: 'background-color 120ms ease, color 120ms ease',
  };

  if (active) {
    return (
      <span
        style={baseStyle}
        aria-label={aria['aria-label']}
        aria-current={aria['aria-current']}
      >
        {children}
      </span>
    );
  }

  if (disabled || !buildHref) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && onPageChange?.(page)}
        style={baseStyle}
        aria-label={aria['aria-label']}
        aria-current={aria['aria-current']}
      >
        {children}
      </button>
    );
  }

  return (
    <Link
      href={buildHref(page, pageSize)}
      style={baseStyle}
      aria-label={aria['aria-label']}
      aria-current={aria['aria-current']}
      scroll={false}
      onClick={() => onPageChange?.(page)}
    >
      {children}
    </Link>
  );
}

/**
 * Produces a list like [1, 'gap', 4, 5, 6, 7, 8, 'gap', 42] for the
 * page number strip. Always includes first and last pages and a window
 * of ±2 around the current page; ellipses fill any gap > 1.
 */
function buildPageWindow(
  current: number,
  total: number,
): Array<number | 'gap'> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const window = new Set<number>([1, total, current]);
  for (let delta = 1; delta <= 2; delta += 1) {
    if (current - delta >= 1) window.add(current - delta);
    if (current + delta <= total) window.add(current + delta);
  }
  const sorted = Array.from(window).sort((a, b) => a - b);
  const out: Array<number | 'gap'> = [];
  let prev = 0;
  for (const n of sorted) {
    if (n - prev > 1) out.push('gap');
    out.push(n);
    prev = n;
  }
  return out;
}
