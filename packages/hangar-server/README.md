# @crewhaus/hangar-server

The Hangar manager's local HTTP server: one loopback `Bun.serve` over the
machine-wide harness registry. A library — `startHangarServer(opts)` boots
it; the `crewhaus hangar` CLI verb wires ports, embedded UI assets, and
lifecycle around it.

M1 was read-only over harness state (registry CRUD was the only write).
**M2 makes the console a driver**, and every new surface is a composition
of a layer that already exists rather than a second implementation of it:

| Surface | Composed from |
|---|---|
| start / stop / restart / drain, the run ledger, the live SSE feed | `@crewhaus/harness-supervisor` (one supervisor per harness; preflight gates every spawn) |
| wake / drain / status, the four-lane timeline's *phase* | `crewhaus.control.v1` (`@crewhaus/gateway-protocol/control`) |
| the approvals inbox | `@crewhaus/session-store`'s `PendingApprovalStore` |
| the review queue | `@crewhaus/feedback-distill` + the adjudicating `FeedbackRecord` path `crewhaus rate --adjudicate` uses |
| eval baseline re-pin | `@crewhaus/eval-report`'s `setBaseline` |
| session pinning | `.crewhaus/retention.json` (validated with the enforcers' own loader) |

**One state tree, two heads.** Everything the console drives lives under
`<harness>/.crewhaus/run/`, so `crewhaus daemon start|stop|…` and the
console are two views of the same state: a daemon either started is adopted
by the other, and neither needs the other running.

## Safety model (enforced + regression-tested)

- **Auth** — every `/api` route requires `Authorization: Bearer <token>`
  (constant-time compare over sha256 digests). The token comes from
  `opts.token` or is minted at boot to `<hangarRoot>/token` (0600;
  hangar root defaults to `~/.crewhaus/hangar`). `/healthz` and the
  static UI shell are the only unauthenticated surfaces. No cookies
  anywhere, so there is no CSRF surface. `noAuth` disables the check with
  a logged warning (trusted localhost dev only).
- **Path safety** — `:id` params are validated against their format
  regexes (`hrn_…`, `sess_…`, `run_…`, safe-segment) before any
  filesystem work, and every harness-relative read must realpath-contain
  inside that harness's registered dir (the registry is the allowlist;
  symlink escapes are refused). Arbitrary absolute dirs enter only via
  `POST /api/harnesses` bodies.
- **Reads never mutate** — session browsing is raw directory scans plus
  tolerant JSONL parsing, never `SessionStore.list()` (whose TTL eviction
  deletes expired transcripts as a side-effect). The approvals inbox folds
  `approvals.jsonl` for the same reason: `PendingApprovalStore.list()`
  COMPACTS the file, and a polled inbox must not rewrite an operator's
  ledger. Regression tests browse both repeatedly and assert every file
  survives byte-identical.
- **Credentials never render** — env handling reports KEY presence
  booleans only; the spec view masks credential values (spec-patch
  `isCredentialKey`/`maskCredentialTokens`); transcripts, preflight
  reports, and eval artifacts pass the same maskers. A test plants a
  fake-shaped key (built from string parts) in a fixture `.env` + spec and
  asserts the byte sequence never appears in any response body.
- **The control bearer stays server-side** — it is read from
  `<harness>/.crewhaus/run/control-token` (0600) per call and is never part
  of any payload. Per call, not cached: a daemon mints a fresh token every
  boot, so a cached one 401s against its own replacement.
- **Captured output is served scrubbed** — `logs/<runId>.log` is raw by
  construction (the scrubber sits on the pump, once, on the way out), so
  history comes from `replayRunEvents()` and `readLogTail(file, scrub)` and
  the live feed from `supervisor.subscribe()`. No route reads that file.
- **A request body never becomes a command line** — job argv is built from
  a closed vocabulary (`jobArgv(kind, options)`) with every interpolated
  value shape-checked; there is no free-form argv parameter.
- **Torn-line tolerance + caps** — every JSONL reader skips unparseable
  lines and caps both lines (`MAX_JSONL_LINES`) and bytes
  (`MAX_JSONL_BYTES`) read; truncation is reported, never hidden.

## Caching

Expensive fleet rollups (`lastEval`, session/feedback counts, 7-day spend,
cost breakdown) live in `<hangarRoot>/cache/<hrnId>.json`, keyed by a
digest of the source files' names + mtimes + sizes — a digest check stats
directories but reads no transcript, so `GET /api/harnesses` answers from
cache without walking session JSONLs when nothing changed. Digest
mismatch recomputes lazily (`?hydrate=1` forces it); cached figures carry
their honest `cachedAt`. The cache is rebuildable and never
authoritative: deleting the cache directory is always safe.

## Routes

```
GET  /healthz                              GET  /api/version
GET  /api/harnesses[?hydrate=1]            POST /api/harnesses {dir}
GET|POST|PUT|DELETE /api/registry/groups   GET|POST|DELETE /api/registry/scan-roots
POST /api/scan                             GET  /api/costs
GET|DELETE /api/h/:id                      POST /api/h/:id/relocate {newDir}
PUT  /api/h/:id/{groups,tags,pin,notes}
GET  /api/h/:id/{spec,preflight,costs}
GET  /api/h/:id/sessions[/:sess[?raw=1]]   POST /api/h/:id/sessions/:sess/pin {pinned}
GET  /api/h/:id/evals[/:runId[/:sampleId]] POST /api/h/:id/evals/baseline {runId}
GET  /api/h/:id/memory/{facts,wiki[/:slug],state,dream,watchme}

# M2 — the process layer
GET  /api/h/:id/proc                       POST /api/h/:id/proc/{start,stop,restart,drain}
GET  /api/h/:id/runs[/:runId]              GET  /api/h/:id/runs/:runId/events   (SSE)
GET  /api/h/:id/control/status             POST /api/h/:id/control/{wake,drain}
GET  /api/h/:id/{schedulers,deployments}
GET  /api/approvals[?all=1]                POST /api/h/:id/approvals/:apprId/{grant,deny}
GET  /api/review[?all=1]                   POST /api/h/:id/review/:itemId {verdict}
GET  /api/activity[?since=]                GET  /api/jobs   POST /api/h/:id/jobs {kind}
```

