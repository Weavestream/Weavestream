import type { SetupGuideStep } from '@weavestream/shared';

/** Step ids of the Custom API setup guide. `diagnose()` names these, so keep them stable. */
export const CUSTOM_API_SETUP_STEP = {
  definition: 'definition',
  credentials: 'credentials',
  organizations: 'organizations',
  layouts: 'layouts',
} as const;

const S = CUSTOM_API_SETUP_STEP;

/** Plain text: blank-line paragraphs, `- ` bullets and `**bold**` only. */
export const CUSTOM_API_SETUP_GUIDE: SetupGuideStep[] = [
  {
    id: S.definition,
    title: 'Describe the API',
    body: [
      'On the **Credentials & schedule** tab, enter the **Base URL** of the API. It must start with https://.',
      'Fill **Organizations**: where the list of organizations is, or which field of each record names its organization, or that all records belong to one organization.',
      'Fill **Devices**, **Other assets**, or both: the request, where the list of records is, how pages work, and which path in each record holds each field. Turn off a resource the API does not have.',
      'Press **Test** in each section. It reads the first page and shows the values that each path finds.',
    ].join('\n\n'),
  },
  {
    id: S.credentials,
    title: 'Enter the credentials',
    body: [
      'Pick the **Authentication** method the API uses and enter its credentials. They are stored encrypted and are never shown again.',
      'If you change the Base URL or the token URL to a different host, enter the credentials again in the same save.',
    ].join('\n\n'),
  },
  {
    id: S.organizations,
    title: 'Map each organization to a company',
    body: 'Open **Organizations**. Each organization the API returns is listed. Map each one to its Weavestream company.',
  },
  {
    id: S.layouts,
    title: 'Map layouts, then sync',
    body: [
      'Open **Map layouts**. Pick the layout devices go into and the field to match on (for example Serial number).',
      'On the first sync, Weavestream links to the assets you already have when the serial number is equal. It only creates an asset when there is no match.',
      'Press **Dry run** to preview, then **Run sync now**.',
    ].join('\n\n'),
  },
];
