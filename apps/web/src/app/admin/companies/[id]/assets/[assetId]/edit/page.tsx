import { notFound } from 'next/navigation';
import {
  getAsset,
  getLayout,
  serverApiFetch,
  type CompanyDetail,
} from '../../../../../../../lib/server-api';
import { AssetForm } from '../../asset-form';

export default async function EditAssetPage({
  params,
}: {
  params: Promise<{ id: string; assetId: string }>;
}) {
  const { id: companyId, assetId } = await params;
  const companyRes = await serverApiFetch<CompanyDetail>(`/companies/${companyId}`);
  if (!companyRes.ok || !companyRes.data) notFound();

  const asset = await getAsset(companyId, assetId);
  if (!asset) notFound();

  const layoutPayload = await getLayout(asset.assetLayoutId);
  if (!layoutPayload) notFound();

  return (
    <AssetForm
      companyId={companyId}
      companyLabel={companyRes.data.name}
      layout={layoutPayload.layout}
      mode="edit"
      assetId={asset.id}
      initialName={asset.name}
      initialValues={asset.fieldValues}
    />
  );
}
