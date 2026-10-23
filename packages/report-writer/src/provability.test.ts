/**
 * The research report gate (design §5.4, §8; the `@crewhaus/report-writer/
 * provability` subpath) — `writeProvableReport` over a
 * REAL citation tracker (fetch records, the sha256-named body cache, the
 * append-only citation log) and the real `CiteFact` tool, at each floor the
 * shape can meet, every failure the report can carry, and the format changes
 * that only happen when the block is on.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type CitationTracker, createCitationTracker, newRunId } from "@crewhaus/citation-tracker";
import { citationDefinitions } from "@crewhaus/claim-ledger";
import { createCiteFactTool } from "@crewhaus/crawler";
import { EXIT_CODES } from "@crewhaus/errors";
import type { IrProvability } from "@crewhaus/ir";
import {
  type EvidenceIndex,
  type VerifyOptions,
  renderMarkdownSection,
  verifyDocument,
} from "@crewhaus/provability";
import { NO_CITATIONS_NOTICE, citationNumber, writeReport } from "./index";
import {
  evidenceFromTracker,
  provabilityFailureReport,
  researchProvabilityGuidance,
  verifiedReportText,
  withCitationNumbers,
  writeProvableReport,
} from "./provability";

const NOW = (): Date => new Date("2026-10-22T12:00:00.000Z");

const config = (
  level: IrProvability["level"],
  patch: Partial<IrProvability> = {},
): IrProvability => ({
  level,
  onFail: "note",
  maxRetries: 1,
  threshold: 1,
  scope: "session",
  assumptions: "allow",
  render: "footer",
  sources: { allow: [], deny: [], bibliographic: false, resolve: "off" },
  grounded: { coverage: 0.8, windowTokens: 60, independent: 1 },
  execution: { allow: ["evaluate"], replay: true, maxReplays: 20 },
  formal: { checkers: ["builtin"], forbid: ["sorry"], timeoutMs: 30_000 },
  ...patch,
});

const POLICY_URL = "https://acme.example/policy";
const POLICY =
  "Acme refund policy. Refunds are accepted within 14 days of purchase. Store credit never expires.";
const SHIPPING_URL = "https://acme.example/shipping";
const SHIPPING = "Shipping policy. Standard shipping is free on orders over 50 dollars.";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A workspace with a tracker under it and a sources/ dir inside it. */
function workspace(): { readonly root: string; readonly tracker: CitationTracker } {
  const root = mkdtempSync(join(tmpdir(), "report-gate-"));
  made.push(root);
  mkdirSync(join(root, "sources"), { recursive: true });
  const tracker = createCitationTracker({
    runId: newRunId(),
    rootDir: join(root, ".crewhaus", "research"),
    now: NOW,
  });
  return { root, tracker };
}

/** Fetch + cite through the tracker, the way Source + CiteFact do. */
function fetchAndCite(tracker: CitationTracker, url: string, body: string, snippet: string): void {
  tracker.recordFetch({ url, content: body });
  tracker.recordCitation({ url, snippet });
}

const gate = async (
  ws: { root: string; tracker: CitationTracker },
  answers: ReadonlyArray<string>,
  cfg: IrProvability,
  extra: {
    goal?: string;
    evidence?: EvidenceIndex | (() => EvidenceIndex);
    fileRoots?: ReadonlyArray<string>;
    resolveHead?: (u: string) => Promise<number | undefined>;
    judgeWaiver?: VerifyOptions["judgeWaiver"];
  } = {},
) =>
  writeProvableReport({
    goal: extra.goal ?? "How do Acme refunds work?",
    branches: answers.map((answer, i) => ({
      question: `Question ${i + 1}?`,
      answer,
      citationUrls: [],
    })),
    citations: ws.tracker.listCitationsOrdered(),
    now: NOW,
    provability: {
      config: cfg,
      evidence:
        extra.evidence ??
        evidenceFromTracker(ws.tracker, {
          workspaceRoot: ws.root,
          ...(extra.fileRoots !== undefined ? { fileRoots: extra.fileRoots } : {}),
        }),
      workspaceRoot: ws.root,
      ...(extra.fileRoots !== undefined ? { fileRoots: extra.fileRoots } : {}),
      ...(extra.resolveHead !== undefined ? { resolveHead: extra.resolveHead } : {}),
      ...(extra.judgeWaiver !== undefined ? { judgeWaiver: extra.judgeWaiver } : {}),
    },
  });

/** The report as a CommonMark renderer shows it (what a reader of the rendered file sees). */
const html = (markdown: string): string =>
  (Bun as unknown as { markdown: { html: (md: string) => string } }).markdown.html(markdown);

describe("writeReport — untouched (an ungated report is byte-identical)", () => {
  test("the exact pre-0.8.0 bytes, citations list and all", () => {
    const r = writeReport({
      goal: "g",
      branches: [{ question: "q1", answer: "  answer 1 [1]  ", citationUrls: [POLICY_URL] }],
      citations: [
        {
          version: 1,
          url: POLICY_URL,
          snippet: "Refunds are accepted\nwithin 14 days",
          retrievedAt: "2026-05-08T00:00:00.000Z",
          sha256: "0".repeat(64),
        },
      ],
      now: NOW,
    });
    expect(r.markdown).toBe(
      `# g\n\n## q1\n\nanswer 1 [1]\n\n## Citations\n\n[1] ${POLICY_URL}\n    Refunds are accepted within 14 days\n`,
    );
    expect("proof" in r.json).toBe(false);
  });
});

describe("why the gated report renders its citations differently", () => {
  test("the ungated `[N] url` list is not the citation grammar: the gate reads it as uncited prose", async () => {
    const ws = workspace();
    fetchAndCite(
      ws.tracker,
      POLICY_URL,
      POLICY,
      "Refunds are accepted within 14 days of purchase.",
    );
    const ungated = writeReport({
      goal: "How do Acme refunds work?",
      branches: [
        {
          question: "Question 1?",
          answer: "Refunds are accepted within 14 days of purchase [1].",
          citationUrls: [POLICY_URL],
        },
      ],
      citations: ws.tracker.listCitationsOrdered(),
      now: NOW,
    });
    const bundle = await verifyDocument(ungated.markdown, {
      config: config("cited"),
      evidence: evidenceFromTracker(ws.tracker, { workspaceRoot: ws.root }),
      workspaceRoot: ws.root,
      now: NOW,
    });
    // `[1] https://…` has no colon, so nothing defines [1] — and the list
    // line itself reads as a claim.
    expect(bundle.verdict).toBe("fail");
    expect(bundle.claims[0]?.bindings[0]?.reason).toBe("no_definition");
    expect(bundle.claimCount).toBeGreaterThan(1);
    // The same answer, gated: one claim, defined, met.
    const gated = await gate(
      ws,
      ["Refunds are accepted within 14 days of purchase [1]."],
      config("cited"),
    );
    expect([gated.proof.verdict, gated.proof.claimCount]).toEqual(["pass", 1]);
  });
});

