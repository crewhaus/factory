/**
 * M3 · CREDENTIALS — the per-harness `.env` editor, the fleet credential
 * matrix, set-across, doctor, the secrets backend, and the MCP config lint.
 *
 * STUBS. Owned by the Creds+Channels+Security implementer together with
 * `channels-ops.ts` and `security-ops.ts`.
 *
 * ---------------------------------------------------------------------------
 * VALUES ARE WRITE-ONLY. THIS IS THE WHOLE MODULE.
 * ---------------------------------------------------------------------------
 * A credential value may enter through a request body and reach
 * `upsertEnvVar`. It may NEVER:
 *   - come back in a response (routes emit KEY PRESENCE BOOLEANS only),
 *   - be stored in manager state (no cache, no registry field, no log line),
 *   - appear in a URL, a query string, or a path segment,
 *   - be echoed in an error message.
 * `upsertEnvVar` is the only writer: it enforces 0600, preserves comments and
 * ordering, and understands the `# NAME=` stub grammar that "unset" produces.
 * There is no delete — an unset key becomes a commented stub, so the required
 * name stays visible.
 *
 * The REQUIRED SET is not a guess: it is the union the doctor checks compute
 * — `agent.model`, model-pool candidates, fallbacks, tiers, judge models,
 * channel secret refs, and MCP env-refs. Cell states are set / missing /
 * commented-stub / informational (bedrock and local chains authenticate
 * through ambient credential chains, so "missing" there is not a failure).
 *
 * Anthropic precedence must be shown, not implied: `AUTH_TOKEN` beats
 * `API_KEY`, and an `sk-ant-oat*` value is an OAuth token — `resolveAuth` is
 * the authority. `doctor --probe` classifies auth-vs-BILLING failures, which
 * is the difference between "wrong key" and "add credits"; `--fix` only ever
 * APPENDS stubs.
 *
 * SET-ACROSS is the most dangerous affordance in the manager: one typed
 * value written into N harnesses' `.env` files. It is typed-confirm, it
 * writes each harness through that harness's own `upsertEnvVar`, it reports
 * per-harness success/failure, and it keeps NOTHING. Rotation is the same
 * shape.
 *
 * Implementation needs `@crewhaus/secrets-manager` added to this package's
 * dependencies + tsconfig references; `@crewhaus/preflight` (doctor checks,
 * `envRefPresence`) is already there. The `.env` reader/merger already
 * exists in this package as `env-file.ts` — reuse it, do not re-parse.
 */
import type { M3Handler } from "./m3";
import { notImplemented } from "./m3";

/**
 * `GET /api/h/:id/env` — the per-harness credential picture.
 *
 * Every required KEY with its presence state (set / missing /
 * commented-stub / informational), which `.env` file in the precedence chain
 * supplies it, and where each requirement came from (model, pool, channel,
 * MCP). NO VALUES.
 */
export const env: M3Handler = () => notImplemented("env presence");

/**
 * `POST /api/h/:id/env` — set one key.
 *
 * Body: `{ key, value }`. Written through `upsertEnvVar` (0600, comments and
 * order preserved). The response re-reads PRESENCE only; the value is gone
 * from the process the moment the write returns.
 */
export const envSet: M3Handler = () => notImplemented("env set");

/**
 * `DELETE /api/h/:id/env/:key` — unset one key.
 *
 * Rewrites the line as a `# KEY=` stub rather than removing it, so the
 * requirement stays visible and the next doctor run still names it.
 */
export const envUnset: M3Handler = () => notImplemented("env unset");

/**
 * `GET /api/credentials` — the fleet matrix (fleet-wide).
 *
 * Harness × credential-NAME grid, values never involved. Rows come from each
 * harness's required-set union; cells carry the four states. This is the
 * screen that answers "which harnesses are one key away from running".
 */
export const credentialsMatrix: M3Handler = () => notImplemented("fleet credentials matrix");

/**
 * `POST /api/credentials/set` — set one key across selected harnesses.
 *
 * Body: `{ key, value, harnessIds[], confirmName }`. TYPED-CONFIRM (the
 * operator echoes a name the server verifies). Writes each harness's own
 * `.env` through its own `upsertEnvVar`; reports per-harness outcomes;
 * stores nothing. A partial failure must be reported per harness, never
 * collapsed into one "failed".
 */
export const credentialsSetAcross: M3Handler = () => notImplemented("set credential across fleet");

/**
 * `GET /api/h/:id/doctor` — the last doctor picture.
 *
 * The offline checks plus the last `--probe` classification if one was run.
 * Anthropic precedence (`AUTH_TOKEN` > `API_KEY`, `sk-ant-oat*` = OAuth) is
 * shown explicitly through `resolveAuth`.
 */
export const doctor: M3Handler = () => notImplemented("doctor report");

/**
 * `POST /api/h/:id/doctor` — run `crewhaus doctor`.
 *
 * Body: `{ probe?, fix? }` through the job queue. `--probe` costs a real
 * provider call, so it is opt-in; `--fix` only appends stubs and must say so
 * before running.
 */
export const doctorRun: M3Handler = () => notImplemented("doctor run");

/**
 * `GET /api/h/:id/secrets` — the secrets backend.
 *
 * `.crewhaus/secrets/` file-backend NAMES and metadata (created, last
 * rotated, which subscribers registered `onRotation`). Names only.
 */
export const secrets: M3Handler = () => notImplemented("secrets backend");

/** `GET /api/h/:id/secrets/doctor` — `secrets doctor`: backend reachability
 *  and the names a running harness expects but cannot resolve. */
export const secretsDoctor: M3Handler = () => notImplemented("secrets doctor");

/**
 * `POST /api/h/:id/secrets/:name/rotate` — rotate one secret.
 *
 * Body: `{ value, confirmName }`. Through `@crewhaus/secrets-manager`'s
 * `rotate` specifically — that is what fires `onRotation`, so subscribers
 * refresh WITHOUT a daemon restart. Writing the file directly would leave a
 * running daemon holding the old value.
 */
export const secretsRotate: M3Handler = () => notImplemented("secret rotate");

/**
 * `GET /api/h/:id/mcp/lint` — the MCP config linter.
 *
 * A `resolveMcpServerConfig` dry run that flags: literal `$FOO`/`${FOO}` in
 * an MCP `env:` map (which NEVER expands — a predicted boot `ConfigError`),
 * env-refs unset in this harness's environment, and credential-shaped
 * literals in the spec. Findings are masked before they are served: a
 * finding QUOTES the offending literal.
 */
export const mcpLint: M3Handler = () => notImplemented("mcp config lint");
