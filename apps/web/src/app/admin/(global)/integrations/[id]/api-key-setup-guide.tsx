'use client';

import { useState } from 'react';
import type { IntegrationSetupCheck, SetupGuideStep } from '@weavestream/shared';
import { problemMessage } from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import { useToast } from '../../../../../components/ui';
import { SetupGuide } from '../../../../../components/integrations/setup-guide';

/**
 * Setup guide with Check setup for drivers that use a pasted API key
 * (OAuth drivers show theirs on the Connections tab). Check setup only
 * runs once a key is saved.
 */
export function ApiKeySetupGuide({
  integrationId,
  steps,
  hasSecret,
}: {
  integrationId: string;
  steps: SetupGuideStep[];
  hasSecret: boolean;
}) {
  const toast = useToast();
  const [check, setCheck] = useState<IntegrationSetupCheck | null>(null);
  const [checking, setChecking] = useState(false);

  async function runCheck() {
    setChecking(true);
    try {
      const res = await apiFetch<IntegrationSetupCheck>(`/admin/integrations/${integrationId}/check`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!res.ok || !res.data) {
        toast.push(problemMessage(res.problem) ?? 'Could not run the setup check.', 'danger');
        return;
      }
      setCheck(res.data);
    } catch {
      // apiFetch rethrows network failures; the button must not stay stuck loading.
      toast.push('Could not run the setup check.', 'danger');
    } finally {
      setChecking(false);
    }
  }

  return (
    <SetupGuide
      steps={steps}
      redirectUri=""
      scopeGroups={[]}
      check={check}
      onCheck={() => void runCheck()}
      checking={checking}
      checkDisabledReason={hasSecret ? null : 'Save the API key first, then press Check setup.'}
      defaultOpen={!hasSecret}
    />
  );
}
