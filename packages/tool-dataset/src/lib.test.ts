import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
/**
 * The pieces, tested where they are decidable.
 *
 * The centre of this file is `planSplits`, because it is the only dataset
 * logic this package owns and the reason it owns it is a defect: the shipped
 * `splitSamples` is a rank-and-cut, so adding rows moves existing rows across
 * the split boundaries. `the shipped split assignment moves existing rows`
 * measures that against the real function rather than describing it, and
 * every stability test beside it would fail against a tool built on
 * `registerDataset` alone.
 *
 * The dedupe tests assert on WORK DONE — comparisons counted, verdicts
 * reached — never on elapsed time, and the recall test shows the blocking
 * parameter (not the threshold) deciding whether a pair is seen at all.
 */
import { DEFAULT_SPLIT_SPEC, findNearDuplicates, splitSamples } from "@crewhaus/dataset-ops";
import type { DatasetSplit } from "@crewhaus/dataset-registry";
import type { Sample } from "@crewhaus/eval-dataset";
import { DEFAULT_DEDUPE_PARAMS, buildDedupeIndex, classifyCandidate } from "./lib/dedupe";
import { assignmentOf, resolveRegistryRoot } from "./lib/registry";
import { renderGiven } from "./lib/result";
import { goldCount, loadSamplesFromFile, parseInlineSamples } from "./lib/samples";
import { checkSessionId, listSessions, readJsonl } from "./lib/sessions";
import { planSplits, splitCounts } from "./lib/splits";

const originalCwd = process.cwd();
const originalDatasetsDir = process.env["CREWHAUS_DATASETS_DIR"];
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-tool-dataset-lib-"));
  process.chdir(tmp);
  Reflect.deleteProperty(process.env, "CREWHAUS_DATASETS_DIR");
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
  // An unset var must be REMOVED, not set to the string "undefined".
  if (originalDatasetsDir === undefined)
    Reflect.deleteProperty(process.env, "CREWHAUS_DATASETS_DIR");
  else process.env["CREWHAUS_DATASETS_DIR"] = originalDatasetsDir;
});

const sample = (i: number, extra: Partial<Sample> = {}): Sample => ({
  id: `s${i}`,
  input: `question number ${i}`,
  ...extra,
});

const rows = (n: number, from = 0): Sample[] =>
  Array.from({ length: n }, (_, i) => sample(from + i));

/** id → split, the way a record reports it. */
function assignmentFrom(plan: ReturnType<typeof planSplits>): Map<string, DatasetSplit> {
  return new Map(plan.assignment);
}

