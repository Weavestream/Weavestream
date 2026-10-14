import { MCP_TOOLS, summarizeLayouts } from './mcp-tools.js';

describe('summarizeLayouts', () => {
  it('keeps identity and counts only live fields', () => {
    const out = summarizeLayouts({
      items: [
        {
          id: 'l1',
          name: 'Vendor',
          slug: 'vendor',
          isActive: true,
          icon: 'globe',
          color: '#f472b6',
          fields: [
            { slug: 'a', options: { choices: [] }, archivedAt: null },
            { slug: 'b', archivedAt: null },
            { slug: 'old', archivedAt: '2026-01-01T00:00:00Z' },
          ],
        },
      ],
      nextCursor: null,
    });
    expect(out).toEqual({
      items: [{ id: 'l1', name: 'Vendor', slug: 'vendor', isActive: true, fieldCount: 2 }],
    });
  });

  it('passes through a response without an items array', () => {
    expect(summarizeLayouts({ ok: true })).toEqual({ ok: true });
    expect(summarizeLayouts(null)).toBeNull();
  });
});

describe('list_layouts tool', () => {
  it('sends q and returns the summary', async () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'list_layouts')!;
    const request = jest.fn().mockResolvedValue({ items: [{ id: 'l1', name: 'N', slug: 'n', isActive: true }] });
    const out = await tool.run({ request }, { q: 'net' });
    expect(request).toHaveBeenCalledWith('GET', '/layouts', { query: { q: 'net' } });
    expect(out).toEqual({ items: [{ id: 'l1', name: 'N', slug: 'n', isActive: true, fieldCount: 0 }] });
  });
});
