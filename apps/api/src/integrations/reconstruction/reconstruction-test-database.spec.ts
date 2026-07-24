import {
  reconstructionDatabaseTemplate,
  reconstructionRunDatabaseName,
} from './reconstruction-test-database.js';

describe('Task 11 disposable database safety', () => {
  it('requires the explicit reconstruction-only environment variable', () => {
    expect(() => reconstructionDatabaseTemplate(undefined)).toThrow(
      /WEAVESTREAM_RECONSTRUCTION_TEST_DATABASE_URL/,
    );
  });

  it.each([
    'postgresql://user:password@localhost:5432/postgres',
    'postgresql://user:password@localhost:5432/weavestream',
    'https://localhost/weavestream_task11_template',
    'postgresql://user:password@example.com:5432/weavestream_task11_template',
  ])('rejects an unsafe template URL without exposing it: %s', (url) => {
    expect(() => reconstructionDatabaseTemplate(url)).toThrow(/safe|dedicated|local/i);
  });

  it('derives a unique bounded database name from a validated local template', () => {
    const template = reconstructionDatabaseTemplate(
      'postgresql://user:password@localhost:5432/weavestream_task11_template',
    );
    const first = reconstructionRunDatabaseName(template.databaseName, 'run-a');
    const second = reconstructionRunDatabaseName(template.databaseName, 'run-b');

    expect(first).toMatch(/^weavestream_task11_[a-z0-9_]+$/);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(63);
    expect(JSON.stringify(template)).not.toContain('password');
  });

  it('keeps run databases distinct and off the template when the template name fills the identifier limit', () => {
    const templateName = `weavestream_task11_${'x'.repeat(44)}`;
    expect(templateName).toHaveLength(63);

    const first = reconstructionRunDatabaseName(templateName, '4321-aaaaaaaa');
    const second = reconstructionRunDatabaseName(templateName, '4321-bbbbbbbb');

    expect(first).not.toBe(second);
    expect(first).not.toBe(templateName);
    expect(second).not.toBe(templateName);
    expect(first).toMatch(/^weavestream_task11_[a-z0-9_]+$/);
    expect(second).toMatch(/^weavestream_task11_[a-z0-9_]+$/);
    expect(first.length).toBeLessThanOrEqual(63);
    expect(second.length).toBeLessThanOrEqual(63);
  });

  it('preserves run token entropy that falls past the truncation boundary', () => {
    const templateName = 'weavestream_task11_template';
    const shared = 'a'.repeat(60);

    const first = reconstructionRunDatabaseName(templateName, `${shared}-1`);
    const second = reconstructionRunDatabaseName(templateName, `${shared}-2`);

    expect(first).not.toBe(second);
    expect(first).toMatch(/^weavestream_task11_[a-z0-9_]+$/);
    expect(first.length).toBeLessThanOrEqual(63);
  });
});
