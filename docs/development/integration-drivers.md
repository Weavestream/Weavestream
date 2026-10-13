---
label: Integration drivers
icon: plug
order: 190
description: The standard every new integration driver follows, and what the conformance test checks.
---

# Integration Drivers

New pull drivers follow one pattern, shared today by Level RMM, Google Workspace and Microsoft 365. Following it is what lets several integrations share one asset: Map layouts pre-selects the same layout and fields for each of them, the integration priority order decides which one owns each field, and the Differences tab shows where a person changed a value.

`apps/api/src/integrations/drivers/driver-conformance.spec.ts` checks every registered driver against this page. A driver that declares `matchSuggestions` must pass all of it.

## Resources

Describe each asset resource as a `StandardResourceSpec` in one `RESOURCES` record, and build everything from it with the helpers in `drivers/standard-resources.ts`:

| Driver member | Helper |
| --- | --- |
| `descriptor.resources` | `standardResources(RESOURCES)` |
| `recommendedDestinations` | `standardRecommendedDestinations(driverKey, RESOURCES)` |
| `listSourceFields()` | `standardSourceFields(spec, { matchAlwaysPresent, extras })` |

- **Match key.** Use a `MATCH_KEYS` entry (serial number, email, group email) when the record has one. Override only `field` when the source names it differently (`{ ...MATCH_KEYS.email, field: 'primaryEmail' }`).
- **Layout hints.** Use `LAYOUT_HINTS` for computers, phones, people and distribution lists. Hint order decides the pre-selected layout, so drivers that see the same kind of record must use the same list.
- **Standard facts.** Take every fact from `STANDARD_FIELDS`. If a fact is missing, add it to the catalog, not to the driver. Override only the label when the source is narrower than the fact (`MAC address (Wi-Fi)`).

## Records

- `fields` holds the name, the match key and the standard facts. Nothing else is written into the operator's layout fields.
- Everything else goes into `section`: plain data validated against `integrationSectionSchema`, never HTML. The runner drops an invalid or credential-shaped section with a run warning.
- Leave the match key empty when the source has none (for example, a VM without a serial). The asset is then created and bound by its source id.

## Setup and errors

- Ship a `setupGuide` and a `diagnose()` that checks it. Failure messages name a guide step and never carry provider error text.
- Throw `DriverResourceUnavailableError` from the first page of `fetchRecords` when the tenant cannot provide a resource at all (not licensed, an optional permission not granted). The runner skips it with a warning and keeps its bindings.
- Optional data that fails becomes a note in the section (`optional()` in `drivers/run-cache.ts`). Only a `DriverRateLimitError` may escape.

## HTTP and isolation

- Call `fetchWithRetry` (or `oauthFetch`). It never follows a redirect unless the caller passes `redirect: 'follow'`, because a redirect would carry the API key or token to another host. Do not pass `'follow'` on an authenticated request.
- Never echo provider error text. Errors carry the HTTP status and a fixed message.
- Before you fetch, check that `ctx.externalOrgId` belongs to the connected account or tenant. Knowing an id is not access.
- Cache lookups that every page of a run needs with `runCached()` from `drivers/run-cache.ts`, and call `evictRun()` on the last page.

## Drivers outside the standard

Breeze (typed reconstruction) and the earlier Action1, NinjaOne and UniFi drivers predate this pattern. They write their own fields and do not take part in shared assets. Do not copy them for a new driver.