describe("planSplits — the property the shipped assignment does not have", () => {
  test("the shipped split assignment moves existing rows when rows are added", () => {
    // Not a claim about `splitSamples`: a measurement of it. If this ever
    // fails because the upstream assignment became stable, the stable mode
    // here becomes redundant and this file should say so.
    const before = splitSamples(rows(50), DEFAULT_SPLIT_SPEC);
    const after = splitSamples(rows(51), DEFAULT_SPLIT_SPEC);
    const where = (r: ReturnType<typeof splitSamples>): Map<string, string> => {
      const m = new Map<string, string>();
      for (const s of r.train) m.set(s.id, "train");
      for (const s of r.dev) m.set(s.id, "dev");
      for (const s of r.test) m.set(s.id, "test");
      return m;
    };
    const a = where(before);
    const b = where(after);
    const moved = [...a].filter(([id, split]) => b.get(id) !== split);
    console.log(
      `UPSTREAM_MOVED=${moved.length} ${moved.map(([id, s]) => `${id}:${s}->${b.get(id)}`).join(" ")}`,
    );
    expect(moved.length).toBeGreaterThan(0);
  });

  test("stable mode leaves every existing row in its original split", () => {
    const first = planSplits({ samples: rows(50), spec: DEFAULT_SPLIT_SPEC, mode: "stable" });
    const previous = assignmentFrom(first);
    const second = planSplits({
      samples: rows(57),
      spec: DEFAULT_SPLIT_SPEC,
      previous,
      mode: "stable",
    });
    const after = assignmentFrom(second);
    const drifted = [...previous].filter(([id, split]) => after.get(id) !== split);
    console.log(
      `STABLE moved=${second.moved.length} carried=${second.carriedForward} new=${second.newlyAssigned} counts=${JSON.stringify(splitCounts(second.splits))}`,
    );
    expect(drifted).toEqual([]);
    expect(second.moved).toEqual([]);
    expect(second.carriedForward).toBe(50);
    expect(second.newlyAssigned).toBe(7);
  });

  test("recompute mode on the same input moves rows, and reports which", () => {
    const first = planSplits({ samples: rows(50), spec: DEFAULT_SPLIT_SPEC, mode: "stable" });
    const previous = assignmentFrom(first);
    const recomputed = planSplits({
      samples: rows(51),
      spec: DEFAULT_SPLIT_SPEC,
      previous,
      mode: "recompute",
    });
    console.log(`RECOMPUTE moved=${JSON.stringify(recomputed.moved)}`);
    // The same detection code runs in both modes, so this is the control for
    // the test above: stable's empty list is a measurement, not a tautology.
    expect(recomputed.moved.length).toBeGreaterThan(0);
    for (const move of recomputed.moved) expect(move.from).not.toBe(move.to);
  });

  test("a first version is assigned exactly the way the CLI would assign it", () => {
    const plan = planSplits({ samples: rows(40), spec: DEFAULT_SPLIT_SPEC, mode: "stable" });
    const upstream = splitSamples(rows(40), DEFAULT_SPLIT_SPEC);
    expect(plan.splits.train.map((s) => s.id)).toEqual(upstream.train.map((s) => s.id));
    expect(plan.splits.dev.map((s) => s.id)).toEqual(upstream.dev.map((s) => s.id));
    expect(plan.splits.test?.map((s) => s.id)).toEqual(upstream.test.map((s) => s.id));
  });

  test("carried rows keep their position and new rows are appended after them", () => {
    const first = planSplits({ samples: rows(30), spec: DEFAULT_SPLIT_SPEC, mode: "stable" });
    const previous = assignmentFrom(first);
    const second = planSplits({
      samples: rows(34),
      spec: DEFAULT_SPLIT_SPEC,
      previous,
      mode: "stable",
    });
    // The stored per-sample hashes are folded into the dataset hash IN ARRAY
    // ORDER, so a reshuffle inside a split changes the dataset's identity
    // even when no row changed split.
    const beforeTrain = first.splits.train.map((s) => s.id);
    const afterTrain = second.splits.train.map((s) => s.id);
    expect(afterTrain.slice(0, beforeTrain.length)).toEqual(beforeTrain);
  });

  test("a test split that the new spec gives 0% to is kept, not dropped on the floor", () => {
    const first = planSplits({ samples: rows(20), spec: DEFAULT_SPLIT_SPEC, mode: "stable" });
    const previous = assignmentFrom(first);
    const testRows = first.splits.test?.length ?? 0;
    expect(testRows).toBeGreaterThan(0);
    const second = planSplits({
      samples: rows(20),
      spec: { train: 80, dev: 20, test: 0 },
      previous,
      mode: "stable",
    });
    // Keying the test key on the spec alone deletes carried-forward holdout
    // rows silently — a data loss disguised as a split change.
    expect(second.splits.test?.length).toBe(testRows);
    expect(second.moved).toEqual([]);
  });

  test("rows the previous version had and this one does not are reported as dropped", () => {
    const first = planSplits({ samples: rows(20), spec: DEFAULT_SPLIT_SPEC, mode: "stable" });
    const previous = assignmentFrom(first);
    const second = planSplits({
      samples: rows(18),
      spec: DEFAULT_SPLIT_SPEC,
      previous,
      mode: "stable",
    });
    expect(second.dropped.sort()).toEqual(["s18", "s19"]);
  });

  test("a single-split put reports the rows it pulled out of other splits", () => {
    const first = planSplits({ samples: rows(20), spec: DEFAULT_SPLIT_SPEC, mode: "stable" });
    const previous = assignmentFrom(first);
    const second = planSplits({
      samples: rows(20),
      spec: DEFAULT_SPLIT_SPEC,
      previous,
      mode: "stable",
      singleSplit: "train",
    });
    expect(second.splits.train.length).toBe(20);
    expect(second.moved.length).toBe([...previous.values()].filter((s) => s !== "train").length);
    expect(second.moved.every((m) => m.to === "train")).toBe(true);
  });

  test("assignmentOf reads the split each id actually sits in, in record order", () => {
    const record = {
      name: "d",
      version: "v1",
      splits: { train: [sample(1), sample(2)], dev: [sample(3)], test: [sample(4)] },
      sampleHashes: {},
      createdAt: "",
    };
    const assignment = assignmentOf(record);
    expect([...assignment]).toEqual([
      ["s1", "train"],
      ["s2", "train"],
      ["s3", "dev"],
      ["s4", "test"],
    ]);
  });
});

