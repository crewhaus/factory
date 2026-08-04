# @crewhaus/hangar-server

The Hangar manager's local HTTP server: one loopback `Bun.serve` over the
machine-wide harness registry. A library — `startHangarServer(opts)` boots
it; the `crewhaus hangar` CLI verb wires ports, embedded UI assets, and
lifecycle around it.

M1 was read-only over harness state (registry CRUD was the only write).
**M2 makes the console a driver**, and every new surface is a composition
of a layer that already exists rather than a second implementation of it.
**M3 adds the detail surface** — the spec's write side, the memory fabric's
write side, the eval/dataset/feedback loops, credentials + channels +
security, Thredz, and the raw inspectors — over routes, guards and client
wrappers that were frozen ahead of its handlers (see *M3* under Routes):

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

### M3 — the detail surface

M3 is the tab-level detail behind every M2 screen. **Its contract was frozen
before its handlers were written** — routes, guards, masking and client
wrappers first — which is what let the six areas be implemented in parallel
without colliding; the contract test drives each route against a live fixture
server and demands the fields its view dereferences.

Every route below is implemented, with ONE deliberate exception: `POST
/api/h/:id/secrets/:name/rotate` still answers `501 not implemented (M3)`,
because cross-harness rotation needs `@crewhaus/secrets-manager`, which this
package does not depend on. It says so in its own refusal.

```
# spec — structured editing, trust tiers, versions, builders
PUT  /api/h/:id/spec                       POST /api/h/:id/spec/{patch,diff,pin,rollback,propose}
GET  /api/h/:id/spec/{schema,trust,versions[/:version[/diff]]}
GET  /api/builders/{templates,mcp-catalog} POST /api/builders/spec
GET|POST /api/h/:id/builders/{graders,dataset,mcp}   DELETE /api/h/:id/builders/mcp/:name

# memory — facts, continuity, wiki, watchme, learning, knowledge
GET  /api/h/:id/memory/facts/:spec         POST /api/h/:id/memory/facts/:spec/{forget,sweep}
POST /api/h/:id/memory/{recall,migrate}    GET  /api/h/:id/memory/{learning,knowledge,reflect}
GET  /api/h/:id/memory/continuity[/trash]  POST /api/h/:id/memory/continuity/restore
POST /api/h/:id/memory/knowledge/sync      GET  /api/h/:id/memory/dream/scaffold
PUT  /api/h/:id/memory/wiki/:slug          GET  /api/h/:id/memory/wiki/:slug/{versions[/:version],links}
POST /api/h/:id/memory/wiki/:slug/{signals,archive}
GET  /api/h/:id/memory/watchme/{analytics,reports[/:stamp],intents,synthesized}
POST /api/h/:id/memory/watchme/{toggle,publish,synthesized/:stamp/apply}

# evals — the quality lab
POST /api/h/:id/evals/{run,suites,plan,judge,redteam,sentinel,optimize,flywheel,experiments}
GET  /api/h/:id/evals/{matrix[/:cell],suites,trends,judge,graders,coverage,sentinel,voice}
GET  /api/h/:id/evals/{optimize[/:optRunId],flywheel,experiments,annotations}
POST /api/h/:id/evals/graders/{suggest,test}
POST /api/h/:id/evals/:runId/:sampleId/annotate

# data — the dataset registry, hygiene, growth (the NAME travels in the body)
GET  /api/h/:id/data/{datasets[/:name],status,quarantine}
POST /api/h/:id/data/{verify,audit,lint,mine,synthesize,refresh-goldens}

# feedback — the growth loops
GET  /api/h/:id/feedback[/{fewshot,faq,lessons,advice,reactions}]   GET /api/feedback
POST /api/h/:id/feedback/{distill,fewshot,faq,lessons,advice[/:adviceId/apply]}

# creds / channels / security
GET|POST /api/h/:id/env    DELETE /api/h/:id/env/:key
GET  /api/credentials      POST /api/credentials/set
GET|POST /api/h/:id/doctor GET /api/h/:id/secrets[/doctor]  POST /api/h/:id/secrets/:name/rotate
GET  /api/h/:id/mcp/lint   GET  /api/h/:id/{channels,gateway,audit,slo}
POST /api/h/:id/channels/verify  GET|POST /api/h/:id/channels/:channel/provision
POST /api/h/:id/channels/:channel/{probe,synthetic}   POST /api/h/:id/audit/verify
GET|POST /api/h/:id/security/{egress[/:decisionId],pii,corpus,compliance,onchain/tune}
GET  /api/h/:id/security/{justification,sandbox,onchain[/sentinel],retention}
POST /api/h/:id/security/justification/{calibrate,preflight}
POST /api/h/:id/security/retention/{sweep,purge}

# thredz — server-side proxied; the key never reaches the browser
GET  /api/h/:id/thredz[/{wiki,records,schemas,goals,tasks,views,dashboards,listeners,
                         webhooks,connectors,activity,keys}]        GET /api/thredz
GET|PUT /api/h/:id/thredz/wiki/:slug        GET  /api/h/:id/thredz/wiki/:slug/versions
POST /api/h/:id/thredz/wiki/:slug/rollback  GET|DELETE /api/h/:id/thredz/records/:recordId
POST /api/h/:id/thredz/{records,listeners,keys,traverse}
POST /api/h/:id/thredz/records/:recordId/restore   POST /api/h/:id/thredz/tasks/:taskId
POST /api/h/:id/thredz/views/:viewId/execute       GET  /api/h/:id/thredz/dashboards/:dashboardId
POST /api/h/:id/thredz/dashboards/:dashboardId/cards
POST /api/h/:id/thredz/keys/:keyId/rotate

# inspect / runtime
GET  /api/h/:id/inspect[/{raw?path=,:store[/:name]}]   PUT /api/h/:id/inspect/settings
GET  /api/h/:id/mcp-servers   POST /api/h/:id/mcp-servers/{start,stop}
GET  /api/h/:id/dev           POST /api/h/:id/dev/{start,stop}
```

