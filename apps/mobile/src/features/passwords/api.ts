import {
  isStepUpProblem,
  tiptapToPlaintext,
  totpConfigSchema,
  type CreatePasswordInput,
  type PasswordDetail,
  type PasswordFolderSchema,
  type PasswordRevealResponse,
  type PasswordSummary,
  type PasswordTotpResponse,
  type UpdatePasswordInput,
} from '@weavestream/shared';
import { ApiError, StepUpCancelledError, apiFetch } from '../../lib/api';

/**
 * Fetchers + pure payload builders for the passwords feature.
 *
 * Responses are consumed via the shared TypeScript types, not runtime
 * Zod parses — same stance as the desktop client. Two standing rules
 * from the build plan apply to everything in this file:
 *
 *  - The detail response is secret-bearing (`notes` arrives decrypted)
 *    and reveal/TOTP responses are secrets outright. None of them may
 *    ever be persisted; reveal/TOTP additionally never enter the React
 *    Query cache (they are imperative calls, not queries).
 *  - `PATCH` payloads are built from **edited fields only**. An
 *    untouched field is omitted, never sent as `null` — `null` is a
 *    deliberate "clear this value" instruction.
 */

// ─── Fetchers ──────────────────────────────────────────────────────

export async function fetchPasswords(
  companyId: string,
  opts?: { includeArchived?: boolean },
): Promise<PasswordSummary[]> {
  // `archived=true` means "INCLUDE archived", not "archived only" —
  // callers wanting the archive view filter `archivedAt != null`.
  const qs = opts?.includeArchived ? '?archived=true' : '';
  const res = await apiFetch<{ items: PasswordSummary[] }>(
    `/companies/${companyId}/passwords${qs}`,
  );
  return res.items;
}

export function fetchPasswordDetail(
  companyId: string,
  passwordId: string,
): Promise<PasswordDetail> {
  return apiFetch<PasswordDetail>(
    `/companies/${companyId}/passwords/${passwordId}`,
  );
}

export async function fetchPasswordFolders(
  companyId: string,
): Promise<PasswordFolderSchema[]> {
  const res = await apiFetch<{ items: PasswordFolderSchema[] }>(
    `/companies/${companyId}/password-folders`,
  );
  return res.items;
}

/**
 * Minimal wire slice of the relations endpoint's `LinkedItem` — same
 * local-interface precedent as `CompanyRow` in org-scope. The server
 * also sends `href`, but that is a desktop path; mobile builds its own
 * navigation from `kind` + `id`.
 */
export interface RelatedItem {
  relationId: string;
  kind: 'asset' | 'article' | 'password';
  id: string;
  title: string;
  subtitle: string | null;
}

export interface RelatedGroups {
  asset: RelatedItem[];
  article: RelatedItem[];
  password: RelatedItem[];
}

export async function fetchPasswordRelations(
  companyId: string,
  passwordId: string,
): Promise<RelatedGroups> {
  const res = await apiFetch<{ groups?: Partial<RelatedGroups> }>(
    `/companies/${companyId}/relations?entityType=password&entityId=${passwordId}`,
  );
  return {
    asset: res.groups?.asset ?? [],
    article: res.groups?.article ?? [],
    password: res.groups?.password ?? [],
  };
}

