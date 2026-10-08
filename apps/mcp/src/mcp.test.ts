import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseConfig, WeavestreamClient } from './client.js';
import { registerTools } from './tools.js';

const KEY = 'ws_0123456789abcdef01_c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0';
const CO = '11111111-1111-4111-8111-111111111111';
const ASSET = '22222222-2222-4222-8222-222222222222';

type Call = { url: string; init: RequestInit };

async function connect(opts: { respond?: (c: Call) => Response } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return opts.respond?.(call) ?? new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const server = new McpServer({ name: 'test', version: '0' });
  registerTools(
    server,
    new WeavestreamClient({ baseUrl: 'https://ws.example.com', apiKey: KEY, fetchImpl }),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, calls };
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? '');

test('config: https only (http just for localhost), and the key must look like a key', () => {
  assert.throws(() => parseConfig({ WEAVESTREAM_URL: 'http://ws.example.com', WEAVESTREAM_API_KEY: KEY }), /https/);
  assert.throws(() => parseConfig({ WEAVESTREAM_URL: 'https://ws.example.com', WEAVESTREAM_API_KEY: 'nope' }), /ws_/);
  assert.equal(parseConfig({ WEAVESTREAM_URL: 'http://localhost:3000/x', WEAVESTREAM_API_KEY: KEY }).baseUrl, 'http://localhost:3000');
  assert.equal(parseConfig({ WEAVESTREAM_URL: 'https://ws.example.com/', WEAVESTREAM_API_KEY: KEY }).baseUrl, 'https://ws.example.com');
});

test('no reveal, destructive or access-changing tools at all', async () => {
  const names = (await (await connect()).client.listTools()).tools.map((t) => t.name);
  for (const n of names) assert.doesNotMatch(n, /reveal|totp|delete|archive|purge|user|member|key/);
});

test('get_password never hands vault notes to the model', async () => {
  const { client } = await connect({
    respond: () =>
      new Response(JSON.stringify({ id: ASSET, name: 'Router', username: 'admin', notes: 'PIN 4711' }), {
        status: 200,
      }),
  });
  const r = await client.callTool({ name: 'get_password', arguments: { companyId: CO, passwordId: ASSET } });
  assert.ok(!text(r).includes('PIN 4711'));
  assert.ok(!text(r).includes('notes'));
  assert.match(text(r), /Router/);
});

test('a tool call is one REST call with the bearer key, no redirects followed', async () => {
  const { client, calls } = await connect();
  await client.callTool({ name: 'get_asset', arguments: { companyId: CO, assetId: ASSET } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `https://ws.example.com/api/v1/companies/${CO}/assets/${ASSET}`);
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
  assert.equal(calls[0]!.init.redirect, 'error');
});

test('ids are validated before anything is sent (no path injection)', async () => {
  const { client, calls } = await connect();
  const r = await client.callTool({ name: 'get_asset', arguments: { companyId: '../../auth/me', assetId: ASSET } });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
});

test('API errors come back as tool errors without the key', async () => {
  const { client } = await connect({
    respond: () => new Response(JSON.stringify({ detail: 'API keys cannot be used here.' }), { status: 403 }),
  });
  const r = await client.callTool({ name: 'whoami', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(text(r), /403: API keys cannot be used here\./);
  assert.ok(!text(r).includes(KEY));
});

test('articles are created as Markdown and hidden from clients', async () => {
  const { client, calls } = await connect();
  await client.callTool({ name: 'create_article', arguments: { companyId: CO, title: 'Runbook', markdownSource: '# Hi' } });
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    title: 'Runbook',
    markdownSource: '# Hi',
    editorMode: 'markdown',
    visibleToClients: false,
  });
});

test('an agent cannot ask for a client-visible article', async () => {
  const { client, calls } = await connect();
  await client.callTool({
    name: 'create_article',
    arguments: { companyId: CO, title: 'x', markdownSource: '# Hi', visibleToClients: true },
  });
  // Unknown arguments are stripped by the schema; the forced false wins.
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(String(calls[0]!.init.body)).visibleToClients, false);
});

test('network failures become readable tool errors', async () => {
  const { client } = await connect({
    respond: () => {
      throw new TypeError('fetch failed');
    },
  });
  const r = await client.callTool({ name: 'whoami', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(text(r), /could not be reached/);
});

test('validation issues reach the model so it can fix its arguments', async () => {
  const { client } = await connect({
    respond: () =>
      new Response(
        JSON.stringify({ detail: 'ValidationError', issues: [{ path: 'fieldValues.serial', message: 'Required' }] }),
        { status: 400 },
      ),
  });
  const r = await client.callTool({
    name: 'create_asset',
    arguments: { companyId: CO, assetLayoutId: ASSET, fieldValues: {} },
  });
  assert.match(text(r), /fieldValues\.serial: Required/);
});

test('empty Markdown is rejected before any request', async () => {
  const { client, calls } = await connect();
  const r = await client.callTool({ name: 'create_article', arguments: { companyId: CO, title: 'x', markdownSource: '' } });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
});
