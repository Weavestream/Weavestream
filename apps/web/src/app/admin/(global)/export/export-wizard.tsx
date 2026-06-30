'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { apiFetch } from '../../../../lib/api';
import { ensureStepUp } from '../../../../lib/step-up';
import {
  Btn,
  Field,
  Icon,
  Input,
  Panel,
  Tag,
  CompanyPicker,
  type CompanyPickerValue,
} from '../../../../components/ui';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JobStatusResponse {
  status: 'waiting' | 'active' | 'completed' | 'failed' | 'unknown';
  downloadUrl?: string;
  error?: string;
}

interface TriggerResponse {
  jobId: string;
  exportId: string;
}

type ExportStatus = 'working' | 'ready' | 'failed' | 'expired';

/**
 * Per-row record persisted in localStorage so a refresh doesn't lose
 * recent exports. We deliberately do NOT persist the `downloadUrl` — it
 * resolves to a same-origin streaming endpoint (`/export/job/:id/download`)
 * that the API re-validates against the storage backend on every click,
 * so we just keep the `jobId` (BullMQ knows the actual storage key).
 */
interface ExportRecord {
  jobId: string;
  exportId: string;
  companyId: string;
  companyName: string;
  startedAt: number; // ms epoch
  includePasswords: boolean;
  pdfPasswordProtected: boolean;
  status: ExportStatus;
  error?: string;
}

const POLL_INTERVAL_MS = 2000;
/**
 * Drop persisted records older than this on mount. The PDF file is
 * deleted from storage after 4 hours and the BullMQ job is evicted
 * after ~5 hours, so anything older than a day is guaranteed
 * unrecoverable.
 */
const RECORD_TTL_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'weavestream:exports:recent';
const MAX_RECORDS = 25;

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

function loadRecords(): ExportRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return (parsed as ExportRecord[])
      .filter(
        (r) =>
          r &&
          typeof r.jobId === 'string' &&
          typeof r.companyId === 'string' &&
          typeof r.startedAt === 'number' &&
          now - r.startedAt < RECORD_TTL_MS,
      )
      .slice(0, MAX_RECORDS);
  } catch {
    return [];
  }
}

function saveRecords(records: ExportRecord[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(records.slice(0, MAX_RECORDS)),
    );
  } catch {
    // Quota exceeded or storage disabled — best-effort only.
  }
}

// ---------------------------------------------------------------------------
// Vault archive wizard
// ---------------------------------------------------------------------------

