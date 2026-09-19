/**
 * Resolution: taking a reference and finding out whether it leads to a secret.
 *
 * Every backend answers in the same four-way shape (`resolved` / `absent` /
 * `unavailable` / `error`, see `./backends`) so a caller can act on the answer
 * without knowing which store it came from.
 *
 * The value rides home in `Resolution.value`. It exists so the tools can
 * fingerprint it, verify a rotation against it and write it into a file — and
 * for nothing else. It is never spread into a result object, and the test
 * suite scans every string these tools return for the fixture secrets to keep
 * that true after the next edit.
 *
 * The bare-name chain deserves its own note. `SLACK_TOKEN` with no scheme
 * means "wherever this harness would actually get it", which is the
 * environment first, then `.env.local`, then `.env`, then the on-disk secrets
 * directory — the precedence `@crewhaus/harness-supervisor` documents for the
 * spawn environment. Every step is checked even after one answers, because the
 * interesting bug is not "it is missing", it is "it is defined in three places
 * with two different values and the one you are editing is not the one that
 * wins". That is reported as `shadowedBy`/`alsoDefinedIn` with fingerprints,
 * which says the values differ without saying what either of them is.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ENV_FILENAMES } from "@crewhaus/harness-supervisor";
import { resolveSafe } from "../paths";
import { type BackendOutcome, classify } from "./backends";
import { decodeAssignment, liveAssignments, parseEnvDoc } from "./envfile";
import { type SecretRef, formatRef, readArgv } from "./refs";
import { type CommandOptions, runCommand } from "./run";

/** Where the on-disk file backend keeps a bare-named secret. */
export const SECRETS_DIR = ".crewhaus/secrets";

export type Resolution = BackendOutcome & {
  /** Human-readable place the answer came from. Never contains a value. */
  readonly source: string;
  /**
   * Something the caller should hear about the resolution itself — today,
   * only that a bare name is defined in more than one place with more than
   * one value. Never contains a value; the fingerprints are what say they
   * differ.
   */
  readonly note?: string;
};

let envSource: () => Record<string, string | undefined> = () => process.env;

/**
 * Test seam for the environment backend. Mutating `process.env` in a test
 * leaks into every other test in the same bun process — including a test
 * asserting that a name is NOT set — so the suite swaps the source instead.
 */
export function _setEnv(source: Record<string, string | undefined> | undefined): void {
  envSource = source === undefined ? () => process.env : () => source;
}

function readFileValue(toolName: string, path: string): Resolution {
  let real: string;
  try {
    real = resolveSafe(toolName, path).real;
  } catch {
    return {
      status: "error",
      reason: `the path "${path}" resolves outside the workspace root, so it was not read. Secrets are read from inside the workspace only.`,
      source: path,
    };
  }
  try {
    const stat = statSync(real);
    if (stat.isDirectory()) {
      return { status: "error", reason: `"${path}" is a directory.`, source: path };
    }
  } catch (err) {
    // ENOENT — and only ENOENT — means the secret is not there. Every other
    // errno means the question could not be ANSWERED: EACCES is a directory
    // this process may not traverse, ENOTDIR is a path with a file in the
    // middle of it, ELOOP is a symlink cycle, EIO is a disk. Reporting any of
    // them as "does not exist" is the lie this package exists to avoid: it
    // sends an operator off to re-create a secret that is sitting right there,
    // and it lets SecretRotate's `createIfAbsent` treat an unreadable existing
    // credential as a create — which skips keep-previous and overwrites it
    // with no copy of the old value anywhere.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { status: "absent", reason: `"${path}" does not exist.`, source: path };
    }
    return {
      status: "error",
      reason:
        code === "ENOTDIR"
          ? `"${path}" cannot be read: something on the way to it is a file, not a directory. Nothing is known about whether the secret exists.`
          : `"${path}" could not be examined (${code ?? "unknown error"}), so whether it exists is unknown — this is NOT the same as the secret being absent.`,
      source: path,
    };
  }
  try {
    return { status: "resolved", value: readFileSync(real, "utf8"), source: path };
  } catch (err) {
    return {
      status: "error",
      reason: `"${path}" could not be read: ${err instanceof Error ? err.message : String(err)}`,
      source: path,
    };
  }
}

/**
 * One `.env` key. The LAST live assignment wins, because that is what the
 * reader does with a duplicate; the count is reported so a caller can see
 * that the file disagrees with itself.
 */
function readEnvFileValue(
  toolName: string,
  path: string,
  key: string,
): Resolution & { readonly duplicates?: number } {
  const file = readFileValue(toolName, path);
  if (file.status !== "resolved") {
    return file.status === "absent"
      ? { status: "absent", reason: `"${path}" does not exist.`, source: `${path}#${key}` }
      : { ...file, source: `${path}#${key}` };
  }
  const doc = parseEnvDoc(file.value);
  const live = liveAssignments(doc, key);
  if (live.length === 0) {
    return {
      status: "absent",
      reason: `"${path}" does not assign ${key}.`,
      source: `${path}#${key}`,
    };
  }
  const last = live[live.length - 1] as number;
  const raw = doc.lines[last]?.raw ?? "";
  const value = decodeAssignment(raw) ?? "";
  return {
    status: "resolved",
    value,
    source: `${path} line ${last + 1}`,
    ...(live.length > 1 ? { duplicates: live.length } : {}),
  };
}

