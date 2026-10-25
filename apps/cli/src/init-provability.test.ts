/**
 * 0.8.0 (design/0.8.0-provability-release.md §11) — the CLI surface of the
 * proof floor at scaffold time, driven through the real binary:
 *
 *   - `crewhaus init --provability <rung>` writes the block (validated; `off`
 *     writes nothing, absent being off), says what the rung still needs, and
 *     the spec it writes compiles;
 *   - `crewhaus init --interactive` asks ONE proof question (cli default
 *     off, the researcher template's default cited), or takes the flag as
 *     the answer;
 *   - `crewhaus run` advertises the `provability` skill only for a spec that
 *     declares the block — through wireMemory's discovery (continuity on, the
 *     default) and through its own (continuity off) — and `crewhaus serve
 *     --mcp` puts it in the served turn's prompt the same way.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSpec } from "@crewhaus/spec";
import { provabilityQuestion } from "./init-interactive";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const ROOTS: string[] = [];
afterAll(() => {
  for (const root of ROOTS.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fresh directory, removed after the file runs. */
function freshDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `crewhaus-init-prov-${label}-`));
  ROOTS.push(dir);
  return dir;
}

/**
 * Spawn the CLI hermetically: an empty HOME (no user skills or registry rows
 * leak in or out), the given cwd, optional stdin.
 */
async function cli(
  args: ReadonlyArray<string>,
  opts: { cwd: string; stdin?: string; env?: Record<string, string> },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const home = freshDir("home");
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd: opts.cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      CREWHAUS_REGISTRY_ROOT: join(home, "registry"),
      CREWHAUS_WATCHME_ROOT: join(home, "watchme"),
      ...(opts.env ?? {}),
    },
    stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const provabilityOf = (yaml: string): unknown =>
  (parseSpec(yaml) as { readonly provability?: unknown }).provability;

