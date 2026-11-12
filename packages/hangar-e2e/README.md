# hangar-e2e

Browser journeys over the real Hangar console, against a seeded fleet. Test-only, and **never
published**. The module brief is
[326-hangar-e2e](https://github.com/crewhaus/docs/blob/main/module-briefs/326-hangar-e2e.md).

## Running it

```sh
bun run --cwd packages/hangar-e2e test                              # DOM-free units; part of the root suite
HANGAR_E2E_SHARD=smoke bun run --cwd packages/hangar-e2e test:browser  # or axe, or system; unset runs all
bun run --cwd packages/hangar-e2e bench --profile smoke --out report.json
```

`test:browser` needs a browser: `bunx playwright install chromium`. In CI it is the `ui-e2e` job,
which runs each shard beside `ci`. `HANGAR_E2E_ARTIFACTS` names where traces and reports go.

## The pieces

- **`boot.ts`** starts Home in this process through its public surface, with an explicit environment
  and recording notification sinks. **`system.ts`** runs the real CLI instead, from source or from
  the binary `CREWHAUS_E2E_BIN` names.
- **`session.ts`** is the one file that knows how sign-in works. A session fails on a console error, a
  page error, a CSP violation, a failed asset, any 5xx, or the script-execution sentinel. A journey
  that answers a 4xx itself with `page.route` (a refusal, a conflict) names that exact path and status
  in `expectedStatuses`, and only that line is excused. `runJourney`
  checks every session a journey opened through its scope when the journey ends, so a journey cannot
  pass over a page that broke along the way.
- **`settle.ts`** is the one function that knows when a screen has finished arriving: the console's
  ready mark (`main#view[data-ready]`, the template of the route it drew) equal to the visited
  route's, with no skeleton and no request in flight. The sign-in screen has no mark and settles on
  the quiet polls alone. **`console-routes.ts`** is the one file that knows the route grammar: it
  takes the route templates, the shape targets, the redirect table and the template filler from the
  real router, and `routeFor(template, harness)` fills a template from a seeded harness.
- **`seed/fleet.ts`** writes one harness per shape through the real store libraries, deterministically.
- **`journeys/`** holds one `*.journey.ts` per journey, each saying what it `proves`. A new journey goes
  in `registry.ts`, and a guard fails if one is missing.
- **`a11y/`** holds the accessibility toolkit: axe injected through `page.evaluate`, never `bypassCSP`,
  the gate's verdict, and helpers for keyboard operation (a whole-page focus tour, a trap, Escape,
  containment inside a dialog, including focus that Tab cannot move), reflow, text spacing, reduced motion, an obscured focus and ARIA
  snapshots. Each returns findings rather than throwing, and `a11y-self-test` proves each one reports a
  planted fault and stays quiet on a clean page.
- **`perf/`** holds the benchmark's machinery. The smoke profile checks only that a well-formed report
  is written. `--profile reference` refuses, because the reference dataset is not in this build.

## The accessibility gate

The `axe` shard's `axe-gate` journey sweeps **every route the console serves** — the router's
`ROUTE_TEMPLATES`, derived from its destination and section tables — in both themes at both widths.
Any axe violation on any route, in any theme at any width, fails the build. There is no allow-list and
no baseline: no parameter can exempt a rule, a node or a screen. Each route also names, in
`GATE_EXPECTS` (`src/a11y/gate.ts`), what must be on it before axe runs, so a seed that stops
producing its content fails by name rather than passing over an empty screen. The sweep fails on its
own machinery too: a missing row, a route that did not settle, or axe not running. It writes
`axe-report.json` and a step summary before it throws.

Three more journeys hold the screens beyond their first paint. `axe-states` sweeps their other
states — every dialog, the command menu, the header's lists, a section's sub-view list, the tooltip,
an armed inbox row, a filtered digest, every memory and Thredz panel, and each Readability choice —
with the same verdict, into its own artifact (`axe-states-report.json`). `keyboard-tour` drives the
toured screens (`TOURED_TEMPLATES`) and the shell by keyboard alone, and `a11y-floor` checks reflow at
320 px, text spacing, the accessibility tree of the shell and reduced motion.

**How a new route joins the gate:** it already has. A screen is a row in the router's tables
(`destinations.js` or `sections/*.js` in hangar-ui), so its template is in `ROUTE_TEMPLATES` the day it
lands, and the sweep fails until it has its line in `GATE_EXPECTS` naming what the screen shows.
Add its other states to `src/journeys/a11y-states.ts`, then run the `axe` shard and fix what it
reports. The `smoke` shard's `crawl` follows the console's links from Home to every template, and
`legacy-redirects` holds every old address to its new one.

## Naming

Never `fixtures.ts`, `*-fixtures.ts`, `fixtures/`, `testkit.ts` or `test-helpers.ts`: those names are
kept out of every build. Journeys are `*.journey.ts` and the suite is `suite.ts`, so `bun test src`
finds only the DOM-free units in `src/unit`, and a runner with no browser can run them.