Absence is not an error: missing state renders as "nothing yet" shapes,
and a vanished harness dir keeps its registry row (`missingSince`) with a
relocate/remove affordance instead of disappearing.

### Degradation is typed, not exceptional

`POST /proc/start` answers `409` with the typed preflight refusal instead
of spawning, and every blocking item says whether it is `acknowledgeable`
— missing channel secrets are not, because the compiled daemon's own boot
gate exits 2 on exactly that set. `409 plan-failed` carries the `remedy`
(`compile` / `add-spec` / `install-cli`) the UI turns into a button.

`POST /proc/{stop,drain}` answer `409 not-adopted` when a runfile says a
daemon IS running but this manager could not adopt it. "I signalled
nothing and the daemon is still there" and "the daemon is gone" are
opposite facts, and the console renders `{ok:true, stopped:true}`
identically for both — so the honest refusal is its own status.

The control routes ALWAYS answer `200` with an envelope, because the UI
needs the reason text in the refused cases just as much as in the happy
one:

| `code` | Means | `expected` | `retryable` |
|---|---|---|---|
| `no_control_port` | pre-0.5.0 bundle, or not running | ✔ | |
| `lane_not_armed` | that spec armed no such lane | ✔ | |
| `draining` | going away — do not retry | ✔ | |
| `tick_in_flight` | a tick is running | | ✔ |
| `unauthorized` / `unreachable` / `error` | a real fault | | |

`expected: true` means *render the control disabled-with-reason*, not
*show an error*. The four-lane timeline follows the same rule: cadence is
read off the spec (offline-knowable), while `lastFiredAt`/`nextDueAt`
appear only when control answers — the phase of an in-process timer is
knowable ONLY inside the process that armed it, which is why control.v1
exists at all.

`GET /api/h/:id/deployments` (F-6) is read-only and honestly empty:
nothing writes `.crewhaus/deployments.json` yet, and inventing a writer
here would make the manager the source of truth for a fact it does not
observe.

Each `/api/harnesses` row carries the registry fields plus flattened
`capabilities` (lenient spec-badge scan), `evalHealthy` (latest run vs the
pinned baseline) and `cachedAt`, alongside the nested `rollup` (null until
hydrated). Cost folds include a zero-filled trailing-7-day `days` series;
the detail payload includes small `memory: { facts, articles }` counts for
the Overview mini-cards. The whole surface is CONTRACT-TESTED against the
console's route map: `src/contract.test.ts` imports hangar-ui's
`assets/js/routes.js` and drives every route on a fixture server —
writes must take effect, reads must carry every field the UI views read
(the test's `VIEW_READS` table).

## Library use

```ts
import { startHangarServer } from "@crewhaus/hangar-server";

const server = startHangarServer({ port: 4200 });
console.log(`${server.url}/#t=${server.token}`); // token travels as a URL fragment
await server.stop();
```

Options cover the bind host/port, hangar root, registry root, explicit
token / `noAuth`, prebuilt static `assets` (the CLI injects the embedded
UI; absent assets get a minimal built-in index page), an injectable
`env`/`now`/`onWarn` for tests, the reported `version`, and — for M2 — an
injectable `processLayer` and `controlClient`.

`server.ready` resolves once the boot sequence has run: **open the port
ledger → `adopt()` every registered harness with a runfile →
`jobQueue.restore()`**. Restore is last on purpose, so a job that was
*running* when the previous manager died is closed as `interrupted`
against an already-accurate process picture — never silently re-run.
`Bun.serve` binds synchronously, so the socket is live either way.

Boot adoption is not the whole story: it only sees the daemons that
existed at that instant. Every request that touches a harness's process
state calls `supervisor.adoptIfRunfile()` first — a no-op unless a runfile
exists and the supervisor holds no pid — so a daemon started from a
terminal (or one belonging to a harness registered after boot) is picked
up rather than reported `stopped` over its own live runfile.

The live run feed is an SSE stream over a daemon that is *supposed* to be
quiet, so two settings keep it open: the server binds with an explicit
`idleTimeout` (Bun's 10 s default severs a `heartbeat: every 60s` console
mid-watch) and the stream emits a `: ping` comment frame on a timer. The
feed stays open for `starting`/`running`/`draining` — a drain can take the
whole stop grace, which is exactly when an operator asks to watch.

`server.stop()` releases timers and subscriptions but deliberately leaves
the CHILDREN alone: a detached daemon outliving its manager is the whole
point of the runfile, and the next boot adopts it.

## Testing

`src/testkit.ts` boots an isolated server per test over a temp workspace,
with the process layer wired to a fake `ProcessOps` + fake clock — so
start/stop/restart/drain drive the REAL supervision state machine without
spawning anything. `startStubControlPlane()` serves the genuine
`crewhaus.control.v1` wire contract (including the 404/409 cases) on a
loopback port, so the proxy is tested against the responses a daemon
actually sends. Real spawns stay in `@crewhaus/harness-supervisor`'s own
suite, where four tiny fixture scripts cover what a fake cannot prove.