describe("evidenceFromTracker", () => {
  test("each fetched URL is a record whose body is the cached content, under its normalized origin", () => {
    const ws = workspace();
    ws.tracker.recordFetch({ url: "HTTPS://Acme.example/policy/", content: POLICY });
    const file = join(ws.root, "sources", "faq.md");
    writeFileSync(file, "faq body");
    ws.tracker.recordFetch({ url: pathToFileURL(file).href, content: "faq body" });
    const index = evidenceFromTracker(ws.tracker, { workspaceRoot: ws.root });
    expect(index.all().map((r) => [r.toolUseId, r.toolName, r.origins])).toEqual([
      ["fetch_1", "Source", [POLICY_URL]],
      ["fetch_2", "Source", ["sources/faq.md"]],
    ]);
    expect(index.bySource(POLICY_URL)[0]?.content).toBe(POLICY);
    expect(index.bySource("sources/faq.md")[0]?.content).toBe("faq body");
    expect(index.byToolUseId("fetch_2")?.input).toEqual({ uri: pathToFileURL(file).href });
  });

  test("a file outside the workspace is a record with no origin", () => {
    const ws = workspace();
    ws.tracker.recordFetch({ url: "file:///etc/hosts-elsewhere", content: "x" });
    const [record] = evidenceFromTracker(ws.tracker, { workspaceRoot: ws.root }).all();
    expect(record?.origins).toEqual([]);
  });

  test("a body that no longer hashes to its fetch record, or whose cache is gone, is not evidence", () => {
    const ws = workspace();
    ws.tracker.recordFetch({ url: POLICY_URL, content: POLICY });
    ws.tracker.recordFetch({ url: SHIPPING_URL, content: SHIPPING });
    const cacheOf = (url: string) =>
      join(
        ws.root,
        ".crewhaus",
        "research",
        ws.tracker.runId,
        "cache",
        `${ws.tracker.getFetchRecord(url)?.sha256}.txt`,
      );
    writeFileSync(cacheOf(POLICY_URL), "Refunds are accepted within 90 days.");
    rmSync(cacheOf(SHIPPING_URL));
    expect(evidenceFromTracker(ws.tracker, { workspaceRoot: ws.root }).all()).toEqual([]);
  });
});

describe("writeProvableReport — the gated report", () => {
  test("grounded pass: definitions the grammar reads, the snippet as a title, the section after Citations", async () => {
    const ws = workspace();
    fetchAndCite(
      ws.tracker,
      POLICY_URL,
      POLICY,
      "Refunds are accepted within 14 days of purchase.",
    );
    fetchAndCite(
      ws.tracker,
      SHIPPING_URL,
      SHIPPING,
      "Standard shipping is free on orders over 50 dollars.",
    );
    const r = await gate(
      ws,
      [
        "Refunds are accepted within 14 days of purchase [1].",
        "Standard shipping is free on orders over 50 dollars [2].",
      ],
      config("grounded"),
    );
    expect(r.proof.verdict).toBe("pass");
    expect(r.proof.claimCount).toBe(2);
    expect(r.proof.sources).toBe(2);
    // The definitions under the title, the branches, then the ungated
    // report's visible list (line for line) and the section.
    const ungated = writeReport({
      goal: "How do Acme refunds work?",
      branches: [],
      citations: ws.tracker.listCitationsOrdered(),
      now: NOW,
    }).markdown;
    expect(r.markdown).toBe(
      [
        "# How do Acme refunds work?",
        "",
        `[1]: ${POLICY_URL} "Refunds are accepted within 14 days of purchase."`,
        `[2]: ${SHIPPING_URL} "Standard shipping is free on orders over 50 dollars."`,
        "",
        "## Question 1?",
        "",
        "Refunds are accepted within 14 days of purchase [1].",
        "",
        "## Question 2?",
        "",
        "Standard shipping is free on orders over 50 dollars [2].",
        "",
        ungated.slice(ungated.indexOf("## Citations")).trimEnd(),
        "",
        renderMarkdownSection(r.proof),
      ].join("\n"),
    );
    expect(r.markdown.endsWith(renderMarkdownSection(r.proof))).toBe(true);
    expect(r.markdown.indexOf("## Provability")).toBeGreaterThan(
      r.markdown.indexOf("## Citations"),
    );
    // The JSON carries the same bundle, and the citations as before.
    expect(r.json.proof).toEqual(r.proof);
    expect(r.json.citations.map((c) => c.number)).toEqual([1, 2]);
    expect(r.json.generatedAt).toBe(NOW().toISOString());
    expect(r.summary).toMatchObject({ level: "grounded", verdict: "pass", claims: 2, met: 2 });
    expect(r.summary.bundleHash).toBe(r.proof.bundleHash);
  });

  test("grounded fail: a claim the source does not hold, and an uncited sentence", async () => {
    const ws = workspace();
    fetchAndCite(
      ws.tracker,
      POLICY_URL,
      POLICY,
      "Refunds are accepted within 14 days of purchase.",
    );
    const r = await gate(
      ws,
      [
        "Refunds are accepted within 90 days for every customer worldwide [1].",
        "Customers can always call the support line for exceptions.",
      ],
      config("grounded"),
    );
    expect(r.proof.verdict).toBe("fail");
    const reasons = r.proof.claims.map(
      (c) => c.bindings[0]?.reason ?? (c.bindings.length === 0 ? "no_citation" : "?"),
    );
    expect(reasons).toEqual(["not_found_in_source", "no_citation"]);
    expect(r.markdown).toContain("fail ✗");
  });

  test("a marker the report never lists is a dangling citation, not a borrowed one", async () => {
    const ws = workspace();
    fetchAndCite(
      ws.tracker,
      POLICY_URL,
      POLICY,
      "Refunds are accepted within 14 days of purchase.",
    );
    const r = await gate(
      ws,
      ["Refunds are accepted within 14 days of purchase [4]."],
      config("cited"),
    );
    expect(r.proof.claims[0]?.bindings[0]?.reason).toBe("no_definition");
  });

  test("a file:// source renders as its workspace path and grounds against the cached body", async () => {
    const ws = workspace();
    const file = join(ws.root, "sources", "shapes.md");
    const body = "CrewHaus compiles specs into harnesses. The research shape writes cited reports.";
    writeFileSync(file, body);
    fetchAndCite(
      ws.tracker,
      pathToFileURL(file).href,
      body,
      "The research shape writes cited reports.",
    );
    const r = await gate(ws, ["The research shape writes cited reports [1]."], config("grounded"));
    expect(r.markdown).toContain(
      '[1]: ./sources/shapes.md "The research shape writes cited reports."',
    );
    expect(r.proof.verdict).toBe("pass");
    expect(r.proof.claims[0]?.bindings[0]?.origin).toBe("sources/shapes.md");
  });

  test("a path with a space renders in angle brackets and still grounds", async () => {
    const ws = workspace();
    const file = join(ws.root, "sources", "my notes.md");
    writeFileSync(file, POLICY);
    fetchAndCite(ws.tracker, pathToFileURL(file).href, POLICY, "Store credit never expires.");
    const r = await gate(ws, ["Store credit never expires at Acme [1]."], config("grounded"));
    expect(r.markdown).toContain('[1]: <./sources/my notes.md> "Store credit never expires."');
    expect(r.proof.verdict).toBe("pass");
  });

  test("snippet titles: quotes pick another delimiter, brackets are escaped — never read as prose or markers", async () => {
    const ws = workspace();
    const body = 'He said "refunds take 14 days" [sic] and it\'s (still) true.';
    fetchAndCite(ws.tracker, POLICY_URL, body, 'He said "refunds take 14 days" [sic]');
    fetchAndCite(ws.tracker, SHIPPING_URL, body, `it's (still) true "really"`);
    const r = await gate(
      ws,
      ['He said "refunds take 14 days" in the policy [1] [2].'],
      config("cited"),
    );
    expect(r.markdown).toContain(`[1]: ${POLICY_URL} 'He said "refunds take 14 days" \\[sic\\]'`);
    expect(r.markdown).toContain(`[2]: ${SHIPPING_URL} "it's (still) true 'really'"`);
    // Only the answer's sentence is a claim: the titles are not.
    expect(r.proof.claimCount).toBe(1);
    expect(r.proof.verdict).toBe("pass");
  });

  test("no citations: the notice is rendered but never verified as a claim", async () => {
    const ws = workspace();
    const r = await gate(ws, ["Which refund policy do you mean?"], config("cited"));
    expect(r.proof.claimCount).toBe(0);
    expect(r.proof.verdict).toBe("pass");
    expect(r.proof.vacuous).toBeDefined();
    expect(r.markdown).toContain(`## Citations\n\n${NO_CITATIONS_NOTICE}\n\n## Provability\n`);
  });

  test("a multi-line goal is one heading line, so its second line is not an uncited claim", async () => {
    const ws = workspace();
    fetchAndCite(
      ws.tracker,
      POLICY_URL,
      POLICY,
      "Refunds are accepted within 14 days of purchase.",
    );
    const r = await gate(
      ws,
      ["Refunds are accepted within 14 days of purchase [1]."],
      config("cited"),
      {
        goal: "How do Acme refunds work?\nList every rule the policy states and explain each one.\n",
      },
    );
    expect(
      r.markdown.startsWith(
        "# How do Acme refunds work? List every rule the policy states and explain each one.\n",
      ),
    ).toBe(true);
    expect(r.proof.claimCount).toBe(1);
    expect(r.proof.verdict).toBe("pass");
  });

  test("checked: a fetched source is below the floor on this shape", async () => {
    const ws = workspace();
    fetchAndCite(
      ws.tracker,
      POLICY_URL,
      POLICY,
      "Refunds are accepted within 14 days of purchase.",
    );
    const r = await gate(
      ws,
      ["Refunds are accepted within 14 days of purchase [1]."],
      config("checked"),
    );
    expect(r.proof.verdict).toBe("fail");
    expect(r.proof.achieved).toBe("grounded");
    expect(r.proof.claims[0]?.bindings[0]?.reason).toBe("below_floor");
  });

  test("sources.resolve: head asks the injected HEAD, and a dead source is unresolved", async () => {
    const ws = workspace();
    fetchAndCite(
      ws.tracker,
      POLICY_URL,
      POLICY,
      "Refunds are accepted within 14 days of purchase.",
    );
    fetchAndCite(
      ws.tracker,
      SHIPPING_URL,
      SHIPPING,
      "Standard shipping is free on orders over 50 dollars.",
    );
    const asked: string[] = [];
    const r = await gate(
      ws,
      [
        "Refunds are accepted within 14 days of purchase [1].",
        "Standard shipping is free on orders over 50 dollars [2].",
      ],
      config("cited", { sources: { allow: [], deny: [], bibliographic: false, resolve: "head" } }),
      {
        resolveHead: async (url) => {
          asked.push(url);
          return url === POLICY_URL ? 200 : 404;
        },
      },
    );
    expect(asked.sort()).toEqual([POLICY_URL, SHIPPING_URL]);
    expect(r.proof.claims.map((c) => c.status)).toEqual(["met", "unmet"]);
    expect(r.proof.claims[1]?.bindings[0]?.reason).toBe("unresolved");
  });

  test("a verifier that throws: an unverified bundle, the section says so, the report still writes", async () => {
    const ws = workspace();
    fetchAndCite(
      ws.tracker,
      POLICY_URL,
      POLICY,
      "Refunds are accepted within 14 days of purchase.",
    );
    const broken: EvidenceIndex = {
      bySource: () => {
        throw new Error("evidence store unreadable");
      },
      byToolUseId: () => undefined,
      all: () => [],
    };
    const r = await gate(
      ws,
      ["Refunds are accepted within 14 days of purchase [1]."],
      config("grounded"),
      {
        evidence: broken,
      },
    );
    expect(r.proof.verdict).toBe("unverified");
    expect(r.proof.error).toContain("evidence store unreadable");
    expect(r.markdown).toContain("**Verdict:** unverified");
    expect(r.json.proof.verdict).toBe("unverified");
  });
});

