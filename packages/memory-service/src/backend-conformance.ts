/**
 * v0.3.0 Goal 4 — the cross-backend WikiStore CONFORMANCE suite
 * (design §5, PR 19): "local and Thredz are contract-identical" is a test,
 * not a convention.
 *
 * This is an exported TEST-KIT FUNCTION, not a test file, and it uses no
 * test-framework APIs: given a `WikiStore`-shaped backend factory it runs
 * the contract assertions itself and returns a structured report, so the
 * SAME suite runs
 *
 *   - against the file backend today (memory-service's own
 *     backend-conformance.test.ts constructs `createWikiStore` per check),
 *   - against the Thredz backend (PR 16, parallel branch) with a factory
 *     that builds `ThredzWikiStore` over a stub server — no rewrite, just a
 *     different factory.
 *
 * The contract checked (each check gets a FRESH backend instance):
 *
 *   upsert.create              create semantics: omitted/0 expectedVersion
 *                              creates v1; round-trips title/tags/status
 *                              (default published) / verified=false
 *   upsert.version-conflict    the Thredz PATCH contract: stale or omitted
 *                              expectedVersion on an existing slug (and a
 *                              nonzero version on a missing slug) MUST fail
 *                              with the literal `stale_article_version`
 *                              (message or a `conflictCode` property), and
 *                              the losing write must change nothing
 *   recall.bundle-shape        recall(query, k) returns ≤k hits with full
 *                              refs, non-empty bodies, `via` ∈ {match,link},
 *                              scores non-increasing; k is respected
 *   signals.metadata-only      setSignals bumps NOTHING but the signals (no
 *                              version bump); a content write RESETS
 *                              verified to false (a new version is a new
 *                              unverified claim)
 *   list.staleness-ordering    list({staleFirst}) sorts updatedAt ascending
 *                              (the REFLECT order); default is descending;
 *                              status + tags filters hold
 *   visibility.defaulting      a write with no visibility signal lands
 *                              PRIVATE (the §4.3 judge-verified hole: the
 *                              backend must default-private, never
 *                              default-shared) — probed via the factory's
 *                              `visibilityOf`
 *   gap.logging                `log_knowledge_gap` (tool-wiki over the
 *                              backend store, no logGap callback) records a
 *                              draft `gap-*` article under the reserved
 *                              `gaps/` tag, discoverable via list, and a
 *                              repeat log upserts (v2) instead of conflicting
 */
import { GAPS_TAG, THREDZ_WIKI_TOOL_NAMES, createWikiTools } from "@crewhaus/tool-wiki";
import type { WikiStore } from "@crewhaus/wiki-store";

export type WikiVisibility = "private" | "shared";

/** What a backend under test supplies to the suite. */
export type WikiConformanceBackend = {
  readonly store: WikiStore;
  /**
   * Report the visibility the backend PERSISTED for a slug. The file
   * backend is private by construction (`async () => "private"`); a Thredz
   * stub returns whatever visibility field its write path received — which
   * is exactly how the suite catches a backend that inherits Thredz's
   * shared-by-default foot-gun instead of enforcing `private`.
   */
  readonly visibilityOf: (slug: string) => Promise<WikiVisibility>;
};

/** Called once per check with a unique specName — every check runs on a
 *  fresh, isolated backend. `now` is a deterministic strictly-increasing
 *  clock the backend SHOULD honor (the staleness check needs
 *  distinguishable `updatedAt`s). */
export type WikiBackendFactory = (ctx: {
  readonly specName: string;
  readonly now: () => Date;
}) => Promise<WikiConformanceBackend> | WikiConformanceBackend;

export type ConformanceCheck = {
  readonly name: string;
  readonly passed: boolean;
  /** Failure detail (assertion message) — absent on green checks. */
  readonly detail?: string;
};

export type ConformanceReport = {
  readonly backend: string;
  readonly passed: boolean;
  readonly checks: ReadonlyArray<ConformanceCheck>;
  readonly failures: ReadonlyArray<ConformanceCheck>;
};

class ConformanceAssertion extends Error {
  override readonly name = "ConformanceAssertion";
}

function ensure(cond: boolean, detail: string): asserts cond {
  if (!cond) throw new ConformanceAssertion(detail);
}

function ensureEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ensure(a === e, `${label}: expected ${e}, got ${a}`);
}

/** The stale conflict must carry the LITERAL Thredz code, either as a
 *  `conflictCode` property (the local error class) or in the message (a
 *  Thredz 409 surfaced as text) — string-matching skills see the same
 *  contract on both backends. */
function isStaleConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { conflictCode?: unknown; message?: unknown };
  if (e.conflictCode === "stale_article_version") return true;
  return typeof e.message === "string" && e.message.includes("stale_article_version");
}

function makeClock(startMs = Date.parse("2026-07-01T00:00:00.000Z")): () => Date {
  let t = startMs;
  return () => {
    const d = new Date(t);
    t += 1_000;
    return d;
  };
}

type CheckFn = (backend: WikiConformanceBackend) => Promise<void>;

