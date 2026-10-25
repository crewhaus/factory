/**
 * What the run did to a source before it read it, through the LIVE loop
 * (wireEvaluation + runChatLoop + the real verifier; design §0 A and B,
 * §1, §2, §10). provability's unit tests pin each rule; these pin that the
 * gate a harness actually runs applies it:
 *
 * - an MCP call's origin is a field its schema declares — the schema the
 *   gate's own catalog holds (the interpreter and the eval runner register
 *   their MCP tools there, not in `defaultCatalog`), and where none is
 *   known, an input carrying anything else a call could have been pointed
 *   at names nothing: a stray `url` grounds no page nobody fetched;
 * - a copy of the run's own session log is no source;
 * - an `Edit` of a figure is the run's own text, an unrelated line it
 *   appended is not;
 * - FactCrossCheck over a file the run wrote reaches a marked `grounded`
 *   at most;
 * - the vacuous-pass backstop reads a claim merged into a question, and
 *   leaves an honest numbered how-to vacuous;
 * - on a stream surface, a narration opener does not hide what a sentence
 *   printed before a tool call states.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXIT_CODES, RunFailedError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { config, tempDirs } from "./__fixtures__/helpers";
import { type Block, URL_A, runTurn, scriptedModel, webFetch } from "./__fixtures__/loop";
import { wireEvaluation } from "./wire";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

const SESSION = "sess_00000000000000e1";
const LOG = `.crewhaus/sessions/${SESSION}.jsonl`;
const THIRTY = "The refund window is 30 days from the date of purchase.";
const FOURTEEN = "The refund window is 14 days from the date of purchase.";
const cite = (claim: string, source: string): string =>
  `${claim.replace(/\.$/, "")} [1].\n\n[1]: ${source}`;

/** tool-fs's and tool-fsx's file tools, by name, input and flags, rooted at `root`. */
function fileTools(root: string): Record<string, RegisteredTool> {
  const at = (path: string): string => join(root, path);
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(at(path)), { recursive: true });
    writeFileSync(at(path), text);
  };
  return {
    write: buildTool({
      name: "Write",
      description: "write a file",
      inputSchema: z.object({ path: z.string(), content: z.string() }).strict(),
      destructive: true,
      execute: async (input) => {
        put(input.path, input.content);
        return `wrote ${input.path}`;
      },
    }),
    edit: buildTool({
      name: "Edit",
      description: "edit a file",
      inputSchema: z.object({ path: z.string(), oldString: z.string(), newString: z.string() }),
      destructive: true,
      execute: async (input) => {
        put(
          input.path,
          readFileSync(at(input.path), "utf8").replace(input.oldString, input.newString),
        );
        return `edited ${input.path}`;
      },
    }),
    read: buildTool({
      name: "Read",
      description: "read a file",
      inputSchema: z.object({ path: z.string() }).strict(),
      readOnly: true,
      concurrencySafe: true,
      execute: async (input) => readFileSync(at(input.path), "utf8"),
    }),
    copyPath: buildTool({
      name: "CopyPath",
      description: "copy a file or a directory",
      inputSchema: z.object({ source: z.string(), destination: z.string() }).strict(),
      execute: async (input) => {
        const files = input.source.endsWith(".jsonl")
          ? [[input.source, input.destination]]
          : readdirSync(at(input.source)).map((name) => [
              `${input.source}/${name}`,
              `${input.destination}/${name}`,
            ]);
        for (const [from, to] of files) {
          mkdirSync(dirname(at(to as string)), { recursive: true });
          copyFileSync(at(from as string), at(to as string));
        }
        return `copied ${input.source} to ${input.destination}`;
      },
    }),
    concatFiles: buildTool({
      name: "ConcatFiles",
      description: "concatenate files",
      inputSchema: z.object({ paths: z.array(z.string()), destination: z.string() }).strict(),
      execute: async (input) => {
        put(input.destination, input.paths.map((p) => readFileSync(at(p), "utf8")).join("\n"));
        return `wrote ${input.destination}`;
      },
    }),
    // FactCrossCheck's report shape: the claim found in each named file.
    factCrossCheck: buildTool({
      name: "FactCrossCheck",
      description: "check claims against files",
      inputSchema: z.object({
        claims: z.array(z.object({ text: z.string(), sources: z.array(z.string()) })),
      }),
      readOnly: true,
      execute: async (input) => {
        const claims = input.claims.map((claim, index) => {
          const sources = claim.sources.map((source) => {
            const text = readFileSync(at(source), "utf8");
            const line = text.split("\n").findIndex((l) => l.includes(claim.text)) + 1;
            return { source, line, excerpt: claim.text, status: "supported", coverage: 1 };
          });
          const [foundIn] = sources;
          return { index, claim: claim.text, verdict: "supported", foundIn, sources };
        });
        return JSON.stringify({ from: "claims", ok: true, checked: claims.length, claims });
      },
    }),
  };
}

