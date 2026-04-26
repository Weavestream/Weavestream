import { notFound } from 'next/navigation';
import {
  getAsset,
  getCompanyDetail,
  getLayout,
  throwUnlessFound,
} from '../../../../../../../lib/server-api';
import { AssetForm } from '../../asset-form';

export default async function EditAssetPage({
  params,
}: {
  params: Promise<{ id: string; assetId: string }>;
}) {
  const { id: companyId, assetId } = await params;
  const companyRes = await getCompanyDetail(companyId);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);

  const asset = await getAsset(companyId, assetId);
  if (!asset) notFound();

  const layoutPayload = await getLayout(asset.assetLayoutId);
  if (!layoutPayload) notFound();

  return (
    <AssetForm
      companyId={companyId}
      companyLabel={company.name}
      layout={layoutPayload.layout}
      mode="edit"
      assetId={asset.id}
      initialName={asset.name}
      initialValues={asset.fieldValues}
      externalSource={asset.externalSource}
      syncedFieldIds={asset.syncedFieldIds}
      lastSyncedAt={asset.lastSyncedAt}
    />
  );
}
