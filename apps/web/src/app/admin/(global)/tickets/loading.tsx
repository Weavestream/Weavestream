import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel } from '../../../../components/ui';

/**
 * Next.js renders this as a Suspense fallback while the global
 * Tickets page server-fetches. NinjaOne's `/trigger/board/{id}/run`
 * endpoint can take 5-10s under load + enrichment, so painting the
 * shell + a table skeleton immediately keeps the UI from feeling
 * stuck.
 */
export default function Loading() {
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Admin', href: '/admin' }, { label: 'Tickets' }]}
        title="Tickets"
        description="Browse live tickets from the connected helpdesk across every client. Open a ticket to ask the AI to draft a knowledge-base article from it."
      />
      <PageBody>
        <Panel
          title={<SkeletonBar w={140} />}
          noPad
          fillHeight
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
              minHeight: 0,
            }}
          >
            <div
              style={{
                padding: '10px 14px',
                borderBottom: '1px solid var(--line)',
                display: 'flex',
                gap: 8,
                alignItems: 'center',
              }}
            >
              <SkeletonBar w="60%" h={28} />
              <SkeletonBar w={120} h={28} />
              <SkeletonBar w={120} h={28} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  style={{
                    display: 'grid',
                    gridTemplateColumns:
                      '2fr 1.2fr 140px 110px 110px 110px 64px',
                    gap: 12,
                    padding: '12px 14px',
                    borderBottom: '1px solid var(--line)',
                    alignItems: 'center',
                  }}
                >
                  <SkeletonBar w="80%" />
                  <SkeletonBar w="60%" />
                  <SkeletonBar w={90} />
                  <SkeletonBar w={70} />
                  <SkeletonBar w={70} />
                  <SkeletonBar w={70} />
                  <SkeletonBar w={40} />
                </div>
              ))}
            </div>
          </div>
        </Panel>
      </PageBody>
    </>
  );
}

function SkeletonBar({
  w,
  h = 14,
}: {
  w: number | string;
  h?: number;
}) {
  return (
    <>
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          width: typeof w === 'number' ? `${w}px` : w,
          height: h,
          background:
            'linear-gradient(90deg, var(--panel-2) 0%, var(--line-2) 50%, var(--panel-2) 100%)',
          backgroundSize: '200% 100%',
          borderRadius: 4,
          animation: 'ws-skeleton-shimmer 1.4s ease-in-out infinite',
        }}
      />
      <style>{
        '@keyframes ws-skeleton-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }'
      }</style>
    </>
  );
}
