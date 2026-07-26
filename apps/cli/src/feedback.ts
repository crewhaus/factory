/**
 * Response-feedback core — MOVED to `@crewhaus/feedback-distill`.
 *
 * The distillation core (FeedbackRecord, turn derivation, multi-rater
 * resolution, `distill()`, grader synthesis) is pure and had no imports, so
 * D39 lifted it into a package: a COMPILED daemon bundle now runs the same
 * `distill()` the CLI does, on its janitor clock, instead of ratings piling
 * up until somebody happens to run `crewhaus run` against the harness.
 *
 * This module stays as the CLI's import surface — every `./feedback` importer
 * in `apps/cli` keeps working unchanged.
 */
export * from "@crewhaus/feedback-distill";
