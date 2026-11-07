/**
 * Early warning: does a Breeze release change the partner API contract
 * Weavestream reads? Run by `.github/workflows/breeze-contract.yml` against
 * the newest Breeze release, and by hand against any checkout (from
 * apps/api; ts-node cannot follow the `.js` import suffixes, so it is
 * compiled first):
 *
 *   pnpm exec tsc -p scripts/tsconfig.check-breeze-contract.json
 *   node node_modules/.cache/breeze-contract-check/scripts/check-breeze-contract.js <breeze-checkout> [--ref v0.126.0] [--summary <file>]
 *
 * The Breeze checkout is read as text only: a few known files, regular
 * files only (no symlinks), with a size cap. Nothing from it is executed.
 * Exit code 0 = no breaking difference (notices may be printed),
 * 1 = breaking differences (summary printed), 2 = the checkout could not
 * be read.
 */
import { appendFileSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  BREEZE_SOURCE_PATHS,
  compareBreezeContract,
  expectedBreezeContract,
  formatContractReport,
  type BreezeSourceFiles,
} from '../src/integrations/drivers/breeze/breeze-upstream-contract.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ROUTE_FILES = 200;
const ROUTE_FILE = /^[A-Za-z][A-Za-z0-9_-]*\.ts$/u;
const REF_LABEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;

function readSourceFile(root: string, relative: string): string | null {
  const path = resolve(root, relative);
  if (!path.startsWith(root + sep)) throw new Error(`Refusing a path outside the checkout: ${relative}`);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) throw new Error(`Not a regular file: ${relative}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`File too large to check: ${relative}`);
  return readFileSync(path, 'utf8');
}

function readBreezeSource(root: string): BreezeSourceFiles {
  const schemas = readSourceFile(root, BREEZE_SOURCE_PATHS.schemas);
  if (schemas === null) throw new Error(`Missing ${BREEZE_SOURCE_PATHS.schemas}`);
  const routes: Record<string, string> = {};
  const names = readdirSync(resolve(root, BREEZE_SOURCE_PATHS.partnerApiDir))
    .filter((name) => ROUTE_FILE.test(name) && !name.endsWith('.test.ts') && name !== 'schemas.ts')
    .sort()
    .slice(0, MAX_ROUTE_FILES);
  for (const name of names) {
    const text = readSourceFile(root, join(BREEZE_SOURCE_PATHS.partnerApiDir, name));
    if (text !== null) routes[name] = text;
  }
  return { schemas, routes, versionInfo: readSourceFile(root, BREEZE_SOURCE_PATHS.versionInfo) };
}

function main(argv: string[]): number {
  const [checkout, ...rest] = argv;
  let ref = 'checkout';
  let summary: string | null = null;
  for (let index = 0; index < rest.length; index += 2) {
    const value = rest[index + 1];
    if (rest[index] === '--ref' && value) ref = value;
    else if (rest[index] === '--summary' && value) summary = value;
    else {
      console.error(`Unknown argument: ${rest[index]}`);
      return 2;
    }
  }
  if (!checkout) {
    console.error('Usage: check-breeze-contract.ts <breeze-checkout> [--ref <tag>] [--summary <file>]');
    return 2;
  }
  if (!REF_LABEL.test(ref)) {
    console.error('The --ref value is not a plain tag name.');
    return 2;
  }
  let files: BreezeSourceFiles;
  try {
    files = readBreezeSource(resolve(checkout));
  } catch (error) {
    console.error(`Could not read the Breeze checkout: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const report = compareBreezeContract(expectedBreezeContract(), files);
  const text = formatContractReport(report, ref);
  console.log(text);
  if (summary) appendFileSync(summary, text);
  return report.failed ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
