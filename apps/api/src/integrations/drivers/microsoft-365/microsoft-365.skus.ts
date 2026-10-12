/**
 * Friendly names for common Microsoft 365 `skuPartNumber` values, from
 * Microsoft's "Product names and service plan identifiers for licensing"
 * list (learn.microsoft.com/entra/identity/users/licensing-service-plan-reference).
 * Bundled on purpose: no runtime download. Anything not listed shows its
 * part number.
 */
export const SKU_NAMES: Readonly<Record<string, string>> = {
  O365_BUSINESS_ESSENTIALS: 'Microsoft 365 Business Basic',
  O365_BUSINESS_PREMIUM: 'Microsoft 365 Business Standard',
  SPB: 'Microsoft 365 Business Premium',
  O365_BUSINESS: 'Microsoft 365 Apps for business',
  OFFICESUBSCRIPTION: 'Microsoft 365 Apps for enterprise',
  STANDARDPACK: 'Office 365 E1',
  ENTERPRISEPACK: 'Office 365 E3',
  ENTERPRISEPREMIUM: 'Office 365 E5',
  DESKLESSPACK: 'Office 365 F3',
  SPE_E3: 'Microsoft 365 E3',
  SPE_E5: 'Microsoft 365 E5',
  SPE_F1: 'Microsoft 365 F3',
  M365_F1: 'Microsoft 365 F1',
  EXCHANGESTANDARD: 'Exchange Online (Plan 1)',
  EXCHANGEENTERPRISE: 'Exchange Online (Plan 2)',
  EXCHANGEDESKLESS: 'Exchange Online Kiosk',
  EXCHANGEARCHIVE_ADDON: 'Exchange Online Archiving',
  EMS: 'Enterprise Mobility + Security E3',
  EMSPREMIUM: 'Enterprise Mobility + Security E5',
  AAD_PREMIUM: 'Microsoft Entra ID P1',
  AAD_PREMIUM_P2: 'Microsoft Entra ID P2',
  INTUNE_A: 'Microsoft Intune Plan 1',
  ATP_ENTERPRISE: 'Microsoft Defender for Office 365 (Plan 1)',
  THREAT_INTELLIGENCE: 'Microsoft Defender for Office 365 (Plan 2)',
  DEFENDER_ENDPOINT_P1: 'Microsoft Defender for Endpoint P1',
  WIN_DEF_ATP: 'Microsoft Defender for Endpoint P2',
  MDATP_XPLAT: 'Microsoft Defender for Endpoint P2 (cross-platform)',
  MDE_SMB: 'Microsoft Defender for Business',
  POWER_BI_PRO: 'Power BI Pro',
  POWER_BI_STANDARD: 'Power BI (free)',
  FLOW_FREE: 'Power Automate Free',
  TEAMS_EXPLORATORY: 'Microsoft Teams Exploratory',
  MCOEV: 'Microsoft Teams Phone Standard',
  MCOMEETADV: 'Microsoft 365 Audio Conferencing',
  PROJECTPROFESSIONAL: 'Project Plan 3',
  VISIOCLIENT: 'Visio Plan 2',
  SHAREPOINTSTORAGE: 'Office 365 Extra File Storage',
  RIGHTSMANAGEMENT: 'Azure Information Protection Plan 1',
  Microsoft_365_Copilot: 'Microsoft 365 Copilot',
  WINDOWS_STORE: 'Windows Store for Business',
};

export function skuName(partNumber: string | null | undefined): string {
  if (!partNumber) return 'Unknown licence';
  return SKU_NAMES[partNumber] ?? partNumber;
}
