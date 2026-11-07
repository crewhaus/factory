/**
 * The rules the composed tables must obey, as functions over any input, so each
 * test can plant one defect and see this report it. Test-only: nothing in the
 * package's source imports these.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { z } from "zod";
import type { AreaModule, MachineDef, OperationRow } from "../areas/types.js";
import { PATH_PARAMS, isPathParam, pathParamSpans } from "../operations/params.js";

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

function duplicatesOf(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) out.add(value);
    seen.add(value);
  }
  return [...out];
}

export function checkModules(modules: readonly AreaModule[]): string[] {
  const problems: string[] = [];
  const report = (vocabulary: string, values: readonly string[]) => {
    for (const value of duplicatesOf(values)) problems.push(`duplicate ${vocabulary}: ${value}`);
  };
  if (modules[0]?.area !== "core") problems.push("the core module is not first");
  report(
    "area",
    modules.map((m) => m.area),
  );
  report(
    "operation",
    modules.flatMap((m) => m.operations.map((op) => op.id)),
  );
  report(
    "ref kind",
    modules.flatMap((m) => m.refKinds.map((decl) => decl.kind)),
  );
  report(
    "event family",
    modules.flatMap((m) => m.eventFamilies.map((family) => family.family)),
  );
  report(
    "event type",
    modules.flatMap((m) => m.eventFamilies.flatMap((f) => f.types.map((t) => t.type))),
  );
  report(
    "machine",
    modules.flatMap((m) => Object.keys(m.machines)),
  );
  report(
    "command kind",
    modules.flatMap((m) => m.commandKinds.map((kind) => kind.id)),
  );
  report(
    "permission",
    modules.flatMap((m) => m.permissions.map((decl) => decl.id)),
  );
  report(
    "scoped act",
    modules.flatMap((m) => m.scopedActs ?? []),
  );
  report(
    "capability",
    modules.flatMap((m) => m.capabilityKeys ?? []),
  );
  report(
    "grammar",
    modules.flatMap((m) => (m.grammars ?? []).map((g) => `${g.prefix}:${g.grammar}`)),
  );
  report(
    "reason code",
    modules.flatMap((m) =>
      Object.entries(m.reasonCodes ?? {}).flatMap(([event, reasons]) =>
        reasons.map((reason) => `${event}:${reason}`),
      ),
    ),
  );
  for (const module of modules) {
    for (const decl of module.permissions) {
      if (decl.id.startsWith("people.") && decl.floor !== "none") {
        problems.push(`a people permission has a role: ${decl.id}`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Machines
// ---------------------------------------------------------------------------

function reachableFrom(machine: MachineDef, start: readonly string[]): Set<string> {
  const seen = new Set<string>(start);
  const queue = [...start];
  while (queue.length > 0) {
    for (const next of machine.transitions[queue.pop() as string] ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

export function checkMachine(name: string, machine: MachineDef): string[] {
  const problems: string[] = [];
  const states = new Set(machine.states);
  for (const state of machine.states) {
    if (!Object.hasOwn(machine.transitions, state)) {
      problems.push(`${name}: ${state} has no transitions entry`);
    }
    if (!Object.hasOwn(machine.recoveryOwner, state)) {
      problems.push(`${name}: ${state} has no recovery owner`);
    }
  }
  for (const key of [...Object.keys(machine.transitions), ...Object.keys(machine.recoveryOwner)]) {
    if (!states.has(key)) problems.push(`${name}: a map names unknown state ${key}`);
  }
  for (const state of [...machine.entry, ...machine.terminal]) {
    if (!states.has(state)) problems.push(`${name}: unknown entry or terminal state ${state}`);
  }
  for (const [from, targets] of Object.entries(machine.transitions)) {
    for (const to of targets) {
      if (!states.has(to)) problems.push(`${name}: ${from} moves to unknown state ${to}`);
    }
  }
  for (const state of machine.terminal) {
    if ((machine.transitions[state] ?? []).length > 0) {
      problems.push(`${name}: terminal ${state} has edges`);
    }
  }
  const reachable = reachableFrom(machine, machine.entry);
  for (const state of machine.states) {
    if (!reachable.has(state)) problems.push(`${name}: orphan ${state}`);
    if (machine.terminal.includes(state)) continue;
    const onward = reachableFrom(machine, [state]);
    if (!machine.terminal.some((end) => onward.has(end))) {
      problems.push(`${name}: dead end ${state}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Zod walks
// ---------------------------------------------------------------------------

/** Peel the wrappers that do not change a value's fields. */
export function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return unwrap(schema.unwrap());
  }
  if (schema instanceof z.ZodDefault) return unwrap(schema.removeDefault());
  if (schema instanceof z.ZodEffects) return unwrap(schema.innerType());
  return schema;
}

