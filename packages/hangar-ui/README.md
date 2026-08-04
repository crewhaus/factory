# @crewhaus/hangar-ui

The Hangar console's static UI — the browser side of the harness manager's
read-only alpha. One HTML shell, one CSS file, and a set of hand-written
browser ES modules, embedded as text and exported as a serve-path map for
the hangar server to host.

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

## The app (M1, read-only)

- **Auth bootstrap** — reads `#t=<token>` from the URL fragment into
  sessionStorage (and strips it via `history.replaceState`), then sends
  `Authorization: Bearer` on every request. Fragments never reach server
  logs; no cookies means no CSRF surface. Any 401 swaps in a token-paste
  screen that points at the token file (`~/.crewhaus/hangar/token` by
  default).
- **Hash router, deep-linkable** — `#/` (Library), `#/h/<id>` (Overview),
  and `#/h/<id>/{spec, sessions[/<sess>], evals[/<runId>[/<sampleId>]],
  memory[/wiki/<slug>], costs}`.
- **Library** — dense sortable table (name + dir tail, shape badge, model,
  process placeholder, eval health dot + text, sessions, spend 7d,
  capability badges, group chips); a sub-rail of stored groups plus
  client-computed smart groups (Failing evals, Unbudgeted, Has Thredz,
  Recently active, Ungrouped, Missing); missing-dir cards with
  relocate/remove; Scan and Add-harness actions; a one-line fleet rollup.
  Registry CRUD is the ONLY write surface — harness state is never
  mutated from this UI in M1.
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

### UX invariants

Dark theme default with an explicit light toggle; traffic-light dots are
always paired with text; every empty state names the CLI verb that creates
its data; 404s render as "nothing yet", never as errors; loading skeletons
everywhere; cached figures show their as-of time; the footer shows the
hangar version + wire-protocol pair. No animation beyond opacity.

### Injection safety

Rendering is 100% `createElement`/`textContent` via a tiny `el()`/`text()`
toolkit — markup-string assignment is banned and a unit test scans every
embedded module for it. The wiki renderer parses a minimal markdown subset
(headings, bold, inline code, lists, fenced code) into tokens and renders
them as text nodes; raw HTML in an article body stays literal text.

## Server routes consumed

This package is the client of record for the M1 route surface, and the
contract is EXECUTABLE: `assets/js/routes.js` holds every route as pure
data (method, path template, body-shape name), `api.js` builds every
request from that map, and the hangar server's `contract.test.ts` imports
the same map and drives each route against a live fixture server — writes
must take effect, reads must carry every field the views dereference. The
two sides cannot drift silently.

Reads: `/api/harnesses[?hydrate=1]`, `/api/registry/groups`, `/api/h/:id`,
and per-harness `spec`, `preflight`, `sessions[/:sess]`,
`evals[/:runId[/:sampleId]]`,
`memory/{facts,wiki[/:slug],state,dream,watchme}`, `costs`, plus
`/api/version`. Writes (registry-only): `POST /api/harnesses` `{dir}`,
`POST /api/scan`, `POST /api/registry/groups` `{name}`,
`POST /api/registry/scan-roots` `{dir}`,
`PUT /api/h/:id/{groups,tags,pin,notes}` (per-field bodies),
`POST /api/h/:id/relocate` `{newDir}`, and `DELETE /api/h/:id`. All
payload readers are tolerant: unknown fields are ignored, missing fields
degrade to "—", and unknown transcript kinds are tallied by the server and
surfaced as a count. A failed write is never silent — non-2xx surfaces as
a toast, and a zero-root Scan says "no scan roots configured" and offers
the add-scan-root input instead of pretending success.

The Library paints twice by design: instantly from the cache-only feed
(figures labeled with their `cachedAt` as-of time), then again from a
background `?hydrate=1` refetch with freshly computed rollups.

## Testing

`bun test src` — the embed-map completeness/hygiene suite plus unit tests
for the pure browser modules (`util.js`, `markdown.js`, `router.js`,
`routes.js`, `shapes.js`) and the `api.js` client under a stubbed `fetch`
(every write asserted against the server's real method/path/body). All
DOM-free at import time and imported directly by bun. Deterministic:
clocks are injected, no network, no subprocesses. The server side of the
same contract runs in `@crewhaus/hangar-server`'s `contract.test.ts`.