describe("writeProvableReport — what a reader of the rendered report sees", () => {
  test("every source is visible text and every marker links through the definitions", async () => {
    const ws = workspace();
    fetchAndCite(
      ws.tracker,
      POLICY_URL,
      POLICY,
      "Refunds are accepted within 14 days of purchase.",
    );
    fetchAndCite(
      ws.tracker,
      SHIPPING_URL,
      SHIPPING,
      "Standard shipping is free on orders over 50 dollars.",
    );
    const r = await gate(
      ws,
      [
        "Refunds are accepted within 14 days of purchase [1].",
        "Standard shipping is free on orders over 50 dollars [2].",
      ],
      config("grounded"),
    );
    const rendered = html(r.markdown);
    const citations = rendered.slice(rendered.indexOf("<h2>Citations</h2>"));
    const provability = citations.indexOf("<h2>Provability</h2>");
    const list = citations.slice(0, provability);
    // The definitions block renders as nothing; the visible list is there.
    expect(rendered).not.toContain("]:");
    for (const url of [POLICY_URL, SHIPPING_URL]) expect(list).toContain(url);
    expect(list).toContain("Refunds are accepted within 14 days of purchase.");
    // The answer's markers are links to their sources, snippet as the title.
    expect(rendered).toContain(
      `<a href="${POLICY_URL}" title="Refunds are accepted within 14 days of purchase.">1</a>`,
    );
  });

  test("a snippet ending in a backslash still closes its title, so the line stays a definition", async () => {
    const ws = workspace();
    const body = "Refunds are accepted within 14 days of purchase. Files live in C:\\acme\\";
    fetchAndCite(ws.tracker, POLICY_URL, body, "Files live in C:\\acme\\");
    const r = await gate(ws, ["Acme files live in C:\\acme for refunds [1]."], config("cited"));
    expect(r.markdown).toContain(`[1]: ${POLICY_URL} "Files live in C:\\\\acme\\\\"`);
    // The gate and a renderer agree: one definition, read by both.
    expect(citationDefinitions(verifiedReportText(r.markdown) ?? "").get("1")).toBe(
      `${POLICY_URL} "Files live in C:\\\\acme\\\\"`,
    );
    const rendered = html(r.markdown);
    expect(rendered).toContain(`<a href="${POLICY_URL}" title="Files live in C:\\acme\\">1</a>`);
    expect(rendered).not.toContain(`[1]: ${POLICY_URL}`);
    expect(r.proof.verdict).toBe("pass");
  });
});

