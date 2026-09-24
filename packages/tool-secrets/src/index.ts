/**
 * @crewhaus/tool-secrets — answering questions about secrets without handing
 * one over.
 *
 * ── The rule the whole package is built around ─────────────────────────────
 *
 * **A tool result never contains a secret value.** Not on success, not in an
 * error, not in a diff, not "just this once behind a flag". A tool result is
 * read by a model, and from there it is in a transcript, a trace, a log export
 * and a support ticket; a secret that enters that path has to be treated as
 * rotated whether or not anyone noticed. So `SecretLookup` reports whether a
 * reference RESOLVES, which backend answered, and a non-reversible fingerprint
 * — never the plaintext. There is deliberately no `reveal` option, because the
 * option is the vulnerability: the moment one exists, a model under pressure
 * to "just check the value" will pass it.
 *
 * The same rule shapes the other two. `EnvFileUpsert` takes a REFERENCE to a
 * value, dereferences it inside `execute`, and reports the key, the line and a
 * fingerprint. `SecretRotate` never returns the value it wrote, and never puts
 * a new value on a command line — only on a child's stdin — because `ps` shows
 * argv to every user on the machine.
 *
 * This matches what `@crewhaus/tool-notify` already does with SMTP
 * credentials: they "arrive already resolved from an environment variable NAME
 * by the caller", and the transcript records `AUTH PLAIN <redacted>`.
 *
 * ── Rotation is the destructive one ────────────────────────────────────────
 *
 * If a rotation half-succeeds, the operator is locked out of their own
 * service. So `SecretRotate` runs in a fixed order — take the lock, read the
 * current value, write the new one, VERIFY it reads back, and only then retire
 * the old — and every step is named in the result. If any step fails, the old
 * value is left working (restored if it had already been replaced), and the
 * result says which step failed and whether the rollback took. `dryRun` walks
 * the same code path and stops at each syscall instead of making it.
 *
 * ── What it does not do ────────────────────────────────────────────────────
 *
 * It does not revoke anything at a provider. Rotating `env:STRIPE_KEY` in a
 * `.env` changes what your harness sends; the old key stays valid at Stripe
 * until you revoke it there. The result says so every time.
 */
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { classifyWrite, helperName } from "./lib/backends";
import {
  type Edit,
  type EnvDoc,
  parseEnvDoc,
  planUnset,
  planUpsert,
  renderEnvDoc,
} from "./lib/envfile";
import { describeValue, fingerprint } from "./lib/fingerprint";
import {
  _setClock,
  acquireLock,
  appendJournal,
  lastRotation,
  now,
  readJournal,
} from "./lib/journal";
import {
  type Resolved,
  type SecretRef,
  formatRef,
  parseRef,
  refuse,
  whyNotRotatable,
  writeArgv,
} from "./lib/refs";
import { type Resolution, _setEnv, reasonOf, resolveChain, resolveOne } from "./lib/resolve";
import { _setRunner, runCommand } from "./lib/run";
import { writeFileAtomic } from "./lib/write";
import { resolveSafe } from "./paths";

/** The seams. Every test in this package drives these instead of the host. */
export { _setRunner, _setEnv, _setClock };
export { COMMAND_BACKENDS, parseRef, formatRef } from "./lib/refs";
export { fingerprint, describeValue, stripValues, firstLine } from "./lib/fingerprint";
export { parseEnvDoc, renderEnvDoc, planUpsert, planUnset, encodeBare } from "./lib/envfile";

/** Compact JSON — the reader is a model, not a person. */
const json = (value: unknown): string => JSON.stringify(value);

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;

const timeoutSchema = z
  .number()
  .int()
  .min(100)
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(
    `milliseconds a credential helper may take before it is killed (default ${DEFAULT_TIMEOUT_MS})`,
  );

const refSchema = z
  .string()
  .min(1)
  .max(512)
  .describe(
    "where the secret lives, never the secret: env:NAME, file:path, envfile:.env#KEY, keychain:service[#account], pass:entry, libsecret:attr=value, op://vault/item/field, or a bare NAME for the local chain",
  );

let randomBytes: (size: number) => Uint8Array = cryptoRandomBytes;

/**
 * Test seam for generated secrets. Generation is the one place this package
 * needs randomness, and a test cannot assert anything about a value it cannot
 * predict — so the suite supplies a counter and the production path keeps the
 * CSPRNG.
 */
export function _setRandomBytes(fn: ((size: number) => Uint8Array) | undefined): void {
  randomBytes = fn ?? cryptoRandomBytes;
}

/** The note that goes on every rotation result. */
const UPSTREAM_NOTE =
  "this rotated the STORED value only. A credential issued by a provider stays valid at that provider until you revoke it there.";

/** Keys whose names say they hold a credential. */
const SECRETISH_KEY_RE = /(^|_)(KEY|TOKEN|SECRET|SECRETS|PASSWORD|PASSPHRASE|CREDENTIALS?|PAT)$/i;

// ---------------------------------------------------------------------------
// SecretLookup
// ---------------------------------------------------------------------------

/**
 * What a caller learns about a value that DID resolve. This type is the
 * package's promise in code: there is no field here that could hold plaintext,
 * so no future edit can add one by accident inside a spread.
 */
type ValueFacts = {
  readonly fingerprint: string;
  readonly length: number;
  readonly empty?: true;
  readonly trailingNewline?: true;
  readonly leadingOrTrailingSpace?: true;
};

/** One reference's answer, as it appears in the result. Never holds a value. */
type LookupReport = {
  readonly ref: string;
  readonly backend: string;
  readonly status: string;
  readonly resolved: boolean;
  readonly source?: string;
  readonly reason?: string;
  readonly lastRotatedAt?: string;
} & Partial<ValueFacts> &
  Record<string, unknown>;

