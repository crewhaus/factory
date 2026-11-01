/**
 * 0.8.0 (design/0.8.0-provability-release.md §1 principle 3, §15) — the
 * release notes promise that a spec without `provability:` runs as before,
 * apart from the changes listed under "Changes that can affect a harness
 * without `provability:`". The first review of the release changed three
 * things every harness sees: the runtime-state floor and the tools that
 * refuse on their own (§10), the WebFetch header, and the warnings
 * `compile --emit-as cf-worker` gives. None of them reached that list, so the
 * promise was false where it matters most: a deny no rule can lift. The
 * second review then folded the text FactCrossCheck compares (claim-ledger's
 * `fold.ts`, §4.1: one kernel for the tool and the gate), which moves the
 * tool's verdicts in every harness that grants it, and that missed the list
 * too.
 *
 * So each change is FOUND in the code that makes it, and a list must name
 * what was found: the roots the runtime protects in a run without the block,
 * every tool that checks its own writes against them, every WebFetch header
 * line 0.7.x did not print, every block the edge says it does not run
 * besides `provability:` itself, and every kind of spelling FactCrossCheck
 * no longer reads the way 0.7.x did. A change reverted or scoped to the
 * block stops being found, and a new root, tool, header line, edge warning
 * or verdict that moved fails until the notes name it. Each scan also
 * asserts it found something, so a scan that silently matches nothing fails
 * too.
 *
 * The guard reads 0.8.0's list, under `PROVABILITY_HEADING`, and every later
 * release's list, under `DEFAULT_ON_HEADING`, which sits in `## [Unreleased]`
 * until the release is cut. 0.8.0's list is released and does not change. A
 * new kind of default-on change adds a check here and a bullet in the
 * `## [Unreleased]` list.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { cfWorkerUnwiredBlockWarnings } from "../packages/compiler/src/index";
import { runtimeStateRoots } from "../packages/runtime-core/src/state-roots";
import { factCrossCheck } from "../packages/tool-verify/src/index";

const ROOT = dirname(import.meta.dir);
/** 0.8.0's list, as released. It does not change. */
const PROVABILITY_HEADING = "**Changes that can affect a harness without `provability:`.**";
/** Every later release's list, in `## [Unreleased]` until the release is cut. */
const DEFAULT_ON_HEADING = "**Changes that can affect a harness without opting in.**";
/**
 * The headings that open a list, each matched byte for byte. An explicit
 * list, not a prefix or a pattern: a release that writes a heading of its own
 * has to add it here on purpose, rather than have the guard match it
 * silently.
 */
const HEADINGS = [PROVABILITY_HEADING, DEFAULT_ON_HEADING] as const;

/**
 * The bullets of every list in `text` that one of `headings` opens, in
 * document order, each folded onto one line. A heading opens a list only
 * where a line starts with it: a mention mid-line opens nothing, and the
 * rest of the heading's line is the list's intro, not a bullet. A bullet
 * starts at a line that begins `- ` and takes in the lines after it up to a
 * blank line or the next bullet. A list ends at the next bold paragraph
 * (0.8.0's ends at `**The 0.7.1 hardening.**`) or at the next Markdown
 * heading, such as a `### Fixed` after it or the `## [` of the entry below,
 * so a bullet outside a list cannot satisfy a check.
 */
function defaultOnBullets(text: string, headings: readonly string[] = HEADINGS): string[] {
  const bullets: string[] = [];
  let inList = false;
  let open = false;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (headings.some((heading) => line.startsWith(heading))) {
      inList = true;
      open = false;
      continue;
    }
    if (!inList) continue;
    if (line.startsWith("**") || /^#{1,6}(\s|$)/.test(line)) {
      inList = false;
      open = false;
      continue;
    }
    if (line.startsWith("- ")) {
      bullets.push(line.slice(2).trim());
      open = true;
    } else if (line.trim() === "") {
      open = false;
    } else if (open) {
      bullets[bullets.length - 1] += ` ${line.trim()}`;
    }
  }
  return bullets;
}

