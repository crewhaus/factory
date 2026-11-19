/**
 * The inspector's kinds: every kind Home resolves opens on a real page, and a link
 * that opens nothing says why in words.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import * as kinds from "../assets/js/inspect/kinds.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import * as router from "../assets/js/router.js";

type Ref = { scope: string; kind: string; id: string };
type KindRow = {
  noun: string;
  homeRoute(ref: Ref): string;
  tabs: readonly { id: string; label: string }[];
};
const { INSPECT_KINDS, answerWords, candidateLinks, harnessOfRef, isOlderRunId } = kinds as {
  INSPECT_KINDS: Readonly<Record<string, KindRow>>;
  answerWords(
    ref: Ref | null,
    answer: unknown,
  ): {
    title: string;
    detail: string;
    candidates?: unknown[];
  };
  candidateLinks(c: unknown): { label: string; ref: string; href: string }[];
  harnessOfRef(ref: Ref | null): string | null;
  isOlderRunId(id: unknown): boolean;
};
const { parseRoute } = router as {
  parseRoute(hash: string): { view: string; [k: string]: unknown };
};

const HRN = "hrn_0123456789abcdef";
const SAMPLE_IDS: Readonly<Record<string, string>> = {
  harness: HRN,
  deployment: "dep_01m76e6f05hp514w9j4v3qymka",
  run: "run_01m76e6f05hp514w9j4v3qymka",
  exec: "run_0123456789abcdef",
  decision: "appr_0123456789abcdef",
  rule: "rule_01m76e6f05hp514w9j4v3qymka",
  cmd: "cmd_01m76e6f05hp514w9j4v3qymka",
  principal: "prn_01m76e6f05hp514w9j4v3qymka",
  evalrun: "run_0123456789abcdef",
  session: "sess_0123456789abcdef",
};
const SCOPE: Readonly<Record<string, string>> = { harness: "home", principal: "home" };

describe("INSPECT_KINDS", () => {
  test("the eight kinds Home resolves, and eval runs and conversations, each open on a real page", () => {
    const served = ["harness", "deployment", "run", "exec", "decision", "rule", "cmd", "principal"];
    for (const kind of [...served, "evalrun", "session"]) {
      const row = INSPECT_KINDS[kind];
      expect([kind, row !== undefined]).toEqual([kind, true]);
      const ref = { scope: SCOPE[kind] ?? HRN, kind, id: SAMPLE_IDS[kind] as string };
      const route = parseRoute(row?.homeRoute(ref) ?? "");
      expect([kind, route.view === "notfound"]).toEqual([kind, false]);
      expect(row?.tabs.map((t) => t.id).slice(0, 2)).toEqual(["summary", "technical"]);
    }
    expect(Object.keys(INSPECT_KINDS).sort()).toEqual([...served, "evalrun", "session"].sort());
  });

  test("a run opens on Work › Runs with its timeline; a decision on Overview › Needs you", () => {
    for (const kind of ["run", "exec"]) {
      const ref = { scope: HRN, kind, id: SAMPLE_IDS[kind] as string };
      const route = parseRoute(INSPECT_KINDS[kind]?.homeRoute(ref) ?? "");
      expect(route).toMatchObject({ view: "harness", section: "work", sub: "runs", runId: ref.id });
      expect(INSPECT_KINDS[kind]?.tabs.map((t) => t.id)).toContain("timeline");
    }
    const decision = parseRoute(
      INSPECT_KINDS["decision"]?.homeRoute({ scope: HRN, kind: "decision", id: "appr_1" }) ?? "",
    );
    expect(decision).toMatchObject({ section: "overview", sub: "needs-you" });
    expect(harnessOfRef({ scope: "home", kind: "harness", id: HRN })).toBe(HRN);
    expect(harnessOfRef({ scope: HRN, kind: "run", id: "x" })).toBe(HRN);
    expect(harnessOfRef({ scope: "home", kind: "cmd", id: "x" })).toBeNull();
  });
});

describe("what a link that opens nothing says", () => {
  const run = (id: string) => ({ scope: HRN, kind: "run", id });

  test("not found, an older run, not served yet, and a refusal", () => {
    expect(answerWords(run("run_01m76e6f05hp514w9j4v3qymka"), { status: 404 }).title).toBe(
      "Nothing here, or you cannot see it",
    );
    for (const id of ["run_0a1b2c3d", "run_k3x9"]) {
      expect(isOlderRunId(id)).toBe(true);
      expect(answerWords(run(id), { status: 404 }).title).toBe(
        "Older run: no record of it was kept",
      );
    }
    expect(isOlderRunId("run_0123456789abcdef")).toBe(false);
    expect(isOlderRunId("run_channel")).toBe(false);
    expect(answerWords(run("run_x"), { status: 501 }).title).toBe(
      "Home does not open these links yet",
    );
    expect(answerWords(run("run_x"), { status: 403 }).title).toBe(
      "Nothing here, or you cannot see it",
    );
  });

  test("a bare id that may name several things lists them as links", () => {
    const candidates = [
      { kind: "exec", ref: `${HRN}/exec/run_0123456789abcdef` },
      { kind: "evalrun", ref: `${HRN}/evalrun/run_0123456789abcdef` },
    ];
    const words = answerWords(null, {
      status: 422,
      error: { reason: "harness_needed", details: { candidates } },
    });
    expect(words.title).toBe("This link does not say which harness it is in");
    expect(candidateLinks(words.candidates)).toEqual([
      { label: "Run", ref: candidates[0]?.ref, href: `#/i/${candidates[0]?.ref}` },
      { label: "Evaluation run", ref: candidates[1]?.ref, href: `#/i/${candidates[1]?.ref}` },
    ]);
    expect(candidateLinks([{ kind: "exec" }, null, "x"])).toEqual([]);
  });
});

describe("View spec says only what Home knows about the spec an object used", () => {
  const { specAnswer } = kinds as {
    specAnswer(
      own: unknown,
      current: unknown,
      o?: { isHarness?: boolean },
    ): { words: string; current: boolean | null };
  };
  const answer = (spec?: string) => ({
    ok: true,
    body: spec === undefined ? { kind: "run" } : { kind: "run", revisions: { spec } },
  });
  const refused = { ok: false, status: 404, error: { message: "no" } };
  const differs = "The spec this used isn't stored. The current spec is different.";

  test("a harness is its current spec", () => {
    expect(specAnswer(null, null, { isHarness: true }).current).toBe(true);
  });

  test("an object whose answer names no spec revision: Home does not know, and never says it differs", () => {
    const out = specAnswer(answer(), answer("sha256:aa"));
    expect(out.current).toBeNull();
    expect(out.words).toContain("does not record which spec this used");
    expect(out.words).not.toBe(differs);
  });

  test("a resolve that failed is not knowledge either", () => {
    expect(specAnswer(refused, answer("sha256:aa")).current).toBeNull();
    expect(specAnswer(answer("sha256:aa"), refused).current).toBeNull();
  });

  test("the same revision uses the current spec; a known other one is not stored", () => {
    expect(specAnswer(answer("sha256:aa"), answer("sha256:aa"))).toEqual({
      words: "This uses the current spec.",
      current: true,
    });
    expect(specAnswer(answer("sha256:aa"), answer("sha256:bb"))).toEqual({
      words: differs,
      current: false,
    });
  });
});

describe("a harness export says what is known about its archive", () => {
  test("a queued job is writing it; a repeat started nothing; saved only once listed", async () => {
    // @ts-expect-error — hand-written browser JS, typed as text for the embed map
    const actions = (await import("../assets/js/inspect/actions.js")) as {
      exportWords(body: unknown): { title: string; detail: string };
      savedWords(body: unknown, path: string): string;
    };
    const path = "/home/x/exports/hrn_1/abc.tar.gz";
    const queued = actions.exportWords({ path, job: { jobId: "job_1", state: "queued" } });
    expect(queued.title).toBe("Exporting the harness");
    expect(queued.detail).toContain("is writing the archive");
    expect(queued.detail).not.toContain("Saved");
    const repeat = actions.exportWords({ path, job: null });
    expect(repeat.detail).toContain("already requested");
    expect(repeat.title).not.toContain("started");
    expect(actions.savedWords({ exports: [] }, path)).toContain("Not saved yet");
    expect(actions.savedWords({ exports: [{ name: "abc.tar.gz", bytes: 9 }] }, path)).toBe(
      "Saved: abc.tar.gz.",
    );
  });
});
