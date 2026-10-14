import { areAllowedRedirects, isAllowedClientId } from './mcp-oauth.constants.js';

describe('isAllowedClientId', () => {
  it('accepts ChatGPT\'s one published document and https documents on claude.ai', () => {
    expect(isAllowedClientId('https://chatgpt.com/oauth/client.json')).toBe(true);
    expect(isAllowedClientId('https://claude.ai/oauth/mcp-client-metadata')).toBe(true);
  });

  it.each([
    'https://chatgpt.com/oauth/other/client.json', // another ChatGPT path
    'https://evil.example/client.json',
    'https://claude.ai.evil.example/client.json', // suffix trick
    'https://evil.example/claude.ai/client.json',
    'http://claude.ai/oauth/client', // not https
    'https://claude.ai:8443/oauth/client', // custom port
    'claude.ai/oauth/client',
    '',
  ])('refuses %s before any fetch', (id) => {
    expect(isAllowedClientId(id)).toBe(false);
  });
});

describe('areAllowedRedirects', () => {
  it('accepts the published callbacks', () => {
    expect(areAllowedRedirects(['https://claude.ai/api/mcp/auth_callback'])).toBe(true);
    expect(areAllowedRedirects(['https://chatgpt.com/connector_platform_oauth_redirect'])).toBe(true);
    expect(
      areAllowedRedirects(['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback']),
    ).toBe(true);
  });

  it.each([
    [['https://claude.ai/api/mcp/auth_callback', 'https://attacker.example/cb']], // one bad entry spoils it
    [['http://claude.ai/api/mcp/auth_callback']],
    [['https://claude.ai:444/cb']],
    [['http://localhost:33418/callback']], // loopback: Claude Code stays on stdio
    [['http://127.0.0.1/callback']],
    [['not a url']],
    [[]],
  ])('refuses %j', (uris) => {
    expect(areAllowedRedirects(uris)).toBe(false);
  });
});