/**
 * Call `visit` with every field name under a schema, at any depth. An unhandled
 * zod type throws, so a new wrapper can never hide fields from a walk.
 */
export function walkFieldNames(
  schema: z.ZodTypeAny,
  visit: (name: string, path: string) => void,
  path = "",
): void {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodObject) {
    for (const [name, field] of Object.entries(inner.shape as Record<string, z.ZodTypeAny>)) {
      const here = path === "" ? name : `${path}.${name}`;
      visit(name, here);
      walkFieldNames(field, visit, here);
    }
    return;
  }
  if (inner instanceof z.ZodArray) {
    walkFieldNames(inner.element, visit, `${path}[]`);
    return;
  }
  if (inner instanceof z.ZodRecord) {
    walkFieldNames(inner.valueSchema, visit, `${path}{}`);
    return;
  }
  if (inner instanceof z.ZodUnion) {
    for (const option of inner.options as z.ZodTypeAny[]) walkFieldNames(option, visit, path);
    return;
  }
  if (
    inner instanceof z.ZodString ||
    inner instanceof z.ZodNumber ||
    inner instanceof z.ZodBoolean ||
    inner instanceof z.ZodLiteral ||
    inner instanceof z.ZodEnum ||
    inner instanceof z.ZodUnknown ||
    inner instanceof z.ZodUndefined ||
    inner instanceof z.ZodAny
  ) {
    return;
  }
  throw new Error(`unhandled zod type at "${path}": ${inner.constructor.name}`);
}

function objectFields(schema: z.ZodTypeAny | undefined): readonly string[] {
  if (schema === undefined) return [];
  const inner = unwrap(schema);
  return inner instanceof z.ZodObject ? Object.keys(inner.shape) : [];
}

