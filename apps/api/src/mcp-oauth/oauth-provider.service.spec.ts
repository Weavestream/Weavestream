import { withoutCookies } from './oauth-provider.service.js';

describe('withoutCookies', () => {
  const names = new Set(['ws_oauth_session', 'ws_oauth_session.sig']);

  it('drops the provider session cookie and its signature, keeps every other cookie', () => {
    expect(
      withoutCookies(
        'ws_session=abc; ws_oauth_session=s1; ws_oauth_session.sig=x; ws_oauth_interaction=i1; ws_csrf=t',
        names,
      ),
    ).toBe('ws_session=abc; ws_oauth_interaction=i1; ws_csrf=t');
  });

  it('matches names exactly, never by prefix', () => {
    expect(withoutCookies('ws_oauth_session_other=1; xws_oauth_session=2', names)).toBe(
      'ws_oauth_session_other=1; xws_oauth_session=2',
    );
  });

  it('leaves no header when nothing else remains, and passes a missing header through', () => {
    expect(withoutCookies('ws_oauth_session=s1', names)).toBeUndefined();
    expect(withoutCookies(undefined, names)).toBeUndefined();
  });
});
