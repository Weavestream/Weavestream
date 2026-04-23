import { notFound } from 'next/navigation';
import {
  getArticle,
  getCompanyDetail,
  getCompanyFolderTree,
  throwUnlessFound,
} from '../../../../../../../lib/server-api';
import { ArticleForm } from '../../article-form';

export default async function EditArticlePage({
  params,
}: {
  params: Promise<{ id: string; articleId: string }>;
}) {
  const { id: companyId, articleId } = await params;

  const [companyRes, folders, article] = await Promise.all([
    getCompanyDetail(companyId),
    getCompanyFolderTree(companyId),
    getArticle(companyId, articleId),
  ]);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);
  if (!article) notFound();

  return (
    <ArticleForm
      companyId={companyId}
      companyLabel={company.name}
      mode="edit"
      folders={folders}
      article={article}
    />
  );
}