describe("dedupe — what it looks at, and what it admits it did not", () => {
  const corpusOf = (samples: ReadonlyArray<Sample>, version = "v1") =>
    samples.map((s) => ({ id: s.id, version, input: s.input, sample: s }));

  test("an id already in the registry is a duplicate before anything is scored", () => {
    const index = buildDedupeIndex(corpusOf(rows(10)));
    const result = classifyCandidate(index, sample(3));
    expect(result.verdict.verdict).toBe("duplicate-id");
    expect(result.comparisons).toBe(0);
  });

  test("the same content under a different id is caught by the registry's own hash", () => {
    const index = buildDedupeIndex(corpusOf([sample(1)]));
    const renamed: Sample = { ...sample(1), id: "other" };
    const result = classifyCandidate(index, renamed);
    expect(result.verdict.verdict).toBe("duplicate-content");
    expect(result.verdict.verdict === "duplicate-content" && result.verdict.matchedId).toBe("s1");
  });

  test("the same question carrying different provenance is still caught, by its text", () => {
    const index = buildDedupeIndex(corpusOf([sample(1)]));
    const remined: Sample = {
      id: "mine_error_abc_t1",
      input: "Question  number   1",
      metadata: { source: "production_log", mined: true },
    };
    const result = classifyCandidate(index, remined);
    expect(result.verdict.verdict).toBe("duplicate-content");
  });

  test("a 300-sample corpus does not cost 300 comparisons per candidate", () => {
    // Every row shares "support ticket about widget", which is therefore in
    // more samples than the posting cap and is dropped from the index: the
    // words that would force a full scan are exactly the words that rule
    // nothing out. What is left is each row's own distinctive token.
    const corpus = corpusOf(
      Array.from({ length: 300 }, (_, i) => ({
        id: `t${i}`,
        input: `support ticket about widget serial${i} configuration${i}`,
      })),
    );
    const index = buildDedupeIndex(corpus);
    const common = classifyCandidate(index, {
      id: "fresh",
      input: "support ticket about widget generally",
    });
    const overlapping = classifyCandidate(index, {
      id: "fresh2",
      input: "support ticket about widget serial7 in a different phrasing entirely",
    });
    console.log(
      `BLOCKED corpus=300 commonOnly=${common.comparisons} sharesRareToken=${overlapping.comparisons}`,
    );
    expect(common.verdict.verdict).toBe("new");
    expect(common.comparisons).toBe(0);
    // The rare token pulls in exactly the row that carries it.
    expect(overlapping.comparisons).toBeLessThanOrEqual(2);
    expect(overlapping.comparisons).toBeGreaterThan(0);
  });

  test("a near-duplicate is found and scored", () => {
    const index = buildDedupeIndex(
      corpusOf([
        {
          id: "existing",
          input: "the deployment webhook returns a 502 when the payload exceeds one megabyte",
        },
      ]),
      { ...DEFAULT_DEDUPE_PARAMS, threshold: 0.8 },
    );
    const result = classifyCandidate(index, {
      id: "candidate",
      input: "the deployment webhook returns a 502 whenever the payload exceeds one megabyte",
    });
    expect(result.verdict.verdict).toBe("near-duplicate");
    expect(result.verdict.verdict === "near-duplicate" && result.verdict.score).toBeGreaterThan(
      0.8,
    );
  });

  test("the blocking width, not the threshold, decides whether a pair is looked at", () => {
    // Two texts whose overlap clears the threshold comfortably. The existing
    // sample's RAREST token ("zulufoxtrot") is the one the candidate lacks, so
    // indexing one token per sample never compares them; indexing four does.
    // Whoever tunes this later must raise the width, not lower the threshold.
    const filler = Array.from({ length: 6 }, (_, i) => ({
      id: `filler${i}`,
      input: `alpha bravo charlie delta echo filler${i} padding${i} unrelated${i} distinct${i} words${i}`,
    }));
    const existing: Sample = {
      id: "existing",
      input: "alpha bravo charlie delta echo zulufoxtrot",
    };
    const candidate: Sample = { id: "candidate", input: "alpha bravo charlie delta echo" };
    const corpus = corpusOf([existing, ...filler]);
    const narrow = classifyCandidate(
      buildDedupeIndex(corpus, {
        ...DEFAULT_DEDUPE_PARAMS,
        tokensIndexedPerSample: 1,
        threshold: 0.8,
      }),
      candidate,
    );
    const wide = classifyCandidate(
      buildDedupeIndex(corpus, {
        ...DEFAULT_DEDUPE_PARAMS,
        tokensIndexedPerSample: 4,
        threshold: 0.8,
      }),
      candidate,
    );
    console.log(
      `NARROW=${narrow.verdict.verdict}/${narrow.comparisons} WIDE=${wide.verdict.verdict}/${wide.comparisons}`,
    );
    expect(narrow.verdict.verdict).toBe("new");
    expect(wide.verdict.verdict).toBe("near-duplicate");
  });

  test("a token in more samples than the posting cap is not indexed", () => {
    const corpus = corpusOf(
      Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, input: `common token number${i}` })),
    );
    const index = buildDedupeIndex(corpus, { ...DEFAULT_DEDUPE_PARAMS, maxPostingsPerToken: 5 });
    expect(index.postings.has("common")).toBe(false);
    expect(index.postings.has("number3")).toBe(true);
  });

  test("an indexed corpus cut by the cap says so, so a 'new' verdict is read as partial", () => {
    const index = buildDedupeIndex(corpusOf(rows(10)), DEFAULT_DEDUPE_PARAMS, 4);
    expect(index.indexed).toBe(4);
    expect(index.truncated).toBe(true);
    // The rows past the cap are genuinely not consulted — the verdict is
    // about the indexed prefix, which is why the caller reports it.
    expect(classifyCandidate(index, sample(9)).verdict.verdict).toBe("new");
  });

  test("a pair the lint rule calls a duplicate is never called new here", () => {
    // ONE NOTION OF "DUPLICATE", OR THE TWO TOOLS CONTRADICT EACH OTHER.
    // `DatasetLint` measures with dataset-ops' `normalizedTokens`, which
    // splits on every non-alphanumeric. A tokenizer that keeps hyphens (the
    // text package's, which this index used to be built on) scores this pair
    // 0.67 and calls the candidate NEW — after which DatasetPut writes it and
    // DatasetLint immediately flags the row that candidate just became as a
    // near-duplicate of the row it was mined against. The lint rule is asked
    // DIRECTLY here rather than restated, so this test follows the rule if
    // the rule ever moves.
    const existing: Sample = {
      id: "s1",
      input: "please reset the well-known config for the primary user account quickly",
    };
    const candidate: Sample = {
      id: "mine_error_abc_t1",
      input: "please reset the well known config for the primary user account",
    };
    const lintSaysDuplicate = findNearDuplicates([existing, candidate]).some(
      (f) => f.sampleIds?.includes(candidate.id) === true,
    );
    expect(lintSaysDuplicate).toBe(true);

    const index = buildDedupeIndex(corpusOf([existing]));
    const result = classifyCandidate(index, candidate);
    // Scored, not short-circuited: the blocking index reached it.
    expect(result.comparisons).toBe(1);
    expect(result.verdict.verdict).toBe("near-duplicate");
  });

  test("a hyphen is not a word boundary the two tools disagree about", () => {
    // The same two token sets exactly, so this pair never even reaches the
    // scorer — but only once the cheap content key is built on the same
    // tokenizer as the rule. Under a hyphen-keeping tokenizer it was "new".
    const existing: Sample = { id: "s1", input: "reset the well-known config" };
    const candidate: Sample = { id: "mine_error_abc_t1", input: "reset the well known config" };
    const index = buildDedupeIndex(corpusOf([existing]));
    expect(classifyCandidate(index, candidate).verdict.verdict).not.toBe("new");
  });

  test("turning the near-duplicate pass off answers the exact-match questions only", () => {
    const index = buildDedupeIndex(
      corpusOf([{ id: "existing", input: "alpha bravo charlie delta echo" }]),
      { ...DEFAULT_DEDUPE_PARAMS, threshold: 0.5 },
    );
    const near = { id: "candidate", input: "alpha bravo charlie delta" };
    expect(classifyCandidate(index, near, true).verdict.verdict).toBe("near-duplicate");
    expect(classifyCandidate(index, near, false).verdict.verdict).toBe("new");
  });
});

