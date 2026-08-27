# @crewhaus/hangar-ui

The Hangar console's static UI — the browser side of the harness manager.
One HTML shell, one CSS file, and a set of hand-written browser ES modules,
embedded as text and exported as a serve-path map for the hangar server to
host.

M1 was read-only over harness state. **M2 makes the console a driver**: it
starts, stops, restarts and drains supervised harnesses, watches a run live,
pokes scheduler lanes through `crewhaus.control.v1`, and settles parked
approvals and review items — and every one of those actions shows the exact
CLI command it runs. **M3 adds the detail surface**: eight more harness tabs
and three more fleet screens over a 178-route contract, covering the spec's
write side, the memory fabric's write side, the eval/dataset/feedback loops,
credentials + channels + security, Thredz, and the raw inspectors.

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
  `#/{runs, approvals, review, activity, credentials, feedback, thredz}`,
  `#/h/<id>` (Overview), and `#/h/<id>/{spec, runs[/<runId>], schedulers,
  sessions[/<sess>], evals[/<runId>[/<sampleId>]], memory[/wiki/<slug>],
  data, feedback, costs, creds, channels, security, thredz, deploy, inspect,
  dev}`. The eight M3 tabs capture their trailing segments GENERICALLY
  (`M3_TABS` → a `rest` array), so a sub-screen inside one of them never
  needs a new `parseRoute` case.
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

### M3 — the detail surface

Eleven new view modules (`views/{spec-edit, memory-fabric, evals-lab, data,
feedback, creds, channels, security, thredz, inspect, runtime}.js`) draw
eight new harness tabs and three new fleet screens:

- **Spec** (`#/h/<id>/spec`) gains the write side — the trust-tier table
  (auto-tunable rows edit inline; human-owned rows demand the typed spec-name
  confirm or route to `crewhaus propose`), the diff interstitial, version
  history with pin/rollback, and the builders (templates, graders, dataset,
  MCP connectors).
- **Memory** (`#/h/<id>/memory`) gains the fabric's write side — facts with
  forget/sweep (tombstones, never a delete), continuity trash + restore, the
  wiki editor with `expectedVersion` and its stale retry, watch-me analytics,
  reports, intents and the synthesize review.
- **Datasets** (`#/h/<id>/data`), **Feedback** (`#/h/<id>/feedback`) and the
  eval lab inside **Evals** cover the quality loops: registry + hygiene +
  growth, the fewshot/faq/lessons/advice feeds, and the matrix / trends /
  judge / graders / coverage / sentinel screens.
- **Credentials**, **Channels** and **Security** (`#/h/<id>/{creds,channels,
  security}`) show env-key PRESENCE (never a value), the channel doctor and
  provisioning, and the egress / PII / compliance / on-chain / retention
  panels.
- **Thredz** (`#/h/<id>/thredz`) is proxied server-side — the workspace key
  never reaches the browser.
- **Inspect** (`#/h/<id>/inspect`) is the raw store browser, and **Dev & MCP**
  (`#/h/<id>/dev`) drives the dev server and the MCP servers.
- Fleet-wide: **Credentials** (`#/credentials`, the provider × harness
  matrix), **Feedback** (`#/feedback`) and **Thredz** (`#/thredz`).

Two conventions make that surface cheap to extend:

1. **The client wrappers are GENERATED.** `routes.js` carries all 178 M3
   routes as pure data tagged with a `group`, and `api.js` builds one wrapper
   per key from the map rather than hand-writing them. A hand-written name
   WINS a collision, so an M1/M2 verb keeps its bespoke wrapper.
2. **Every M3 read answers `{present, note, verb, …}`** — is there anything
   to show, why is it empty, and which CLI verb creates it. Most of this
   surface is normally empty on a given harness, so the views render that
   triple directly through `emptyState(message, verb)`; an empty panel is
   never indistinguishable from a broken one.

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

M3 adds 178 more, grouped `spec | memory | evals | data | feedback | creds |
channels | security | thredz | inspect | runtime` — enumerated in
`assets/js/routes.js` and mirrored route-for-route by the server's
`M3_ROUTES`, which the contract test asserts is the same set (key, method and
path). They are not re-listed here: the map is the inventory, and a README
copy of it would be the thing that goes stale.

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

## M4 — the polish layer

| Module | What it owns |
|---|---|
| `assets/js/keys.js` | the app-level keyboard reducer: who owns ⌘K, Escape and `?` (HM-190) |
| `assets/js/omnibox.js` | the ⌘K overlay — navigation rows are links, ACTION rows are proposals |
| `assets/js/notify.js` | the ONE notification poll: the evaluating GET, shared (HM-183) |
| `assets/js/views/health.js` | the explained score, per harness and as the fleet board |
| `assets/js/views/onboarding.js` | first boot: scan-root picker, demo mode, direct registration |
| `assets/js/views/settings.js` | notification rules, read-only mode, the plugin inventory |
| `assets/js/views/panes.js` | sandboxed plugin panes |

**Keyboard ownership is a reducer, not a race.** M2 shipped the inbox half of
HM-190 (`triageKey` in `supervision.js`: j/k, one-key verdicts, `.`, `?`).
`keys.js` adds the layer above it and decides between them: a field owns its
keys (including ⌘K), the open omnibox owns everything but Escape, and `?`
goes to the app sheet only when no inbox is mounted — two sheets opening on
one keypress is the bug that rule exists to prevent. The reducer claims
nothing else, so the inbox keeps receiving j/k/g/d untouched.

