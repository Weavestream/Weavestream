'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  DriverDescriptor,
  DriverResourceDescriptor,
  DriverStandardField,
  EnsureResourceMatchFieldResult,
  IntegrationDto,
  IntegrationFieldMappingDto,
  IntegrationResourceDto,
  LayoutFieldSummary,
  LayoutSummary,
} from '@weavestream/shared';
import { problemMessage, standardFieldTargetCompatible } from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import {
  Btn,
  DataTable,
  Field,
  MobileCardRow,
  Select,
  Tag,
  useToast,
  type DataColumn,
} from '../../../../../components/ui';

/** Resources that opt into the guided matcher (asset target + match suggestions). */
export type MatchableResource = DriverResourceDescriptor & {
  targetKind: 'asset';
  matchSuggestions: NonNullable<DriverResourceDescriptor['matchSuggestions']>;
};

export function matchableResources(driver: DriverDescriptor | null): MatchableResource[] {
  return (driver?.resources ?? []).filter(
    (resource): resource is MatchableResource =>
      resource.targetKind === 'asset' && resource.matchSuggestions !== undefined,
  );
}

export const NEW_LAYOUT = '__new__';
export const SKIP = '__skip__';
/** "Match on" choice: create the match field on the picked layout when saving. */
export const CREATE_FIELD = '__create_field__';

