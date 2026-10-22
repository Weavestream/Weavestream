import { checkDcrMetadata } from './dcr-metadata.js';

const LOOPBACK = 'http://127.0.0.1:54321/callback';

describe('checkDcrMetadata', () => {
  it('accepts a public native client on a loopback redirect and registers it as native', () => {
    const r = checkDcrMetadata({
      client_name: 'Claude Code',
      redirect_uris: [LOOPBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(r).toEqual({
      ok: true,
      metadata: expect.objectContaining({ client_name: 'Claude Code', application_type: 'native' }),
    });
  });

  it('turns a web client with a loopback redirect into a native one', () => {
    const r = checkDcrMetadata({ redirect_uris: [LOOPBACK], application_type: 'web' });
    expect(r.ok && r.metadata.application_type).toBe('native');
  });

  it('accepts a minimal https web client and leaves its type alone', () => {
    const r = checkDcrMetadata({ redirect_uris: ['https://assistant.example/oauth/callback'] });
    expect(r.ok).toBe(true);
    expect(r.ok && r.metadata.application_type).toBeUndefined();
  });

  it.each([
    ['not an object', 'nope'],
    ['an array', []],
    ['null', null],
    ['no redirect_uris', { client_name: 'x' }],
    ['empty redirect_uris', { redirect_uris: [] }],
    ['http on a LAN host', { redirect_uris: ['http://192.168.1.20/cb'] }],
    ['a custom scheme', { redirect_uris: ['myapp://callback'] }],
    ['a fragment', { redirect_uris: ['https://a.example/cb#x'] }],
    ['client_secret_basic', { redirect_uris: [LOOPBACK], token_endpoint_auth_method: 'client_secret_basic' }],
    ['private_key_jwt', { redirect_uris: [LOOPBACK], token_endpoint_auth_method: 'private_key_jwt' }],
    ['client_credentials', { redirect_uris: [LOOPBACK], grant_types: ['client_credentials'] }],
    ['implicit', { redirect_uris: [LOOPBACK], grant_types: ['authorization_code', 'implicit'] }],
    ['refresh only', { redirect_uris: [LOOPBACK], grant_types: ['refresh_token'] }],
    ['response type token', { redirect_uris: [LOOPBACK], response_types: ['token'] }],
    ['two response types', { redirect_uris: [LOOPBACK], response_types: ['code', 'code id_token'] }],
    ['an unknown application_type', { redirect_uris: [LOOPBACK], application_type: 'service' }],
    ['a client_secret', { redirect_uris: [LOOPBACK], client_secret: 'x' }],
    ['jwks', { redirect_uris: [LOOPBACK], jwks: { keys: [] } }],
    ['jwks_uri', { redirect_uris: [LOOPBACK], jwks_uri: 'https://a.example/jwks' }],
  ])('refuses %s with invalid_client_metadata', (_label, body) => {
    const r = checkDcrMetadata(body);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe('invalid_client_metadata');
    expect(!r.ok && r.error_description.length).toBeGreaterThan(0);
  });
});