describe("writeProvableReport — a branch cannot define a source", () => {
  test("cited: a definition the branch wrote is left out, and its marker has no source", async () => {
    const ws = workspace();
    const r = await gate(
      ws,
      ["The moon is made of green cheese [9].\n\n[9]: https://fabricated.example/moon"],
      config("cited"),
    );
    expect(r.json.citations).toEqual([]);
    expect(r.proof.verdict).toBe("fail");
    expect(r.proof.claims.map((c) => c.text)).toEqual(["The moon is made of green cheese."]);
    expect(r.proof.claims[0]?.bindings[0]?.reason).toBe("no_definition");
    // The line is gone: the grammar reads no definition, and no reader sees the page.
    expect(r.markdown).not.toContain("fabricated.example");
    expect(citationDefinitions(verifiedReportText(r.markdown) ?? "").size).toBe(0);
    // The JSON keeps the answer as the model wrote it.
    expect(r.json.subAnswers[0]?.answer).toContain("[9]: https://fabricated.example/moon");
  });

  test("grounded: a branch cannot re-point a number the report defines at another page", async () => {
    const ws = workspace();
    fetchAndCite(
      ws.tracker,
      POLICY_URL,
      POLICY,
      "Refunds are accepted within 14 days of purchase.",
    );
    // Fetched, but CiteFact never accepted a fact from it.
    const RUMOR = "https://b.example/rumor";
    ws.tracker.recordFetch({
      url: RUMOR,
      content: "Refunds are accepted within 90 days of purchase for all members.",
    });
    const r = await gate(
      ws,
      [`Refunds are accepted within 90 days of purchase for all members [1].\n\n[1]: ${RUMOR}`],
      config("grounded"),
    );
    // [1] is the writer's: the policy page, which does not say 90 days.
    expect(r.proof.verdict).toBe("fail");
    expect(r.proof.claims[0]?.bindings[0]?.origin).toBe(POLICY_URL);
    expect(r.proof.claims[0]?.bindings[0]?.reason).toBe("not_found_in_source");
    expect(r.json.citations.map((c) => c.url)).toEqual([POLICY_URL]);
    expect(r.markdown).not.toContain(RUMOR);
  });

  test("every definition shape is left out: footnote ids, indents, the destination on the next line, CRLF, code", async () => {
    const ws = workspace();
    const answer = [
      "Refunds take a while at Acme [a].",
      "",
      "[^a]: https://x.example/a",
      "   [b]: https://x.example/b",
      "[c]:",
      "https://x.example/c",
      "\r\n[d]: https://x.example/d",
      "```",
      "[e]: https://x.example/e",
      "```",
      // A line the grammar's `^` starts after U+2028, which CommonMark reads as text.
      `Store credit at Acme is unusual.${String.fromCharCode(0x2028)}[f]: https://x.example/f`,
    ].join("\n");
    const r = await gate(ws, [answer], config("cited"));
    expect(citationDefinitions(verifiedReportText(r.markdown) ?? "").size).toBe(0);
    expect(r.markdown).not.toContain("x.example");
    // The code sample keeps its fences; nothing the definitions showed is read.
    expect(r.markdown).toContain("```\n```\nStore credit at Acme is unusual.\n\n## Citations");
    expect(r.proof.claims.map((c) => c.text)).toEqual([
      "Refunds take a while at Acme.",
      "Store credit at Acme is unusual.",
    ]);
    expect(r.proof.verdict).toBe("fail");
  });
});