/** An MCP server's tool, its declared JSON schema carried as tool-mcp registers it. */
function mcpTool(
  name: string,
  properties: Record<string, unknown>,
  execute: (input: Record<string, unknown>) => string,
): RegisteredTool {
  return buildTool({
    name,
    description: name,
    inputSchema: z.record(z.unknown()),
    jsonSchema: { type: "object", properties },
    readOnly: true,
    concurrencySafe: true,
    execute: async (input) => execute(input as Record<string, unknown>),
  });
}

type Outcome = {
  readonly halted?: RunFailedError;
  readonly verdicts: ReadonlyArray<string>;
  readonly footer: string;
};

async function live(opts: {
  readonly level: "cited" | "grounded" | "checked";
  readonly onFail: "halt" | "retry";
  readonly script: ReadonlyArray<ReadonlyArray<Block>>;
  readonly tools: (cwd: string) => ReadonlyArray<RegisteredTool>;
  /** Tools the gate's own catalog holds beside them (default: the run's tools). */
  readonly catalog?: (
    cwd: string,
    tools: ReadonlyArray<RegisteredTool>,
  ) => ReadonlyArray<RegisteredTool>;
  readonly files?: Readonly<Record<string, string>>;
  readonly footerTarget?: "reply" | "stream";
  readonly seed?: string;
}): Promise<Outcome> {
  const cwd = dirs.make();
  for (const [path, text] of Object.entries(opts.files ?? {})) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  const sessionRootDir = join(cwd, ".crewhaus", "sessions");
  const tools = opts.tools(cwd);
  const gates = await wireEvaluation(
    {
      specName: "support-bot",
      primaryModel: "test-model",
      provability: config(opts.level, {
        onFail: opts.onFail,
        execution: { allow: ["factCrossCheck"], replay: false },
      }),
    },
    {
      cwd,
      sessionRootDir,
      footerTarget: opts.footerTarget ?? "reply",
      catalog: opts.catalog !== undefined ? opts.catalog(cwd, tools) : tools,
    },
  );
  const verdicts: string[] = [];
  const out: string[] = [];
  try {
    const run = await runTurn({
      model: scriptedModel(opts.script),
      tools,
      gates,
      sessionRootDir,
      cwd,
      sessionId: SESSION,
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      onEvent: (event) => {
        if (event.kind === "provability_graded")
          verdicts.push((event as { verdict: string }).verdict);
      },
      onStdout: (chunk) => out.push(chunk),
    });
    const footer = String(run.result)
      .split("\n")
      .findLast((l) => l.startsWith("── provability"));
    return {
      verdicts,
      footer:
        footer ??
        out
          .join("")
          .split("\n")
          .findLast((l) => l.startsWith("── provability")) ??
        "",
    };
  } catch (err) {
    if (!(err instanceof RunFailedError)) throw err;
    return { halted: err, verdicts, footer: "" };
  }
}

const halted = (outcome: Outcome): string | undefined => outcome.halted?.message;

