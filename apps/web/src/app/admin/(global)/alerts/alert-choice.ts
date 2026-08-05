import {
  ALERT_TYPE_DESCRIPTIONS,
  ALERT_TYPE_LABELS,
  SECURITY_ALERT_DESCRIPTIONS,
  SECURITY_ALERT_LABELS,
  alertTypeValues,
  isSecurityAlertSelector,
  securityAlertSelectorValues,
  type AlertExpirationKind,
  type AlertRecordAction,
  type AlertRecordEntityType,
  type AlertType,
  type SecurityAlertSelector,
} from '@weavestream/shared';
import type { CompanyPickerValue } from '../../../../components/ui';

/**
 * Pure draft-state logic for the alert wizard, kept out of the client
 * component so the type-transition invariants are unit-testable
 * (`proxy.ts`-style: the React file itself has no test harness).
 *
 * The invariant this module owns: a "security" draft is a RECORD_EVENT
 * draft whose `recordEntityTypes` is exactly one reserved selector,
 * with `recordActions: ['all']` and no company scope — and switching
 * to any conventional choice must strip the selector so it can never
 * ride along into another type's payload.
 */

export interface DraftState {
  name: string;
  type: AlertType;
  enabled: boolean;
  /** Free-form text — split on commas/semicolons/newlines on save. */
  recipientEmails: string;
  company: CompanyPickerValue | null;
  triggerDays: string;
  stopAfterTrigger: boolean;
  expirationKinds: AlertExpirationKind[];
  recordEntityTypes: AlertRecordEntityType[];
  recordActions: AlertRecordAction[];
}

export function emptyDraft(): DraftState {
  return {
    name: '',
    type: 'SINGLE_EXPIRATION',
    enabled: true,
    recipientEmails: '',
    company: null,
    triggerDays: '30',
    stopAfterTrigger: true,
    expirationKinds: ['domain_registrar', 'domain_tls'],
    recordEntityTypes: ['all'],
    recordActions: ['all'],
  };
}

/** One step-1 wizard card: a conventional alert type or a security kind. */
export type AlertChoice =
  | { kind: 'type'; type: AlertType }
  | { kind: 'security'; selector: SecurityAlertSelector };

export interface AlertChoiceCard {
  choice: AlertChoice;
  label: string;
  description: string;
}

export const ALERT_CHOICE_CARDS: readonly AlertChoiceCard[] = [
  ...alertTypeValues.map((type) => ({
    choice: { kind: 'type', type } as AlertChoice,
    label: ALERT_TYPE_LABELS[type],
    description: ALERT_TYPE_DESCRIPTIONS[type],
  })),
  ...securityAlertSelectorValues.map((selector) => ({
    choice: { kind: 'security', selector } as AlertChoice,
    label: SECURITY_ALERT_LABELS[selector],
    description: SECURITY_ALERT_DESCRIPTIONS[selector],
  })),
];

export function choiceKey(choice: AlertChoice): string {
  return choice.kind === 'security' ? choice.selector : choice.type;
}

/**
 * The reserved selector of a security config/draft, or null. Works on
 * both `AlertConfig` rows and wizard drafts (structural match). The
 * `type` check matters: a draft mid-transition could momentarily carry
 * a leftover selector under another type, and must NOT render (or
 * label) as a security alert then.
 */
export function securitySelectorOfConfig(config: {
  type: AlertType;
  recordEntityTypes: readonly string[];
}): SecurityAlertSelector | null {
  if (config.type !== 'RECORD_EVENT') return null;
  if (config.recordEntityTypes.length !== 1) return null;
  const sole = config.recordEntityTypes[0];
  return isSecurityAlertSelector(sole) ? sole : null;
}

/** Display label for the list/table: security kind label, else the type label. */
export function alertKindLabel(config: {
  type: AlertType;
  recordEntityTypes: readonly string[];
}): string {
  const selector = securitySelectorOfConfig(config);
  return selector ? SECURITY_ALERT_LABELS[selector] : ALERT_TYPE_LABELS[config.type];
}

/** The step-1 card matching the draft's current choice (for step-2 header). */
export function activeChoiceCard(draft: DraftState): AlertChoiceCard | null {
  const selector = securitySelectorOfConfig(draft);
  const key = selector ?? draft.type;
  return ALERT_CHOICE_CARDS.find((c) => choiceKey(c.choice) === key) ?? null;
}

/**
 * Apply a step-1 choice to the draft.
 *
 * Security choice → set the exact invariant in one transition: type
 * RECORD_EVENT, the selector as the sole entity type, actions
 * `['all']`, company cleared (security alerts are global).
 *
 * Conventional choice → strip any reserved selector so it can never
 * ride along (`toPayload` always sends `recordEntityTypes`, and the
 * server rejects hybrids); restore a picker-safe `['all']` default
 * when the strip empties the list.
 */
export function selectAlertChoice(
  draft: DraftState,
  choice: AlertChoice,
): DraftState {
  if (choice.kind === 'security') {
    return {
      ...draft,
      type: 'RECORD_EVENT',
      recordEntityTypes: [choice.selector],
      recordActions: ['all'],
      company: null,
    };
  }

  const cleanedEntityTypes = draft.recordEntityTypes.filter(
    (v) => !isSecurityAlertSelector(v),
  );
  return {
    ...draft,
    type: choice.type,
    recordEntityTypes:
      cleanedEntityTypes.length > 0 ? cleanedEntityTypes : ['all'],
    recordActions: draft.recordActions.length > 0 ? draft.recordActions : ['all'],
  };
}

/**
 * The `recordActions` a save payload may carry for the draft's type.
 *
 * PASSWORD_EVENT hides the 'deleted' checkbox (the vault archives,
 * never hard-deletes), but the draft can still hold that action — an
 * edited legacy config, or a RECORD_EVENT draft with "Deleted" checked
 * switched to PASSWORD_EVENT — and the server would reject it with an
 * error naming a checkbox that isn't on screen. Strip to the server's
 * accepted set ('all' included: it validates and means created-or-
 * updated here); every other type passes through untouched.
 */
export function payloadRecordActions(draft: {
  type: AlertType;
  recordActions: readonly AlertRecordAction[];
}): AlertRecordAction[] {
  if (draft.type !== 'PASSWORD_EVENT') return [...draft.recordActions];
  return draft.recordActions.filter(
    (a) => a === 'created' || a === 'updated' || a === 'all',
  );
}
