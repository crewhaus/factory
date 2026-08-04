/**
 * M3 · DATA — the dataset registry, its hygiene verbs, and the growth loops.
 *
 * STUBS. Owned by the Evals+Data implementer.
 *
 * Everything lives under `/api/h/:id/data/…` and the dataset NAME travels in
 * the BODY for every write, deliberately: a name is operator-supplied, and
 * routing it through a path segment would put a user-chosen string in the
 * position where a literal route keyword ("status", "quarantine") lives. The
 * two reads that take a name (`/data/datasets/:name`) validate it as a safe
 * segment first, like every other id in this server.
 *
 * Rules the registry already encodes and the console must not soften:
 *   - VERIFY IS A HASH CHECK. A mismatch means TAMPERED — badge it as such,
 *     never as "stale".
 *   - PROVENANCE IS A TAXONOMY, not a free-text note: `metadata.source`
 *     (including the canary bucket) is what makes a dataset trustworthy.
 *   - `<spec>-ratings` and `<spec>-regressions` are AUTO-MAINTAINED. Render
 *     them as such; do not offer hand edits that the next distill overwrites.
 *   - THE TEST SPLIT IS LOCKED to the release flow, with a burn count from
 *     `releases[]`. Using it is a visible, gated gesture.
 *   - QUARANTINE IS EVIDENCE. `_quarantine/` entries surface beside the
 *     registry WITH their provenance — a quarantined sample that vanishes
 *     from the UI is a bug report nobody can file.
 *   - `dataset lint` is the canary-CONTAMINATION scan across specs and
 *     few-shot pools; `dataset audit` is the registry integrity pass. They
 *     answer different questions and must not share a button.
 *
 * The growth verbs (`mine`, `synthesize`, `refresh-goldens`) are jobs, and
 * each must show a DIFF-STYLE PREVIEW before it writes: they add rows to a
 * dataset that later gates a release.
 *
 * Implementation needs `@crewhaus/dataset-registry`
 * (`createFileBackedRegistry`) added to this package's dependencies +
 * tsconfig references.
 */
import type { M3Handler } from "./m3";
import { notImplemented } from "./m3";

/**
 * `GET /api/h/:id/data/datasets` — the registry panel.
 *
 * `.crewhaus/datasets` records: split sizes, `createdAt`, the provenance
 * breakdown, verify status, and which datasets are auto-maintained.
 */
export const datasets: M3Handler = () => notImplemented("dataset registry");

/** `GET /api/h/:id/data/datasets/:name` — one dataset: splits, provenance,
 *  version history, `releases[]` burn count, and its verify state. */
export const dataset: M3Handler = () => notImplemented("dataset detail");

/**
 * `GET /api/h/:id/data/status` — `datasets status` rendered.
 *
 * Saturated always-passing samples (the dataset has stopped discriminating),
 * version freshness, and test-split burn.
 */
export const datasetStatus: M3Handler = () => notImplemented("datasets status");

/** `GET /api/h/:id/data/quarantine` — `.crewhaus/datasets/_quarantine/`
 *  entries with the provenance that explains why each was pulled. */
export const datasetQuarantine: M3Handler = () => notImplemented("dataset quarantine");

/** `POST /api/h/:id/data/verify` — body `{ name }`. Re-hash the dataset and
 *  report match / MISMATCH (tampered). A read-only job. */
export const datasetVerify: M3Handler = () => notImplemented("dataset verify");

/** `POST /api/h/:id/data/audit` — `dataset audit`: registry integrity across
 *  every dataset. Read-only; results are actionable rows, not a log dump. */
export const datasetAudit: M3Handler = () => notImplemented("dataset audit");

/** `POST /api/h/:id/data/lint` — `dataset lint`: the canary-contamination
 *  scan over specs and few-shot pools. Read-only. */
export const datasetLint: M3Handler = () => notImplemented("dataset lint");

/**
 * `POST /api/h/:id/data/mine` — `dataset mine`.
 *
 * Body: `{ name, from?, limit?, dryRun }`. Mines session struggle signals
 * into candidate samples. Preview the diff before writing; this is also the
 * hand-off target for `eval coverage`'s "draft samples from these sessions".
 */
export const datasetMine: M3Handler = () => notImplemented("dataset mine");

/** `POST /api/h/:id/data/synthesize` — `dataset synthesize`. Body:
 *  `{ name, count?, seedDataset?, dryRun }`. Same preview-first posture. */
export const datasetSynthesize: M3Handler = () => notImplemented("dataset synthesize");

/** `POST /api/h/:id/data/refresh-goldens` — `dataset refresh-goldens`. Body:
 *  `{ name, dryRun }`. Re-generating goldens changes what "correct" means,
 *  so the diff preview is mandatory, not a nicety. */
export const datasetRefreshGoldens: M3Handler = () => notImplemented("dataset refresh-goldens");