const CHECKS: ReadonlyArray<readonly [string, CheckFn]> = [
  [
    "upsert.create",
    async ({ store }) => {
      const created = await store.write({
        slug: "csv-delimiters",
        title: "CSV delimiter conventions",
        body: "Comma by default; semicolon in EU locales.\n\n## Sources\n- RFC 4180",
        tags: ["csv", "locale"],
        confidence: 0.8,
      });
      ensureEqual(created, { slug: "csv-delimiters", version: 1 }, "create result");
      const zero = await store.write({
        slug: "zero-created",
        title: "Zero creates",
        body: "expectedVersion 0 must create, matching the local contract.",
        expectedVersion: 0,
      });
      ensureEqual(zero.version, 1, "expectedVersion 0 creates v1");
      const article = await store.get("csv-delimiters");
      ensure(article !== null, "get() returns the created article");
      ensureEqual(article.title, "CSV delimiter conventions", "title round-trips");
      ensureEqual([...article.tags], ["csv", "locale"], "tags round-trip");
      ensureEqual(article.version, 1, "created version");
      ensureEqual(article.verified, false, "a new article is unverified");
      ensureEqual(article.status, "published", "status defaults to published");
      ensure((await store.get("missing-slug")) === null, "get() of a missing slug is null");
    },
  ],
  [
    "upsert.version-conflict",
    async ({ store }) => {
      await store.write({ slug: "a", title: "A", body: "v1" });
      await store.write({ slug: "a", title: "A", body: "v2", expectedVersion: 1 });
      // Stale expectedVersion → the coded conflict; nothing written.
      let staleErr: unknown;
      try {
        await store.write({ slug: "a", title: "A", body: "v3-lost", expectedVersion: 1 });
      } catch (err) {
        staleErr = err;
      }
      ensure(staleErr !== undefined, "stale expectedVersion must throw");
      ensure(
        isStaleConflict(staleErr),
        `stale conflict must carry the literal stale_article_version (got: ${String(
          (staleErr as Error).message ?? staleErr,
        )})`,
      );
      ensureEqual((await store.get("a"))?.body, "v2", "the losing write changed nothing");
      // Omitted expectedVersion on an EXISTING slug is also a conflict
      // (PATCH requires the version — blind last-write-wins is forbidden).
      let omittedErr: unknown;
      try {
        await store.write({ slug: "a", title: "A", body: "v3-blind" });
      } catch (err) {
        omittedErr = err;
      }
      ensure(
        omittedErr !== undefined && isStaleConflict(omittedErr),
        "omitted expectedVersion on an existing slug must conflict",
      );
      // A nonzero expectedVersion on a MISSING slug conflicts too.
      let missingErr: unknown;
      try {
        await store.write({ slug: "brand-new", title: "B", body: "b", expectedVersion: 3 });
      } catch (err) {
        missingErr = err;
      }
      ensure(
        missingErr !== undefined && isStaleConflict(missingErr),
        "nonzero expectedVersion on a missing slug must conflict",
      );
      // The honest read-then-write path succeeds.
      const v3 = await store.write({ slug: "a", title: "A", body: "v3", expectedVersion: 2 });
      ensureEqual(v3.version, 3, "read-then-write bumps to v3");
    },
  ],
  [
    "recall.bundle-shape",
    async ({ store }) => {
      ensureEqual([...(await store.recall("anything", 5))], [], "empty wiki recalls nothing");
      await store.write({
        slug: "alpha-export",
        title: "Alpha export",
        body: "How the alpha export pipeline works, delimiter by delimiter.",
        tags: ["alpha"],
      });
      await store.write({
        slug: "alpha-import",
        title: "Alpha import",
        body: "Alpha import parsing and delimiter sniffing for alpha files.",
        tags: ["alpha"],
      });
      await store.write({
        slug: "unrelated",
        title: "Retry backoff",
        body: "Exponential backoff with jitter for network retries.",
      });
      const hits = await store.recall("alpha delimiter", 2);
      ensure(hits.length >= 1 && hits.length <= 2, `recall respects k (got ${hits.length})`);
      let prev = Number.POSITIVE_INFINITY;
      for (const hit of hits) {
        ensure(typeof hit.ref.slug === "string" && hit.ref.slug !== "", "hit.ref.slug present");
        ensure(typeof hit.ref.title === "string" && hit.ref.title !== "", "hit.ref.title present");
        ensure(typeof hit.ref.version === "number", "hit.ref.version present");
        ensure(typeof hit.body === "string" && hit.body !== "", "hit.body is the full body");
        ensure(hit.via === "match" || hit.via === "link", `hit.via valid (got ${hit.via})`);
        ensure(typeof hit.score === "number" && hit.score <= prev, "scores non-increasing");
        prev = hit.score;
      }
      ensure(
        hits.some((h) => h.ref.slug.startsWith("alpha-")),
        "a lexical match ranks in the bundle",
      );
      const one = await store.recall("alpha delimiter", 1);
      ensureEqual(one.length, 1, "k=1 returns exactly one hit");
    },
  ],
  [
    "signals.metadata-only",
    async ({ store }) => {
      await store.write({ slug: "a", title: "A", body: "v1", confidence: 0.5 });
      await store.setSignals("a", { verified: true, confidence: 0.95 });
      const signaled = await store.get("a");
      ensureEqual(signaled?.version, 1, "signals never bump the version");
      ensureEqual(signaled?.verified, true, "verified signal lands");
      ensureEqual(signaled?.confidence, 0.95, "confidence signal lands");
      ensureEqual(signaled?.body, "v1", "signals never touch the body");
      // A content write is a NEW claim: version bumps, verified resets.
      await store.write({ slug: "a", title: "A", body: "v2", expectedVersion: 1 });
      const rewritten = await store.get("a");
      ensureEqual(rewritten?.version, 2, "content write bumps the version");
      ensureEqual(rewritten?.verified, false, "content write RESETS verified");
    },
  ],
  [
    "list.staleness-ordering",
    async ({ store }) => {
      await store.write({ slug: "oldest", title: "O", body: "b", tags: ["x", "y"] });
      await store.write({ slug: "middle", title: "M", body: "b", tags: ["x"], status: "draft" });
      await store.write({ slug: "newest", title: "N", body: "b" });
      ensureEqual(
        (await store.list({ staleFirst: true })).map((r) => r.slug),
        ["oldest", "middle", "newest"],
        "staleFirst sorts updatedAt ascending",
      );
      ensureEqual(
        (await store.list()).map((r) => r.slug),
        ["newest", "middle", "oldest"],
        "default order is updatedAt descending",
      );
      ensureEqual(
        (await store.list({ tags: ["x", "y"] })).map((r) => r.slug),
        ["oldest"],
        "tags filter requires EVERY tag",
      );
      ensureEqual(
        (await store.list({ status: "draft" })).map((r) => r.slug),
        ["middle"],
        "status filter holds",
      );
      ensureEqual((await store.list({ status: "all" })).length, 3, "'all' disables the filter");
    },
  ],
  [
    "visibility.defaulting",
    async ({ store, visibilityOf }) => {
      await store.write({
        slug: "quiet-note",
        title: "Quiet note",
        body: "Written with no visibility signal at all.",
      });
      const visibility = await visibilityOf("quiet-note");
      ensureEqual(
        visibility,
        "private",
        "a write with no visibility signal must land PRIVATE (never shared-by-default)",
      );
    },
  ],
  [
    "gap.logging",
    async ({ store }) => {
      // The REAL gap-logging path: tool-wiki's log_knowledge_gap over this
      // backend, standalone (no logGap callback → the wiki fallback).
      const bundle = createWikiTools({ specName: "conformance", store });
      ensureEqual(
        bundle.all.map((t) => t.name),
        [...THREDZ_WIKI_TOOL_NAMES],
        "the thredz tool vocabulary is intact over this backend",
      );
      const first = await bundle.logKnowledgeGap.execute({
        topic: "EU locale delimiters",
        detail: "Could not answer which locales use semicolons.",
        priority: "high",
      });
      ensure(
        typeof first === "string" && first.includes("gap-eu-locale-delimiters"),
        "log_knowledge_gap reports the gap slug",
      );
      const gap = await store.get("gap-eu-locale-delimiters");
      ensure(gap !== null, "the gap landed in the store");
      ensureEqual(gap.status, "draft", "gaps are drafts (STUDY input, not knowledge)");
      ensure(gap.tags.includes(GAPS_TAG), `gaps carry the reserved ${GAPS_TAG} tag`);
      ensure(gap.tags.includes("priority:high"), "gaps carry their priority tag");
      const listed = await store.list({ tags: [GAPS_TAG] });
      ensureEqual(
        listed.map((r) => r.slug),
        ["gap-eu-locale-delimiters"],
        "gaps are discoverable via list (the STUDY entry point)",
      );
      // A repeat log UPSERTS an occurrence (read-then-write, no conflict).
      await bundle.logKnowledgeGap.execute({ topic: "EU locale delimiters" });
      const bumped = await store.get("gap-eu-locale-delimiters");
      ensureEqual(bumped?.version, 2, "a repeat gap log upserts to v2");
    },
  ],
];

/** The check names, exported so runners can enumerate/filter. */
export const WIKI_CONFORMANCE_CHECKS: ReadonlyArray<string> = CHECKS.map(([name]) => name);

/**
 * Run the full conformance suite against `factory`'s backend. Never throws
 * for CONTRACT failures — they land as `failures` in the report (a factory
 * that itself explodes fails that check with the thrown message).
 */
export async function runWikiBackendConformance(
  backendName: string,
  factory: WikiBackendFactory,
): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  for (const [name, fn] of CHECKS) {
    try {
      const backend = await factory({
        specName: `conformance-${name.replace(/[^a-zA-Z0-9]+/g, "-")}`,
        now: makeClock(),
      });
      await fn(backend);
      checks.push({ name, passed: true });
    } catch (err) {
      checks.push({
        name,
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const failures = checks.filter((c) => !c.passed);
  return { backend: backendName, passed: failures.length === 0, checks, failures };
}
