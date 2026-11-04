import { validTagIds } from './tag-ids.js';

const A = '2ba00000-0000-4000-8000-0000000000a1';
const B = '2BA00000-0000-4000-8000-0000000000B2';

describe('validTagIds', () => {
  it('keeps UUIDs', () => {
    expect(validTagIds([A, B])).toEqual([A, B]);
  });

  it('drops legacy non-UUID values, so a legacy-only value gives no ids', () => {
    expect(validTagIds(['production', 'staging'])).toEqual([]);
  });

  it('keeps the UUIDs in a mixed value', () => {
    expect(validTagIds(['production', A, 42, null, { name: 'x' }])).toEqual([A]);
  });

  it('removes duplicates', () => {
    expect(validTagIds([A, A, B, A])).toEqual([A, B]);
  });
});
