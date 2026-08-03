/**
 * The top-level `crewhaus` usage/help text.
 *
 * Extracted from `index.ts` as pure DATA: it is ~31 KB of string literals with
 * no dependencies, and `index.ts` (the CLI's single dispatch entrypoint) had
 * grown past Biome's 1 MiB per-file ceiling — a ceiling worth keeping as the
 * signal that the entrypoint needs splitting, rather than raising repo-wide.
 * Nothing here executes; `usage()` / `help()` in index.ts still own the exit
 * codes and the stream each one writes to.
 */
export function usageText(): string {
  return [
    "usage: crewhaus <subcommand> [args]",
    "",
    "subcommands:",
    "  compile <spec.yaml> -o <out-dir>     compile a spec to a runnable bundle",
    "                                       (fails if an outward tool is left non-external — FR-002)",
    "                  [--allow-unmarked-sinks]  opt out of the external-sink scope gate",
    "                  [--check]            verify the emitted bundle (shape assertion + install + liveness boot)",
    "  compile <spec.yaml> --emit-ir        print the lowered IR as JSON (debug)",
    "  compile <spec.yaml> --emit-as cf-worker  emit the Cloudflare-Worker bundle (cli|workflow|graph)",
    "  compile <spec.yaml> --watch          re-run parse→lint→compile on every change (item 41)",
    "  export claude-plugin <spec.yaml>     emit an Anthropic Claude Code plugin dir from the spec",
    "                  [--out <dir>] [--force] [--author <name>]  (item 4)",
    "  lint [spec.yaml] [--fix]             check-only: parse + ir-passes (§47 chain / graph-crew",
    "       [--format text|json]            well-formedness the CLI compile path skips) + scope audit,",
    "                                       WITHOUT emitting; --fix does nearest-match/typo repairs (item 41)",
    "  run <spec.yaml> [--model <model>]    compile in-memory and execute the agent",
    "                  [--watch]            re-validate on change (authoring aid; does not re-launch)",
    "                  [--resume <id>]      resume a specific session (cli targets only)",
    "                  [--continue]         resume the most-recent session (cli targets only)",
    "                  [--prompt <text>]    run one turn and exit, printing the reply (cli: no REPL; browser: the single-turn input, else stdin)",
    "                  [--plugins <a,b>]    override the spec's plugins: list for this run (item 3)",
    "                  [--justification-judge rule-based|claude]  Pillar 3 intent-gate judge (FR-004)",
    "                  [--egress-matcher substring|semantic]  Pillar 3 sink-side matcher (FR-006)",
    "                  [--egress-embedder <model>]  embedder for --egress-matcher semantic",
    "  serve --mcp <spec.yaml> [--sse]      project the cli agent as an MCP server (stdio or HTTP+SSE)",
    "                  [--port <n>] [--plugins <a,b>]  so it is a tool in Claude Code / an IDE (item 1)",
    "  dev <spec.yaml> [--once]             compile in memory + run the bundle as a supervised child,",
    "                  [--debounce <ms>]    relaunching on every spec/commands/skills change",
    "                  [--plugins <a,b>]    (CREWHAUS_TRACE=pretty by default; per-turn summaries)",
    "  runs resume <session>                re-drive a persisted cli session (e.g. one PARKED on a",
    "                  [--spec <path>]      pending approval, resolved via `approvals grant`); resolves",
    "                  [--prompt <text>]    the spec from --spec or cwd/crewhaus.yaml",
    "  eval <spec.yaml> --dataset <data>    run the agent against a dataset and grade",
    "       --graders <graders.yaml>       (deterministic graders + LLM-as-judge)",
    "       [--judge-model <model>] [--concurrency N] [--seed N] [-o <out-dir>]",
    "       [--slice <k1,k2,...>]          per-slice results by metadata keys (default:",
    "                                      family,difficulty,language,source when present)",
    "       [--gate]                       exit non-zero on regression vs the pinned baseline",
    "       [--max-p95-latency-ms N]       gate: fail when p95 latency rose > N ms vs baseline",
    "       [--max-cost-usd F]             gate: fail when the run's estimated cost exceeds $F",
    "       [--sample-timeout-ms N]        per-sample wall-clock timeout (default: the spec's",
    "       [--budget-usd F]               limits.deadline_ms) + run spend cap (default: the",
    "                                      spec's budget.usd; queued samples abort at the cap)",
    "       [--no-promote]                 keep the existing baseline pin after this run",
    "       [--record-tools <dir>]         record every tool result to <dir>/tools.jsonl, keyed",
    "                                      by (sampleId, toolName, sha256 of canonical args)",
    "       [--replay-tools <dir>]         serve tool results from that recording instead of",
    "       [--replay-miss error|live]     executing them (miss: fail the sample, or run live)",
    "       [--resume <runDir>]            re-open an interrupted run: reuse its graded samples,",
    "                                      run only the missing ones, re-aggregate the union",
    "       [--models <m1,m2,...>]         benchmark matrix: run the dataset once per model",
    "                                      (cells write to <out>/<model-slug>/; emits matrix.json",
    "                                      + index.html; incompatible with --gate/--no-promote)",
    "       --dataset also accepts registry:<name>[@version][#split] (Section 29 registry;",
    "                                      bare refs = train+dev — #test needs --allow-test-split)",
    "  eval coverage                        detect prod behaviors no eval sample exercises (item 6):",
    "       [--sessions N|all] [--dataset <d>]  tool/MCP/bigram/compaction gaps ranked by prod",
    "       [-o <dir>] [--format text|html|json] frequency; json is a backlog for `dataset mine`",
    "       [--graders <g.yaml>]                + grader coverage: gold-needing graders vs gold-less",
    "                                           samples, never-run graders, dead judge criteria",
    "  eval suite <suite.yaml>              run a named CI TIER of a suite manifest (NEW-HUNT-8):",
    "       [--tier fast|nightly|release]   each tier lists entries {name, dataset, graders, seed,",
    "       [--spec <spec.yaml>] [-o <dir>] repeats, concurrency, slice, gate, thresholds}; entries",
    "       [--gate]                        run sequentially through the same eval path, absolute",
    "                                       thresholds + the existing baseline gate decide each,",
    "                                       and the tier passes only if EVERY entry does",
    "  redteam generate                     generate an attack suite against the agent (E49):",
    "       [--spec <s>] [--taxonomy <t>]   behaviour categories × attack strategies, deterministic",
    "       [--count N] [--seed N]          and offline (attack strings composed from inert parts,",
    "       [--budget-usd F] [--model <m>]  never shipped whole); optional model-rephrased variants",
    "       [--out-dataset <n>]             under the budget. Emits a <spec>-redteam registry",
    "       [--out-graders <f>] [--force]   dataset (synthetic/adversarial, never gated by default)",
    "                                       + a refusal-grading graders.yaml",
    "  redteam report --runs <r>            attack-success rate by category/strategy from persisted",
    "                                       runs (dir | dir,dir | last:N); errored + judge-abstained",
    "                                       probes leave the denominator, never counted as resistance",
    "  eval plan --target-delta F           sample-size planner (C28): n ≈ z²·p(1−p)/e², printed",
    "       [--confidence C] [--pilot <run>] with every term + source; --pilot seeds p from a run's",
    "                                      measured pass rate (else 0.5 worst case). Offline.",
    "  eval-report diff <prev> <new>        compare two eval runs and emit a diff report",
    "       [-o <out-dir>] [--seed N]       (paired significance + per-slice deltas ride along;",
    "       [--epsilon F]                   --seed pins the Monte Carlo draw; --epsilon sets the",
    "                                      score-shift tolerance, default 0.1)",
    "  eval-report history                  list recorded runs (.crewhaus/evals/index.jsonl)",
    "       [--spec <name>] [--dataset <name>]",
    "  eval-report trends                   pass-rate / mean-score / cost OVER TIME per (spec,",
    "       [--spec <n>] [--dataset <n>]    dataset) from the same index; -o writes a",
    "       [-o <dir>]                      self-contained HTML chart (inline SVG, no assets)",
    "  eval-report export --runs <r>        flatten runs to one row per (run, sample, grader):",
    "       --format csv|jsonl [-o <file>]  <dir>, <dir,dir> or last:N; the cross-run",
    "                                      failure-analysis table nested results.json can't be",
    "  eval-report baseline show            print pinned baselines (.crewhaus/evals/baselines.json)",
    "       [--spec <name>] [--dataset <name>]",
    "  eval-report baseline set <runId>     pin a recorded run as its (spec, dataset) baseline",
    "  eval history|baseline|diff ...       working aliases for the eval-report verbs above (E52):",
    "                                       a stderr notice names the canonical verb, flags pass",
    "                                       through; a spec file named history.yaml still runs",
    "  optimize <spec.yaml> --dataset <data> --graders <graders.yaml>",
    "       (--dataset also accepts registry:<name>[@version][#split])",
    "       [--mutator rule-based|claude|meta-harness] [--iterations N] [--seed N]",
    "       [--stage <name>]                     multi-stage specs (workflow/graph/crew): optimize ONE",
    "                                            step/node/role; omitted, every stage runs in order",
    "       [--ratings <session>|all]            distill user ratings into the training set (Pillar 2)",
    "       [--budget-usd N]                     stop a model-driven run before it exceeds $N (FR-003)",
    "       [--write-back] [-o <out-dir>]        active eval-driven optimization (Pillar 2)",
    "  flywheel run [spec.yaml]             the nightly self-improvement loop, one command (item 45):",
    "       compile gate → baseline eval → optimize → after eval → acceptance",
    "       gate (pass_rate strictly up AND zero regressions) → write-back on",
    "       accept; a rejected patch never touches the spec.",
    "       [--dataset <data>] [--graders <g.yaml>] [--budget-usd N] [--iterations N]",
    "       [--seed N] [--concurrency N] [--mutator rule-based|claude]",
    "       [--gate-split train|dev] [--dry-run] [--allow-dirty]",
    "  schedule generate --for <target>     print ready-to-install scheduling text (D41) for",
    "       [--runner cron|launchd|systemd] flywheel | eval-gate | sentinel, wrapping the matching",
    "       [--dir <path>]                  crewhaus command — for teams not on GitHub Actions.",
    "                                       A shim: it prints, it never installs.",
    "  flywheel init [--force]              scaffold .github/workflows/crewhaus-flywheel.yml",
    "       [--suite <suite.yaml>]           (nightly cron + manual dispatch; accepted improvements",
    "                                       arrive as PRs for human review — never auto-merged).",
    "                                       --suite appends a nightly `eval suite --tier nightly",
    "                                       --gate` step to the same cron (NEW-HUNT-8)",
    "  init [name]                          scaffold a new crewhaus.yaml",
    "       [--interactive] [--detect]      interview-driven spec authoring (model, or scripted",
    "                                       fallback with no credentials); validated via parseSpec (item 39)",
    "       [--ci]                          also scaffold .github/workflows/crewhaus-eval.yml —",
    "                                       eval-gated spec PRs (base vs PR spec, two fresh runs,",
    "                                       score-delta PR comment, check fails on regression);",
    "                                       with an existing crewhaus.yaml, adds just the workflow",
    "       [--suite <suite.yaml>]          with --ci: scaffold the TIERED workflow instead",
    "                                       (NEW-HUNT-8) — fast tier gates PRs, nightly tier on a",
    "                                       cron; with --sentinel: the drift cron also runs the",
    "                                       nightly tier. Without it both scaffolds are unchanged",
    "       [--with-evals]                  also scaffold eval/dataset.jsonl + eval/graders.yaml",
    "                                       (item 13; offline template mode — no credentials needed)",
    "       [--force]                       overwrite an existing scaffolded workflow / eval assets",
    "  scaffold-evals <spec.yaml>           day-one eval assets FROM the spec (item 13): sample",
    "       [-o <dir>] [--samples N]        stubs derived from agent.instructions (one model call",
    "       [--model <m>] [--force]         with credentials, deterministic template without) +",
    "                                       ONE starter grader (spec-goal llm_judge rubric online,",
    "                                       non-empty-answer floor grader offline)",
    "       [--template <family>]           or start from the eval-template library (E47): rag |",
    "                                       summarize | extract | support | safety | classify —",
    "                                       a grader-template's anchored rubric + seed dataset,",
    "                                       copied as REVIEW files. Offline: no model call",
    "  graders suggest [-o <file>]          draft grader suites from failure rationale (item 4):",
    "       [--runs <dir|last:N>]           clusters grades.json rationale (via the run-history",
    "       [--model <m>] [--spec <name>]   index), judge criterionScores, and rating comments",
    "       [--min-score F] [--force]       into themes; drafts deterministic graders per theme",
    "                                       (+ an llm_judge rubric with --model/credentials) into",
    "                                       a REVIEW file — never auto-applied",
    "  graders test --graders <g.yaml>      meta-eval every grader against labeled golden verdicts",
    "       --golden <verdicts.jsonl>       (E48): per-line {id, input, agent_output, expected_passed,",
    "       [--judge-model <m>]             expected_score?}; deterministic graders replay credential-",
    "       [--min-agreement F]             free, judges skip loudly without credentials; reports",
    "                                       agreement/kappa/FP+FN exemplars per grader; exits non-zero",
    "                                       when any TESTED grader falls below --min-agreement",
    "  graders card --graders <g.yaml>      render the measurement-instrument RUBRIC CARD as markdown",
    "       | --template <family>            (NEW-HUNT-11): per-grader type/opts/thresholds, judge",
    "       [-o <file>]                     rubrics (criteria+anchors or labels, passing cut, panel/",
    "                                       repeats/temperature/target), registry pack opts, and the",
    "                                       gradersHash history records; deterministic (content-derived",
    "                                       identity, no timestamps) — stdout by default, -o writes.",
    "                                       --template cards an eval-template family (E47) without",
    "                                       scaffolding it first",
    "  doctor                               check environment health",
    "       [--philosophy-alignment [--json] [--baseline | --accept-baseline]]  pillar audit + scope-audit drift gate (item 49)",
    "       [--detect [--no-probe]]         inventory reachable providers/local models/MCP servers (item 40)",
    "       [--fix]                         apply mechanical remediations (dry-run by default) (item 40)",
    "  context --bundle [-o <file>]         emit a single-markdown orientation manifest",
    "       [--factory-root <p>] [--docs-root <p>] [--demos-root <p>]",
    "  cost-summary --session <id>          summarize cost_accrual events for a session",
    "  route status [--dir <root>]          show the adaptive model_pool reward scoreboard",
    "  route explain <session> [--dir <r>]  replay a run's per-turn model_route decisions",
    "  route reset  [--dir <root>]          wipe the scoreboard (default root .crewhaus)",
    "  advise [--session <id> | --all]      mine session logs for spec advice (item 14)",
    "       [--json] [-o <dir>]             writes suggestions.json + report.html (default .crewhaus/advice)",
    "  tools list                           list every builtin tool + its metadata (item 18)",
    "  tools suggest [spec.yaml]            rank builtins against agent.instructions (keyword match)",
    "  tools audit [--sessions N|all]       mine tool_stats vs. grants — unused/failing/readOnly",
    "  permissions suggest [--apply]        mine ask/deny history into settings.json rules (item 16)",
    "       [--sessions N|all] [--json]     --apply is interactive-confirm only (never eval-gated)",
    "  rate --session <id> [--turn N]       rate an assistant turn 👍/👎, ⭐, or 0–1",
    "       (--thumbs up|down | --stars 1-5 | --score 0-1) [--comment <t>] [--adjudicate]",
    "  feedback --session <id> --text <msg> attach a comment/correction to a turn",
    "       [--turn N] [--correction <better answer>] [--adjudicate]",
    "  approvals list|show|grant|deny <id>  resolve tool-permission approvals a headless run parked",
    "       [--dir <root>] [--by <who>]      (permissions.ask_mode: pause); grant is one-shot (--once)",
    "  review list|next|resolve <id>        persistent human-review queue (.crewhaus/review/): eval",
    "       [--kind <k>] [--all] [--note t]     abstentions/panel flags, rater ties, mined quarantine (B20)",
    "  distill --session <id> -o <ds.jsonl> turn ratings into an eval dataset + graders",
    "       [--all-sessions] [--graders-out <g.yaml>] [--min-score F]",
    "       [--register <name>]            also promote a new dataset version into the registry",
    "       [--no-redact]                  keep raw sample text (PII/secret-redacted by default)",
    "  fewshot harvest [--all-sessions]     harvest up-rated turns into a golden few-shot pool (#54)",
    "       [--min-score F] [-o <pool>]     (PII/secret-redacted); optimize with --few-shot",
    "  fewshot show [--k N]                 print the pool as the injectable prompt block",
    "  faq distill [--sessions N|all]       cluster recurring questions into an auto-discovered FAQ skill (#55)",
    "       [--min-score F] [--min-occurrences N] [-o <skill-dir>]",
    "  lessons update [--sessions N|all]    mine corrections + failures into an auto-loaded LESSONS.md (#56)",
    "       [--low-score F] [-o <LESSONS.md>]  + per-user prefs under .crewhaus/preferences/",
    "  sessions summarize [--before <date>] summarize sessions into a durable index before TTL eviction (#57)",
    "  sessions tail [<session>]            follow a session's transcript live (per-turn view; --no-follow to dump)",
    "  memory list [--spec <name>]          inspect the per-spec fact stores: id/age/tags/provenance/status",
    "  memory show <mem_id>                 full detail for one memory (provenance, expiry, supersededBy)",
    "  memory forget <mem_id>|--query <q>   explicitly forget memories (append-only supersede tombstones;",
    "       [--spec <name>] [--yes]             a query forgets EVERY match; prompts unless --yes)",
    "  memory sweep [--compact] [--yes]     tombstone TTL-expired memories; --compact rewrites the file",
    "                                       dropping dead lines (atomic; the growth-bounding compaction)",
    "  migrate memories [--dry-run]         backfill the v2 memory schema + provenance; stamps .crewhaus/meta.json",
    "  wiki list [--spec <name>]            inspect the per-spec local wikis, stalest first (versions, signals,",
    "       [--tags <t1,t2>] [--status <s>]     tags; articles live under .crewhaus/wiki/<spec>/articles/)",
    "  wiki show <slug>                     full frontmatter + body for one article (priors in versions/<slug>/)",
    "  wiki search <q> [-k <n>]             BM25 keyword search over a spec's articles",
    "  wiki stats                           corpus health: articles/status/versions/tags/verified/links",
    "  dream [run] <spec.yaml> [--force]    scheduled memory consolidation (§6): deterministic pass + budget-",
    "                                       capped model synthesis per memory.dream (cron-safe, window-idempotent)",
    "  dream status <spec.yaml>             schedule state + next due (.crewhaus/dream/<spec>/state.json)",
    "  dream init <spec.yaml> [--force]     scaffold the nightly consolidation cron (crewhaus-dream.yml)",
    "       [--evicted] [--ttl-days N]        --evicted indexes each session just before it is deleted",
    '  watchme start|stop|status      watch this harness\'s agent interactions ("watch me")',
    "  watchme report [--all]         quality/continuity/factuality/model-fit report from watched sessions",
    "  watchme intents [--all]        recurring-intent digest for this harness or all registered ones",
    "  watchme synthesize             draft an agent-loop spec that mimics observed usage (proposal only)",
    "  watchme publish                distill findings into this harness's local wiki (report --all recalls opted-in peers)",
    "  datasets list                        all registered datasets + versions (Section 29)",
    "  datasets get <name>[@version]        print a dataset's samples as JSONL",
    "       [--split train|dev|test]",
    "  datasets put <name> --file <f.jsonl> import a file as a new auto-bumped version;",
    "       [--split-spec 70/15/15 | --split train]  --canary injects a contamination tripwire",
    "       [--canary]                              sample (excluded from pass rates; B18)",
    "  datasets verify <name>[@version]     recompute sample hashes vs the stored record;",
    "                                       exits non-zero on mismatch (registry integrity)",
    "  datasets status <name> [--runs N]    freshness/saturation: version age, run coverage,",
    "                                       always-passing samples, test-split burn (B17)",
    "  datasets release <name>[@version]    the sanctioned holdout spend: eval the locked",
    "       --spec <s.yaml> --graders <g.yaml>  #test split + record a release/burn entry;",
    "       [--force]                           refuses a second release without --force",
    "  datasets card <name>[@version]       markdown datasheet: splits, provenance, hashes,",
    "       [-o <file.md>]                      release history + offline lint summary (B21)",
    "  dataset mine [--sessions N|all]      mine hard cases from session struggle signals (item 2):",
    "       [--out-dataset <name>] [--review]   errors/eval-fails/loops/retries/egress → quarantine;",
    "       [--no-redact]                       --review promotes accepted into a mined dataset",
    "                                           (candidate text PII/secret-redacted by default)",
    "  dataset synthesize --from <f|reg>    PII-redacted stress variants (item 2): paraphrase,",
    "       [--count N] [--budget-usd N]        truncate, ambiguate, inject → separate synthetic",
    "       [--out-dataset <name>]              split (never contaminates human golds)",
    "  dataset refresh-goldens              reconcile corrections/up-rated turns with golds (item 5):",
    "       --dataset <file|registry:ref>       propose gold updates as a review diff; --apply writes",
    "       [--min-score F] [--apply]           a NEW registry version (never in-place)",
    "  dataset audit --dataset <f|reg>      offline PII/secret scan of an existing dataset (B23):",
    "       [--pii] [--apply] [--strict]        per-detector/field/sample hit report (no model calls);",
    "                                           --apply writes a redacted NEW registry version;",
    "                                           --strict exits non-zero on hits (CI gate)",
    "  dataset lint --dataset <f|reg>|--all offline hygiene lint (B26): duplicate/near-dup",
    "       [--graders <g.yaml>] [--strict]     samples, grader mismatches, provenance taxonomy,",
    "                                           empty golds, canary leak scan; --strict = CI gate",
    "  judge calibrate                      calibrate an llm_judge against human ratings (item 8):",
    "       [--graders <g.yaml>] [--model <m>]  correlation/bias/ROC-optimal cut over paired",
    "       [--sessions N|all] [--apply]        (human rating, judge score); --apply writes the cut",
    "       [--dataset <file|registry:ref>]     also pair the golden verdicts a distilled dataset",
    "                                           carries (metadata.user_rating + the rated answer)",
    "  state backup [-o <file.tar.gz>]      snapshot the cwd .crewhaus state dir to a tarball (item 69)",
    "       [--exclude <glob,glob>]",
    "  state restore <file.tar.gz>          restore a snapshot (refuses a non-empty .crewhaus)",
    "       [--into <dir>] [--force] [--merge feedback|all]",
    "  secrets doctor                       list known secrets via the configured backend",
    "  secrets rotate <name> [--value V]    rotate a named secret (file backend)",
    "  fleet list|status|run <sub> ...      cross-harness inventory/health + bulk read-ops (item 58)",
    "  knowledge sync [--pull|--push]       cross-harness shared memories/graders/prompts (item 63)",
    "  retire <spec> [--dry-run] [--force]  audited harness decommissioning (item 64)",
    "  plugins list|search|install|...      marketplace plugins CLI + publish/outdated (item 60)",
    "  templates list|search|use ...        marketplace templates CLI (item 60)",
    "  spec put|list|get|pin|alias|log ...  versioned spec storage + changelog (Section 28 spec-registry)",
    "  deploy promote|rollback ...          re-pin a spec for an environment (Section 28)",
    "       promote --require-approval      gate a protected env on an approval quorum (item 59)",
    "  deploy fly|render|railway|heroku <spec>  scaffold PaaS deploy manifests for a daemon shape;",
    "       [-o <dir>] [--app <n>] [--image <ref>] [--live]  --live (token-gated) deploys via the API",
    "  propose <proposed.yaml> ...          package a spec change + open a review PR (item 59)",
    "  deploy canary <spec> <version> ...   eval-gated ramp with auto-rollback (item 29):",
    "       --traffic 5,25,50,100 --dataset <d> --graders <g>  eval both versions per step,",
    "                                       gate on regression-runner, auto-promote/rollback",
    "       [--traffic-split]               ALSO write the deterministic variant assignment +",
    "                                       per-version outcome ledger (E50). NOT a live",
    "                                       request split — see `deploy --help`",
    "  experiment status|record|assign      per-version outcome deltas with Wilson 95% CIs (E50):",
    "       status [--name n] [--min-n N]    refuses to name a winner below --min-n per version",
    "       record --name n --version v --outcome pass|fail   report one outcome",
    "       assign --name n --key <k>        the version a request key deterministically maps to",
    "  incident collect --session <id>      assemble an incident bundle from a session's",
    "                                       traces + audit + cost + doctor (item 32)",
    "  failures report [--propose-taxonomy] cluster run_failed + incidents by class + message",
    "       [--sessions N|all] [--dir <r>]   similarity; --propose-taxonomy drafts failure_taxonomy (G63)",
    "  migrate-all --from N --to N          batch-migrate every spec in the registry",
    "  upgrade [spec.yaml] [--write]        detect the cwd spec's version drift + run the migration",
    "                                       chain (validated); --dry-run diff by default (item 43)",
    "  build-image <target> --tag <tag>     build the docker image for a target shape (Section 32)",
    "       [--platform <p>] [--push]        (--push records the registry manifest digest in",
    "       [--no-record]                     docker/digests.json; --no-record opts out. Local",
    "                                         --load builds record nothing — not pullable)",
    "  cloud deploy --provider <p>          deploy a managed CrewHaus cluster (Section 32)",
    "       --region <r> [--tier <t>] [--image-tag <tag>] [--working-dir <dir>]",
    "                                        (generated terraform/kustomize lands in",
    "                                         .crewhaus/cloud/<cluster> unless --working-dir says otherwise)",
    "  cloud teardown --provider <p>        tear down a managed cluster",
    "       --region <r> [--working-dir <dir>]",
    "  federation discover <deployment>     resolve a federated peer's endpoint + cert fingerprint (Section 34)",
    "       [--srv-domain <d>] [--format json|yaml]",
    "  sandbox doctor [--probe]             list registered sandbox images + healthcheck status (Section 36)",
    "       [--format json|table]",
    "  mcp doctor [--probe]                 per-server MCP health scoring, drift watch, auto-quarantine (item 38)",
    "       [--format json|table]",
    "  compliance evidence                  collect SOC 2 / ISO 27001 / HIPAA evidence (Section 39)",
    "       (--framework <id> | --all-frameworks) [--control <id>]",
    "       --period <p>|current [--audit-dir <d>] [--out-dir <d>]",
    "       [--signing-key-env <ENV>] [--fail-on-empty]",
    "  audit verify [--dir <auditDir>]      verify the hash-chained audit log (tamper check)",
    "       [--anchor file:<path>]          cross-check an append-only file anchor store",
    "  retention sweep [--dry-run]          scheduled GDPR/TTL enforcement over .crewhaus stores",
    "       [--dir <root>]                  (sessions expire by .crewhaus/retention.json; audit is export-only)",
    "  retention export <outDir>            right-to-export: copy session/audit records out",
    "       [--since <date>] [--dry-run] [--dir <root>]",
    "  retention purge [--before <date>]    right-to-delete: purge expired records now",
    "       [--dry-run] [--dir <root>]",
    "  security digest [--since 7d|30d|ISO] triage rollup of denials/egress/injection from .crewhaus stores (item 48)",
    "       [--format text|json|html] [-o <dir>] [--notify <url>] [--dir <root>]",
    "  channel provision <spec.yaml>        one-command platform app setup for a channel spec (item 61):",
    "       --base-url <public-url>         slack app manifest YAML, telegram setWebhook, discord",
    "       [--platform slack|telegram|discord|all]  interactions endpoint + invite URL",
    "       [-o <dir>] [--dry-run] [--force]",
    "  channel verify <spec.yaml>           scope doctor: every env var the daemon boots on,",
    "       [--platform ...] [--dry-run]    then slack auth.test + granted scopes, telegram",
    "       [--base-url <public-url>]       getWebhookInfo, discord application fetch",
    "       [--offline]                     (--offline = the env checks only: no network,",
    "                                       deterministic exit code for CI/pre-flight)",
    "  version                              print the CLI version (also: --version, -v)",
    "",
  ].join("\n");
}