describe("an MCP call's origin is a field its schema declares (I1)", () => {
  // The official filesystem server's read_multiple_files, and a shell
  // server: neither declares `url`, and neither is in `defaultCatalog`.
  const readMany = (cwd: string): RegisteredTool =>
    mcpTool("mcp__filesystem__read_multiple_files", { paths: { type: "array" } }, (input) =>
      (input["paths"] as string[]).map((p) => readFileSync(join(cwd, p), "utf8")).join("\n---\n"),
    );
  const shell = (cwd: string): RegisteredTool =>
    mcpTool("mcp__shell__run_command", { command: { type: "string" } }, (input) =>
      readFileSync(join(cwd, String(input["command"]).replace(/^cat /, "")), "utf8"),
    );
  const wrote: Block = {
    type: "tool_use",
    id: "toolu_w1",
    name: "Write",
    input: { path: "notes.md", content: THIRTY },
  };

  for (const [label, read, tool] of [
    [
      "read_multiple_files {paths, url}",
      { name: "mcp__filesystem__read_multiple_files", input: { paths: ["notes.md"], url: URL_A } },
      readMany,
    ],
    [
      "run_command {command, url}",
      { name: "mcp__shell__run_command", input: { command: "cat notes.md", url: URL_A } },
      shell,
    ],
  ] as const) {
    for (const where of ["the gate's catalog", "no catalog"] as const) {
      test(`Write, then ${label} with a stray url, schema in ${where}: not fetched`, async () => {
        const outcome = await live({
          level: "grounded",
          onFail: "halt",
          tools: (cwd) => [webFetch, fileTools(cwd)["write"] as RegisteredTool, tool(cwd)],
          ...(where === "no catalog" ? { catalog: () => [webFetch] } : {}),
          script: [
            [wrote],
            [{ type: "tool_use", id: "toolu_r1", ...read }],
            [{ type: "text", text: cite(THIRTY, URL_A) }],
          ],
        });
        expect([label, where, outcome.halted?.report.exitCode]).toEqual([
          label,
          where,
          EXIT_CODES.provability,
        ]);
        expect(halted(outcome)).toContain("not_fetched");
      });
    }
  }

  test("a url the only address in the input, on a tool whose schema in the gate's catalog does not declare it: not fetched", async () => {
    // A notes server's `latest {limit}` handed a stray `url`: without the
    // schema, the url is the one address the input carries.
    const latest = (cwd: string): RegisteredTool =>
      mcpTool("mcp__notes__latest", { limit: { type: "number" } }, () =>
        readFileSync(join(cwd, "notes.md"), "utf8"),
      );
    const outcome = await live({
      level: "grounded",
      onFail: "halt",
      tools: (cwd) => [webFetch, fileTools(cwd)["write"] as RegisteredTool, latest(cwd)],
      script: [
        [wrote],
        [
          {
            type: "tool_use",
            id: "toolu_r1",
            name: "mcp__notes__latest",
            input: { limit: 1, url: URL_A },
          },
        ],
        [{ type: "text", text: cite(THIRTY, URL_A) }],
      ],
    });
    expect(outcome.halted?.report.exitCode).toBe(EXIT_CODES.provability);
    expect(halted(outcome)).toContain("not_fetched");
  });

  test("the run's own log read under a stray url grounds nothing, on the retry either", async () => {
    const outcome = await live({
      level: "grounded",
      onFail: "retry",
      tools: (cwd) => [webFetch, readMany(cwd)],
      catalog: () => [webFetch],
      script: [
        [{ type: "text", text: cite(THIRTY, URL_A) }],
        [
          {
            type: "tool_use",
            id: "toolu_m1",
            name: "mcp__filesystem__read_multiple_files",
            input: { paths: [LOG], url: URL_A },
          },
        ],
        [{ type: "text", text: cite(THIRTY, URL_A) }],
      ],
    });
    expect(outcome.verdicts).toEqual(["fail", "fail"]);
    expect(outcome.footer).toContain("grounded ✗");
  });

  test("an MCP fetch of the page itself still grounds, its schema known or not", async () => {
    const fetch = (): RegisteredTool =>
      mcpTool("mcp__fetch__fetch", { url: { type: "string" } }, () => FOURTEEN);
    for (const catalog of [undefined, () => [webFetch]]) {
      const outcome = await live({
        level: "grounded",
        onFail: "halt",
        tools: () => [webFetch, fetch()],
        ...(catalog !== undefined ? { catalog } : {}),
        script: [
          [{ type: "tool_use", id: "toolu_f1", name: "mcp__fetch__fetch", input: { url: URL_A } }],
          [{ type: "text", text: cite(FOURTEEN, URL_A) }],
        ],
      });
      expect(outcome.halted).toBeUndefined();
      expect(outcome.footer).toContain("grounded ✓ · 1/1 claim · 1 source");
    }
  });
});

