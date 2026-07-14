import type { AiToolExecutionContext } from '../tool-registry.js';
import {
  getAppHelpToolInputSchema,
  getAppHelpToolOutputSchema,
} from '@weavestream/shared';
import { GetAppHelpAiTool } from './get-app-help.tool.js';

const ctxFor = (role: string): AiToolExecutionContext =>
  ({ actor: { role } }) as unknown as AiToolExecutionContext;

describe('GetAppHelpAiTool', () => {
  it('is self-scoped and passes only the validated natural-language question', async () => {
    const help = {
      search: jest.fn(() => ({ version: 'v1', matches: [] })),
    };
    const tool = new GetAppHelpAiTool(help as never);

    await expect(tool.resolveCompanyId(ctxFor('OPERATOR'))).resolves.toBe('self-scoped');
    await expect(
      tool.execute({} as AiToolExecutionContext, { question: 'Create an asset' }),
    ).resolves.toEqual({ version: 'v1', matches: [] });
    expect(help.search).toHaveBeenCalledWith('Create an asset');
  });

  it('denies CLIENT_USER at execution — defense-in-depth (F13)', async () => {
    const tool = new GetAppHelpAiTool({ search: jest.fn() } as never);
    // null routes to the executor's shared unavailable outcome,
    // indistinguishable from not-found (non-enumeration).
    await expect(tool.resolveCompanyId(ctxFor('CLIENT_USER'))).resolves.toBeNull();
  });

  it('accepts only a trimmed question and enforces the output limits', () => {
    expect(getAppHelpToolInputSchema.parse({ question: '  create an asset  ' })).toEqual({
      question: 'create an asset',
    });
    expect(() =>
      getAppHelpToolInputSchema.parse({
        question: 'create an asset',
        filename: 'assets.md',
      }),
    ).toThrow();
    expect(() =>
      getAppHelpToolOutputSchema.parse({
        version: 'v1',
        matches: Array.from({ length: 4 }, (_, i) => ({
          documentId: 'assets',
          sectionId: `assets/section-${i}`,
          documentTitle: 'Assets',
          sectionTitle: `Section ${i}`,
          requiredPermissions: [],
          markdown: '## Help\n\nSteps.',
        })),
      }),
    ).toThrow();
  });
});
