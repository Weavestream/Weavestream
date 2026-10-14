import { dropdownOptionsSchema, multiselectOptionsSchema } from './asset-field.js';

describe('choice option slugs', () => {
  const dup = {
    choices: [
      { slug: '2022', label: '2022' },
      { slug: '2025', label: '2022' },
      { slug: '2025', label: '2025' },
    ],
  };

  it.each([
    ['DROPDOWN', dropdownOptionsSchema],
    ['MULTISELECT', multiselectOptionsSchema],
  ])('%s rejects a slug used by two options, pointing at the second', (_kind, schema) => {
    const res = schema.safeParse(dup);
    expect(res.success).toBe(false);
    expect(res.error?.issues).toEqual([
      expect.objectContaining({
        path: ['choices', 2, 'slug'],
        message: 'Option slug "2025" is used by more than one option',
      }),
    ]);
  });

  it('accepts repeated labels with distinct slugs', () => {
    const res = dropdownOptionsSchema.safeParse({
      choices: [
        { slug: 'a', label: 'Same' },
        { slug: 'b', label: 'Same' },
      ],
    });
    expect(res.success).toBe(true);
  });
});