function isStrict(schema: z.ZodTypeAny | undefined): boolean {
  if (schema === undefined) return false;
  const inner = unwrap(schema);
  return inner instanceof z.ZodObject && inner._def.unknownKeys === "strict";
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type OperationEnv = {
  readonly permissions: readonly string[];
  readonly qualifiers: readonly string[];
  readonly schemas: Readonly<Record<string, z.ZodTypeAny>>;
  readonly commandKinds: AreaModule["commandKinds"];
  readonly cliVerbs: Readonly<Record<string, readonly string[]>>;
  readonly placeholders: Readonly<Record<string, RegExp>>;
};

type Segment = { readonly literal: string } | { readonly param: string; readonly spanned: boolean };

/** One way of laying a path out, with a `{ref}` taken at each of its spans. */
function expandPath(path: string): Segment[][] {
  let layouts: Segment[][] = [[]];
  for (const piece of path.split("/").filter((part) => part !== "")) {
    const param = /^\{(\w+)\}$/.exec(piece)?.[1];
    if (param === undefined) {
      layouts = layouts.map((layout) => [...layout, { literal: piece }]);
    } else {
      layouts = pathParamSpans(param).flatMap((span) =>
        layouts.map((layout) => [
          ...layout,
          ...Array<Segment>(span).fill({ param, spanned: span > 1 }),
        ]),
      );
    }
  }
  return layouts;
}

function segmentsCollide(a: Segment, b: Segment): boolean {
  if ("literal" in a && "literal" in b) return a.literal === b.literal;
  if ("param" in a && "param" in b) return true;
  const [param, literal] = ("param" in a ? [a, b] : [b, a]) as [
    { param: string; spanned: boolean },
    { literal: string },
  ];
  // One piece of a spanning param tells nothing alone, so it may match anything.
  return param.spanned || isPathParam(param.param, [literal.literal]);
}

function pathsCollide(a: string, b: string): boolean {
  for (const left of expandPath(a)) {
    for (const right of expandPath(b)) {
      if (
        left.length === right.length &&
        left.every((segment, i) => segmentsCollide(segment, right[i] as Segment))
      ) {
        return true;
      }
    }
  }
  return false;
}

function twinProblems(row: OperationRow, env: OperationEnv): string[] {
  if (row.cliTwin === null) return [];
  const problems: string[] = [];
  const [noun, verb] = row.cliTwin.argv;
  const verbs = env.cliVerbs[noun ?? ""];
  if (verbs === undefined) {
    problems.push(`${row.id}: twin noun "${noun}" is not in CLI_VERBS`);
  } else if (verb !== "{choice}" && !verbs.includes(verb ?? "")) {
    problems.push(`${row.id}: twin verb "${noun} ${verb}" is not in CLI_VERBS`);
  }
  for (const token of row.cliTwin.argv) {
    if (token.startsWith("{") && !Object.hasOwn(env.placeholders, token)) {
      problems.push(`${row.id}: twin placeholder ${token} is not declared`);
    }
  }
  return problems;
}

export function checkOperations(rows: readonly OperationRow[], env: OperationEnv): string[] {
  const problems: string[] = [];
  for (const id of duplicatesOf(rows.map((row) => row.id))) {
    problems.push(`duplicate operation id: ${id}`);
  }
  for (const route of duplicatesOf(rows.map((row) => `${row.method} ${row.path}`))) {
    problems.push(`duplicate route: ${route}`);
  }
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i] as OperationRow;
      const b = rows[j] as OperationRow;
      if (a.method === b.method && a.path !== b.path && pathsCollide(a.path, b.path)) {
        problems.push(`route collision: ${a.method} ${a.path} and ${b.path}`);
      }
    }
  }
  const kinds = new Map(env.commandKinds.map((kind) => [kind.id, kind]));
  for (const row of rows) {
    const { id } = row;
    for (const match of row.path.matchAll(/\{(\w+)\}/g)) {
      if (!Object.hasOwn(PATH_PARAMS, match[1] as string)) {
        problems.push(`${id}: undeclared param {${match[1]}}`);
      }
    }
    if (
      row.permission !== "public" &&
      row.permission !== "authenticated" &&
      !env.permissions.includes(row.permission)
    ) {
      problems.push(`${id}: unknown permission ${row.permission}`);
    }
    for (const qualifier of row.qualifiers) {
      if (!env.qualifiers.includes(qualifier))
        problems.push(`${id}: unknown qualifier ${qualifier}`);
    }
    if (row.method === "GET" && row.receipt !== "none") problems.push(`${id}: a GET has a receipt`);
    if ((row.receipt !== "none") !== (row.idempotency !== "none")) {
      problems.push(`${id}: receipt and idempotency disagree`);
    }
    if (row.method !== "GET" && row.receipt === "none" && !row.noReceiptReason) {
      problems.push(`${id}: no receipt and no reason`);
    }
    const request = env.schemas[row.request];
    const response = env.schemas[row.response];
    if (request === undefined) problems.push(`${id}: no schema ${row.request}`);
    if (response === undefined) problems.push(`${id}: no schema ${row.response}`);
    if (row.method !== "GET" && !isStrict(request)) problems.push(`${id}: request is not strict`);
    const requestFields = objectFields(request);
    for (const field of row.secretFields ?? []) {
      if (!requestFields.includes(field))
        problems.push(`${id}: secret field ${field} not in request`);
    }
    for (const field of Object.keys(row.modelBound ?? {})) {
      if (!requestFields.includes(field))
        problems.push(`${id}: modelBound ${field} not in request`);
    }
    if ((row.cliTwin === null) !== (row.noTwinReason !== undefined)) {
      problems.push(`${id}: a twin and its reason disagree`);
    }
    problems.push(...twinProblems(row, env));
    const kind = kinds.get(id);
    if (row.receipt !== "none") {
      if (kind === undefined) {
        problems.push(`${id}: receipted with no command kind`);
      } else {
        if (kind.permission !== row.permission) problems.push(`${id}: kind permission differs`);
        if (JSON.stringify(kind.cliTwin) !== JSON.stringify(row.cliTwin)) {
          problems.push(`${id}: kind twin differs`);
        }
        if (kind.effect === "external" && row.idempotency !== "required") {
          problems.push(`${id}: an external effect does not require idempotency`);
        }
      }
    } else if (kind !== undefined) {
      problems.push(`${id}: a command kind with no receipt`);
    }
    const returnsIssued = objectFields(response).includes("issued");
    if (returnsIssued !== requestFields.includes("seal")) {
      problems.push(`${id}: issued and seal disagree`);
    }
  }
  for (const kind of env.commandKinds) {
    if (!rows.some((row) => row.id === kind.id)) problems.push(`${kind.id}: a kind with no row`);
  }
  return problems;
}

