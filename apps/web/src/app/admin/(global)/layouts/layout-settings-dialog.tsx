'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { updateAssetLayoutSchema } from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import { Btn, Dialog, useToast } from '../../../../components/ui';
import type { LayoutSummary } from '../../../../lib/server-api';
import {
  LayoutFormFields,
  slugify,
  type LayoutFormValues,
} from './layout-form-fields';

/**
 * Edit-mode sibling of `CreateLayoutButton`'s details step: lets an
 * operator rename a layout or swap its icon / color / slug after
 * creation. Changes are sent to `PATCH /layouts/:id` as a diff — only
 * dirty fields are included — so untouched values are never sent back.
 *
 * Slug edits get an inline warning because the slug is embedded in
 * URLs (sidebar, per-layout asset tables) and filter DSL; old
 * bookmarks break the moment this goes through.
 */
export function LayoutSettingsDialog({
  layout,
  open,
  onClose,
  onSaved,
}: {
  layout: LayoutSummary;
  open: boolean;
  onClose: () => void;
  onSaved?: (next: LayoutSummary) => void;
}) {
  const router = useRouter();
  const toast = useToast();

  const [name, setName] = useState(layout.name);
  const [slug, setSlug] = useState(layout.slug);
  const [slugTouched, setSlugTouched] = useState(false);
  const [icon, setIcon] = useState(layout.icon);
  const [color, setColor] = useState(layout.color);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Re-seed local state whenever the dialog opens (or the source layout
  // changes) so a cancelled edit doesn't leak stale values into the
  // next open, and a successful save re-baselines the form.
  useEffect(() => {
    if (!open) return;
    setName(layout.name);
    setSlug(layout.slug);
    setSlugTouched(false);
    setIcon(layout.icon);
    setColor(layout.color);
    setError(null);
  }, [open, layout.id, layout.name, layout.slug, layout.icon, layout.color]);

  const values: LayoutFormValues = { name, slug, icon, color };

  const dirty =
    name !== layout.name ||
    slug !== layout.slug ||
    icon !== layout.icon ||
    color !== layout.color;

  const slugChanged = slug !== layout.slug;

  async function submit() {
    setError(null);

    const patch: {
      name?: string;
      slug?: string;
      icon?: string;
      color?: string;
    } = {};
    if (name !== layout.name) patch.name = name;
    if (slug !== layout.slug) patch.slug = slug;
    if (icon !== layout.icon) patch.icon = icon;
    if (color !== layout.color) patch.color = color;

    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }

    const parsed = updateAssetLayoutSchema.safeParse(patch);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the fields above.');
      return;
    }

    setPending(true);
    const res = await apiFetch<LayoutSummary>(`/layouts/${layout.id}`, {
      method: 'PATCH',
      body: JSON.stringify(parsed.data),
    });
    setPending(false);

    if (!res.ok || !res.data) {
      const problem = res.problem as
        | { detail?: string; title?: string; message?: string }
        | undefined;
      setError(
        problem?.detail ??
          problem?.message ??
          problem?.title ??
          'Could not update layout.',
      );
      return;
    }

    toast.push('Layout updated', 'ok');
    onSaved?.(res.data);
    onClose();
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!pending) onClose();
      }}
      title="Layout settings"
      width={440}
      footer={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Btn>
          <Btn
            kind="primary"
            onClick={submit}
            loading={pending}
            disabled={!dirty || pending}
          >
            Save changes
          </Btn>
        </>
      }
    >
      <LayoutFormFields
        values={values}
        error={error}
        onName={(v) => {
          setName(v);
          // Keep slug linked to name until the operator explicitly
          // edits it — matches the create dialog's behavior so
          // renaming the display name alone doesn't accidentally break
          // bookmarks.
          if (!slugTouched && slug === layout.slug) {
            const next = slugify(v);
            if (next) setSlug(next);
          }
        }}
        onSlug={(v) => {
          setSlug(v.toLowerCase());
          setSlugTouched(true);
        }}
        onIcon={setIcon}
        onColor={setColor}
        slugWarning={
          slugChanged
            ? 'Changing the slug updates every URL that references this layout — existing bookmarks, saved filters, and sidebar links will break.'
            : null
        }
      />
    </Dialog>
  );
}
