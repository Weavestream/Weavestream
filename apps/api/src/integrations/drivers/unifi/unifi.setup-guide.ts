import type { SetupGuideStep } from '@weavestream/shared';

/** Step ids of the UniFi setup guide. `diagnose()` names these, so keep them stable. */
export const UNIFI_SETUP_STEP = {
  apiKey: 'api-key',
  credentials: 'credentials',
  hosts: 'hosts',
  fields: 'fields',
  sync: 'sync',
} as const;

export const UNIFI_DEFAULT_BASE_URL = 'https://api.ui.com';

const S = UNIFI_SETUP_STEP;

/** Plain text: blank-line paragraphs, `- ` bullets and `**bold**` only. */
export const UNIFI_SETUP_GUIDE: SetupGuideStep[] = [
  {
    id: S.apiKey,
    title: 'Create a Site Manager API key in UniFi',
    body: [
      'Sign in to UniFi Site Manager at **unifi.ui.com** with the UI account that is **Owner** or **Super Admin** of your consoles. Open **Settings > API Keys** and press **Create New API Key**.',
      'The key belongs to the account that created it, and sees what that account sees. Site Manager lists devices only for consoles where that account is Owner or Super Admin.',
      'Site Manager API keys are read-only. Weavestream only reads from UniFi.',
      'Copy the key. UniFi shows it only once. If you lose it, create a new key.',
    ].join('\n\n'),
    links: [
      { label: 'UniFi Site Manager API keys', href: 'https://unifi.ui.com/settings/api-keys' },
      { label: 'Site Manager API getting started', href: 'https://developer.ui.com/site-manager/v1.0.0/gettingstarted' },
    ],
  },
  {
    id: S.credentials,
    title: 'Paste the key into Weavestream',
    body: [
      'On this integration\'s **Credentials & schedule** tab, paste the key into **API Key** and save. Leave **API Base URL** at its default.',
      'Press **Test connection**, then **Check setup**. Steps that pass turn green.',
    ].join('\n\n'),
    copyValues: [{ label: 'API Base URL (default)', value: UNIFI_DEFAULT_BASE_URL }],
  },
  {
    id: S.hosts,
    title: 'Map each UniFi console to a company',
    body: [
      'Open **Organizations**. Each UniFi console (Site Manager calls it a host) that the key can see is listed. Map each one to its Weavestream company.',
      'Devices sync from Site Manager. Clients are read through the console itself, from every site on it, so:',
      '- The console must be online when the sync runs.\n- UniFi can refuse client reads when the key\'s account is not the owner of the console.',
    ].join('\n\n'),
    links: [
      { label: 'Site Manager API: List Devices', href: 'https://developer.ui.com/site-manager/v1.0.0/listdevices' },
      { label: 'UniFi Network API: Connector', href: 'https://developer.ui.com/network/v10.6.106/connectorget' },
    ],
  },
  {
    id: S.fields,
    title: 'Map device and client fields',
    body: [
      'Open **Devices fields**. Pick the asset layout for gateways, switches and access points, the match key (**mac** is suggested), and which UniFi fields fill which layout fields.',
      'Open **Clients fields** and do the same for connected clients. The match key **name** is suggested, because UniFi\'s client list does not include the MAC address.',
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
