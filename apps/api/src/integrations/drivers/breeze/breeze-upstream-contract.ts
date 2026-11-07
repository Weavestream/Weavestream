import * as ts from 'typescript';
import {
  BREEZE_SOURCE_ENDPOINTS,
  breezeBlockedRecordSchema,
  breezeEnvelopeSchema,
  breezeRecordSchemaByEndpoint,
  type BreezeSourceEndpoint,
} from './breeze.schemas.js';
import { BREEZE_KNOWN_SCHEMA_VERSION } from './breeze-partner-api.client.js';
import { buildPresencePlan, type PresencePlan, type ShapeNode } from './breeze-field-presence.js';

/**
 * Early warning (integration robustness, rule 5): compare the partner API
 * contract Weavestream reads with the contract a Breeze release declares in
 * its source, so a scheduled CI job reports a renamed or removed field, a
 * removed endpoint, or a new `schemaVersion` before a customer upgrades.
 *
 * What Weavestream reads comes from the driver itself: the same field paths
 * the field-presence report walks (`buildPresencePlan` over the Breeze Zod
 * schemas), so there is no second list to keep in step.
 *
 * What Breeze declares is read from its source TEXT with the TypeScript
 * parser. Nothing from the Breeze repository is executed or imported. The
 * reader understands the Zod building blocks Breeze uses (`z.object`,
 * `.extend`, spreads, `z.array`, `z.discriminatedUnion`, small local helper
 * functions); anything it cannot follow is "unknown" and never reported as
 * a removal. A file layout it cannot read at all is reported as a
 * difference, so a broken check fails loudly instead of passing silently.
 *
 * Test and CI tooling only: excluded from the API build (tsconfig.build.json).
 */

/** Paths read from a Breeze checkout, relative to its root. */
export const BREEZE_SOURCE_PATHS = {
  partnerApiDir: 'apps/api/src/routes/partnerApi',
  schemas: 'apps/api/src/routes/partnerApi/schemas.ts',
  versionInfo: 'apps/api/src/services/versionInfo.ts',
} as const;

export interface BreezeSourceFiles {
  /** Text of `schemas.ts`. */
  schemas: string;
  /** Text of each partner API route file (no tests), by file name. */
  routes: Record<string, string>;
  /** Text of `services/versionInfo.ts`, or null when it is absent. */
  versionInfo: string | null;
}

export type ContractProblem =
  | 'endpoint_missing'
  | 'contract_unreadable'
  | 'schema_version'
  | 'field_missing'
  | 'not_a_list'
  | 'not_an_object'
  | 'variant_missing'
  | 'health_version';

export interface ContractDifference {
  problem: ContractProblem;
  /** `breaking` fails the check; a `notice` is reported only. */
  severity: 'breaking' | 'notice';
  /** Endpoint, `(envelope)`, `(blocked notice)`, or `/health`. */
  where: string;
  /** Field path or variant; empty for the whole endpoint. */
  path: string;
  message: string;
}

export interface ContractReport {
  differences: ContractDifference[];
  /** True when at least one difference is breaking (the check fails). */
  failed: boolean;
  /** Fields Weavestream reads that the check could compare. */
  checkedFields: number;
  /** Fields the reader could not follow in the Breeze source (not failures). */
  uncheckedFields: number;
  /** The first of those, as `where: path`, for a human to review. */
  uncheckedPaths: string[];
}

// ---------------------------------------------------------------------
// What Weavestream reads
// ---------------------------------------------------------------------

export interface ExpectedBreezeContract {
  schemaVersion: string;
  endpoints: Record<BreezeSourceEndpoint, PresencePlan>;
  envelope: PresencePlan;
  blockedNotice: PresencePlan;
}

export function expectedBreezeContract(): ExpectedBreezeContract {
  const endpoints = {} as Record<BreezeSourceEndpoint, PresencePlan>;
  for (const endpoint of BREEZE_SOURCE_ENDPOINTS) {
    endpoints[endpoint] = buildPresencePlan(breezeRecordSchemaByEndpoint[endpoint]);
  }
  return {
    schemaVersion: BREEZE_KNOWN_SCHEMA_VERSION,
    endpoints,
    envelope: buildPresencePlan(breezeEnvelopeSchema),
    blockedNotice: buildPresencePlan(breezeBlockedRecordSchema),
  };
}

// ---------------------------------------------------------------------
// What the Breeze source declares
// ---------------------------------------------------------------------