describe("crewhaus init --provability <rung>", () => {
  test("writes the floor with the tool it needs, lints clean, and the spec compiles", async () => {
    const dir = freshDir("grounded");
    const r = await cli(["init", "--provability", "grounded"], { cwd: dir });
    expect(r.exitCode).toBe(0);
    const yaml = readFileSync(join(dir, "crewhaus.yaml"), "utf-8");
    expect(yaml).toContain("\n# The proof gate: off | cited | grounded | checked | proven.\n");
    expect(provabilityOf(yaml)).toBe("grounded");
    // A floor no tool can meet would fail every answer: the scaffold reads sources.
    expect((parseSpec(yaml) as { tools?: unknown }).tools).toEqual(["read", "webFetch"]);
    expect(r.stdout).toContain(
      "provability: grounded — the cited source was read this session and holds the claim.",
    );
    expect(r.stdout).not.toContain("note:");
    const lint = await cli(["lint", join(dir, "crewhaus.yaml")], { cwd: dir });
    expect(lint.stdout).toContain("lint: clean");
    const compiled = await cli(["compile", join(dir, "crewhaus.yaml"), "-o", join(dir, "out")], {
      cwd: dir,
    });
    expect(compiled.exitCode).toBe(0);
    expect(readFileSync(join(dir, "out", "agent.ts"), "utf-8")).toContain("provabilitySkills(");
  }, 30_000);

  test("checked: the scaffold carries an allowlisted tool and lints clean", async () => {
    const dir = freshDir("checked");
    const r = await cli(["init", "--provability", "checked"], { cwd: dir });
    expect(r.exitCode).toBe(0);
    const yaml = readFileSync(join(dir, "crewhaus.yaml"), "utf-8");
    expect((parseSpec(yaml) as { tools?: unknown }).tools).toEqual(["evaluate"]);
    expect(r.stdout).not.toContain("note:");
    const lint = await cli(["lint", join(dir, "crewhaus.yaml")], { cwd: dir });
    expect(lint.stdout).toContain("lint: clean");
  }, 30_000);

  test("a path-like name: the spec is written and init exits 0 — the notes are advisory", async () => {
    // The plain scaffold writes `name: <arg>` unvalidated, so `./bot` and
    // `sub/e` write names parseSpec refuses. The proof-floor notes run AFTER
    // the write and must say so, never crash an init that already wrote.
    for (const [arg, level] of [
      ["./bot", "cited"],
      ["sub/e", "checked"],
    ] as const) {
      const dir = freshDir("pathlike");
      const r = await cli(["init", arg, "--provability", level], { cwd: dir });
      expect([arg, r.exitCode]).toEqual([arg, 0]);
      expect(r.stderr).not.toContain("SpecParseError");
      const yaml = readFileSync(join(dir, arg, "crewhaus.yaml"), "utf-8");
      expect(yaml).toContain(`provability: ${level}`);
      expect(r.stdout).toContain(`provability: ${level} — `);
      expect(r.stdout).toContain("note: could not check what this proof level needs");
      expect(r.stdout).toContain("run `crewhaus lint`");
    }
  }, 30_000);

  test("an unknown rung is refused before anything is written", async () => {
    const dir = freshDir("bogus");
    const r = await cli(["init", "--provability", "verified"], { cwd: dir });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      '--provability must be one of off | cited | grounded | checked | proven (got "verified")',
    );
    expect(existsSync(join(dir, "crewhaus.yaml"))).toBe(false);
  }, 20_000);

  test("off writes nothing: the spec is byte-identical to a plain init", async () => {
    const plain = freshDir("plain");
    const off = freshDir("off");
    expect((await cli(["init", "agent"], { cwd: plain })).exitCode).toBe(0);
    const r = await cli(["init", "agent", "--provability", "off"], { cwd: off });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(off, "agent", "crewhaus.yaml"), "utf-8")).toBe(
      readFileSync(join(plain, "agent", "crewhaus.yaml"), "utf-8"),
    );
    expect(r.stdout).toContain("provability: off — no proof gate (absent is off");
  }, 20_000);

  test("an existing spec is never touched: the flag is refused, by name", async () => {
    const dir = freshDir("existing");
    writeFileSync(join(dir, "crewhaus.yaml"), "name: pre\ntarget: cli\n");
    const r = await cli(["init", "--ci", "--provability", "cited"], { cwd: dir });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--provability sets the proof floor of a new spec");
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf-8")).toBe("name: pre\ntarget: cli\n");
    expect(existsSync(join(dir, ".github"))).toBe(false);
  }, 20_000);

  test("composes with --hybrid, tools included", async () => {
    const dir = freshDir("hybrid");
    const r = await cli(["init", "--hybrid", "--provability", "checked"], { cwd: dir });
    expect(r.exitCode).toBe(0);
    const yaml = readFileSync(join(dir, "crewhaus.yaml"), "utf-8");
    expect(yaml).toContain("model_pool:");
    expect(provabilityOf(yaml)).toBe("checked");
    expect((parseSpec(yaml) as { tools?: unknown }).tools).toEqual(["evaluate"]);
    expect(r.stdout).not.toContain("note:");
  }, 20_000);

  test("--help documents the flag", async () => {
    const r = await cli(["init", "--help"], { cwd: freshDir("help") });
    expect(r.stdout).toContain("--provability <rung>");
    expect(r.stdout).toContain("off | cited | grounded | checked | proven");
  }, 20_000);
});

