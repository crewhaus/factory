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
  page error, a CSP violation, a failed asset, any 5xx, or the script-execution sentinel. `runJourney`
  checks every session a journey opened through its scope when the journey ends, so a journey cannot
  pass over a page that broke along the way.
- **`settle.ts`** is the one function that knows when a screen has finished arriving.
  **`console-routes.ts`** is the one file that knows the route grammar, and takes its lists from the
  real router.
- **`seed/fleet.ts`** writes one harness per shape through the real store libraries, deterministically.
- **`journeys/`** holds one `*.journey.ts` per journey, each saying what it `proves`. A new journey goes
  in `registry.ts`, and a guard fails if one is missing.
- **`a11y/`** holds the accessibility toolkit: axe injected through `page.evaluate`, never `bypassCSP`,
  and helpers for keyboard operation, reflow, text spacing, reduced motion, an obscured focus and ARIA
  snapshots. Each returns findings rather than throwing, and `a11y-self-test` proves each one reports a
  planted fault and stays quiet on a clean page.
- **`perf/`** holds the benchmark's machinery. The smoke profile checks only that a well-formed report
  is written. `--profile reference` refuses, because the reference dataset is not in this build.

## The accessibility baseline

`axe-baseline.json` holds axe's node counts for today's console, by template, theme and width. The
`axe-baseline` journey reports against it and never fails on a violation. It fails only when the
machine broke: too few rows, a route that did not settle, axe not running, or a malformed baseline.

To replace it, take `axe-report.json` from the `ui-e2e-axe` job, so it reflects CI's browser and
fonts, or write one locally with `HANGAR_E2E_WRITE_BASELINE=1`. Then format it:

```sh
node_modules/.bin/biome check --write packages/hangar-e2e/axe-baseline.json
```

## Naming

Never `fixtures.ts`, `*-fixtures.ts`, `fixtures/`, `testkit.ts` or `test-helpers.ts`: those names are
kept out of every build. Journeys are `*.journey.ts` and the suite is `suite.ts`, so `bun test src`
finds only the DOM-free units in `src/unit`, and a runner with no browser can run them.