/** The items in `found` that `notes` does not name as `` `item` ``, in the order given. */
function unlisted(found: Iterable<string>, notes: string): string[] {
  return [...found].filter((item) => !notes.includes(`\`${item}\``));
}

/** The real notes, read once. */
const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
/** Every bullet of every default-on list, 0.8.0's and every later release's. */
const bullets = defaultOnBullets(changelog);
const notes = bullets.join("\n");

/** Workspace source files (tracked or new, never dist or a test) that contain `needle`. */
function sourcesContaining(needle: string): string[] {
  const out = Bun.spawnSync(
    ["git", "grep", "-l", "-z", "--untracked", "-F", "-e", needle, "--", "packages", "apps"],
    { cwd: ROOT },
  );
  return out.stdout
    .toString()
    .split("\0")
    .filter((f) => /\/src\/.+\.ts$/.test(f) && !/\.test\.ts$/.test(f) && !f.includes("/dist/"));
}

const at = (...points: number[]): string => String.fromCodePoint(...points);
const REFUND = "The refund window is 30 days.";

/**
 * One claim and source per kind of spelling a reader cannot tell from the
 * plain one, with the verdict 0.7.x's FactCrossCheck gave the pair (0.7.0's
 * and 0.7.1's alike, each run against this table) and, as `kind`, the words
 * the notes use for it. A kind the fold comes to read is added here with its
 * 0.7.x verdict.
 */
const SPELLINGS: ReadonlyArray<{
  readonly kind: string;
  readonly claim: string;
  readonly source: string;
  readonly was: string;
}> = [
  {
    kind: "any script",
    claim: REFUND,
    source: `The refund window is ${at(0x663, 0x660)} days.`,
    was: "notFound",
  },
  {
    kind: "fullwidth",
    claim: REFUND,
    source: `The refund window is ${at(0xff13, 0xff10)} days.`,
    was: "notFound",
  },
  {
    kind: "fullwidth",
    claim: REFUND,
    source: `The ${at(0xff52, 0xff45, 0xff46, 0xff55, 0xff4e, 0xff44)} window is 30 days.`,
    was: "notFound",
  },
  {
    kind: "mathematical",
    claim: REFUND,
    source: `The refund window is ${at(0x1d7d1, 0x1d7ce)} days.`,
    was: "notFound",
  },
  {
    kind: "superscript",
    claim: `It costs ${at(0xb3, 0x2070)} dollars.`,
    source: "It costs 30 dollars.",
    was: "notFound",
  },
  {
    kind: "Cyrillic",
    claim: "The office is in Moscow.",
    source: `The office is in M${at(0x43e)}scow.`,
    was: "notFound",
  },
  {
    kind: "Greek",
    claim: "The office is in Athens.",
    source: `The office is in ${at(0x391)}thens.`,
    was: "notFound",
  },
  {
    kind: "soft hyphen",
    claim: REFUND,
    source: `The re${at(0xad)}fund window is 30 days.`,
    was: "notFound",
  },
  {
    kind: "zero-width",
    claim: REFUND,
    source: `The refund win${at(0x200b)}dow is 30 days.`,
    was: "notFound",
  },
  { kind: "footnote", claim: `${REFUND}${at(0xb9)}`, source: REFUND, was: "notFound" },
  // The one that moves the other way: a negation 0.7.x did not see.
  {
    kind: "`polarityConflict`",
    claim: "The budget was approved by the board.",
    source: `The budget was n${at(0x200b)}ot approved by the board.`,
    was: "supported",
  },
];

/**
 * FactCrossCheck's verdict on each claim against its own source, through the
 * tool's schema and `execute` as a harness calls it. The tool reads files
 * under the working directory, so it runs in a workspace of its own and the
 * directory is put back.
 */