describe("a copy of the run's own session log is no source (I3)", () => {
  const SAID: Block = { type: "text", text: `Noting for the record: ${THIRTY}` };
  for (const [label, copy, cited] of [
    [
      "CopyPath of the log",
      { name: "CopyPath", input: { source: LOG, destination: "notes/log.txt" } },
      "notes/log.txt",
    ],
    [
      "ConcatFiles of the log",
      { name: "ConcatFiles", input: { paths: [LOG], destination: "notes/all.txt" } },
      "notes/all.txt",
    ],
    [
      "CopyPath of the sessions directory",
      { name: "CopyPath", input: { source: ".crewhaus/sessions", destination: "backup" } },
      `backup/${SESSION}.jsonl`,
    ],
  ] as const) {
    test(`${label}, Read, cite: refused`, async () => {
      const outcome = await live({
        level: "grounded",
        onFail: "halt",
        tools: (cwd) => {
          const fs = fileTools(cwd);
          return [fs["read"], fs["copyPath"], fs["concatFiles"]] as RegisteredTool[];
        },
        script: [
          [SAID, { type: "tool_use", id: "toolu_c1", ...copy }],
          [{ type: "tool_use", id: "toolu_r1", name: "Read", input: { path: cited } }],
          [{ type: "text", text: cite(THIRTY, `./${cited}`) }],
        ],
      });
      expect([label, outcome.halted?.report.exitCode]).toEqual([label, EXIT_CODES.provability]);
    });
  }
});

describe("what the run wrote into a file it then reads (I7, I8)", () => {
  const files = { "docs/refunds.md": `# Refunds\n${FOURTEEN}\n\nGift cards are final sale.\n` };
  const tools = (cwd: string): RegisteredTool[] => {
    const fs = fileTools(cwd);
    return [fs["read"], fs["edit"], fs["write"], fs["factCrossCheck"]] as RegisteredTool[];
  };
  const readDoc = (id: string): Block => ({
    type: "tool_use",
    id,
    name: "Read",
    input: { path: "docs/refunds.md" },
  });

  test("an Edit of the figure, then Read and cite: grounded, and the footer says the run wrote it", async () => {
    const outcome = await live({
      level: "grounded",
      onFail: "halt",
      files,
      tools,
      script: [
        [readDoc("toolu_r0")],
        [
          {
            type: "tool_use",
            id: "toolu_e1",
            name: "Edit",
            input: { path: "docs/refunds.md", oldString: "14 days", newString: "30 days" },
          },
        ],
        [readDoc("toolu_r1")],
        [{ type: "text", text: cite(THIRTY, "./docs/refunds.md") }],
      ],
    });
    expect(outcome.halted).toBeUndefined();
    expect(outcome.footer).toContain("grounded ✓ · 1/1 claim · 1 source (1 written by this run)");
  });

  test("Write, FactCrossCheck the file, cite the check: halted at checked, marked at grounded", async () => {
    const script = [
      [
        {
          type: "tool_use",
          id: "toolu_w1",
          name: "Write",
          input: { path: "notes.md", content: THIRTY },
        },
      ],
      [
        {
          type: "tool_use",
          id: "toolu_fcc",
          name: "FactCrossCheck",
          input: { claims: [{ text: THIRTY, sources: ["notes.md"] }] },
        },
      ],
      [{ type: "text", text: cite(THIRTY, "tool:toolu_fcc") }],
    ] as const;
    const checked = await live({ level: "checked", onFail: "halt", tools, script });
    expect(checked.halted?.report.exitCode).toBe(EXIT_CODES.provability);
    expect(halted(checked)).toContain("below_floor");
    const grounded = await live({ level: "grounded", onFail: "halt", tools, script });
    expect(grounded.halted).toBeUndefined();
    expect(grounded.footer).toContain("(1 written by this run)");
  });

  test("an unrelated line appended beside the claim leaves FactCrossCheck a check", async () => {
    const outcome = await live({
      level: "checked",
      onFail: "halt",
      files,
      tools,
      script: [
        [readDoc("toolu_r0")],
        [
          {
            type: "tool_use",
            id: "toolu_e1",
            name: "Edit",
            input: {
              path: "docs/refunds.md",
              oldString: "Gift cards are final sale.",
              newString: "Gift cards are final sale.\n\nFor any refund question, email support.",
            },
          },
        ],
        [
          {
            type: "tool_use",
            id: "toolu_fcc",
            name: "FactCrossCheck",
            input: { claims: [{ text: FOURTEEN, sources: ["docs/refunds.md"] }] },
          },
        ],
        [{ type: "text", text: cite(FOURTEEN, "tool:toolu_fcc") }],
      ],
    });
    expect(outcome.halted).toBeUndefined();
    expect(outcome.footer).toContain("checked ✓ · 1/1 claim");
  });
});