The field rule has exactly one exception, and the omnibox is it: the overlay
focuses its own input, so from the moment it opens every key arrives from a
field. Escape and the ⌘K toggle are therefore claimed even in a field while
the omnibox is open — otherwise the overlay swallows both of its own exits
and the only way out is a mouse click, on the feature whose whole point is
the keyboard. Nothing else is taken: the query still types.

**One evaluating poll, shared.** `GET /api/notifications` IS the rules
evaluation (the manager runs no timer of its own), and every delivery it
returns is deduped away server-side and never returned again — so a second
caller does not read that state, it consumes it. `notify.js` owns the only
call: it polls on an interval so a console left open actually notifies,
toasts what each pass delivered, keeps the nav badge honest, and hands the
same snapshot to the Settings screen rather than letting it issue a GET that
would eat a toast. The PUT that saves the rules answers with the same
evaluated view, so its answer is folded back in through the same path. The
asset-hygiene suite pins the single caller.

**The omnibox proposes; it never acts.** Enter on a navigation row goes
somewhere. Enter on an ACTION row opens a confirm, showing the exact CLI
command it will run, and only the four process verbs are executable at all —
anything else the server proposes renders with a reason instead.

**The score is never rendered alone.** Every deduction row is a link to the
tab that fixes it; signals the server could not read are shown as unknowns
rather than folded into the number.

**Panes are the one deliberate exception to the markup-string ban.** A pane
document is handed to an `<iframe>` via `srcdoc` with `sandbox="allow-scripts"`
and no `allow-same-origin`, so it becomes a SANDBOXED document with an opaque
origin — never part of this one. The asset-hygiene suite pins the exception
to that single module, and `paneSandbox` strips `allow-same-origin` even if a
payload asks for it.

## M5 — the Advisor

`views/advisor.js` draws one more harness tab (`#/h/<id>/advisor`, right
after Overview — the strip order is the triage order) and one more fleet
screen (`#/advisor`):

- **The feed** — every alert, suggestion and optimization signal the manager
  can derive about the harness, in one severity-ranked list. Every item
  carries a hover TOOLTIP (`withTip`/`tipIcon` in `dom.js`: a `data-tip`
  attribute the stylesheet renders via `attr()` — text only, so the
  injection ban holds) explaining why it matters, the fact it was derived
  from, guidance on what to do, and a quick action: an executable button for
  a queued CLI verb (with its CLI twin beside it) or a deep link into the
  tab that owns the fix. Acting opens an inline confirm where a COMMENT can
  be attached — it is recorded in the harness-local decisions ledger next to
  the queued job. Dismissing REQUIRES a reason (the server refuses without
  one), dismissed items keep their recorded reasoning in a collapsible fold,
  and every dismissal can be reopened. Zero open items renders as a
  first-class "running optimally" state, never as an empty screen.
- **The trend** — "is it improving?": the eval pass-rate bars, the decision
  counts, and a one-line verdict, all folded from durable sources.
- **Reports** — generate model-usage / costs / usefulness / optimization
  reports (each button tooltipped with what it measures); saved reports are
  listed and re-readable in place.
- **Issues** — describe a problem and it is tuned into an update ready to
  run: the kind selector (tooltipped per kind) picks what gets queued, with
  `optimize` — the eval→patch loop whose artifact is a reviewable spec
  patch — as the default.
- **The fleet board** (`#/advisor`) — every harness's rollup, worst first,
  each row deep-linking its Advisor tab.

The Library also becomes curatable (M5): harness rows carry a `hidden` flag
(the row editor's Visibility checkbox), hidden rows fold out of every view
except an explicit **Hidden** rail bucket, and a **Find harnesses…** panel
lists the unregistered harnesses under the scan roots (via
`GET /api/registry/discover`) with per-candidate Add buttons — discovery
without registration, so the Library only shows what you add. The blanket
Scan (which registers everything) stays as the labeled bulk fallback.

## Testing

`bun run test` — two `bun test` invocations, DELIBERATELY two processes:
`bun test src` runs the unit tests for the pure browser modules
(`util.js`, `supervision.js`, `markdown.js`, `router.js`, `routes.js`,
`shapes.js`, the view decisions) and the `api.js` client under a stubbed
`fetch` (every wrapper asserted against the route map's method/path/body);
`bun test ./src/embed-suite.ts` then runs the embed-map
completeness/hygiene suite alone. The split is load-bearing, not taste:
the embed suite imports every asset as TEXT while the view tests import
the same files as ES modules, and bun's module registry keys a module by
path alone — in one process whichever load lands first poisons the other.
All DOM-free at import time and imported directly by bun. Deterministic:
clocks are injected, no network, no subprocesses. The server side of the
same contract runs in `@crewhaus/hangar-server`'s `contract.test.ts`.

The M2 screens stay testable without a browser by keeping the decisions —
state → row, envelope → disabled-with-reason, SSE frame → feed item,
refusal → modal model, keystroke → next state — as pure functions in
`supervision.js`; `views/*.js` are thin DOM builders over them.

The M3 suites follow the same shape: `routes.test.ts` pins the route map's
grammar, `api.test.ts` drives every generated M3 wrapper against it under a
stubbed `fetch`, and `creds-views.test.ts` / `memory-fabric.test.ts` unit-test
the pure decisions those tabs make. The embed-map suite additionally asserts
that no module is ORPHANED — reachable from `app.js`'s import graph — so a
view that loses its last importer cannot keep shipping to the browser.
