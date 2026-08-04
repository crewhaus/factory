/**
 * Item 58 — `crewhaus fleet` core — MOVED to `@crewhaus/harness-inventory`.
 *
 * The whole cross-harness core (discovery walk, lenient spec-header scrape,
 * inventory/health aggregation + renderers, and the seam-injected bulk
 * runner with its exit-code decoder) was pure/injected and had no CLI-only
 * imports, so the harness manager lifted it into a package: any surface
 * that needs the cross-harness view (the fleet subcommand, the `crewhaus
 * harness` verb family, a fleet server) now consumes one implementation.
 *
 * This module stays as the CLI's import surface — every `./fleet` importer
 * in `apps/cli` keeps working unchanged.
 */
export * from "@crewhaus/harness-inventory";

/**
 * HM-202 — `crewhaus fleet --help`.
 *
 * `crewhaus fleet` is KEPT indefinitely: since the harness manager landed it
 * has been a thin consumer of `@crewhaus/harness-inventory` and the registry,
 * golden-tested for behavior preservation, so maintenance is near zero — and
 * it is a genuinely different entry point, not a legacy one. The distinction
 * worth teaching in the help text is the axis:
 *
 *   fleet   — FILESYSTEM-centric. Walks `--root`, needs no registration, has
 *             no console. Point it at a directory of harnesses and go.
 *   harness — REGISTRY-centric. The machine-wide list wherever the harnesses
 *             live, with groups/tags/pins, preflight, and the Hangar console.
 *
 * Deprecating either would break scripts for no gain, so the help signposts
 * across instead: an operator who found `fleet` first should discover the
 * registry from here rather than by reading a changelog.
 *
 * The text lives in this module (not in the entry file) so it is testable
 * without executing the CLI's top-level argv switch.
 */
export const FLEET_USAGE: string = [
  "usage:",
  "  crewhaus fleet list [--root <dir>] [--group <name>]  cross-harness inventory",
  "  crewhaus fleet status [--root <dir>] [--group <name>]  per-harness health rollup",
  "  crewhaus fleet run <sub> [--filter <glob>] [--group <name>] [--root <dir>]",
  "                                                     bulk-run a read-only subcommand",
  "         [--allow-mutating] [--yes]                  across the filtered fleet",
  "",
  "  A harness is any directory carrying a crewhaus.yaml (the standalone-harness",
  "  convention). Discovery skips .crewhaus/, node_modules/, .git/, dist/.",
  "  --group <name> keeps only harnesses whose machine-registry entry carries the",
  "  group (manage membership with `crewhaus harness group`).",
  "  Read-only bulk subcommands: eval, doctor, security digest, audit verify.",
  "  A mutating subcommand requires --allow-mutating and per-harness confirmation.",
  "",
  "  `fleet` is FILESYSTEM-centric: it walks --root, needs no registration, and has",
  "  no console. `crewhaus harness` is the REGISTRY-centric twin — the machine-wide",
  "  list wherever the harnesses live, plus groups/tags/pins, preflight, and the",
  "  Hangar console (`crewhaus hangar`). Both are supported; neither replaces the",
  "  other.",
  "",
].join("\n");