function VaultArchiveWizard() {
  // Form state
  const [company, setCompany] = useState<CompanyPickerValue | null>(null);
  const [includePasswords, setIncludePasswords] = useState(false);
  const [pdfPassword, setPdfPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [justSubmitted, setJustSubmitted] = useState<string | null>(null);

  // Records list (rehydrated from localStorage on mount)
  const [records, setRecords] = useState<ExportRecord[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Per-record "downloading" busy flag, keyed by jobId.
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Latest records cached on a ref so the polling tick (started ONCE)
  // always reads the current list without retriggering on every change.
  const recordsRef = useRef<ExportRecord[]>([]);
  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  // ---- Hydrate + persist ----
  useEffect(() => {
    setRecords(loadRecords());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveRecords(records);
  }, [records, hydrated]);

  // ---- Background poll for any 'working' rows ----
  const pollAll = useCallback(async () => {
    const working = recordsRef.current.filter((r) => r.status === 'working');
    if (working.length === 0) return;

    const updates = await Promise.all(
      working.map(async (rec) => {
        const poll = await apiFetch<JobStatusResponse>(
          `/export/job/${rec.jobId}`,
        );
        if (!poll.ok || !poll.data) return null;
        return { jobId: rec.jobId, ...poll.data };
      }),
    );

    setRecords((prev) =>
      prev.map((rec) => {
        const u = updates.find((x) => x && x.jobId === rec.jobId);
        if (!u) return rec;
        if (u.status === 'completed') {
          return {
            ...rec,
            status: 'ready',
            error: undefined,
          };
        }
        if (u.status === 'failed') {
          return { ...rec, status: 'failed', error: u.error ?? 'Export failed.' };
        }
        if (u.status === 'unknown') {
          return {
            ...rec,
            status: 'expired',
            error: 'Export job is no longer tracked.',
          };
        }
        return rec; // waiting / active — still working
      }),
    );
  }, []);

  useEffect(() => {
    pollTimerRef.current = setInterval(() => {
      void pollAll();
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, [pollAll]);

  // ---- Submit a new export ----
  async function submit() {
    if (!company || submitting) return;
    setSubmitting(true);
    setSubmitError('');
    setJustSubmitted(null);

    const res = await apiFetch<TriggerResponse>(`/export/company/${company.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        includePasswords,
        ...(pdfPassword ? { pdfPassword } : {}),
      }),
    });

    if (!res.ok || !res.data) {
      setSubmitError('Failed to start export. Please try again.');
      setSubmitting(false);
      return;
    }

    const newRecord: ExportRecord = {
      jobId: res.data.jobId,
      exportId: res.data.exportId,
      companyId: company.id,
      companyName: company.name,
      startedAt: Date.now(),
      includePasswords,
      pdfPasswordProtected: pdfPassword.length > 0,
      status: 'working',
    };
    setRecords((prev) => [newRecord, ...prev].slice(0, MAX_RECORDS));
    // Kick an immediate poll so the user gets feedback faster than the
    // 2-second tick on small exports.
    void pollAll();

    // Reset form for the next one but keep success indicator briefly
    // so the user knows the job landed.
    setJustSubmitted(company.name);
    setCompany(null);
    setIncludePasswords(false);
    setPdfPassword('');
    setSubmitting(false);
    window.setTimeout(() => setJustSubmitted(null), 4000);
  }

  // ---- Download (always re-fetch a fresh URL) ----
  async function download(rec: ExportRecord) {
    setDownloadingId(rec.jobId);
    const poll = await apiFetch<JobStatusResponse>(`/export/job/${rec.jobId}`);
    setDownloadingId(null);
    if (!poll.ok || !poll.data) {
      setRecords((prev) =>
        prev.map((r) =>
          r.jobId === rec.jobId
            ? { ...r, status: 'failed', error: 'Could not refresh download link.' }
            : r,
        ),
      );
      return;
    }
    if (poll.data.status === 'completed' && poll.data.downloadUrl) {
      // Vault PDFs may contain plaintext passwords — the download
      // endpoint requires step-up. Open the re-auth modal first (a 403
      // on a new-tab navigation can't be surfaced cleanly), then open.
      const ready = await ensureStepUp();
      if (!ready) return;
      window.open(poll.data.downloadUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    if (poll.data.status === 'failed' || poll.data.status === 'unknown') {
      setRecords((prev) =>
        prev.map((r) =>
          r.jobId === rec.jobId
            ? {
                ...r,
                status: poll.data!.status === 'unknown' ? 'expired' : 'failed',
                error:
                  poll.data!.error ??
                  (poll.data!.status === 'unknown'
                    ? 'Export has been evicted. Please re-trigger.'
                    : 'Export failed.'),
              }
            : r,
        ),
      );
    }
  }

  function dismiss(jobId: string) {
    setRecords((prev) => prev.filter((r) => r.jobId !== jobId));
  }

  function clearAll() {
    if (records.every((r) => r.status !== 'working')) {
      setRecords([]);
      return;
    }
    // Don't yank in-flight rows; only sweep terminal ones.
    setRecords((prev) => prev.filter((r) => r.status === 'working'));
  }

  const hasTerminal = records.some((r) => r.status !== 'working');

  // ---- Render ----
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* New export form */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr)',
          gap: 16,
          maxWidth: 560,
        }}
      >
        <Field label="Company" htmlFor="export-company-picker">
          <CompanyPicker
            id="export-company-picker"
            value={company}
            onChange={setCompany}
            placeholder="Search for a company…"
          />
        </Field>

        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            cursor: 'pointer',
            fontSize: 13,
            padding: '10px 12px',
            border: '1px solid var(--line)',
            borderRadius: 6,
            background: includePasswords ? 'var(--danger-soft)' : 'var(--panel-2)',
            transition: 'background 120ms',
          }}
        >
          <input
            type="checkbox"
            checked={includePasswords}
            onChange={(e) => setIncludePasswords(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span>
            <strong>Include passwords (plaintext)</strong>
            <br />
            <span style={{ color: 'var(--text-2)' }}>
              Password values, notes, and TOTP secrets will appear in clear text.
              Handle the PDF with extreme care.
            </span>
          </span>
        </label>

        <Field
          label="PDF password (optional)"
          htmlFor="pdf-password"
          help="If set, the PDF is AES-encrypted and requires this password to open."
        >
          <Input
            id="pdf-password"
            type="password"
            value={pdfPassword}
            onChange={(e) => setPdfPassword(e.target.value)}
            placeholder="Leave blank for no encryption"
            autoComplete="new-password"
          />
        </Field>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Btn
            kind="primary"
            size="md"
            disabled={!company || submitting}
            icon={Icon.archive}
            onClick={submit}
          >
            {submitting ? 'Queuing…' : 'Generate PDF'}
          </Btn>
          {justSubmitted && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                color: 'var(--ok)',
              }}
            >
              <Icon.check size={14} /> Queued for {justSubmitted}
            </span>
          )}
          {submitError && (
            <span style={{ fontSize: 12, color: 'var(--danger)' }}>
              {submitError}
            </span>
          )}
        </div>
      </div>

      {/* Recent exports list */}
      {records.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
            }}
          >
            <h3
              style={{
                margin: 0,
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--text-2)',
                letterSpacing: 0.3,
                textTransform: 'uppercase',
              }}
            >
              Recent exports ({records.length})
            </h3>
            {hasTerminal && (
              <button
                type="button"
                onClick={clearAll}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-2)',
                  fontSize: 12,
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                Clear completed
              </button>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {records.map((rec) => (
              <ExportRow
                key={rec.jobId}
                rec={rec}
                downloading={downloadingId === rec.jobId}
                onDownload={() => download(rec)}
                onDismiss={() => dismiss(rec.jobId)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single export row
// ---------------------------------------------------------------------------

function ExportRow({
  rec,
  downloading,
  onDownload,
  onDismiss,
}: {
  rec: ExportRecord;
  downloading: boolean;
  onDownload: () => void;
  onDismiss: () => void;
}) {
  const startedLabel = useMemo(() => formatRelative(rec.startedAt), [rec.startedAt]);

  const rowStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: 12,
    alignItems: 'center',
    padding: '10px 14px',
    border: '1px solid var(--line)',
    borderRadius: 8,
    background:
      rec.status === 'failed' || rec.status === 'expired'
        ? 'var(--panel-2)'
        : 'var(--panel)',
  };

  return (
    <div style={rowStyle}>
      {/* Left: name + metadata */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 0,
          }}
        >
          <strong
            style={{
              fontSize: 14,
              color: 'var(--text-1)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {rec.companyName}
          </strong>
          <StatusBadge status={rec.status} />
          {rec.includePasswords && (
            <Tag tone="danger" mono={false}>
              <Icon.key size={11} /> plaintext
            </Tag>
          )}
          {rec.pdfPasswordProtected && (
            <Tag tone="info" mono={false}>
              <Icon.lock size={11} /> encrypted
            </Tag>
          )}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--text-2)',
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <span>Started {startedLabel}</span>
          {rec.status === 'failed' && rec.error && (
            <span style={{ color: 'var(--danger)' }}>{rec.error}</span>
          )}
          {rec.status === 'expired' && (
            <span style={{ color: 'var(--text-2)' }}>
              File deleted. Trigger a new export to re-generate.
            </span>
          )}
        </div>
      </div>

      {/* Right: actions */}
      <div style={{ display: 'flex', gap: 6 }}>
        {rec.status === 'working' && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--text-2)',
              padding: '0 6px',
            }}
          >
            <Spinner /> Generating…
          </span>
        )}
        {rec.status === 'ready' && (
          <>
            <Btn
              kind="primary"
              size="sm"
              icon={Icon.ext}
              loading={downloading}
              onClick={onDownload}
            >
              Download
            </Btn>
            <Btn
              kind="ghost"
              size="sm"
              icon={Icon.x}
              onClick={onDismiss}
              iconOnly
              title="Remove from list"
              aria-label="Remove from list"
            />
          </>
        )}
        {(rec.status === 'failed' || rec.status === 'expired') && (
          <Btn
            kind="ghost"
            size="sm"
            icon={Icon.trash}
            onClick={onDismiss}
          >
            Dismiss
          </Btn>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: ExportStatus }) {
  if (status === 'working') {
    return (
      <Tag tone="info" mono={false}>
        Working
      </Tag>
    );
  }
  if (status === 'ready') {
    return (
      <Tag tone="ok" mono={false}>
        Ready
      </Tag>
    );
  }
  if (status === 'failed') {
    return (
      <Tag tone="danger" mono={false}>
        Failed
      </Tag>
    );
  }
  return (
    <Tag tone="default" mono={false}>
      Expired
    </Tag>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      style={{
        width: 12,
        height: 12,
        borderRadius: '50%',
        border: '2px solid var(--line-2, var(--line))',
        borderTopColor: 'var(--accent, #6366f1)',
        animation: 'ws-spin 0.8s linear infinite',
        display: 'inline-block',
      }}
    />
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))} h ago`;
  return new Date(ts).toLocaleString();
}

// ---------------------------------------------------------------------------
// Main export page
// ---------------------------------------------------------------------------

export function ExportWizard() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Inline keyframes for the spinner — avoids touching the global stylesheet
          for a single 12px element. */}
      <style>{`@keyframes ws-spin { to { transform: rotate(360deg); } }`}</style>

      <Panel title="Vault archive (PDF)">
        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Generates a multi-page PDF containing all of a company&apos;s vault data — assets,
          articles, domains, memberships, uploads, and optionally passwords. Files are
          stored temporarily and deleted automatically after 4 hours.
        </p>
        <VaultArchiveWizard />
      </Panel>


    </div>
  );
}
