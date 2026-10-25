/**
 * What the run did to a source before it read it (design §10, §1, §0 A):
 *
 * - a source the run wrote itself is marked (`writtenBy`, `selfWritten`),
 *   decided per origin — an `Edit` of one figure is the run's text, as a
 *   `Write` of the whole sentence is — and for an MCP read of a URL or path
 *   another tool wrote, as for a builtin reader;
 * - a copy of the harness's own state (a session log copied, concatenated
 *   or unpacked into the workspace) is no source, cited or checked;
 * - an MCP tool's origin is a field it declares: a stray `url` beside a file
 *   server's `path` grounds nothing;
 * - FactCrossCheck over a file the run wrote checks nothing: it reaches a
 *   marked `grounded` at most, as the file itself, cited, does.
 *
 * Every index is built by the real builders (`recordFromCall`), so the
 * origins are read the way the gate reads them.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InputSchemaLookup, buildEvidenceIndex, recordFromCall } from "./evidence";
import { renderFooter } from "./render";
import { type CallSpec, config, fetched, now } from "./test-helpers";
import type { EvidenceIndex, ProofBinding, ProofBundle, VerifyOptions } from "./types";
import { verifyDocument } from "./verify";

const workspace = mkdtempSync(join(tmpdir(), "prov-provenance-"));
const SESSION = "sess_00000000000000d1";
const LOG = `.crewhaus/sessions/${SESSION}.jsonl`;
const FOURTEEN =
  "# Refunds\nThe refund window is 14 days from the date of purchase. Refunds go to the original card.\n";
const THIRTY = FOURTEEN.replace("14 days", "30 days");
const SAID = "The refund window is 30 days from the date of purchase.";
const LOG_TEXT = `${JSON.stringify({ kind: "assistant_message", payload: { text: SAID } })}\n`;
for (const [file, text] of [
  ["docs/refunds.md", THIRTY],
  ["docs/gift.md", "Gift cards are refundable.\n"],
  ["notes/policy.md", `${SAID}\n`],
  ["notes/log.txt", LOG_TEXT],
  ["notes/all.txt", LOG_TEXT],
  [`backup/${SESSION}.jsonl`, LOG_TEXT],
  [LOG, LOG_TEXT],
] as const) {
  mkdirSync(join(workspace, file, ".."), { recursive: true });
  writeFileSync(join(workspace, file), text);
}
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

const URL_A = "https://acme.example/policy";
const ANSWER = "The refund window is 30 days from the date of purchase [1].";
const cite = (source: string, answer = ANSWER): string => `${answer}\n\n[1]: ${source}`;

/** The schemas the MCP servers in these tests advertise. */
const SCHEMAS: Record<string, unknown> = {
  mcp__filesystem__read_file: { type: "object", properties: { path: { type: "string" } } },
  mcp__fetch__fetch: { type: "object", properties: { url: { type: "string" } } },
};
const schemas: InputSchemaLookup = (name) => SCHEMAS[name];

function evidence(calls: ReadonlyArray<CallSpec>, inputSchemaOf = schemas): EvidenceIndex {
  return buildEvidenceIndex(
    calls.map((c) =>
      recordFromCall(
        {
          toolUseId: c.id,
          toolName: c.name,
          input: c.input ?? {},
          content: c.content,
          isError: c.isError ?? false,
        },
        { workspaceRoot: workspace, inputSchemaOf },
      ),
    ),
  );
}

async function verify(
  text: string,
  calls: ReadonlyArray<CallSpec>,
  opts: Partial<VerifyOptions> & { readonly inputSchemaOf?: InputSchemaLookup } = {},
): Promise<ProofBundle> {
  const { inputSchemaOf, ...rest } = opts;
  return verifyDocument(text, {
    config: config("grounded"),
    evidence: evidence(calls, inputSchemaOf),
    workspaceRoot: workspace,
    now,
    ...rest,
  });
}

const binding = (bundle: ProofBundle): ProofBinding | undefined => bundle.claims[0]?.bindings[0];
const read = (id: string, path: string, content: string): CallSpec => ({
  id,
  name: "Read",
  input: { path },
  content,
});
const edit = (id: string, path: string, oldString: string, newString: string): CallSpec => ({
  id,
  name: "Edit",
  input: { path, oldString, newString },
  content: `edited ${path}`,
});

