import { notFound } from 'next/navigation';
import { getLayout, getMe, listLayouts } from '../../../../../../lib/server-api';
import { LayoutBuilder } from './layout-builder';

/**
 * Phase 3 layout builder. Readable by every authenticated role (the API
 * lets OPERATOR / CLIENT through on `GET /layouts/:id`), but the builder
 * puts every mutation behind `canEdit` (SUPER_ADMIN) — hands-off readers
 * get a read-only view with field inspector switched off.
 */
export default async function LayoutEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [me, payload, allLayouts] = await Promise.all([
    getMe(),
    getLayout(id, true),
    listLayouts(),
  ]);
  if (!payload || !me) notFound();

  const canEdit = me.role === 'SUPER_ADMIN';
  return (
    <LayoutBuilder
      layout={payload.layout}
      stats={payload.stats ?? null}
      canEdit={canEdit}
      allLayouts={allLayouts}
    />
  );
}