describe("crewhaus init --interactive — the proof question (scripted path)", () => {
  test("cli: asked last with the default off; a rung answer writes the block", async () => {
    const root = freshDir("q-cli");
    // name, shape, model, instructions, tools, hybrid, proof
    const r = await cli(["init", "--interactive", "bot"], {
      cwd: root,
      stdin: "\n\n\nhelp users\n\n\ngrounded\n",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(provabilityQuestion("off"));
    // Asked after the hybrid question, once.
    expect(r.stdout.indexOf("[y/N]: ")).toBeLessThan(r.stdout.indexOf("How much proof"));
    expect(r.stdout.split("How much proof should answers carry?").length).toBe(2);
    const yaml = readFileSync(join(root, "bot", "crewhaus.yaml"), "utf-8");
    expect(provabilityOf(yaml)).toBe("grounded");
    expect(r.stdout).toContain("note: provability.level: grounded needs a source");
  }, 20_000);

  test("a wrong answer is asked again", async () => {
    const root = freshDir("q-retry");
    const r = await cli(["init", "--interactive", "bot"], {
      cwd: root,
      stdin: "\n\n\nhelp users\n\n\nvery much\nproven\n",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "not a proof level — off | cited | grounded | checked | proven [off]: ",
    );
    expect(provabilityOf(readFileSync(join(root, "bot", "crewhaus.yaml"), "utf-8"))).toBe("proven");
  }, 20_000);

  test("research: the researcher template defaults to cited, and the spec compiles", async () => {
    const root = freshDir("q-research");
    // name, shape, model, instructions, tools, goal — then end of input on the proof question.
    const r = await cli(["init", "--interactive", "res"], {
      cwd: root,
      stdin: "\nresearch\n\ninvestigate\n\nfind the best framework\n",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(provabilityQuestion("cited"));
    const file = join(root, "res", "crewhaus.yaml");
    const yaml = readFileSync(file, "utf-8");
    expect(provabilityOf(yaml)).toBe("cited");
    expect(r.stdout).toContain("provability: cited — every claim names a source");
    const compiled = await cli(["compile", file, "-o", join(root, "out")], { cwd: root });
    expect(compiled.exitCode).toBe(0);
    expect(compiled.stderr).not.toContain("provability-on-fail-degraded");
  }, 30_000);

  test("--provability answers the question up front", async () => {
    const root = freshDir("q-preset");
    const r = await cli(["init", "--interactive", "bot", "--provability", "checked"], {
      cwd: root,
      stdin: "\n\n\nhelp users\n\n\n",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("How much proof");
    expect(provabilityOf(readFileSync(join(root, "bot", "crewhaus.yaml"), "utf-8"))).toBe(
      "checked",
    );
  }, 20_000);

  test("a spec that does not lower: init still succeeds, and the note says so", async () => {
    // parseSpec accepts `all-nonsense`; lower refuses it. The spec is
    // written before the notes are computed, so the notes are advisory.
    const root = freshDir("q-unlowerable");
    const r = await cli(["init", "--interactive", "bot"], {
      cwd: root,
      stdin: "\n\n\nhelp users\nall-nonsense\n\ngrounded\n",
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(root, "bot", "crewhaus.yaml"))).toBe(true);
    expect(r.stdout).toContain("  note: could not check what this proof level needs");
    expect(r.stdout).toContain("all-nonsense");
    expect(r.stdout).toContain("next: cd bot && crewhaus run crewhaus.yaml");
    // The researcher template's default floor takes the same path.
    const res = await cli(["init", "--interactive", "res"], {
      cwd: freshDir("q-unlowerable-research"),
      stdin: "\nresearch\n\ninvestigate\nall-nonsense\nfind x\n\n",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("  note: could not check what this proof level needs");
  }, 30_000);

  test("a workflow never sees the question, and refuses the flag plainly", async () => {
    const asked = await cli(["init", "--interactive", "flow"], {
      cwd: freshDir("q-flow"),
      stdin: "\nworkflow\n\ndo the thing\n\n",
    });
    expect(asked.exitCode).toBe(0);
    expect(asked.stdout).not.toContain("How much proof");
    const refused = await cli(["init", "--interactive", "flow", "--provability", "cited"], {
      cwd: freshDir("q-flow-flag"),
      stdin: "\nworkflow\n\ndo the thing\n\n",
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("a workflow spec does not carry provability:");
  }, 20_000);
});

describe("crewhaus run — the provability skill reaches the prompt only with the block", () => {
  const SPEC = (extra: string): string =>
    `name: gated\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: answer\n${extra}`;

  async function skillsLine(extra: string): Promise<string> {
    const dir = freshDir("run");
    writeFileSync(join(dir, "crewhaus.yaml"), SPEC(extra));
    mkdirSync(join(dir, ".crewhaus"), { recursive: true });
    const r = await cli(["run", join(dir, "crewhaus.yaml")], {
      cwd: dir,
      stdin: "",
      env: { ANTHROPIC_API_KEY: "test-no-call" },
    });
    expect(r.exitCode).toBe(0);
    return r.stdout.split("\n").find((l) => l.startsWith("[skills] ")) ?? "";
  }

  test("continuity on (the default): wireMemory's discovery carries it beside continuity", async () => {
    expect(await skillsLine("provability: cited\n")).toBe(
      "[skills] 2 available: continuity, provability",
    );
    expect(await skillsLine("")).toBe("[skills] 1 available: continuity");
  }, 30_000);

  test("continuity off: the run's own discovery carries it", async () => {
    expect(await skillsLine("continuity: false\nprovability: grounded\n")).toBe(
      "[skills] 1 available: provability",
    );
    expect(await skillsLine("continuity: false\n")).toBe("");
  }, 30_000);
});

describe("crewhaus serve --mcp — the served turn's prompt carries the skill only with the block", () => {
  /**
   * A minimal OpenAI-compatible `/v1/chat/completions` SSE server (the wire a
   * `local/<id>@<url>` model resolves to): one plain answer per request, every
   * request body recorded — so a served turn runs credential-free and the
   * test reads exactly what reached the model.
   */
  function startStub(): {
    readonly url: string;
    readonly bodies: Array<Record<string, unknown>>;
    stop(): void;
  } {
    const bodies: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json()) as Record<string, unknown>;
        bodies.push(body);
        const head = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 0 };
        const chunks = [
          {
            ...head,
            choices: [
              { index: 0, delta: { role: "assistant", content: "Hello." }, finish_reason: null },
            ],
          },
          {
            ...head,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
          },
        ];
        return new Response(
          `${chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n")}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    return { url: `http://127.0.0.1:${server.port}/v1`, bodies, stop: () => server.stop(true) };
  }

  /** Serve `extra` over stdio, run one `chat` call, and return what the model was sent. */
  async function servedRequest(extra: string): Promise<string> {
    const stub = startStub();
    const dir = freshDir("serve");
    const home = freshDir("serve-home");
    writeFileSync(
      join(dir, "crewhaus.yaml"),
      `name: gated\ntarget: cli\nagent:\n  model: local/stub@${stub.url}\n  instructions: answer\n${extra}`,
    );
    const proc = Bun.spawn([process.execPath, CLI_PATH, "serve", "--mcp", "crewhaus.yaml"], {
      cwd: dir,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        CREWHAUS_REGISTRY_ROOT: join(home, "registry"),
        CREWHAUS_WATCHME_ROOT: join(home, "watchme"),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const send = (message: Record<string, unknown>): void => {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    };
    try {
      send({
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      });
      send({ method: "notifications/initialized" });
      send({ id: 2, method: "tools/call", params: { name: "chat", arguments: { message: "hi" } } });
      // Read the protocol channel until the call answers, then close stdin.
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let seen = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
        if (seen.split("\n").some((line) => line.includes('"id":2'))) break;
      }
      reader.releaseLock();
      expect(seen).toContain('"id":2');
      expect(seen).not.toContain('"isError":true');
      proc.stdin.end();
      await proc.exited;
      expect(stub.bodies.length).toBeGreaterThan(0);
      return JSON.stringify(stub.bodies[0]);
    } finally {
      proc.kill();
      stub.stop();
    }
  }

  const BULLET = "- provability: Load before you answer";

  test("continuity on (the default): wireMemory's discovery lists it beside continuity", async () => {
    const gated = await servedRequest("provability: cited\n");
    expect(gated).toContain(BULLET);
    expect(gated).toContain("- continuity: ");
    const plain = await servedRequest("");
    expect(plain).not.toContain(BULLET);
    expect(plain).toContain("- continuity: ");
  }, 60_000);

  test("continuity off: serve's own discovery carries it, with a Skill tool to load it", async () => {
    const gated = await servedRequest("continuity: false\nprovability: grounded\n");
    expect(gated).toContain(BULLET);
    expect(gated).toContain('"name":"Skill"');
    const plain = await servedRequest("continuity: false\n");
    expect(plain).not.toContain(BULLET);
    expect(plain).not.toContain('"name":"Skill"');
  }, 60_000);
});
