import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseConfig, WeavestreamClient } from './client.js';
import { MCP_TOOLS, registerTools } from '@weavestream/shared/mcp-tools';

const KEY = 'ws_0123456789abcdef01_c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0';
const CO = '11111111-1111-4111-8111-111111111111';
const ASSET = '22222222-2222-4222-8222-222222222222';

type Call = { url: string; init: RequestInit };

async function connect(opts: { respond?: (c: Call) => Response; allowWrite?: boolean } = {}) {
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
    { allowWrite: opts.allowWrite ?? true },
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

const ALL_TOOLS = [
  'whoami',
  'list_companies',
  'search',
  'list_layouts',
  'get_layout',
  'list_assets',
  'get_asset',
  'create_asset',
  'update_asset',
  'list_domains',
  'get_domain',
  'list_passwords',
  'get_password',
  'list_articles',
  'get_article',
  'create_article',
  'update_article',
];
const WRITE_TOOLS = ['create_asset', 'update_asset', 'create_article', 'update_article'];

test('the catalogue is exactly the 17 published tools', async () => {
  const names = (await (await connect()).client.listTools()).tools.map((t) => t.name);
  assert.deepEqual([...names].sort(), [...ALL_TOOLS].sort());
});

test('without write access the write tools are neither listed nor callable', async () => {
  const { client, calls } = await connect({ allowWrite: false });
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual([...names].sort(), ALL_TOOLS.filter((n) => !WRITE_TOOLS.includes(n)).sort());
  const r = await client.callTool({
    name: 'create_asset',
    arguments: { companyId: CO, assetLayoutId: ASSET, fieldValues: {} },
  });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
});

test('read hints match access, and every read tool issues GET, every write tool POST or PATCH', async () => {
  const { client, calls } = await connect();
  const listed = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
  const sample: Record<string, Record<string, unknown>> = {
    whoami: {},
    list_companies: {},
    search: { q: 'x' },
    list_layouts: {},
    get_layout: { layoutId: ASSET },
    list_assets: { companyId: CO },
    get_asset: { companyId: CO, assetId: ASSET },
    create_asset: { companyId: CO, assetLayoutId: ASSET, fieldValues: {} },
    update_asset: { companyId: CO, assetId: ASSET, name: 'x' },
    list_domains: { companyId: CO },
    get_domain: { companyId: CO, domainId: ASSET },
    list_passwords: { companyId: CO },
    get_password: { companyId: CO, passwordId: ASSET },
    list_articles: { companyId: CO },
    get_article: { companyId: CO, articleId: ASSET },
    create_article: { companyId: CO, title: 't', markdownSource: '# x' },
    update_article: { companyId: CO, articleId: ASSET, title: 't' },
  };
  for (const tool of MCP_TOOLS) {
    assert.equal(listed.get(tool.name)?.annotations?.readOnlyHint, tool.access === 'read', tool.name);
    const before = calls.length;
    const r = await client.callTool({ name: tool.name, arguments: sample[tool.name] });
    assert.notEqual(r.isError, true, tool.name);
    assert.equal(calls.length, before + 1, tool.name);
    const method = calls[calls.length - 1]!.init.method;
    if (tool.access === 'read') assert.equal(method, 'GET', tool.name);
    else assert.ok(method === 'POST' || method === 'PATCH', tool.name);
  }
});