describe("writeProvableReport — an answer that also lists its sources", () => {
  /** The policy page, fetched and cited: the writer defines it as [1]. */
  function citedPolicy(): { root: string; tracker: CitationTracker } {
    const ws = workspace();
    fetchAndCite(
      ws.tracker,
      POLICY_URL,
      POLICY,
      "Refunds are accepted within 14 days of purchase.",
    );
    return ws;
  }
  const CLAIM = "Refunds are accepted within 14 days of purchase [1].";

  /** The branch's section of a gated report: from its heading to the next. */
  const section = (markdown: string): string => {
    const from = markdown.indexOf("## Question 1?\n\n") + "## Question 1?\n\n".length;
    return markdown.slice(from, markdown.indexOf("\n\n## Citations"));
  };

  test("a correct answer ending with the writer's own definition passes at cited and grounded", async () => {
    for (const level of ["cited", "grounded"] as const) {
      const ws = citedPolicy();
      const answer = `${CLAIM}\n\n[1]: ${POLICY_URL}`;
      const r = await gate(ws, [answer], config(level, { onFail: "halt" }));
      expect(r.proof.verdict).toBe("pass");
      expect(r.proof.claims.map((c) => c.text)).toEqual([
        "Refunds are accepted within 14 days of purchase.",
      ]);
      // The answer reads as it would without the line; [1] is the writer's.
      expect(section(r.markdown)).toBe(CLAIM);
      expect(r.markdown.split(`]: ${POLICY_URL}`).length - 1).toBe(1);
      expect(r.json.subAnswers[0]?.answer).toBe(answer);
    }
  });

  test("the footnote form, [^1] and [^1]:, passes at grounded", async () => {
    const ws = citedPolicy();
    const claim = "Refunds are accepted within 14 days of purchase [^1].";
    const r = await gate(ws, [`${claim}\n\n[^1]: ${POLICY_URL}`], config("grounded"));
    expect(r.proof.verdict).toBe("pass");
    expect(r.proof.claimCount).toBe(1);
    expect(section(r.markdown)).toBe(claim);
  });

  test("every way of writing the source is left out: a title, a label, <>, the next line, CRLF, a file URL", async () => {
    const lists = [
      `[1]: ${POLICY_URL} "Acme refund policy"`,
      `[1]: ${POLICY_URL} — Acme refund policy page, read in October`,
      `[1]: <${POLICY_URL}>`,
      `[1]:\n    ${POLICY_URL}`,
      `[1]: ${POLICY_URL}\r\n[2]: file:///srv/acme/policy.md\r\n[^3]: ./sources/policy.md`,
      "  [1]: doi:10.1000/acme.2024",
      "[A1]: assume: the purchase date is the delivery date",
      "[2]: mailto:refunds@acme.example",
    ];
    for (const list of lists) {
      const ws = citedPolicy();
      const r = await gate(ws, [`${CLAIM}\n\n${list}`], config("grounded"));
      expect({ list, verdict: r.proof.verdict, claims: r.proof.claimCount }).toEqual({
        list,
        verdict: "pass",
        claims: 1,
      });
      expect(section(r.markdown)).toBe(CLAIM);
    }
  });

  test("a source named after its title is a source: a footnote, a dash, an autolink, a DOI, a path", async () => {
    // Before, only a line that opened with its source named one: these were
    // kept escaped and read as the uncited claim "\: Acme, …", failing a
    // correct answer the guidance had told the report leaves them out of.
    const lists = [
      `[^1]: Acme, "Refund policy", ${POLICY_URL}`,
      `[1]: Acme Refund Policy — ${POLICY_URL}`,
      `[1]: Acme refund policy <${POLICY_URL}>`,
      `[1]: Acme refund policy (${POLICY_URL}), read in October`,
      "[1]: Acme (2024). Refunds. doi:10.1000/acme.2024",
      "[1]: Acme (2024). Refunds. 10.1000/acme.2024",
      "[2]: Acme refunds desk <refunds@acme.example>",
      "[2]: Acme refunds desk, mailto:refunds@acme.example",
      "[3]: The policy as saved, ./sources/policy.md",
      `[1]: Acme refund policy, ${POLICY_URL}\r\n[^2]: Acme shipping — ${SHIPPING_URL}`,
    ];
    for (const list of lists) {
      const r = await gate(citedPolicy(), [`${CLAIM}\n\n${list}`], config("grounded"));
      expect({ list, verdict: r.proof.verdict, claims: r.proof.claimCount }).toEqual({
        list,
        verdict: "pass",
        claims: 1,
      });
      expect(section(r.markdown)).toBe(CLAIM);
    }
  });

  test("the lines that are part of a definition go with it: a title under it, a footnote's indented text", async () => {
    const lists = [
      // CommonMark reads a title alone on the next line as the definition's.
      `[1]: ${POLICY_URL}\n    "Acme refund policy page"`,
      `[1]: <${POLICY_URL}>\n(Acme refund policy page)`,
      `[1]:\n${POLICY_URL}\n'Acme refund policy page'`,
      // A footnote's content runs on into the lines indented under it.
      `[^1]: Acme refund policy page,\n    ${POLICY_URL}`,
      `[^1]: ${POLICY_URL}\n    Acme refund policy page, read on 2026-10-01.`,
      `[^1]:\n    Acme refund policy page,\n    ${POLICY_URL}`,
      // So does a definition-shaped paragraph that is not a definition.
      `[1]: Acme refund policy — ${POLICY_URL}\n    (retrieved October 2026)`,
      // The source on an unindented line under a bare label: the line the
      // grammar itself reads as that label's source.
      `[^1]:\nAcme, "Refund policy", ${POLICY_URL}`,
      // A bare footnote label's content runs on past its first line.
      `[^1]:\n    ${POLICY_URL}\n    Acme refund policy page, read on 2026-10-01.`,
      // A lazy continuation line that opens with the source finishes it.
      `[^1]: Acme, "Refund policy",\n${POLICY_URL}`,
      `[1]: Acme Refund Policy\n${POLICY_URL}`,
      `> [^1]: Acme, "Refund policy",\n${POLICY_URL}`,
      // In a list item, the item's own continuation; in a footnote, a list
      // indented into its content.
      `- [^1]: Acme refund policy page,\n  ${POLICY_URL}`,
      `[^1]: Acme refund policy:\n    - ${POLICY_URL}`,
    ];
    for (const list of lists) {
      const r = await gate(citedPolicy(), [`${CLAIM}\n\n${list}`], config("grounded"));
      expect({ list, verdict: r.proof.verdict, claims: r.proof.claimCount }).toEqual({
        list,
        verdict: "pass",
        claims: 1,
      });
      expect(section(r.markdown)).toBe(CLAIM);
    }
  });

  test("a source listed in a list item or a block quote is left out too", async () => {
    const lists = [
      `- [1]: ${POLICY_URL}`,
      `- [1]: Acme — ${POLICY_URL}`,
      `1. [^1]: Acme, "Refund policy", ${POLICY_URL}`,
      `* [1]: <${POLICY_URL}>\n  "Acme refund policy"`,
      `> [1]: ${POLICY_URL}`,
      `Sources:\n\n- [1]: ${POLICY_URL}\n- [2]: Acme shipping, ${SHIPPING_URL}`,
    ];
    for (const list of lists) {
      const r = await gate(citedPolicy(), [`${CLAIM}\n\n${list}`], config("grounded"));
      expect({ list, verdict: r.proof.verdict, claims: r.proof.claimCount }).toEqual({
        list,
        verdict: "pass",
        claims: 1,
      });
      expect(section(r.markdown).replace(/\n\nSources:$/, "")).toBe(CLAIM);
    }
    // A renderer reads a definition in a list item, so a branch's own number
    // would link the reader to a page the gate never saw: gone, the marker
    // has no source anywhere.
    const r = await gate(
      workspace(),
      ["The moon is made of green cheese [9].\n\n- [9]: https://fabricated.example/moon"],
      config("cited"),
    );
    expect(r.markdown).not.toContain("fabricated.example");
    expect(r.proof.claims[0]?.bindings[0]?.reason).toBe("no_definition");
  });

  test("a long run of container markers that never reaches a label is read in one pass", async () => {
    // A marker pattern whose blanks could split two ways backtracked
    // exponentially here: 18 `-   ` took seconds, 200 would never end.
    const markers = ["-   ", ">  ", "1.  "].map((unit) => `${unit.repeat(200)}x`).join("\n\n");
    const r = await gate(citedPolicy(), [`${CLAIM}\n\n${markers}`], config("cited"));
    expect(section(r.markdown)).toBe(`${CLAIM}\n\n${markers}`);
  });

  test("what is not part of a definition stays, and is read", async () => {
    const ws = citedPolicy();
    const r = await gate(
      ws,
      [
        [
          CLAIM,
          "",
          // A complete definition ends on its line: the sentences under it,
          // indented or not, are the answer's.
          `[1]: ${POLICY_URL}`,
          "Store credit never expires at Acme [1].",
          `[1]: ${POLICY_URL}`,
          "    Store credit at Acme never expires [1].",
          "",
          // Schemes need a boundary: these name nothing and stay sentences.
          "[2]: Hotel:5 stars and Returns:30 days at the Acme outlet.",
          // In a list item the grammar reads no definition: shown as written.
          "- [3]: Refunds are accepted within 90 days for members.",
        ].join("\n"),
      ],
      config("grounded"),
    );
    expect(section(r.markdown)).toBe(
      [
        CLAIM,
        "",
        "Store credit never expires at Acme [1].",
        "    Store credit at Acme never expires [1].",
        "",
        "\\[2]: Hotel:5 stars and Returns:30 days at the Acme outlet.",
        "- [3]: Refunds are accepted within 90 days for members.",
      ].join("\n"),
    );
    expect(r.proof.claims.map((c) => [c.text, c.status])).toEqual([
      ["Refunds are accepted within 14 days of purchase.", "met"],
      ["Store credit never expires at Acme.", "met"],
      ["Store credit at Acme never expires.", "met"],
      ["\\: Hotel:5 stars and Returns:30 days at the Acme outlet.", "unmet"],
      ["Refunds are accepted within 90 days for members.", "unmet"],
    ]);

    // A definition ends with its list item: the items beside it, at its own
    // level or its parent's, are the answer's claims, read and verified. A
    // false one fails the report (it once dropped with the source, leaving
    // 0/0 to pass), and a true one meets the floor.
    const unmet = (text: string) => [text, "unmet"] as const;
    const met = (text: string) => [text, "met"] as const;
    const cases: ReadonlyArray<{
      readonly answer: string;
      readonly served: string;
      readonly claims: ReadonlyArray<readonly [string, string]>;
    }> = [
      {
        answer: `- Findings:\n  - [1]: Acme refund policy — ${POLICY_URL}\n  - Refunds take 90 days for everyone [1].\n  - Store credit expires after one week [1].`,
        served:
          "- Findings:\n  - Refunds take 90 days for everyone [1].\n  - Store credit expires after one week [1].",
        claims: [
          unmet("Refunds take 90 days for everyone."),
          unmet("Store credit expires after one week."),
        ],
      },
      {
        answer: `- Policy details:\n  - [1]: Acme refund policy — ${POLICY_URL}\n  - Refunds are accepted within 14 days of purchase [1].\n  - Store credit never expires [1].`,
        served:
          "- Policy details:\n  - Refunds are accepted within 14 days of purchase [1].\n  - Store credit never expires [1].",
        claims: [
          met("Refunds are accepted within 14 days of purchase."),
          met("Store credit never expires."),
        ],
      },
      {
        answer: `- Item\n    - [1]: Acme — ${POLICY_URL}\n  - Refunds are accepted within 14 days of purchase [1].`,
        served: "- Item\n  - Refunds are accepted within 14 days of purchase [1].",
        claims: [met("Refunds are accepted within 14 days of purchase.")],
      },
      // At the top level a list after the definition's paragraph is a list
      // of its own, and an unindented sentence that does not open with a
      // source is the answer's, not the rest of the source.
      {
        answer: `[1]: Acme — ${POLICY_URL}\n  - Refunds take 90 days for everyone [1].`,
        served: "  - Refunds take 90 days for everyone [1].",
        claims: [unmet("Refunds take 90 days for everyone.")],
      },
      {
        answer: `[^1]: Acme — ${POLICY_URL}\nStore credit expires after one week [1].`,
        served: "Store credit expires after one week [1].",
        claims: [unmet("Store credit expires after one week.")],
      },
      // A destination CommonMark takes for a whole definition ends on its
      // line, whatever its scheme: the lines under it are the answer's.
      {
        answer:
          "[2]: mailto:refunds@acme.example\nStore credit never expires [1].\n\n[3]: file:///srv/acme/policy.md\n  Store credit expires after one week [1].",
        served: "Store credit never expires [1].\n\n  Store credit expires after one week [1].",
        claims: [met("Store credit never expires."), unmet("Store credit expires after one week.")],
      },
    ];
    for (const c of cases) {
      const g = await gate(citedPolicy(), [c.answer], config("grounded", { onFail: "halt" }));
      expect({ answer: c.answer, served: section(g.markdown) }).toEqual({
        answer: c.answer,
        served: c.served,
      });
      expect(g.proof.claims.map((claim) => [claim.text, claim.status])).toEqual(
        c.claims.map(([text, status]) => [text, status]),
      );
      expect(g.proof.verdict).toBe(c.claims.every(([, s]) => s === "met") ? "pass" : "fail");
    }
  });

  test("a line shaped like a definition that names no source is a sentence: shown, escaped and read", async () => {
    const ws = citedPolicy();
    const r = await gate(
      ws,
      [
        `${CLAIM}\n\n[2]: Refunds are accepted within 90 days for members.\n[3]: Returns:30 days for members at Acme.`,
      ],
      config("cited"),
    );
    expect(r.markdown).toContain("\\[2]: Refunds are accepted within 90 days for members.");
    expect(r.markdown).toContain("\\[3]: Returns:30 days for members at Acme.");
    expect(html(r.markdown)).toContain("[2]: Refunds are accepted within 90 days for members.");
    expect(r.proof.claims.map((c) => c.status)).toEqual(["met", "unmet", "unmet"]);
    expect(r.proof.verdict).toBe("fail");
  });

  test("a free-text reference is a sentence unless sources.bibliographic accepts it", async () => {
    const ref = "[2]: Smith, J. (2024). Refund policies of online stores. Acme Press.";
    const sources = (bibliographic: boolean): Partial<IrProvability> => ({
      sources: { allow: [], deny: [], bibliographic, resolve: "off" },
    });
    const off = await gate(citedPolicy(), [`${CLAIM}\n\n${ref}`], config("cited", sources(false)));
    expect(off.markdown).toContain(`\\${ref}`);
    expect(off.proof.verdict).toBe("fail");
    const on = await gate(citedPolicy(), [`${CLAIM}\n\n${ref}`], config("cited", sources(true)));
    expect(on.markdown).not.toContain("Smith");
    expect(on.proof.verdict).toBe("pass");
  });

  test("a bare label goes alone: the sentence or the fence under it stays, and is read", async () => {
    const ws = citedPolicy();
    const r = await gate(
      ws,
      [
        `${CLAIM}\n\n[c]:\nStore credit never expires at Acme [1].\n\n[d]:\n\`\`\`sh/x\nacme refund\n\`\`\``,
      ],
      config("grounded"),
    );
    expect(section(r.markdown)).toBe(
      `${CLAIM}\n\nStore credit never expires at Acme [1].\n\n\`\`\`sh/x\nacme refund\n\`\`\``,
    );
    expect(r.proof.claims.map((c) => c.text)).toEqual([
      "Refunds are accepted within 14 days of purchase.",
      "Store credit never expires at Acme.",
    ]);
    expect(r.proof.verdict).toBe("pass");
  });
});

