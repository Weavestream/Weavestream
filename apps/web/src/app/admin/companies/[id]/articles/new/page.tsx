import {
  getCompanyDetail,
  getCompanyFolderTree,
  getSettings,
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

  const [companyRes, folders, settings] = await Promise.all([
    getCompanyDetail(companyId),
    getCompanyFolderTree(companyId),
    getSettings(),
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
      // Autosave doesn't run in Create mode (we don't have an article
      // id to PATCH against until Publish), but we still pass the
      // resolved setting through so the status label can show the
      // right copy on first edit.
      autosaveEnabled={settings.articleAutosaveEnabled}
      // Workspace-wide default editor format. Only meaningful in
      // Create mode — edit mode honours the article's own stored mode.
      defaultEditorMode={settings.articleDefaultEditorMode}
    />
  );
}
