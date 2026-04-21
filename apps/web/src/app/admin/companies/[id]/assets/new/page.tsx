import { notFound } from 'next/navigation';
import {
  getLayout,
  listLayouts,
  serverApiFetch,
  type CompanyDetail,
} from '../../../../../../lib/server-api';
import { NewAssetFlow } from './new-asset-flow';

/**
 * New asset page. If the URL provides `?layout=<id>` we jump directly
 * into the form for that layout; otherwise the client picker renders
 * the full global catalog and PATCHes the URL when the operator
 * chooses one.
 */
export default async function NewAssetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ layout?: string }>;
}) {
  const { id: companyId } = await params;
  const { layout: layoutId } = await searchParams;

  const companyRes = await serverApiFetch<CompanyDetail>(`/companies/${companyId}`);
  if (!companyRes.ok || !companyRes.data) notFound();

  const [layouts, chosen] = await Promise.all([
    listLayouts({ includeArchived: false }),
    layoutId ? getLayout(layoutId) : Promise.resolve(null),
  ]);

  return (
    <NewAssetFlow
      companyId={companyId}
      companyName={companyRes.data.name}
      layouts={layouts}
      initialLayout={chosen?.layout ?? null}
    />
  );
}
