import {
  WITHHELD_PLACEHOLDER,
  isCredentialName,
  redactSensitiveText,
  scanSensitiveMaterial,
} from './sensitive-material.js';

// Credential-shaped fixtures are built at runtime (no secret-shaped literal
// in source, §2).
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const token = (length: number, stride: number) =>
  Array.from({ length }, (_, index) => ALPHABET[(index * stride) % ALPHABET.length]).join('');
const PLAIN = ['hunter', '2'].join('');
const SEASON = ['Summer', '2026!'].join('');

describe('scanSensitiveMaterial', () => {
  it('detects nested secret material', () => {
    expect(scanSensitiveMaterial({ nested: [{ accessToken: 'short' }] })).toBe('sensitive');
  });

  it('returns a stable bounds result for cycles', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(scanSensitiveMaterial(value)).toBe('bounds_exceeded');
  });

  it('returns a stable bounds result beyond depth eight', () => {
    let value: Record<string, unknown> = {};
    const root = value;
    for (let index = 0; index < 9; index += 1) {
      const child: Record<string, unknown> = {};
      value.child = child;
      value = child;
    }
    expect(scanSensitiveMaterial(root)).toBe('bounds_exceeded');
  });

  it('returns a stable bounds result beyond 1024 traversed entries', () => {
    const value = Object.fromEntries(
      Array.from({ length: 1_025 }, (_, index) => [`field${index}`, index]),
    );
    expect(scanSensitiveMaterial(value)).toBe('bounds_exceeded');
  });

  it('fails closed when array classification touches a revoked proxy', () => {
    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();
    expect(scanSensitiveMaterial(proxy)).toBe('bounds_exceeded');
  });

  it('fails closed when an array index getter throws', () => {
    const value: unknown[] = [];
    Object.defineProperty(value, 0, {
      enumerable: true,
      get: () => { throw new Error('source-secret-index-text'); },
    });
    expect(scanSensitiveMaterial(value)).toBe('bounds_exceeded');
  });

  it('flags a high-entropy token even when embedded in surrounding text', () => {
    // The entropy scan inspects each token run, so a secret concatenated with a
    // whitespace or punctuation separator cannot be laundered by its neighbours.
    const secret = 'Kf9mZ2pQ7rL4wXbn6vT8cH3dSjY0aGeU4iO1kPqRtWc';
    expect(scanSensitiveMaterial(secret)).toBe('sensitive');
    expect(scanSensitiveMaterial(`device ${secret} active`)).toBe('sensitive');
    expect(scanSensitiveMaterial(`${secret}: Firewall`)).toBe('sensitive');
    expect(scanSensitiveMaterial({ note: `key = ${secret}` })).toBe('sensitive');
  });

  it('keeps benign inventory labels, digests, and large payloads safe', () => {
    expect(scanSensitiveMaterial('Main Firewall Rack 3 Building A')).toBe('safe');
    expect(scanSensitiveMaterial('edge-router-01.datacenter-west.internal.example.com')).toBe('safe');
    // SHA-256 hex digest: 16-symbol alphabet caps entropy below the threshold
    // and offers only two character classes, so digests are not secrets.
    expect(
      scanSensitiveMaterial('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
    ).toBe('safe');
    // A genuinely high-entropy blob longer than 4096 chars (a large legitimate
    // payload) stays outside the detection window.
    const bigBlob = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.repeat(70);
    expect(scanSensitiveMaterial(bigBlob)).toBe('safe');
  });

  it('does not read a UUID-derived slug as a secret but still flags a token next to one', () => {
    // A real Breeze automation id whose `automations-<uuid>` slug cleared the
    // entropy bar and withheld the article.
    const uuid = '060b4c48-6fee-4771-af13-15d6201fb76d';
    expect(scanSensitiveMaterial({ slug: `automations-${uuid}` })).toBe('safe');
    expect(scanSensitiveMaterial(`configuration-policies-${uuid}`)).toBe('safe');
    const secret = 'Kf9mZ2pQ7rL4wXbn6vT8cH3dSjY0aGeU4iO1kPqRtWc';
    expect(scanSensitiveMaterial(`${uuid}-${secret}`)).toBe('sensitive');
  });
});

