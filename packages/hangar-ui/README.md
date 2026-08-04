# @crewhaus/hangar-ui

The Hangar console's static UI — the browser side of the harness manager.
One HTML shell, one CSS file, and a set of hand-written browser ES modules,
embedded as text and exported as a serve-path map for the hangar server to
host.

M1 was read-only over harness state. **M2 makes the console a driver**: it
starts, stops, restarts and drains supervised harnesses, watches a run live,
pokes scheduler lanes through `crewhaus.control.v1`, and settles parked
approvals and review items — and every one of those actions shows the exact
CLI command it runs.

## Zero-build by design

There is no build step, no framework, and no npm dependency. The `assets/`
tree IS the app: plain ES modules loaded by the browser exactly as checked
in. `src/index.ts` imports every asset `with { type: "text" }` — static
imports only, because `bun build --compile` embeds only what the import
graph references statically; a runtime `readFileSync` of a
package-relative path resolves inside the compiled binary's virtual
filesystem where the files were never placed, and bricks the CLI at boot.
A unit test enforces that the embed map and the `assets/` tree stay in
lockstep (every file present, every relative import resolving inside the
map, every module transpiler-clean), so the zero-build path still has a
compile-shaped safety net.

## Exported API

```ts
import { hangarAssets, CONTENT_TYPES, contentTypeFor } from "@crewhaus/hangar-ui";

hangarAssets; // Readonly<Record<string, { body: string; contentType: string }>>
contentTypeFor("/assets/js/app.js"); // "text/javascript; charset=utf-8"
```

`hangarAssets` is keyed by serve path — `"/"` is the SPA shell (the app is
a hash router, so `/` is the only HTML route) and everything else lives
under `/assets/…` exactly as laid out on disk. Hand the map to the hangar
server's static-asset option; a server route for `path` responds with
`body` and `Content-Type: contentType`.

## The app

- **Auth bootstrap** — reads `#t=<token>` from the URL fragment into
  sessionStorage (and strips it via `history.replaceState`), then sends
  `Authorization: Bearer` on every request. Fragments never reach server
  logs; no cookies means no CSRF surface. Any 401 swaps in a token-paste
  screen that points at the token file (`~/.crewhaus/hangar/token` by
  default). The live run feed is hand-rolled over `fetch` for the same
  reason `EventSource` cannot be used: it carries no bearer header.
- **Hash router, deep-linkable** — `#/` (Library), the fleet screens
  `#/{runs, approvals, review, activity}`, `#/h/<id>` (Overview), and
  `#/h/<id>/{spec, runs[/<runId>], schedulers, sessions[/<sess>],
  evals[/<runId>[/<sampleId>]], memory[/wiki/<slug>], costs, deploy}`.
- **Library** — dense sortable table (name + dir tail, shape badge, model,
  supervision state + parked-approval count, eval health dot + text,
  sessions, spend 7d, capability badges, group chips); a sub-rail of stored
  groups plus client-computed smart groups (Failing evals, Unbudgeted, Has
  Thredz, Recently active, Ungrouped, Missing); missing-dir cards with
  relocate/remove; Scan and Add-harness actions; a one-line fleet rollup.
- **Detail** — Overview (header with click-to-copy dir and capability
  chips, health checklist, eval-trend SVG, memory mini-cards, cost
  mini-chart, expandable preflight report), Spec (masked YAML with line numbers,
  env-ref presence checklist, parse issues), Sessions (TTL countdowns,
  evicted rows fall through to summaries, per-kind transcript rendering
  with a metadata gutter and a Raw toggle), Evals (history with
  flaky/partial/replayed/baseline badges, run + sample drill-down),
  Memory (facts with tombstones folded, wiki with a minimal safe-subset
  markdown reader, continuity, dream, watchme), Costs (per-model table +
  7-day bars).

### M2 — the driving surfaces

