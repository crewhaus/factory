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
- **`settle.ts`** is the one function that knows when a screen has finished arriving.
  **`console-routes.ts`** is the one file that knows the route grammar, and takes its lists from the
  real router.
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

## The accessibility gate and the baseline

The `axe` shard sweeps every fleet screen and every tab in both themes at both widths, in one pass.
The screens moved onto the shared accessible components are the **gate** (`GATED_TEMPLATES` in
`src/a11y/gate.ts`): any axe violation on one of them, in any theme at any width, fails the build, and
there is no allow-list — no parameter can exempt a rule or a node. Each gated screen also names, in
`GATE_EXPECTS`, what must be on it before axe runs, so a seed that stops producing its content fails by
name rather than passing over an empty screen.

Every other screen is reported against `axe-baseline.json`, which holds axe's node counts by template,
theme and width, and never fails. The sweep fails on its own machinery too: too few rows, a route that
did not settle, axe not running, or a malformed baseline.

Three more journeys hold the gated screens beyond their first paint. `axe-states` sweeps each one's
other states — every dialog, the command menu, the tooltip, an armed inbox row, a filtered digest,
every memory and Thredz panel, and each Readability choice — with the same verdict, into its own
artifact (`axe-states-report.json`), never into the baseline. `keyboard-tour` drives them by keyboard
alone, and `a11y-floor` checks reflow at 320 px, text spacing, the accessibility tree and reduced
motion.

**Moving a screen into the gate:** rebuild it on the components, add its template to
`GATED_TEMPLATES` and its content selector to `GATE_EXPECTS`, add its states to
`src/journeys/a11y-states.ts`, then run the `axe` shard and fix what it reports.

**Replacing the baseline:** take `axe-report.json` from the `ui-e2e-axe` job, so it reflects CI's
browser and fonts, or write one locally with `HANGAR_E2E_WRITE_BASELINE=1`. Gated rows are empty. Then
format it:

```sh
node_modules/.bin/biome check --write packages/hangar-e2e/axe-baseline.json
```

## Naming

Never `fixtures.ts`, `*-fixtures.ts`, `fixtures/`, `testkit.ts` or `test-helpers.ts`: those names are
kept out of every build. Journeys are `*.journey.ts` and the suite is `suite.ts`, so `bun test src`
finds only the DOM-free units in `src/unit`, and a runner with no browser can run them.
