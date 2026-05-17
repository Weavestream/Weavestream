import { notFound } from 'next/navigation';
import {
  getArticle,
  getCompanyDetail,
  getCompanyFolderTree,
  getSettings,
  throwUnlessFound,
} from '../../../../../../../lib/server-api';
import { ArticleForm } from '../../article-form';

export default async function EditArticlePage({
  params,
}: {
  params: Promise<{ id: string; articleId: string }>;
}) {
  const { id: companyId, articleId } = await params;

  const [companyRes, folders, article, settings] = await Promise.all([
    getCompanyDetail(companyId),
    getCompanyFolderTree(companyId),
    getArticle(companyId, articleId),
    // Resolve the workspace-wide autosave toggle on the server so we
    // never let the client decide whether to silently persist edits.
    // Cached for 5 s in the API; this is the same handle used by the
    // admin shell.
    getSettings(),
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
      autosaveEnabled={settings.articleAutosaveEnabled}
      defaultEditorMode={settings.articleDefaultEditorMode}
    />
  );
}