- **Runs & daemons** (`#/runs`) — every registered harness's supervision
  state in one board: state pill, pid, uptime, adopted badge, restarts in
  the window with the next-restart countdown, last exit + failure class,
  control availability. Row actions Start / Stop / Restart / Drain, each
  disabled WITH ITS REASON; a blocked start opens the refusal modal. Under
  it: the global job queue (running / pending / interrupted) and a failure
  board grouping the fleet by how it died ("3 harnesses exited 31 —
  provider funding").
- **Run console** (`#/h/<id>/runs/<runId>`) — the live SSE feed rendered in
  the M1 transcript vocabulary, with interleaved (scrubbed) prose, a
  stats/cost HUD folded from the frames, and the terminal exit banner with
  its failure class and remediation. The `replay`-first / `done`-last
  grammar means a finished run and a live one take the same code path.
- **Schedulers** (`#/h/<id>/schedulers`) — the four-lane timeline with
  cadence + its source, last outcome, and next due — or an honest "cadence
  only" naming why the phase is unknown. Wake respects `pokeable`; a
  `tick_in_flight` refusal retries, a `draining` one does not.
- **Approvals** (`#/approvals`) and **Review** (`#/review`) — cross-harness
  triage with the verbatim (masked) tool input, keyboard-first (j/k to
  move, one key per verdict, `.` row menu, `?` bindings). Review offers
  thumbs only where they can land on a session turn.
- **Activity** (`#/activity`) — what changed since yesterday, grouped by
  kind with per-group filters, every row deep-linking into the screen that
  owns it.
- **Deployments** (`#/h/<id>/deploy`) — the records with class (local /
  PaaS / cf-worker) and health, and an honest empty state naming the file
  that will hold them.
- **Action faces on the M1 screens** — session retention pin, eval baseline
  re-pin, dream "Run now" (through the job queue), plus the supervision
  pill, bundle-freshness badge and control availability on the detail
  header, where a plan that cannot be built renders its remedy as a button.

### UX invariants

Dark theme default with an explicit light toggle; traffic-light dots are
always paired with text; every empty state names the CLI verb that creates
its data; 404s render as "nothing yet", never as errors; loading skeletons
everywhere; cached figures show their as-of time; the footer shows the
hangar version + wire-protocol pair. No animation beyond opacity.

Three more that M2 adds, because a console that drives things can lie in
new ways:

1. **Every action shows its CLI twin** — the exact command, with a copy
   button. The CLI and the console drive the same harness-local state tree,
   so the twin is both a trust affordance and a fallback. Where no CLI verb
   exists yet (the retention pin), the UI says so instead of inventing one.
2. **A disabled control always says why.** `expected: true` control
   refusals (`no_control_port`, `lane_not_armed`, `draining`) render
   disabled-with-reason, never as an error toast.
3. **Say which answer you got.** Bundle freshness distinguishes the
   hash-exact verdict from the mtime approximation; a last exit read off
   the run ledger rather than observed by this manager is badged as such.

### Injection safety

Rendering is 100% `createElement`/`textContent` via a tiny `el()`/`text()`
toolkit — markup-string assignment is banned and a unit test scans every
embedded module for it. The wiki renderer parses a minimal markdown subset
(headings, bold, inline code, lists, fenced code) into tokens and renders
them as text nodes; raw HTML in an article body stays literal text.

## Server routes consumed

This package is the client of record for the whole route surface, and the
contract is EXECUTABLE: `assets/js/routes.js` holds every route as pure
data (method, path template, body-shape name), `api.js` builds every
request from that map, and the hangar server's `contract.test.ts` imports
the same map and drives each route against a live fixture server — writes
must take effect, reads must carry every field the views dereference. A
unit test here drives every `api.js` wrapper against the same map, so the
client cannot drift from it either. The two sides cannot drift silently.

Reads: `/api/harnesses[?hydrate=1]`, `/api/registry/groups`, `/api/h/:id`,
and per-harness `spec`, `preflight`, `sessions[/:sess]`,
`evals[/:runId[/:sampleId]]`,
`memory/{facts,wiki[/:slug],state,dream,watchme}`, `costs`, plus
`/api/version` — and for M2 `proc`, `runs[/:runId]`,
`runs/:runId/events` (SSE), `control/status`, `schedulers`, `deployments`,
`/api/{approvals,review,activity,jobs}`. Writes: registry CRUD
(`POST /api/harnesses` `{dir}`, `POST /api/scan`,
`POST /api/registry/groups` `{name}`, `POST /api/registry/scan-roots`
`{dir}`, `PUT /api/h/:id/{groups,tags,pin,notes}`,
`POST /api/h/:id/relocate` `{newDir}`, `DELETE /api/h/:id`) plus the M2
verbs: `POST /api/h/:id/proc/{start,stop,restart,drain}`,
`POST /api/h/:id/control/{wake,drain}`,
`POST /api/h/:id/approvals/:apprId/{grant,deny}`,
`POST /api/h/:id/review/:itemId`, `POST /api/h/:id/jobs`,
`POST /api/h/:id/sessions/:sess/pin`, `POST /api/h/:id/evals/baseline`.

All payload readers are tolerant: unknown fields are ignored, missing
fields degrade to "—", and unknown transcript/trace kinds still render. A
failed write is never silent — non-2xx surfaces as a toast, and a zero-root
Scan says "no scan roots configured" and offers the add-scan-root input
instead of pretending success. Two refusals are deliberately NOT errors:
`POST /proc/start`'s 409 becomes the preflight modal, and a control
envelope with `expected: true` disables its control with the server's own
sentence.

The Library paints twice by design: instantly from the cache-only feed
(figures labeled with their `cachedAt` as-of time), then again from a
background `?hydrate=1` refetch with freshly computed rollups.

## Testing

`bun test src` — the embed-map completeness/hygiene suite plus unit tests
for the pure browser modules (`util.js`, `supervision.js`, `markdown.js`,
`router.js`, `routes.js`, `shapes.js`) and the `api.js` client under a
stubbed `fetch` (every wrapper asserted against the route map's
method/path/body). All DOM-free at import time and imported directly by
bun. Deterministic: clocks are injected, no network, no subprocesses. The
server side of the same contract runs in `@crewhaus/hangar-server`'s
`contract.test.ts`.

The M2 screens stay testable without a browser by keeping the decisions —
state → row, envelope → disabled-with-reason, SSE frame → feed item,
refusal → modal model, keystroke → next state — as pure functions in
`supervision.js`; `views/*.js` are thin DOM builders over them.