export type UpstreamNode =
  | { kind: 'object'; fields: Map<string, UpstreamNode> }
  | { kind: 'array'; element: UpstreamNode }
  | { kind: 'union'; discriminator: string | null; options: UpstreamNode[] }
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'leaf' }
  | { kind: 'unknown' };

const UNKNOWN: UpstreamNode = { kind: 'unknown' };
const LEAF: UpstreamNode = { kind: 'leaf' };
const MAX_DEPTH = 64;

interface Binding {
  expr: ts.Expression;
  env: Env;
}
type Env = ReadonlyMap<string, Binding>;
const EMPTY_ENV: Env = new Map();

type Callable = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

// Zod calls that keep the schema they are called on (or wrap it).
const PASS_THROUGH_FUNCTIONS = new Set(['optional', 'nullable', 'nullish', 'readonly']);

/** Reads Zod schema shapes from one TypeScript source file, statically. */
export class ZodSourceReader {
  private readonly declarations = new Map<string, ts.Expression | Callable>();
  private readonly resolving = new Set<string>();

  constructor(text: string, fileName = 'schemas.ts') {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer) {
            this.declarations.set(declaration.name.text, declaration.initializer);
          }
        }
      } else if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
        this.declarations.set(statement.name.text, statement);
      }
    }
  }

  has(name: string): boolean {
    return this.declarations.has(name);
  }

  /** The schema a top-level declaration builds, or `unknown`. */
  schemaOf(name: string): UpstreamNode {
    const declaration = this.declarations.get(name);
    if (!declaration || isCallable(declaration)) return UNKNOWN;
    return this.withName(name, () => this.schema(declaration, EMPTY_ENV, 0));
  }

  private withName(name: string, read: () => UpstreamNode): UpstreamNode {
    if (this.resolving.has(name)) return UNKNOWN; // a recursive schema
    this.resolving.add(name);
    try {
      return read();
    } finally {
      this.resolving.delete(name);
    }
  }

  private schema(raw: ts.Expression, env: Env, depth: number): UpstreamNode {
    if (depth > MAX_DEPTH) return UNKNOWN;
    const expr = unwrapExpression(raw);
    if (ts.isIdentifier(expr)) {
      const bound = env.get(expr.text);
      if (bound) return this.schema(bound.expr, bound.env, depth + 1);
      return this.schemaOf(expr.text);
    }
    // One field of another schema: `otherSchema.shape.edges`.
    if (ts.isPropertyAccessExpression(expr)) {
      const owner = unwrapExpression(expr.expression);
      if (!ts.isPropertyAccessExpression(owner) || owner.name.text !== 'shape') return UNKNOWN;
      const schema = this.schema(owner.expression, env, depth + 1);
      return schema.kind === 'object' ? schema.fields.get(expr.name.text) ?? UNKNOWN : UNKNOWN;
    }
    if (!ts.isCallExpression(expr)) return UNKNOWN;
    const callee = unwrapExpression(expr.expression);
    const args = expr.arguments;

    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      const receiver = unwrapExpression(callee.expression);
      if (ts.isIdentifier(receiver) && receiver.text === 'z' && !env.has('z')) {
        return this.zodFactory(method, args, env, depth);
      }
      return this.zodMethod(method, receiver, args, env, depth);
    }
    if (ts.isIdentifier(callee)) {
      const callable = this.callableOf(callee.text, env);
      if (callable) return this.call(callable, args, env, depth);
    }
    return UNKNOWN;
  }

  private zodFactory(
    method: string,
    args: ts.NodeArray<ts.Expression>,
    env: Env,
    depth: number,
  ): UpstreamNode {
    const first = args[0];
    switch (method) {
      case 'object':
      case 'strictObject':
      case 'looseObject': {
        const fields = first ? this.shape(first, env, depth + 1) : new Map<string, UpstreamNode>();
        return fields ? { kind: 'object', fields } : UNKNOWN;
      }
      case 'array':
        return first ? { kind: 'array', element: this.schema(first, env, depth + 1) } : UNKNOWN;
      case 'discriminatedUnion': {
        const key = first ? unwrapExpression(first) : undefined;
        const options = args[1] ? this.list(args[1], env, depth) : null;
        if (!key || !ts.isStringLiteralLike(key) || !options) return UNKNOWN;
        return { kind: 'union', discriminator: key.text, options };
      }
      case 'union': {
        const options = first ? this.list(first, env, depth) : null;
        return options ? { kind: 'union', discriminator: null, options } : UNKNOWN;
      }
      case 'literal': {
        const value = first ? literalValue(first) : null;
        return value === null ? UNKNOWN : { kind: 'literal', value };
      }
      default:
        if (PASS_THROUGH_FUNCTIONS.has(method) && first) return this.schema(first, env, depth + 1);
        // Scalars, enums, JSON, records, lazy values: Weavestream reads
        // them as one value and never looks inside.
        return LEAF;
    }
  }

  private zodMethod(
    method: string,
    receiver: ts.Expression,
    args: ts.NodeArray<ts.Expression>,
    env: Env,
    depth: number,
  ): UpstreamNode {
    const base = (): UpstreamNode => this.schema(receiver, env, depth + 1);
    switch (method) {
      case 'extend':
      case 'safeExtend': {
        const target = base();
        const added = args[0] ? this.shape(args[0], env, depth + 1) : null;
        if (target.kind !== 'object' || !added) return UNKNOWN;
        return { kind: 'object', fields: new Map([...target.fields, ...added]) };
      }
      case 'merge': {
        const target = base();
        const other = args[0] ? this.schema(args[0], env, depth + 1) : UNKNOWN;
        if (target.kind !== 'object' || other.kind !== 'object') return UNKNOWN;
        return { kind: 'object', fields: new Map([...target.fields, ...other.fields]) };
      }
      case 'pick':
      case 'omit': {
        const target = base();
        const keys = args[0] ? objectKeys(args[0]) : null;
        if (target.kind !== 'object' || !keys) return UNKNOWN;
        const keep = (key: string) => (method === 'pick' ? keys.has(key) : !keys.has(key));
        return { kind: 'object', fields: new Map([...target.fields].filter(([key]) => keep(key))) };
      }
      case 'array':
        return { kind: 'array', element: base() };
      case 'or':
        return args[0]
          ? { kind: 'union', discriminator: null, options: [base(), this.schema(args[0], env, depth + 1)] }
          : UNKNOWN;
      case 'and':
        return UNKNOWN;
      default:
        // nullable, optional, strict, max, refine, transform, default, ...:
        // the wire shape is the one of the schema they are called on.
        return base();
    }
  }

  private list(raw: ts.Expression, env: Env, depth: number): UpstreamNode[] | null {
    const expr = unwrapExpression(raw);
    if (!ts.isArrayLiteralExpression(expr)) return null;
    return expr.elements.map((element) =>
      ts.isSpreadElement(element) ? UNKNOWN : this.schema(element, env, depth + 1),
    );
  }

  /** The fields of a Zod shape (an object literal of schemas). */
  private shape(raw: ts.Expression, env: Env, depth: number): Map<string, UpstreamNode> | null {
    if (depth > MAX_DEPTH) return null;
    const expr = unwrapExpression(raw);
    if (ts.isIdentifier(expr)) {
      const bound = env.get(expr.text);
      if (bound) return this.shape(bound.expr, bound.env, depth + 1);
      const declaration = this.declarations.get(expr.text);
      if (!declaration || isCallable(declaration) || this.resolving.has(expr.text)) return null;
      this.resolving.add(expr.text);
      try {
        return this.shape(declaration, EMPTY_ENV, depth + 1);
      } finally {
        this.resolving.delete(expr.text);
      }
    }
    if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'shape') {
      const owner = this.schema(expr.expression, env, depth + 1);
      return owner.kind === 'object' ? owner.fields : null;
    }
    if (!ts.isObjectLiteralExpression(expr)) return null;
    const fields = new Map<string, UpstreamNode>();
    for (const property of expr.properties) {
      if (ts.isPropertyAssignment(property)) {
        const key = propertyName(property.name);
        if (key !== null) fields.set(key, this.schema(property.initializer, env, depth + 1));
      } else if (ts.isShorthandPropertyAssignment(property)) {
        fields.set(property.name.text, this.schema(property.name, env, depth + 1));
      } else if (ts.isSpreadAssignment(property)) {
        const spread = this.shape(property.expression, env, depth + 1);
        if (!spread) return null;
        for (const [key, value] of spread) fields.set(key, value);
      }
    }
    return fields;
  }

  private callableOf(name: string, env: Env): Callable | null {
    if (env.has(name)) return null;
    let declaration = this.declarations.get(name);
    for (let hops = 0; hops < 8 && declaration; hops += 1) {
      const expr = isCallable(declaration) ? declaration : unwrapExpression(declaration);
      if (isCallable(expr)) return expr;
      if (!ts.isIdentifier(expr)) return null;
      declaration = this.declarations.get(expr.text);
    }
    return null;
  }

  /** Evaluate a small local helper (`strictPartnerExportRecordSchema(shape)`). */
  private call(
    callable: Callable,
    args: ts.NodeArray<ts.Expression>,
    env: Env,
    depth: number,
  ): UpstreamNode {
    const scope = new Map<string, Binding>();
    callable.parameters.forEach((parameter, index) => {
      const arg = args[index];
      if (ts.isIdentifier(parameter.name) && arg) {
        scope.set(parameter.name.text, { expr: arg, env });
      }
    });
    const body = callable.body;
    if (!body) return UNKNOWN;
    if (!ts.isBlock(body)) return this.schema(body, scope, depth + 1);
    // The last top-level `return` builds the schema; earlier statements are
    // guards (loops that throw on a reserved key, and the like).
    const returns = body.statements.filter(ts.isReturnStatement);
    const last = returns[returns.length - 1];
    return last?.expression ? this.schema(last.expression, scope, depth + 1) : UNKNOWN;
  }
}