describe("a source the run changed is the run's own, decided per origin (design §10)", () => {
  test("Read, an Edit of part of the sentence, Read: marked, and the footer says so", async () => {
    const bundle = await verify(cite("./docs/refunds.md"), [
      read("toolu_r0", "docs/refunds.md", FOURTEEN),
      edit("toolu_e", "docs/refunds.md", "refund window is 14 days", "refund window is 30 days"),
      read("toolu_r1", "docs/refunds.md", THIRTY),
    ]);
    expect(bundle.verdict).toBe("pass");
    expect(binding(bundle)).toMatchObject({
      ok: true,
      rung: "grounded",
      writtenBy: { toolUseId: "toolu_e", toolName: "Edit" },
    });
    expect(bundle.selfWritten).toBe(1);
    expect(renderFooter(bundle)).toContain("1 source (1 written by this run)");
  });

  test("an Edit of the figure alone, of '14 days', or of the whole sentence beside the next one", async () => {
    for (const [oldString, newString] of [
      ["14", "30"],
      ["14 days", "30 days"],
      [
        "The refund window is 14 days from the date of purchase.",
        "The refund window is 30 days from the date of purchase.",
      ],
    ] as const) {
      const bundle = await verify(cite("./docs/refunds.md"), [
        edit("toolu_e", "docs/refunds.md", oldString, newString),
        read("toolu_r", "docs/refunds.md", THIRTY),
      ]);
      expect([oldString, binding(bundle)?.writtenBy]).toEqual([
        oldString,
        { toolUseId: "toolu_e", toolName: "Edit" },
      ]);
    }
  });

  test("a placeholder filled in, a sentence finished by an append, a patch applied, a word taken out", async () => {
    const placeholder = await verify(cite("./notes/policy.md"), [
      {
        id: "toolu_w",
        name: "Write",
        input: { path: "notes/policy.md", content: SAID.replace("30", "TBD") },
        content: "wrote notes/policy.md",
      },
      edit("toolu_e", "notes/policy.md", "TBD", "30"),
      read("toolu_r", "notes/policy.md", `${SAID}\n`),
    ]);
    expect(binding(placeholder)?.writtenBy?.toolUseId).toBe("toolu_w");
    const appended = await verify(cite("./notes/policy.md"), [
      {
        id: "toolu_w",
        name: "Write",
        input: { path: "notes/policy.md", content: "The refund window is 30" },
        content: "wrote notes/policy.md",
      },
      {
        id: "toolu_a",
        name: "AppendFile",
        input: { path: "notes/policy.md", content: " days from the date of purchase." },
        content: "appended",
      },
      read("toolu_r", "notes/policy.md", `${SAID}\n`),
    ]);
    expect(appended.selfWritten).toBe(1);
    const patched = await verify(cite("./docs/refunds.md"), [
      {
        id: "toolu_p",
        name: "GitApplyPatch",
        input: {
          cwd: ".",
          patch: [
            "--- a/docs/refunds.md",
            "+++ b/docs/refunds.md",
            "@@ -1,2 +1,2 @@",
            " # Refunds",
            "-The refund window is 14 days from the date of purchase. Refunds go to the original card.",
            "+The refund window is 30 days from the date of purchase. Refunds go to the original card.",
            "",
          ].join("\n"),
        },
        content: "applied",
      },
      read("toolu_r", "docs/refunds.md", THIRTY),
    ]);
    expect(binding(patched)?.writtenBy).toEqual({
      toolUseId: "toolu_p",
      toolName: "GitApplyPatch",
    });
    const unsaid = await verify(cite("./docs/gift.md", "Gift cards are refundable [1]."), [
      edit("toolu_e", "docs/gift.md", "are not refundable", "are refundable"),
      read("toolu_r", "docs/gift.md", "Gift cards are refundable.\n"),
    ]);
    expect(binding(unsaid)?.writtenBy?.toolUseId).toBe("toolu_e");
  });

  test("an edit elsewhere in the file, or a read before the edit that grounds it: not marked", async () => {
    const answer = "Refunds go to the original card [1].";
    const elsewhere = await verify(cite("./docs/refunds.md", answer), [
      edit("toolu_e", "docs/refunds.md", "14 days", "30 days"),
      read("toolu_r", "docs/refunds.md", THIRTY),
    ]);
    expect(binding(elsewhere)).toMatchObject({ ok: true });
    expect(binding(elsewhere)?.writtenBy).toBeUndefined();
    const before = await verify(cite("./docs/refunds.md"), [
      read("toolu_r0", "docs/refunds.md", THIRTY),
      edit("toolu_e", "docs/refunds.md", "original card", "card used"),
      read("toolu_r1", "docs/refunds.md", THIRTY.replace("original card", "card used")),
    ]);
    expect(binding(before)).toMatchObject({ ok: true });
    expect(binding(before)?.writtenBy).toBeUndefined();
  });
});

