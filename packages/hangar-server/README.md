# @crewhaus/hangar-server

The Hangar manager's local HTTP server, first (read-only) milestone: one
loopback `Bun.serve` exposing the machine-wide harness registry and
read-only views over every registered harness's on-disk state — fleet rows
with cached rollups, per-harness detail/spec/preflight, TTL-safe session
browsing, eval history drill-down, memory-fabric views, and cost folds.
A library: `startHangarServer(opts)` boots the server; the `crewhaus
hangar` CLI verb wires ports, embedded UI assets, and lifecycle around it.

Registry CRUD (manager state under `~/.crewhaus/harnesses.json` via
`@crewhaus/harness-registry`) is the ONLY write surface. Harness state is
never written: no process spawning, no WebSocket — later milestones.

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
  deletes expired transcripts as a side-effect). A regression test browses
  every sessions route repeatedly over expired-mtime fixtures and asserts
  every file survives byte-identical.
- **Credentials never render** — env handling reports KEY presence
  booleans only; the spec view masks credential values (spec-patch
  `isCredentialKey`/`maskCredentialTokens`); transcripts, preflight
  reports, and eval artifacts pass the same maskers. A test plants a
  fake-shaped key (built from string parts) in a fixture `.env` + spec and
  asserts the byte sequence never appears in any response body.
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

## Routes (read-only milestone)

```
GET  /healthz                              GET  /api/version
GET  /api/harnesses[?hydrate=1]            POST /api/harnesses {dir}
GET|POST|PUT|DELETE /api/registry/groups   GET|POST|DELETE /api/registry/scan-roots
POST /api/scan                             GET  /api/costs
GET|DELETE /api/h/:id                      POST /api/h/:id/relocate {newDir}
PUT  /api/h/:id/{groups,tags,pin,notes}
GET  /api/h/:id/{spec,preflight,costs}
GET  /api/h/:id/sessions[/:sess[?raw=1]]
GET  /api/h/:id/evals[/:runId[/:sampleId]]
GET  /api/h/:id/memory/{facts,wiki[/:slug],state,dream,watchme}
```

Absence is not an error: missing state renders as "nothing yet" shapes,
and a vanished harness dir keeps its registry row (`missingSince`) with a
relocate/remove affordance instead of disappearing.

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
`env`/`now`/`onWarn` for tests, and the reported `version`.
