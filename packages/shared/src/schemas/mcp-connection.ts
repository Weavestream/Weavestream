import { z } from 'zod';

/**
 * A remote MCP connection (an AI app such as Claude or ChatGPT) as its owner
 * sees it. Never a token, a code or the grant id.
 */
export interface McpConnectionSummary {
  id: string;
  /**
   * Client ID Metadata Document URL for a verified client, or the opaque id
   * the server issued to an app that registered itself.
   */
  clientId: string;
  /**
   * True when `clientId` is an https URL (a client metadata document fetched
   * from that host). False for an app that registered itself: its name and
   * identity are not checked.
   */
  clientVerified: boolean;
  /** Host of `clientId` for a verified client; null for one that registered itself. */
  clientHost: string | null;
  /** `client_name` stated by the client, display only. */
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
 * What the consent page shows. For a verified client the host is checked
 * (the client metadata document was fetched from `clientHost`); an app that
 * registered itself has no checked host (`clientHost` null). The redirect URI
 * is always checked against the client's registered ones. `clientName` is
 * never checked.
 */
export interface McpConsentDetails {
  uid: string;
  clientId: string;
  clientVerified: boolean;
  clientHost: string | null;
  clientName: string;
  redirectHost: string;
  /** The app returns to a loopback address on the user's own computer. */
  redirectLoopback: boolean;
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
