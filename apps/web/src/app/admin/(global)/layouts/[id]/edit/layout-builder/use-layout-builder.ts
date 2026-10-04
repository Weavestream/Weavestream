'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { getLayoutTemplate, type LayoutSummary, problemMessage } from '@weavestream/shared';
import { apiFetch } from '../../../../../../../lib/api';
import { useToast } from '../../../../../../../components/ui';
import { slugifyFieldSlug as slugify } from '../../../../../../../lib/slugify';
import {
  activeLayoutFields,
  fieldsFromTemplate,
  initialBuilderState,
  isDirty,
  layoutBuilderReducer,
  newKey,
  prepareSave,
  toBuilder,
} from './layout-builder-state';
import type { BuilderField } from './types';

export type ForcePrompt = {
  affectedAssetCount: number;
  affectedCompanyIds: string[];
};

/**
 * Controller for the layout builder: field state (via the pure
 * reducer), server-snapshot sync, template seeding, drag wiring, and
 * the save round-trip. The coordinator component only renders.
 */
export function useLayoutBuilder({
  layout,
  canEdit,
}: {
  layout: LayoutSummary;
  canEdit: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const toast = useToast();

  const activeFields = useMemo(() => activeLayoutFields(layout.fields), [layout.fields]);

  const [state, dispatch] = useReducer(layoutBuilderReducer, undefined, () =>
    initialBuilderState(activeFields.map(toBuilder)),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forcePrompt, setForcePrompt] = useState<ForcePrompt | null>(null);

  // When the server component re-renders with a new layout version (after
  // `router.refresh()`), pull the fresh field list in as the new baseline
  // + working copy so stable server IDs replace our transient `new-*`
  // keys and future diffs are computed against authoritative data.
  const lastVersion = useRef<number>(layout.version);
  useEffect(() => {
    if (layout.version !== lastVersion.current) {
      lastVersion.current = layout.version;
      dispatch({ type: 'reset', fields: activeFields.map(toBuilder) });
    }
  }, [layout.version, activeFields]);

  // Starter-template seeding: when the builder is opened with
  // `?template=<id>` (set by the create-layout dialog) AND the layout
  // has no persisted fields yet AND the viewer can edit, pre-populate
  // the local field list from the template catalog. The query param is
  // stripped after the seed so a refresh doesn't clobber in-progress
  // edits with the original template fields.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    const templateId = searchParams.get('template');
    if (!templateId) return;
    // Mark before any early return so the effect only ever fires once
    // per mount — even if the template is invalid or the layout
    // already has fields, the URL gets cleaned up on the same pass.
    seededRef.current = true;
    const stripParam = () => {
      const next = new URLSearchParams(searchParams.toString());
      next.delete('template');
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    };
    if (!canEdit || activeFields.length > 0) {
      stripParam();
      return;
    }
    const template = getLayoutTemplate(templateId);
    if (!template) {
      stripParam();
      return;
    }
    dispatch({ type: 'seed', fields: fieldsFromTemplate(template.fields) });
    stripParam();
  }, [searchParams, pathname, router, canEdit, activeFields.length]);

  const { fields, baseline, selectedKey, drag } = state;
  const dirty = useMemo(() => isDirty(fields, baseline), [fields, baseline]);
  const selected = fields.find((f) => f.key === selectedKey) ?? null;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const select = useCallback((key: string) => dispatch({ type: 'select', key }), []);
  const removeField = useCallback((key: string) => dispatch({ type: 'remove', key }), []);
  const updateField = useCallback(
    (key: string, patch: Partial<BuilderField>) => dispatch({ type: 'update', key, patch }),
    [],
  );
  const autoFillSlug = useCallback(
    (key: string, label: string) =>
      dispatch({ type: 'update', key, patch: { slug: slugify(label) } }),
    [],
  );
  const setPrimary = useCallback((key: string) => dispatch({ type: 'setPrimary', key }), []);

  const onDragStart = useCallback((e: DragStartEvent) => {
    dispatch({ type: 'dragStart', activeId: e.active.id.toString() });
  }, []);
  const onDragEnd = useCallback((e: DragEndEvent) => {
    dispatch({
      type: 'dragEnd',
      activeId: e.active.id.toString(),
      overId: e.over?.id?.toString() ?? null,
      key: newKey(),
    });
  }, []);

  async function save(force: boolean) {
    setError(null);
    setForcePrompt(null);

    const prepared = prepareSave(fields);
    if (!prepared.ok) {
      setError(prepared.error);
      return;
    }

    const sent = fields;
    setSaving(true);
    const res = await apiFetch<LayoutSummary>(
      `/layouts/${layout.id}/fields${force ? '?force=true' : ''}`,
      { method: 'PUT', body: JSON.stringify(prepared.payload) },
    );
    setSaving(false);

    if (res.ok) {
      // Prefer the server's response so transient `new-*` keys are
      // replaced by persisted IDs immediately; fall back to the local
      // snapshot if the API ever shipped a thinner response.
      const serverFields = res.data?.fields
        ? activeLayoutFields(res.data.fields).map(toBuilder)
        : null;
      dispatch({ type: 'saved', sent, serverFields });
      toast.push('Layout saved', 'ok');
      router.refresh();
      return;
    }

    // RFC 7807 extension members live at the top level alongside
    // `detail` / `title` — see ProblemExceptionFilter.
    const problem = res.problem as
      | {
          error?: string;
          affectedAssetCount?: number;
          affectedCompanyIds?: string[];
        }
      | undefined;

    if (problem?.error === 'DestructiveFieldRemoval') {
      setForcePrompt({
        affectedAssetCount: problem.affectedAssetCount ?? 0,
        affectedCompanyIds: problem.affectedCompanyIds ?? [],
      });
      return;
    }
    setError(problemMessage(problem) ?? 'Save failed.');
  }

  return {
    activeFields,
    fields,
    selectedKey,
    selected,
    drag,
    dirty,
    sensors,
    select,
    removeField,
    updateField,
    autoFillSlug,
    setPrimary,
    onDragStart,
    onDragEnd,
    save,
    saving,
    error,
    forcePrompt,
    dismissForcePrompt: () => setForcePrompt(null),
  };
}