/** Name of the field "Create field" adds (the driver's label, else the source key spelled out). */
export function createFieldLabel(resource: MatchableResource): string {
  const { fieldLabel, sourceField } = resource.matchSuggestions;
  if (fieldLabel) return fieldLabel;
  const spaced = sourceField.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const norm = (value: string) => value.trim().toLowerCase();

/** First candidate whose slug or name equals a hint, else contains one (hint order wins). */
function suggest<T extends { slug: string; name: string }>(candidates: T[], hints: string[]): T | null {
  const keyed = candidates.map((candidate) => ({ candidate, keys: [norm(candidate.slug), norm(candidate.name)] }));
  for (const exact of [true, false]) {
    for (const hint of hints.map(norm)) {
      const hit = keyed.find(({ keys }) => keys.some((key) => (exact ? key === hint : key.includes(hint))));
      if (hit) return hit.candidate;
    }
  }
  return null;
}

export function suggestLayout(layouts: LayoutSummary[], hints: string[]): LayoutSummary | null {
  return suggest(layouts, hints);
}

export function suggestField(fields: LayoutFieldSummary[], hints: string[]): LayoutFieldSummary | null {
  return suggest(fields.filter((field) => !field.archivedAt), hints);
}

/** Standard-field row choice: leave this fact out of the layout. */
export const DONT_SYNC = '__dont_sync__';

/** The resource's standard fields minus its match key (that one has its own picker). */
export function standardFieldsOf(resource: MatchableResource): DriverStandardField[] {
  return (resource.standardFields ?? []).filter((field) => field.sourceField !== resource.matchSuggestions.sourceField);
}

const tokens = (value: string) => norm(value).split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Existing layout field for a standard fact: a compatible type whose slug or
 * name equals a hint word for word ("IP address" = ip_address). Exact only:
 * a partial match would pre-select a field the operator owns ("OS license
 * key", "Storage location") and the first sync would overwrite it. Fields
 * in `taken` are already used by another row.
 */
export function suggestStandardField(
  fields: LayoutFieldSummary[],
  spec: DriverStandardField,
  taken: ReadonlySet<string> = new Set(),
): LayoutFieldSummary | null {
  const usable = fields.filter(
    (field) => !field.archivedAt && !taken.has(field.id) && standardFieldTargetCompatible(spec.fieldType, field.fieldType),
  );
  for (const hint of [spec.sourceField, ...spec.fieldHints]) {
    const wanted = tokens(hint).join('_');
    const hit = usable.find((field) => [field.slug, field.name].some((key) => tokens(key).join('_') === wanted));
    if (hit) return hit;
  }
  return null;
}

/** Pre-selection per standard field: the saved mapping, else a hinted field, else Create field / Don't sync. */
export function initialStandardChoices(
  resource: MatchableResource,
  fields: LayoutFieldSummary[],
  matchFieldId: string,
  saved: Readonly<Record<string, string>>,
  canCreate: boolean,
): Record<string, string> {
  const taken = new Set<string>(matchFieldId ? [matchFieldId] : []);
  for (const fieldId of Object.values(saved)) taken.add(fieldId);
  const out: Record<string, string> = {};
  for (const spec of standardFieldsOf(resource)) {
    const savedId = saved[spec.sourceField];
    if (savedId && fields.some((field) => field.id === savedId && !field.archivedAt)) {
      out[spec.sourceField] = savedId;
      continue;
    }
    const hit = suggestStandardField(fields, spec, taken);
    if (hit) taken.add(hit.id);
    out[spec.sourceField] = hit?.id ?? (canCreate ? CREATE_FIELD : DONT_SYNC);
  }
  return out;
}

type Choice = { layout: string; matchFieldId: string; standard: Record<string, string> };

/** What is saved today, or null when the resource has never been mapped. */
function persistedChoice(row: IntegrationResourceDto | undefined, saved: Record<string, string>): Choice | null {
  if (row && !row.enabled) return { layout: SKIP, matchFieldId: '', standard: {} };
  if (row?.assetLayoutId) return { layout: row.assetLayoutId, matchFieldId: row.matchKeyFieldIds[0] ?? '', standard: saved };
  return null;
}

/** Standard choices for a new layout: every fact gets a field when the user may create them. */
function newLayoutStandard(resource: MatchableResource, canCreate: boolean): Record<string, string> {
  return Object.fromEntries(standardFieldsOf(resource).map((spec) => [spec.sourceField, canCreate ? CREATE_FIELD : DONT_SYNC]));
}

function choiceForLayout(
  resource: MatchableResource,
  layout: LayoutSummary,
  matchFieldId: string,
  saved: Record<string, string>,
  canCreate: boolean,
): Choice {
  return {
    layout: layout.id,
    matchFieldId,
    standard: initialStandardChoices(resource, layout.fields, matchFieldId, saved, canCreate),
  };
}

function initialChoice(
  resource: MatchableResource,
  row: IntegrationResourceDto | undefined,
  layouts: LayoutSummary[],
  canCreate: boolean,
  saved: Record<string, string>,
): Choice {
  const createField = canCreate ? CREATE_FIELD : '';
  if (row && !row.enabled) return { layout: SKIP, matchFieldId: '', standard: {} };
  if (row?.assetLayoutId) {
    const layout = layouts.find((candidate) => candidate.id === row.assetLayoutId);
    const matchFieldId =
      row.matchKeyFieldIds[0] ??
      (layout ? suggestField(layout.fields, resource.matchSuggestions.fieldHints)?.id : undefined) ??
      createField;
    return layout
      ? choiceForLayout(resource, layout, matchFieldId, saved, canCreate)
      : { layout: row.assetLayoutId, matchFieldId, standard: saved };
  }
  const layout = suggestLayout(layouts, resource.matchSuggestions.layoutHints);
  if (!layout) {
    return canCreate
      ? { layout: NEW_LAYOUT, matchFieldId: '', standard: newLayoutStandard(resource, true) }
      : { layout: SKIP, matchFieldId: '', standard: {} };
  }
  const matchFieldId = suggestField(layout.fields, resource.matchSuggestions.fieldHints)?.id ?? createField;
  return choiceForLayout(resource, layout, matchFieldId, {}, canCreate);
}

function sameChoice(a: Choice | null | undefined, b: Choice): boolean {
  if (!a || a.layout !== b.layout || a.matchFieldId !== b.matchFieldId) return false;
  const keys = new Set([...Object.keys(a.standard), ...Object.keys(b.standard)]);
  // An unsaved "Don't sync" equals no mapping.
  return [...keys].every((key) => (a.standard[key] ?? DONT_SYNC) === (b.standard[key] ?? DONT_SYNC));
}

/**
 * Guided "Map layouts" step for drivers whose resources declare
 * `matchSuggestions`: one row per resource with a layout picker
 * (pre-selected from the hints, or "Create new layout") and a "match on"
 * picker. Saving sets the resource layout, its match key and the match-key
 * field mapping through the same APIs as the Field mappings tab. A skipped
 * resource is disabled, not an error.
 */
export function MapLayoutsTab({
  integration,
  driver,
  canManageLayouts = true,
}: {
  integration: IntegrationDto;
  driver: DriverDescriptor | null;
  /** LAYOUT_MANAGE: needed for Create new layout and Create field (the API enforces it too). */
  canManageLayouts?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const resources = useMemo(() => matchableResources(driver), [driver]);
  const [layouts, setLayouts] = useState<LayoutSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [persisted, setPersisted] = useState<Record<string, Choice | null>>({});
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await apiFetch<{ items: LayoutSummary[] }>('/layouts');
      if (cancelled) return;
      if (!res.ok || !res.data) {
        setLoadError(problemMessage(res.problem) ?? 'Could not load asset layouts.');
        return;
      }
      const active = res.data.items.filter((layout) => !layout.archivedAt && layout.isActive);
      const next: Record<string, Choice> = {};
      const saved: Record<string, Choice | null> = {};
      for (const resource of resources) {
        const row = integration.resources.find((candidate) => candidate.resourceKey === resource.key);
        const standardSaved = await savedStandardMappings(integration.id, resource, row);
        if (cancelled) return;
        if (standardSaved === null) {
          setLoadError('Could not load the field mappings.');
          return;
        }
        next[resource.key] = initialChoice(resource, row, active, canManageLayouts, standardSaved);
        saved[resource.key] = persistedChoice(row, standardSaved);
      }
      setLayouts(active);
      setPersisted(saved);
      setChoices(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [integration.id, integration.resources, resources, canManageLayouts]);

  function choose(key: string, layoutValue: string) {
    const resource = resources.find((candidate) => candidate.key === key)!;
    const layout = layouts?.find((candidate) => candidate.id === layoutValue);
    const matchFieldId = layout
      ? suggestField(layout.fields, resource.matchSuggestions.fieldHints)?.id ?? (canManageLayouts ? CREATE_FIELD : '')
      : '';
    setChoices((prev) => ({
      ...prev,
      [key]: layout
        ? choiceForLayout(resource, layout, matchFieldId, {}, canManageLayouts)
        : {
            layout: layoutValue,
            matchFieldId: '',
            standard: layoutValue === NEW_LAYOUT ? newLayoutStandard(resource, canManageLayouts) : {},
          },
    }));
    setErrors((prev) => ({ ...prev, [key]: '' }));
  }

  function chooseStandard(key: string, sourceField: string, value: string) {
    setChoices((prev) => {
      const current = prev[key];
      if (!current) return prev;
      return { ...prev, [key]: { ...current, standard: { ...current.standard, [sourceField]: value } } };
    });
  }

  async function saveResource(resource: MatchableResource, choice: Choice): Promise<string | null> {
    const base = `/admin/integrations/${integration.id}/resources/${resource.key}`;
    const row = integration.resources.find((candidate) => candidate.resourceKey === resource.key);
    const patch = (body: Record<string, unknown>) =>
      apiFetch<IntegrationResourceDto>(base, { method: 'PATCH', body: JSON.stringify(body) });
    const putMappings = (mappings: unknown[]) =>
      apiFetch(`${base}/field-mappings`, { method: 'PATCH', body: JSON.stringify({ mappings }) });

    if (choice.layout === SKIP) {
      const res = await patch({ enabled: false });
      return res.ok ? null : problemMessage(res.problem) ?? 'Could not skip this resource.';
    }

    const layoutChanges = (row?.assetLayoutId ?? null) !== (choice.layout === NEW_LAYOUT ? null : choice.layout);
    // The API refuses a layout change while mappings point at the old one.
    if (layoutChanges && (row?.fieldMappingCount ?? 0) > 0) {
      const cleared = await putMappings([]);
      if (!cleared.ok) return problemMessage(cleared.problem) ?? 'Could not clear the old field mappings.';
    }

    const standard = standardFieldsOf(resource);
    const picked = standard.flatMap((spec) => {
      const value = choice.standard[spec.sourceField] ?? DONT_SYNC;
      return value === DONT_SYNC ? [] : [{ spec, value }];
    });
    const pickedIds = picked.map(({ value }) => value).filter((value) => value !== CREATE_FIELD);
    if (new Set(pickedIds).size !== pickedIds.length || pickedIds.includes(choice.matchFieldId)) {
      return 'Each layout field can take only one value. Pick another field or Don\'t sync.';
    }
    /** Creates the "Create field" picks on the layout; returns the mappings to add. */
    const standardMappings = async (assetLayoutId: string): Promise<{ sourceField: string; targetFieldId: string }[] | string> => {
      const out: { sourceField: string; targetFieldId: string }[] = [];
      for (const { spec, value } of picked) {
        let targetFieldId = value;
        if (value === CREATE_FIELD) {
          const ensured = await apiFetch<EnsureResourceMatchFieldResult>(`${base}/match-field`, {
            method: 'POST',
            body: JSON.stringify({ assetLayoutId, sourceField: spec.sourceField }),
          });
          if (!ensured.ok || !ensured.data) return problemMessage(ensured.problem) ?? `Could not create the field "${spec.label}".`;
          targetFieldId = ensured.data.fieldId;
        }
        out.push({ sourceField: spec.sourceField, targetFieldId });
      }
      return out;
    };
    const standardSources = new Set(standard.map((spec) => spec.sourceField));
    const toBody = (mapping: IntegrationFieldMappingDto) => ({
      sourceField: mapping.sourceField,
      targetFieldId: mapping.targetFieldId,
      syncDirection: mapping.syncDirection,
      transform: mapping.transform,
    });
    // Standard fields never overwrite a value a person changed (see the Differences tab).
    const standardBody = (mappings: { sourceField: string; targetFieldId: string }[]) =>
      mappings.map((m) => ({ ...m, syncDirection: 'preserve_manual', transform: null }));

    if (choice.layout === NEW_LAYOUT) {
      if (row?.assetLayoutId) {
        const detached = await patch({ assetLayoutId: null, matchKeyFieldIds: [] });
        if (!detached.ok) return problemMessage(detached.problem) ?? 'Could not detach the old layout.';
      }
      const created = await apiFetch<IntegrationResourceDto>(`${base}/destination`, { method: 'POST' });
      if (!created.ok || !created.data?.assetLayoutId) return problemMessage(created.problem) ?? 'Could not create the layout.';
      if (picked.length === 0) return null;
      const added = await standardMappings(created.data.assetLayoutId);
      if (typeof added === 'string') return added;
      const current = await apiFetch<IntegrationFieldMappingDto[]>(`${base}/field-mappings`);
      if (!current.ok || !current.data) return problemMessage(current.problem) ?? 'Could not read field mappings.';
      const addedIds = new Set(added.map((m) => m.targetFieldId));
      const saved = await putMappings([
        ...current.data
          .filter((m) => m.targetFieldId !== null && !standardSources.has(m.sourceField) && !addedIds.has(m.targetFieldId))
          .map(toBody),
        ...standardBody(added),
      ]);
      return saved.ok ? null : problemMessage(saved.problem) ?? 'Could not save the field mappings.';
    }

    if (!choice.matchFieldId) return 'Pick the field to match on.';
    let matchFieldId = choice.matchFieldId;
    if (matchFieldId === CREATE_FIELD) {
      const ensured = await apiFetch<EnsureResourceMatchFieldResult>(`${base}/match-field`, {
        method: 'POST',
        body: JSON.stringify({ assetLayoutId: choice.layout }),
      });
      if (!ensured.ok || !ensured.data) return problemMessage(ensured.problem) ?? 'Could not create the match field.';
      matchFieldId = ensured.data.fieldId;
    }
    const updated = await patch({
      assetLayoutId: choice.layout,
      matchKeyFieldIds: [matchFieldId],
      enabled: true,
    });
    if (!updated.ok) return problemMessage(updated.problem) ?? 'Could not save the layout.';

    const added = await standardMappings(choice.layout);
    if (typeof added === 'string') return added;
    const addedIds = new Set(added.map((m) => m.targetFieldId));
    const sourceField = resource.matchSuggestions.sourceField;
    let kept: IntegrationFieldMappingDto[] = [];
    if (!layoutChanges) {
      const current = await apiFetch<IntegrationFieldMappingDto[]>(`${base}/field-mappings`);
      if (!current.ok || !current.data) return problemMessage(current.problem) ?? 'Could not read field mappings.';
      kept = current.data.filter(
        (mapping) =>
          mapping.targetFieldId !== null &&
          mapping.sourceField !== sourceField &&
          mapping.targetFieldId !== matchFieldId &&
          !standardSources.has(mapping.sourceField) &&
          !addedIds.has(mapping.targetFieldId),
      );
    }
    const saved = await putMappings([
      ...kept.map(toBody),
      { sourceField, targetFieldId: matchFieldId, syncDirection: 'source_wins', transform: null },
      ...standardBody(added),
    ]);
    return saved.ok ? null : problemMessage(saved.problem) ?? 'Could not save the field mappings.';
  }

  async function save() {
    setPending(true);
    try {
      const nextErrors: Record<string, string> = {};
      for (const resource of resources) {
        const choice = choices[resource.key];
        const before = persisted[resource.key];
        if (!choice || sameChoice(before, choice)) continue;
        const error = await saveResource(resource, choice);
        if (error) nextErrors[resource.key] = error;
      }
      setErrors(nextErrors);
      if (Object.keys(nextErrors).length === 0) {
        toast.push('Layouts mapped.', 'ok');
        router.refresh();
      }
    } catch {
      // A rejected request (network down) has no problem body to show; say so instead of hanging.
      toast.push('Could not save the layout mapping. Check your connection and try again.', 'danger');
    } finally {
      setPending(false);
    }
  }

  if (resources.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 600 }}>
          Map layouts
        </h3>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>
          Pick the layout each kind of record belongs to and the field that identifies an existing
          asset. Records that match an existing asset are linked to it; unmatched records create new
          assets. Standard facts (hostname, OS, RAM, ...) fill the layout fields you pick below; pick
          Create field to add a missing one when you save, or Don&apos;t sync to leave it out. A value
          a person changed is never overwritten: it shows as a difference instead. Everything else
          shows in the integration section on the asset page. Skipped resources are not synced.
        </p>
      </header>
      {!canManageLayouts && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
          Create new layout and Create field need permission to manage asset layouts.
        </p>
      )}
      {loadError && <Tag tone="danger">{loadError}</Tag>}
      {!layouts && !loadError && <Tag tone="default">Loading layouts…</Tag>}
      {layouts &&
        resources.map((resource) => {
          const choice: Choice = choices[resource.key] ?? { layout: SKIP, matchFieldId: '', standard: {} };
          const layout = layouts.find((candidate) => candidate.id === choice.layout);
          const fields = layout?.fields.filter((field) => !field.archivedAt) ?? [];
          const layoutId = `map-layout-${resource.key}`;
          const fieldId = `map-match-${resource.key}`;
          return (
            <section
              key={resource.key}
              aria-label={resource.label}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'flex-end',
                gap: 12,
                padding: 12,
                border: '1px solid var(--line)',
                borderRadius: 6,
                background: 'var(--panel-2)',
              }}
            >
              <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{resource.label}</div>
                {resource.description && (
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{resource.description}</div>
                )}
              </div>
              <Field label="Layout" htmlFor={layoutId} style={{ flex: '1 1 200px', minWidth: 0 }}>
                <Select id={layoutId} value={choice.layout} onChange={(e) => choose(resource.key, e.target.value)}>
                  {layouts.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                  <option value={NEW_LAYOUT} disabled={!canManageLayouts}>
                    Create new layout
                  </option>
                  <option value={SKIP}>Skip (do not sync)</option>
                </Select>
              </Field>
              {layout && (
                <Field
                  label={`Match ${resource.matchSuggestions.sourceField} on`}
                  htmlFor={fieldId}
                  style={{ flex: '1 1 200px', minWidth: 0 }}
                >
                  <Select
                    id={fieldId}
                    value={choice.matchFieldId}
                    onChange={(e) =>
                      setChoices((prev) => ({ ...prev, [resource.key]: { ...choice, matchFieldId: e.target.value } }))
                    }
                  >
                    <option value="">Select a field…</option>
                    {fields.map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.name}
                      </option>
                    ))}
                    <option value={CREATE_FIELD} disabled={!canManageLayouts}>
                      {`Create field "${createFieldLabel(resource)}"`}
                    </option>
                  </Select>
                </Field>
              )}
              {choice.layout !== SKIP && standardFieldsOf(resource).length > 0 && (
                <div style={{ flexBasis: '100%', minWidth: 0 }}>
                  <StandardFieldsTable
                    resource={resource}
                    fields={choice.layout === NEW_LAYOUT ? [] : fields}
                    choice={choice}
                    canCreate={canManageLayouts}
                    onChange={(sourceField, value) => chooseStandard(resource.key, sourceField, value)}
                  />
                </div>
              )}
              {errors[resource.key] && (
                <div role="alert" style={{ flexBasis: '100%' }}>
                  <Tag tone="danger">{errors[resource.key]}</Tag>
                </div>
              )}
            </section>
          );
        })}
      {layouts && (
        <div>
          <Btn kind="primary" onClick={save} loading={pending}>
            Save layout mapping
          </Btn>
        </div>
      )}
    </div>
  );
}