describe("a line the run added beside a sentence it did not touch leaves that sentence the source's", () => {
  // Located, not counted: the appended line shares "refund" with the claim,
  // and lands nowhere near it.
  const appended = edit(
    "toolu_e",
    "docs/refunds.md",
    "Refunds go to the original card.",
    "Refunds go to the original card.\n\nFor any refund question, email support.",
  );
  const after = `${THIRTY}\nFor any refund question, email support.\n`;

  test("on the path route: grounded, unmarked", async () => {
    for (const calls of [
      [appended, read("toolu_r1", "docs/refunds.md", after)],
      [
        read("toolu_r0", "docs/refunds.md", THIRTY),
        appended,
        read("toolu_r1", "docs/refunds.md", after),
      ],
    ]) {
      const bundle = await verify(cite("./docs/refunds.md"), calls);
      expect(bundle.verdict).toBe("pass");
      expect(binding(bundle)?.writtenBy).toBeUndefined();
      expect(bundle.selfWritten ?? 0).toBe(0);
    }
  });

  test("the one-figure, context and placeholder edits stay marked beside it", async () => {
    const bundle = await verify(cite("./docs/refunds.md"), [
      edit("toolu_e1", "docs/refunds.md", "14", "30"),
      appended,
      read("toolu_r1", "docs/refunds.md", after),
    ]);
    expect(binding(bundle)?.writtenBy).toEqual({ toolUseId: "toolu_e1", toolName: "Edit" });
  });
});

describe("an MCP read of a URL or path another tool wrote is marked like a builtin read (design §10)", () => {
  test("a PUT to the URL, then mcp__fetch__fetch of it", async () => {
    const bundle = await verify(cite(URL_A), [
      {
        id: "toolu_put",
        name: "HttpRequest",
        input: { url: URL_A, method: "PUT", body: SAID },
        content: "HTTP 201",
      },
      { id: "toolu_f", name: "mcp__fetch__fetch", input: { url: URL_A }, content: SAID },
    ]);
    expect(binding(bundle)).toMatchObject({
      ok: true,
      writtenBy: { toolUseId: "toolu_put", toolName: "HttpRequest" },
    });
    expect(bundle.selfWritten).toBe(1);
  });

  test("a builtin Write, then a file server's read_file of it", async () => {
    const bundle = await verify(cite("./notes/policy.md"), [
      {
        id: "toolu_w",
        name: "Write",
        input: { path: "notes/policy.md", content: SAID },
        content: "wrote notes/policy.md",
      },
      {
        id: "toolu_r",
        name: "mcp__filesystem__read_file",
        input: { path: "notes/policy.md" },
        content: `${SAID}\n`,
      },
    ]);
    expect(binding(bundle)?.writtenBy).toEqual({ toolUseId: "toolu_w", toolName: "Write" });
  });

  test("the draft preflighted, or a phrase searched for, before an honest MCP fetch: still the page's, unmarked", async () => {
    for (const first of [
      {
        id: "toolu_pf",
        name: "ProvabilityPreflight",
        input: { draft: cite(URL_A) },
        content: "{}",
      },
      {
        id: "toolu_s",
        name: "mcp__search__query",
        input: { query: "refund window is 30 days" },
        content: "[]",
      },
    ]) {
      const bundle = await verify(cite(URL_A), [
        first,
        { id: "toolu_f", name: "mcp__fetch__fetch", input: { url: URL_A }, content: THIRTY },
      ]);
      expect([first.name, binding(bundle)?.ok, binding(bundle)?.writtenBy]).toEqual([
        first.name,
        true,
        undefined,
      ]);
    }
  });
});

