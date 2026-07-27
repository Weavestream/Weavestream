import { useEffect, useState } from 'react';
import { FieldBlock } from '../../components/FieldBlock';
import { FormScreenChrome } from '../../components/FormScreenChrome';
import { Input } from '../../components/primitives';
import { EmptyState, ErrorBanner, SkeletonList } from '../../components/states';
import { useToast } from '../../components/Toast';
import { useBackOr } from '../../lib/use-back';
import { UUID_RE } from '../../lib/uuid';
import { useOrgScope, type Org } from '../../lib/org-scope';
import { useScopedNavigate } from '../../lib/scoped-nav';
import { useCompanyAccess } from '../../lib/use-company-access';
import type { AssetRecord, LayoutRecord } from './api';
import { AssetFieldsFormFields, useAssetFieldsForm } from './AssetFieldsForm';
import { unsatisfiableRequiredFields } from './field-values';
import { recallListFilter } from './list-filter-memory';
import {
  useAssetDetail,
  useCreateAsset,
  useLayout,
  useUpdateAsset,
} from './queries';

/**
 * Create / edit form — a full-viewport routed page (the Shell hides
 * the tab bar for these paths). The field editors are dynamic over the
 * layout; this screen owns the gates (scope, canManage, archived
 * asset, unavailable layout, unsatisfiable-create), the optional Name
 * override, Save wiring, and navigation.
 */
export function AssetFormScreen(
  props: { mode: 'create'; layoutId: string } | { mode: 'edit'; assetId: string },
) {
  const { currentOrg, scopeStatus } = useOrgScope();
  const { canWrite, isClientUser } = useCompanyAccess();
  const canManage = canWrite && !isClientUser;
  const navigate = useScopedNavigate();

  const isEdit = props.mode === 'edit';
  const assetId = isEdit ? props.assetId : '';
  const orgId = currentOrg?.id ?? null;
  const detailQuery = useAssetDetail(isEdit ? orgId : null, assetId);
  const layoutId = isEdit
    ? (detailQuery.data?.assetLayoutId ?? null)
    : props.layoutId;
  const layoutQuery = useLayout(layoutId);

  // Deep-linked or role-changed viewers without write access bounce
  // straight back — the server would 403 the save anyway.
  useEffect(() => {
    if (scopeStatus === 'ready' && !canManage) {
      navigate({ to: '/assets', replace: true });
    }
  }, [scopeStatus, canManage, navigate]);

  // Create-mode Cancel pops to the LIST when the flow started there
  // (the chooser replaced itself with this form, so the list is one
  // entry behind and its filters survive the pop); a cold deep link
  // falls back to the structural navigation with remembered filters.
  const cancelCreate = useBackOr('/assets', recallListFilter(orgId));
  const cancelEdit = useBackOr(isEdit ? `/assets/${assetId}` : '/assets');
  const cancel = isEdit ? cancelEdit : cancelCreate;
  const title = isEdit ? 'Edit asset' : 'New asset';

  // A malformed `/assets/<junk>/edit` deep link would otherwise hang on
  // the skeleton forever: the UUID guard in useAssetDetail disables the
  // query, and a disabled query reports `isPending` indefinitely.
  if (isEdit && !UUID_RE.test(assetId)) {
    return (
      <FormScreenChrome title={title} onCancel={cancel}>
        <EmptyState message="This asset wasn’t found. It may have been removed, or you may not have access to it." />
      </FormScreenChrome>
    );
  }

  if (scopeStatus !== 'ready' || !currentOrg || !canManage) {
    return (
      <FormScreenChrome title={title} onCancel={cancel}>
        <SkeletonList rows={4} variant="row" />
      </FormScreenChrome>
    );
  }

  if (isEdit) {
    if (detailQuery.isPending) {
      return (
        <FormScreenChrome title={title} onCancel={cancel}>
          <SkeletonList rows={4} variant="row" />
        </FormScreenChrome>
      );
    }
    if (detailQuery.error || !detailQuery.data) {
      return (
        <FormScreenChrome title={title} onCancel={cancel}>
          <ErrorBanner
            title="Couldn’t load this asset."
            detail="Check your connection and try again."
            onRetry={() => void detailQuery.refetch()}
          />
        </FormScreenChrome>
      );
    }
    // The server refuses edits on archived assets with this exact copy;
    // gating here covers deep links without waiting for the 400.
    if (detailQuery.data.archivedAt !== null) {
      return (
        <FormScreenChrome title={title} onCancel={cancel}>
          <ErrorBanner title="Cannot edit an archived asset — restore it first." />
        </FormScreenChrome>
      );
    }
  }

  if (layoutQuery.isPending || (isEdit && !detailQuery.data)) {
    return (
      <FormScreenChrome title={title} onCancel={cancel}>
        <SkeletonList rows={4} variant="row" />
      </FormScreenChrome>
    );
  }
  if (layoutQuery.error || !layoutQuery.data) {
    return (
      <FormScreenChrome title={title} onCancel={cancel}>
        <ErrorBanner
          title="Couldn’t load this layout."
          detail="Check your connection and try again."
          onRetry={() => void layoutQuery.refetch()}
        />
      </FormScreenChrome>
    );
  }

  const layout = layoutQuery.data;

  if (!isEdit && (layout.archivedAt !== null || !layout.isActive)) {
    return (
      <FormScreenChrome title={title} onCancel={cancel}>
        <ErrorBanner
          title="This layout isn’t available."
          detail="Pick a different layout, or ask an administrator."
        />
      </FormScreenChrome>
    );
  }

  if (!isEdit) {
    const blocked = unsatisfiableRequiredFields(layout.fields);
    if (blocked.length > 0) {
      // The API enforces `isRequired` on EVERY field at create — a
      // required field mobile renders read-only makes this form
      // unsatisfiable. Explicit guidance beats a doomed submit.
      return (
        <FormScreenChrome title={title} onCancel={cancel}>
          <ErrorBanner
            title="This layout requires desktop."
            detail={
              blocked.map((f) => f.name).join(', ') +
              (blocked.length === 1 ? ' is a required field' : ' are required fields') +
              ' that can only be filled in on desktop — create this asset there.'
            }
          />
        </FormScreenChrome>
      );
    }
  }

  return (
    <AssetFormFields
      key={isEdit ? detailQuery.data!.id : layout.id}
      org={currentOrg}
      layout={layout}
      original={isEdit ? detailQuery.data! : null}
      onCancel={cancel}
    />
  );
}

