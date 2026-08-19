import { humanSize } from './file-format';

describe('humanSize', () => {
  it.each([
    [512, '512 B'],
    [2048, '2.0 KB'],
    [3 * 1024 * 1024, '3.0 MB'],
    [2 * 1024 * 1024 * 1024, '2.00 GB'],
  ])('%d → %s', (bytes, expected) => {
    expect(humanSize(bytes as number)).toBe(expected);
  });

  it('switches unit exactly at each 1024 boundary', () => {
    expect(humanSize(1023)).toBe('1023 B');
    expect(humanSize(1024)).toBe('1.0 KB');
    expect(humanSize(1024 * 1024 - 1)).toBe('1024.0 KB');
    expect(humanSize(1024 * 1024)).toBe('1.0 MB');
    expect(humanSize(1024 ** 3 - 1)).toBe('1024.0 MB');
    expect(humanSize(1024 ** 3)).toBe('1.00 GB');
  });

  it('keeps two decimals above a gigabyte and does not cap at TB', () => {
    expect(humanSize(1024 ** 4)).toBe('1024.00 GB');
  });

  it('handles zero', () => {
    expect(humanSize(0)).toBe('0 B');
  });
});
