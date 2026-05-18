import { notFound, redirect } from 'next/navigation';
import { getArticle, getMe } from '../../../../../../lib/server-api';

/**
 * Portal id→slug resolver for `@`-mention links. The portal article
 * reader is slug-keyed (`/portal/[companySlug]/articles/[slug]`), but
 * legacy mentions stored before the slug attribute was persisted only
 * carry the article id. This route looks the article up by id through
 * the authenticated server API (which enforces tenant + visibility),
 * then 307-redirects to the canonical slug URL. Unknown / unauthorised
 * ids 404 as they would on the destination page.
 */
export default async function PortalArticleByIdRedirectPage({
  params,
}: {
  params: Promise<{ companySlug: string; articleId: string }>;
}) {
  const { companySlug, articleId } = await params;
  const me = await getMe();
  if (!me) notFound();
  const membership = me.memberships.find((m) => m.company.slug === companySlug);
  if (!membership) notFound();
  const article = await getArticle(membership.company.id, articleId);
  if (!article) notFound();
  redirect(
    `/portal/${companySlug}/articles/${encodeURIComponent(article.slug)}`,
  );
}