async function crossCheck(
  pairs: ReadonlyArray<{ readonly claim: string; readonly source: string }>,
): Promise<string[]> {
  const home = process.cwd();
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-default-on-fcc-")));
  try {
    for (const [i, pair] of pairs.entries()) writeFileSync(join(workspace, `${i}.md`), pair.source);
    process.chdir(workspace);
    const input = factCrossCheck.inputSchema.parse({
      claims: pairs.map((pair, i) => ({ text: pair.claim, sources: [`${i}.md`] })),
    });
    const report = JSON.parse(String(await factCrossCheck.execute(input))) as {
      claims: Array<{ verdict: string }>;
    };
    return report.claims.map((claim) => claim.verdict);
  } finally {
    process.chdir(home);
    rmSync(workspace, { recursive: true, force: true });
  }
}

describe("the guard reads every release's default-on list", () => {
  test("both headings are in the CHANGELOG, each where it belongs", () => {
    // Line by line, as the parser reads it. This never looks for
    // `## [Unreleased]` itself, so the release can retitle that entry with
    // its version and this still holds.
    const lines = changelog.replace(/\r\n/g, "\n").split("\n");
    const startingWith = (heading: string): number[] =>
      lines.flatMap((line, i) => (line.startsWith(heading) ? [i] : []));
    const entry = lines.indexOf("## [0.8.0] - 2026-10-25");
    expect(entry).toBeGreaterThan(-1);
    const nextEntry = lines.findIndex((line, i) => i > entry && line.startsWith("## ["));
    expect(nextEntry).toBeGreaterThan(entry);
    // 0.8.0's list: once, inside 0.8.0's entry.
    const provability = startingWith(PROVABILITY_HEADING);
    expect(provability).toHaveLength(1);
    expect(provability[0]).toBeGreaterThan(entry);
    expect(provability[0]).toBeLessThan(nextEntry);
    // Every later release's list: inside an entry above 0.8.0's, never in
    // the preamble. The line numbers of any copy out of place:
    const firstEntry = lines.findIndex((line) => line.startsWith("## ["));
    const defaultOn = startingWith(DEFAULT_ON_HEADING);
    expect(defaultOn.length).toBeGreaterThan(0);
    expect(defaultOn.filter((i) => i < firstEntry || i > entry).map((i) => i + 1)).toEqual([]);
  });

  test("0.8.0's list is released, so it neither grows nor changes", () => {
    // The 13 bullets 0.8.0 shipped with, folded and joined as the parser
    // reads them. A later default-on change is listed under
    // DEFAULT_ON_HEADING, in `## [Unreleased]`, and a correction goes in the
    // newest entry, as `### Corrections to the 0.7.0 notes` did. Without
    // this, a change could pass every check in this file by joining a list
    // that has already shipped, or by editing one of its bullets.
    const shipped = defaultOnBullets(changelog, [PROVABILITY_HEADING]);
    expect(shipped).toHaveLength(13);
    expect(createHash("sha256").update(shipped.join("\n")).digest("hex")).toBe(
      "a671f6e37147a2bc254c9a9923d438917b20f256cd58f37ebb50f6e81528ea71",
    );
  });

  // The parser on notes written here, so each rule is tested alone.

  /** An `## [Unreleased]` entry shaped like the real one, its list holding `items`. */
  const unreleasedEntry = (...items: string[]): string[] => [
    "## [Unreleased]",
    "",
    "### Changed",
    "",
    "#### Before you upgrade",
    "",
    `${DEFAULT_ON_HEADING} No spec has to turn`,
    "these on: they reach every harness that uses what each one names.",
    "",
    ...items,
    "",
  ];
  /** 0.8.0's entry shaped like the real one, its list holding `items`, then the 0.7.1 hardening. */
  const releasedEntry = (...items: string[]): string[] => [
    "## [0.8.0] - 2026-10-25",
    "",
    "### Changed",
    "",
    "#### Before you upgrade",
    "",
    `${PROVABILITY_HEADING} The gate is off`,
    "until a spec turns it on, but these changes reach every harness that uses",
    "what each one names.",
    "",
    ...items,
    "",
    "**The 0.7.1 hardening.** Most 0.7.0 specs compile and run unchanged.",
    "",
    "- **Bun 1.3.14 or later.** A hardening change, in no default-on list.",
    "",
  ];

  test("both lists are read, in document order, and `headings` chooses which", () => {
    const text = [
      ...unreleasedEntry("- **New one.** Listed first.", "- **New two.** Listed second."),
      ...releasedEntry("- **Old one.** Listed in 0.8.0."),
    ].join("\n");
    expect(defaultOnBullets(text)).toEqual([
      "**New one.** Listed first.",
      "**New two.** Listed second.",
      "**Old one.** Listed in 0.8.0.",
    ]);
    expect(defaultOnBullets(text, [DEFAULT_ON_HEADING])).toEqual([
      "**New one.** Listed first.",
      "**New two.** Listed second.",
    ]);
    expect(defaultOnBullets(text, [PROVABILITY_HEADING])).toEqual([
      "**Old one.** Listed in 0.8.0.",
    ]);
  });

  test("a list ends at the next bold paragraph and at the next heading", () => {
    // A bullet after each end, with no list heading in between, is not the
    // list's. Keyed by the end, so a failure names the rule that broke.
    const ends = [
      "**The 0.7.1 hardening.** Most 0.7.0 specs compile and run unchanged.",
      "### Fixed",
      "## [0.8.0] - 2026-10-25",
    ];
    const listEndingAt = (end: string): string =>
      [
        `${DEFAULT_ON_HEADING} No spec has to turn these on.`,
        "",
        "- **Listed.** It is in the list.",
        "",
        end,
        "",
        "- **After the end.** It is not.",
        "",
      ].join("\n");
    expect(
      Object.fromEntries(ends.map((end) => [end, defaultOnBullets(listEndingAt(end))])),
    ).toEqual(Object.fromEntries(ends.map((end) => [end, ["**Listed.** It is in the list."]])));
  });

  test("a heading opens a list only at the start of a line", () => {
    // A bullet that quotes the heading mid-line, or wraps so that its
    // continuation line starts with it, opens nothing, and the bullets after
    // it are in no list.
    const text = [
      "### Changed",
      "",
      `- **The notes moved.** A default-on change is listed under ${DEFAULT_ON_HEADING}`,
      "- **It wraps.** A default-on change is listed under",
      `  ${DEFAULT_ON_HEADING} as well.`,
      "- **Another change.** It is in no list.",
      "",
    ].join("\n");
    expect(defaultOnBullets(text)).toEqual([]);
  });

  test("a bullet folds onto one line, a blank line closes it, and the intro is no bullet", () => {
    const text = [
      `${DEFAULT_ON_HEADING} The intro on the heading's line,`,
      "and the intro's next line, are not bullets.",
      "",
      "- **Folded.** A bullet's first line",
      "  and its continuation come back as one line.",
      "- **Closed.** A blank line closes this bullet.",
      "",
      "A paragraph after the blank line is not appended to it.",
      "",
      "- **Also closed.** So does a line of spaces.",
      "   ",
      "Nor is a paragraph after that.",
      "",
      "- **Next.** A bullet after the paragraphs.",
      "",
    ].join("\n");
    const expected = [
      "**Folded.** A bullet's first line and its continuation come back as one line.",
      "**Closed.** A blank line closes this bullet.",
      "**Also closed.** So does a line of spaces.",
      "**Next.** A bullet after the paragraphs.",
    ];
    expect(defaultOnBullets(text)).toEqual(expected);
    expect(defaultOnBullets(text.replace(/\n/g, "\r\n"))).toEqual(expected);
  });

  test("an empty list reads nothing, and swallows nothing after it", () => {
    const text = [
      ...unreleasedEntry(),
      "## [0.8.0] - 2026-10-25",
      "",
      "- **A summary bullet.** It is in no list.",
      "",
      "### Changed",
      "",
      "- **A change.** Nor is this one.",
      "",
    ].join("\n");
    expect(defaultOnBullets(text)).toEqual([]);
  });

  test("a planted default-on change fails until the newest list names it", () => {
    // The floor test's check, against notes that name a planted root in one
    // place, or in none.
    const PLANTED = ".crewhaus/planted";
    const PLACES = [
      "nowhere",
      "the list",
      "### Fixed",
      "the intro",
      "the 0.7.1 hardening",
      "0.8.0's list",
    ] as const;
    type Place = (typeof PLACES)[number];
    const notesNaming = (place: Place): string => {
      const name = (here: Place): string => (here === place ? `\`${PLANTED}\`` : "a path");
      return [
        "## [Unreleased]",
        "",
        "### Changed",
        "",
        "#### Before you upgrade",
        "",
        `${DEFAULT_ON_HEADING} No spec has to turn on ${name("the intro")}.`,
        "",
        `- **A new root.** The runtime now protects ${name("the list")}.`,
        "",
        "### Fixed",
        "",
        `- **A fix.** It touches ${name("### Fixed")}.`,
        "",
        "## [0.8.0] - 2026-10-25",
        "",
        `${PROVABILITY_HEADING} The gate is off until a spec turns it on.`,
        "",
        `- **A released change.** It names ${name("0.8.0's list")}.`,
        "",
        "**The 0.7.1 hardening.** Most 0.7.0 specs compile and run unchanged.",
        "",
        `- **A hardening change.** It names ${name("the 0.7.1 hardening")}.`,
        "",
      ].join("\n");
    };
    // Every place but "nowhere" plants the name, so no case passes by
    // leaving it out.
    expect(PLACES.filter((place) => notesNaming(place).includes(`\`${PLANTED}\``))).toEqual(
      PLACES.filter((place) => place !== "nowhere"),
    );
    const unlistedIn = (place: Place): string[] =>
      unlisted([PLANTED], defaultOnBullets(notesNaming(place)).join("\n"));
    expect(Object.fromEntries(PLACES.map((place) => [place, unlistedIn(place)]))).toEqual({
      nowhere: [PLANTED],
      "the list": [],
      "### Fixed": [PLANTED],
      "the intro": [PLANTED],
      "the 0.7.1 hardening": [PLANTED],
      // The parser reads 0.8.0's list too, so a name there passes here. In
      // the real file, the test that holds 0.8.0's list to what shipped
      // refuses it.
      "0.8.0's list": [],
    });
  });
});

