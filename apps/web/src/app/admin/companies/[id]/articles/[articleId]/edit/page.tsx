import { notFound } from 'next/navigation';
import {
  getArticle,
  listFolderTree,
  serverApiFetch,
  type CompanyDetail,
} from '../../../../../../../lib/server-api';
import { ArticleForm } from '../../article-form';

export default async function EditArticlePage({
  params,
}: {
  params: Promise<{ id: string; articleId: string }>;
}) {
  const { id: companyId, articleId } = await params;

  const [companyRes, folders, article] = await Promise.all([
    serverApiFetch<CompanyDetail>(`/companies/${companyId}`),
    listFolderTree(companyId),
    getArticle(companyId, articleId),
  ]);
  if (!companyRes.ok || !companyRes.data) notFound();
  if (!article) notFound();

  return (
    <ArticleForm
      companyId={companyId}
      companyLabel={companyRes.data.name}
      mode="edit"
      folders={folders}
      article={article}
    />
  );
}