describe('redactSensitiveText', () => {
  it.each([
    [`password=${PLAIN}`, `password=${PLAIN}`],
    [`set "PASSWORD=${PLAIN}"`, PLAIN],
    [`setx /M DB_PASSWORD ${PLAIN}`, PLAIN],
    [`tool --password ${PLAIN} --mode rebuild`, PLAIN],
    // Flag forms a script uses (review finding: these kept the password).
    ['tool --password=hunter --mode rebuild', 'hunter'],
    ['tool --password hunter --mode rebuild', 'hunter'],
    ["tool --password='Summer two' --mode rebuild", 'Summer two'],
    ['Connect-Thing -Password:hunter -Server db1', 'hunter'],
    ['agent.exe /install /password:hunter /quiet', 'hunter'],
    ['tool --db-password=hunter', 'hunter'],
    // Second review: a value that starts with `-` after `=`, and a spaced number.
    ['tool --password=-example-value --mode rebuild', '-example-value'],
    ['Connect-Thing -Password:-example-value', '-example-value'],
    ['$Password = 123456', '123456'],
    ['DB_PASSWORD = 987654', '987654'],
    // Third review: an escaped quote inside the value must not end it early.
    [`$Password = 'prefix''suffixvalue'`, 'suffixvalue'],
    [`$Password = "prefix""suffixvalue"`, 'suffixvalue'],
    ['$Password = "prefix`"suffixvalue"', 'suffixvalue'],
    [String.raw`export PASSWORD="prefix\"suffixvalue"`, 'suffixvalue'],
    [String.raw`{"user":"admin","password":"prefix\"suffixvalue","mode":"rebuild"}`, 'suffixvalue'],
    [String.raw`PASSWORD='prefix'\''suffixvalue'`, 'suffixvalue'],
    [String.raw`password = 'prefix\'suffixvalue'`, 'suffixvalue'],
    [String.raw`tool --password="prefix\"suffixvalue" --mode rebuild`, 'suffixvalue'],
    [String.raw`setx DB_PASSWORD "prefix\"suffixvalue"`, 'suffixvalue'],
    [String.raw`ConvertTo-SecureString 'prefix''suffixvalue' -AsPlainText -Force`, 'suffixvalue'],
    ["tool --mode rebuild --access-token 'ordinary-value'", 'ordinary-value'],
    [`{"user":"admin","password":"${PLAIN}","mode":"rebuild"}`, PLAIN],
    ['RECOVERY_KEY=1234-5678-9012', '1234-5678-9012'],
    ['BitLockerRecoveryKey: "1234-5678-9012"', '1234-5678-9012'],
    [`TOKEN_BACKUP=ordinary-value`, 'ordinary-value'],
    [`postgresql://operator:${PLAIN}@database.example/rebuild`, PLAIN],
    [`$Password = '${SEASON}'`, SEASON],
    [`$env:API_KEY="${SEASON}"`, SEASON],
    [`ConvertTo-SecureString -AsPlainText -Force '${SEASON}'`, SEASON],
    [`ConvertTo-SecureString ${PLAIN} -AsPlainText -Force`, PLAIN],
    [`Authorization: Bearer ${token(32, 7)}`, token(32, 7)],
    [token(48, 11), token(48, 11)],
  ])('replaces only the secret span: %s', (text, secret) => {
    const result = redactSensitiveText(`line one\n${text}\nline three`);
    expect(result.redacted).toBe(true);
    expect(result.text).toContain(WITHHELD_PLACEHOLDER);
    expect(result.text).not.toContain(secret);
    expect(result.text.startsWith('line one\n')).toBe(true);
    expect(result.text.endsWith('\nline three')).toBe(true);
    // What is left passes the scan the writers run.
    expect(scanSensitiveMaterial(result.text)).toBe('safe');
  });

  it('ends a quoted value at its real closing quote and keeps the text after it', () => {
    expect(redactSensitiveText(`$Password = 'a''b'; Write-Host done`).text)
      .toBe(`$Password = '${WITHHELD_PLACEHOLDER}'; Write-Host done`);
    expect(redactSensitiveText(String.raw`{"password":"a\"b","mode":"rebuild"}`).text)
      .toBe(`{"password":"${WITHHELD_PLACEHOLDER}","mode":"rebuild"}`);
    expect(redactSensitiveText(String.raw`DB_PASSWORD='a'\''b' ./run.sh`).text)
      .toBe(`DB_PASSWORD='${WITHHELD_PLACEHOLDER}' ./run.sh`);
    // Bash: a backslash before the closing single quote is a literal.
    expect(redactSensitiveText(String.raw`DB_PASSWORD='C:\' ./run.sh`).text)
      .toBe(`DB_PASSWORD='${WITHHELD_PLACEHOLDER}' ./run.sh`);
  });

  it.each([
    // Fourth review: PowerShell reads `\` as a plain character, so these are
    // two assignments; the escape reading sees one long value.
    [String.raw`$Password = 'prefix\'; $Token = 'fixturesuffix'`, `$Password = '${WITHHELD_PLACEHOLDER}'`],
    [String.raw`$Password = "prefix\"; $Token = "fixturesuffix"`, `$Password = "${WITHHELD_PLACEHOLDER}"`],
    // A non-credential value first must not hide the credential after it.
    [String.raw`$Path = 'C:\'; $Token = 'fixturesuffix'`, String.raw`$Path = 'C:\'; $Token = '${WITHHELD_PLACEHOLDER}'`],
    [String.raw`$Path = "C:\"; $Token = "fixturesuffix"`, String.raw`$Path = "C:\"; $Token = "${WITHHELD_PLACEHOLDER}"`],
    // Python: one value with an escaped quote.
    [String.raw`password = 'prefix\'fixturesuffix'; mode = 'x'`, `password = '${WITHHELD_PLACEHOLDER}'; mode = 'x'`],
  ])('withholds every value either quote reading finds: %s', (text, expected) => {
    const result = redactSensitiveText(text);
    expect(result).toEqual({ text: expected, redacted: true });
    expect(result.text).not.toContain('fixturesuffix');
  });

  it('stays fast on long runs of backslashes and quotes', () => {
    const started = Date.now();
    for (const body of ["\\'".repeat(20_000), '\\"'.repeat(20_000), "''".repeat(20_000) + "'", '\\'.repeat(40_000)]) {
      redactSensitiveText(`$Password = '${body}`);
      redactSensitiveText(`$Password = "${body}`);
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('keeps the name of an assignment and the text around it', () => {
    expect(redactSensitiveText(`$Password = '${SEASON}'; Write-Host done`).text)
      .toBe(`$Password = '${WITHHELD_PLACEHOLDER}'; Write-Host done`);
    expect(redactSensitiveText(`https://user:${PLAIN}@host.example/path`).text)
      .toBe(`https://${WITHHELD_PLACEHOLDER}@host.example/path`);
  });

  it.each([
    'tool --password-policy enabled --mode rebuild',
    'echo secretary tokenize ordinary prose',
    'postgresql://database.example/rebuild',
    'Usage documentation mentions tool --password without carrying a value.',
    'Set it with --password and restart the service.',
    'tool --password $pw --mode rebuild',
    'Connect-Thing -Password $SecurePassword',
    'tool --password-file /etc/tool/pass --mode rebuild',
    'cat /secret file',
    '$PasswordLength = 12',
    'tool --password -v --mode rebuild',
    'Password: must be at least 12 characters',
    '$Password = Read-Host -AsSecureString',
    '$Password = $env:DB_PASSWORD',
    'passwordMinLength=12 is checked',
    'Windows-Defender-Realtime-Protection-Policy',
    'correct-horse-battery-staple-marble-hamlet',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    `"password": ""`,
  ])('leaves ordinary text alone: %s', (text) => {
    expect(redactSensitiveText(text)).toEqual({ text, redacted: false });
  });
});

describe('isCredentialName', () => {
  it.each([
    'password', 'adminPassword', 'api_key', 'apiKey', 'clientSecret', 'recoveryKey', 'DB_PASSWORD',
    'secretAccessKey', 'privateKey', 'ssh_key', 'wifiPsk',
  ])(
    'names a credential: %s', (name) => expect(isCredentialName(name)).toBe(true),
  );
  it.each([
    'passwordMinLength', 'tokenExpiry', 'secretary', 'tokenize', 'requirePasswordChangeDays',
    'accessKeyId', 'registryKey', 'keyName',
  ])(
    'names a setting, not a credential: %s', (name) => expect(isCredentialName(name)).toBe(false),
  );
  it('counts any word for assignments in text', () => {
    expect(isCredentialName('PASSWORD_VALUE', 'any')).toBe(true);
    expect(isCredentialName('PASSWORD_VALUE')).toBe(false);
  });
});
