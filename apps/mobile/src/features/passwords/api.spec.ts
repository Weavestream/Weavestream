import {
  buildCreatePayload,
  buildUpdatePayload,
  isReasonRequired,
  notesToPlaintext,
  validateTotpSecret,
  type PasswordFormValues,
} from './api';
import { ApiError } from '../../lib/api';
import { makePasswordDetail } from './test-fixtures';

function form(over: Partial<PasswordFormValues> = {}): PasswordFormValues {
  return {
    name: 'Router admin',
    username: 'admin',
    password: '',
    url: '',
    notes: '',
    totp: { kind: 'none' },
    ...over,
  };
}

describe('buildCreatePayload', () => {
  it('sends only name+password when the optional fields are blank', () => {
    const payload = buildCreatePayload(
      form({ name: '  Router admin  ', username: '  ', password: 'hunter2 ' }),
    );
    expect(payload).toEqual({ name: 'Router admin', password: 'hunter2 ' });
  });

  it('never trims the password itself — spaces can be part of a passphrase', () => {
    const payload = buildCreatePayload(form({ password: ' word one two ' }));
    expect(payload.password).toBe(' word one two ');
  });

  it('includes trimmed optionals only when non-empty', () => {
    const payload = buildCreatePayload(
      form({
        password: 'x',
        username: ' admin ',
        url: ' https://r.example ',
        notes: 'port 8443',
      }),
    );
    expect(payload.username).toBe('admin');
    expect(payload.url).toBe('https://r.example');
    expect(payload.notes).toBe('port 8443');
  });

  it('maps a TOTP secret to the desktop-parity SHA1/6/30 config, normalized', () => {
    const payload = buildCreatePayload(
      form({ password: 'x', totp: { kind: 'set', secret: 'jbsw y3dp ehpk 3pxp' } }),
    );
    expect(payload.totp).toEqual({
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });
  });

  it('never emits mobile-unsupported fields (folder, flags, tags…)', () => {
    const payload = buildCreatePayload(form({ password: 'x' }));
    expect(Object.keys(payload).sort()).toEqual(['name', 'password', 'username']);
  });
});

describe('buildUpdatePayload — diff-only, omission means keep', () => {
  it('returns an empty object for an untouched form', () => {
    const original = makePasswordDetail({ username: 'admin', url: null, notes: null });
    const untouched = form({ name: original.name, username: 'admin' });
    expect(buildUpdatePayload(original, untouched)).toEqual({});
  });

  it('omits the password key when the field is left blank (= keep current)', () => {
    const original = makePasswordDetail();
    const payload = buildUpdatePayload(original, form({ name: original.name, password: '' }));
    expect('password' in payload).toBe(false);
  });

  it('sends null to clear a text field, a value to change it', () => {
    const original = makePasswordDetail({ username: 'admin', url: 'https://a.example' });
    const payload = buildUpdatePayload(
      original,
      form({ name: original.name, username: '', url: 'https://b.example' }),
    );
    expect(payload.username).toBeNull();
    expect(payload.url).toBe('https://b.example');
  });

  it('leaves an untouched Tiptap-doc note alone (no notes key at all)', () => {
    // The form is seeded with the doc's plaintext projection; saving
    // without editing must not rewrite the stored doc as a string.
    const doc = {
      type: 'doc' as const,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'switch closet B' }] },
      ],
    };
    const original = makePasswordDetail({ notes: doc });
    const seeded = form({ name: original.name, username: 'admin', notes: notesToPlaintext(doc) });
    expect('notes' in buildUpdatePayload(original, seeded)).toBe(false);
  });

  it('sends edited notes, and null when cleared', () => {
    const original = makePasswordDetail({ notes: 'old note' });
    expect(
      buildUpdatePayload(original, form({ name: original.name, notes: 'new note' })).notes,
    ).toBe('new note');
    expect(
      buildUpdatePayload(original, form({ name: original.name, notes: '' })).notes,
    ).toBeNull();
  });

  it('maps the TOTP tri-state: keep=omit, set=config, remove=null', () => {
    const original = makePasswordDetail({ hasTotp: true });
    const base = { name: original.name, username: 'admin' };

    expect('totp' in buildUpdatePayload(original, form({ ...base, totp: { kind: 'keep' } }))).toBe(false);
    expect('totp' in buildUpdatePayload(original, form({ ...base, totp: { kind: 'none' } }))).toBe(false);
    expect(
      buildUpdatePayload(original, form({ ...base, totp: { kind: 'remove' } })).totp,
    ).toBeNull();
    expect(
      buildUpdatePayload(original, form({ ...base, totp: { kind: 'set', secret: 'JBSWY3DPEHPK3PXP' } })).totp,
    ).toEqual({ secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 });
  });
});

describe('notesToPlaintext', () => {
  it('passes strings through verbatim and flattens docs', () => {
    expect(notesToPlaintext('line 1\nline 2')).toBe('line 1\nline 2');
    expect(notesToPlaintext(null)).toBe('');
    expect(notesToPlaintext(undefined)).toBe('');
    expect(
      notesToPlaintext({
        type: 'doc' as const,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
      }),
    ).toBe('hello');
  });
});

describe('validateTotpSecret', () => {
  it('accepts base32 with spaces and returns the normalized secret', () => {
    const res = validateTotpSecret('jbsw y3dp ehpk 3pxp');
    expect(res).toEqual({ ok: true, secret: 'JBSWY3DPEHPK3PXP' });
  });

  it('rejects non-base32 and too-short secrets with a message', () => {
    expect(validateTotpSecret('not-base32!').ok).toBe(false);
    expect(validateTotpSecret('AB').ok).toBe(false);
  });
});

describe('error classifiers', () => {
  const reasonProblem = { status: 400, error: 'ReasonRequired' };

  it('isReasonRequired matches only the 400 + error extension pair', () => {
    expect(isReasonRequired(new ApiError(400, reasonProblem))).toBe(true);
    expect(isReasonRequired(new ApiError(400, { error: 'ValidationError' }))).toBe(false);
    expect(isReasonRequired(new ApiError(403, reasonProblem))).toBe(false);
    expect(isReasonRequired(new Error('x'))).toBe(false);
  });

  // isRestrictedError moved to lib/api.ts (Phase 2b) — see lib/api.spec.ts.
});
