import { MICROSOFT_REPORT_SETTING, type SetupGuideStep } from '@weavestream/shared';

/**
 * Step ids of the Microsoft 365 setup guide. `diagnose()` names these when
 * Check setup passes or fails a step, so keep them stable.
 */
export const MICROSOFT_SETUP_STEP = {
  register: 'register',
  permissions: 'permissions',
  secret: 'secret',
  credentials: 'credentials',
  connect: 'connect',
  names: 'names',
  layouts: 'layouts',
} as const;

const S = MICROSOFT_SETUP_STEP;

/**
 * The one-time app registration per Weavestream install, then the
 * per-customer admin consent. Wording follows the Microsoft Entra admin
 * center (App registrations). Plain text: blank-line paragraphs, `- `
 * bullets and `**bold**` only.
 */
export const MICROSOFT_365_SETUP_GUIDE: SetupGuideStep[] = [
  {
    id: S.register,
    title: 'Register one multi-tenant app in Entra',
    body: [
      'You do this once for your whole Weavestream install, in your own Microsoft Entra tenant, not once per customer.',
      'Open the **Microsoft Entra admin center** and go to **Entra ID > App registrations > New registration**.',
      '- Name: **Weavestream**\n- Supported account types: **Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant)**\n- Redirect URI: platform **Web**, and paste the redirect URI below exactly.',
      'Press **Register**. The overview page shows the **Application (client) ID** and the **Directory (tenant) ID**. Keep both.',
    ].join('\n\n'),
    copyValues: [{ label: 'Redirect URI (Web)', computed: 'redirectUri' }],
    links: [{ label: 'App registrations', href: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade' }],
  },
  {
    id: S.permissions,
    title: 'Add the Microsoft Graph application permissions',
    body: [
      'In the app, open **API permissions > Add a permission > Microsoft Graph > Application permissions**. Add every required permission below (use the copy buttons), then press **Add permissions**.',
      'Pick **Application permissions**, not Delegated. Weavestream reads with its own app identity and never signs in as a person. You can remove the default delegated **User.Read**; it is not used.',
      'The two **Optional** groups are up to you. **ReportSettings.Read.All** lets the integration page show the current report names setting. **ReportSettings.ReadWrite.All** is optional: add it only if you want Weavestream to be able to turn report name concealment off/on for a customer (step 6); without it the page shows the admin center steps instead. It is the only permission that is not read-only.',
      'Do not add any other permission: a connection that grants more than this list is refused.',
    ].join('\n\n'),
    copyValues: [{ label: 'Application permissions', computed: 'scopes' }],
  },
  {
    id: S.secret,
    title: 'Create a client secret and note its expiry',
    body: [
      'Open **Certificates & secrets > Client secrets > New client secret**. Pick an expiry (at most 24 months) and press **Add**.',
      'Copy the secret **Value** now (not the Secret ID). Entra shows it only once. Write down the **Expires** date: Weavestream warns you 30 days before it.',
      'To rotate later, create a second secret before the first expires, save it in Weavestream, then delete the old one in Entra.',
    ].join('\n\n'),
    links: [{ label: 'App registrations', href: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade' }],
  },
  {
    id: S.credentials,
    title: 'Paste the app into Weavestream',
    body: [
      'In Weavestream, go to **Admin > Integrations** and open the **Microsoft 365** integration (add it once with **New integration** if it is not there yet; one per Weavestream install). On its **App** tab, fill in the **Application (client) ID**, the secret **Value**, the secret expiry date and, to let Check setup verify the secret fully, your **Directory (tenant) ID**. Press **Save Microsoft app**.',
      'Then press **Check setup**. Steps that pass turn green. If a step turns red, follow its message.',
    ].join('\n\n'),
  },
  {
    id: S.connect,
    title: 'Connect a customer (admin consent)',
    body: [
      'Do this once per customer. Open the **Microsoft 365** integration, go to its **Connections** tab and press **Connect a client**. Each customer tenant becomes one connection of the same integration.',
      'Sign in as that customer\'s **Global Administrator** or **Privileged Role Administrator**. A Cloud Application Administrator or Application Administrator cannot grant Microsoft Graph application permissions.',
      'Microsoft lists every permission. The app shows as **unverified**; that is expected for a self-hosted app and does not stop an admin from approving. Press **Accept**.',
      'Weavestream then checks the token Microsoft issues for that tenant and shows **Connected to** the tenant name. No password or user token is stored.',
    ].join('\n\n'),
  },
  {
    id: S.names,
    title: 'Choose whether usage reports show real names',
    body: [
      'Microsoft hides user, group and site names in usage reports by default, so mailbox and OneDrive storage cannot be matched to people.',
      `After connecting, the integration page reads the tenant setting **${MICROSOFT_REPORT_SETTING.label}** (${MICROSOFT_REPORT_SETTING.path}) and asks you. If you choose to show real names, Weavestream turns that checkbox off once. It is tenant-wide, and you can turn it back on from the same place at any time.`,
      'If you keep names hidden, nothing is changed and storage rows say they are hidden by the tenant\'s report privacy setting.',
    ].join('\n\n'),
  },
  {
    id: S.layouts,
    title: 'Map the company and layouts, then sync',
    body: [
      'Open **Organizations** and map the Microsoft 365 tenant to its Weavestream company. Then set **Status** to active and save.',
      'Open the **Map layouts** tab. For each kind of Microsoft data, pick the layout it goes into (for example Users to People) and the field to match on (for example Email).',
      'On the first sync, Weavestream links to the assets you already have when the match field is equal, and only creates an asset when there is no match. Press **Dry run** to preview, then **Run sync now**.',
    ].join('\n\n'),
  },
];
