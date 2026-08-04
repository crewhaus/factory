# @crewhaus/harness-inventory

Cross-harness discovery and fleet inventory/health rollup — the library core behind
`crewhaus fleet`, lifted out of the CLI so every surface that needs the cross-harness view
(the fleet subcommand, the harness manager, remote consoles) consumes one implementation.

A "harness" is any directory carrying a `crewhaus.yaml` (the standalone-harness convention).
This package:

- **discovers** harnesses under a root (`discoverHarnesses`) — bounded-depth walk that never
  descends into `.crewhaus/`, `node_modules/`, `.git/`, `dist/`, or `.worktrees/`;
- **aggregates** each harness's on-disk state into an inventory row (`buildFleetInventory`):
  a lenient `crewhaus.yaml` header scrape that survives schema drift (`readSpecHeader`),
  registry version + env pins, newest eval pass-rate, session and distinct-feedback counts;
- **rolls up health** (`buildHarnessHealth`, `healthMark`): registered? eval baseline held?
  open incidents? audit trail present?;
- **plans and runs bulk operations** (`resolveBulkCommand`, `runFleetBulk`) across the filtered
  fleet, refusing anything off the read-only allow-list unless explicitly opted in and
  per-harness confirmed, and **decodes child exit codes** back into failure classes
  (`describeFleetExit`).

Everything is side-effect-free on import. All reads are tolerant — a torn JSONL line, an
absent state dir, or an unreadable spec degrades to an absent field instead of aborting the
scan — and the only side-effect surface (launching per-harness CLI invocations) is the
injected `FleetRunner` seam, so tests drive the whole path deterministically.

```ts
import {
  buildFleetInventory,
  buildHarnessHealth,
  discoverHarnesses,
  formatInventory,
} from "@crewhaus/harness-inventory";

const rows = await buildFleetInventory(".", {
  readManifest, // e.g. a closure over @crewhaus/spec-registry
  readEvalIndex, // e.g. a closure over @crewhaus/eval-report's readRunIndexLatest
});
for (const line of formatInventory(rows, ".")) console.log(line);
```

Part of the [CrewHaus factory](https://github.com/crewhaus/factory).