describe("samples", () => {
  test("an inline sample that does not validate is rejected by index", () => {
    const parsed = parseInlineSamples([sample(1), { id: "", input: "x" }]);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain("samples[1]");
  });

  test("an empty history is rejected — by the runner's schema, not a copy of it", () => {
    const parsed = parseInlineSamples([{ id: "a", input: "x", history: [] }]);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.code).toBe("malformed");
  });

  test("a jsonl file loads through the same schema the eval runner uses", async () => {
    writeFileSync(
      path.join(tmp, "d.jsonl"),
      `${JSON.stringify(sample(1))}\n${JSON.stringify({ ...sample(2), expected_output: "yes" })}\n`,
    );
    const loaded = await loadSamplesFromFile("T", "d.jsonl");
    expect(loaded.ok).toBe(true);
    expect(loaded.ok === true && loaded.value.samples.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(loaded.ok === true && goldCount(loaded.value.samples)).toBe(1);
  });

  test("a malformed line refuses the whole read and names the line", async () => {
    writeFileSync(path.join(tmp, "d.jsonl"), `${JSON.stringify(sample(1))}\n{not json\n`);
    const loaded = await loadSamplesFromFile("T", "d.jsonl");
    expect(loaded.ok).toBe(false);
    expect(loaded.ok === false && loaded.message).toContain("line 2");
  });

  test("a path outside the workspace is refused", async () => {
    const loaded = await loadSamplesFromFile("T", "../escape.jsonl");
    expect(loaded.ok).toBe(false);
    expect(loaded.ok === false && loaded.code).toBe("refused");
  });

  test("an http URL is never dispatched to the network loader", async () => {
    // `loadDataset` would send this to the HTTP loader. This package resolves
    // it as a path first, so it can only ever be a (missing) local file.
    const loaded = await loadSamplesFromFile("T", "https://example.invalid/data.jsonl");
    expect(loaded.ok).toBe(false);
    expect(loaded.ok === false && ["missing", "refused", "bad-input"]).toContain(
      loaded.ok === false ? loaded.code : "",
    );
  });

  test("a file with no dataset extension is refused by name", async () => {
    writeFileSync(path.join(tmp, "d.txt"), "{}");
    const loaded = await loadSamplesFromFile("T", "d.txt");
    expect(loaded.ok).toBe(false);
    expect(loaded.ok === false && loaded.message).toContain(".jsonl");
  });
});