function valueFacts(value: string): ValueFacts {
  const shape = describeValue(value);
  return {
    fingerprint: shape.fingerprint,
    length: shape.length,
    ...(shape.empty ? { empty: true as const } : {}),
    ...(shape.trailingNewline ? { trailingNewline: true as const } : {}),
    ...(shape.leadingOrTrailingSpace ? { leadingOrTrailingSpace: true as const } : {}),
  };
}

async function lookupOne(
  ref: SecretRef,
  options: { toolName: string; timeoutMs: number; signal?: AbortSignal },
): Promise<LookupReport> {
  if (ref.kind !== "auto") {
    const resolution = await resolveOne(ref, options);
    return {
      ref: formatRef(ref),
      backend: ref.kind,
      status: resolution.status,
      resolved: resolution.status === "resolved",
      source: resolution.source,
      ...(resolution.status === "resolved"
        ? valueFacts(resolution.value)
        : { reason: reasonOf(resolution) }),
    };
  }

  // A bare name: walk the WHOLE chain, not just until something answers. The
  // bug worth catching is a second definition with a different value in a file
  // the operator is editing, which a first-match-wins probe never sees.
  const steps = await resolveChain(ref.name, options);
  const found = steps.filter(
    (step): step is typeof step & { resolution: { status: "resolved"; value: string } } =>
      step.resolution.status === "resolved",
  );
  const winner = found[0];
  const others = found.slice(1);
  const errors = steps.filter((step) => step.resolution.status === "error");

  if (winner === undefined) {
    const firstError = errors[0];
    return {
      ref: ref.name,
      backend: "auto",
      status: errors.length > 0 ? "error" : "absent",
      resolved: false,
      searched: steps.map((step) => formatRef(step.ref)),
      reason:
        firstError !== undefined
          ? reasonOf(firstError.resolution)
          : `${ref.name} is not set in the environment, in any .env file, or in the secrets directory.`,
    };
  }

  // Steps that OUTRANK the winner and could not be read. They are not "no":
  // each one may hold a different value, and if it does, that value is what
  // the harness will use. Reporting the winner as the answer while quietly
  // dropping them is a definite answer built on an unknown.
  const blockedAbove = steps
    .slice(0, steps.indexOf(winner))
    .filter(
      (step) => step.resolution.status === "error" || step.resolution.status === "unavailable",
    );
  const winnerShape = valueFacts(winner.resolution.value);
  const shadowed = others.map((step) => {
    const shape = valueFacts(step.resolution.value);
    return {
      ref: formatRef(step.ref),
      source: step.resolution.source,
      fingerprint: shape.fingerprint,
      sameValue: shape.fingerprint === winnerShape.fingerprint,
    };
  });
  const disagreeing = shadowed.filter((entry) => entry.sameValue === false);
  const warnings: string[] = [];
  if (disagreeing.length > 0) {
    warnings.push(
      `${ref.name} is defined in ${disagreeing.length + 1} places with different values; ${winner.resolution.source} is the one that wins. Editing any of the others changes nothing.`,
    );
  }
  if (blockedAbove.length > 0) {
    warnings.push(
      `${blockedAbove
        .map((step) => formatRef(step.ref))
        .join(
          " and ",
        )} outranks ${winner.resolution.source} and could not be checked, so this is only the winning value if nothing is defined there.`,
    );
  }
  return {
    ref: ref.name,
    backend: "auto",
    status: "resolved",
    resolved: true,
    wonBy: formatRef(winner.ref),
    source: winner.resolution.source,
    ...winnerShape,
    ...(shadowed.length > 0 ? { alsoDefinedIn: shadowed } : {}),
    ...(blockedAbove.length > 0
      ? {
          couldNotCheck: blockedAbove.map((step) => ({
            ref: formatRef(step.ref),
            status: step.resolution.status,
            reason: reasonOf(step.resolution),
          })),
        }
      : {}),
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  };
}

