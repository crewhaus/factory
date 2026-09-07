/**
 * 0.6.0 PR 9e — the COMPILED-BUNDLE smoke for the hybrid mechanisms.
 *
 * Every other test in this PR asserts on emitted TEXT. This one boots the
 * emitted bundle for real: `crewhaus compile` a hybrid cli spec (cascade +
 * `model_directed` + `policy: classifier` + guide), then `bun agent.ts` in a
 * sandbox with one line on stdin, and assert on what the provider actually
 * received and what the session log actually recorded:
 *
 *   - `Consult` (and `Escalate`) are ADVERTISED on the serving turn — the
 *     model-directed pair reached the bundle's tool list;
 *   - the `model_route` line carries `policy: "classifier"` and the label —
 *     the route classifier ran, instead of the documented fallback
 *     (`reason: "classifier failed: no classifier wired"`, which is exactly
 *     what a compiled bundle produced before this PR);
 *   - the serving request's system prompt carries a `<guide>` block — the
 *     side-call closure ran and its text reached the request.
 *
 * Offline by construction: every model slot in the spec is a
 * `local/<id>@http://127.0.0.1:<port>/v1` string, so the whole run — main
 * turn, classifier label call, guide side call — goes to the stub
 * OpenAI-compatible server started here. No credentials, no network.
 *
 * Resolution (the 0.5.6 eval-bridge lesson): the emitted pinned
 * `package.json` is removed and the IN-TREE workspace packages are symlinked
 * beside the bundle, and the spawn passes `--no-install` — without both, Bun
 * auto-installs the last PUBLISHED release into the out-dir and the smoke
 * measures the wrong code (that is how 0.5.5 shipped a runtime-core that
 * could not resolve `zod` with every gate green).
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../..");
const CLI_PATH = join(import.meta.dir.replace(/([/\\])dist$/, "$1src"), "index.ts");

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function newTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type StubRequest = { readonly model: string; readonly body: Record<string, unknown> };

/**
 * A minimal OpenAI-compatible `/v1/chat/completions` SSE server — the wire
 * the `local/<id>@<url>` model strings resolve to (`@crewhaus/adapter-openai`
 * through the model-router). A forced `submit_route_label` call is answered
 * with a tool call (that is the route classifier); everything else with one
 * text chunk. Every request body is recorded for the assertions.
 */
function startStubServer(requests: StubRequest[]) {
  const sse = (chunks: ReadonlyArray<Record<string, unknown>>): Response =>
    new Response(
      `${chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n")}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
    );
  const head = (model: string) => ({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: 0,
    model,
  });
  const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      const model = String(body["model"] ?? "");
      requests.push({ model, body });
      const forced = body["tool_choice"] as { function?: { name?: string } } | undefined;
      if (forced?.function?.name === "submit_route_label") {
        return sse([
          {
            ...head(model),
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: "submit_route_label", arguments: "" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            ...head(model),
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '{"label":"strong"}' } }],
                },
                finish_reason: null,
              },
            ],
          },
          {
            ...head(model),
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage,
          },
        ]);
      }
      return sse([
        {
          ...head(model),
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: `stub(${model})` },
              finish_reason: null,
            },
          ],
        },
        { ...head(model), choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
      ]);
    },
  });
}

/** Symlink every in-tree `@crewhaus/*` package beside the bundle, so its bare
 *  imports resolve to THIS working tree (paired with `--no-install`). */
function linkWorkspacePackages(bundleDir: string): void {
  for (const entry of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(REPO_ROOT, "packages", entry.name);
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
    if (name === undefined || !name.startsWith("@crewhaus/")) continue;
    const dest = join(bundleDir, "node_modules", name);
    mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(dest)) symlinkSync(dir, dest, "dir");
  }
}

/** Every event of one kind across the sandbox's session logs. */
function eventsOfKind(sessionDir: string, kind: string): Array<Record<string, unknown>> {
  if (!existsSync(sessionDir)) return [];
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
    );
  const out: Array<Record<string, unknown>> = [];
  for (const file of walk(sessionDir)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.length === 0) continue;
      const ev = JSON.parse(line) as { kind?: string; payload?: Record<string, unknown> };
      if (ev.kind === kind && ev.payload !== undefined) out.push(ev.payload);
    }
  }
  return out;
}