describe("sessions", () => {
  const writeSession = (id: string, lines: unknown[]): void => {
    mkdirSync(path.join(tmp, ".crewhaus", "sessions"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".crewhaus", "sessions", `${id}.jsonl`),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
  };

  test("a trace sidecar is not listed as a session", () => {
    writeSession("s1", [{ kind: "user_message" }]);
    writeFileSync(
      path.join(tmp, ".crewhaus", "sessions", "s1.events.jsonl"),
      `${JSON.stringify({ kind: "eval_graded" })}\n`,
    );
    const listing = listSessions("T", ".crewhaus/sessions", 10);
    expect(listing.ok && listing.value.ids).toEqual(["s1"]);
  });

  test("a non-transcript file is skipped by name, not ignored", () => {
    writeSession("s1", [{}]);
    writeFileSync(path.join(tmp, ".crewhaus", "sessions", "notes.md"), "hi");
    const listing = listSessions("T", ".crewhaus/sessions", 10);
    expect(listing.ok && listing.value.skipped.join()).toContain("notes.md");
  });

  test("the cap keeps the newest by name and says the list is partial", () => {
    for (const id of ["a1", "a2", "a3"]) writeSession(id, [{}]);
    const listing = listSessions("T", ".crewhaus/sessions", 2);
    expect(listing.ok && listing.value.ids).toEqual(["a2", "a3"]);
    expect(listing.ok && listing.value.truncated).toBe(true);
    expect(listing.ok && listing.value.total).toBe(3);
  });

  test("a missing sessions directory is missing, not empty", () => {
    const listing = listSessions("T", ".crewhaus/sessions", 10);
    expect(listing.ok).toBe(false);
    expect(listing.ok === false && listing.code).toBe("missing");
  });

  test("a malformed line is counted rather than dropped", () => {
    mkdirSync(path.join(tmp, "logs"), { recursive: true });
    writeFileSync(path.join(tmp, "logs", "x.jsonl"), '{"kind":"a"}\nnot json\n{"kind":"b"}\n');
    const read = readJsonl("T", "logs/x.jsonl", 100);
    expect(read.ok && read.value.records.length).toBe(2);
    expect(read.ok && read.value.malformed).toBe(1);
  });

  test("a session id that is really a path is refused", () => {
    for (const bad of ["../escape", "a/b", "..", "a b", ""]) {
      const checked = checkSessionId(bad);
      expect({ bad, ok: checked.ok }).toEqual({ bad, ok: false });
    }
    expect(checkSessionId("sess-1").ok).toBe(true);
  });
});

describe("registry root", () => {
  test("the default root is reported as the default, and as absent when it is", () => {
    const root = resolveRegistryRoot("T");
    expect(root.ok && root.value.source).toBe("default");
    expect(root.ok && root.value.exists).toBe(false);
  });

  test("CREWHAUS_DATASETS_DIR is honoured when it stays inside the workspace", () => {
    mkdirSync(path.join(tmp, "elsewhere"), { recursive: true });
    process.env["CREWHAUS_DATASETS_DIR"] = "elsewhere";
    const root = resolveRegistryRoot("T");
    expect(root.ok && root.value.source).toBe("env");
    expect(root.ok && root.value.exists).toBe(true);
    expect(root.ok && root.value.rel).toBe("elsewhere");
  });

  test("an explicit registryDir wins over the environment", () => {
    mkdirSync(path.join(tmp, "chosen"), { recursive: true });
    process.env["CREWHAUS_DATASETS_DIR"] = "elsewhere";
    const root = resolveRegistryRoot("T", "chosen");
    expect(root.ok && root.value.source).toBe("input");
    expect(root.ok && root.value.rel).toBe("chosen");
  });

  test("CREWHAUS_DATASETS_DIR pointing out of the workspace is refused, by name", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "crewhaus-outside-"));
    process.env["CREWHAUS_DATASETS_DIR"] = outside;
    const root = resolveRegistryRoot("T");
    rmSync(outside, { recursive: true, force: true });
    expect(root.ok).toBe(false);
    // The refusal has to name the variable: an operator who exported it needs
    // to know it is why the tool will not read their registry.
    expect(root.ok === false && root.message).toContain("CREWHAUS_DATASETS_DIR");
  });

  test("a root that is a file is a bad input, not a missing registry", () => {
    writeFileSync(path.join(tmp, "notadir"), "x");
    const root = resolveRegistryRoot("T", "notadir");
    expect(root.ok).toBe(false);
    expect(root.ok === false && root.code).toBe("bad-input");
  });
});

describe("echoing caller input", () => {
  test("control characters are neutralised and long strings are bounded", () => {
    const rendered = renderGiven(`a bc\n${"x".repeat(500)}`);
    expect(rendered).not.toContain(" ");
    expect(rendered).not.toContain("");
    expect(rendered).not.toContain("\n");
    expect(rendered.length).toBeLessThanOrEqual(201);
  });
});