describe("an MCP tool's origin is a field it declares (design §0 A)", () => {
  const write: CallSpec = {
    id: "toolu_w",
    name: "Write",
    input: { path: "notes/policy.md", content: SAID },
    content: "wrote notes/policy.md",
  };
  const stray: CallSpec = {
    id: "toolu_r",
    name: "mcp__filesystem__read_file",
    input: { path: "notes/policy.md", url: URL_A },
    content: `${SAID}\n`,
  };

  test("a Write, then read_file with a stray url: the page was never fetched — schema known or not", async () => {
    for (const inputSchemaOf of [schemas, () => undefined]) {
      for (const onFail of ["halt", "retry"] as const) {
        const bundle = await verify(cite(URL_A), [write, stray], {
          config: config("grounded", { onFail }),
          inputSchemaOf,
        });
        expect(bundle.verdict).toBe("fail");
        expect(binding(bundle)?.reason).toBe("not_fetched");
      }
    }
  });

  test("read_file of the run's own session log under a stray url grounds nothing, whatever the schema declares", async () => {
    const own: CallSpec = { ...stray, input: { path: LOG, url: URL_A }, content: LOG_TEXT };
    const both: InputSchemaLookup = () => ({
      type: "object",
      properties: { path: { type: "string" }, url: { type: "string" } },
    });
    for (const inputSchemaOf of [schemas, () => undefined, both]) {
      const bundle = await verify(cite(URL_A), [own], { inputSchemaOf });
      expect(binding(bundle)?.reason).toBe("not_fetched");
    }
    const declared = await verify(cite(URL_A), [own], { inputSchemaOf: both });
    expect(binding(declared)?.detail).toContain("the harness's own state");
  });

  test("schema unknown: a `paths` list, a command line or an id beside a stray url names nothing", async () => {
    for (const [name, input] of [
      ["mcp__filesystem__read_multiple_files", { paths: ["notes/policy.md"], url: URL_A }],
      ["mcp__shell__run_command", { command: "cat notes/policy.md", url: URL_A }],
      ["mcp__notes__get_note", { id: "n1", url: URL_A }],
    ] as const) {
      const bundle = await verify(
        cite(URL_A),
        [write, { id: "toolu_r", name, input, content: `${SAID}\n` }],
        { inputSchemaOf: () => undefined },
      );
      expect([name, binding(bundle)?.reason]).toEqual([name, "not_fetched"]);
    }
  });

  test("the run's own log in a `paths` list is the log, whatever origin the read is indexed under", async () => {
    // A server that declares both: the url names the origin, and the list
    // names what was read — the session log, so nothing it returned is a source.
    const both: InputSchemaLookup = () => ({
      type: "object",
      properties: { paths: { type: "array" }, url: { type: "string" } },
    });
    const own: CallSpec = {
      id: "toolu_r",
      name: "mcp__filesystem__read_multiple_files",
      input: { paths: [LOG], url: URL_A },
      content: LOG_TEXT,
    };
    const bundle = await verify(cite(URL_A), [own], { inputSchemaOf: both });
    expect(binding(bundle)?.ok).toBe(false);
    expect(binding(bundle)?.detail).toContain("the harness's own state");
  });

  test("schema unknown: a fetcher's rendering options leave its url the page it read", async () => {
    const page = "The refund window is 30 days from the date of purchase.";
    for (const input of [
      { url: URL_A },
      { url: URL_A, formats: ["markdown"] },
      { url: URL_A, method: "GET" },
    ]) {
      const bundle = await verify(
        cite(URL_A),
        [{ id: "toolu_f", name: "mcp__firecrawl__scrape", input, content: page }],
        { inputSchemaOf: () => undefined },
      );
      expect([input, bundle.verdict]).toEqual([input, "pass"]);
    }
  });
});

