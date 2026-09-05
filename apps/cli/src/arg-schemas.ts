/**
 * Every `ParseArgsSchema` the CLI dispatches on, in one side-effect-free
 * module. They live here rather than in index.ts because index.ts self-executes
 * at import (top-level argv read + dispatch switch), so nothing can import it —
 * which left these schemas impossible to assert on except by spawning the CLI.
 * Keeping them importable is what lets arg-schemas.test.ts validate all of them
 * in CI, including the ones no test ever invokes.
 */
import type { ParseArgsSchema } from "@crewhaus/infra-utils";

export { DREAM_CLI_SCHEMA } from "./dream-cli";

export const COMPILE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "out", short: "o", takesValue: true },
    { name: "emit-ir", takesValue: false },
    // Loop contract 0.4 (Batch B, G42) — print projectLoop() of the lowered
    // IR (the studio /builder + compiler-worker POST /loop wire contract)
    // instead of emitting code. Human-readable by default; --json prints the
    // raw LoopProjection; with -o writes <out-dir>/loop.json.
    { name: "emit-loop", takesValue: false },
    { name: "json", takesValue: false },
    // Loop contract 0.4 (Batch F, item 6) — `--emit-as cf-worker` emits the
    // Cloudflare-Worker bundle (the same one the compiler-worker's remote
    // POST /compile { emitAs } serves) instead of the default `local` bundle.
    // Supported for target=cli|workflow|graph; see cf-worker-emit.ts.
    { name: "emit-as", takesValue: true },
    // FR-002 made the strict scope gate DEFAULT-ON, which left `--strict` an
    // accepted no-op. Loop contract 0.4 (Batch A) gives it real meaning
    // again: escalate compile WARNINGS (accepted-but-unwired spec keys) to
    // errors — warnings always print (code + path + message, one per line);
    // with --strict any warning fails the compile before files are written.
    // The scope gate itself stays default-on regardless (opt out below).
    { name: "strict", takesValue: false },
    // FR-002 — explicit opt-out for users who knowingly bypass the gate (e.g.
    // an outward sink whose external scope is verified out of band). Either
    // spelling disables the gate; both are accepted so neither reach is a
    // surprise. Without one of these flags an unmarked outward/io-capable tool
    // FAILS the compile.
    { name: "allow-unmarked-sinks", takesValue: false },
    { name: "no-strict-scope", takesValue: false },
    // Item 33 — post-compile verification of the just-emitted bundle
    // (shape assertion → bun install → credential-free liveness boot).
    // See compile-check.ts; wired at the very end of the compile path.
    { name: "check", takesValue: false },
    // Item 42 — README emission into the bundle is DEFAULT-ON; this is the
    // explicit opt-out for users who post-process bundles and don't want
    // the extra file.
    { name: "no-readme", takesValue: false },
    // Item 46 — auto-registration of the compiled spec into the local
    // spec-registry (with a distilled CHANGELOG.md entry) is DEFAULT-ON;
    // this is the explicit opt-out.
    { name: "no-register", takesValue: false },
    // Item 10 — also emit an eval bridge (a target: eval bundle projected from
    // this non-cli spec's own agent) into <out-dir>/eval/, so the shape can
    // consume its distilled feedback through eval/optimize/flywheel.
    { name: "with-eval-harness", takesValue: false },
    // Item 10 — the dataset the projected eval bridge consumes (defaults to
    // <specName>-eval@v1#dev, the dataset mine/distill convention).
    { name: "eval-dataset", takesValue: true },
    // Item 41 — re-run parse→lint→compile on every change to the spec /
    // .crewhaus/commands / skills dirs (the watch mode the header listed as
    // "future"). Debounced, Ctrl-C-clean, one green/red status per cycle.
    { name: "watch", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// Item 41 — `crewhaus lint [--fix] [--format text|json]`: a check-only command
// running parseSpec + compile({applyIrPasses:true}) + auditToolScopes WITHOUT
// emitting, so §47 chain / graph-crew well-formedness checks (skipped on the
// CLI compile path) surface for authors.
export const LINT_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "fix", takesValue: false },
    { name: "format", takesValue: true },
    { name: "help", short: "h" },
  ],
};

