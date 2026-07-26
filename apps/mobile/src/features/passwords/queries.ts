import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_PASSWORD_GENERATOR_DEFAULTS,
  passwordGeneratorDefaultsSchema,
  type CreatePasswordInput,
  type PasswordGeneratorDefaults,
  type UpdatePasswordInput,
} from '@weavestream/shared';
import { apiFetch } from '../../lib/api';
import {
  archivePassword,
  createPassword,
  fetchPasswordDetail,
  fetchPasswordFolders,
  fetchPasswords,
  restorePassword,
  updatePassword,
} from './api';

/**
 * Query wiring for the passwords feature.
 *
 * Key discipline: everything password-shaped lives under the
 * `['passwords', companyId]` prefix so one invalidation covers list,
 * archived list, and details. None of these keys start with
 * `'org-scope'`/`'me'`, so the org switcher's predicate invalidation
 * (org-scope.tsx) evicts all of them automatically on a switch.
 *
 * Deliberately absent: reveal and TOTP. Those are imperative
 * `apiFetch` calls owned by their hooks — secret-bearing responses
 * never enter the query cache. The detail response (decrypted notes)
 * is cached in memory only; there is no persister in this app and none
 * may be added (CLAUDE.md).
 */

export const passwordKeys = {
  all: (companyId: string | null) => ['passwords', companyId] as const,
  list: (companyId: string | null) => ['passwords', companyId, 'list'] as const,
  archived: (companyId: string | null) =>
    ['passwords', companyId, 'archived'] as const,
  detail: (companyId: string | null, passwordId: string) =>
    ['passwords', companyId, 'detail', passwordId] as const,
};

export function usePasswords(companyId: string | null) {
  return useQuery({
    queryKey: passwordKeys.list(companyId),
    queryFn: () => fetchPasswords(companyId!),
    enabled: companyId !== null,
  });
}

/**
 * The archive view's rows. Only fetched while the Archived chip is
 * active (`enabled`); `archived=true` INCLUDES active rows, so the
 * archived-only projection happens in `select`.
 */
export function useArchivedPasswords(companyId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: passwordKeys.archived(companyId),
    queryFn: () => fetchPasswords(companyId!, { includeArchived: true }),
    select: (rows) => rows.filter((p) => p.archivedAt !== null),
    enabled: companyId !== null && enabled,
  });
}

export function usePasswordDetail(companyId: string | null, passwordId: string) {
  return useQuery({
    queryKey: passwordKeys.detail(companyId, passwordId),
    queryFn: () => fetchPasswordDetail(companyId!, passwordId),
    enabled: companyId !== null,
  });
}

export function usePasswordFolders(companyId: string | null) {
  return useQuery({
    queryKey: ['password-folders', companyId] as const,
    queryFn: () => fetchPasswordFolders(companyId!),
    enabled: companyId !== null,
  });
}

/**
 * Workspace generator defaults, with the shared constant as fallback
 * for both the not-loaded-yet and request-failed states — the
 * generator sheet must work in a server closet with a flaky radio.
 *
 * The parse lives in `select`, NOT in the render body: TanStack
 * memoizes the select result per data identity, so consumers get a
 * referentially stable object. A per-render `safeParse` returns a
 * fresh clone every time, and the generator sheet's reseed effect
 * depends on this object — a new identity per render put it in a
 * setState→render→new-identity loop the moment real settings loaded.
 */
export function useGeneratorDefaults(): PasswordGeneratorDefaults {
  const query = useQuery({
    queryKey: ['settings'] as const,
    queryFn: () => apiFetch<Record<string, unknown>>('/settings'),
    staleTime: 5 * 60_000,
    select: (data): PasswordGeneratorDefaults => {
      const parsed = passwordGeneratorDefaultsSchema.safeParse(
        data?.passwordGeneratorDefaults,
      );
      return parsed.success ? parsed.data : DEFAULT_PASSWORD_GENERATOR_DEFAULTS;
    },
  });
  return query.data ?? DEFAULT_PASSWORD_GENERATOR_DEFAULTS;
}

// ─── Mutations ─────────────────────────────────────────────────────

// Mutation hooks accept `string | null` because they mount before the
// org scope resolves; the non-null assertions hold because every
// trigger (New button, edit Save, archive/restore) only renders under
// a resolved org.

export function useCreatePassword(companyId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePasswordInput) => createPassword(companyId!, input),
    onSuccess: (detail) => {
      queryClient.setQueryData(passwordKeys.detail(companyId, detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: passwordKeys.all(companyId) });
    },
  });
}

export function useUpdatePassword(companyId: string | null, passwordId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePasswordInput) =>
      updatePassword(companyId!, passwordId, input),
    onSuccess: (detail) => {
      queryClient.setQueryData(passwordKeys.detail(companyId, passwordId), detail);
      void queryClient.invalidateQueries({ queryKey: passwordKeys.all(companyId) });
    },
  });
}

/**
 * Archive/restore return summaries; the detail key is deliberately NOT
 * seeded from them (a summary is missing `notes` and the TOTP config —
 * seeding would corrupt the cached detail shape). Invalidation alone
 * makes the mounted detail screen refetch and re-render its state.
 */
export function useArchivePassword(companyId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (passwordId: string) => archivePassword(companyId!, passwordId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: passwordKeys.all(companyId) });
    },
  });
}

export function useRestorePassword(companyId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (passwordId: string) => restorePassword(companyId!, passwordId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: passwordKeys.all(companyId) });
    },
  });
}