describe("a copy of the harness's own state is no source (design §1)", () => {
  const copies: ReadonlyArray<readonly [string, CallSpec, string]> = [
    [
      "CopyPath of the log",
      {
        id: "toolu_cp",
        name: "CopyPath",
        input: { source: LOG, destination: "notes/log.txt" },
        content: "copied",
      },
      "notes/log.txt",
    ],
    [
      "ConcatFiles of the log",
      {
        id: "toolu_cat",
        name: "ConcatFiles",
        input: { paths: [LOG], destination: "notes/all.txt" },
        content: "concatenated",
      },
      "notes/all.txt",
    ],
    [
      "CopyPath of the sessions directory",
      {
        id: "toolu_cpd",
        name: "CopyPath",
        input: { source: ".crewhaus/sessions", destination: "backup" },
        content: "copied",
      },
      `backup/${SESSION}.jsonl`,
    ],
  ];

  test("copied, concatenated or copied whole, then Read and cited: not_fetched, the detail naming the copy", async () => {
    for (const [name, copy, path] of copies) {
      for (const level of ["cited", "grounded"] as const) {
        const bundle = await verify(cite(`./${path}`), [copy, read("toolu_r", path, LOG_TEXT)], {
          config: config(level),
        });
        if (level === "cited") {
          expect([name, bundle.verdict]).toEqual([name, "pass"]);
          continue;
        }
        expect([name, bundle.verdict, binding(bundle)?.reason]).toEqual([
          name,
          "fail",
          "not_fetched",
        ]);
        expect(binding(bundle)?.detail).toContain(`${copy.id} (${copy.name}) copied`);
        expect(binding(bundle)?.detail).toContain(".crewhaus/");
      }
    }
  });

  test("a copy INTO a state root leaves the original a source", async () => {
    const bundle = await verify(cite("./docs/refunds.md"), [
      {
        id: "toolu_cp",
        name: "CopyPath",
        input: { source: "docs/refunds.md", destination: ".crewhaus/backup/refunds.md" },
        content: "copied",
      },
      read("toolu_r", "docs/refunds.md", THIRTY),
    ]);
    expect(binding(bundle)).toMatchObject({ ok: true });
    expect(binding(bundle)?.writtenBy).toBeUndefined();
  });
});

