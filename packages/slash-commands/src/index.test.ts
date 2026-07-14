import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SlashCommand,
  SlashCommandError,
  expand,
  loadCommands,
  parseCommandFile,
} from "./index";

// A shared empty home dir so tests never read the developer's real
// `~/.crewhaus/commands` now that loadCommands walks a user-level root.
const EMPTY_HOME = mkdtempSync(join(tmpdir(), "slash-home-"));

// Snapshot the genuine node:fs module before any mock so passthroughs hold the
// real implementations (Bun mutates the live namespace in place when mocking).
const REAL_FS = { ...(await import("node:fs")) };
const realReadFileSync = REAL_FS.readFileSync;
const restoreRealFs = () => {
  mock.module("node:fs", () => ({ ...REAL_FS }));
};

function withTempCwd(
  setup: (cwd: string) => void,
  body: (cwd: string) => Promise<void> | void,
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "slash-cwd-"));
  try {
    setup(cwd);
    return Promise.resolve(body(cwd)).finally(() => {
      rmSync(cwd, { recursive: true, force: true });
    });
  } catch (err) {
    rmSync(cwd, { recursive: true, force: true });
    throw err;
  }
}

function writeCommand(cwd: string, name: string, content: string): string {
  const dir = join(cwd, ".crewhaus", "commands");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.md`);
  writeFileSync(file, content);
  return file;
}

describe("loadCommands", () => {
  test("returns empty map when no directory", async () => {
    await withTempCwd(
      () => {},
      async (cwd) => {
        const cmds = await loadCommands({ cwd, homeDir: EMPTY_HOME });
        expect(cmds.size).toBe(0);
      },
    );
  });

  test("loads body-only files (no frontmatter)", async () => {
    await withTempCwd(
      (cwd) => {
        writeCommand(cwd, "explain", "Explain $ARGUMENTS in two sentences.");
      },
      async (cwd) => {
        const cmds = await loadCommands({ cwd, homeDir: EMPTY_HOME });
        expect(cmds.size).toBe(1);
        const cmd = cmds.get("explain");
        expect(cmd?.body).toBe("Explain $ARGUMENTS in two sentences.");
        expect(cmd?.description).toBeUndefined();
      },
    );
  });

  test("parses optional frontmatter (description, argument-hint)", async () => {
    await withTempCwd(
      (cwd) => {
        writeCommand(
          cwd,
          "review",
          `---\ndescription: code review on a PR\nargument-hint: "<pr-number>"\n---\nReview PR $ARGUMENTS.`,
        );
      },
      async (cwd) => {
        const cmds = await loadCommands({ cwd, homeDir: EMPTY_HOME });
        const cmd = cmds.get("review");
        expect(cmd?.description).toBe("code review on a PR");
        expect(cmd?.argumentHint).toBe("<pr-number>");
        expect(cmd?.body).toBe("Review PR $ARGUMENTS.");
      },
    );
  });

  test("supports camelCase alias `argumentHint`", async () => {
    await withTempCwd(
      (cwd) => {
        writeCommand(cwd, "alias", `---\nargumentHint: "<x>"\n---\nbody`);
      },
      async (cwd) => {
        const cmds = await loadCommands({ cwd, homeDir: EMPTY_HOME });
        expect(cmds.get("alias")?.argumentHint).toBe("<x>");
      },
    );
  });

  test("ignores non-md files and subdirectories", async () => {
    await withTempCwd(
      (cwd) => {
        mkdirSync(join(cwd, ".crewhaus", "commands", "subdir"), { recursive: true });
        writeFileSync(join(cwd, ".crewhaus", "commands", "notmd.txt"), "ignored");
        writeCommand(cwd, "real", "body");
      },
      async (cwd) => {
        const cmds = await loadCommands({ cwd, homeDir: EMPTY_HOME });
        expect([...cmds.keys()]).toEqual(["real"]);
      },
    );
  });

  test("treats unterminated frontmatter as plain body (defensive)", async () => {
    await withTempCwd(
      (cwd) => {
        writeCommand(cwd, "rule", "---\nthis is not really frontmatter\nstill the body");
      },
      async (cwd) => {
        const cmds = await loadCommands({ cwd, homeDir: EMPTY_HOME });
        const cmd = cmds.get("rule");
        expect(cmd?.body.startsWith("---\n")).toBe(true);
      },
    );
  });
});

describe("loadCommands — builtin + user + project roots (PR 12)", () => {
  function writeUserCommand(home: string, name: string, content: string): string {
    const dir = join(home, ".crewhaus", "commands");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.md`);
    writeFileSync(file, content);
    return file;
  }

  function writeBuiltinCommand(dir: string, name: string, content: string): string {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.md`);
    writeFileSync(file, content);
    return file;
  }

  test("user-level ~/.crewhaus/commands is loaded", async () => {
    await withTempCwd(
      () => {},
      async (cwd) => {
        const home = mkdtempSync(join(tmpdir(), "slash-home-"));
        try {
          writeUserCommand(home, "mine", "user body");
          const cmds = await loadCommands({ cwd, homeDir: home });
          expect(cmds.get("mine")?.body).toBe("user body");
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      },
    );
  });

  test("builtin dirs are read as flat command directories (no .crewhaus suffix)", async () => {
    await withTempCwd(
      (cwd) => {
        writeBuiltinCommand(join(cwd, "builtin-cmds"), "plan", "builtin plan body $ARGUMENTS");
      },
      async (cwd) => {
        const cmds = await loadCommands({
          cwd,
          homeDir: EMPTY_HOME,
          builtinDirs: [join(cwd, "builtin-cmds")],
        });
        expect(cmds.get("plan")?.body).toBe("builtin plan body $ARGUMENTS");
      },
    );
  });

  test("precedence: builtin < user < project, override by name", async () => {
    await withTempCwd(
      (cwd) => {
        const builtinDir = join(cwd, "builtin-cmds");
        writeBuiltinCommand(builtinDir, "only-builtin", "from builtin");
        writeBuiltinCommand(builtinDir, "user-wins", "from builtin");
        writeBuiltinCommand(builtinDir, "project-wins", "from builtin");
        writeCommand(cwd, "project-wins", "from project");
      },
      async (cwd) => {
        const home = mkdtempSync(join(tmpdir(), "slash-home-"));
        try {
          writeUserCommand(home, "user-wins", "from user");
          writeUserCommand(home, "project-wins", "from user");
          const cmds = await loadCommands({
            cwd,
            homeDir: home,
            builtinDirs: [join(cwd, "builtin-cmds")],
          });
          expect(cmds.get("only-builtin")?.body).toBe("from builtin");
          expect(cmds.get("user-wins")?.body).toBe("from user");
          expect(cmds.get("project-wins")?.body).toBe("from project");
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      },
    );
  });

  test("an empty-body project override effectively disables a builtin", async () => {
    await withTempCwd(
      (cwd) => {
        writeBuiltinCommand(join(cwd, "builtin-cmds"), "dream", "run the dream playbook");
        writeCommand(cwd, "dream", "");
      },
      async (cwd) => {
        const cmds = await loadCommands({
          cwd,
          homeDir: EMPTY_HOME,
          builtinDirs: [join(cwd, "builtin-cmds")],
        });
        expect(cmds.get("dream")?.body).toBe("");
        // expand() of the disabled command yields an empty effective message.
        const r = expand("/dream now", cmds);
        expect(r.handled).toBe(true);
        expect(r.expanded).toBe("");
      },
    );
  });

  test("nonexistent builtin dirs are ignored", async () => {
    await withTempCwd(
      (cwd) => {
        writeCommand(cwd, "real", "body");
      },
      async (cwd) => {
        const cmds = await loadCommands({
          cwd,
          homeDir: EMPTY_HOME,
          builtinDirs: [join(cwd, "does-not-exist")],
        });
        expect([...cmds.keys()]).toEqual(["real"]);
      },
    );
  });

  test("$ARGUMENTS expansion works for a builtin-loaded command", async () => {
    await withTempCwd(
      (cwd) => {
        writeBuiltinCommand(
          join(cwd, "builtin-cmds"),
          "focus",
          "Set the current focus to: $ARGUMENTS",
        );
      },
      async (cwd) => {
        const cmds = await loadCommands({
          cwd,
          homeDir: EMPTY_HOME,
          builtinDirs: [join(cwd, "builtin-cmds")],
        });
        const r = expand("/focus ship the CSV export", cmds);
        expect(r.handled).toBe(true);
        expect(r.expanded).toBe("Set the current focus to: ship the CSV export");
      },
    );
  });
});

describe("loadCommands — error wrapping (SlashCommandError)", () => {
  afterEach(() => {
    restoreRealFs();
  });

  test("a readFileSync failure is wrapped in a SlashCommandError", async () => {
    await withTempCwd(
      (cwd) => {
        writeCommand(cwd, "boom", "body");
      },
      async (cwd) => {
        const mdFile = join(cwd, ".crewhaus", "commands", "boom.md");
        // statSync passes (real file), but the read fails — exercises the
        // readFileSync catch and the SlashCommandError constructor.
        mock.module("node:fs", () => ({
          ...REAL_FS,
          readFileSync: (p: Parameters<typeof realReadFileSync>[0], ...rest: unknown[]) => {
            if (typeof p === "string" && p === mdFile) {
              throw new Error("EACCES: permission denied");
            }
            // biome-ignore lint/suspicious/noExplicitAny: passthrough shim
            return (realReadFileSync as any)(p, ...rest);
          },
        }));

        const err = await loadCommands({ cwd, homeDir: EMPTY_HOME }).then(
          () => null,
          (e) => e,
        );
        expect(err).toBeInstanceOf(SlashCommandError);
        expect((err as SlashCommandError).name).toBe("SlashCommandError");
        expect((err as Error).message).toContain("failed to read");
        expect((err as Error).message).toContain("EACCES");
        // The original error is threaded through as `cause`.
        expect((err as SlashCommandError).cause).toBeInstanceOf(Error);
      },
    );
  });

  test("SlashCommandError is a config-kind CrewhausError carrying its cause", () => {
    const cause = new Error("root");
    const err = new SlashCommandError("nope", cause);
    expect(err).toBeInstanceOf(SlashCommandError);
    expect(err.name).toBe("SlashCommandError");
    expect(err.message).toBe("nope");
    expect(err.cause).toBe(cause);
  });
});

describe("expand — non-slash and unknown", () => {
  test("non-slash input passes through unchanged", () => {
    const cmds = new Map<string, SlashCommand>([["x", { name: "x", body: "B", filePath: "/x" }]]);
    const r = expand("hello world", cmds);
    expect(r.handled).toBe(false);
    expect(r.expanded).toBe("hello world");
  });

  test("unknown command name passes through", () => {
    const cmds = new Map<string, SlashCommand>([["x", { name: "x", body: "B", filePath: "/x" }]]);
    const r = expand("/missing some args", cmds);
    expect(r.handled).toBe(false);
    expect(r.expanded).toBe("/missing some args");
  });

  test("empty commands map → not handled", () => {
    const r = expand("/anything", new Map());
    expect(r.handled).toBe(false);
  });
});

describe("expand — known command", () => {
  const cmds = new Map<string, SlashCommand>([
    [
      "explain",
      {
        name: "explain",
        body: "Explain $ARGUMENTS in two sentences.",
        filePath: "/x",
      },
    ],
  ]);

  test("substitutes simple args", () => {
    const r = expand("/explain quicksort", cmds);
    expect(r.handled).toBe(true);
    expect(r.expanded).toBe("Explain quicksort in two sentences.");
    expect(r.arguments).toBe("quicksort");
    expect(r.command?.name).toBe("explain");
  });

  test("empty args become empty string", () => {
    const r = expand("/explain", cmds);
    expect(r.handled).toBe(true);
    expect(r.expanded).toBe("Explain  in two sentences.");
    expect(r.arguments).toBe("");
  });

  test("multi-line args preserved", () => {
    const r = expand("/explain a\nmulti\nline", cmds);
    expect(r.expanded).toBe("Explain a\nmulti\nline in two sentences.");
  });

  test("leading whitespace before slash is allowed", () => {
    const r = expand("   /explain trimmed", cmds);
    expect(r.handled).toBe(true);
    expect(r.expanded).toContain("trimmed");
  });
});

describe("expand — $ARGUMENTS property test (T9)", () => {
  // Generate random body fragments and args, assert the algebraic property:
  //   expanded === body.split("$ARGUMENTS").join(args)
  // Charset deliberately includes the placeholder, regex specials, $, \, \n.
  const CHARS = "abc 123 \n\t  \\ $ARGUMENTS .*+?^${}()|[]{} 你好 emoji $$$ \" '";

  function randomString(maxLen: number): string {
    const len = Math.floor(Math.random() * maxLen);
    let out = "";
    for (let i = 0; i < len; i++) {
      out += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
    }
    return out;
  }

  function randomBody(): string {
    // Drop in 0–4 placeholders interleaved with random text.
    const placeholders = Math.floor(Math.random() * 5);
    let out = randomString(20);
    for (let i = 0; i < placeholders; i++) {
      out += "$ARGUMENTS";
      out += randomString(10);
    }
    return out;
  }

  test("substitution matches body.split($ARGUMENTS).join(extracted-args) for 200 random pairs", () => {
    for (let i = 0; i < 200; i++) {
      const body = randomBody();
      const args = randomString(30);
      const cmds = new Map<string, SlashCommand>([["t", { name: "t", body, filePath: "/x" }]]);
      const result = expand(`/t ${args}`, cmds);
      // Property is keyed on `result.arguments` (the canonical extraction)
      // so we don't pre-suppose anything about how the separator between
      // command name and args is parsed. The invariant under test is the
      // substitution algebra: every literal `$ARGUMENTS` in the body is
      // replaced with whatever extracted args was, and nothing else.
      const expected = body.split("$ARGUMENTS").join(result.arguments ?? "");
      expect(result.handled).toBe(true);
      expect(result.expanded).toBe(expected);
    }
  });

  test("args containing $ARGUMENTS are NOT recursively expanded", () => {
    const cmds = new Map<string, SlashCommand>([
      ["t", { name: "t", body: "before $ARGUMENTS after", filePath: "/x" }],
    ]);
    const result = expand("/t $ARGUMENTS-literal", cmds);
    // Single non-recursive substitution: args land verbatim, $ARGUMENTS in
    // the args is NOT re-substituted.
    expect(result.expanded).toBe("before $ARGUMENTS-literal after");
  });

  test("regex specials in args are not interpreted", () => {
    const cmds = new Map<string, SlashCommand>([
      ["t", { name: "t", body: "[$ARGUMENTS]", filePath: "/x" }],
    ]);
    const result = expand("/t .*+?^${}()|[]\\", cmds);
    expect(result.expanded).toBe("[.*+?^${}()|[]\\]");
  });
});

describe("parseCommandFile direct", () => {
  test("body-only", () => {
    const r = parseCommandFile("plain body");
    expect(r.body).toBe("plain body");
    expect(r.description).toBeUndefined();
  });

  test("frontmatter then body", () => {
    const r = parseCommandFile("---\ndescription: d\n---\nbody here");
    expect(r.description).toBe("d");
    expect(r.body).toBe("body here");
  });
});
