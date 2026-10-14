import { z } from 'zod';

/**
 * A remote MCP connection (ChatGPT, Claude) as its owner sees it. Never a
 * token, a code or the grant id.
 */
export interface McpConnectionSummary {
  id: string;
  /** Client ID Metadata Document URL. */
  clientId: string;
  /** Host of `clientId` — the verified identity of the client. */
  clientHost: string;
  /** `client_name` from the document. Stated by the client, display only. */
  clientName: string;
  /** Host the approved redirect URI points at. */
  redirectHost: string;
  /** False = read-only. Fixed at consent. */
  allowWrite: boolean;
  lastUsedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

/** One live connection in the admin Security center, with its owner. */
export interface AdminMcpConnectionRow extends McpConnectionSummary {
  user: { id: string; name: string; email: string };
}

/** Offset pagination with a total, like the admin API key list. */
export interface AdminMcpConnectionPage {
  items: AdminMcpConnectionRow[];
  total: number;
  /** 1-based, clamped to the last page by the server. */
  page: number;
  pageSize: number;
}

export const ADMIN_MCP_CONNECTION_PAGE_SIZES = [25, 50, 100] as const;
export const ADMIN_MCP_CONNECTION_DEFAULT_PAGE_SIZE = 50;

/**
 * What the consent page shows. The client and redirect hosts are verified
 * (the client metadata document was fetched from `clientHost`, and the
 * redirect URI was checked against it); `clientName` is not.
 */
export interface McpConsentDetails {
  uid: string;
  clientId: string;
  clientHost: string;
  clientName: string;
  redirectHost: string;
  user: { email: string };
}

/** The user's decision. Read-only unless they opt in. */
export const mcpConsentApproveSchema = z.object({ allowWrite: z.boolean() }).strict();
export type McpConsentApproveInput = z.infer<typeof mcpConsentApproveSchema>;

/**
 * Where the browser goes next: the authorization server's resume URL, which
 * then redirects to the client with the code (or the denial).
 */
export interface McpConsentResult {
  redirectTo: string;
}
