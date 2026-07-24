'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  integrationCompletenessResponseSchema,
  integrationGapsPageSchema,
  type IntegrationCompanyMappingDto,
  type IntegrationCompletenessResponse,
  type IntegrationGapRow,
  type IntegrationResourceDto,
} from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import { Btn, Tag } from '../../../../../components/ui';
import { FormattedDateTime } from '../../../../../lib/timezone-context';

const CATEGORIES = [
  ['synchronizedCurrent', 'Synchronized/current', 'ok'],
  ['manuallyDocumented', 'Manually documented', 'info'],
  ['secretBlocked', 'Secret-blocked', 'warn'],
  ['missing', 'Missing', 'default'],
  ['stale', 'Stale', 'warn'],
  ['synchronizationError', 'Synchronization error', 'danger'],
] as const;

export function CompletenessTab({
  integrationId,
  mappings,
  resources,
}: {
  integrationId: string;
  mappings: IntegrationCompanyMappingDto[];
  resources: IntegrationResourceDto[];
}) {
  const [mappingId, setMappingId] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [summary, setSummary] = useState<IntegrationCompletenessResponse | null>(null);
  const [gaps, setGaps] = useState<IntegrationGapRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Monotonic scope generation, bumped whenever the filters change and on
  // unmount. `loadMore` captures it at request time so a page that lands
  // after the operator moved the filters can be dropped: its rows would be
  // appended to a different scope's list, and its cursor would keep paging
  // the scope that is no longer on screen.
  const scopeRef = useRef(0);

  useEffect(() => {
    scopeRef.current += 1;
    const scope = scopeRef.current;
    (async () => {
      setLoading(true);
      setLoadingMore(false);
      setError(null);
      const query = scopeQuery(mappingId, resourceId);
      try {
        const [summaryResult, gapsResult] = await Promise.all([
          apiFetch(`/admin/integrations/${integrationId}/completeness${query}`),
          apiFetch(`/admin/integrations/${integrationId}/gaps${appendQuery(query, 'resolution=active&limit=50')}`),
        ]);
        if (scopeRef.current !== scope) return;
        setLoading(false);
        if (!summaryResult.ok || !gapsResult.ok) {
          setError(problemMessage(summaryResult.problem ?? gapsResult.problem));
          return;
        }
        const parsedSummary = integrationCompletenessResponseSchema.safeParse(summaryResult.data);
        const parsedGaps = integrationGapsPageSchema.safeParse(gapsResult.data);
        if (!parsedSummary.success || !parsedGaps.success) {
          setError('The completeness response was invalid.');
          return;
        }
        setSummary(parsedSummary.data);
        setGaps(parsedGaps.data.items);
        setNextCursor(parsedGaps.data.nextCursor);
      } catch {
        // apiFetch rethrows non-abort network failures — don't leave the tab
        // stuck on "Loading completeness…" with no error and no way to retry.
        if (scopeRef.current !== scope) return;
        setLoading(false);
        setError(problemMessage(null));
      }
    })();
    return () => { scopeRef.current += 1; };
  }, [integrationId, mappingId, resourceId]);

  async function loadMore() {
    if (!nextCursor) return;
    const scope = scopeRef.current;
    setLoadingMore(true);
    const query = appendQuery(
      scopeQuery(mappingId, resourceId),
      `resolution=active&limit=50&cursor=${encodeURIComponent(nextCursor)}`,
    );
    try {
      const result = await apiFetch(`/admin/integrations/${integrationId}/gaps${query}`);
      // Filters moved while this page was in flight: the effect for the new
      // scope has already reset the list and the button, so drop this page
      // rather than appending it to a scope it does not belong to.
      if (scopeRef.current !== scope) return;
      setLoadingMore(false);
      const parsed = result.ok ? integrationGapsPageSchema.safeParse(result.data) : null;
      if (!parsed?.success) {
        setError(problemMessage(result.problem));
        return;
      }
      setGaps((current) => [...current, ...parsed.data.items]);
      setNextCursor(parsed.data.nextCursor);
    } catch {
      // Same rethrow contract as the filter effect — a network failure must
      // not leave "Load more" spinning and permanently disabled.
      if (scopeRef.current !== scope) return;
      setLoadingMore(false);
      setError(problemMessage(null));
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <header>
        <h3 style={{ margin: 0, fontSize: 14 }}>Reconstruction completeness</h3>
        <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 12.5 }}>
          Current persisted evaluation results. Missing or failed evaluations are never treated as current.
        </p>
      </header>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label style={filterLabel}>Organization mapping
          <select aria-label="Organization mapping" value={mappingId} onChange={(event) => setMappingId(event.target.value)} style={selectStyle}>
            <option value="">All mappings</option>
            {mappings.map((mapping) => <option key={mapping.id} value={mapping.id}>{mapping.companyName ?? 'Unmapped organization'}</option>)}
          </select>
        </label>
        <label style={filterLabel}>Resource
          <select aria-label="Resource" value={resourceId} onChange={(event) => setResourceId(event.target.value)} style={selectStyle}>
            <option value="">All resources</option>
            {resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.resourceLabel}</option>)}
          </select>
        </label>
      </div>
      {loading ? <Tag tone="default">Loading completeness…</Tag> : error ? (
        <div role="alert" style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>
      ) : summary ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
            {CATEGORIES.map(([key, label, tone]) => (
              <div key={key} style={{ border: '1px solid var(--line)', borderRadius: 7, padding: 10 }}>
                <Tag tone={tone}>{label}</Tag>
                <div style={{ marginTop: 7, fontSize: 22, fontFamily: 'var(--font-mono)' }}>{summary.counts[key]}</div>
              </div>
            ))}
          </div>
          {summary.rows.length > 0 && (
            <section>
              <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>Per mapping and resource</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 8 }}>
                {summary.rows.map((row) => (
                  <article
                    key={row.id}
                    aria-label={`${row.companyName} ${row.resourceLabel} completeness`}
                    style={{ border: '1px solid var(--line)', borderRadius: 7, padding: 10 }}
                  >
                    <div style={{ display: 'flex', gap: 7, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 13 }}>{row.companyName}</strong>
                      <span style={{ color: 'var(--muted)', fontSize: 12 }}>{row.resourceLabel}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 8 }}>
                      {CATEGORIES.map(([key, label, tone]) => (
                        <Tag key={key} tone={tone}>{row.counts[key]} {label}</Tag>
                      ))}
                    </div>
                    <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: 11.5 }}>
                      Evaluated <FormattedDateTime value={row.evaluatedAt} />
                      {' · '}Last successful sync{' '}
                      {row.lastSuccessfulSyncAt
                        ? <FormattedDateTime value={row.lastSuccessfulSyncAt} />
                        : 'Never'}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
          {summary.rows.length === 0 && gaps.length === 0 ? (
            <div style={emptyStyle}>No successful completeness evaluation exists for this scope.</div>
          ) : (
            <section>
              <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>Active gaps</h4>
              {gaps.length === 0 ? <div style={emptyStyle}>No active gaps.</div> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {gaps.map((gap) => (
                    <div key={gap.id} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 10, fontSize: 12.5 }}>
                      <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Tag tone={gap.kind === 'synchronization_error' ? 'danger' : gap.kind === 'secret_blocked' ? 'warn' : 'default'}>
                          {gap.kind.replaceAll('_', ' ')}
                        </Tag>
                        <strong>{gap.companyName}</strong><span style={{ color: 'var(--muted)' }}>{gap.resourceLabel}</span>
                      </div>
                      <p style={{ margin: '7px 0 0' }}>{gap.message}</p>
                      {gap.target && (gap.target.targetHref ? (
                        <Link href={gap.target.targetHref} style={{ display: 'inline-block', marginTop: 6, color: 'var(--accent)' }}>{gap.target.targetLabel}</Link>
                      ) : <span style={{ display: 'block', marginTop: 6, color: 'var(--muted)' }}>{gap.target.targetLabel}</span>)}
                    </div>
                  ))}
                </div>
              )}
              {nextCursor && <Btn kind="outline" size="sm" onClick={loadMore} loading={loadingMore} style={{ marginTop: 10 }}>Load more</Btn>}
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}

function scopeQuery(mappingId: string, resourceId: string): string {
  const query = new URLSearchParams();
  if (mappingId) query.set('mappingId', mappingId);
  if (resourceId) query.set('resourceId', resourceId);
  return query.size ? `?${query}` : '';
}
function appendQuery(existing: string, addition: string): string {
  return `${existing || '?'}${existing ? '&' : ''}${addition}`;
}
function problemMessage(problem: unknown): string {
  if (problem && typeof problem === 'object') {
    const value = problem as { detail?: unknown; title?: unknown };
    if (typeof value.detail === 'string' && value.detail.length <= 512) return value.detail;
    if (typeof value.title === 'string' && value.title.length <= 512) return value.title;
  }
  return 'Could not load completeness.';
}
const filterLabel: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: 'var(--muted)' };
const selectStyle: React.CSSProperties = { minWidth: 210, height: 32, border: '1px solid var(--line)', borderRadius: 5, background: 'var(--panel-2)', color: 'var(--text)', padding: '0 8px' };
const emptyStyle: React.CSSProperties = { padding: 18, border: '1px dashed var(--line-2)', borderRadius: 6, color: 'var(--muted)', fontSize: 12.5 };
