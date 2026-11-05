import {
  CUSTOM_API_RESOURCE_KEYS,
  parsePath,
  readPath,
  type CustomApiDefinition,
  type CustomApiResource,
  type SourceOrgDto,
} from '@weavestream/shared';
import type { CustomApiCall } from './custom-api.http.js';
import { fetchAllItems, type ListSpec } from './custom-api.pagination.js';
import { capText, idAt } from './custom-api.records.js';

/**
 * Source organizations of a Custom API integration, by mode:
 *   - endpoint: the organizations request, read with idPath and namePath;
 *   - field: the distinct values of each enabled resource's orgIdPath;
 *   - single: one organization, `default`, for all records.
 */

export const SINGLE_ORG_ID = 'default';
export const SINGLE_ORG_NAME = 'All records';

function nameAt(item: unknown, path: string | undefined): string | null {
  if (!path) return null;
  const read = readPath(item, parsePath(path));
  if (read.kind !== 'value') return null;
  const name = capText(String(read.value)).trim().slice(0, 200);
  return name === '' ? null : name;
}

export function resourceListSpec(resource: CustomApiResource): ListSpec {
  return { request: resource.request, recordsPath: resource.recordsPath, pagination: resource.pagination };
}

export function enabledResources(definition: CustomApiDefinition): Array<{ key: (typeof CUSTOM_API_RESOURCE_KEYS)[number]; resource: CustomApiResource }> {
  const out: Array<{ key: (typeof CUSTOM_API_RESOURCE_KEYS)[number]; resource: CustomApiResource }> = [];
  for (const key of CUSTOM_API_RESOURCE_KEYS) {
    const resource = definition.resources[key];
    if (resource.enabled) out.push({ key, resource });
  }
  return out;
}

/** Organizations from organization records (endpoint mode). Records without a usable id are skipped. */
export function orgsFromItems(items: unknown[], idPath: string, namePath: string | undefined): SourceOrgDto[] {
  const seen = new Map<string, SourceOrgDto>();
  for (const item of items) {
    const id = idAt(item, idPath);
    if (id === null) continue;
    const existing = seen.get(id);
    const name = nameAt(item, namePath);
    if (!existing) seen.set(id, { externalId: id, name: name ?? id, hint: null });
    else if (existing.name === id && name) existing.name = name;
  }
  return [...seen.values()];
}

export async function listOrganizations(call: CustomApiCall): Promise<SourceOrgDto[]> {
  const orgs = call.definition.organizations;
  switch (orgs.mode) {
    case 'single':
      return [{ externalId: SINGLE_ORG_ID, name: SINGLE_ORG_NAME, hint: null }];
    case 'endpoint': {
      const items = await fetchAllItems(call, { request: orgs.request, recordsPath: orgs.recordsPath, pagination: orgs.pagination }, {});
      return orgsFromItems(items, orgs.idPath, orgs.namePath);
    }
    case 'field': {
      const all: SourceOrgDto[] = [];
      for (const { resource } of enabledResources(call.definition)) {
        if (!resource.orgIdPath) continue;
        const items = await fetchAllItems(call, resourceListSpec(resource), {});
        all.push(...orgsFromItems(items, resource.orgIdPath, resource.orgNamePath));
      }
      return orgsFromItems(all, 'externalId', 'name');
    }
  }
}