export type ResolveOptions = {
  readonly toolName: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

/**
 * Resolve one reference.
 *
 * A bare name walks the whole chain here too, not just the environment. That
 * matters beyond `SecretLookup`: `EnvFileUpsert`'s `valueFrom` and
 * `SecretRotate`'s `newValueFrom` come through this function, and a bare name
 * that quietly meant "the environment only" in one tool and "the chain" in
 * another would resolve to two different secrets depending on which tool the
 * caller reached for.
 */
export async function resolveOne(ref: SecretRef, options: ResolveOptions): Promise<Resolution> {
  switch (ref.kind) {
    case "auto":
      return resolveAuto(ref.name, options);
    case "env": {
      const value = envSource()[ref.name];
      return value === undefined
        ? {
            status: "absent",
            reason: `the environment variable ${ref.name} is not set in this process.`,
            source: "the environment",
          }
        : { status: "resolved", value, source: "the environment" };
    }
    case "file":
      return readFileValue(options.toolName, ref.path);
    case "envfile":
      return readEnvFileValue(options.toolName, ref.path, ref.key);
    default: {
      const argv = readArgv(ref);
      if (argv === undefined) {
        return {
          status: "error",
          reason: "no read command for this backend.",
          source: formatRef(ref),
        };
      }
      const run = await runCommand(argv, {
        timeoutMs: options.timeoutMs,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      } satisfies CommandOptions);
      return { ...classify(ref, run), source: `\`${argv.join(" ")}\`` };
    }
  }
}

/** One step of the bare-name chain, with the reference that names it. */
export type ChainStep = {
  readonly ref: SecretRef;
  readonly resolution: Resolution;
};

/**
 * The local chain for a bare name, HIGHEST precedence first.
 *
 * `ENV_FILENAMES` is `@crewhaus/harness-supervisor`'s own list, imported
 * rather than restated so this package cannot drift from the chain the
 * harness actually spawns with. It is ordered lowest-precedence-first there,
 * so it is reversed here.
 */
export function chainRefs(name: string): SecretRef[] {
  const files = [...ENV_FILENAMES].reverse();
  return [
    { kind: "env", name },
    ...files.map((file): SecretRef => ({ kind: "envfile", path: file, key: name })),
    { kind: "file", path: join(SECRETS_DIR, name) },
  ];
}

/** Walk the whole chain. Every step is probed, not just the winning one. */
export async function resolveChain(name: string, options: ResolveOptions): Promise<ChainStep[]> {
  const steps: ChainStep[] = [];
  for (const ref of chainRefs(name)) {
    steps.push({ ref, resolution: await resolveOne(ref, options) });
  }
  return steps;
}

/**
 * The winner of the chain, with a note when the losers disagree with it.
 *
 * The note is what a caller writing the value somewhere else needs: it means
 * "the file you are about to read from is not the one this harness will use".
 * It names places and fingerprints, never values.
 */
async function resolveAuto(name: string, options: ResolveOptions): Promise<Resolution> {
  const steps = await resolveChain(name, options);
  const found = steps.filter(
    (step): step is ChainStep & { resolution: { status: "resolved"; value: string } } =>
      step.resolution.status === "resolved",
  );
  const winner = found[0];
  if (winner === undefined) {
    const failure = steps.find((step) => step.resolution.status === "error");
    if (failure !== undefined) return failure.resolution;
    return {
      status: "absent",
      reason: `${name} is not set in the environment, in any .env file, or in ${SECRETS_DIR}.`,
      source: `the local chain (${steps.map((step) => formatRef(step.ref)).join(", ")})`,
    };
  }
  const disagreeing = found
    .slice(1)
    .filter((step) => step.resolution.value !== winner.resolution.value);
  // A step that OUTRANKS the winner and could not be read is not a step that
  // said "no". It may hold a different value, and if it does, that value — not
  // this one — is what the harness will use. Dropping it because something
  // further down the chain answered turns "I could not check the place that
  // wins" into a confident report about the place that lost.
  const blockedAbove = steps
    .slice(0, steps.indexOf(winner))
    .filter(
      (step) => step.resolution.status === "error" || step.resolution.status === "unavailable",
    );
  const notes: string[] = [];
  if (disagreeing.length > 0) {
    notes.push(
      `${name} is also defined, with a different value, in ${disagreeing
        .map((step) => formatRef(step.ref))
        .join(" and ")}. ${winner.resolution.source} is the one that wins.`,
    );
  }
  if (blockedAbove.length > 0) {
    notes.push(
      `${blockedAbove
        .map((step) => `${formatRef(step.ref)} (${reasonOf(step.resolution)})`)
        .join(
          " and ",
        )} outranks ${winner.resolution.source} and could not be checked, so this value is only the one that wins if those hold nothing.`,
    );
  }
  return {
    status: "resolved",
    value: winner.resolution.value,
    source: winner.resolution.source,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
}

/** A failed resolution's reason, narrowed in one place. */
export function reasonOf(resolution: Resolution): string {
  return resolution.status === "resolved" ? "" : resolution.reason;
}