describe("the release notes name every change a harness without provability: sees", () => {
  test("the list is there to check", () => {
    expect(bullets.length).toBeGreaterThan(0);
  });

  test("the runtime-state floor: every root a run without the block protects, and what bypass lifts", () => {
    // The roots of a run with no tenant and no session-dir override, the
    // call runChatLoop makes for every harness; a path that does not exist
    // only spells them, nothing is created.
    const cwd = join(tmpdir(), "crewhaus-default-on-changes");
    const roots = runtimeStateRoots(undefined, undefined, cwd)
      .filter((root) => !isAbsolute(root))
      .map((root) => root.split(sep).join("/"));
    expect(roots.length).toBeGreaterThan(0);
    const unnamed = unlisted(roots, notes);
    expect(unnamed).toEqual([]);
    // The bullet that names them says how far bypass reaches and what the
    // floor cannot see (permission-engine `EvaluateOptions.protectedRoots`).
    const floor = bullets.find((b) => roots.every((root) => b.includes(`\`${root}\``))) ?? "";
    expect(floor).toContain("bypass");
    expect(floor).toContain("`Bash`");
    expect(floor).toContain("`RunCommand`");
  });

  test("every tool that refuses a write into those roots on its own is named", () => {
    // Each `protectedRootsOf(ctx)` call is a tool checking its own targets
    // against the roots on its bridge — in every permission mode, bypass
    // included — and the tool is the one whose `name:` precedes the call.
    const tools = new Set<string>();
    const unattributed: string[] = [];
    for (const file of sourcesContaining("protectedRootsOf(")) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const names = [...text.matchAll(/\bname: "([A-Z][A-Za-z0-9]*)"/g)];
      for (const call of text.matchAll(/(?<!function )\bprotectedRootsOf\(/g)) {
        const owner = names.filter((m) => (m.index ?? 0) < (call.index ?? 0)).at(-1);
        if (owner?.[1] === undefined) unattributed.push(`${file}@${call.index}`);
        else tools.add(owner[1]);
      }
    }
    expect(unattributed).toEqual([]);
    // CopyPath, MovePath, RemovePath, ArchiveExtract (tool-fsx),
    // GitApplyPatch (tool-git), StateImport (tool-state) and StoreMigrate
    // (tool-lifecycle) today.
    expect(tools.size).toBe(7);
    const unnamed = unlisted(tools, notes).sort();
    expect(unnamed).toEqual([]);
  });

  test("WebFetch: a header line 0.7.x did not print is named", () => {
    const source = readFileSync(join(ROOT, "packages", "tool-web", "src", "index.ts"), "utf8");
    const line = source.split(/\r?\n/).find((l) => /\bconst header = `URL: /.test(l)) ?? "";
    const fields = [...line.matchAll(/([A-Z][A-Za-z-]*): \$\{/g)].map((m) => m[1] ?? "");
    expect(fields).toContain("URL");
    const added = fields.filter((f) => !["URL", "Status", "Content-Type"].includes(f));
    const webFetch = bullets.filter((b) => b.includes("`WebFetch`")).join("\n");
    expect(added.filter((f) => !webFetch.includes(`\`${f}:\``))).toEqual([]);
  });

  test("the cf-worker edge: a block it says it does not run, besides provability:, is named with what --strict does", () => {
    // Every block the rule knows, found by handing it an IR that carries
    // them all. `provability:` is the release's own block; any other is one
    // a spec without it may carry, which 0.7.x compiled without a word.
    const everyBlock = new Proxy({}, { get: () => ({}) }) as Parameters<
      typeof cfWorkerUnwiredBlockWarnings
    >[0];
    const paths = cfWorkerUnwiredBlockWarnings(everyBlock).map((w) => w.path);
    expect(paths).toContain("provability");
    const edge = bullets.filter((b) => b.includes("--emit-as cf-worker") && b.includes("--strict"));
    const unnamed = paths
      .filter((p) => p !== "provability")
      .filter((p) => !edge.some((b) => b.includes(`\`${p}:\``)));
    expect(unnamed).toEqual([]);
  });

  test("FactCrossCheck: every kind of spelling whose verdict moved since 0.7.x is named", async () => {
    // FactCrossCheck compares through claim-ledger's fold, the gate's (§4.1),
    // in every harness that grants it, `provability:` or not. A kind whose
    // verdict is no longer 0.7.x's is a change the notes name; a fold
    // reverted, or scoped to the gate, moves none. The plain pair first, so
    // a run that read no source fails rather than finding nothing.
    const verdicts = await crossCheck([
      { claim: REFUND, source: "Our policy: the refund window is 30 days from delivery." },
      ...SPELLINGS,
    ]);
    expect(verdicts[0]).toBe("supported");
    const moved = SPELLINGS.filter((pair, i) => verdicts[i + 1] !== pair.was).map((p) => p.kind);
    const crossCheckNotes = bullets.filter((b) => b.includes("`FactCrossCheck`")).join("\n");
    const unnamed = [...new Set(moved)].filter((kind) => !crossCheckNotes.includes(kind));
    expect(unnamed).toEqual([]);
  });
});