function AssetFormFields({
  org,
  layout,
  original,
  onCancel,
}: {
  org: Org;
  layout: LayoutRecord;
  original: AssetRecord | null;
  onCancel: () => void;
}) {
  const navigate = useScopedNavigate();
  const toast = useToast();
  const isEdit = original !== null;

  const form = useAssetFieldsForm({ layoutFields: layout.fields, asset: original });
  const [name, setName] = useState(original?.name ?? '');

  const createMutation = useCreateAsset(org.id);
  const updateMutation = useUpdateAsset(org.id, original?.id ?? '');
  const busy = createMutation.isPending || updateMutation.isPending;

  const primaryField = layout.fields.find(
    (f) => f.isPrimary && f.archivedAt === null,
  );

  const updatePayload = isEdit ? form.buildUpdate(original.name, name) : null;
  const saveDisabled =
    busy ||
    form.uploadsPending ||
    form.invalidNumbers().length > 0 ||
    (isEdit && updatePayload === null);

  function onSave() {
    form.clearFormError();

    const badNumbers = form.invalidNumbers();
    if (badNumbers.length > 0) {
      form.setFieldErrors(
        Object.fromEntries(badNumbers.map((slug) => [slug, 'Enter a number.'])),
      );
      return;
    }

    if (!isEdit) {
      // Local required pre-check saves a round trip; the server's
      // create-mode enforcement stays authoritative and maps onto the
      // same fields if this misses anything.
      const missing = form.missingRequired();
      if (missing.length > 0) {
        form.setFieldErrors(
          Object.fromEntries(missing.map((slug) => [slug, 'Required.'])),
        );
        return;
      }
      createMutation.mutate(form.buildCreate(layout.id, name), {
        onSuccess: (created) => {
          toast.push('Asset created', 'ok');
          // Replace so back skips the stale form; the detail cache is
          // pre-seeded by the mutation's onSuccess.
          navigate({ to: `/assets/${created.id}`, replace: true });
        },
        onError: (err) => form.applyServerError(err),
      });
      return;
    }

    if (updatePayload === null) return;
    updateMutation.mutate(updatePayload, {
      onSuccess: () => {
        toast.push('Asset saved', 'ok');
        onCancel();
      },
      onError: (err) => form.applyServerError(err),
    });
  }

  return (
    <FormScreenChrome
      title={isEdit ? 'Edit asset' : 'New asset'}
      onCancel={onCancel}
      saveDisabled={saveDisabled}
      onSave={onSave}
    >
      {form.formError && <ErrorBanner title={form.formError} />}

      <FieldBlock
        label="Name"
        htmlFor="af-asset-name"
        hint={
          primaryField
            ? `Derived from ${primaryField.name} when left empty.`
            : undefined
        }
      >
        <Input
          id="af-asset-name"
          type="text"
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
          placeholder={primaryField ? `(from ${primaryField.name})` : undefined}
        />
      </FieldBlock>

      <AssetFieldsFormFields
        form={form}
        companyId={org.id}
        asset={original}
        disabled={busy}
      />
    </FormScreenChrome>
  );
}
