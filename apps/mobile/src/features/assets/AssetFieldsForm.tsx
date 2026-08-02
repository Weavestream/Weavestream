import { useCallback, useMemo, useRef, useState } from 'react';
import {
  HTTP_URL_VALIDATION_MESSAGE,
  type CreateAssetInput,
  type UpdateAssetInput,
} from '@weavestream/shared';
import { FieldBlock } from '../../components/FieldBlock';
import type { AssetFieldMeta, AssetRecord, LayoutFieldRecord } from './api';
import { AssetFieldValue } from './FieldValueDisplay';
import { AssetReferencePicker } from './AssetReferencePicker';
import { FileFieldEditor } from './FileFieldEditor';
import { ReadonlyField, ScalarFieldEditor } from './FieldEditor';
import { TagsInput } from './TagsInput';
import {
  buildCreateAssetPayload,
  buildUpdateAssetPayload,
  invalidNumberSlugs,
  invalidUrlSlugs,
  mapAssetWriteError,
  missingRequiredSlugs,
  seedAssetForm,
  type AssetFormModel,
  type FieldEditorValue,
} from './field-values';

/**
 * The dynamic-form assembly seam: `useAssetFieldsForm` owns the value
 * model, dirty/error state, and the payload builders; the fields
 * component renders every active layout field in position order as a
 * `FieldBlock`. Screens own Save/Cancel wiring, mutations, and
 * navigation.
 *
 * Reseeding is by REMOUNT (the screen keys this on the asset id), the
 * PasswordFormScreen precedent — no effect-based resync.
 */

export interface AssetFieldsFormApi {
  activeFields: LayoutFieldRecord[];
  model: AssetFormModel;
  setValue: (slug: string, next: FieldEditorValue) => void;
  fieldErrors: Record<string, string>;
  formError: string | null;
  /** True while any FILE upload is in flight — Save must stay disabled. */
  uploadsPending: boolean;
  setPendingCount: (slug: string, inFlight: number) => void;
  applyServerError: (err: unknown) => void;
  setFieldErrors: (errors: Record<string, string>) => void;
  clearFormError: () => void;
  /** Create-time pre-check; server stays authoritative. */
  missingRequired: () => string[];
  invalidNumbers: () => string[];
  invalidUrls: () => string[];
  buildCreate: (assetLayoutId: string, name: string) => CreateAssetInput;
  buildUpdate: (originalName: string, name: string) => UpdateAssetInput | null;
}

export function useAssetFieldsForm({
  layoutFields,
  asset,
}: {
  layoutFields: LayoutFieldRecord[];
  asset: AssetRecord | null;
}): AssetFieldsFormApi {
  const activeFields = useMemo(
    () => layoutFields.filter((f) => f.archivedAt === null),
    [layoutFields],
  );
  const [model, setModel] = useState<AssetFormModel>(() => seedAssetForm(layoutFields, asset));
  const [fieldErrors, setFieldErrorsState] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingTotal, setPendingTotal] = useState(0);
  const pendingBySlug = useRef(new Map<string, number>());

  const setValue = useCallback((slug: string, next: FieldEditorValue) => {
    setModel((prev) => ({ ...prev, values: { ...prev.values, [slug]: next } }));
    // Typing in a field clears its mapped server error.
    setFieldErrorsState((prev) => {
      if (!(slug in prev)) return prev;
      const { [slug]: _dropped, ...rest } = prev;
      return rest;
    });
  }, []);

  const setPendingCount = useCallback((slug: string, inFlight: number) => {
    pendingBySlug.current.set(slug, inFlight);
    let total = 0;
    for (const n of pendingBySlug.current.values()) total += n;
    setPendingTotal(total);
  }, []);

  const knownSlugs = useMemo(() => new Set(activeFields.map((f) => f.slug)), [activeFields]);

  const clientUrlErrors = useMemo(
    () =>
      Object.fromEntries(
        invalidUrlSlugs(layoutFields, model).map((slug) => [slug, HTTP_URL_VALIDATION_MESSAGE]),
      ),
    [layoutFields, model],
  );

  const applyServerError = useCallback(
    (err: unknown) => {
      const view = mapAssetWriteError(err, knownSlugs);
      setFieldErrorsState(view.fieldErrors);
      setFormError(view.formError);
    },
    [knownSlugs],
  );

  return {
    activeFields,
    model,
    setValue,
    fieldErrors: { ...fieldErrors, ...clientUrlErrors },
    formError,
    uploadsPending: pendingTotal > 0,
    setPendingCount,
    applyServerError,
    setFieldErrors: setFieldErrorsState,
    clearFormError: () => setFormError(null),
    missingRequired: () => missingRequiredSlugs(layoutFields, model),
    invalidNumbers: () => invalidNumberSlugs(layoutFields, model),
    invalidUrls: () => invalidUrlSlugs(layoutFields, model),
    buildCreate: (assetLayoutId, name) =>
      buildCreateAssetPayload(assetLayoutId, name, layoutFields, model),
    buildUpdate: (originalName, name) =>
      buildUpdateAssetPayload(originalName, name, layoutFields, model),
  };
}