export const RUN_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "model", takesValue: true },
    { name: "permission-mode", takesValue: true },
    // Loop contract 0.4 (G11) — pause|deny. Overrides the spec's
    // `permissions.ask_mode` for how a non-interactive `ask` behaves.
    { name: "ask-mode", takesValue: true },
    { name: "resume", takesValue: true },
    { name: "continue", takesValue: false },
    { name: "prompt", takesValue: true },
    // FR-004 — select the Pillar 3 intent-gate judge for this run.
    // rule-based (default) | claude. Overrides the spec's
    // security.justification.judge when supplied.
    { name: "justification-judge", takesValue: true },
    // FR-004 — disable the durable `permission_justification_evaluated`
    // audit-log record (on by default for `run`). The ephemeral trace-bus
    // event is unaffected; this only skips opening `.crewhaus/audit`.
    { name: "no-justification-audit", takesValue: false },
    // FR-006 — select the Pillar 3 sink-side egress matcher for this run.
    // substring (default) | semantic. Overrides the spec's
    // security.egressMatcher when supplied.
    { name: "egress-matcher", takesValue: true },
    // FR-006 — embedder model for the "semantic" egress matcher (the
    // @crewhaus/embedder prefix grammar, e.g. openai/text-embedding-3-small,
    // mock/deterministic). Flag > CREWHAUS_EGRESS_EMBEDDER env > default.
    { name: "egress-embedder", takesValue: true },
    // Item 41 — re-validate (parse→lint→compile-in-memory) on every change to
    // the spec / .crewhaus/commands / skills dirs, printing a green/red status
    // per cycle. A pre-run authoring aid; it does NOT re-launch the agent.
    { name: "watch", takesValue: false },
    // Item 27 — run-level spend cap in dollars. Sets/overrides the spec
    // `budget.usd` ceiling and keeps the spec's on_exceed ladder (default
    // `stop`). On reaching the cap the run stops (or degrades) before the
    // next turn.
    { name: "budget-usd", takesValue: true },
    // Loop contract 0.4 (Batch A) — force streaming tool dispatch on for
    // this run (runChatLoop's `streaming` option: tools execute as each
    // tool_use block completes mid-stream). The spec's `agent.streaming`
    // sets the default; the flag wins.
    { name: "streaming", takesValue: false },
    // Loop contract 0.4 (Batch C, G26) — override the spec's
    // `observability.trace.level` for this run: off | ring | pretty | json.
    // pretty/json attach the structured-event-printer; ring keeps only the
    // bus ring buffer (default); off suppresses the printer. The flag wins
    // absolutely over the spec block AND the ambient CREWHAUS_TRACE env.
    { name: "trace", takesValue: true },
    // Item #56 — identify the current user so their
    // `.crewhaus/preferences/<user>.md` is injected at run start (alongside
    // the auto-loaded LESSONS.md). Flag > CREWHAUS_USER env.
    { name: "user", takesValue: true },
    // Item 38 — opt out of the MCP auto-quarantine: register even the tools of
    // servers `crewhaus mcp doctor` marked chronically failing in
    // `.crewhaus/mcp/quarantine.json` (default: withdraw them + inject a notice).
    { name: "no-mcp-quarantine", takesValue: false },
    // Item 3 (G32) — override the spec's `plugins:` list for this run: a
    // comma-separated set of installed plugin names to activate at boot
    // instead of the spec's. `--plugins ""` activates none.
    { name: "plugins", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Loop contract 0.4 (Batch F, item 7, CLI half) — `crewhaus runs resume
// <session>`. The `resume` is the positional <session>, so it is NOT a flag
// here; `--spec` names the backing spec. The rest mirror the run flags a
// resumed continuation honours (they are threaded verbatim into the shared
// resumed run path).
export const RUNS_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "spec", takesValue: true },
    { name: "model", takesValue: true },
    { name: "permission-mode", takesValue: true },
    // Loop contract 0.4 (G11) — `runs resume` re-drives a run that PARKED on a
    // pending approval, so it must accept the same knob the original run did.
    { name: "ask-mode", takesValue: true },
    { name: "prompt", takesValue: true },
    { name: "justification-judge", takesValue: true },
    { name: "no-justification-audit", takesValue: false },
    { name: "egress-matcher", takesValue: true },
    { name: "egress-embedder", takesValue: true },
    { name: "budget-usd", takesValue: true },
    { name: "streaming", takesValue: false },
    { name: "trace", takesValue: true },
    { name: "user", takesValue: true },
    { name: "no-mcp-quarantine", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// Loop contract 0.4 (Batch F, item 2) — `crewhaus dev <spec>`: compile in
// memory, run the bundle as a supervised child, relaunch on change.
export const DEV_SCHEMA: ParseArgsSchema = {
  flags: [
    // Compile + launch once, wait for the child, exit with its code (no watch
    // loop) — the scriptable/CI boot check.
    { name: "once", takesValue: false },
    // Debounce window (ms) for coalescing a burst of fs changes. Default 150.
    { name: "debounce", takesValue: true },
    // Item 3 (G32) — override the spec's `plugins:` list for the launched
    // child: a comma-separated set of installed plugin names compiled into the
    // bundle in place of the spec's. `--plugins ""` activates none. Absent →
    // the spec list is compiled unchanged (a byte-identical bundle).
    { name: "plugins", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 1 (G30) — `crewhaus serve --mcp <spec> [--sse]`: project the spec's
// agent as an MCP server (stdio or HTTP+SSE) so it becomes a tool inside
// Claude Code / an IDE / another CrewHaus runtime.
export const SERVE_SCHEMA: ParseArgsSchema = {
  flags: [
    // Required — the projection kind. `serve` reserves room for other exposure
    // kinds; `--mcp` is the only one today.
    { name: "mcp", takesValue: false },
    // Serve over HTTP+SSE (a `fetch` server) instead of stdio; overrides the
    // spec's `expose.mcp.transport`.
    { name: "sse", takesValue: false },
    // SSE listen port (default 8000, or CREWHAUS_MCP_PORT). Ignored for stdio.
    { name: "port", takesValue: true },
    // Threaded into the projected agent's turn exactly as on `crewhaus run`.
    { name: "model", takesValue: true },
    { name: "permission-mode", takesValue: true },
    { name: "ask-mode", takesValue: true },
    { name: "plugins", takesValue: true },
    { name: "no-mcp-quarantine", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// Item 4 (§59) — `crewhaus export claude-plugin <spec> [--out <dir>]`: emit an
// Anthropic-compatible Claude Code plugin directory from any target shape.
export const EXPORT_SCHEMA: ParseArgsSchema = {
  flags: [
    // Output directory (default: <cwd>/<pluginName>). Refuses to overwrite a
    // non-empty dir without --force.
    { name: "out", short: "o", takesValue: true },
    { name: "force", takesValue: false },
    // Plugin author name/email stamped into .claude-plugin/plugin.json
    // (Anthropic's schema requires a non-empty author; name defaults to
    // "CrewHaus").
    { name: "author", takesValue: true },
    { name: "author-email", takesValue: true },
    // Override the plugin description (default: the IR's name + target).
    { name: "description", takesValue: true },
    // Item 14 — opt OUT of carrying the harness's authored `.crewhaus/skills`
    // + `.crewhaus/commands` into the plugin (default: they travel).
    { name: "no-assets", takesValue: false },
    { name: "help", short: "h" },
  ],
};

export const INIT_SCHEMA: ParseArgsSchema = {
  flags: [
    // Item 44 — also scaffold the eval-on-PR CI workflow. Composable with
    // an existing harness: `init --ci` in a dir that already has a
    // crewhaus.yaml adds just the workflow.
    { name: "ci", takesValue: false },
    // Item 13 — also scaffold eval/dataset.jsonl + eval/graders.yaml (the
    // flywheel's conventional paths) in OFFLINE template mode, so a fresh
    // harness can `crewhaus eval` on day one. Composable with an existing
    // harness like --ci: `init --with-evals` adds just the eval assets.
    { name: "with-evals", takesValue: false },
    // Item 30 — also scaffold .github/workflows/sentinel-drift.yml, the nightly
    // model-drift sentinel cron. Composable with an existing harness like --ci.
    { name: "sentinel", takesValue: false },
    // NEW-HUNT-8 — scaffold the TIERED workflow against a suite manifest:
    // --ci emits fast-tier-on-PR + nightly-tier-on-cron, --sentinel appends a
    // nightly tier step beside the drift probe. Without it both scaffolds are
    // byte-identical to before.
    { name: "suite", takesValue: true },
    // Overwrite an existing scaffolded workflow or eval assets (never the
    // spec).
    { name: "force", takesValue: false },
    // Item 39 — interactive spec authoring: interview the user (via the
    // resolved model, or a scripted stdin questionnaire when no credentials)
    // and emit a parseSpec-validated crewhaus.yaml. Composes with --detect to
    // prefill the model from what's reachable.
    { name: "interactive", short: "i", takesValue: false },
    { name: "detect", takesValue: false },
    // v0.3.0 §2.9 — restart a persisted interview session (the conversation
    // is a runChatLoop session; a crashed/interrupted interview resumes with
    // its ledger and transcript intact).
    { name: "resume", takesValue: false },
    // v0.3.0 §2.9 — skip the conversational interview (scripted
    // questionnaire), mirroring the non-TTY behavior.
    { name: "yes", short: "y", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// Item 13 — `crewhaus scaffold-evals`: starter eval assets FROM the spec.
export const SCAFFOLD_EVALS_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "out", short: "o", takesValue: true },
    { name: "samples", takesValue: true },
    // E47 — start from a first-party eval-template FAMILY (rag, summarize,
    // extract, support, safety, classify) instead of drafting from the spec:
    // a `grader-template` manifest's fully-anchored graders.yaml + seed
    // dataset. The families are EMBEDDED in the CLI (no fetch, no signature
    // to check) and are the only names this flag resolves — there is no
    // `--registry` here, and nothing on this path reads
    // CREWHAUS_TEMPLATE_REGISTRY. The `grader-template` KIND rides
    // template-registry's Ed25519 signing so a registry can carry and verify
    // one, but no consumer fetches it yet. Static content, so this path never
    // calls a model.
    { name: "template", takesValue: true },
    // Model for the one-shot sample-input generation call (model-router
    // grammar); also baked into the emitted llm_judge grader. Without it the
    // spec's own agent.model is used when its credentials are visible, else
    // the deterministic template fallback.
    { name: "model", takesValue: true },
    // Overwrite existing eval assets (default: refuse).
    { name: "force", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// Item 4 — `crewhaus graders suggest`: draft grader suites from failure
// rationale accumulated in recent eval runs + user feedback.
export const GRADERS_SUGGEST_SCHEMA: ParseArgsSchema = {
  flags: [
    // A run dir, or `last:N` (default: the last 10 indexed runs for the cwd
    // spec — the item-3 run-history index).
    { name: "runs", takesValue: true },
    // Model for the one-shot llm_judge rubric draft from real good/bad
    // exemplars (model-router grammar). Without it the cwd spec's model is
    // used when its credentials are visible; else deterministic-only output.
    { name: "model", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    // Override the run-index spec filter (default: the cwd crewhaus.yaml's
    // name when parseable, else unfiltered).
    { name: "spec", takesValue: true },
    // Rating threshold splitting up-rated exemplars from failure evidence
    // (mirrors `distill --min-score`).
    { name: "min-score", takesValue: true },
    // Overwrite an existing review file (default: refuse).
    { name: "force", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// E48 — `crewhaus graders test`: meta-eval every grader in a graders.yaml
// against a labeled golden-verdict JSONL (agreement/kappa/FP-FN per grader).
export const GRADERS_TEST_SCHEMA: ParseArgsSchema = {
  flags: [
    // The graders.yaml whose suite to meta-eval (required).
    { name: "graders", takesValue: true },
    // The golden verdicts JSONL: {id, input, agent_output, expected_passed,
    // expected_score?} per line, strict (required).
    { name: "golden", takesValue: true },
    // Judge model for llm_judge entries without their own model:/judges:
    // (model-router grammar); default claude-sonnet-5.
    { name: "judge-model", takesValue: true },
    // Exit non-zero when any TESTED grader's agreement rate falls below F.
    { name: "min-agreement", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// NEW-HUNT-11 — `crewhaus graders card`: render a graders.yaml as the
// deterministic markdown rubric card (stdout by default, -o writes a file).
export const GRADERS_CARD_SCHEMA: ParseArgsSchema = {
  flags: [
    // The graders.yaml to document (one of --graders / --template).
    { name: "graders", takesValue: true },
    // E47 — document an eval-template FAMILY's rubric without scaffolding it
    // first: the gallery is the discovery surface, and "what does the rag
    // family actually measure" must be answerable before you adopt it.
    { name: "template", takesValue: true },
    // Write the card to a file instead of stdout.
    { name: "out", short: "o", takesValue: true },
    { name: "help", short: "h" },
  ],
};

export const DOCTOR_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "philosophy-alignment", takesValue: false },
    // Item 49 — scope-audit drift watch (compose with --philosophy-alignment):
    //   --json             persist findings to .crewhaus/scope-audit/<date>.json
    //                      (stable ids) and print the snapshot JSON
    //   --baseline         diff against .crewhaus/scope-audit/baseline.json;
    //                      exit non-zero ONLY on NEW findings
    //   --accept-baseline  promote the current findings to the baseline
    { name: "json", takesValue: false },
    { name: "baseline", takesValue: false },
    { name: "accept-baseline", takesValue: false },
    // Process-liveness only — exit 0 fast, no credential/spec checks. The
    // probe target for container HEALTHCHECKs and k8s exec probes.
    { name: "liveness", takesValue: false },
    // Item 17 — context-pressure report over recent sessions (truncation
    // recoveries, compaction fires, snip-vs-autocompact, spec knobs +
    // advise/optimize command hints). Report, not gate: exit 0 always.
    { name: "context-pressure", takesValue: false },
    // How many most-recent sessions --context-pressure scans (default 20).
    { name: "sessions", takesValue: true },
    // Item 24 — model advisory: flag spec models missing from the pricing
    // table (silently billed $0), pricing-table staleness, and known sunsets.
    { name: "models", takesValue: false },
    // Item 37 — SLO/TTFT probe: compare recent p95 TTFT vs the cwd spec's
    // observability.slo.ttft_ms and name faster candidates on a breach.
    // Container-HEALTHCHECK exit semantics (0 within/no-data, 1 breach).
    { name: "slo", takesValue: false },
    { name: "ttft", takesValue: false },
    // Item 40 — `--detect`: read-only inventory of reachable providers, the
    // local Ollama/vLLM endpoint's models, and MCP servers from
    // .mcp.json / Claude Desktop config. `--no-probe` skips the localhost HTTP
    // probe (offline / CI).
    { name: "detect", takesValue: false },
    { name: "no-probe", takesValue: false },
    // Item 40 — `--fix`: apply the mechanical remediations doctor otherwise
    // only prints (scaffold crewhaus.yaml, create .crewhaus/, mark outward
    // tools scope:external, append commented .env stubs). Dry-run is the
    // DEFAULT: without --fix, doctor prints the diff it WOULD apply.
    { name: "fix", takesValue: false },
    // v0.3.0 Goal 6 — `--probe`: opt-in ~1-token live call per configured
    // provider, catching present-but-invalid keys and unfunded accounts
    // BEFORE a long run dies on them. Distinct from --detect's --no-probe
    // (a localhost reachability knob): this one spends real (fractional-
    // cent) tokens, so it is never on by default.
    { name: "probe", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// Item 24 — `crewhaus model-scan`: scheduled market scan. Enumerate
// capability-compatible replacements for the cwd spec's agent.model, eval each
// on the spec's dataset, and emit a proposal (+ patch.json) when a candidate
// beats current on score at lower cost. Proposal-only unless --write.
export const MODEL_SCAN_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "dataset", takesValue: true },
    { name: "graders", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    { name: "concurrency", takesValue: true },
    { name: "seed", takesValue: true },
    { name: "judge-model", takesValue: true },
    // Restrict candidates to same-provider siblings (keeps credentials + cache).
    { name: "same-provider", takesValue: false },
    // Max candidates evaled (cheapest-first). Default 6.
    { name: "limit", takesValue: true },
    // Apply the winning proposal to the spec via a direct comment-preserving
    // CST edit (model fields are outside OPTIMIZABLE_PATHS — this bypasses the
    // optimizer whitelist deliberately; always human-initiated).
    { name: "write", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// Item 24 — `crewhaus pricing sync|show`: load a versioned pricing feed into
// ~/.crewhaus/pricing/ so createCostTracker({pricing}) can override without a
// code release.
export const PRICING_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "file", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 25 — `crewhaus model right-size <spec>`: enumerate → compile → eval
// downshift search for a cheaper model that holds quality. Proposal-only
// unless --write.
export const MODEL_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "dataset", takesValue: true },
    { name: "graders", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    { name: "concurrency", takesValue: true },
    { name: "seed", takesValue: true },
    { name: "judge-model", takesValue: true },
    // Minimum cost drop (fraction, e.g. 0.2 = 20%) to recommend a downshift.
    { name: "min-cost-drop", takesValue: true },
    // Pass-rate tolerance (fraction) a downshift may dip and still recommend.
    { name: "pass-rate-tolerance", takesValue: true },
    // Max candidates per slot (cheapest-first). Default 3.
    { name: "per-slot-limit", takesValue: true },
    // Apply the winning downshift via a direct comment-preserving CST edit.
    { name: "write", takesValue: false },
    // Item 40 — `--detect`: read-only inventory of reachable providers, the
    // local Ollama/vLLM endpoint's models, and MCP servers from
    // .mcp.json / Claude Desktop config. `--no-probe` skips the localhost HTTP
    // probe (offline / CI).
    { name: "detect", takesValue: false },
    { name: "no-probe", takesValue: false },
    // Item 40 — `--fix`: apply the mechanical remediations doctor otherwise
    // only prints (scaffold crewhaus.yaml, create .crewhaus/, mark outward
    // tools scope:external, append commented .env stubs). Dry-run is the
    // DEFAULT: without --fix, doctor prints the diff it WOULD apply.
    { name: "fix", takesValue: false },
    { name: "help", short: "h" },
  ],
};

export const CONTEXT_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "bundle", takesValue: false },
    { name: "out", short: "o", takesValue: true },
    { name: "factory-root", takesValue: true },
    { name: "docs-root", takesValue: true },
    { name: "demos-root", takesValue: true },
    { name: "help", short: "h" },
  ],
};

export const OPTIMIZE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "dataset", takesValue: true },
    { name: "graders", takesValue: true },
    // Item 15 — apply `crewhaus advise` SpecPatches (suggestions.json) via
    // the eval-gated accept/reject/compose loop instead of running the
    // mutation search. Mutually exclusive with --mutator/--iterations;
    // --dataset/--graders/--ratings still resolve as usual (the apply path
    // needs an eval).
    { name: "from-advice", takesValue: true },
    // Inline-distill user ratings into the training set (Pillar 2 — close the
    // loop from real feedback). Value: a session id (sess_<16 hex>) or "all".
    // Synthesizes the dataset (and, when --graders is omitted, the graders too).
    { name: "ratings", takesValue: true },
    { name: "min-score", takesValue: true },
    // B23 — the --ratings inline distill PII/secret-redacts sample text by
    // default (same detector set and opt-out as `crewhaus distill`); this
    // keeps raw text out of the sample pool, the synthesized graders, and
    // the optimizer meta-prompt sent to the mutator model.
    { name: "no-redact", takesValue: false },
    // Item #54 — inject the top-K harvested few-shot examples as in-context
    // demonstrations at the front of the seed instructions the optimizer
    // mutates. Value: a pool file path, or "auto" for the cwd default
    // `.crewhaus/fewshot/<spec>.jsonl`. Composes with --ratings.
    { name: "few-shot", takesValue: true },
    { name: "few-shot-k", takesValue: true },
    { name: "mutator", takesValue: true },
    // D36 — narrow a MULTI-STAGE spec's search to one workflow step / graph
    // node / crew role. Omitted on a multi-stage spec, every stage is
    // optimized sequentially, each gated independently.
    { name: "stage", takesValue: true },
    { name: "iterations", takesValue: true },
    { name: "seed", takesValue: true },
    { name: "concurrency", takesValue: true },
    { name: "improvement-threshold", takesValue: true },
    // FR-003 — dollar ceiling for model-driven runs (composes with --iterations).
    { name: "budget-usd", takesValue: true },
    { name: "write-back", takesValue: false },
    // Item 9 — skip pinning an accepted patch's fail→pass recoveries into
    // the per-spec `<specName>-regressions` registry dataset.
    { name: "no-pin-regressions", takesValue: false },
    // Item 7 — opt out of the runner's default one-shot retry of ERRORED
    // samples inside each candidate's fitness eval (mirrors `eval --no-retry`).
    { name: "no-retry", takesValue: false },
    // Item 46 — after a successful --write-back the working spec changed, so
    // the same auto-register + changelog flow as `compile` runs; this is the
    // explicit opt-out (mirrors `compile --no-register`).
    { name: "no-register", takesValue: false },
    { name: "out", short: "o", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 45 — `crewhaus flywheel run|init`. Knobs mirror the demo's
// FLYWHEEL_* env names (flag > env > default — see ./flywheel.ts).
export const FLYWHEEL_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "dataset", takesValue: true },
    { name: "graders", takesValue: true },
    { name: "budget-usd", takesValue: true },
    { name: "iterations", takesValue: true },
    { name: "seed", takesValue: true },
    { name: "concurrency", takesValue: true },
    { name: "mutator", takesValue: true },
    // D42 — narrow the before/after ACCEPTANCE evals to one registry split
    // (train|dev). Omitted keeps the historical behavior (every split the
    // ref resolved). Refused for flat-file datasets (no split boundaries).
    { name: "gate-split", takesValue: true },
    // Run the whole loop (evals + optimize + acceptance gate) but never
    // write the spec, register, or pin — a rehearsal run.
    { name: "dry-run", takesValue: false },
    // Invariant: the flywheel refuses to run over uncommitted spec changes
    // (a rejected write-back could not be told apart from the user's own
    // edits). This is the explicit opt-out.
    { name: "allow-dirty", takesValue: false },
    // `flywheel init` — overwrite an existing workflow scaffold.
    { name: "force", takesValue: false },
    // NEW-HUNT-8 — `flywheel init --suite <suite.yaml>` appends the nightly
    // TIER step to the scaffolded cron (the same wiring `init --ci|--sentinel
    // --suite` emit). Harness-relative, like every other path in the job.
    { name: "suite", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 60 — `crewhaus plugins {list,search,install,uninstall,publish,outdated}`.
export const PLUGINS_SCHEMA: ParseArgsSchema = {
  flags: [
    // Registry backend: a dir (or file:<dir>) of manifest JSONs, or an
    // http(s):// index URL. Falls back to CREWHAUS_PLUGIN_REGISTRY.
    { name: "registry", takesValue: true },
    // search filter.
    { name: "query", short: "q", takesValue: true },
    // install: pin a version (default latest).
    { name: "version", takesValue: true },
    // Where installed plugins live (default ~/.crewhaus/plugins) + registry file.
    { name: "plugins-dir", takesValue: true },
    { name: "registry-file", takesValue: true },
    // Signing: opt out of fail-closed verification (dev only).
    { name: "allow-unsigned", takesValue: false },
    // publish: the manifest JSON to publish.
    { name: "manifest", takesValue: true },
    // publish/outdated: assemble + print without touching git/gh / network write.
    { name: "dry-run", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// Item 60 — `crewhaus templates {list,search,use}`.
export const TEMPLATES_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "registry", takesValue: true },
    { name: "query", short: "q", takesValue: true },
    { name: "target", takesValue: true },
    // `use`: workspace dir the template scaffolds into (default cwd) + subdir.
    { name: "into", takesValue: true },
    { name: "subdir", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 64 — `crewhaus retire <spec>`. `--archive <dir>` where the evidence
// bundle lands; `--dry-run` prints the plan; `--force` retires despite an
// active pin; `--push-knowledge` shares lessons out first; `--shared` picks
// the shared store for that push.
export const RETIRE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "archive", takesValue: true },
    { name: "dry-run", takesValue: false },
    { name: "force", takesValue: false },
    { name: "push-knowledge", takesValue: false },
    { name: "shared", takesValue: true },
    { name: "root-dir", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 63 — `crewhaus knowledge sync [--pull|--push]`. `--root` scopes the
// fleet discovery; `--shared` overrides the shared-store dir; `--dry-run`
// plans without writing; `--no-redact` skips redaction (dev/local only).
export const KNOWLEDGE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "root", takesValue: true },
    { name: "shared", takesValue: true },
    { name: "pull", takesValue: false },
    { name: "push", takesValue: false },
    { name: "dry-run", takesValue: false },
    { name: "no-redact", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// Item 58 — `crewhaus fleet list|status|run`. `--root` scopes discovery;
// `--filter` narrows a bulk `run`; `--allow-mutating` + per-harness confirm
// gates a mutating bulk op; `--yes` skips the interactive confirm (CI).
export const FLEET_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "root", takesValue: true },
    { name: "filter", takesValue: true },
    { name: "group", takesValue: true },
    { name: "allow-mutating", takesValue: false },
    { name: "yes", short: "y", takesValue: false },
    { name: "help", short: "h" },
  ],
};

export const EVAL_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "dataset", takesValue: true },
    { name: "graders", takesValue: true },
    { name: "judge-model", takesValue: true },
    { name: "concurrency", takesValue: true },
    { name: "seed", takesValue: true },
    // Loop contract 0.4 (Batch B, G15) — trials per sample: run every sample
    // K times (seed-offset when --seed is set); aggregates gain pass@K /
    // pass^K and the per-sample results carry per-trial grades.
    { name: "repeats", takesValue: true },
    // B13 — metadata keys to slice the results by (comma-separated; default
    // family,difficulty,language,source — applied only where present in
    // sample metadata as strings). Per-slice figures land in results.json
    // (`slices`), the stdout block, and the report's slice table.
    { name: "slice", takesValue: true },
    // Item 11 — benchmark matrix: run the same dataset+graders once per
    // model; each cell writes to <out>/<model-slug>/. Incompatible with
    // --gate/--no-promote (cells skip the run-history lineage entirely).
    { name: "models", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    // Run-history item 3 — exit non-zero when the run regresses against the
    // pinned (spec, dataset) baseline (regression-runner gate, strict
    // defaults: any pass-rate drop or sample-level pass→fail flip fails).
    { name: "gate", takesValue: false },
    // C30 — pre-declared ops thresholds for the baseline gate: fail the
    // verdict when p95 per-sample latency rose more than N ms vs the
    // baseline, or when the run's estimated agent-model cost exceeds $F
    // (exits non-zero under --gate). Absent = pass-rate/flip-only gating.
    { name: "max-p95-latency-ms", takesValue: true },
    { name: "max-cost-usd", takesValue: true },
    // NEW-HUNT-3 — runtime ceilings, overriding the spec's own blocks:
    // --sample-timeout-ms > limits.deadline_ms (per-sample watchdog),
    // --budget-usd > budget.usd (run-level spend cap; queued samples abort
    // at the cap and results.json is marked partial).
    { name: "sample-timeout-ms", takesValue: true },
    { name: "budget-usd", takesValue: true },
    // NEW-HUNT-4 — tool record/replay. --record-tools <dir> appends every
    // tool execution's result to <dir>/tools.jsonl keyed by (sampleId,
    // toolName, sha256(canonical-JSON args)); --replay-tools <dir> serves
    // those results instead of executing (mutually exclusive), with
    // --replay-miss error|live governing unrecorded calls.
    { name: "record-tools", takesValue: true },
    { name: "replay-tools", takesValue: true },
    { name: "replay-miss", takesValue: true },
    // NEW-HUNT-6 — resume an interrupted run: re-open <runDir>, keep its
    // runId, skip samples that already wrote grades.json, run the rest, and
    // re-aggregate the union.
    { name: "resume", takesValue: true },
    // Run-history item 3 — keep the existing baseline pin instead of
    // auto-promoting this run on gate pass (also skips the first-run pin).
    { name: "no-promote", takesValue: false },
    // Item 9 — skip the default union of the per-spec
    // `<specName>-regressions` registry dataset into the loaded dataset.
    // Item 7 — ALSO skips the failure-arbiter's bug-sample pin into that
    // suite (opting out of regression-suite integration means no writes
    // to it either).
    { name: "no-regressions", takesValue: false },
    // B16 — explicit opt-in to consume an explicit `#test` registry ref
    // (the locked held-out split; meant for release-gate runs only). Bare
    // refs always resolve train+dev regardless of this flag, and
    // optimize/flywheel refuse #test outright.
    { name: "allow-test-split", takesValue: false },
    // Item 7 — opt out of the runner's default one-shot retry of ERRORED
    // samples (infra noise, not graded failures).
    { name: "no-retry", takesValue: false },
    // NEW-HUNT-10 — skip the pre-spend lint-lite (duplicate sample ids +
    // grader↔dataset gold mismatch). The preflight is offline and refuses
    // BEFORE any model call; this is the explicit escape hatch.
    { name: "no-preflight", takesValue: false },
    // Item 30 — nightly model-drift sentinel: re-run the (seed-pinned) dataset
    // against the UNCHANGED spec and diff against a frozen baseline run dir;
    // any flip/score-shift when specHash AND dataset-hash are both unchanged is
    // provider drift → exit non-zero. --baseline points at the frozen run dir.
    { name: "sentinel", takesValue: false },
    { name: "baseline", takesValue: true },
    // Item 65 — voice replay eval: replay recorded call-session logs through
    // the voice grader pack (latency / barge-in / transcript) instead of the
    // text model-driven eval. --replay-dir points at the recorded session
    // JSONLs (default .crewhaus/voice-replays). Latency budgets via --max-*.
    // D46 — the shared --graders flag additionally applies CONTENT graders to
    // each replayed transcript (absent = the latency-only pack, as before).
    { name: "voice", takesValue: false },
    { name: "replay-dir", takesValue: true },
    { name: "max-ttft-ms", takesValue: true },
    { name: "max-turn-latency-ms", takesValue: true },
    { name: "max-barge-in-yield-ms", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 6 — `crewhaus eval coverage`: detect agent behaviors present in
// production sessions that no eval sample exercises.
export const EVAL_COVERAGE_SCHEMA: ParseArgsSchema = {
  flags: [
    // How many of the cwd spec's most-recent sessions to scan (default 50; `all`).
    { name: "sessions", takesValue: true },
    // Intersect against a dataset's expected_tools (file or registry:<ref>);
    // defaults to the conventional eval/dataset.jsonl next to the cwd spec.
    { name: "dataset", takesValue: true },
    // D44 — the grader-side coverage join: which graders can score which
    // samples, which declared graders never ran, and which judge criteria
    // never varied across the inspected runs. Omitted = dataset-side report
    // only (every pre-D44 invocation renders identically).
    { name: "graders", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    { name: "format", takesValue: true },
    { name: "help", short: "h" },
  ],
};

export const EVAL_REPORT_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "out", short: "o", takesValue: true },
    // C29 — pins `diff`'s Monte Carlo significance draw + bootstrap CI
    // (defaults to a fixed seed, so unseeded diffs are still deterministic).
    { name: "seed", takesValue: true },
    // NEW-stats-1 — `diff`'s score-shift tolerance (default 0.1): how far a
    // score may move, verdict unchanged, before the diff calls it a shift.
    { name: "epsilon", takesValue: true },
    // A1 — opt-in head-to-head judging of the two runs' outputs (2 judge
    // calls per shared sample, order swapped; requires judge credentials).
    { name: "pairwise", takesValue: false },
    { name: "judge-model", takesValue: true },
    // `history` / `baseline show` / `trends` filters.
    { name: "spec", takesValue: true },
    { name: "dataset", takesValue: true },
    // C32 — `export`: which runs to flatten (a run dir, a comma-separated
    // list of them, or `last:N` from the history index) and in what format.
    { name: "runs", takesValue: true },
    { name: "format", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// E49 — `crewhaus redteam generate|report`: the generated attack suite
// (behaviour categories × attack strategies) and its attack-success-rate
// report. EVERY flag either action takes lives here (the shared-schema
// convention: one schema per verb, actions branch inside).
export const REDTEAM_SCHEMA: ParseArgsSchema = {
  flags: [
    // generate — the spec under test (default: ./crewhaus.yaml). Names the
    // emitted dataset (<spec>-redteam) and seeds the model-variant prompt.
    { name: "spec", takesValue: true },
    // generate — a custom behaviour taxonomy (strict schema); default: the
    // shipped first-party taxonomy.
    { name: "taxonomy", takesValue: true },
    // generate — cap on emitted probes (the cross product is truncated).
    { name: "count", takesValue: true },
    // generate — deterministic rotation of the walk order.
    { name: "seed", takesValue: true },
    // generate — dollar cap for OPTIONAL model-rephrased variants (the
    // deterministic corpus needs no credentials at all).
    { name: "budget-usd", takesValue: true },
    { name: "model", takesValue: true },
    // generate — registry dataset name (default <spec>-redteam) + where the
    // paired refusal graders.yaml is written.
    { name: "out-dataset", takesValue: true },
    { name: "out-graders", takesValue: true },
    { name: "force", takesValue: false },
    // report — which runs to compute ASR over: a run dir, a comma-separated
    // list of them, or last:N from the run-history index.
    { name: "runs", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// NEW-HUNT-8 — `crewhaus eval suite <suite.yaml>`: run a named CI tier of
// (dataset, graders, flags) entries and aggregate one suite verdict.
export const EVAL_SUITE_SCHEMA: ParseArgsSchema = {
  flags: [
    // Which tier to run (default: fast — the per-change tier).
    { name: "tier", takesValue: true },
    // Override every entry's spec (the CI scaffold points the base-branch
    // run at the base checkout's spec with exactly this).
    { name: "spec", takesValue: true },
    // Suite output root; each entry writes <out>/<entry>/ (default
    // .crewhaus/evals/suite_<tier>_<timestamp>).
    { name: "out", short: "o", takesValue: true },
    // Exit non-zero when the tier verdict fails (report-only without it).
    { name: "gate", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// C28 — `crewhaus eval plan`: offline sample-size planning (no run, no
// credentials, no spend — just the arithmetic and where its terms came from).
export const EVAL_PLAN_SCHEMA: ParseArgsSchema = {
  flags: [
    // The smallest pass-rate change worth detecting, as a fraction (0.05 = 5pp).
    { name: "target-delta", takesValue: true },
    // Two-sided confidence level (default 0.95).
    { name: "confidence", takesValue: true },
    // A previous run directory whose measured pass rate seeds p (else 0.5).
    { name: "pilot", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// D41 — `crewhaus schedule generate`: print ready-to-install scheduling text
// for the recurring eval surfaces, for teams not on GitHub Actions.
export const SCHEDULE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "for", takesValue: true },
    { name: "runner", takesValue: true },
    // Working directory the scheduled command runs in (default: cwd).
    { name: "dir", takesValue: true },
    // Command inputs (defaults: crewhaus.yaml, eval/dataset.jsonl,
    // eval/graders.yaml, eval/sentinel-baseline).
    { name: "spec", takesValue: true },
    { name: "dataset", takesValue: true },
    { name: "graders", takesValue: true },
    { name: "baseline", takesValue: true },
    { name: "help", short: "h" },
  ],
};

export const COST_SUMMARY_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "session", takesValue: true },
    { name: "tenant", takesValue: true },
    { name: "format", takesValue: true },
    { name: "help", short: "h" },
  ],
};

export const ADVISE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "session", takesValue: true },
    { name: "all" },
    { name: "json" },
    { name: "out", short: "o", takesValue: true },
    { name: "help", short: "h" },
  ],
};

export const TOOLS_SCHEMA: ParseArgsSchema = {
  flags: [{ name: "sessions", takesValue: true }, { name: "json" }, { name: "help", short: "h" }],
};

export const PERMISSIONS_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "sessions", takesValue: true },
    { name: "apply" },
    { name: "json" },
    { name: "help", short: "h" },
  ],
};

export const RATE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "session", takesValue: true },
    { name: "turn", takesValue: true },
    { name: "thumbs", takesValue: true },
    { name: "stars", takesValue: true },
    { name: "score", takesValue: true },
    { name: "comment", takesValue: true },
    { name: "rater", takesValue: true },
    // B19 — mark the record as an ADJUDICATION: at distill time it always
    // wins a multi-rater disagreement on this turn and closes it.
    { name: "adjudicate", takesValue: false },
    { name: "help", short: "h" },
  ],
};

export const FEEDBACK_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "session", takesValue: true },
    { name: "turn", takesValue: true },
    { name: "text", takesValue: true },
    { name: "correction", takesValue: true },
    { name: "rater", takesValue: true },
    // B19 — see RATE_SCHEMA: an adjudication settles a rater disagreement
    // on the turn. On this surface it REQUIRES --correction (a comment alone
    // carries no verdict — buildFeedbackRecord rejects the combination).
    { name: "adjudicate", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// Wave 3 (B20) — `crewhaus review list|next|resolve <id>` over the
// persistent human-review queue (.crewhaus/review/queue.jsonl).
export const REVIEW_SCHEMA: ParseArgsSchema = {
  flags: [
    // list/next: filter to one kind (abstained | needs_review |
    // rater_disagreement | quarantine).
    { name: "kind", takesValue: true },
    // list: include resolved items (default: open only).
    { name: "all", takesValue: false },
    // resolve: the recorded resolution note.
    { name: "note", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Loop contract 0.4 (Batch C, G11) — `crewhaus approvals list|show|grant|deny`
// over the session-store approvals store (`.crewhaus/sessions/approvals.jsonl`).
export const APPROVALS_SCHEMA: ParseArgsSchema = {
  flags: [
    // Harness root that owns `.crewhaus/` (mirrors `security digest --dir`).
    { name: "dir", takesValue: true },
    // The deciding identity recorded on grant/deny (flag > CREWHAUS_USER > "cli").
    { name: "by", takesValue: true },
    // grant only — the grant applies to the next matching tool call only
    // (default; the runtime consumes a grant on use). Explicit for scripting.
    { name: "once", takesValue: false },
    // grant only (#383) — a STANDING allow: grants this call AND persists an
    // `alwaysAllow` rule for the tool into `.crewhaus/settings.json`, so
    // future calls (any input) run pre-approved on this harness.
    { name: "always", takesValue: false },
    { name: "json", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// G63 — `crewhaus failures report`: cluster run_failed + incident records.
export const FAILURES_SCHEMA: ParseArgsSchema = {
  flags: [
    // Harness root that owns `.crewhaus/` (mirrors `security digest --dir`).
    { name: "dir", takesValue: true },
    // How many recent sessions to scan (default all); `all` is explicit.
    { name: "sessions", takesValue: true },
    // Draft failure_taxonomy entries from the clusters (reuses the advise
    // drafting machinery + specificity floor).
    { name: "propose-taxonomy", takesValue: false },
    // Write the drafted failure_taxonomy YAML to a file (else printed to stdout).
    { name: "out", short: "o", takesValue: true },
    { name: "json", takesValue: false },
    { name: "help", short: "h" },
  ],
};

export const DISTILL_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "session", takesValue: true },
    { name: "all-sessions", takesValue: false },
    { name: "out", short: "o", takesValue: true },
    { name: "graders-out", takesValue: true },
    { name: "min-score", takesValue: true },
    { name: "judge", takesValue: false },
    { name: "judge-model", takesValue: true },
    // Item 12 — promote the distilled samples into the dataset registry as a
    // new auto-bumped version of <name> (deterministic 70/15/15
    // train/dev/test split), consumable as `--dataset registry:<name>`.
    // -o becomes optional when given; plain file output stays the default.
    { name: "register", takesValue: true },
    // B23 — opt out of the default PII/secret redaction of distilled sample
    // text (dev/local only; the unattended feedback.autoDistill teardown
    // always redacts).
    { name: "no-redact", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// Item #54 — `crewhaus fewshot harvest|show`: mine up-rated turns into a
// golden few-shot pool consumable by `optimize --few-shot`.
export const FEWSHOT_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "session", takesValue: true },
    { name: "all-sessions", takesValue: false },
    { name: "min-score", takesValue: true },
    // Override the pool file (default `.crewhaus/fewshot/<spec>.jsonl`).
    { name: "out", short: "o", takesValue: true },
    // show/inject: how many top examples to print/format (default 5).
    { name: "k", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item #55 — `crewhaus faq distill`: cluster recurring user questions into an
// auto-discovered FAQ SKILL.md under `.crewhaus/skills/faq/`.
export const FAQ_SCHEMA: ParseArgsSchema = {
  flags: [
    // How many recent sessions to scan (default all; `N` or `all`).
    { name: "sessions", takesValue: true },
    { name: "min-score", takesValue: true },
    // Minimum recurrences for a question cluster to become an FAQ (default 2).
    { name: "min-occurrences", takesValue: true },
    // Override the emitted skill directory (default `.crewhaus/skills/faq`).
    { name: "out", short: "o", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item #56 — `crewhaus lessons update`: mine corrections + failure→fix
// patterns into a deduped LESSONS.md and maintain per-user preference files.
export const LESSONS_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "sessions", takesValue: true },
    { name: "low-score", takesValue: true },
    // Override the LESSONS.md path (default `<cwd>/LESSONS.md`).
    { name: "out", short: "o", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item #57 — `crewhaus sessions summarize`: fold sessions into a durable index
// (on demand, or before TTL eviction with --evicted).
export const SESSIONS_SCHEMA: ParseArgsSchema = {
  flags: [
    // Only summarize sessions last modified strictly BEFORE this date (ISO or
    // epoch-ms). Omitted → every session in the store.
    { name: "before", takesValue: true },
    // Run a TTL eviction pass and summarize each session into the index BEFORE
    // it is unlinked (the summarize-before-evict hook).
    { name: "evicted", takesValue: false },
    // TTL for the --evicted eviction pass (days). Default: session-store's 30.
    { name: "ttl-days", takesValue: true },
    // Loop contract 0.4 (Batch B, G53) — `sessions export`: the export shape
    // (only "trajectories" today) and where the JSONL lands (default stdout).
    { name: "format", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    // Loop contract 0.4 (Batch F, item 2) — `sessions tail`: which session dir
    // to read (default cwd/.crewhaus/sessions), the follow-poll interval, and
    // --no-follow to dump-and-exit (the scriptable/CI mode).
    { name: "dir", takesValue: true },
    { name: "interval", takesValue: true },
    { name: "no-follow", takesValue: false },
    // 0.6.0 (design §8.2) — `sessions tail` renders route / cost / eval /
    // stage lines by default; this restores the transcript-only view.
    { name: "transcript-only", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// 0.3.0 memory release (design §3.4) — `crewhaus memory list|show|forget|sweep`.
export const MEMORY_SCHEMA: ParseArgsSchema = {
  flags: [
    // Which spec's memory file to operate on. `list`/`sweep` default to every
    // file under .crewhaus/memories/; `show`/`forget` auto-resolve only when a
    // single file exists.
    { name: "spec", takesValue: true },
    // forget — a text query instead of an exact id (forgets EVERY match).
    { name: "query", short: "q", takesValue: true },
    // forget / sweep --compact — skip the confirmation prompt (scripted/CI).
    { name: "yes", takesValue: false },
    // sweep — additionally rewrite the file(s) dropping tombstoned/expired
    // lines (atomic tmp+rename; the growth-bounding compaction).
    { name: "compact", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// 0.3.0 memory release — `crewhaus migrate memories [--dry-run]`: backfill
// schemaVersion + derivable provenance onto v1 entries, stamp .crewhaus/meta.json.
export const MIGRATE_MEMORIES_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "dry-run", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// 0.3.0 memory release (design §3.1, PR 9) — `crewhaus wiki list|show|search|stats`.
export const WIKI_SCHEMA: ParseArgsSchema = {
  flags: [
    // Which spec's wiki to operate on. `list`/`stats` default to every wiki
    // under .crewhaus/wiki/; `show`/`search` auto-resolve only when a single
    // wiki exists.
    { name: "spec", takesValue: true },
    // list — filter to articles carrying EVERY listed tag (comma-separated).
    { name: "tags", takesValue: true },
    // list — filter by article status (draft|published|review|archived|all).
    { name: "status", takesValue: true },
    // search — max results to print. Default 10.
    { name: "k", short: "k", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 12 — the dataset-registry CLI face (`datasets list|get|put`); Wave 3
// cluster C added verify/status/release/card.
export const DATASETS_SCHEMA: ParseArgsSchema = {
  flags: [
    // `put` — the file to import (any @crewhaus/eval-dataset format).
    { name: "file", takesValue: true },
    // `get` — print one split verbatim instead of the all-splits merge.
    // `put` — import everything into this single named split.
    { name: "split", takesValue: true },
    // `put` — train/dev[/test] percentages for the deterministic split.
    { name: "split-spec", takesValue: true },
    // `put` (B18) — inject the version's ONE deterministic contamination
    // canary sample (hex phrase from the name+version hash; source: canary).
    { name: "canary", takesValue: false },
    // `release` (NEW-HUNT-9) — the spec + graders for the sanctioned
    // test-split eval, and the double-release override.
    { name: "spec", takesValue: true },
    { name: "graders", takesValue: true },
    { name: "force", takesValue: false },
    // `status` (B17) — how many recent joined runs feed the saturation join.
    { name: "runs", takesValue: true },
    // `card` (B21) — write the markdown datasheet to a file instead of stdout.
    { name: "out", short: "o", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 2 — the `dataset` (singular) growth subcommand family:
// `dataset mine` + `dataset synthesize` (+ item-5 `dataset refresh-goldens`).
export const DATASET_SCHEMA: ParseArgsSchema = {
  flags: [
    // mine — how many recent sessions to scan (default 50; `all`).
    { name: "sessions", takesValue: true },
    // mine — register accepted candidates into this mined registry dataset
    // (default <spec>-hardcases).
    { name: "out-dataset", takesValue: true },
    // mine — accept/reject quarantined candidates (interactive in a TTY;
    // non-TTY prints the list unless --yes is also given).
    { name: "review", takesValue: false },
    // mine — required in non-TTY alongside --review to promote candidates
    // non-interactively (F3: --review alone must never silently auto-accept).
    { name: "yes", takesValue: false },
    // synthesize — the source dataset (file or registry:<ref>) to grow from.
    { name: "from", takesValue: true },
    // synthesize — how many variants to generate per source sample.
    { name: "count", takesValue: true },
    // synthesize — dollar cap for model paraphrases (budget-gate pattern).
    { name: "budget-usd", takesValue: true },
    // refresh-goldens (item 5) — the dataset whose golds to reconcile.
    // audit (B23) — the dataset to scan; --apply shared with refresh-goldens.
    { name: "dataset", takesValue: true },
    { name: "min-score", takesValue: true },
    { name: "apply", takesValue: false },
    // Model for synthesize paraphrases / refresh (model-router grammar).
    { name: "model", takesValue: true },
    // mine (B23) — write candidates verbatim, skipping the default
    // PII/secret redaction (dev/local parity with `distill --no-redact`).
    { name: "no-redact", takesValue: false },
    // audit (B23) — explicit scan-category selector; PII/secret is the only
    // audit today, so a bare `dataset audit` implies it.
    { name: "pii", takesValue: false },
    // audit (B23) + lint (B26) — exit non-zero on any hit/finding (CI gate).
    { name: "strict", takesValue: false },
    // lint (B26) — lint every registered dataset's latest version.
    { name: "all", takesValue: false },
    // lint (B26) — explicit graders.yaml for the grader↔dataset checks
    // (default: the conventional eval/graders.yaml when present).
    { name: "graders", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 8 — `crewhaus judge calibrate`: pair human ratings with llm_judge
// scores over the rated transcript turns.
export const JUDGE_SCHEMA: ParseArgsSchema = {
  flags: [
    // The dataset providing sample context for the judge (file or registry).
    { name: "dataset", takesValue: true },
    // A graders.yaml whose llm_judge rubric to calibrate (else a default rubric).
    { name: "graders", takesValue: true },
    // How many recent sessions' rated turns to calibrate against (default 50; `all`).
    { name: "sessions", takesValue: true },
    // The judge model (model-router grammar); default claude-sonnet-5.
    { name: "model", takesValue: true },
    // Persist the calibrated --min-score default to .crewhaus/judge-calibration.json.
    { name: "apply", takesValue: false },
    { name: "help", short: "h" },
  ],
};

export const STATE_SCHEMA: ParseArgsSchema = {
  flags: [
    // backup
    { name: "out", short: "o", takesValue: true },
    { name: "exclude", takesValue: true },
    // restore
    { name: "into", takesValue: true },
    { name: "merge", takesValue: true },
    { name: "force", takesValue: false },
    { name: "help", short: "h" },
  ],
};

export const SANDBOX_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "probe", takesValue: false },
    { name: "format", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 38 — `crewhaus mcp doctor [--probe]`: per-server health scoring, drift
// watch, runtime auto-quarantine decision.
export const MCP_SCHEMA: ParseArgsSchema = {
  flags: [
    // Live `listTools` probe for drift watch (offline without it, scoring only).
    { name: "probe", takesValue: false },
    { name: "format", takesValue: true },
    // How many most-recent sessions to score (default 20).
    { name: "sessions", takesValue: true },
    { name: "help", short: "h" },
  ],
};

export const COMPLIANCE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "framework", takesValue: true },
    // Item 34 — collect every registered framework in one (schedulable) run.
    { name: "all-frameworks", takesValue: false },
    { name: "control", takesValue: true },
    // Accepts a literal period label (e.g. 2026-Q2) or "current" (the current
    // UTC quarter) so a cron job never hardcodes a stale label.
    { name: "period", takesValue: true },
    { name: "audit-dir", takesValue: true },
    { name: "out-dir", takesValue: true },
    { name: "signing-key-env", takesValue: true },
    // Item 34 / ops-review F4 — opt IN to the empty-evidence tripwire: with
    // this flag a control that collected 0 records exits 1 (for scheduled
    // runs); the default is exit 0 with a warning so documented bare
    // invocations keep working.
    { name: "fail-on-empty", takesValue: false },
    { name: "help", short: "h" },
  ],
};

export const AUDIT_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "dir", takesValue: true },
    { name: "anchor", takesValue: true },
    { name: "help", short: "h" },
  ],
};

export const RETENTION_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "dry-run", takesValue: false },
    { name: "dir", takesValue: true },
    { name: "since", takesValue: true },
    { name: "before", takesValue: true },
    { name: "help", short: "h" },
  ],
};

export const SECURITY_SCHEMA: ParseArgsSchema = {
  flags: [
    // Item 48 — `security digest` rollup window: 7d (default), 30d, or ISO.
    { name: "since", takesValue: true },
    { name: "format", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    // POST the JSON digest to a webhook (plain fetch — see security-digest.ts
    // for the deliberate no-channel-adapter decision + the Slack wrapper note).
    { name: "notify", takesValue: true },
    // Harness root that owns `.crewhaus/` (mirrors `retention --dir`).
    { name: "dir", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// AUTOMATION-OPPORTUNITIES.md item 50 — `security corpus [check]`.
export const SECURITY_CORPUS_SCHEMA: ParseArgsSchema = {
  flags: [
    // rollup window over session logs: <N>d or ISO (default all-time).
    { name: "since", takesValue: true },
    // harness root that owns .crewhaus/ (mirrors `security digest --dir`).
    { name: "dir", takesValue: true },
    // minimum distinct-snippet cluster support to emit a candidate rule.
    { name: "min-support", takesValue: true },
    { name: "json", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// AUTOMATION-OPPORTUNITIES.md item 20 — `egress review [--propose]`.
export const EGRESS_SCHEMA: ParseArgsSchema = {
  flags: [
    // harness root that owns .crewhaus/audit (mirrors `security digest --dir`).
    { name: "dir", takesValue: true },
    // write the eval-gated SpecPatch suggestions to a suggestions.json that
    // `optimize --from-advice` can consume (mirrors `advise -o`).
    { name: "propose", takesValue: false },
    { name: "out", short: "o", takesValue: true },
    { name: "json", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// AUTOMATION-OPPORTUNITIES.md item 51 — `pii tune`.
export const PII_SCHEMA: ParseArgsSchema = {
  flags: [
    // how many recent sessions to scan (default 50; `all`).
    { name: "sessions", takesValue: true },
    // harness root that owns .crewhaus/ (mirrors `security digest --dir`).
    { name: "dir", takesValue: true },
    // HMAC key for hashing PII values (also read from CREWHAUS_PII_HASH_SECRET).
    // MUST match the redactor's secret for the emitted policy to apply.
    { name: "secret", takesValue: true },
    // write the reviewed allow-list to <dir>/.crewhaus/pii-policy.json.
    { name: "write", takesValue: false },
    { name: "json", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// AUTOMATION-OPPORTUNITIES.md item 66 — `onchain tune|sentinel`.
export const ONCHAIN_SCHEMA: ParseArgsSchema = {
  flags: [
    // receipt-history JSONL (default .crewhaus/onchain/receipts.jsonl).
    { name: "history", takesValue: true },
    // tune — headroom multiplier over observed max spend for the cap (default 1.25).
    { name: "cap-margin", takesValue: true },
    // tune — write the proposed transaction_policy SpecPatch here (default
    // .crewhaus/onchain/policy-patch.json); advice-only when not whitelisted.
    { name: "out", short: "o", takesValue: true },
    // sentinel — baseline history to learn from. When omitted, sentinel
    // self-compares --history against itself using a leave-one-out
    // per-contract max (each receipt's ceiling excludes its own value) so a
    // lone spike is still measured against its peers, not itself. When
    // --baseline is given, --history is the candidate window instead.
    { name: "baseline", takesValue: true },
    // sentinel — anomaly threshold: flag spend > N× the per-contract max (default 2).
    { name: "max-multiple", takesValue: true },
    { name: "json", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// AUTOMATION-OPPORTUNITIES.md item 68 — `crewhaus loadtest`.
export const LOADTEST_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "concurrency", short: "c", takesValue: true },
    // total requests to send (`-n`).
    { name: "requests", short: "n", takesValue: true },
    { name: "duration", takesValue: true },
    { name: "rps", takesValue: true },
    { name: "format", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    // gate mode: exit 1 when p95 latency / error rate exceed the thresholds.
    { name: "gate", takesValue: false },
    { name: "max-p95-ms", takesValue: true },
    { name: "max-error-rate", takesValue: true },
    // deterministic stub-model latency (ms/request) for a credential-free run.
    { name: "stub-latency-ms", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// AUTOMATION-OPPORTUNITIES.md item 67 — `crewhaus intents`.
export const INTENTS_SCHEMA: ParseArgsSchema = {
  flags: [
    // how many of the cwd spec's most-recent sessions to scan (default 100; `all`).
    { name: "sessions", takesValue: true },
    { name: "format", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    // how many entries to surface per view (default 5).
    { name: "top", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// "Watch me" (design/watch-me.md §11) — `crewhaus watchme
// start|stop|status|report|intents|synthesize|publish`. EVERY flag any action
// accepts is declared here (parseArgs throws ArgParseError on an undeclared
// flag); per-action validation lives in the handler.
export const WATCHME_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "spec", takesValue: true },
    // Global watchme root override (default ~/.crewhaus/watchme, or the
    // CREWHAUS_WATCHME_ROOT env) — tests always pass it (CI sandboxes).
    { name: "root", takesValue: true },
    { name: "session", takesValue: true },
    { name: "all" },
    { name: "out", short: "o", takesValue: true },
    { name: "json" },
    { name: "name", takesValue: true },
    { name: "force" },
    { name: "interactive" },
    { name: "propose" },
    { name: "feed-routing" },
    { name: "emit-feedback" },
    { name: "no-model" },
    { name: "dry-run" },
    { name: "forget" },
    { name: "help", short: "h" },
  ],
};

// AUTOMATION-OPPORTUNITIES.md item 52 — `justification calibrate|preflight`.
export const JUSTIFICATION_SCHEMA: ParseArgsSchema = {
  flags: [
    // calibrate — how many recent sessions to fold for the outcome proxy.
    { name: "sessions", takesValue: true },
    // harness root that owns .crewhaus/ (mirrors `security digest --dir`).
    { name: "dir", takesValue: true },
    // preflight — the session goal (spec agent.instructions) is read from the
    // <spec> positional; this overrides it for ad-hoc replay.
    { name: "goal", takesValue: true },
    { name: "json", takesValue: false },
    { name: "help", short: "h" },
  ],
};

export const CHANNEL_SCHEMA: ParseArgsSchema = {
  flags: [
    // Item 61 — `channel provision|verify` platform selection + daemon origin.
    { name: "platform", takesValue: true },
    { name: "base-url", takesValue: true },
    // provision only: directory the Slack manifest YAML is written into.
    { name: "out", short: "o", takesValue: true },
    // print every network call (redacted) without performing it.
    { name: "dry-run", takesValue: false },
    // verify only: run the boot-gate env checks and NOTHING else, so the
    // verdict is a function of the environment alone (deterministic
    // pre-flight — the live auth.test made it a function of the network).
    { name: "offline", takesValue: false },
    // provision (discord) only: overwrite a DIFFERENT pre-existing
    // interactions_endpoint_url — read-before-write refuses without it
    // (mirrors `state restore --force`).
    { name: "force", takesValue: false },
    { name: "help", short: "h" },
  ],
};

export const SECRETS_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "backend", takesValue: true },
    { name: "root-dir", takesValue: true },
    { name: "value", takesValue: true },
    { name: "help", short: "h" },
  ],
};

export const SPEC_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "root-dir", takesValue: true },
    { name: "tenant", takesValue: true },
    { name: "help", short: "h" },
  ],
};

export const DEPLOY_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "root-dir", takesValue: true },
    { name: "tenant", takesValue: true },
    { name: "actor", takesValue: true },
    // Item 59 — approval gate: a protected env (per .crewhaus/environments.json)
    // needs a recorded approval quorum / green PR check before the pin flips.
    { name: "require-approval", takesValue: false },
    // Consult a PR check as an approval witness (drives `gh pr checks`).
    { name: "check-pr", takesValue: false },
    // Item 29 — `deploy canary <spec> <version>` eval-gated ramp flags
    // (previously misfiled on PROPOSE_SCHEMA, which made every documented
    // canary invocation die at arg parse with `unknown flag: --dataset`).
    { name: "traffic", takesValue: true },
    { name: "dataset", takesValue: true },
    { name: "graders", takesValue: true },
    { name: "env", takesValue: true },
    { name: "name", takesValue: true },
    { name: "from", takesValue: true },
    { name: "concurrency", takesValue: true },
    { name: "seed", takesValue: true },
    { name: "judge-model", takesValue: true },
    // Gate threshold overrides (regression-runner GateThresholds).
    { name: "max-pass-rate-drop", takesValue: true },
    { name: "max-p95-latency-ms", takesValue: true },
    // B16 — canary is a release-gating flow, i.e. a sanctioned spender of the
    // held-out split: an explicit #test dataset ref is consumable here behind
    // the same opt-in as `crewhaus eval`.
    { name: "allow-test-split", takesValue: false },
    // E50 — write the deterministic variant assignment + record per-version
    // eval outcomes into the experiment ledger. NOT a live traffic split; see
    // the boundary note in `deploy --help`.
    { name: "traffic-split", takesValue: false },
    { name: "experiment", takesValue: true },
    { name: "experiment-dir", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// E50 — `crewhaus experiment <status|record|assign>`: the honest subset of an
// online A/B experiment CrewHaus can actually reach — deterministic
// per-request version selection plus per-version outcome accounting.
export const EXPERIMENT_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "name", takesValue: true },
    { name: "version", takesValue: true },
    { name: "outcome", takesValue: true },
    { name: "score", takesValue: true },
    { name: "rating", takesValue: true },
    { name: "key", takesValue: true },
    { name: "source", takesValue: true },
    { name: "control", takesValue: true },
    { name: "min-n", takesValue: true },
    { name: "json", takesValue: false },
    { name: "dir", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Loop contract 0.4 (Batch F, item 5) — `crewhaus deploy <fly|render|railway|
// heroku> <spec>`. Scaffolds provider manifests; `--live` (token-gated) drives
// the cloud-adapter-* engine's API deploy.
export const CLOUD_DEPLOY_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "out", short: "o", takesValue: true },
    { name: "app", takesValue: true },
    { name: "image", takesValue: true },
    { name: "region", takesValue: true },
    // Perform the API deploy (gated on the provider token); default is
    // scaffold-only.
    { name: "live", takesValue: false },
    // Provider-specific live-deploy inputs.
    { name: "project", takesValue: true }, // railway projectId
    { name: "org", takesValue: true }, // fly org slug
    { name: "owner", takesValue: true }, // render ownerId
    { name: "help", short: "h" },
  ],
};

// Item 59 — `crewhaus propose <proposed-spec.yaml>`: package a spec change
// into a review artifact + open a PR (the governance wrapper around
// optimize/advise write-back). Never auto-merges.
export const PROPOSE_SCHEMA: ParseArgsSchema = {
  flags: [
    // The current spec to diff against (default ./crewhaus.yaml).
    { name: "current", takesValue: true },
    // Provenance: which verb produced the proposal (optimize|advise|model-scan|manual).
    { name: "source", takesValue: true },
    { name: "run-id", takesValue: true },
    // The version label the changelog/PR uses for the proposed spec.
    { name: "as-version", takesValue: true },
    // Eval delta for the PR body (else read from the optimize run if given).
    { name: "score-before", takesValue: true },
    { name: "score-after", takesValue: true },
    { name: "dataset", takesValue: true },
    // Optimize run dir whose provenance the changelog folds in.
    { name: "optimize-dir", takesValue: true },
    // Repo-relative path of the spec file on the branch (default crewhaus.yaml).
    { name: "spec-path", takesValue: true },
    // Assemble the bundle + print the plan without touching git/gh.
    { name: "dry-run", takesValue: false },
    { name: "help", short: "h" },
  ],
};

export const MIGRATE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "root-dir", takesValue: true },
    { name: "from", takesValue: true },
    { name: "to", takesValue: true },
    { name: "dry-run" },
    { name: "help", short: "h" },
  ],
};

// Item 32 — `crewhaus incident collect --session <id>`: assemble a full
// incident bundle from a session's traces/audit/cost + doctor.
export const INCIDENT_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "session", takesValue: true },
    { name: "kind", takesValue: true },
    { name: "reason", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 43 — `crewhaus upgrade`: detect the cwd spec's version drift vs the
// current CLI's spec version, run the migration chain (validated), show a diff.
// --dry-run (default) previews; --write applies.
export const UPGRADE_SCHEMA: ParseArgsSchema = {
  flags: [{ name: "dry-run" }, { name: "write" }, { name: "help", short: "h" }],
};

export const BUILD_IMAGE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "tag", takesValue: true },
    { name: "platform", takesValue: true },
    { name: "push" },
    { name: "no-record" },
    { name: "help", short: "h" },
  ],
};

export const CLOUD_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "provider", takesValue: true },
    { name: "region", takesValue: true },
    { name: "tier", takesValue: true },
    { name: "image-tag", takesValue: true },
    { name: "working-dir", takesValue: true },
    { name: "help", short: "h" },
  ],
};

export const FEDERATION_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "srv-domain", takesValue: true },
    { name: "format", takesValue: true },
    { name: "help", short: "h" },
  ],
};
