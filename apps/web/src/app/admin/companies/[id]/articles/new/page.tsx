import {
  getCompanyDetail,
  getCompanyFolderTree,
  throwUnlessFound,
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
    getCompanyDetail(companyId),
    getCompanyFolderTree(companyId),
  ]);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);

  const initialFolderId =
    typeof sp.folderId === 'string' && sp.folderId !== 'root'
      ? sp.folderId
      : null;

  return (
    <ArticleForm
      companyId={companyId}
      companyLabel={company.name}
      mode="create"
      folders={folders}
      initialFolderId={initialFolderId}
    />
  );
}
