/**
 * FR-007 — sandboxed evaluation of untrusted verifier code.
 *
 * This module is the ONLY place candidate verifier code is compiled and
 * run. It is `tool-harness-synthesizer`'s trust boundary: `code` strings
 * are attacker-influenceable (caller seeds + refiner output), so they are
 * NEVER executed on this host. `runVerifierInSandbox` ships them to a
 * locked-down `@crewhaus/sandbox` container (`--network none`,
 * `--read-only`, no host env, cpu/mem caps, wall-clock kill,
 * `no-new-privileges`) and scores the returned verdicts on the host —
 * the container never receives the `expected` labels.
 *
 * The container runs `VERIFIER_HARNESS` (a fixed `node -e` script). The
 * untrusted `code` is delivered as STDIN DATA, never interpolated into
 * that script string — so it cannot break out of the harness.
 */
import type { Sandbox } from "@crewhaus/sandbox";
import { HarnessSynthesizerError, type VerifierSample } from "./index";

/** Sentinel that frames the harness's single JSON result line on stdout. */
export const VERIFIER_SENTINEL = "__CREWHAUS_VERIFIER__";

const VERIFIER_IMAGE = "node:22-alpine";
const DEFAULT_TIMEOUT_MS = 10_000;

/** Input/output pair handed to the verifier (labels stripped). */
type VerifierIO = { readonly input: unknown; readonly output: unknown };

/** Payload marshaled across the isolation boundary. */
type VerifierPayload = { readonly code: string; readonly samples: ReadonlyArray<VerifierIO> };

/** Per-sample result from inside the jail (or the in-process test double). */
export type VerifierEvalResult =
  | { readonly verdicts: ReadonlyArray<boolean>; readonly errors: number }
  | { readonly compileError: string };

/**
 * Compile `payload.code` and run it over `payload.samples`, collecting a
 * boolean verdict per sample. A compile failure returns `{ compileError }`;
 * a per-sample runtime throw is caught (verdict `false`, `errors++`).
 *
 * Single source of truth for verifier scoring: it runs both (a) inside the
 * container — `VERIFIER_HARNESS` embeds this function's own source via
 * `.toString()` — and (b) in unit tests via a fake sandbox. It MUST stay
 * self-contained: reference no imports or module scope, or the in-container
 * copy throws a ReferenceError.
 */
export function evalVerifierPayload(payload: VerifierPayload): VerifierEvalResult {
  let fn: (input: unknown, output: unknown) => unknown;
  try {
    fn = new Function("input", "output", String(payload.code)) as (
      input: unknown,
      output: unknown,
    ) => unknown;
  } catch (err) {
    return { compileError: err instanceof Error ? err.message : String(err) };
  }
  const verdicts: boolean[] = [];
  let errors = 0;
  const samples = payload.samples || [];
  for (let i = 0; i < samples.length; i++) {
    try {
      const s = samples[i] as VerifierIO;
      verdicts.push(Boolean(fn(s.input, s.output)));
    } catch {
      verdicts.push(false);
      errors++;
    }
  }
  return { verdicts, errors };
}

/**
 * The in-container harness (`node -e <this>`). Reads `{ code, samples }`
 * from stdin, runs `evalVerifierPayload` (embedded verbatim), and writes
 * `SENTINEL + JSON` once on stdout. Untrusted `code` is stdin DATA, never
 * part of this script.
 */
const VERIFIER_HARNESS = [
  '"use strict";',
  `const SENTINEL = ${JSON.stringify(VERIFIER_SENTINEL)};`,
  `const evalVerifierPayload = ${evalVerifierPayload.toString()};`,
  'let raw = "";',
  'try { raw = require("fs").readFileSync(0, "utf8"); } catch (e) { raw = ""; }',
  "let payload;",
  "try { payload = JSON.parse(raw); }",
  'catch (e) { process.stdout.write(SENTINEL + JSON.stringify({ compileError: "invalid harness payload" })); process.exit(0); }',
  "process.stdout.write(SENTINEL + JSON.stringify(evalVerifierPayload(payload)));",
].join("\n");

function parseHarnessResult(stdout: string): VerifierEvalResult | undefined {
  const idx = stdout.lastIndexOf(VERIFIER_SENTINEL);
  if (idx === -1) return undefined;
  const tail = stdout.slice(idx + VERIFIER_SENTINEL.length);
  const line = tail.split("\n", 1)[0] ?? "";
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof obj !== "object" || obj === null) return undefined;
  if (
    "compileError" in obj &&
    typeof (obj as { compileError: unknown }).compileError === "string"
  ) {
    return { compileError: (obj as { compileError: string }).compileError };
  }
  const rec = obj as { verdicts?: unknown; errors?: unknown };
  if (Array.isArray(rec.verdicts)) {
    return {
      verdicts: rec.verdicts.map((v) => Boolean(v)),
      errors: typeof rec.errors === "number" ? rec.errors : 0,
    };
  }
  return undefined;
}

/**
 * Marshal `{ code, samples }` (labels stripped) into the jail, run the
 * harness, parse the framed result, and score verdicts against the
 * host-held `expected` labels.
 *
 * Throws `HarnessSynthesizerError` on: non-serializable samples, compile
 * failure, timeout, non-zero harness exit, or unparseable output. Caught
 * per-sample runtime errors are reflected in `errors` (not thrown).
 */
export async function runVerifierInSandbox(
  sandbox: Sandbox,
  code: string,
  samples: ReadonlyArray<VerifierSample>,
  opts: { readonly timeoutMs?: number; readonly image?: string } = {},
): Promise<{
  readonly verdicts: ReadonlyArray<boolean>;
  readonly heuristic: number;
  readonly errors: number;
}> {
  // Strip `expected` — the jail produces verdicts; the host scores them.
  const payload: VerifierPayload = {
    code,
    samples: samples.map((s) => ({ input: s.input, output: s.output })),
  };
  let stdin: string;
  try {
    // JSON.stringify throws on BigInt and circular references — surface
    // that as a clear error rather than shipping a broken payload.
    stdin = JSON.stringify(payload);
  } catch (err) {
    throw new HarnessSynthesizerError(
      `verifier samples are not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = await sandbox.exec({
    image: opts.image ?? VERIFIER_IMAGE,
    argv: ["node", "-e", VERIFIER_HARNESS],
    stdin,
    timeoutMs,
  });

  if (result.timedOut) {
    throw new HarnessSynthesizerError(`verifier evaluation timed out after ${timeoutMs}ms`);
  }
  const parsed = parseHarnessResult(result.stdout);
  if (parsed === undefined) {
    if (result.exitCode !== 0) {
      throw new HarnessSynthesizerError(
        `verifier harness exited ${result.exitCode}: ${result.stderr.slice(-500)}`,
      );
    }
    throw new HarnessSynthesizerError("verifier harness produced no result");
  }
  if ("compileError" in parsed) {
    throw new HarnessSynthesizerError(`verifier code did not compile: ${parsed.compileError}`);
  }
  if (parsed.verdicts.length !== samples.length) {
    throw new HarnessSynthesizerError(
      `verifier harness returned ${parsed.verdicts.length} verdicts for ${samples.length} samples`,
    );
  }

  let correct = 0;
  const verdicts: boolean[] = [];
  for (let i = 0; i < samples.length; i++) {
    const v = parsed.verdicts[i] === true;
    verdicts.push(v);
    if (v === (samples[i] as VerifierSample).expected) correct++;
  }
  const heuristic = samples.length === 0 ? 0 : correct / samples.length;
  return { verdicts, heuristic, errors: parsed.errors };
}