describe("writeProvableReport — one branch's code cannot hide another's claims", () => {
  test("a fence the loose grammar reader pairs differently from CommonMark: the definitions stay readable", async () => {
    const ws = workspace();
    fetchAndCite(
      ws.tracker,
      POLICY_URL,
      POLICY,
      "Refunds are accepted within 14 days of purchase.",
    );
    const r = await gate(
      ws,
      [
        "Refunds are accepted within 14 days of purchase [1].",
        "Here is a snippet:\n\n```md\n~~~\n```\n\nStore credit never expires at Acme [1].",
      ],
      config("cited"),
    );
    expect(r.proof.claims.map((c) => c.status)).toEqual(["met", "met"]);
    expect(r.proof.verdict).toBe("pass");
  });

  test("an answer cut off inside a fence is closed at its end, so the next branch is still read", async () => {
    const ws = workspace();
    fetchAndCite(
      ws.tracker,
      POLICY_URL,
      POLICY,
      "Refunds are accepted within 14 days of purchase.",
    );
    const r = await gate(
      ws,
      [
        "Refunds are accepted within 14 days of purchase [1].\n\n````python\nrefund_window = 14",
        "Store credit is valid for ten years at Acme.",
        "~~~\nan unclosed tilde block",
      ],
      config("cited"),
    );
    // Branch 2's uncited claim is read (and fails), not hidden in branch 1's code.
    expect(r.proof.claims.map((c) => c.text)).toEqual([
      "Refunds are accepted within 14 days of purchase.",
      "Store credit is valid for ten years at Acme.",
    ]);
    expect(r.proof.verdict).toBe("fail");
    expect(r.markdown).toContain("refund_window = 14\n````\n\n## Question 2?");
    expect(r.markdown).toContain("an unclosed tilde block\n~~~\n\n## Citations");
    // A renderer agrees: the trailer is not swallowed into a code block.
    const rendered = html(r.markdown);
    expect(rendered).toContain("<h2>Question 2?</h2>");
    expect(rendered).toContain("<h2>Provability</h2>");
  });

  test("a closed fence, or one inside a list item, is left as the model wrote it", async () => {
    const ws = workspace();
    const answers = [
      "Run this:\n\n```sh\nacme refund\n```",
      "- step one is to open the app\n  ```sh\n  acme open",
    ];
    const r = await gate(ws, answers, config("cited"));
    for (const answer of answers) expect(r.markdown).toContain(`\n${answer}\n\n`);
  });
});