/** One `FieldBlock` per active field, position order, every type. */
export function AssetFieldsFormFields({
  form,
  companyId,
  asset,
  disabled,
}: {
  form: AssetFieldsFormApi;
  companyId: string | null;
  /** The asset being edited (null on create) — read-only display + refs. */
  asset: AssetRecord | null;
  disabled?: boolean;
}) {
  return (
    <>
      {form.activeFields.map((field) => {
        const value = form.model.values[field.slug];
        if (!value) return null;
        const id = `af-${field.slug}`;
        return (
          <FieldBlock
            key={field.id}
            label={field.isRequired ? `${field.name} *` : field.name}
            htmlFor={id}
            error={form.fieldErrors[field.slug] ?? null}
          >
            <AssetFieldControl
              field={field}
              id={id}
              value={value}
              form={form}
              companyId={companyId}
              asset={asset}
              disabled={disabled}
            />
          </FieldBlock>
        );
      })}
    </>
  );
}

function AssetFieldControl({
  field,
  id,
  value,
  form,
  companyId,
  asset,
  disabled,
}: {
  field: LayoutFieldRecord;
  id: string;
  value: FieldEditorValue;
  form: AssetFieldsFormApi;
  companyId: string | null;
  asset: AssetRecord | null;
  disabled?: boolean;
}) {
  switch (value.kind) {
    case 'readonly': {
      // RICH_TEXT / VAULTWARDEN_LINK / unknown — shown, never editable,
      // never serialized. The display component needs the thinner
      // AssetFieldMeta shape.
      const displayField: AssetFieldMeta = {
        id: field.id,
        slug: field.slug,
        name: field.name,
        fieldType: field.fieldType,
        isPrimary: field.isPrimary,
        visibleToClients: field.visibleToClients,
        options: field.options,
      };
      return (
        <ReadonlyField>
          <AssetFieldValue
            field={displayField}
            value={asset?.fieldValues[field.slug]}
            references={asset?.references ?? {}}
          />
        </ReadonlyField>
      );
    }
    case 'tags':
      return (
        <TagsInput
          id={id}
          value={value.chips}
          onChange={(chips) => form.setValue(field.slug, { kind: 'tags', chips })}
          disabled={disabled}
        />
      );
    case 'reference':
      return (
        <AssetReferencePicker
          field={field}
          id={id}
          companyId={companyId}
          currentAssetId={asset?.id}
          value={value}
          onChange={(next) => form.setValue(field.slug, next)}
          disabled={disabled}
        />
      );
    case 'file':
      return (
        <FileFieldEditor
          field={field}
          id={id}
          companyId={companyId}
          value={value}
          onChange={(next) => form.setValue(field.slug, next)}
          onPendingChange={(n) => form.setPendingCount(field.slug, n)}
          disabled={disabled}
        />
      );
    default:
      return (
        <ScalarFieldEditor
          field={field}
          id={id}
          value={value}
          onChange={(next) => form.setValue(field.slug, next)}
          disabled={disabled}
        />
      );
  }
}
