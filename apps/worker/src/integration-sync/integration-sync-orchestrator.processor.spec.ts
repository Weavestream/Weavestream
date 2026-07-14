import { integrationSyncMappingJobSchema } from '@weavestream/shared';

describe('integration sync orchestrator staged payload', () => {
  it('keeps legacy resourceId while carrying the whole mapping DAG and audit actor', () => {
    const job = integrationSyncMappingJobSchema.parse({
      syncRunId: '00000000-0000-0000-0000-000000000001',
      integrationCompanyMappingId: '00000000-0000-0000-0000-000000000002',
      resourceId: '00000000-0000-0000-0000-000000000003',
      resourceIds: [
        '00000000-0000-0000-0000-000000000003',
        '00000000-0000-0000-0000-000000000004',
      ],
      auditActorId: '00000000-0000-0000-0000-000000000005',
    });
    expect(job.resourceIds).toHaveLength(2);
    expect(job.auditActorId).toBe('00000000-0000-0000-0000-000000000005');
  });
});