function isCallable(node: ts.Node): node is Callable {
  return ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function unwrapExpression(raw: ts.Expression): ts.Expression {
  let expr = raw;
  for (let guard = 0; guard < 16; guard += 1) {
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isSatisfiesExpression(expr) ||
      ts.isNonNullExpression(expr) ||
      ts.isTypeAssertionExpression(expr)
    ) {
      expr = expr.expression;
    } else {
      break;
    }
  }
  return expr;
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function objectKeys(raw: ts.Expression): Set<string> | null {
  const expr = unwrapExpression(raw);
  if (!ts.isObjectLiteralExpression(expr)) return null;
  const keys = new Set<string>();
  for (const property of expr.properties) {
    if (!ts.isPropertyAssignment(property)) return null;
    const key = propertyName(property.name);
    if (key === null) return null;
    keys.add(key);
  }
  return keys;
}

function literalValue(raw: ts.Expression): string | number | boolean | null {
  const expr = unwrapExpression(raw);
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

/**
 * The envelope schema an endpoint answers with: the first `*EnvelopeSchema`
 * named after its `GET /<endpoint>` route, up to the next route.
 */
export function findEnvelopeName(
  routes: Record<string, string>,
  endpoint: string,
): { found: boolean; envelope: string | null } {
  const route = new RegExp(`\\.get\\(\\s*['"\`]/${escapeRegExp(endpoint)}['"\`]`, 'u');
  const nextRoute = /\.(?:get|post|put|patch|delete|all)\(\s*['"`]\//gu;
  for (const text of Object.values(routes)) {
    const match = route.exec(text);
    if (!match) continue;
    const start = match.index + match[0].length;
    nextRoute.lastIndex = start;
    const end = nextRoute.exec(text)?.index ?? text.length;
    const envelope = /\b([A-Za-z_$][\w$]*EnvelopeSchema)\b/u.exec(text.slice(start, end));
    return { found: true, envelope: envelope?.[1] ?? null };
  }
  return { found: false, envelope: null };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// ---------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------

interface Tally {
  differences: ContractDifference[];
  checked: number;
  unchecked: number;
  uncheckedPaths: string[];
}

const MAX_UNCHECKED_PATHS = 20;

function markUnchecked(tally: Tally, count: number, where: string, path: string): void {
  tally.unchecked += count;
  if (tally.uncheckedPaths.length < MAX_UNCHECKED_PATHS) {
    tally.uncheckedPaths.push(`${where}: ${path || '(record)'}`);
  }
}

export function compareBreezeContract(
  expected: ExpectedBreezeContract,
  files: BreezeSourceFiles,
): ContractReport {
  const tally: Tally = { differences: [], checked: 0, unchecked: 0, uncheckedPaths: [] };
  const reader = new ZodSourceReader(files.schemas);
  let envelopeChecked = false;

  for (const endpoint of Object.keys(expected.endpoints) as BreezeSourceEndpoint[]) {
    const route = findEnvelopeName(files.routes, endpoint);
    if (!route.found) {
      tally.differences.push({
        problem: 'endpoint_missing',
        severity: 'breaking',
        where: endpoint,
        path: '',
        message: `Breeze no longer serves GET /api/v1/partner-api/${endpoint}.`,
      });
      continue;
    }
    const envelope = route.envelope ? reader.schemaOf(route.envelope) : UNKNOWN;
    const data = envelope.kind === 'object' ? envelope.fields.get('data') : undefined;
    if (envelope.kind !== 'object' || data?.kind !== 'array') {
      tally.differences.push({
        problem: 'contract_unreadable',
        severity: 'breaking',
        where: endpoint,
        path: '',
        message: route.envelope
          ? `The check could not read the record contract of ${endpoint} (${route.envelope} in schemas.ts). Review the release by hand and update the check.`
          : `The check found no *EnvelopeSchema for GET /${endpoint}. Review the release by hand and update the check.`,
      });
      continue;
    }

    checkSchemaVersion(expected.schemaVersion, endpoint, envelope.fields.get('schemaVersion'), tally);
    if (!envelopeChecked) {
      // Every export endpoint shares one envelope builder; check it once.
      envelopeChecked = true;
      compareRecord(expected.envelope, envelope, '(envelope)', tally);
      const blocked = envelope.fields.get('blocked');
      if (blocked?.kind === 'array') {
        compareRecord(expected.blockedNotice, blocked.element, '(blocked notice)', tally);
      }
    }
    compareRecord(expected.endpoints[endpoint], data.element, endpoint, tally);
  }

  checkHealthVersion(files.versionInfo, tally);
  const differences = dedupe(tally.differences);
  return {
    differences,
    failed: differences.some((difference) => difference.severity === 'breaking'),
    checkedFields: tally.checked,
    uncheckedFields: tally.unchecked,
    uncheckedPaths: tally.uncheckedPaths,
  };
}

function checkSchemaVersion(
  known: string,
  endpoint: string,
  node: UpstreamNode | undefined,
  tally: Tally,
): void {
  if (node?.kind === 'literal' && String(node.value) === known) return;
  const sent = node?.kind === 'literal' ? `"${String(node.value)}"` : 'something other than one fixed value';
  tally.differences.push({
    problem: 'schema_version',
    severity: 'breaking',
    where: endpoint,
    path: 'schemaVersion',
    message: `Breeze declares schemaVersion ${sent}; Weavestream knows "${known}". Syncs will pause until Weavestream knows the new version or an admin accepts it.`,
  });
}

function compareRecord(plan: PresencePlan, upstream: UpstreamNode, where: string, tally: Tally): void {
  if (upstream.kind === 'unknown') {
    markUnchecked(tally, countPlanFields(plan), where, '');
    return;
  }
  if (plan.discriminator === null) {
    const shape = plan.shapes.get('');
    if (!shape) return;
    // A plain record that became a union must still carry every field in
    // each of its variants.
    const options = upstream.kind === 'union' ? upstream.options : [upstream];
    for (const option of options) compareShape(shape, option, where, '', tally);
    return;
  }
  const key = plan.discriminator;
  const variants = upstream.kind === 'union' ? variantsOf(upstream, key) : null;
  for (const [variant, shape] of plan.shapes) {
    const option = variants?.get(variant);
    if (!option) {
      tally.differences.push({
        problem: 'variant_missing',
        severity: 'breaking',
        where,
        path: `${key}=${variant}`,
        message: `${where}: Breeze no longer declares records with ${key} "${variant}".`,
      });
      continue;
    }
    compareShape(shape, option, `${where} (${key}=${variant})`, '', tally);
  }
}

function variantsOf(union: Extract<UpstreamNode, { kind: 'union' }>, key: string): Map<string, UpstreamNode> {
  const variants = new Map<string, UpstreamNode>();
  for (const option of union.options) {
    if (option.kind !== 'object') continue;
    const value = option.fields.get(key);
    if (value?.kind === 'literal') variants.set(String(value.value), option);
  }
  return variants;
}

function compareShape(
  shape: ShapeNode,
  upstream: UpstreamNode,
  where: string,
  parentPath: string,
  tally: Tally,
): void {
  if (upstream.kind === 'unknown') {
    markUnchecked(tally, countShapeFields(shape), where, parentPath);
    return;
  }
  if (upstream.kind === 'union') {
    for (const option of upstream.options) compareShape(shape, option, where, parentPath, tally);
    return;
  }
  if (upstream.kind !== 'object') {
    tally.differences.push({
      problem: 'not_an_object',
      severity: 'breaking',
      where,
      path: parentPath,
      message: `${where}: ${parentPath} is no longer an object with the fields Weavestream reads.`,
    });
    return;
  }
  for (const [key, entry] of shape) {
    const field = upstream.fields.get(key);
    if (!field) {
      tally.checked += 1;
      tally.differences.push({
        problem: 'field_missing',
        severity: 'breaking',
        where,
        path: entry.path,
        message: `${where}: ${entry.path} is no longer declared (removed or renamed). Weavestream reads it.`,
      });
      continue;
    }
    if (field.kind === 'unknown') {
      markUnchecked(tally, 1 + (entry.child ? countShapeFields(entry.child) : 0), where, entry.path);
      continue;
    }
    tally.checked += 1;
    if (entry.array) {
      if (field.kind !== 'array') {
        tally.differences.push({
          problem: 'not_a_list',
          severity: 'breaking',
          where,
          path: entry.path,
          message: `${where}: ${entry.path} is no longer a list. Weavestream reads a list.`,
        });
      } else if (entry.child) {
        compareShape(entry.child, field.element, where, `${entry.path}[]`, tally);
      }
    } else if (entry.child) {
      compareShape(entry.child, field, where, entry.path, tally);
    }
  }
}

function countShapeFields(shape: ShapeNode): number {
  let count = 0;
  for (const entry of shape.values()) count += 1 + (entry.child ? countShapeFields(entry.child) : 0);
  return count;
}

function countPlanFields(plan: PresencePlan): number {
  let count = 0;
  for (const shape of plan.shapes.values()) count += countShapeFields(shape);
  return count;
}

function checkHealthVersion(versionInfo: string | null, tally: Tally): void {
  // `GET /health` returns `{ status, ...getVersionInfo(), uptime }`.
  if (versionInfo && /getVersionInfo\s*\(\s*\)\s*:\s*\{[^}]*\bversion\s*:/u.test(versionInfo)) return;
  tally.differences.push({
    problem: 'health_version',
    severity: 'notice',
    where: '/health',
    path: 'version',
    message: 'GET /health may no longer report "version". Only the Breeze version shown on sync runs is affected; syncs are not.',
  });
}

function dedupe(differences: ContractDifference[]): ContractDifference[] {
  const seen = new Set<string>();
  return differences.filter((difference) => {
    if (seen.has(difference.message)) return false;
    seen.add(difference.message);
    return true;
  });
}

// ---------------------------------------------------------------------
// Report text
// ---------------------------------------------------------------------

const PROBLEM_TITLE: Record<ContractProblem, string> = {
  endpoint_missing: 'Endpoint removed',
  contract_unreadable: 'Contract not readable by the check',
  schema_version: 'Schema version changed',
  field_missing: 'Field removed or renamed',
  not_a_list: 'Field type changed',
  not_an_object: 'Field type changed',
  variant_missing: 'Record variant removed',
  health_version: 'Version endpoint changed',
};

/** Markdown for the job summary and the log. */
export function formatContractReport(report: ContractReport, breezeRef: string): string {
  const breaking = report.differences.filter((difference) => difference.severity === 'breaking');
  const notices = report.differences.filter((difference) => difference.severity === 'notice');
  const lines: string[] = [];
  lines.push(
    breaking.length === 0
      ? `## Breeze ${breezeRef}: no partner API change Weavestream depends on`
      : `## Breeze ${breezeRef}: ${breaking.length} partner API change(s) Weavestream depends on`,
  );
  if (report.differences.length > 0) {
    lines.push('');
    lines.push('| Change | Where | Detail |');
    lines.push('| --- | --- | --- |');
    for (const difference of [...breaking, ...notices]) {
      const title = PROBLEM_TITLE[difference.problem] + (difference.severity === 'notice' ? ' (notice)' : '');
      lines.push(`| ${title} | \`${difference.where}\` | ${escapeCell(difference.message)} |`);
    }
  }
  if (breaking.length > 0) {
    lines.push('');
    lines.push('Update the Breeze driver before customers upgrade, or confirm the change is harmless. Until then Weavestream protects synced data: a field it saw before and no longer gets holds the page, an unknown schema version pauses the sync.');
  }
  lines.push('');
  lines.push(`Fields compared: ${report.checkedFields}. Fields the check could not follow in the Breeze source: ${report.uncheckedFields}.`);
  if (report.uncheckedPaths.length > 0) {
    lines.push('');
    lines.push('<details><summary>Fields not compared</summary>');
    lines.push('');
    for (const path of report.uncheckedPaths) lines.push(`- \`${path}\``);
    lines.push('');
    lines.push('</details>');
  }
  return `${lines.join('\n')}\n`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
}