describe("a compiled hybrid bundle runs the closures it declares (PR 9e)", () => {
  test("Consult is advertised, the classifier verdict lands on model_route, and a <guide> block reaches the request", async () => {
    const requests: StubRequest[] = [];
    const server = startStubServer(requests);
    const url = `http://127.0.0.1:${server.port}/v1`;
    try {
      const sandbox = newTmp("crewhaus-hybrid-cwd-");
      const specPath = join(sandbox, "crewhaus.yaml");
      writeFileSync(
        specPath,
        [
          "name: hybrid-smoke",
          "target: cli",
          // Continuity off keeps the smoke to the routing surface under test.
          "continuity: false",
          "agent:",
          `  model: 'local/cheap@${url}'`,
          "  instructions: be helpful",
          "  model_pool:",
          "    policy: classifier",
          "    candidates:",
          `      - { model: 'local/cheap@${url}', tags: [cheap] }`,
          `      - { model: 'local/strong@${url}', tags: [strong] }`,
          `    classifier: { model: 'local/judge@${url}', labels: { cheap: simple, strong: hard } }`,
          "    strategy:",
          "      cascade: { draft: cheap, escalate_to: strong }",
          `      guide: { model: 'local/strong@${url}', every: first_turn }`,
          "      model_directed: true",
          "",
        ].join("\n"),
      );

      const out = newTmp("crewhaus-hybrid-out-");
      const env = {
        PATH: process.env["PATH"] ?? "",
        CREWHAUS_REGISTRY_ROOT: join(sandbox, "registry"),
        CREWHAUS_WATCHME_ROOT: join(sandbox, "watchme"),
        CREWHAUS_SESSION_DIR: join(sandbox, "sessions"),
      };
      const compiled = Bun.spawnSync(
        [process.execPath, CLI_PATH, "compile", specPath, "--no-register", "-o", out],
        { cwd: sandbox, env },
      );
      expect(compiled.stderr.toString()).not.toContain("error");
      expect(compiled.exitCode).toBe(0);

      // The bundle must carry BOTH halves of the pool: the literal blob and
      // the composition-root call that turns its closure keys into closures.
      const agentTs = readFileSync(join(out, "agent.ts"), "utf8");
      expect(agentTs).toContain('import { wireHybrid } from "@crewhaus/model-service";');
      expect(agentTs).toContain("...wireHybrid({");
      // …and the pinned manifest must declare the package it now imports.
      const manifest = JSON.parse(readFileSync(join(out, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      expect(Object.keys(manifest.dependencies ?? {})).toContain("@crewhaus/model-service");

      rmSync(join(out, "package.json"), { force: true });
      linkWorkspacePackages(out);

      const proc = Bun.spawn([process.execPath, "--no-install", join(out, "agent.ts")], {
        cwd: sandbox,
        env,
        stdin: new TextEncoder().encode("hello there\n"),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("agent> stub(");

      // (1) The serving turn. Three calls in all: the guide, the classifier's
      // forced label call, and the turn itself.
      const serving = requests.filter(
        (r) => r.body["tools"] !== undefined && r.body["tool_choice"] === undefined,
      );
      expect(serving.length).toBe(1);
      const advertised = (
        serving[0]?.body["tools"] as ReadonlyArray<{ function?: { name?: string } }>
      ).map((t) => t.function?.name);
      expect(advertised).toContain("Consult");
      expect(advertised).toContain("Escalate");

      // (2) The route line names the classifier and its label — not the
      // "no classifier wired" fallback a pre-9e bundle produced.
      const routes = eventsOfKind(join(sandbox, "sessions"), "model_route");
      expect(routes.length).toBeGreaterThan(0);
      const route = routes[0] as { policy?: string; reason?: string; model?: string };
      expect(route.policy).toBe("classifier");
      expect(route.reason).toContain("label=strong");
      expect(route.reason).not.toContain("no classifier wired");
      expect(route.model).toBe("strong");

      // (3) The guide's text reached the serving request's system prompt.
      const system = JSON.stringify(serving[0]?.body["messages"]);
      expect(system).toContain("<guide>");
      const stages = eventsOfKind(join(sandbox, "sessions"), "model_stage");
      expect(stages.some((s) => s["stage"] === "guide" && s["outcome"] === "done")).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 240_000);
});