describe("the vacuous-pass backstop in the live loop (B1)", () => {
  test("a figure merged into a question is read and checked: halted", async () => {
    for (const [level, answer, fetches] of [
      ["checked", "1,284.60; want the PDF?", false],
      ["grounded", `The refund window is 30 days [1]　Anything else?\n\n[1]: ${URL_A}`, true],
    ] as const) {
      const outcome = await live({
        level,
        onFail: "halt",
        tools: () => [webFetch],
        script: [
          ...(fetches
            ? [
                [
                  { type: "tool_use", id: "toolu_f1", name: "WebFetch", input: { url: URL_A } },
                ] as Block[],
              ]
            : []),
          [{ type: "text", text: answer }],
        ],
      });
      expect([answer, outcome.halted?.report.exitCode]).toEqual([answer, EXIT_CODES.provability]);
    }
  });

  test("an honest numbered how-to has nothing to prove: served, not halted", async () => {
    for (const answer of [
      "To reset your password:\n\n1. Open Settings\n2. Tap Security\n3. Choose Reset",
      "Which do you mean?\n\n1. Basic\n2. Pro",
    ]) {
      const outcome = await live({
        level: "grounded",
        onFail: "halt",
        tools: () => [webFetch],
        script: [[{ type: "text", text: answer }]],
      });
      expect([answer, outcome.halted]).toEqual([answer, undefined]);
      expect(outcome.footer).toContain("no claims to prove");
    }
  });
});

describe("on a stream surface, a narration opener does not hide a statement (I10)", () => {
  const saveNote = buildTool({
    name: "SaveNote",
    description: "save a note",
    inputSchema: z.object({ text: z.string() }).strict(),
    execute: async () => "saved",
  });
  const fetchCall: Block = {
    type: "tool_use",
    id: "toolu_f1",
    name: "WebFetch",
    input: { url: URL_A },
  };
  for (const [said, call, seed] of [
    ["I can confirm your refund has been processed.", fetchCall, undefined],
    ["Hold on, refunds are not allowed on sale items.", fetchCall, undefined],
    ["One moment — the warranty does not cover water damage.", fetchCall, undefined],
    ["Of course, I'll note that refunds are not allowed on sale items.", fetchCall, undefined],
    ["Looking at your account, your refund went through yesterday.", fetchCall, undefined],
    ["Pulling up your order — it shipped Tuesday via UPS.", fetchCall, undefined],
    ["Thanks — I can see your subscription renews automatically every year.", fetchCall, undefined],
    // A figure inside the call's free text is the agent's own writing.
    [
      "I'll save a note that the refund window is 30 days.",
      {
        type: "tool_use",
        id: "toolu_n1",
        name: "SaveNote",
        input: { text: "Refund window: 30 days" },
      },
      undefined,
    ],
    // One the reader handed, or one naming a thing, exempts no statement.
    [
      "Let me confirm — yes, the refund window is 30 days.",
      fetchCall,
      "is the refund window 30 days? note it down",
    ],
    ["Let me check: order #4512 was refunded in the 2025 audit.", fetchCall, undefined],
  ] as const) {
    test(`"${said}", then "Done.": graded, exit 37`, async () => {
      const outcome = await live({
        level: "cited",
        onFail: "halt",
        footerTarget: "stream",
        tools: () => [webFetch, saveNote],
        ...(seed !== undefined ? { seed } : {}),
        script: [[{ type: "text", text: said }, call], [{ type: "text", text: "Done." }]],
      });
      expect([said, outcome.halted?.report.exitCode]).toEqual([said, EXIT_CODES.provability]);
    });
  }

  test("honest narration before the call still passes", async () => {
    for (const said of [
      "Let me fetch the refund policy page first.",
      "One moment while I look that up.",
      "Hold on, let me check the policy page.",
    ]) {
      const outcome = await live({
        level: "cited",
        onFail: "halt",
        footerTarget: "stream",
        tools: () => [webFetch],
        script: [
          [
            { type: "text", text: said },
            { type: "tool_use", id: "toolu_f1", name: "WebFetch", input: { url: URL_A } },
          ],
          [{ type: "text", text: "Done." }],
        ],
      });
      expect([said, outcome.halted]).toEqual([said, undefined]);
    }
  });
});