export const secretLookup: RegisteredTool = buildTool({
  name: "SecretLookup",
  operativeArgs: [{ field: "refs", kind: "id" }],
  description:
    "Check whether a secret reference resolves, and report where it resolves FROM — without returning the secret. Use it to preflight credentials before a run, to find out which of several definitions of the same variable actually wins, or to confirm a rotation took. Each reference comes back with the backend that answered, the source, and a truncated SHA-256 fingerprint that lets you compare two secrets or detect a change without ever seeing either value; a bare NAME is searched across the environment, the .env chain and the secrets directory, and a shadowing definition with a different value is reported as a warning. It deliberately has no option to reveal a value.",
  inputSchema: z.object({
    refs: z
      .array(refSchema)
      .min(1)
      .max(32)
      .describe("one or more references to check, in one call"),
    timeout: timeoutSchema,
  }),
  readOnly: true,
  concurrencySafe: true,
  // A keychain/pass/op reference spawns a helper, so this declares the
  // process boundary it can cross and must therefore be scope "external"
  // (see auditToolScopes in @crewhaus/tool-builder).
  scope: "external",
  ioCapability: "process",
  execute: async (input, ctx?: ToolExecuteContext) => {
    const timeoutMs = input.timeout ?? DEFAULT_TIMEOUT_MS;
    const { journal, unreadable } = readJournal("SecretLookup");
    const reports: LookupReport[] = [];
    for (const raw of input.refs) {
      const parsed = parseRef(raw);
      if (!parsed.ok) {
        reports.push({
          ref: raw,
          backend: "none",
          status: "invalid",
          resolved: false,
          reason: parsed.message,
        });
        continue;
      }
      const report = await lookupOne(parsed.value, {
        toolName: "SecretLookup",
        timeoutMs,
        ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      const rotated = lastRotation(journal.entries, formatRef(parsed.value));
      reports.push({
        ...report,
        ...(rotated !== undefined ? { lastRotatedAt: rotated.rotatedAt } : {}),
      });
      if (ctx?.signal?.aborted === true) break;
    }
    // A scan that stopped early has NOT checked the references it never
    // reached, and `allResolved: true` over the handful it did reach is a
    // preflight that says "every credential is there" about credentials it
    // never looked at. The count that was asked for is reported alongside the
    // count that was done, and the claim is withdrawn rather than narrowed.
    const complete = reports.length === input.refs.length;
    return json({
      requested: input.refs.length,
      checked: reports.length,
      allResolved: complete && reports.every((report) => report.resolved === true),
      ...(complete
        ? {}
        : {
            incomplete: `this call was cancelled after ${reports.length} of ${input.refs.length} references; the rest were never checked, so nothing is known about them.`,
          }),
      results: reports,
      ...(unreadable !== undefined ? { journalNote: unreadable } : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// EnvFileUpsert
// ---------------------------------------------------------------------------

type EnvOp = {
  readonly key: string;
  readonly action: "set" | "unset";
  /** Resolved before any planning; absent for `unset`. */
  readonly value?: string;
  readonly source: string;
};

type AppliedEdit = {
  readonly key: string;
  readonly how: Edit["how"];
  readonly line?: number;
  readonly source: string;
  readonly fingerprint?: string;
  readonly previousFingerprint?: string;
};

type EnvPlan = {
  readonly doc: EnvDoc;
  readonly edits: readonly AppliedEdit[];
  readonly changed: number;
};

/**
 * Plan every edit against ONE document, in order, and refuse the whole call if
 * any of them cannot be made.
 *
 * All-or-nothing on purpose: a partial write is the failure mode this package
 * exists to avoid. Two keys half-written is a `.env` that neither the old
 * configuration nor the new one describes, and the caller has no way to know
 * which half landed.
 */
function planEnvOps(doc: EnvDoc, ops: readonly EnvOp[]): Resolved<EnvPlan> {
  let current = doc;
  const edits: AppliedEdit[] = [];
  let changed = 0;
  for (const op of ops) {
    const planned =
      op.action === "set"
        ? planUpsert(current, op.key, op.value ?? "")
        : planUnset(current, op.key);
    if (!planned.ok) return refuse(`${op.key}: ${planned.message}`);
    const edit = planned.value;
    current = edit.doc;
    if (edit.how !== "unchanged" && edit.how !== "absent" && edit.how !== "already-commented") {
      changed += 1;
    }
    edits.push({
      key: op.key,
      how: edit.how,
      ...(edit.line !== undefined ? { line: edit.line } : {}),
      source: op.source,
      ...(op.value !== undefined ? { fingerprint: fingerprint(op.value) } : {}),
      ...(edit.previous !== undefined ? { previousFingerprint: fingerprint(edit.previous) } : {}),
    });
  }
  return { ok: true, value: { doc: current, edits, changed } };
}

type OpenedDoc = { readonly real: string; readonly doc: EnvDoc; readonly existed: boolean };

/**
 * Read a `.env` for editing. A missing file is an empty one, not an error:
 * setting the first key in a harness that has no `.env` yet is the common
 * case, not a mistake.
 *
 * The read is synchronous, and so is the write that follows it. An `await`
 * between them would widen the window in which somebody else's editor saves
 * the same file and has their change overwritten.
 */
function readDocForEdit(toolName: string, path: string): Resolved<OpenedDoc> {
  let real: string;
  try {
    real = resolveSafe(toolName, path).real;
  } catch {
    return refuse(
      `refused "${path}": it resolves outside the workspace root. A .env is written inside the workspace only.`,
    );
  }
  if (!existsSync(real)) return { ok: true, value: { real, doc: parseEnvDoc(""), existed: false } };
  try {
    return {
      ok: true,
      value: { real, doc: parseEnvDoc(readFileSync(real, "utf8")), existed: true },
    };
  } catch (err) {
    return refuse(
      `"${path}" could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export const envFileUpsert: RegisteredTool = buildTool({
  name: "EnvFileUpsert",
  description:
    "Set or comment out keys in a .env file, in place, preserving every comment, blank line and the operator's key order. A value is given either literally (for ordinary configuration) or as a reference such as env:NAME or keychain:service, which is dereferenced inside the tool so the secret never appears in the call or the result — what comes back is the key, the line number and a fingerprint. An existing assignment is rewritten where it stands, a commented-out stub is promoted in place, and a key assigned twice is refused rather than guessed at. All the edits in one call land in a single atomic write, or none do. dryRun reports exactly the same plan without writing.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe("the .env file, relative to the workspace root (default .env)"),
    entries: z
      .array(
        z.object({
          key: z.string().min(1).max(128).describe("the variable name, e.g. SLACK_BOT_TOKEN"),
          value: z
            .string()
            .max(4096)
            .optional()
            .describe(
              "a literal value, for ordinary configuration — anything passed here is already in the transcript, so use valueFrom for a secret",
            ),
          valueFrom: refSchema
            .optional()
            .describe(
              "a reference the tool dereferences itself, so the value stays out of the call",
            ),
          action: z
            .enum(["set", "unset"])
            .optional()
            .describe("set (default), or unset to comment the line out as `# KEY=`"),
        }),
      )
      .min(1)
      .max(32),
    dryRun: z
      .boolean()
      .optional()
      .describe("plan the same edits and report them without writing the file"),
    timeout: timeoutSchema,
  }),
  destructive: true,
  scope: "external",
  ioCapability: "process",
  // The file a rule is about. Leaving `path` out writes `.env`, so a rule
  // sees `.env` too — `alwaysDeny EnvFileUpsert(.env)` cannot be dodged by
  // omitting the field.
  operativeArgs: [{ field: "path", kind: "path", default: ".env" }],
  execute: async (input, ctx?: ToolExecuteContext) => {
    const path = input.path ?? ".env";
    const timeoutMs = input.timeout ?? DEFAULT_TIMEOUT_MS;
    const warnings: string[] = [];

    // 1. Validate every entry BEFORE resolving anything: a refusal after a
    //    keychain prompt has already cost the operator a prompt.
    const seen = new Set<string>();
    for (const entry of input.entries) {
      const action = entry.action ?? "set";
      if (seen.has(entry.key)) {
        return `[EnvFileUpsert error] ${entry.key} appears twice in this call. Two edits to one key in one write have no defined order — send one.`;
      }
      seen.add(entry.key);
      if (action === "set") {
        const given = [entry.value, entry.valueFrom].filter((v) => v !== undefined).length;
        if (given !== 1) {
          return `[EnvFileUpsert error] ${entry.key} needs exactly one of value or valueFrom (${given === 0 ? "neither was given" : "both were given"}). Guessing which one you meant could write the wrong secret.`;
        }
      } else if (entry.value !== undefined || entry.valueFrom !== undefined) {
        return `[EnvFileUpsert error] ${entry.key} has action "unset" and a value. Unsetting comments the line out; it takes no value.`;
      }
    }

    // 2. Dereference. This is the only place a value exists in this tool.
    const ops: EnvOp[] = [];
    for (const entry of input.entries) {
      const action = entry.action ?? "set";
      if (action === "unset") {
        ops.push({ key: entry.key, action, source: "unset" });
        continue;
      }
      if (entry.value !== undefined) {
        if (SECRETISH_KEY_RE.test(entry.key)) {
          warnings.push(
            `${entry.key} was given a literal value. Its name says it holds a credential, and a literal value is already in this conversation's transcript — pass valueFrom next time so the tool dereferences it instead.`,
          );
        }
        ops.push({ key: entry.key, action, value: entry.value, source: "literal" });
        continue;
      }
      const parsed = parseRef(entry.valueFrom as string);
      if (!parsed.ok) return `[EnvFileUpsert error] ${entry.key}: ${parsed.message}`;
      const resolution = await resolveOne(parsed.value, {
        toolName: "EnvFileUpsert",
        timeoutMs,
        ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      if (resolution.status !== "resolved") {
        return `[EnvFileUpsert error] ${entry.key}: ${formatRef(parsed.value)} did not resolve (${resolution.status}) — ${resolution.reason}. Nothing was written.`;
      }
      // A bare name that resolves out of a chain whose members disagree: the
      // caller asked for "the value", and there are two. Which one was taken
      // is reported rather than left for them to discover in production.
      if (resolution.note !== undefined) warnings.push(`${entry.key}: ${resolution.note}`);
      ops.push({
        key: entry.key,
        action,
        value: resolution.value,
        // The reference as the caller wrote it — plus, for a bare name, the
        // place in the chain that actually answered.
        source:
          parsed.value.kind === "auto"
            ? `${formatRef(parsed.value)} (${resolution.source})`
            : formatRef(parsed.value),
      });
    }

    // 3. Plan against the file as it is.
    const opened = readDocForEdit("EnvFileUpsert", path);
    if (!opened.ok) return `[EnvFileUpsert error] ${opened.message}`;
    const { real, doc, existed } = opened.value;
    const planned = planEnvOps(doc, ops);
    if (!planned.ok) return `[EnvFileUpsert error] ${planned.message} Nothing was written.`;
    const plan = planned.value;

    const body = {
      file: path,
      dryRun: input.dryRun === true,
      entries: plan.edits,
      changed: plan.changed,
      unchanged: plan.edits.length - plan.changed,
      ...(warnings.length > 0 ? { warnings } : {}),
    };

    // 4. Apply — or, for a dry run, stop exactly here. The plan above is the
    //    plan that would be written; there is no second preview path to drift.
    if (input.dryRun === true) {
      return json({ ...body, applied: false, wouldCreateFile: !existed });
    }
    if (plan.changed === 0) {
      return json({ ...body, applied: false, note: "every entry already had that value." });
    }
    let report: ReturnType<typeof writeFileAtomic>;
    try {
      report = writeFileAtomic(real, renderEnvDoc(plan.doc));
    } catch (err) {
      return `[EnvFileUpsert error] ${path} could not be written: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.`;
    }
    return json({
      ...body,
      applied: true,
      created: report.created,
      ...(report.modeTightened !== undefined ? { modeTightened: report.modeTightened } : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// SecretRotate
// ---------------------------------------------------------------------------

type Step = {
  readonly step: string;
  readonly ok: boolean;
  readonly detail?: string;
  /** True when a dry run stopped short of the syscall this step makes. */
  readonly wouldRun?: boolean;
};

/** Write a value through whichever backend the reference names. */
async function writeValue(
  ref: SecretRef,
  value: string,
  options: { toolName: string; timeoutMs: number; signal?: AbortSignal; dry: boolean },
): Promise<{ ok: true; detail: string } | { ok: false; message: string }> {
  if (ref.kind === "file") {
    let real: string;
    try {
      real = resolveSafe(options.toolName, ref.path).real;
    } catch {
      return { ok: false, message: `"${ref.path}" resolves outside the workspace root.` };
    }
    if (options.dry) return { ok: true, detail: `would write ${ref.path} (0600)` };
    try {
      const report = writeFileAtomic(real, value);
      return {
        ok: true,
        detail: `wrote ${ref.path}${report.modeTightened !== undefined ? ` (mode ${report.modeTightened})` : ""}`,
      };
    } catch (err) {
      return {
        ok: false,
        message: `${ref.path}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (ref.kind === "envfile") {
    const opened = readDocForEdit(options.toolName, ref.path);
    if (!opened.ok) return { ok: false, message: opened.message };
    const { real, doc } = opened.value;
    const planned = planUpsert(doc, ref.key, value);
    if (!planned.ok) return { ok: false, message: planned.message };
    if (options.dry) {
      // The `how` comes from the same plan the real write would use, so the
      // dry run reports the ACTUAL outcome ("uncommented" rather than
      // "appended") instead of a preview that guesses.
      return {
        ok: true,
        detail: `would set ${ref.key} in ${ref.path} (${planned.value.how})`,
      };
    }
    try {
      writeFileAtomic(real, renderEnvDoc(planned.value.doc));
      return { ok: true, detail: `${planned.value.how} ${ref.key} in ${ref.path}` };
    } catch (err) {
      return {
        ok: false,
        message: `${ref.path}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const argv = writeArgv(ref);
  if (argv === undefined) {
    return { ok: false, message: `no write command for the ${ref.kind} backend.` };
  }
  if (options.dry)
    return { ok: true, detail: `would run \`${argv.join(" ")}\` with the value on stdin` };
  const run = await runCommand(argv, {
    timeoutMs: options.timeoutMs,
    // The value goes on STDIN. argv is world-readable through `ps`, so a
    // rotation that passed it as an argument would publish the new secret at
    // the moment it was created.
    stdin: value,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  const outcome = classifyWrite(ref, run, value);
  return outcome.status === "resolved"
    ? { ok: true, detail: `\`${helperName(ref.kind)}\` accepted the new value` }
    : { ok: false, message: outcome.reason };
}

/** Where a backend keeps the previous value while the new one is proven. */
function previousRef(ref: SecretRef): SecretRef | undefined {
  if (ref.kind === "envfile")
    return { kind: "envfile", path: ref.path, key: `${ref.key}_PREVIOUS` };
  if (ref.kind === "file") return { kind: "file", path: `${ref.path}.previous` };
  // `pass` and `secret-tool` would need a second entry under a name this tool
  // invented, which an operator would find later with no idea what wrote it.
  return undefined;
}

export const secretRotate: RegisteredTool = buildTool({
  name: "SecretRotate",
  operativeArgs: [{ field: "ref", kind: "id" }],
  description:
    "Replace a stored secret with a new value and prove the new one reads back, without either value appearing in the result. The new value is generated here or taken from another reference; it is written first, verified by re-reading it, and only then is the previous copy retired — so a failure at any step leaves the old secret working, and the result names the step that failed. A rotation takes an exclusive lock, so two callers cannot rotate the same secret at once and invalidate each other. It rotates the STORED value only: a credential issued by a provider stays valid there until you revoke it. dryRun walks the same steps and reports what each one would do.",
  inputSchema: z.object({
    ref: refSchema.describe("the secret to rotate — envfile:, file:, pass: or libsecret:"),
    newValueFrom: refSchema
      .optional()
      .describe("take the new value from this reference instead of generating one"),
    generate: z
      .object({
        bytes: z
          .number()
          .int()
          .min(16)
          .max(128)
          .describe("how many random bytes the new value is made of"),
        encoding: z
          .enum(["base64url", "hex"])
          .describe("base64url is shorter; both are safe to write into a .env unquoted"),
      })
      .optional()
      .describe("generate the new value here; it is never returned"),
    createIfAbsent: z
      .boolean()
      .optional()
      .describe("allow rotating a secret that does not exist yet (default false)"),
    keepPrevious: z
      .boolean()
      .optional()
      .describe(
        "keep the old value alongside the new one (KEY_PREVIOUS, or <path>.previous) so a running process can be migrated (default true where the backend supports it)",
      ),
    retirePrevious: z
      .boolean()
      .optional()
      .describe("remove a previously kept copy AFTER the new value verifies (default false)"),
    minIntervalHours: z
      .number()
      .min(0)
      .max(8760)
      .optional()
      .describe("refuse if this secret was rotated more recently than this, per the local journal"),
    dryRun: z.boolean().optional().describe("report every step without changing anything"),
    timeout: timeoutSchema,
  }),
  destructive: true,
  requireJustification: true,
  scope: "external",
  ioCapability: "process",
  execute: async (input, ctx?: ToolExecuteContext) => {
    const dry = input.dryRun === true;
    const timeoutMs = input.timeout ?? DEFAULT_TIMEOUT_MS;
    const signal = ctx?.signal;
    const steps: Step[] = [];
    const runOptions = {
      toolName: "SecretRotate",
      timeoutMs,
      ...(signal !== undefined ? { signal } : {}),
    };

    const parsed = parseRef(input.ref);
    if (!parsed.ok) return `[SecretRotate error] ${parsed.message}`;
    const ref = parsed.value;
    const label = formatRef(ref);

    const notRotatable = whyNotRotatable(ref);
    if (notRotatable !== undefined) {
      return `[SecretRotate error] ${label} cannot be rotated: ${notRotatable}`;
    }

    const wantGenerate = input.generate !== undefined;
    const wantFrom = input.newValueFrom !== undefined;
    if (wantGenerate === wantFrom) {
      return `[SecretRotate error] give exactly one of generate or newValueFrom (${wantGenerate ? "both were given" : "neither was given"}). There is no default new value: guessing one would write a credential nobody chose.`;
    }

    // The whole rotation runs under the lock, including the dry run, because a
    // dry run that ignored the lock would report a plan that a concurrent real
    // rotation is already invalidating.
    const lock = acquireLock("SecretRotate", label);
    if (!lock.ok) return `[SecretRotate error] ${lock.message}`;
    steps.push({
      step: "lock",
      ok: true,
      ...(lock.value.brokeStale !== undefined ? { detail: lock.value.brokeStale } : {}),
    });

    /** Everything below reports through here so the lock is always released. */
    const finish = (payload: Record<string, unknown>): string => {
      lock.value.release();
      return json({ ref: label, backend: ref.kind, dryRun: dry, steps, ...payload });
    };
    const failed = (step: string, reason: string, extra: Record<string, unknown> = {}): string => {
      steps.push({ step, ok: false, detail: reason });
      return finish({
        ok: false,
        failedAt: step,
        reason,
        oldValueStillInPlace: true,
        ...extra,
        note: UPSTREAM_NOTE,
      });
    };

    // A throw below would leave the lock file behind and wedge every later
    // rotation of this secret until the stale timeout breaks it. Nothing
    // below is expected to throw — every I/O path returns a named failure
    // instead — but "expected" is not a guarantee, and this is the tool that
    // can lock an operator out of their own service.
    try {
      // ── read the current value ──────────────────────────────────────────
      const current = await resolveOne(ref, runOptions);
      if (current.status === "error" || current.status === "unavailable") {
        return failed("read-current", `${current.reason} Nothing was written.`, {
          oldValueStillInPlace: true,
        });
      }
      if (current.status === "absent" && input.createIfAbsent !== true) {
        return failed(
          "read-current",
          `${label} does not exist yet (${current.reason}). Rotating something absent is creating it, which is a different decision — pass createIfAbsent if that is what you mean.`,
        );
      }
      const currentValue = current.status === "resolved" ? current.value : undefined;
      const beforeFingerprint = currentValue === undefined ? undefined : fingerprint(currentValue);
      steps.push({
        step: "read-current",
        ok: true,
        detail:
          currentValue === undefined
            ? "absent — this rotation creates it"
            : `resolved from ${current.source}`,
      });

      // ── interval guard ──────────────────────────────────────────────────
      // Every way this guard can fail to KNOW the answer is reported rather
      // than passed over: a rotation policy that silently stopped applying is
      // worse than one that refuses, because nobody finds out either way
      // until a credential has been rotated twice in an hour.
      const { journal, unreadable } = readJournal("SecretRotate");
      const previousRotation = lastRotation(journal.entries, label);
      let guardDetail: string;
      if (unreadable !== undefined) {
        // `minIntervalHours` is a policy the caller asked for, and a policy
        // that cannot be evaluated has not been satisfied. Waving the rotation
        // through with a note in a steps array is how a rotation policy stops
        // applying without anyone noticing — the note reads as a detail, and
        // the credential gets rotated twice in an hour. With no interval asked
        // for there is no policy to break, so that case still proceeds.
        if (input.minIntervalHours !== undefined) {
          return failed(
            "interval-guard",
            `you asked for at least ${input.minIntervalHours}h between rotations, but ${unreadable} — so whether that interval has passed cannot be established, and a guard that cannot be checked is not a guard. Nothing was written. Repair or remove the journal, or drop minIntervalHours to rotate anyway.`,
          );
        }
        guardDetail = `${unreadable}; treated as never rotated`;
      } else if (previousRotation === undefined) {
        guardDetail = "no previous rotation recorded";
      } else {
        const age = now() - Date.parse(previousRotation.rotatedAt);
        if (!Number.isFinite(age)) {
          // Same rule as an unreadable journal: an interval that cannot be
          // measured has not been met. The difference is that this entry
          // proves the secret HAS been rotated before, so waving it through
          // would be the exact double-rotation the caller asked to prevent.
          if (input.minIntervalHours !== undefined) {
            return failed(
              "interval-guard",
              `you asked for at least ${input.minIntervalHours}h between rotations, and ${label} has a recorded rotation whose time ("${previousRotation.rotatedAt}") is not a date this can read — so how long ago it was cannot be established. Nothing was written. Repair the entry in the journal, or drop minIntervalHours to rotate anyway.`,
            );
          }
          guardDetail = `the recorded rotation time ("${previousRotation.rotatedAt}") is not a date this can read, so the interval could not be checked; treated as never rotated`;
        } else if (
          input.minIntervalHours !== undefined &&
          age < input.minIntervalHours * 3_600_000
        ) {
          const hours = (age / 3_600_000).toFixed(1);
          return failed(
            "interval-guard",
            `${label} was rotated ${hours}h ago, less than the ${input.minIntervalHours}h you asked for. Nothing was written.`,
          );
        } else {
          guardDetail = `last rotated ${previousRotation.rotatedAt}`;
        }
      }
      steps.push({ step: "interval-guard", ok: true, detail: guardDetail });

      // ── the new value ───────────────────────────────────────────────────
      let newValue: string;
      if (input.generate !== undefined) {
        const bytes = randomBytes(input.generate.bytes);
        newValue = Buffer.from(bytes).toString(input.generate.encoding);
        steps.push({
          step: "new-value",
          ok: true,
          detail: `generated ${input.generate.bytes} random bytes as ${input.generate.encoding}`,
        });
      } else {
        const source = parseRef(input.newValueFrom as string);
        if (!source.ok) return failed("new-value", source.message);
        const resolution = await resolveOne(source.value, runOptions);
        if (resolution.status !== "resolved") {
          return failed(
            "new-value",
            `${formatRef(source.value)} did not resolve (${resolution.status}) — ${resolution.reason}. Nothing was written.`,
          );
        }
        newValue = resolution.value;
        steps.push({
          step: "new-value",
          ok: true,
          // `resolution.source` rather than the reference: with a bare name
          // the two differ, and which PLACE the new value came from is the
          // fact worth recording before a credential is replaced with it.
          detail: `read from ${resolution.source}${resolution.note !== undefined ? ` — ${resolution.note}` : ""}`,
        });
      }
      const afterFingerprint = fingerprint(newValue);
      if (beforeFingerprint === afterFingerprint) {
        return failed(
          "new-value",
          "the new value is identical to the current one. A rotation that changes nothing would report success while the old credential stayed live, so this stops instead.",
        );
      }

      // ── keep the previous value, BEFORE anything is replaced ────────────
      const keepRef = previousRef(ref);
      const wantKeep = input.keepPrevious !== false && currentValue !== undefined;
      let keptAs: string | undefined;
      if (wantKeep && keepRef === undefined) {
        steps.push({
          step: "keep-previous",
          ok: true,
          detail: `skipped: the ${ref.kind} backend has no place to keep a previous value that an operator would recognise later.`,
        });
      } else if (wantKeep && keepRef !== undefined) {
        const kept = await writeValue(keepRef, currentValue as string, { ...runOptions, dry });
        if (!kept.ok) {
          return failed(
            "keep-previous",
            `${kept.message} The current value was NOT replaced, so nothing is broken.`,
          );
        }
        keptAs = formatRef(keepRef);
        steps.push({
          step: "keep-previous",
          ok: true,
          detail: kept.detail,
          ...(dry ? { wouldRun: true } : {}),
        });
      }

      // ── write the new value ─────────────────────────────────────────────
      const written = await writeValue(ref, newValue, { ...runOptions, dry });
      if (!written.ok) {
        // "The write failed, so the old value is still there" is a GUESS, and
        // in the direction that stops anyone from checking. A credential
        // helper can store the value and still exit non-zero afterwards —
        // `pass insert` writes the entry and then git-commits it, and a failed
        // commit exits 1 with the new secret already in the store. Reporting
        // `oldValueStillInPlace: true` there tells an operator their service
        // is fine while it is already locked out. So the state is READ back
        // rather than asserted, and when the read cannot answer either, the
        // result says "unknown" instead of picking the comfortable one.
        const extra: Record<string, unknown> = {
          ...(keptAs !== undefined ? { previousKeptAs: keptAs } : {}),
        };
        let suffix = "";
        if (dry) {
          suffix = " Nothing was written (this was a dry run).";
        } else {
          const after = await resolveOne(ref, runOptions);
          if (after.status === "resolved" && fingerprint(after.value) === afterFingerprint) {
            extra["oldValueStillInPlace"] = false;
            extra["storedValueIsTheNewOne"] = true;
            extra["recovery"] =
              "the backend reported a failure but IS holding the new value, so whatever reads this secret is now using it. Either finish the rotation at the provider, or restore the previous value yourself.";
            suffix = ` A read-back shows the backend is holding the NEW value anyway, so the rotation may have half-taken: ${after.source}.`;
          } else if (
            after.status === "resolved" &&
            beforeFingerprint !== undefined &&
            fingerprint(after.value) === beforeFingerprint
          ) {
            extra["oldValueStillInPlace"] = true;
            suffix = " A read-back confirms the previous value is still in place.";
          } else if (after.status === "absent" && currentValue === undefined) {
            // This rotation was a create (`createIfAbsent`); the read-back says
            // it is still absent, so the failure left nothing behind.
            extra["oldValueStillInPlace"] = true;
            extra["nothingWasCreated"] = true;
            suffix = " A read-back confirms nothing was created.";
          } else if (after.status === "absent") {
            // The loudest case there is: the old value is gone and the new one
            // did not land. Saying "unknown" here would bury the one fact the
            // operator must act on right now.
            extra["oldValueStillInPlace"] = false;
            extra["secretIsNowAbsent"] = true;
            extra["recovery"] =
              keptAs !== undefined
                ? `the write failed and a read-back finds NOTHING at ${label} — whatever reads this secret has no value at all. The previous value was kept at ${keptAs}; restore it from there now.`
                : `the write failed and a read-back finds NOTHING at ${label} — whatever reads this secret has no value at all, and no copy was kept. Restore it from your own records; its fingerprint was ${beforeFingerprint}.`;
            suffix =
              " A read-back finds the secret ABSENT: the old value is gone and the new one did not land.";
          } else {
            extra["oldValueStillInPlace"] = "unknown";
            extra["recovery"] =
              `the write failed and reading the secret back did not settle what is stored now (${after.status}: ${reasonOf(after)}). Check ${label} with SecretLookup before anything else.`;
            suffix = " Reading it back did not settle what is stored now.";
          }
        }
        return failed("write-new", `${written.message}${suffix}`, extra);
      }
      steps.push({
        step: "write-new",
        ok: true,
        detail: written.detail,
        ...(dry ? { wouldRun: true } : {}),
      });

      // ── verify by READING IT BACK ───────────────────────────────────────
      if (dry) {
        steps.push({
          step: "verify",
          ok: true,
          wouldRun: true,
          detail: "would re-read the reference and compare its fingerprint to the new value's",
        });
        steps.push({
          step: "retire-previous",
          ok: true,
          wouldRun: true,
          detail:
            input.retirePrevious === true
              ? `would remove ${keptAs ?? "the previous copy"} once the new value verified`
              : "would keep the previous copy (retirePrevious was not set)",
        });
        return finish({
          ok: true,
          applied: false,
          fingerprint: {
            ...(beforeFingerprint !== undefined ? { before: beforeFingerprint } : {}),
            after: afterFingerprint,
          },
          ...(keptAs !== undefined ? { previousWouldBeKeptAs: keptAs } : {}),
          note: UPSTREAM_NOTE,
        });
      }

      const readBack = await resolveOne(ref, runOptions);
      const verified =
        readBack.status === "resolved" && fingerprint(readBack.value) === afterFingerprint;
      if (!verified) {
        // The new value did not take. Put the old one back through the same
        // write path, so the operator is left exactly where they started.
        let rolledBack = false;
        let rollbackDetail = "there was no previous value to restore (this was a create).";
        if (currentValue !== undefined) {
          const restored = await writeValue(ref, currentValue, { ...runOptions, dry: false });
          rolledBack = restored.ok;
          rollbackDetail = restored.ok
            ? `the previous value was written back (${restored.detail}).`
            : `the rollback ALSO failed: ${restored.message}`;
        }
        steps.push({ step: "verify", ok: false, detail: rollbackDetail });
        const why =
          readBack.status === "resolved"
            ? "it read back as a different value"
            : `it did not read back at all (${readBack.status}: ${readBack.reason})`;
        return finish({
          ok: false,
          failedAt: "verify",
          reason: `the new value was written but ${why}, so the rotation was not completed. ${rollbackDetail}`,
          rolledBack,
          oldValueStillInPlace: rolledBack || currentValue === undefined,
          ...(keptAs !== undefined ? { previousKeptAs: keptAs } : {}),
          ...(rolledBack || currentValue === undefined
            ? {}
            : {
                recovery: `the previous value is still in ${keptAs ?? "no kept copy — restore it from your own records"}; its fingerprint was ${beforeFingerprint}.`,
              }),
          note: UPSTREAM_NOTE,
        });
      }
      steps.push({ step: "verify", ok: true, detail: `read back from ${readBack.source}` });

      // ── record it, THEN retire the old copy ─────────────────────────────
      // The journal is written before the retirement so a failure there cannot
      // leave a rotated secret with no record of having been rotated — which
      // would let an interval guard wave through an immediate second rotation.
      const rotatedAt = new Date(now()).toISOString();
      let journalNote: string | undefined;
      try {
        appendJournal("SecretRotate", {
          ref: label,
          backend: ref.kind,
          rotatedAt,
          fingerprint: afterFingerprint,
          ...(beforeFingerprint !== undefined ? { previousFingerprint: beforeFingerprint } : {}),
        });
      } catch (err) {
        journalNote = `the rotation succeeded but the journal could not be updated: ${err instanceof Error ? err.message : String(err)}`;
      }
      steps.push({
        step: "record",
        ok: journalNote === undefined,
        ...(journalNote !== undefined
          ? { detail: journalNote }
          : { detail: `recorded at ${rotatedAt}` }),
      });

      if (input.retirePrevious === true && keepRef !== undefined) {
        const retired = await retirePrevious(keepRef, runOptions);
        steps.push({ step: "retire-previous", ok: retired.ok, detail: retired.detail });
      } else {
        steps.push({
          step: "retire-previous",
          ok: true,
          detail:
            keptAs === undefined
              ? "nothing to retire"
              : `${keptAs} was kept; pass retirePrevious once everything has picked the new value up`,
        });
      }

      return finish({
        ok: true,
        applied: true,
        rotatedAt,
        fingerprint: {
          ...(beforeFingerprint !== undefined ? { before: beforeFingerprint } : {}),
          after: afterFingerprint,
        },
        ...(keptAs !== undefined && input.retirePrevious !== true
          ? { previousKeptAs: keptAs }
          : {}),
        note: UPSTREAM_NOTE,
      });
    } catch (err) {
      lock.value.release();
      return `[SecretRotate error] the rotation stopped on an unexpected failure after the lock was taken: ${err instanceof Error ? err.message : String(err)}. Check the reference with SecretLookup before retrying — the steps that had already run are not reported, because the failure was not one of them.`;
    }
  },
});

/** Remove a kept previous value, once the new one has proven itself. */
async function retirePrevious(
  keepRef: SecretRef,
  options: { toolName: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{ ok: boolean; detail: string }> {
  if (keepRef.kind === "file") {
    try {
      const real = resolveSafe(options.toolName, keepRef.path).real;
      rmSync(real, { force: true });
      return { ok: true, detail: `removed ${keepRef.path}` };
    } catch (err) {
      return {
        ok: false,
        detail: `${keepRef.path} could not be removed: ${(err as Error).message}`,
      };
    }
  }
  if (keepRef.kind === "envfile") {
    const opened = readDocForEdit(options.toolName, keepRef.path);
    if (!opened.ok) return { ok: false, detail: opened.message };
    const { real, doc } = opened.value;
    const planned = planUnset(doc, keepRef.key);
    if (!planned.ok) return { ok: false, detail: planned.message };
    if (planned.value.how === "absent") return { ok: true, detail: "nothing to retire" };
    try {
      writeFileAtomic(real, renderEnvDoc(planned.value.doc));
      return { ok: true, detail: `commented out ${keepRef.key} in ${keepRef.path}` };
    } catch (err) {
      return { ok: false, detail: `${keepRef.path}: ${(err as Error).message}` };
    }
  }
  return { ok: false, detail: `nothing to retire for the ${keepRef.kind} backend` };
}

/** Everything this package registers, in one place for the catalog. */
export const SECRETS_TOOLS: readonly RegisteredTool[] = [
  secretLookup,
  envFileUpsert,
  secretRotate,
] as const;