/** Which `CLI_VERBS` entries and placeholders no row uses. */
export function unusedTwinVocabulary(
  rows: readonly OperationRow[],
  env: Pick<OperationEnv, "cliVerbs" | "placeholders">,
  choices: readonly string[],
): string[] {
  const used = new Set<string>();
  const usedTokens = new Set<string>();
  for (const row of rows) {
    const argv = row.cliTwin?.argv;
    if (argv === undefined) continue;
    for (const token of argv) usedTokens.add(token);
    const [noun, verb] = argv;
    if (verb === "{choice}") {
      for (const choice of choices) used.add(`${noun} ${choice}`);
    } else {
      used.add(`${noun} ${verb}`);
    }
  }
  const unused: string[] = [];
  for (const [noun, verbs] of Object.entries(env.cliVerbs)) {
    for (const verb of verbs) {
      if (!used.has(`${noun} ${verb}`)) unused.push(`${noun} ${verb}`);
    }
  }
  for (const token of Object.keys(env.placeholders)) {
    if (!usedTokens.has(token)) unused.push(token);
  }
  return unused;
}

// ---------------------------------------------------------------------------
// The main entry's import graph
// ---------------------------------------------------------------------------

export type ImportGraph = {
  readonly files: readonly string[];
  readonly problems: readonly string[];
};

const FORBIDDEN_CODE: readonly (readonly [RegExp, string])[] = [
  [/\bBuffer\b/, "Buffer"],
  [/\bprocess\./, "process."],
  [/\bBun\./, "Bun."],
  [/\brequire\(/, "require("],
];

/**
 * Walk what an entry reaches, with both of the repo's parsers: Bun's, which sees
 * what runs, and TypeScript's, which sees `import type` too.
 */
export function scanImportGraph(entry: string): ImportGraph {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const root = dirname(entry);
  const files = new Set<string>();
  const problems: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const name = relative(root, file);
    const source = readFileSync(file, "utf8");
    const code = transpiler.transformSync(source);
    for (const [pattern, label] of FORBIDDEN_CODE) {
      if (pattern.test(code)) problems.push(`${name}: uses ${label}`);
    }
    const specifiers = new Set<string>([
      ...transpiler.scan(source).imports.map((item) => item.path),
      ...ts.preProcessFile(source, true, true).importedFiles.map((item) => item.fileName),
    ]);
    for (const specifier of specifiers) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        problems.push(`${name}: imports the package or builtin "${specifier}"`);
        continue;
      }
      if (!specifier.endsWith(".js")) {
        problems.push(`${name}: extensionless import "${specifier}"`);
        continue;
      }
      if (/(?:^|\/)schemas\//.test(specifier)) {
        problems.push(`${name}: imports ./schemas through "${specifier}"`);
        continue;
      }
      queue.push(join(dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  }
  return { files: [...files].sort(), problems };
}
