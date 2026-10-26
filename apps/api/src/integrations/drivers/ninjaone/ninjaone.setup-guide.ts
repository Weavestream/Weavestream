import type { SetupGuideStep } from '@weavestream/shared';

/** Step ids of the NinjaOne setup guide. `diagnose()` names these, so keep them stable. */
export const NINJAONE_SETUP_STEP = {
  apiClient: 'api-client',
  region: 'region',
  credentials: 'credentials',
  organizations: 'organizations',
  fields: 'fields',
  sync: 'sync',
  tickets: 'tickets',
} as const;

/** The default (US) API base URL. */
export const NINJAONE_DEFAULT_BASE_URL = 'https://app.ninjarmm.com';

/**
 * Regional API base URLs other than the default (`https://app.ninjarmm.com`),
 * from NinjaOne's own instance list. Each host answers `/ws/oauth/token`.
 */
export const NINJAONE_REGION_BASE_URLS = [
  { label: 'United States 2 (us2)', value: 'https://us2.ninjarmm.com' },
  { label: 'Canada', value: 'https://ca.ninjarmm.com' },
  { label: 'Europe', value: 'https://eu.ninjarmm.com' },
  { label: 'Asia-Pacific Southeast (OC)', value: 'https://oc.ninjarmm.com' },
  { label: 'Japan', value: 'https://jp.ninjarmm.com' },
  { label: 'FedRAMP Moderate', value: 'https://fed.ninjarmm.com' },
] as const;

const S = NINJAONE_SETUP_STEP;

/** Plain text: blank-line paragraphs, `- ` bullets and `**bold**` only. */
export const NINJAONE_SETUP_GUIDE: SetupGuideStep[] = [
  {
    id: S.apiClient,
    title: 'Create an API client app in NinjaOne',
    body: [
      'In NinjaOne, open **Administration > Apps > API**, select the **Client app IDs** tab and press **Add client app**.',
      'Set **Application Platform** to **API Services (machine-to-machine)**. Then fill in:',
      [
        '- **Name**: a name you will recognise, for example **Weavestream**.',
        '- **Redirect URIs**: leave empty. This flow has no user sign-in.',
        '- **Scopes**: select **Monitoring** only. It gives read-only access to devices and organizations. Weavestream only reads from NinjaOne, so it needs no **Management** or **Control** scope.',
        '- **Allowed Grant Types**: select **Client Credentials**.',
      ].join('\n'),
      'Press **Save** and copy the **Client ID** and the **Client Secret**. Keep the secret safe.',
    ].join('\n\n'),
    links: [
      { label: 'Register an API Services app', href: 'https://app.ninjarmm.com/apidocs-beta/authorization/create-applications/machine-to-machine-apps' },
      { label: 'Client credentials flow', href: 'https://app.ninjarmm.com/apidocs-beta/authorization/flows/client-credentials-flow' },
      { label: 'NinjaOne API OAuth token setup', href: 'https://www.ninjaone.com/docs/application-programming-interface-api/oauth-token-configuration/' },
    ],
  },
  {
    id: S.region,
    title: 'Pick the API base URL for your region',
    body: [
      'Each NinjaOne account lives on one regional instance, and its client app works only there. Use the host you see in the address bar when you sign in to NinjaOne.',
      'For **app.ninjarmm.com** (United States), leave **API Base URL** at its default. For any other instance, copy its URL below.',
    ].join('\n\n'),
    copyValues: NINJAONE_REGION_BASE_URLS.map((r) => ({ label: r.label, value: r.value })),
    links: [
      { label: 'NinjaOne regional instances', href: 'https://www.ninjaone.com/blog/how-to-set-up-an-api-server-in-ninjaone/' },
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
    title: 'Map each NinjaOne organization to a company',
    body: [
      'Open **Organizations**. Each NinjaOne organization is listed. Map each one to its Weavestream company.',
      'Organizations that you do not map are not synced.',
    ].join('\n\n'),
  },
  {
    id: S.fields,
    title: 'Map device fields',
    body: [
      'Open **Agent devices fields**. Pick the asset layout that devices with the NinjaOne agent go into, the match key (**uid**, the NinjaOne device id, is suggested), and which NinjaOne fields fill which layout fields.',
      'Weavestream reads the field list from a few devices in the organization. If the organization has no devices yet, it shows a standard list.',
      'To also sync network gear and virtual machines that have no agent, set up **Network & non-agent devices fields** the same way, with its own layout. Leave it empty to skip those devices.',
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
  {
    id: S.tickets,
    title: 'Optional: NinjaOne tickets',
    body: [
      'Weavestream can also show NinjaOne tickets, read-only, with the same client app. It reads them from your NinjaOne ticket boards.',
      'If no tickets show, check that NinjaOne Ticketing is turned on for your account and that it has at least one ticket board. Device sync works without it.',
    ].join('\n\n'),
  },
];