**Dispatch is a table, not a chain.** `src/m3-routes.ts` holds one row per
route (key, method, path template, group, handler) and `matchM3` resolves a
request against it LITERAL-FIRST, so `GET …/evals/matrix` matches the M3 route
while `GET …/evals/run_…` still falls through to the M2 handler. One place in
`server.ts` then applies every guard uniformly — id shape + registry lookup +
live-directory check, per-param shape guards, JSON body parsing, a
containment closure, and `maskDeep` on the way out — and hands the handler an
already-validated `M3Context`. The per-area modules (`spec-edit.ts`,
`builders.ts`, `memory-ops.ts`, `wiki-ops.ts`, `watchme-ops.ts`,
`evals-ops.ts`, `data-ops.ts`, `feedback-ops.ts`, `creds-ops.ts`,
`channels-ops.ts`, `security-ops.ts`, `thredz.ts`, `inspect.ts`,
`runtime-ops.ts`) therefore contain nothing but subject matter.

Each handler's docblock carries the write covenant it honours — the store
library or CLI verb that is the sanctioned path for its write, and the trap it
must not re-learn. `src/m3.ts` states the covenant once for all of them: spec
via `applySpecEdits` with `restrictToOptimizable` (human-owned paths route to
`crewhaus propose`), env via `upsertEnvVar` (values in, presence booleans
out), secrets via `secrets rotate` (so `onRotation` subscribers refresh), no
hard delete anywhere in the memory fabric, wiki writes carrying
`expectedVersion` with the stale-version retry, Thredz keys read server-side
and never persisted, and the confirm → typed-confirm → dry-run-first ladder
for destructive verbs.

**Every M3 read answers `{present, note, verb, …}`.** Those three fields are
the arguments the console's `emptyState(message, verb)` already takes: is
there anything to show, why is it empty, and which CLI verb creates it. Most
of this surface is normally empty on a given harness, and without them an
empty panel is indistinguishable from a broken one.

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

**There is no manager-action audit ledger yet.** `<hangarRoot>/jobs.jsonl`
is the durable record of QUEUED work (the 19 job kinds), and control.v1
calls append `gateway_request` records to the harness's own hash-chained
audit log — but a mutating call that writes directly (a spec edit,
`env`/`envUnset`, a session pin, an eval baseline re-pin) leaves no
manager-side trace. `~/.crewhaus/hangar/actions.jsonl` is planned (HM-143)
and has no writer in this milestone; saying so here is cheaper than an
operator discovering it while trying to answer "who changed this".

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

The M3 routes are driven by that same test, and each must answer either `501
not implemented (M3)` (only `secrets/:name/rotate` today) or a 2xx — at
which point its
`VIEW_READS` table is enforced automatically, with no edit to the driving
loop. A 404 there would mean the dispatch table and the route map have
drifted apart; a 500 would mean a guard threw. The test additionally asserts
that `M3_ROUTES` and the map's grouped entries are the same set — key for
key, method for method, path for path — so `routes.js`, `m3-routes.ts` and
the test stay one truth rather than three opinions.