/**
 * `crewhaus eval --help`. Pure string data, kept out of the entry file for the
 * same reason {@link usageText} is (see this module's header).
 */
export const EVAL_USAGE =
  "usage: crewhaus eval <spec.yaml> --dataset <data> --graders <graders.yaml> " +
  "[--judge-model <model>] [--concurrency N] [--seed N] [--repeats K] " +
  "[--slice <k1,k2,...>] [-o <out-dir>] " +
  "[--gate] [--no-promote] [--no-regressions] [--no-retry] [--allow-test-split] " +
  "[--no-preflight] " +
  "[--max-p95-latency-ms N] [--max-cost-usd F] " +
  "[--sample-timeout-ms N] [--budget-usd F] " +
  "[--record-tools <dir> | --replay-tools <dir> [--replay-miss error|live]] " +
  "[--resume <runDir>] " +
  "[--models <m1,m2,...>]\n" +
  "  Before any model spend, an OFFLINE preflight lint-lite refuses runs with\n" +
  "  duplicate sample ids (artifact dirs collide, flip detection corrupts) or\n" +
  "  gold-needing graders (exact_match/expected_contains) over a dataset where NO\n" +
  "  sample carries expected_output (all-fail-by-construction); partial gold\n" +
  "  gaps only warn. --no-preflight skips it; `crewhaus dataset lint` is the\n" +
  "  full offline lint. Samples tagged metadata.source: canary (from `datasets\n" +
  "  put --canary`) are contamination tripwires: excluded from the pass-rate\n" +
  "  denominator like needs_human and listed separately (canary=N).\n" +
  "  --dataset takes a file path (jsonl/csv/yaml/http) or registry:<name>[@version][#split]\n" +
  "  — a Section 29 dataset-registry ref (.crewhaus/datasets, or CREWHAUS_DATASETS_DIR).\n" +
  "  Default version: latest; default samples: train + dev (a bare ref EXCLUDES the\n" +
  "  locked test split, with a stderr note when one existed; give #train or #dev to\n" +
  "  eval one split). An explicit #test is refused unless --allow-test-split is also\n" +
  "  passed — the held-out split exists to be spent at release-gate time, and\n" +
  "  optimize/flywheel refuse it outright. Runs key into the history index/baselines as\n" +
  "  <name>@<version>[#split] with a content hash derived from the record's sample hashes.\n" +
  "  -o defaults to .crewhaus/evals/<runId>. Every run is appended to\n" +
  "  .crewhaus/evals/index.jsonl and diffed against the pinned baseline for its\n" +
  "  (spec, dataset) pair (.crewhaus/evals/baselines.json). The first run for a\n" +
  "  pair pins the baseline; later runs auto-promote when the regression gate\n" +
  "  passes. --no-promote keeps the existing pin; --gate exits non-zero when the\n" +
  "  gate fails (any pass-rate drop or sample-level pass→fail flip).\n" +
  "  --max-p95-latency-ms N / --max-cost-usd F declare ops thresholds for the same\n" +
  "  baseline gate: the verdict FAILS (and exits non-zero under --gate) when p95\n" +
  "  per-sample latency rose more than N ms vs the pinned baseline, or when this\n" +
  "  run's estimated cost exceeds $F. Cost is projected from the run's agent-model\n" +
  "  token totals through the same pricing table as the --models est_$ column (all\n" +
  "  trials under --repeats); an unpriced model leaves cost unknown, so the cost\n" +
  "  gate warns instead of failing. JUDGE spend is now metered too (C35): every\n" +
  "  llm_judge call's token usage lands in results.json (aggregates.judgeUsage, per\n" +
  "  judge model) and the run prints a `cost:` line breaking out agent vs judge vs\n" +
  "  total — judge grading often costs more than the agent run it grades. The gate\n" +
  "  thresholds themselves still compare AGENT cost, unchanged. Like the regression\n" +
  "  gate, the thresholds compare\n" +
  "  against the pinned baseline — the first run for a pair pins and is not gated.\n" +
  "  Every run's index entry/baseline pin also records p95LatencyMs + costUsd\n" +
  "  (additive fields). Incompatible with --sentinel/--models, which skip the gate.\n" +
  "  --sample-timeout-ms N bounds each sample's AGENT INVOCATION to N ms of wall\n" +
  "  clock: a timed-out sample records an errored result (artifacts still written)\n" +
  "  instead of stalling a concurrency slot forever. Defaults to the spec's\n" +
  "  limits.deadline_ms when declared; the rest of the spec's limits: ceilings\n" +
  "  (turn/model-call timeouts, max_tool_iterations, loop_detection, ...) now also\n" +
  "  apply inside each sample's loop exactly as `crewhaus run` applies them.\n" +
  "  --budget-usd F caps the RUN's estimated agent-model spend: when accrued cost\n" +
  "  reaches the cap, in-flight samples finish, queued samples abort with an\n" +
  "  '[eval] budget exhausted after k/N samples' error, and results.json is marked\n" +
  "  partial (completed samples keep their grades). Defaults to the spec's\n" +
  "  budget.usd when declared — eval always STOPS at the cap (the block's\n" +
  "  on_exceed: degrade ladder never applies to a measurement run). The cap meters\n" +
  "  AGENT spend only (judge tokens are reported but do not move the cap), and an\n" +
  "  unpriced model disables enforcement with a warning. Under --models, each cell\n" +
  "  meters its own cap.\n" +
  "  --record-tools <dir> records every TOOL execution to <dir>/tools.jsonl, keyed\n" +
  "  by (sampleId, toolName, sha256 of the canonical-JSON args); tools still run\n" +
  "  for real and the run is otherwise unchanged. --replay-tools <dir> serves those\n" +
  "  results from the recording instead of executing anything — deterministic,\n" +
  "  credential-free, side-effect-free tool behaviour for a tool-using agent's\n" +
  "  eval. The two are mutually exclusive. A call whose key the recording does not\n" +
  "  carry is a MISS: --replay-miss error (default) fails that sample with a\n" +
  "  message naming the missing key (and is never noise-retried — it would fail\n" +
  "  identically), --replay-miss live executes the tool for real. Repeated\n" +
  "  identical calls replay the recorded results in order; once a key's entries run\n" +
  "  out the last one keeps replaying, and because that means the replayed\n" +
  "  trajectory called the tool more times than the recording did, the run prints an\n" +
  "  `[eval] warning:` naming those calls and records a reusedEntries count.\n" +
  "  Scope: TOOLS only — the agent stack is still wired (MCP servers\n" +
  "  still boot so their tool schemas exist) and the MODEL still runs live. run.json\n" +
  "  records the mode, the directory, and (on replay) the recording's content hash,\n" +
  "  so a replayed run gates and pins like any other run but says what it was.\n" +
  "  A recording holds tool args and results VERBATIM (bash stdout, MCP responses,\n" +
  "  file contents) — treat <dir> like a session transcript and do not commit one\n" +
  "  recorded against production credentials or production data.\n" +
  "  --resume <runDir> re-opens an interrupted run instead of re-paying for it:\n" +
  "  the run keeps its ORIGINAL runId and startedAt, every sample that already\n" +
  "  wrote grades.json is reloaded from disk (no agent call, no judge call, no\n" +
  "  spend), only the missing samples run, and the UNION is re-aggregated into a\n" +
  "  fresh results.json + index.html. The resume REFUSES loudly when the run's\n" +
  "  specHash, datasetHash or gradersHash no longer match the recorded run.json —\n" +
  "  splicing two different measurements into one run is never silent. A sample\n" +
  "  that ran and ERRORED is complete (it has grades.json) and is reused as-is;\n" +
  "  delete its artifact directory to re-run just that one. The run history is\n" +
  "  updated, not duplicated: the resumed run appends a superseding index entry\n" +
  "  under the same runId, and every reader built on eval-report's\n" +
  "  readRunIndexLatest (crewhaus eval-report history|trends and this CLI's own\n" +
  "  listings) keeps only the newest — the raw readRunIndex still returns the full\n" +
  "  append log. A budget-partial run still refuses to pin a baseline until it\n" +
  "  completes, and when the PINNED baseline is the very run you are resuming the\n" +
  "  gate is refused with a warning rather than comparing the run against itself.\n" +
  "  --budget-usd is re-armed per attempt: the resume prints what earlier attempts\n" +
  "  already spent (run.json's spentUsd) before spending more. Incompatible with -o\n" +
  "  (the run directory IS the output) and with --models.\n" +
  "  When the registry contains <specName>-regressions (pinned by `crewhaus optimize`),\n" +
  "  its samples are unioned into the dataset by default (dedupe by id, primary wins).\n" +
  "  When the union actually ADDS samples, datasetName/datasetHash reflect it\n" +
  "  (`+regressions@vX` suffix + folded hash), so the first adding union starts a new\n" +
  "  baseline lineage by design; a union that adds nothing keeps the primary identity\n" +
  "  (and lineage) untouched. --no-regressions skips the union.\n" +
  "  Samples whose run ERRORS (provider timeout, 429, a grader/judge throw — infra\n" +
  "  noise, not a graded failure) are retried once by default; the retried outcome\n" +
  "  replaces the errored one and is tagged retried:true in results.json (the summary\n" +
  "  line and run index report the retried count). --no-retry disables the retry.\n" +
  "  When the spec declares a failure_taxonomy, a sample's final error is classified\n" +
  "  against it (results.json failureClass + a `failure classes:` output tally), and\n" +
  "  a matched class declaring `recovery: fail` SUPPRESSES the noise auto-retry —\n" +
  "  the user declared that error terminal, so re-running it is futile.\n" +
  "  --repeats K runs every sample K times (trial t gets seed+t-1 when --seed is\n" +
  "  set; i.i.d. draws otherwise). Trial 1 is the canonical result; per-trial grades\n" +
  "  land on the sample (results.json trials[]) and the aggregates gain pass@K (at\n" +
  "  least one trial passed — the optimistic capability metric) and pass^K (ALL K\n" +
  "  passed — tau-bench's reliability metric: a flaky 60%-reliable agent scores\n" +
  "  0.6^K). Trials run sequentially inside each sample's concurrency slot, so a\n" +
  "  K-repeat run costs ~K× the wall clock and spend; the summary's\n" +
  "  tokens_all_trials makes the real spend visible. Samples whose trials DISAGREED\n" +
  "  (0 < trial pass rate < 1) are flagged FLAKY (C34): marked per sample in\n" +
  "  results.json, counted + listed on stdout with what to do about them, and\n" +
  "  recorded on the run-history entry so `eval-report history` marks the run.\n" +
  "  Their verdicts still count — quarantine is a decision you make against the\n" +
  "  dataset, not one the runner makes silently.\n" +
  "  --slice <k1,k2,...> slices the results by sample-metadata keys (default:\n" +
  "  family,difficulty,language,source). A key applies only to samples carrying it\n" +
  "  in metadata as a STRING; per-slice sample count / pass rate / mean score land\n" +
  "  in results.json (slices), one stdout line per key, and the report's slice\n" +
  "  table — a macro pass rate can hold while the hard slice collapses. Computed by\n" +
  "  the runner, so matrix cells and target-eval bundles inherit the default keys.\n" +
  "  The summary line carries closed-form 95% CIs on pass_rate (Wilson) and\n" +
  "  mean_score (Student t) — at small n the point estimates alone overstate\n" +
  "  certainty. Both are also stored in results.json (passRateCI95/meanScoreCI95)\n" +
  "  and inherited by matrix cells.\n" +
  "  llm_judge graders may ABSTAIN (insufficient evidence): if nothing else failed\n" +
  "  the sample's outcome is `abstained` — excluded from the pass-rate denominator,\n" +
  "  counted + id-listed as needs_human in results.json/stdout/report for\n" +
  "  `crewhaus rate` follow-up, and excluded from the baseline gate's per-sample\n" +
  "  flip comparison. Judge criterion scores are persisted per grade (detail) and\n" +
  "  aggregated per criterion (criterionMeans + a `judge criteria` line).\n" +
  "  llm_judge graders judge the final output by default; `target: transcript`\n" +
  "  feeds the judge the run's bounded, sentinel-wrapped trajectory digest instead.\n" +
  "  Rubrics are scalar (1-5 criteria/anchors) or categorical (`kind: categorical`\n" +
  "  + labels/passing_labels — the judge picks exactly one label; the label's\n" +
  "  declared 0..1 score is the grade).\n" +
  "  Graders with `type: registry` resolve against the default grader registry —\n" +
  "  the specialty packs (continuity.*, twelve.*, nlg.*, semantic.similarity,\n" +
  "  multimodal.*, safety.*, calibration.*, consistency.*) plus .crewhaus/graders\n" +
  "  plugins, which win on name collisions. Constructed once per run and shared\n" +
  "  with every matrix cell.\n" +
  "  Registry entries may carry `opts:` — pack construction options (thresholds,\n" +
  "  embedder spec, disableFallback, ...) validated per pack at run start: an\n" +
  "  unknown or out-of-range key errors naming the pack's accepted vocabulary,\n" +
  "  never silently ignored. Plugin graders receive the opts record verbatim.\n" +
  "  llm_judge rubrics that declare no passing_score gate on the calibrated cut\n" +
  "  from .crewhaus/judge-calibration.json when present (`crewhaus judge calibrate\n" +
  "  --apply`); the run output and run.json note every grader gated this way.\n" +
  "  After the run, every failing sample is triaged by the failure arbiter into\n" +
  "  bug / spec-gap / noise / contract-ambiguity: verdicts land in <out>/verdicts.json\n" +
  "  + a report section + a one-line `triage:` summary. Triage never pins samples the\n" +
  "  run's own dataset already contains, never pins errored samples, and skips pinning\n" +
  "  entirely when the run looks infrastructure-failed. Best-effort — a triage failure\n" +
  "  never fails the eval. Matrix cells (--models) skip triage.\n" +
  "  --judge-model accepts the full router grammar (claude-*, openai/<m>, gemini/<m>,\n" +
  "  bedrock/<id>, local/<m>@<url>); the default judge claude-sonnet-5 requires\n" +
  "  Anthropic credentials (ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY)\n" +
  "  --models <m1,m2,...> runs a benchmark matrix: the SAME dataset (resolved once,\n" +
  "  regression union included) and graders once per model, patching the spec's\n" +
  "  agent.model in-memory like `run --model`. Model strings take the full router\n" +
  "  grammar and are validated before the first cell runs. Each cell writes a full\n" +
  "  run dir to <out>/<model-slug>/ (default out: .crewhaus/evals/matrix_<id>), so\n" +
  "  `eval-report diff` works on any pair of cells; the matrix root gets matrix.json\n" +
  "  + index.html (pass rate, mean score, latency, tokens, projected $/1k samples —\n" +
  "  unknown pricing shows n/a). Matrix cells skip the run-history index/baselines\n" +
  "  (they are comparisons, not lineage), so --gate/--no-promote are rejected. A\n" +
  "  cell that crashes (bad credentials, 404 model) records an error row and the\n" +
  "  remaining cells still run; the command then exits non-zero.\n" +
  "  --sentinel --baseline <run-dir> runs the model-drift sentinel (item 30):\n" +
  "  re-run this dataset against the UNCHANGED spec and diff against the frozen\n" +
  "  baseline run dir. Pin --seed for a deterministic sample order. When the spec's\n" +
  "  specHash AND the dataset's content hash are BOTH identical to the baseline's,\n" +
  "  any pass/fail flip or score shift can only be the provider silently changing\n" +
  "  model behaviour — the command flags it and exits non-zero so a CI cron alerts.\n" +
  "  A specHash or dataset-hash mismatch is reported as not-comparable (also exits\n" +
  "  non-zero — a mis-pointed sentinel is loud, never silently green). Sentinel mode\n" +
  "  skips the run-history index/baselines/triage and the regression union (a probe,\n" +
  "  not lineage); --gate/--no-promote/--models are rejected with it.\n" +
  "  --voice [--replay-dir <dir>] replays recorded call sessions through the voice\n" +
  "  grader pack (latency / barge-in / transcript coverage) with the --max-ttft-ms /\n" +
  "  --max-turn-latency-ms / --max-barge-in-yield-ms budgets. Adding --graders\n" +
  "  <g.yaml> ALSO grades what the agent SAID (D46): each replayed transcript is\n" +
  "  scored by the ordinary grader stack (deterministic graders, registry packs,\n" +
  "  llm_judge rubrics), and a content failure fails the session exactly like a\n" +
  "  latency breach. A replay carries no gold, so gold-needing graders\n" +
  "  (exact_match / expected_contains) have nothing to compare against — use\n" +
  "  contains/regex/llm_judge for content. Judge rubrics need judge credentials;\n" +
  "  without --graders the voice path stays credential-free.\n" +
  "  Read verbs: `crewhaus eval history|baseline|diff` alias the eval-report\n" +
  "  verbs (E52) — see `crewhaus eval-report --help`. Planning verb: `crewhaus eval\n" +
  "  plan --target-delta F` sizes the dataset BEFORE you spend on it. Suite verb:\n" +
  "  `crewhaus eval suite <suite.yaml> --tier fast|nightly|release` runs a whole CI\n" +
  "  tier of (dataset, graders) entries through this same path and aggregates ONE\n" +
  "  verdict (NEW-HUNT-8) — see `crewhaus eval suite --help`.\n";
