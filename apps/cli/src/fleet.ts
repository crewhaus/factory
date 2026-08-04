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
