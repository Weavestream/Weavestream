import type { SetupGuideStep } from '@weavestream/shared';

/** Step ids of the Action1 setup guide. `diagnose()` names these, so keep them stable. */
export const ACTION1_SETUP_STEP = {
  apiCredential: 'api-credential',
  region: 'region',
  credentials: 'credentials',
  organizations: 'organizations',
  fields: 'fields',
  sync: 'sync',
} as const;

/** Regional API base URLs, from Action1's own PSAction1 host table. */
export const ACTION1_REGION_BASE_URLS = [
  { label: 'North America (default)', value: 'https://app.action1.com/api/3.0' },
  { label: 'North America 2', value: 'https://app.na-2.action1.com/api/3.0' },
  { label: 'Europe', value: 'https://app.eu.action1.com/api/3.0' },
  { label: 'United Kingdom', value: 'https://app.uk.action1.com/api/3.0' },
  { label: 'Australia', value: 'https://app.au.action1.com/api/3.0' },
] as const;

const S = ACTION1_SETUP_STEP;

/** Plain text: blank-line paragraphs, `- ` bullets and `**bold**` only. */
export const ACTION1_SETUP_GUIDE: SetupGuideStep[] = [
  {
    id: S.apiCredential,
    title: 'Create read-only API credentials in Action1',
    body: [
      'In the Action1 console, open **Configuration | Users & API Credentials** and press **+ New API Credentials**.',
      'Give them a name you will recognise, for example **Weavestream**, and select the **Enterprise Viewer** role. It is a built-in read-only role that can see endpoints in every organization. Weavestream only reads from Action1.',
      'Copy the **Client ID** and the **Client Secret**. Action1 shows the secret only until you close the pop-up. If you lose it, create new credentials.',
      'To give credentials you already have another role, follow Action1\'s role assignment page below.',
    ].join('\n\n'),
    links: [
      { label: 'Action1 API credentials', href: 'https://www.action1.com/api-documentation/api-credentials/' },
      { label: 'Action1 built-in roles', href: 'https://www.action1.com/documentation/users-and-roles/' },
      { label: 'Assigning a role in Action1', href: 'https://www.action1.com/documentation/managing-roles/assign-role-to-user/' },
    ],
  },
  {
    id: S.region,
    title: 'Pick the API base URL for your region',
    body: [
      'Each Action1 account lives in one region, and its credentials work only there. Copy the API base URL of the region where your Action1 account was created.',
      'For North America, leave **API Base URL** at its default.',
    ].join('\n\n'),
    copyValues: ACTION1_REGION_BASE_URLS.map((r) => ({ label: r.label, value: r.value })),
    links: [
      { label: 'Action1 regions', href: 'https://www.action1.com/documentation/migrating-between-regions/' },
      { label: 'PSAction1 regional API hosts', href: 'https://github.com/Action1Corp/PSAction1/blob/main/Private/Configuration/Action1.Hosts.ps1' },
    ],
  },
  {
    id: S.credentials,
    title: 'Paste the credentials into Weavestream',
    body: [
      'On this integration\'s **Credentials & schedule** tab, paste the **Client ID** and the **Client Secret**, set **API Base URL** (step 2), and save.',
      'Press **Test connection**, then **Check setup**. Steps that pass turn green.',
    ].join('\n\n'),
  },
  {
    id: S.organizations,
    title: 'Map each Action1 organization to a company',
    body: [
      'Open **Organizations**. Each Action1 organization the credentials can see is listed. Map each one to its Weavestream company.',
      'If an organization is missing, check that the role from step 1 covers it.',
    ].join('\n\n'),
  },
  {
    id: S.fields,
    title: 'Map endpoint fields',
    body: [
      'Open **Endpoints fields**. Pick the asset layout that endpoints go into, the match key (**MAC** is suggested), and which Action1 fields fill which layout fields.',
      'Weavestream reads the field list from a few endpoints in the organization. If the organization has no endpoints yet, it shows a standard list.',
    ].join('\n\n'),
  },
  {
    id: S.sync,
    title: 'Dry run, then sync',
    body: [
      'New integrations start paused. On **Credentials & schedule**, set **Status** to active and press **Save changes**.',
      'Press **Dry run** and review the result in **Run history**. Then press **Run sync now**.',
    ].join('\n\n'),
  },
];
