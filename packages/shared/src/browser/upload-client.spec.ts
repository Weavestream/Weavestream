import {
  UploadError,
  describeUploadError,
  humanSize,
  inferMime,
  preflightFile,
} from './upload-client';

/**
 * First coverage for the promoted upload-client helpers (they had none
 * while living in `apps/web`). Runs in the default node environment:
 * `File` is a Node ≥20 global, and the functions under test never touch
 * `window`/`XMLHttpRequest` (`putWithProgress` is exercised by the app
 * suites, not here).
 */

function file(name: string, type: string, bytes = 4): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('inferMime', () => {
  it('prefers the browser-declared type when present', () => {
    expect(inferMime(file('photo.jpg', 'image/jpeg'))).toBe('image/jpeg');
  });

  it('falls back to the extension map when the type is empty', () => {
    expect(inferMime(file('script.ps1', ''))).toBe('text/plain');
    expect(inferMime(file('notes.md', ''))).toBe('text/markdown');
  });

  it('treats application/octet-stream as undeclared and uses the extension', () => {
    expect(inferMime(file('data.csv', 'application/octet-stream'))).toBe('text/csv');
  });

  it('is case-insensitive on the extension', () => {
    expect(inferMime(file('PHOTO.JPG', ''))).toBe('image/jpeg');
  });

  it('returns application/octet-stream for unknown extensionless files', () => {
    expect(inferMime(file('mystery', ''))).toBe('application/octet-stream');
  });
});

describe('preflightFile', () => {
  it('accepts a supported type within the size limit', () => {
    expect(preflightFile(file('a.png', 'image/png'), { maxBytes: 1024 })).toBeNull();
  });

  it('rejects oversize files with a human-readable size sentence', () => {
    const msg = preflightFile(file('big.png', 'image/png', 2048), { maxBytes: 1024 });
    expect(msg).toContain('big.png');
    expect(msg).toContain('2.0 KB');
    expect(msg).toContain('1.0 KB');
  });

  it('skips the size check when maxBytes is null or omitted', () => {
    expect(preflightFile(file('big.png', 'image/png', 2048), { maxBytes: null })).toBeNull();
    expect(preflightFile(file('big.png', 'image/png', 2048))).toBeNull();
  });

  it('rejects unsupported mime types, naming the type', () => {
    const msg = preflightFile(file('movie.mp4', 'video/mp4'));
    expect(msg).toContain('movie.mp4');
    expect(msg).toContain('video/mp4');
  });

  it('uses the extension fallback before rejecting (empty-type .md is fine)', () => {
    expect(preflightFile(file('runbook.md', ''))).toBeNull();
  });
});

describe('describeUploadError', () => {
  it('maps MimeNotAllowed with the offending type', () => {
    const err = new UploadError('init-failed', {
      error: 'MimeNotAllowed',
      mimeType: 'video/mp4',
    });
    const msg = describeUploadError(err, 'clip.mp4');
    expect(msg).toContain('“clip.mp4”');
    expect(msg).toContain('video/mp4');
  });

  it('maps FileTooLarge with both sizes humanised', () => {
    const err = new UploadError('init-failed', {
      error: 'FileTooLarge',
      maxBytes: 1024 * 1024,
      sizeBytes: 3 * 1024 * 1024,
    });
    const msg = describeUploadError(err, 'iso.png');
    expect(msg).toContain('3.0 MB');
    expect(msg).toContain('1.0 MB');
  });

  it('maps MimeMismatch with declared/detected pair', () => {
    const err = new UploadError('confirm-failed', {
      error: 'MimeMismatch',
      declared: 'image/png',
      detected: 'application/zip',
    });
    const msg = describeUploadError(err);
    expect(msg).toContain('declared image/png');
    expect(msg).toContain('looks like application/zip');
  });

  it('maps expired sessions for both server codes', () => {
    for (const code of ['PendingUploadNotFound', 'UploadNotFound']) {
      const msg = describeUploadError(new UploadError('confirm-failed', { error: code }), 'x.pdf');
      expect(msg).toContain('expired');
    }
  });

  it('honours the tenant term on scope mismatch', () => {
    const err = new UploadError('confirm-failed', { error: 'CompanyScopeMismatch' });
    expect(describeUploadError(err, 'x.pdf', 'client')).toContain('this client');
    expect(describeUploadError(err, 'x.pdf')).toContain('this company');
  });

  it('falls back to local codes when there is no server problem body', () => {
    expect(describeUploadError(new UploadError('aborted'), 'x.pdf')).toContain('cancelled');
    expect(describeUploadError(new UploadError('network-error'))).toContain('interrupted');
    expect(describeUploadError(new UploadError('put-failed'))).toContain('storage');
  });

  it('surfaces server messages on init/confirm failures', () => {
    const err = new UploadError('confirm-failed', { message: 'quota exceeded' });
    expect(describeUploadError(err, 'x.pdf')).toContain('quota exceeded');
  });

  it('handles plain errors and unknown values safely', () => {
    expect(describeUploadError(new Error('boom'), 'x.pdf')).toContain('boom');
    expect(describeUploadError(undefined, 'x.pdf')).toContain('failed');
  });
});

describe('humanSize', () => {
  it.each([
    [512, '512 B'],
    [2048, '2.0 KB'],
    [3 * 1024 * 1024, '3.0 MB'],
    [2 * 1024 * 1024 * 1024, '2.00 GB'],
  ])('%d → %s', (bytes, expected) => {
    expect(humanSize(bytes as number)).toBe(expected);
  });
});