describe("writeProvableReport — file sources under a crawler root outside the workspace", () => {
  /** A corpus directory outside the workspace, with one fetched and cited file. */
  function corpus(ws: { tracker: CitationTracker }): {
    readonly dir: string;
    readonly url: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "report-gate-corpus-"));
    made.push(dir);
    const file = join(dir, "policy.md");
    writeFileSync(file, POLICY);
    const url = pathToFileURL(file).href;
    fetchAndCite(ws.tracker, url, POLICY, "Refunds are accepted within 14 days of purchase.");
    return { dir, url };
  }

  test("with the crawler's roots: the absolute path is defined, and it meets cited and grounded", async () => {
    const ws = workspace();
    const { dir } = corpus(ws);
    for (const level of ["cited", "grounded"] as const) {
      const r = await gate(
        ws,
        ["Refunds are accepted within 14 days of purchase [1]."],
        config(level),
        {
          fileRoots: [dir],
        },
      );
      expect([level, r.proof.verdict]).toEqual([level, "pass"]);
      expect(r.markdown).toContain(`[1]: ${join(dir, "policy.md")} "`);
      expect(r.proof.claims[0]?.bindings[0]?.origin?.endsWith("/policy.md")).toBe(true);
    }
  });

  test("a workspace source keys alike beside an outside root, and still renders as ./path", async () => {
    const ws = workspace();
    const { dir } = corpus(ws);
    const file = join(ws.root, "sources", "faq.md");
    writeFileSync(file, "Store credit never expires at Acme.");
    fetchAndCite(
      ws.tracker,
      pathToFileURL(file).href,
      "Store credit never expires at Acme.",
      "Store credit never expires at Acme.",
    );
    const r = await gate(
      ws,
      [
        "Refunds are accepted within 14 days of purchase [1].",
        "Store credit never expires at Acme [2].",
      ],
      config("grounded"),
      { fileRoots: [dir, join(ws.root, "sources")] },
    );
    expect(r.markdown).toContain('[2]: ./sources/faq.md "Store credit never expires at Acme."');
    expect(r.proof.verdict).toBe("pass");
  });

  test("without them, the same source is outside the workspace (what the gate did before)", async () => {
    const ws = workspace();
    corpus(ws);
    const r = await gate(
      ws,
      ["Refunds are accepted within 14 days of purchase [1]."],
      config("cited"),
    );
    expect(r.proof.verdict).toBe("fail");
    expect(r.proof.claims[0]?.bindings[0]?.reason).toBe("path_outside_workspace");
  });

  test("the wider root admits only what the roots name: a file under none of them is not a source", async () => {
    const ws = workspace();
    const { dir, url } = corpus(ws);
    // `other` sits beside `dir` in the temp dir — inside the widened root,
    // under no declared one (the crawler would never have fetched it).
    const other = mkdtempSync(join(tmpdir(), "report-gate-other-"));
    made.push(other);
    const otherUrl = pathToFileURL(join(other, "x.md")).href;
    writeFileSync(join(other, "x.md"), "Store credit never expires at Acme.");
    fetchAndCite(
      ws.tracker,
      otherUrl,
      "Store credit never expires at Acme.",
      "Store credit never expires at Acme.",
    );
    const index = evidenceFromTracker(ws.tracker, { workspaceRoot: ws.root, fileRoots: [dir] });
    expect(index.all().map((r) => [r.input, r.origins.length])).toEqual([
      [{ uri: url }, 1],
      [{ uri: otherUrl }, 0],
    ]);
    const r = await gate(
      ws,
      [
        "Refunds are accepted within 14 days of purchase [1].",
        "Store credit never expires at Acme [2].",
      ],
      config("cited"),
      { fileRoots: [dir] },
    );
    expect(r.markdown).toContain(`[2]: ${otherUrl} "`);
    expect(r.proof.verdict).toBe("fail");
    expect(r.proof.claims[0]?.status).toBe("met");
    // [2]'s claim — and the text its URL-form definition shows, read as one — are unlocatable.
    const rest = r.proof.claims.slice(1).map((c) => c.bindings[0]?.reason);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((reason) => reason === "not_locatable")).toBe(true);
  });
});

describe("writeProvableReport — the waiver judge (provability.judge)", () => {
  const PARAPHRASE = "Acme accepts refund requests for 14 days after a purchase [1].";

  test("a paraphrase miss at grounded is put to the judge, and a yes meets the floor", async () => {
    const ws = workspace();
    fetchAndCite(
      ws.tracker,
      POLICY_URL,
      POLICY,
      "Refunds are accepted within 14 days of purchase.",
    );
    const asked: Array<{ claim: string; source: string }> = [];
    const r = await gate(ws, [PARAPHRASE], config("grounded"), {
      judgeWaiver: async ({ claim, source }) => {
        asked.push({ claim, source });
        return { supported: true, model: "judge-model", costUsdMicros: 120 };
      },
    });
    expect(asked).toEqual([
      { claim: "Acme accepts refund requests for 14 days after a purchase.", source: POLICY_URL },
    ]);
    expect(r.proof.verdict).toBe("pass");
    expect(r.proof.judgeWaived).toBe(1);
    expect(r.proof.judgeModel).toBe("judge-model");
    expect(r.proof.spentUsdMicros).toBe(120);
    expect(r.summary).toMatchObject({ judgeModel: "judge-model", judgeCostUsdMicros: 120 });
    expect(r.markdown).toContain("accepted by the paraphrase-waiver judge (judge-model)");
  });

  test("without a judge the same paraphrase stays unmet", async () => {
    const ws = workspace();
    fetchAndCite(
      ws.tracker,
      POLICY_URL,
      POLICY,
      "Refunds are accepted within 14 days of purchase.",
    );
    const r = await gate(ws, [PARAPHRASE], config("grounded"));
    expect(r.proof.verdict).toBe("fail");
    expect(r.proof.claims[0]?.bindings[0]?.reason).toBe("not_found_in_source");
  });
});

describe("writeProvableReport — evidence that cannot be built", () => {
  test("an evidence function that throws leaves the report unverified, written", async () => {
    const ws = workspace();
    fetchAndCite(
      ws.tracker,
      POLICY_URL,
      POLICY,
      "Refunds are accepted within 14 days of purchase.",
    );
    const r = await gate(
      ws,
      ["Refunds are accepted within 14 days of purchase [1]."],
      config("grounded", { onFail: "halt" }),
      {
        evidence: () => {
          throw new Error("EISDIR: illegal operation on a directory, read");
        },
      },
    );
    expect(r.proof.verdict).toBe("unverified");
    expect(r.proof.error).toContain("EISDIR");
    expect(r.markdown).toContain("**Verdict:** unverified");
  });

  test("a cache entry that cannot be read is skipped, not thrown: its citation reads not_fetched", async () => {
    const ws = workspace();
    fetchAndCite(
      ws.tracker,
      POLICY_URL,
      POLICY,
      "Refunds are accepted within 14 days of purchase.",
    );
    const cache = join(
      ws.root,
      ".crewhaus",
      "research",
      ws.tracker.runId,
      "cache",
      `${ws.tracker.getFetchRecord(POLICY_URL)?.sha256}.txt`,
    );
    rmSync(cache);
    mkdirSync(cache);
    expect(() => ws.tracker.getFetchedContent(POLICY_URL)).toThrow();
    expect(evidenceFromTracker(ws.tracker, { workspaceRoot: ws.root }).all()).toEqual([]);
    const r = await gate(
      ws,
      ["Refunds are accepted within 14 days of purchase [1]."],
      config("grounded"),
    );
    expect(r.proof.claims[0]?.bindings[0]?.reason).toBe("not_fetched");
  });
});

