import type { SetupGuideStep } from '@weavestream/shared';

/** Step ids of the Level setup guide. `diagnose()` names these, so keep them stable. */
export const LEVEL_SETUP_STEP = {
  apiKey: 'api-key',
  credentials: 'credentials',
  organizations: 'organizations',
  layouts: 'layouts',
} as const;

const S = LEVEL_SETUP_STEP;

/** Plain text: blank-line paragraphs, `- ` bullets and `**bold**` only. */
export const LEVEL_SETUP_GUIDE: SetupGuideStep[] = [
  {
    id: S.apiKey,
    title: 'Create a read-only API key in Level',
    body: [
      'In Level, open **Settings > API keys** and press **Create API key**.',
      'Give it a name you will recognise, for example **Weavestream**, and set the access level to **Read-only**. Weavestream only reads from Level.',
      'Copy the key. It covers your whole Level account and does not expire, so keep it safe.',
    ].join('\n\n'),
    links: [{ label: 'Level API docs', href: 'https://docs.level.io/en/articles/12152745-public-api-getting-started' }],
  },
  {
    id: S.credentials,
    title: 'Paste the key into Weavestream',
    body: [
      'On this integration\'s **Credentials & schedule** tab, paste the key into **API key** and save.',
      'Press **Test connection**, then **Check setup**. Steps that pass turn green.',
    ].join('\n\n'),
  },
  {
    id: S.organizations,
    title: 'Map each Level group to a company',
    body: [
      'Open **Organizations**. Each top-level group in Level is listed. Map each one to its Weavestream company.',
      'Devices in groups nested under a top-level group sync with it. Devices that are in no group are not synced.',
    ].join('\n\n'),
  },
  {
    id: S.layouts,
    title: 'Map layouts, then sync',
    body: [
      'Open **Map layouts**. Pick the layout devices go into (for example Workstations or Configurations) and the field to match on (for example Serial number).',
      'On the first sync, Weavestream links to the assets you already have when the serial number is equal. It only creates an asset when there is no match.',
      'Press **Dry run** to preview, then **Run sync now**.',
    ].join('\n\n'),
  },
];
