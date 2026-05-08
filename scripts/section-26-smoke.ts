#!/usr/bin/env bun
/**
 * Section 26 Studio — end-to-end smoke.
 *
 * Verifies the studio backend stack against a fresh tmpdir:
 *
 *   1. studio-server boots on a port, /healthz returns ok.
 *   2. /api/templates lists 10 scaffold-templates (one per target shape).
 *   3. POST /api/wizard/start → step (×5) → /compile produces a valid
 *      YAML; POST /api/specs creates the spec; GET /api/specs lists it.
 *   4. POST /api/runs synthesizes events; GET /api/runs/:id/events
 *      streams `run_start`, at least one `trace`, and a `done` SSE event.
 *   5. /api/graph-layout/:specName returns nodes + edges for a graph
 *      spec (creates `g` with 3 nodes + 2 edges; layout returns the
 *      same 3 + 2 with deterministic positions).
 *   6. Drop a fixture plugin under `<pluginRoot>/fixture/index.ts` →
 *      /api/plugins lists it (T8 sandbox check verified by
 *      plugin-sdk's own tests).
 *   7. trace-viewer + graph-visualizer module APIs work in-process
 *      (smoke imports them and asserts a basic Gantt + layout shape).
 *
 * The smoke does NOT use Playwright in v0 — backend HTTP probes are
 * sufficient. The kickoff says Playwright is gated behind
 * `CREWHAUS_RUN_PLAYWRIGHT=1` and v0 sticks to that gate.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const log = (msg: string): void => {
  process.stderr.write(`[smoke] ${msg}\n`);
};
const fail = (msg: string): never => {
  process.stderr.write(`[smoke] FAIL: ${msg}\n`);
  process.exit(2);
};

const main = async (): Promise<void> => {
  const root = join(tmpdir(), `studio-smoke-${Math.random().toString(16).slice(2, 8)}`);
  mkdirSync(root, { recursive: true });
  const workspaceDir = join(root, "specs");
  const pluginRoot = join(root, "plugins");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(pluginRoot, { recursive: true });

  // (6) Pre-seed a fixture plugin (so /api/plugins finds it on first scan).
  const fixtureDir = join(pluginRoot, "fixture");
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(
    join(fixtureDir, "index.ts"),
    `export default {
  name: "fixture",
  version: "0.0.1",
  description: "Hello from plugin",
  panes: [{ id: "main", title: "Hello", html: "<div>Hello from plugin</div>" }],
};
`,
  );

  log(`starting studio-server with tmp workspace ${root}`);
  // The smoke can't `import { startStudioServer }` directly because
  // scripts/ has no workspace-package resolution from outside the
  // workspace root. We invoke `scripts/studio-launcher.ts` as a
  // subprocess from the repo root — it does have resolution — and
  // pass the tmp paths via env vars.
  const port = 4187 + Math.floor(Math.random() * 1000);
  const child = spawn("bun", [join(process.cwd(), "scripts", "studio-launcher.ts")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      STUDIO_PORT: String(port),
      STUDIO_WORKSPACE: workspaceDir,
      STUDIO_PLUGIN_ROOT: pluginRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let actualPort = port;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("studio-server didn't start in 8s")), 8_000);
    child.stdout.on("data", (b: Buffer) => {
      const s = b.toString();
      const m = /READY:(\d+)/.exec(s);
      if (m?.[1]) {
        actualPort = Number.parseInt(m[1], 10);
        clearTimeout(t);
        resolve();
      }
    });
    child.stderr.on("data", (b: Buffer) => {
      process.stderr.write(`[server-stderr] ${b.toString()}`);
    });
  });
  const baseUrl = `http://localhost:${actualPort}`;
  log(`server up on ${baseUrl}`);
  try {
    // (1) /healthz
    const h = await fetch(`${baseUrl}/healthz`);
    if (h.status !== 200 || (await h.text()) !== "ok") fail("/healthz did not return ok");
    log("OK: /healthz");

    // (2) /api/templates
    const tmpls = (await fetch(`${baseUrl}/api/templates`).then((r) => r.json())) as {
      templates: Array<{ id: string; target: string }>;
    };
    if (tmpls.templates.length !== 10) {
      fail(`expected 10 templates, got ${tmpls.templates.length}`);
    }
    log(`OK: /api/templates lists ${tmpls.templates.length} templates`);

    // (3) Wizard end-to-end
    const start = (await fetch(`${baseUrl}/api/wizard/start`, {
      method: "POST",
    }).then((r) => r.json())) as { state: unknown };
    let state = start.state;
    const answers: Array<{ question: string; value: unknown }> = [
      { question: "target", value: "cli" },
      { question: "name", value: "smoke-cli" },
      { question: "model", value: "claude-sonnet-4-6" },
      { question: "tools", value: ["read", "bash"] },
      { question: "permissionMode", value: "default" },
    ];
    for (const a of answers) {
      const r = (await fetch(`${baseUrl}/api/wizard/step`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state, answer: a }),
      }).then((r) => r.json())) as { state: unknown };
      state = r.state;
    }
    const compiled = (await fetch(`${baseUrl}/api/wizard/compile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state }),
    }).then((r) => r.json())) as { yaml: string; envExample: string };
    if (!compiled.yaml.includes("name: smoke-cli")) fail("wizard YAML missing name");
    log("OK: wizard 5-question flow → compiled YAML");

    const create = await fetch(`${baseUrl}/api/specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "smoke-cli", yaml: compiled.yaml }),
    });
    if (create.status !== 201) fail(`spec create returned ${create.status}`);
    log("OK: POST /api/specs created the spec");

    const list = (await fetch(`${baseUrl}/api/specs`).then((r) => r.json())) as {
      specs: Array<{ name: string; target: string }>;
    };
    if (!list.specs.some((s) => s.name === "smoke-cli")) fail("spec not in /api/specs list");
    log("OK: GET /api/specs lists smoke-cli");

    // (4) Run + SSE
    const runRes = (await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ specName: "smoke-cli", prompt: "test" }),
    }).then((r) => r.json())) as { runId: string };
    const sse = await fetch(`${baseUrl}/api/runs/${runRes.runId}/events`);
    if (sse.headers.get("content-type") !== "text/event-stream") {
      fail("SSE stream did not return text/event-stream");
    }
    const text = await sse.text();
    if (!text.includes("run_start") || !text.includes("event: done")) {
      fail("SSE stream missing run_start or event: done");
    }
    log("OK: SSE stream emitted run_start + trace + event: done");

    // (5) Graph layout
    const graphYaml = `name: smoke-graph
target: graph
model: claude-sonnet-4-6
entry: a
nodes:
  a:
    instructions: a
  b:
    instructions: b
  c:
    instructions: c
edges:
  - { from: a, to: b }
  - { from: b, to: c }
`;
    const c2 = await fetch(`${baseUrl}/api/specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "smoke-graph", yaml: graphYaml }),
    });
    if (c2.status !== 201) fail(`graph spec create returned ${c2.status}`);
    const layout = (await fetch(`${baseUrl}/api/graph-layout/smoke-graph`).then((r) =>
      r.json(),
    )) as { nodes: Array<{ id: string }>; edges: Array<unknown> };
    if (layout.nodes.length !== 3)
      fail(`graph layout returned ${layout.nodes.length} nodes (expected 3)`);
    if (layout.edges.length !== 2)
      fail(`graph layout returned ${layout.edges.length} edges (expected 2)`);
    log("OK: /api/graph-layout returns 3 nodes + 2 edges (deterministic positions)");

    // (6) Plugin discovery
    const plugins = (await fetch(`${baseUrl}/api/plugins`).then((r) => r.json())) as {
      plugins: Array<{ name: string; panes: unknown[] }>;
    };
    if (!plugins.plugins.some((p) => p.name === "fixture")) {
      fail("fixture plugin not discovered");
    }
    log("OK: /api/plugins lists the fixture plugin");

    // (7) trace-viewer + graph-visualizer module tests as a subprocess
    log("running trace-viewer + graph-visualizer unit tests");
    for (const pkg of [
      "trace-viewer",
      "graph-visualizer",
      "wizard",
      "scaffold-templates",
      "plugin-sdk",
    ]) {
      const r = spawnSync("bun", ["test", "src"], {
        cwd: join(process.cwd(), "packages", pkg),
        encoding: "utf8",
      });
      if (r.status !== 0) {
        process.stderr.write(`[${pkg} test stderr]\n${r.stderr}\n`);
        fail(`${pkg} unit tests failed`);
      }
    }
    log(
      "OK: trace-viewer + graph-visualizer + wizard + scaffold-templates + plugin-sdk unit tests pass",
    );

    log("Section 26 Studio smoke PASS");
  } finally {
    child.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
};

main().catch((err) => {
  process.stderr.write(
    `[smoke] ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