describe("verifiedReportText — the served report re-verifies to the bundle it carries", () => {
  test("the text before the trailer is the text the gate verified: same verdict, same hash", async () => {
    const ws = workspace();
    fetchAndCite(
      ws.tracker,
      POLICY_URL,
      POLICY,
      "Refunds are accepted within 14 days of purchase.",
    );
    fetchAndCite(
      ws.tracker,
      SHIPPING_URL,
      SHIPPING,
      "Standard shipping is free on orders over 50 dollars.",
    );
    const r = await gate(
      ws,
      [
        "Refunds are accepted within 14 days of purchase [1].",
        "## Citations\n\nStandard shipping is free on orders over 50 dollars [2].",
      ],
      config("grounded"),
    );
    const text = verifiedReportText(r.markdown);
    expect(text).toBeDefined();
    const again = await verifyDocument(text as string, {
      config: config("grounded"),
      evidence: evidenceFromTracker(ws.tracker, { workspaceRoot: ws.root }),
      workspaceRoot: ws.root,
      now: NOW,
    });
    expect(again.verdict).toBe("pass");
    expect(again.bundleHash).toBe(r.proof.bundleHash);
    // The whole served file is not what was verified: the writer's lines read as claims.
    const whole = await verifyDocument(r.markdown, {
      config: config("grounded"),
      evidence: evidenceFromTracker(ws.tracker, { workspaceRoot: ws.root }),
      workspaceRoot: ws.root,
      now: NOW,
    });
    expect(whole.claimCount).toBeGreaterThan(r.proof.claimCount);
  });

  test("an ungated report, or any other document, is not a gated report", () => {
    const ungated = writeReport({
      goal: "g",
      branches: [{ question: "q", answer: "a [1]", citationUrls: [] }],
      citations: [],
      now: NOW,
    });
    expect(verifiedReportText(ungated.markdown)).toBeUndefined();
    expect(verifiedReportText("# Notes\n\nNothing here.\n")).toBeUndefined();
  });
});

describe("withCitationNumbers — CiteFact names the report's number", () => {
  const cite = (tracker: CitationTracker) =>
    withCitationNumbers(createCiteFactTool({ tracker }), tracker);

  test("each recorded fact is told its number: by URL, on first appearance, stable on repeat", async () => {
    const ws = workspace();
    ws.tracker.recordFetch({ url: POLICY_URL, content: POLICY });
    ws.tracker.recordFetch({ url: SHIPPING_URL, content: SHIPPING });
    const tool = cite(ws.tracker);
    const first = await tool.execute({
      uri: POLICY_URL,
      snippet: "Refunds are accepted within 14 days",
    });
    const second = await tool.execute({ uri: SHIPPING_URL, snippet: "Standard shipping is free" });
    const again = await tool.execute({ uri: POLICY_URL, snippet: "Store credit never expires." });
    expect(first).toEndWith(
      "Cite it as [1]: put [1] right after each sentence this fact supports.",
    );
    expect(second).toEndWith(
      "Cite it as [2]: put [2] right after each sentence this fact supports.",
    );
    expect(again).toEndWith(
      "Cite it as [1]: put [1] right after each sentence this fact supports.",
    );
    // The number the model was told is the number the report prints.
    const r = writeReport({
      goal: "g",
      branches: [],
      citations: ws.tracker.listCitationsOrdered(),
      now: NOW,
    });
    expect(r.json.citations.map((c) => `${c.number} ${c.url}`)).toEqual([
      `1 ${POLICY_URL}`,
      `2 ${SHIPPING_URL}`,
    ]);
    expect(citationNumber(ws.tracker.listCitationsOrdered(), SHIPPING_URL)).toBe(2);
  });

  test("a refused quote, or a uri never loaded, gets no number", async () => {
    const ws = workspace();
    ws.tracker.recordFetch({ url: POLICY_URL, content: POLICY });
    const tool = cite(ws.tracker);
    const refused = await tool.execute({ uri: POLICY_URL, snippet: "Refunds take 90 days." });
    const unloaded = await tool.execute({
      uri: SHIPPING_URL,
      snippet: "Standard shipping is free",
    });
    expect(String(refused)).toStartWith("[CiteFact rejected]");
    expect(String(refused)).not.toContain("Cite it as");
    expect(String(unloaded)).not.toContain("Cite it as");
    expect(ws.tracker.listCitationsOrdered()).toEqual([]);
  });

  test("everything but the result and the description is the wrapped tool's", () => {
    const ws = workspace();
    const plain = createCiteFactTool({ tracker: ws.tracker });
    const wrapped = withCitationNumbers(plain, ws.tracker);
    expect(wrapped.name).toBe("CiteFact");
    expect(wrapped.inputSchema).toBe(plain.inputSchema);
    expect([wrapped.readOnly, wrapped.concurrencySafe, wrapped.destructive, wrapped.scope]).toEqual(
      [plain.readOnly, plain.concurrencySafe, plain.destructive, plain.scope],
    );
    expect(wrapped.description.startsWith(plain.description)).toBe(true);
    expect(wrapped.description).toContain("citation number");
  });

  test("an input without a string uri passes straight through", async () => {
    const ws = workspace();
    let called = 0;
    const tool = withCitationNumbers(
      { ...createCiteFactTool({ tracker: ws.tracker }), execute: async () => `ran ${++called}` },
      ws.tracker,
    );
    expect(await tool.execute({ uri: 7 })).toBe("ran 1");
    expect(await tool.execute(null)).toBe("ran 2");
  });
});

describe("researchProvabilityGuidance", () => {
  test("names the floor, the CiteFact numbering rule and the rung's own check", () => {
    for (const level of ["cited", "grounded", "checked", "proven"] as const) {
      const text = researchProvabilityGuidance(config(level));
      expect(text).toContain(`the \`${level}\` floor`);
      expect(text).toContain("CiteFact");
      expect(text).toContain("write no definition lines");
      expect(text).toContain(`At \`${level}\``);
    }
    expect(researchProvabilityGuidance(config("grounded"))).toContain("quote it when you can");
  });
});

describe("provabilityFailureReport", () => {
  test("class provability, exit 37, the score, the tallied reasons and the bundle's path", async () => {
    const ws = workspace();
    fetchAndCite(
      ws.tracker,
      POLICY_URL,
      POLICY,
      "Refunds are accepted within 14 days of purchase.",
    );
    const r = await gate(
      ws,
      ["Shipping is always free for members [1].", "Gift cards are sold online in every region."],
      config("grounded", { assumptions: "forbid" }),
    );
    const report = provabilityFailureReport(r.proof, "/x/proof.json");
    expect(report.class).toBe("provability");
    expect(report.exitCode).toBe(EXIT_CODES.provability);
    expect(report.exitCode).toBe(37);
    expect(report.detail).toContain("0/2 claims of the research report met the grounded floor");
    expect(report.detail).toContain("unmet: not_found_in_source, no_citation");
    expect(report.detail).toContain("proof bundle: /x/proof.json");
    expect(report.remediation).toContain("on_fail: note");
  });
});
