/**
 * Tests for the `crewhaus wiki` verb helpers (0.3.0 design §3.1, PR 9).
 * Store semantics live in @crewhaus/wiki-store; here we cover the CLI-side
 * spec resolution and the deterministic list/show/search/stats renders.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WikiArticle, type WikiRef, createWikiStore } from "@crewhaus/wiki-store";
import {
  WIKI_SUBDIR,
  WikiCliError,
  humanAge,
  listWikiSpecs,
  renderWikiList,
  renderWikiSearch,
  renderWikiShow,
  renderWikiStats,
  resolveWikiSpec,
} from "./wiki-cli";

let root: string;
let wikiDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wiki-cli-"));
  wikiDir = join(root, WIKI_SUBDIR);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function seedWiki(specName: string): Promise<void> {
  const store = createWikiStore({ specName, rootDir: wikiDir });
  await store.write({ slug: "a", title: "Alpha", body: "alpha body" });
}

const NOW = Date.parse("2026-07-13T12:00:00.000Z");

const ref = (overrides: Partial<WikiRef> = {}): WikiRef => ({
  slug: "csv-delimiters",
  title: "CSV delimiter conventions",
  tags: ["csv"],
  confidence: 0.8,
  verified: true,
  version: 3,
  updatedAt: "2026-07-12T12:00:00.000Z",
  links: ["eu-locale-rules"],
  status: "published",
  ...overrides,
});

describe("listWikiSpecs + resolveWikiSpec", () => {
  test("lists spec names that actually contain a wiki, sorted", async () => {
    await seedWiki("beta");
    await seedWiki("alpha");
    mkdirSync(join(wikiDir, "empty-scaffold"), { recursive: true }); // not a wiki
    expect(listWikiSpecs(wikiDir)).toEqual(["alpha", "beta"]);
  });

  test("missing dir lists nothing and resolve throws", () => {
    expect(listWikiSpecs(wikiDir)).toEqual([]);
    expect(() => resolveWikiSpec(wikiDir)).toThrow(WikiCliError);
  });

  test("a lone wiki auto-resolves; multiple require --spec; unknown --spec throws", async () => {
    await seedWiki("alpha");
    expect(resolveWikiSpec(wikiDir)).toBe("alpha");
    await seedWiki("beta");
    expect(() => resolveWikiSpec(wikiDir)).toThrow(/--spec/);
    expect(resolveWikiSpec(wikiDir, "beta")).toBe("beta");
    expect(() => resolveWikiSpec(wikiDir, "ghost")).toThrow(/no wiki for spec "ghost"/);
  });
});

describe("renders", () => {
  test("humanAge buckets minutes/hours/days", () => {
    expect(humanAge("2026-07-13T11:58:00.000Z", NOW)).toBe("2m");
    expect(humanAge("2026-07-13T02:00:00.000Z", NOW)).toBe("10h");
    expect(humanAge("2026-07-01T12:00:00.000Z", NOW)).toBe("12d");
    expect(humanAge("not-a-date", NOW)).toBe("?");
  });

  test("renderWikiList: [wiki] header + one deterministic row per ref", () => {
    const lines = renderWikiList(
      "support-bot",
      [ref(), ref({ slug: "draft-1", verified: false, status: "draft", tags: [] })],
      NOW,
    );
    expect(lines[0]).toBe("[wiki] support-bot — 2 article(s), 1 verified (stalest first)");
    expect(lines[1]).toContain("csv-delimiters");
    expect(lines[1]).toContain("v3");
    expect(lines[1]).toContain("✓0.80");
    expect(lines[1]).toContain("[csv]");
    expect(lines[2]).toContain("draft-1");
    expect(lines[2]).toContain("draft");
    expect(lines[2]).not.toContain("✓");
  });

  test("renderWikiShow: full frontmatter then the body verbatim", () => {
    const article: WikiArticle = {
      ...ref(),
      sources: ["RFC 4180"],
      supersedes: 2,
      createdBy: { sessionId: "sess_0123456789abcdef", agentIdentity: "role=researcher" },
      createdAt: "2026-07-01T00:00:00.000Z",
      body: "Comma by default.\n\n## Sources\n- RFC 4180",
    };
    const lines = renderWikiShow(article);
    expect(lines).toContain("slug:        csv-delimiters");
    expect(lines.join("\n")).toContain("supersedes v2 — priors in versions/csv-delimiters/");
    expect(lines.join("\n")).toContain("sources:     RFC 4180");
    expect(lines.join("\n")).toContain("session sess_0123456789abcdef · role=researcher");
    expect(lines[lines.length - 1]).toContain("## Sources");
  });

  test("renderWikiSearch: ranked rows, and a polite empty message", () => {
    expect(renderWikiSearch("s", "csv", [ref()])[1]).toContain("csv-delimiters (v3)");
    expect(renderWikiSearch("s", "zzz", [])[0]).toContain('no articles matched "zzz"');
  });

  test("renderWikiStats mirrors the store's corpus-health shape", () => {
    const lines = renderWikiStats("s", {
      articles: 3,
      byStatus: { draft: 1, published: 2, review: 0, archived: 0 },
      priorVersions: 4,
      uniqueTags: 5,
      verified: 1,
      averageConfidence: 0.75,
      links: 2,
    });
    expect(lines[0]).toBe("[wiki] s");
    expect(lines.join("\n")).toContain(
      "articles:        3 (published 2, draft 1, review 0, archived 0)",
    );
    expect(lines.join("\n")).toContain("prior versions:  4");
    expect(lines.join("\n")).toContain("avg confidence:  0.75");
  });
});
