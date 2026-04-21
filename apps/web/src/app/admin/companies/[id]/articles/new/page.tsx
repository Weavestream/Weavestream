import { notFound } from 'next/navigation';
import {
  listFolderTree,
  serverApiFetch,
  type CompanyDetail,
} from '../../../../../../lib/server-api';
import { ArticleForm } from '../article-form';

export default async function NewArticlePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: companyId } = await params;
  const sp = await searchParams;

  const [companyRes, folders] = await Promise.all([
    serverApiFetch<CompanyDetail>(`/companies/${companyId}`),
    listFolderTree(companyId),
  ]);
  if (!companyRes.ok || !companyRes.data) notFound();

  const initialFolderId =
    typeof sp.folderId === 'string' && sp.folderId !== 'root'
      ? sp.folderId
      : null;

  return (
    <ArticleForm
      companyId={companyId}
      companyLabel={companyRes.data.name}
      mode="create"
      folders={folders}
      initialFolderId={initialFolderId}
    />
  );
}