### M4 — health, onboarding, ⌘K, notifications, read-only, plugins

| Route | What it answers |
|---|---|
| `GET /api/h/:id/health` · `GET /api/health` | the 0–100 score with its DEDUCTIONS, each naming the console tab that fixes it (HM-11) |
| `GET /api/onboarding` · `POST /api/onboarding/demo` | first-boot state + scan-root suggestions; demo mode copies a starter out of a LOCAL demos checkout (HM-12) |
| `GET /api/search?q=` | the lazy ⌘K index over harnesses/sessions/wiki/facts/datasets/graders/eval runs/incidents/approvals, plus ACTION proposals (HM-189) |
| `GET·PUT /api/notifications` · `POST /api/notifications/clear` | the rules engine + the badge; the GET is also the evaluation pass (HM-183) |
| `GET·PUT /api/read-only` | the demo/screen-share mode, enforced ahead of every handler (HM-187) |
| `GET /api/plugins` · `GET /api/plugins/:plugin/panes/:pane` · `GET /api/h/:id/panes` | the plugin inventory, one sandboxed pane document, and the panes a harness shows (HM-179) |

Four properties are worth stating because they are easy to get wrong:

**The score is never a bare number.** `computeHealth` is pure and returns
every deduction it applied — points, the fact it came from, and the tab that
fixes it — so the arithmetic is reconstructible by hand and the number is a
route into the work. An input the server could not read comes back as an
`unknown` rather than as a pass. Preflight's credentials area and the spec's
own `$VAR` list describe the same missing key from two directions, so the
unset-env deduction dedupes on `envVar` and one missing key costs once.

**Demo mode copies; it never downloads.** `POST /api/onboarding/demo` reads a
local demos checkout (`CREWHAUS_DEMOS_DIR` or the `demosDir` option) and
answers `409 no-demos-checkout` naming the repo, the variable and the CLI
verb when there is none. It refuses a non-empty destination, refuses to
install inside the checkout, skips symlinks rather than following them, and
is capped by file count and bytes.

**The ⌘K index never blocks boot.** `createOmniIndex()` allocates a map; the
first query pays for the harnesses it needs and memoizes each against a cheap
mtime token. Sessions are listed by NAME from a directory scan — never
`SessionStore.list()`, whose TTL sweep deletes transcripts. The `actions` a
query returns are PROPOSALS carrying a route key and a CLI twin; the search
route executes nothing.

**Read-only mode is enforced here, not in the UI.** Every non-GET `/api`
request is refused unless it is on the short exact-match exempt list
(`READ_ONLY_EXEMPT`), so a route added next month is covered by construction.
It prevents accidents during a demo — the bearer token, not this toggle, is
the security boundary — and `readOnlyLocked` refuses even the un-toggle for
the case where the person driving is not the person who owns the machine. A
`--read-only` BOOT flag is a posture for one process and is deliberately not
persisted; an explicit toggle through the API is a preference and is.

**The plugin wiring is deliberately partial, and says so.** Exactly two
extension points are wired — `onTraceEvent` and `panes` — and
`onSpecLoad`/`onEvalSampleRendered` are reported declared-but-deferred WITH
their reasons rather than silently ignored. Discovery reads manifests and
never `import()`s plugin code into the manager (which holds every harness's
`.env` chain); a pane's own code runs only inside an iframe with an opaque
origin and a CSP built from its `net` allow-list. Visibility is decided by
`@crewhaus/plugin-loader`'s own fail-closed `isFsAllowed`, so a plugin that
may not read a harness neither draws a tab on it nor sees its trace events.

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
point of the runfile, and the next boot adopts it. The corollary is a trap
for the embedder: an ATTACHED job child keeps a handle on the host
process's event loop, so `stop()` is not by itself an exit. `crewhaus
hangar` therefore names what it is leaving behind and calls `process.exit`
after releasing its lock — a manager that let the loop decide stayed alive
for hours with no lock and no port.

## Testing

`src/testkit.ts` boots an isolated server per test over a temp workspace,
with the process layer wired to a fake `ProcessOps` + fake clock — so
start/stop/restart/drain drive the REAL supervision state machine without
spawning anything. `startStubControlPlane()` serves the genuine
`crewhaus.control.v1` wire contract (including the 404/409 cases) on a
loopback port, so the proxy is tested against the responses a daemon
actually sends. Real spawns stay in `@crewhaus/harness-supervisor`'s own
suite, where four tiny fixture scripts cover what a fake cannot prove.
