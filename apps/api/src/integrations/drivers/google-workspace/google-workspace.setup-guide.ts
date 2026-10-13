import type { SetupGuideStep } from '@weavestream/shared';

/**
 * Step ids of the Google Workspace setup guide. `diagnose()` names these
 * when Check setup passes or fails a step, so keep them stable.
 */
export const GOOGLE_SETUP_STEP = {
  project: 'project',
  apis: 'apis',
  consent: 'consent',
  scopes: 'scopes',
  client: 'client',
  credentials: 'credentials',
  connect: 'connect',
  trust: 'trust',
  layouts: 'layouts',
} as const;

const S = GOOGLE_SETUP_STEP;

/**
 * The one-time Google Cloud setup per Weavestream install, then the
 * per-customer connect. Wording follows the Google Cloud console's
 * "Google Auth Platform" pages (Branding, Audience, Clients, Data Access).
 * Plain text: blank-line paragraphs, `- ` bullets and `**bold**` only.
 */
export const GOOGLE_WORKSPACE_SETUP_GUIDE: SetupGuideStep[] = [
  {
    id: S.project,
    title: 'Create a Google Cloud project',
    body: [
      'You do this once for your whole Weavestream install, not once per customer.',
      'Open the Google Cloud console and create a new project. Any Google account works. The Google Workspace admin account of your own company is a good choice.',
      'Name it something you will recognise, for example **Weavestream**. Make sure the new project is selected at the top of the console before you continue.',
    ].join('\n\n'),
    links: [{ label: 'Create a project', href: 'https://console.cloud.google.com/projectcreate' }],
  },
  {
    id: S.apis,
    title: 'Turn on two Google APIs',
    body: [
      'Weavestream reads data through two Google APIs. Open each link below, check that your project is selected, and press **Enable**.',
      '- Admin SDK API (users, groups, domains, devices and usage reports)\n- Enterprise License Manager API (licences)',
    ].join('\n\n'),
    links: [
      { label: 'Admin SDK API', href: 'https://console.cloud.google.com/apis/library/admin.googleapis.com' },
      { label: 'Enterprise License Manager API', href: 'https://console.cloud.google.com/apis/library/licensing.googleapis.com' },
      { label: 'API library', href: 'https://console.cloud.google.com/apis/library' },
    ],
  },
  {
    id: S.consent,
    title: 'Set up the consent screen and publish it',
    body: [
      'Open **Google Auth Platform**. If you see **Get started**, press it.',
      '- **Branding**: app name **Weavestream**, your support email, and a developer contact email.\n- **Audience**: user type **External**. Then press **Publish app** so the status shows **In production**.',
      'Do not leave the app in **Testing**. In Testing, every connection stops working after 7 days.',
      'You do not need Google verification. Customers will see a "Google hasn\'t verified this app" screen when they connect. That is expected for a self-hosted app.',
      'An unverified app can be approved by up to 100 admins in total over the life of the project. You connect one admin per customer, so that is plenty.',
    ].join('\n\n'),
    links: [
      { label: 'Branding', href: 'https://console.cloud.google.com/auth/branding' },
      { label: 'Audience', href: 'https://console.cloud.google.com/auth/audience' },
    ],
  },
  {
    id: S.scopes,
    title: 'Add the scopes',
    body: [
      'Open **Data Access** and press **Add or remove scopes**. Under **Manually add scopes**, paste the list below, press **Add to table**, then **Update** and **Save**.',
      'All of them are read-only except licensing. Google has no read-only version of that one. Weavestream only ever reads.',
    ].join('\n\n'),
    copyValues: [{ label: 'Scopes', computed: 'scopes' }],
    links: [{ label: 'Data Access', href: 'https://console.cloud.google.com/auth/scopes' }],
  },
  {
    id: S.client,
    title: 'Create the OAuth client',
    body: [
      'Open **Clients** and press **Create client**.',
      '- Application type: **Web application**\n- Name: **Weavestream**\n- Under **Authorized redirect URIs**, press **Add URI** and paste the redirect URI below exactly.',
      'Press **Create**. Google shows the **Client ID** and **Client secret**. Copy both now: Google shows the secret only once. You can download it as JSON as a backup.',
    ].join('\n\n'),
    copyValues: [{ label: 'Authorized redirect URI', computed: 'redirectUri' }],
    links: [{ label: 'Clients', href: 'https://console.cloud.google.com/auth/clients' }],
  },
  {
    id: S.credentials,
    title: 'Paste the client into Weavestream',
    body: [
      'In Weavestream, go to **Admin > Integrations** and open the **Google Workspace** integration (add it once with **New integration** if it is not there yet; one per Weavestream install). On its **App** tab, paste the **Client ID** and **Client secret** and press **Save OAuth app**.',
      'Then press **Check setup** in the guide. Steps that pass turn green. If a step turns red, follow its message.',
    ].join('\n\n'),
  },
  {
    id: S.connect,
    title: 'Connect a customer',
    body: [
      'Do this once per customer. Open the **Google Workspace** integration, go to its **Connections** tab and press **Connect a client**. Each customer tenant becomes one connection of the same integration.',
      'Sign in with that customer\'s **super admin**. A delegated admin also works if their role can read users, groups, reports, licences and devices.',
      'On the "Google hasn\'t verified this app" screen, press **Advanced**, then **Go to Weavestream (unsafe)**. The warning appears because the app is your own and not reviewed by Google. Your data only goes to your own Weavestream server.',
      'Tick every permission and press **Continue**. If a box is left unticked, that data is missing until you reconnect.',
    ].join('\n\n'),
  },
  {
    id: S.trust,
    title: 'If the customer blocks third-party apps',
    body: [
      'Some customers only allow apps they have approved. Signing in then fails with "access blocked" or "admin_policy_enforced".',
      'In that customer\'s Google Admin console, open **Security > Access and data control > API controls > Manage third-party app access**. Press **Configure new app**, search for your **Client ID**, and set it to **Trusted**. Then connect again.',
    ].join('\n\n'),
    links: [{ label: 'Google Admin console', href: 'https://admin.google.com/ac/owl' }],
  },
  {
    id: S.layouts,
    title: 'Map the company and layouts, then sync',
    body: [
      'Open **Organizations** and map the Google tenant to its Weavestream company. Then set **Status** to active and save.',
      'Open the **Map layouts** tab. For each kind of Google data, pick the layout it goes into (for example Users to People) and the field to match on (for example Email).',
      'On the first sync, Weavestream links to the assets you already have when the match field is equal. It only creates an asset when there is no match. Then press **Dry run** to preview, and **Run sync now**.',
    ].join('\n\n'),
  },
];
