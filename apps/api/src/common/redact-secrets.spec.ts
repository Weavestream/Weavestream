import {
  readUpstreamSnippet,
  redactSecretsInText,
  SNIPPET_MAX_CHARS,
} from './redact-secrets.js';

describe('redactSecretsInText', () => {
  it('redacts JSON credential fields, preserving the quoted shape', () => {
    const input = '{"error":"unauthorized","api_key":"sk-live-abcdef123456"}';
    const out = redactSecretsInText(input);
    expect(out).toContain('"api_key":"[redacted]"');
    expect(out).not.toContain('abcdef123456');
  });

  it('redacts assorted JSON secret field names case-insensitively', () => {
    const input =
      '{"Authorization":"Basic dXNlcjpwYXNz","access_token":"tok_123456789","PASSWORD":"hunter22"}';
    const out = redactSecretsInText(input);
    expect(out).not.toContain('dXNlcjpwYXNz');
    expect(out).not.toContain('tok_123456789');
    expect(out).not.toContain('hunter22');
  });

  it('redacts Bearer credentials in free text', () => {
    const out = redactSecretsInText(
      'upstream said: invalid header Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
    );
    expect(out).toContain('Bearer [redacted]');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('redacts sk-style provider keys, including sk-proj-', () => {
    const out = redactSecretsInText(
      'Incorrect API key provided: sk-proj-AbCdEf12345678 (request id req_1)',
    );
    expect(out).toContain('sk-[redacted]');
    expect(out).not.toContain('AbCdEf12345678');
  });

  it('redacts secret-bearing query/form params', () => {
    const out = redactSecretsInText('failed to call callback?api_key=zzz-topsecret&x=1');
    expect(out).toContain('api_key=[redacted]');
    expect(out).not.toContain('zzz-topsecret');
  });

  it('redacts embedded URLs (userinfo + query)', () => {
    const out = redactSecretsInText(
      'connect failed for https://user:pass@llm.example/v1?sig=abc123',
    );
    expect(out).not.toContain('user:pass');
    expect(out).not.toContain('sig=abc123');
  });
});

describe('readUpstreamSnippet', () => {
  it('returns the redacted, trimmed body for a short error response', async () => {
    const res = new Response('  {"error":"invalid_api_key","api_key":"sk-abc12345"}  ', {
      status: 401,
    });
    const snippet = await readUpstreamSnippet(res);
    expect(snippet).toContain('"api_key":"[redacted]"');
    expect(snippet).not.toContain('sk-abc12345');
  });

  it('redacts before truncating so a boundary-straddling secret cannot leak', async () => {
    // Padding pushes the key across the SNIPPET_MAX_CHARS boundary; if
    // truncation ran first, the regex would no longer match the partial
    // key and its prefix would survive.
    const padding = 'x'.repeat(SNIPPET_MAX_CHARS - 10);
    const res = new Response(`${padding} sk-supersecretvalue1234567890`, { status: 500 });
    const snippet = await readUpstreamSnippet(res);
    expect(snippet).not.toContain('supersecret');
    expect(snippet!.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS + 1); // +1 for the ellipsis
  });

  it('caps the total output length', async () => {
    const res = new Response('a'.repeat(1500), { status: 500 });
    const snippet = await readUpstreamSnippet(res);
    expect(snippet!.length).toBe(SNIPPET_MAX_CHARS + 1);
    expect(snippet!.endsWith('…')).toBe(true);
  });

  it('reads only a bounded prefix of a huge body', async () => {
    // Stream that would hand out ~10 MB in 1 KB chunks if fully drained.
    // The reader must stop (and cancel) after its byte budget, so only a
    // handful of chunks are ever pulled.
    let pulls = 0;
    const chunk = new TextEncoder().encode('b'.repeat(1024));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 10_000) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = new Response(stream, { status: 500 });
    const snippet = await readUpstreamSnippet(res);
    expect(snippet!.endsWith('…')).toBe(true);
    expect(pulls).toBeLessThan(10);
  });

  it('returns null for an empty or missing body', async () => {
    await expect(readUpstreamSnippet(new Response('', { status: 500 }))).resolves.toBeNull();
    await expect(
      readUpstreamSnippet(new Response(null, { status: 204 })),
    ).resolves.toBeNull();
    await expect(
      readUpstreamSnippet(new Response('   \n  ', { status: 500 })),
    ).resolves.toBeNull();
  });
});
