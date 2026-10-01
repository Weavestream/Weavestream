#!/usr/bin/env node
/**
 * Weavestream MCP server (stdio).
 *
 *   WEAVESTREAM_URL=https://weavestream.example.com \
 *   WEAVESTREAM_API_KEY=ws_… \
 *   weavestream-mcp
 *
 * Set WEAVESTREAM_MCP_ALLOW_PASSWORD_REVEAL=1 to expose reveal_password. The
 * key must also have been created with password reveal allowed; the server
 * enforces that regardless of this flag.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseConfig, WeavestreamClient } from './client.js';
import { registerTools } from './tools.js';

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  const server = new McpServer({ name: 'weavestream', version: '0.1.0' });
  registerTools(server, new WeavestreamClient(config), {
    allowPasswordReveal: process.env.WEAVESTREAM_MCP_ALLOW_PASSWORD_REVEAL === '1',
  });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // stdout is the MCP channel; diagnostics go to stderr. Config errors never
  // contain the key (parseConfig only names the variable).
  process.stderr.write(`weavestream-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
