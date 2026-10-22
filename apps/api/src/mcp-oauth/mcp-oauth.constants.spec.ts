import {
  areAllowedRedirects,
  clientHostOf,
  connectionAllowed,
  isAllowedClientId,
  isFirstPartyConnection,
  isLoopbackRedirect,
  isVerifiedClientId,
} from './mcp-oauth.constants.js';

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

describe('mode any', () => {
  it('accepts an https client metadata document on any host, with a port', () => {
    expect(isAllowedClientId('https://agent.example/client.json', 'any')).toBe(true);
    expect(isAllowedClientId('https://agent.example:8443/oauth/client', 'any')).toBe(true);
    expect(isAllowedClientId('https://chatgpt.com/oauth/client.json', 'any')).toBe(true);
  });

  it.each([
    'http://agent.example/client.json', // not https
    'https://user:pw@agent.example/client.json', // credentials
    'https://user@agent.example/client.json',
    'https://agent.example/client.json#frag', // fragment
    'https://agent.example/', // no path
    'https://agent.example',
    'not a url',
    '',
  ])('refuses the client id %s', (id) => {
    expect(isAllowedClientId(id, 'any')).toBe(false);
  });

  it('accepts https on any host and port, and loopback http on any port', () => {
    expect(areAllowedRedirects(['https://agent.example/cb'], 'any')).toBe(true);
    expect(areAllowedRedirects(['https://agent.example:9443/cb'], 'any')).toBe(true);
    expect(areAllowedRedirects(['http://127.0.0.1:54321/callback'], 'any')).toBe(true);
    expect(areAllowedRedirects(['http://[::1]:8080/callback'], 'any')).toBe(true);
    expect(areAllowedRedirects(['http://localhost:33418/callback'], 'any')).toBe(true);
    expect(areAllowedRedirects(['http://127.0.0.1/callback'], 'any')).toBe(true);
    expect(areAllowedRedirects(['https://claude.ai/api/mcp/auth_callback'], 'any')).toBe(true);
  });

  it.each([
    [['http://192.168.1.10/cb']], // http on a LAN host
    [['http://agent.example/cb']],
    [['http://127.0.0.2/cb']], // not one of the three loopback names
    [['myapp://callback']], // custom scheme
    [['com.example.app:/oauth']],
    [['https://agent.example/cb#frag']],
    [['https://user:pw@agent.example/cb']],
    [['https://agent.example/cb', 'http://10.0.0.5/cb']], // one bad entry spoils it
    [['not a url']],
    [[]],
  ])('refuses %j', (uris) => {
    expect(areAllowedRedirects(uris, 'any')).toBe(false);
  });

  it('keeps today\'s rules in the default mode', () => {
    expect(areAllowedRedirects(['http://127.0.0.1:54321/callback'])).toBe(false);
    expect(isAllowedClientId('https://agent.example/client.json')).toBe(false);
  });
});

describe('client helpers', () => {
  it('treats an https client id as verified, and a registered id as not', () => {
    expect(isVerifiedClientId('https://claude.ai/oauth/x')).toBe(true);
    expect(isVerifiedClientId('Xk3_registered-id')).toBe(false);
    expect(isVerifiedClientId('http://agent.example/c')).toBe(false);
    expect(clientHostOf('https://agent.example:8443/c')).toBe('agent.example');
    expect(clientHostOf('Xk3_registered-id')).toBeNull();
  });

  it('flags loopback redirects', () => {
    expect(isLoopbackRedirect('http://127.0.0.1:1234/cb')).toBe(true);
    expect(isLoopbackRedirect('http://localhost/cb')).toBe(true);
    expect(isLoopbackRedirect('https://localhost/cb')).toBe(false);
    expect(isLoopbackRedirect('https://claude.ai/cb')).toBe(false);
  });

  it('allows other apps\' connections only in mode any', () => {
    const claude = { clientId: 'https://claude.ai/oauth/x', redirectHost: 'claude.ai' };
    const gpt = { clientId: 'https://chatgpt.com/oauth/client.json', redirectHost: 'chatgpt.com' };
    const dcr = { clientId: 'Xk3_registered-id', redirectHost: '127.0.0.1' };
    const otherCimd = { clientId: 'https://agent.example/c', redirectHost: 'agent.example' };
    const claudeToLoopback = { clientId: 'https://claude.ai/oauth/x', redirectHost: '127.0.0.1' };
    for (const row of [claude, gpt]) {
      expect(connectionAllowed('claude_chatgpt', row)).toBe(true);
      expect(connectionAllowed('any', row)).toBe(true);
    }
    for (const row of [dcr, otherCimd, claudeToLoopback]) {
      expect(isFirstPartyConnection(row)).toBe(false);
      expect(connectionAllowed('claude_chatgpt', row)).toBe(false);
      expect(connectionAllowed('any', row)).toBe(true);
    }
  });
});