export function createPassword(
  companyId: string,
  input: CreatePasswordInput,
): Promise<PasswordDetail> {
  return apiFetch<PasswordDetail>(`/companies/${companyId}/passwords`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updatePassword(
  companyId: string,
  passwordId: string,
  input: UpdatePasswordInput,
): Promise<PasswordDetail> {
  return apiFetch<PasswordDetail>(
    `/companies/${companyId}/passwords/${passwordId}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
}

/** DELETE archives — there is no hard delete anywhere in this API. */
export function archivePassword(
  companyId: string,
  passwordId: string,
): Promise<PasswordSummary> {
  return apiFetch<PasswordSummary>(
    `/companies/${companyId}/passwords/${passwordId}`,
    { method: 'DELETE' },
  );
}

export function restorePassword(
  companyId: string,
  passwordId: string,
): Promise<PasswordSummary> {
  return apiFetch<PasswordSummary>(
    `/companies/${companyId}/passwords/${passwordId}/restore`,
    { method: 'POST' },
  );
}

/**
 * Audited server-side on every call and throttled at 30/min per user —
 * callers reuse an in-memory revealed value rather than re-calling.
 */
export function revealPassword(
  companyId: string,
  passwordId: string,
  body?: { reason?: string },
): Promise<PasswordRevealResponse> {
  return apiFetch<PasswordRevealResponse>(
    `/companies/${companyId}/passwords/${passwordId}/reveal`,
    { method: 'POST', body: JSON.stringify(body ?? {}) },
  );
}

/** Throttled at 60/min per user; deliberately un-audited (the UI polls). */
export function fetchTotpCode(
  companyId: string,
  passwordId: string,
): Promise<PasswordTotpResponse> {
  return apiFetch<PasswordTotpResponse>(
    `/companies/${companyId}/passwords/${passwordId}/totp`,
    { method: 'POST' },
  );
}

// ─── Error classifiers ─────────────────────────────────────────────

function problemErrorCode(problem: unknown): string | null {
  if (typeof problem !== 'object' || problem === null) return null;
  const value = (problem as Record<string, unknown>).error;
  return typeof value === 'string' ? value : null;
}

/**
 * `requireReasonToView` reveal attempted without a reason. The
 * discriminator is the problem's `error` extension — NOT the RFC-7807
 * `code` field the step-up problems use.
 */
export function isReasonRequired(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 400 &&
    problemErrorCode(err.problem) === 'ReasonRequired'
  );
}

/**
 * A `restrictedToUserIds` denial. The server sends a plain 403 with no
 * stable code, so this is "403 that is neither a step-up demand nor the
 * user declining one". (CLIENT_USERs get a 404 instead — deliberately
 * no existence oracle — which surfaces as the generic not-found state.)
 */
export function isRestrictedError(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 403) return false;
  if (err instanceof StepUpCancelledError) return false;
  return !isStepUpProblem(err.problem);
}

// ─── Form model + payload builders ─────────────────────────────────

export type TotpFormState =
  /** No secret stored and none entered. */
  | { kind: 'none' }
  /** Edit only: leave the stored TOTP config untouched (omit the key). */
  | { kind: 'keep' }
  /** Store this secret (create, add, or replace). */
  | { kind: 'set'; secret: string }
  /** Edit only: clear the stored TOTP config (send null). */
  | { kind: 'remove' };

export interface PasswordFormValues {
  name: string;
  username: string;
  /** Empty string on edit = keep the current password (key omitted). */
  password: string;
  url: string;
  notes: string;
  totp: TotpFormState;
}

/** Mirrors the schema's transform so the wire value matches validation. */
function normalizeTotpSecret(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/**
 * Client-side pre-check for the TOTP secret field, reusing the shared
 * schema rather than a re-typed regex. Returns the normalized secret on
 * success so the form can show what will actually be stored.
 */
export function validateTotpSecret(
  raw: string,
): { ok: true; secret: string } | { ok: false; message: string } {
  const parsed = totpConfigSchema.shape.secret.safeParse(raw);
  if (parsed.success) return { ok: true, secret: parsed.data };
  return {
    ok: false,
    message: 'Enter the base32 secret from the authenticator setup (at least 8 characters).',
  };
}

/** Desktop parity: new/replaced secrets are stored as SHA1 / 6 / 30. */
function totpPayload(secret: string) {
  return {
    secret: normalizeTotpSecret(secret),
    algorithm: 'SHA1' as const,
    digits: 6,
    period: 30,
  };
}

/**
 * Notes render and edit as plaintext on mobile. Strings pass through
 * verbatim; Tiptap docs are flattened exactly the way the desktop
 * detail page flattens them (`renderNotes`). Never HTML.
 */
export function notesToPlaintext(notes: PasswordDetail['notes'] | undefined): string {
  if (notes == null) return '';
  if (typeof notes === 'string') return notes;
  return tiptapToPlaintext(notes);
}

export function buildCreatePayload(form: PasswordFormValues): CreatePasswordInput {
  const payload: CreatePasswordInput = {
    name: form.name.trim(),
    password: form.password,
  };
  const username = form.username.trim();
  if (username) payload.username = username;
  const url = form.url.trim();
  if (url) payload.url = url;
  if (form.notes.trim()) payload.notes = form.notes;
  if (form.totp.kind === 'set') payload.totp = totpPayload(form.totp.secret);
  // Everything else — folderId, tags, visibleToClients (server defaults
  // to false: secure-by-default), requireReasonToView, expiry — is
  // deliberately not settable from mobile v1.
  return payload;
}

/**
 * Diff-only PATCH body: a key appears iff the user changed that field.
 * `null` means "clear", omission means "keep" — sending `null` for an
 * untouched field would destroy data (same trap as asset fieldValues).
 */
export function buildUpdatePayload(
  original: PasswordDetail,
  form: PasswordFormValues,
): UpdatePasswordInput {
  const payload: UpdatePasswordInput = {};

  const name = form.name.trim();
  if (name && name !== original.name) payload.name = name;

  const username = form.username.trim() || null;
  if (username !== (original.username ?? null)) payload.username = username;

  const url = form.url.trim() || null;
  if (url !== (original.url ?? null)) payload.url = url;

  // Compared against the same plaintext projection the form was seeded
  // with, so an untouched Tiptap-doc note is omitted (and survives)
  // rather than being rewritten as a string.
  if (form.notes !== notesToPlaintext(original.notes)) {
    payload.notes = form.notes.trim() ? form.notes : null;
  }

  if (form.password.length > 0) payload.password = form.password;

  if (form.totp.kind === 'set') payload.totp = totpPayload(form.totp.secret);
  else if (form.totp.kind === 'remove') payload.totp = null;
  // 'keep' / 'none' → key omitted.

  return payload;
}