/** Saved standard-field mappings (source key to field id), {} when none, null on a read error. */
async function savedStandardMappings(
  integrationId: string,
  resource: MatchableResource,
  row: IntegrationResourceDto | undefined,
): Promise<Record<string, string> | null> {
  const standard = new Set(standardFieldsOf(resource).map((spec) => spec.sourceField));
  if (standard.size === 0 || !row?.assetLayoutId || row.fieldMappingCount === 0) return {};
  const res = await apiFetch<IntegrationFieldMappingDto[]>(
    `/admin/integrations/${integrationId}/resources/${resource.key}/field-mappings`,
  );
  if (!res.ok || !res.data) return null;
  return Object.fromEntries(
    res.data
      .filter((mapping) => standard.has(mapping.sourceField) && mapping.targetFieldId)
      .map((mapping) => [mapping.sourceField, mapping.targetFieldId!]),
  );
}

type StandardRow = DriverStandardField & { id: string };

/** One row per standard fact: an existing layout field, Create field, or Don't sync. */
function StandardFieldsTable({
  resource,
  fields,
  choice,
  canCreate,
  onChange,
}: {
  resource: MatchableResource;
  fields: LayoutFieldSummary[];
  choice: Choice;
  canCreate: boolean;
  onChange: (sourceField: string, value: string) => void;
}) {
  const rows: StandardRow[] = standardFieldsOf(resource).map((spec) => ({ ...spec, id: spec.sourceField }));
  const picker = (row: StandardRow) => {
    const id = `map-standard-${resource.key}-${row.sourceField}`;
    const usable = fields.filter((field) => !field.archivedAt && standardFieldTargetCompatible(row.fieldType, field.fieldType));
    return (
      <Select
        id={id}
        aria-label={`Layout field for ${row.label}`}
        value={choice.standard[row.sourceField] ?? DONT_SYNC}
        onChange={(e) => onChange(row.sourceField, e.target.value)}
      >
        {usable.map((field) => (
          <option key={field.id} value={field.id}>
            {field.name}
          </option>
        ))}
        <option value={CREATE_FIELD} disabled={!canCreate}>
          {`Create field "${row.label}"`}
        </option>
        <option value={DONT_SYNC}>Don&apos;t sync</option>
      </Select>
    );
  };
  const columns: DataColumn<StandardRow>[] = [
    { id: 'fact', header: 'Fact', width: 200, render: (row) => row.label },
    { id: 'field', header: 'Layout field', render: picker },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      disableSort
      renderMobileCard={(row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <MobileCardRow label="Fact">{row.label}</MobileCardRow>
          {picker(row)}
        </div>
      )}
    />
  );
}