describe("FactCrossCheck over the run's own text checks nothing (design §0 B, §10)", () => {
  const allow = { execution: { allow: ["factCrossCheck"], replay: false } };
  const fcc = (source: string, claim = SAID): CallSpec => {
    const found = { source, line: 1, excerpt: claim };
    return {
      id: "toolu_fcc",
      name: "FactCrossCheck",
      input: { claims: [{ text: claim, sources: [source] }] },
      content: JSON.stringify({
        from: "claims",
        ok: true,
        checked: 1,
        claims: [
          {
            index: 0,
            claim,
            verdict: "supported",
            foundIn: found,
            sources: [{ ...found, status: "supported", coverage: 1 }],
          },
        ],
      }),
    };
  };
  const write: CallSpec = {
    id: "toolu_w",
    name: "Write",
    input: { path: "notes/policy.md", content: `# Policy\n\n${SAID}` },
    content: "wrote notes/policy.md",
  };

  test("Write, FactCrossCheck the file, cite the check: a marked grounded at most", async () => {
    const checked = await verify(cite("tool:toolu_fcc"), [write, fcc("notes/policy.md")], {
      config: config("checked", allow),
    });
    expect(checked.verdict).toBe("fail");
    expect(binding(checked)).toMatchObject({
      ok: false,
      rung: "grounded",
      reason: "below_floor",
      writtenBy: { toolUseId: "toolu_w", toolName: "Write" },
    });
    expect(binding(checked)?.detail).toContain("wrote it before the check");
    const grounded = await verify(cite("tool:toolu_fcc"), [write, fcc("notes/policy.md")], {
      config: config("grounded", allow),
    });
    expect(grounded.verdict).toBe("pass");
    expect(binding(grounded)?.writtenBy).toEqual({ toolUseId: "toolu_w", toolName: "Write" });
    expect(grounded.selfWritten).toBe(1);
    expect(renderFooter(grounded)).toContain("(1 written by this run)");
  });

  test("an unrelated line the run appended to the file leaves the check a check", async () => {
    const appended = edit(
      "toolu_e",
      "docs/refunds.md",
      "Refunds go to the original card.",
      "Refunds go to the original card.\n\nFor any refund question, email support.",
    );
    for (const calls of [
      [appended, fcc("docs/refunds.md")],
      [read("toolu_r0", "docs/refunds.md", THIRTY), appended, fcc("docs/refunds.md")],
    ]) {
      const bundle = await verify(cite("tool:toolu_fcc"), calls, {
        config: config("checked", allow),
      });
      expect(bundle.verdict).toBe("pass");
      expect(binding(bundle)).toMatchObject({ ok: true, rung: "checked" });
      expect(binding(bundle)?.writtenBy).toBeUndefined();
    }
  });

  test("a read of the file before the run wrote it, holding the claim, leaves the check a check", async () => {
    // The Write puts the sentence there whole, which alone would mark it.
    const rewrite: CallSpec = {
      ...write,
      input: { path: "notes/policy.md", content: `${SAID}\n` },
    };
    const bundle = await verify(
      cite("tool:toolu_fcc"),
      [read("toolu_r0", "notes/policy.md", `${SAID}\n`), rewrite, fcc("notes/policy.md")],
      { config: config("checked", allow) },
    );
    expect(binding(bundle)).toMatchObject({ ok: true, rung: "checked" });
    expect(binding(bundle)?.writtenBy).toBeUndefined();
    // Without that read, the same Write is the run's own text.
    const own = await verify(cite("tool:toolu_fcc"), [rewrite, fcc("notes/policy.md")], {
      config: config("checked", allow),
    });
    expect(binding(own)).toMatchObject({ ok: false, rung: "grounded", reason: "below_floor" });
  });

  test("an Edit of the claim's figure before the check still caps it at a marked grounded", async () => {
    const bundle = await verify(
      cite("tool:toolu_fcc"),
      [edit("toolu_e", "docs/refunds.md", "14", "30"), fcc("docs/refunds.md")],
      { config: config("checked", allow) },
    );
    expect(binding(bundle)).toMatchObject({
      ok: false,
      rung: "grounded",
      writtenBy: { toolUseId: "toolu_e", toolName: "Edit" },
    });
  });

  test("a file the run did not write still checks it", async () => {
    const bundle = await verify(cite("tool:toolu_fcc"), [fcc("notes/policy.md")], {
      config: config("checked", allow),
    });
    expect(binding(bundle)).toMatchObject({ ok: true, rung: "checked" });
    expect(binding(bundle)?.writtenBy).toBeUndefined();
  });

  test("FactCrossCheck over a copy of the session log checks nothing", async () => {
    for (const level of ["checked", "grounded"] as const) {
      const bundle = await verify(
        cite("tool:toolu_fcc"),
        [
          {
            id: "toolu_cp",
            name: "CopyPath",
            input: { source: LOG, destination: "notes/log.txt" },
            content: "copied",
          },
          fcc("notes/log.txt"),
        ],
        { config: config(level, allow) },
      );
      expect([level, binding(bundle)?.ok, binding(bundle)?.reason]).toEqual([
        level,
        false,
        "value_absent",
      ]);
      expect(binding(bundle)?.detail).toContain("a copy of .crewhaus/sessions/");
    }
  });
});

describe("a WebFetch of a page the run did not write is untouched by all this", () => {
  test("grounds unmarked", async () => {
    const bundle = await verify(cite(URL_A), [
      { id: "toolu_f", name: "WebFetch", input: { url: URL_A }, content: fetched(URL_A, THIRTY) },
    ]);
    expect(binding(bundle)).toMatchObject({ ok: true, rung: "grounded" });
    expect(binding(bundle)?.writtenBy).toBeUndefined();
    expect(bundle.selfWritten).toBeUndefined();
  });
});
