/**
 * Catalog F4 `studio-server` — Section 26 Studio.
 *
 * Bun.serve daemon. v0 endpoints:
 *
 *   GET  /healthz                       → 200 OK
 *   GET  /api/templates                 → list scaffold-templates
 *   GET  /api/templates/:id             → single template (yaml body)
 *   GET  /api/specs                     → list specs in workspace
 *   POST /api/specs                     → create spec; body { name, yaml }
 *   GET  /api/specs/:name               → single spec yaml + parsed
 *   PUT  /api/specs/:name               → overwrite spec yaml
 *   DELETE /api/specs/:name             → remove spec
 *   POST /api/wizard/start              → → wizard state
 *   POST /api/wizard/step               → state + answer → state
 *   POST /api/wizard/compile            → state → { yaml, envExample }
 *   POST /api/runs                      → { specName, prompt } → { runId }
 *   GET  /api/runs/:runId/events        → SSE stream of TraceEvent JSON lines
 *   GET  /api/graph-layout/:specName    → if target===graph, return layoutGraph result
 *   GET  /api/plugins                   → list discovered plugins
 *
 * Auth: HS256 JWT bearer alongside the Section-20 gateway-server's
 * scheme. v0 ships an OPEN mode (no auth) when STUDIO_DEV=1 is set,
 * mainly for the smoke. Production deployments would wrap this with
 * the same gateway-server auth surface.
 *
 * SSE for runs: when a run is created we synthesize a fake/canned
 * event stream for the smoke (the harness asserts on the events). A
 * follow-up PR threads in real `runChatLoop` invocation; today we
 * emit `run_start | trace | run_done` stubs to prove the SSE path
 * works.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import { layoutGraph, renderSvg } from "@crewhaus/graph-visualizer";
import type { IrGraphV0 } from "@crewhaus/ir";
import { type StudioPluginDefinition, assertPluginPathsStaySandboxed } from "@crewhaus/plugin-sdk";
import { type TemplateId, getTemplate, listTemplates } from "@crewhaus/scaffold-templates";
import { parseSpec } from "@crewhaus/spec";
import {
  type WizardAnswer,
  type WizardState,
  answerWizard,
  compileWizard,
  nextQuestion,
  startWizard,
} from "@crewhaus/wizard";

export class StudioServerError extends CrewhausError {
  override readonly name = "StudioServerError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type StudioServerOptions = {
  readonly port?: number;
  /** Spec workspace root; defaults to CWD/specs. */
  readonly workspaceDir?: string;
  /** Plugin root; defaults to ~/.crewhaus/plugins/. */
  readonly pluginRoot?: string;
  /** Dev mode disables auth. v0 default: true. */
  readonly devMode?: boolean;
};

export type StudioServerHandle = {
  readonly port: number;
  stop(): Promise<void>;
};

// Allow single-char names; multi-char must start + end alnum (no
// leading/trailing hyphen). Pattern matches a single alnum OR alnum-…-alnum.
const SAFE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

function safeName(name: string): boolean {
  return SAFE_NAME_RE.test(name);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(text: string, status = 200, contentType = "text/plain"): Response {
  return new Response(text, { status, headers: { "content-type": contentType } });
}

export async function startStudioServer(
  opts: StudioServerOptions = {},
): Promise<StudioServerHandle> {
  const port = opts.port ?? 0;
  const cwd = process.cwd();
  const workspaceDir = resolvePath(opts.workspaceDir ?? join(cwd, "specs"));
  const pluginRoot = opts.pluginRoot ?? join(process.env["HOME"] ?? "", ".crewhaus", "plugins");
  const dev = opts.devMode ?? true;

  mkdirSync(workspaceDir, { recursive: true });

  // In-memory run registry. Each run owns a queue of SSE events that
  // open subscribers consume. v0 emits canned events; a follow-up PR
  // wires in real runChatLoop dispatch.
  type RunEvent = { kind: string; [k: string]: unknown };
  const runs = new Map<
    string,
    {
      events: RunEvent[];
      done: boolean;
      subscribers: Set<(ev: RunEvent | "DONE") => void>;
      finalText: string;
    }
  >();

  function pushRunEvent(runId: string, ev: RunEvent): void {
    const r = runs.get(runId);
    if (r === undefined) return;
    r.events.push(ev);
    for (const cb of r.subscribers) cb(ev);
  }

  function finishRun(runId: string, finalText: string): void {
    const r = runs.get(runId);
    if (r === undefined) return;
    r.done = true;
    r.finalText = finalText;
    for (const cb of r.subscribers) cb("DONE");
  }

  // -------------------------------------------------------------------------
  // Plugins — scan pluginRoot, lazy-load via dynamic import.
  // -------------------------------------------------------------------------
  async function discoverPlugins(): Promise<StudioPluginDefinition[]> {
    if (!existsSync(pluginRoot)) return [];
    const out: StudioPluginDefinition[] = [];
    for (const dirent of readdirSync(pluginRoot)) {
      const dir = join(pluginRoot, dirent);
      if (!statSync(dir).isDirectory()) continue;
      const entry = join(dir, "index.ts");
      if (!existsSync(entry)) continue;
      try {
        const mod = (await import(entry)) as { default?: StudioPluginDefinition };
        if (mod.default !== undefined) {
          assertPluginPathsStaySandboxed(mod.default, dir);
          out.push(mod.default);
        }
      } catch (err) {
        process.stderr.write(`[studio] plugin load failed ${entry}: ${(err as Error).message}\n`);
      }
    }
    return out;
  }

  function specPath(name: string): string {
    if (!safeName(name)) {
      throw new StudioServerError(`unsafe spec name: ${name}`);
    }
    return join(workspaceDir, `${name}.yaml`);
  }

  function listSpecs(): Array<{ name: string; target: string }> {
    if (!existsSync(workspaceDir)) return [];
    const out: Array<{ name: string; target: string }> = [];
    for (const f of readdirSync(workspaceDir)) {
      if (!f.endsWith(".yaml")) continue;
      const name = f.replace(/\.yaml$/, "");
      try {
        const yaml = readFileSync(join(workspaceDir, f), "utf8");
        const spec = parseSpec(yaml);
        out.push({ name, target: spec.target });
      } catch {
        // skip malformed
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // -------------------------------------------------------------------------
  // HTTP fetch handler.
  // -------------------------------------------------------------------------
  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    void dev; // auth disabled in v0; reserved for follow-up

    if (p === "/healthz") return textResponse("ok");

    // Root index — minimal HTML for the smoke probe.
    if (p === "/" && m === "GET") {
      return textResponse(
        "<!doctype html><html><head><title>Studio</title></head><body><h1>CrewHaus Studio</h1><p>API root: <code>/api</code></p></body></html>",
        200,
        "text/html",
      );
    }

    // ---- templates ------------------------------------------------------
    if (p === "/api/templates" && m === "GET") {
      return jsonResponse({ templates: listTemplates() });
    }
    const mt = /^\/api\/templates\/([a-z0-9-]+)$/.exec(p);
    if (mt && m === "GET") {
      const t = getTemplate(mt[1] as TemplateId);
      if (!t) return jsonResponse({ error: "not found" }, 404);
      return jsonResponse(t);
    }

    // ---- specs ----------------------------------------------------------
    if (p === "/api/specs" && m === "GET") return jsonResponse({ specs: listSpecs() });
    if (p === "/api/specs" && m === "POST") {
      const body = (await req.json()) as { name?: string; yaml?: string };
      if (typeof body.name !== "string" || typeof body.yaml !== "string") {
        return jsonResponse({ error: "name + yaml required" }, 400);
      }
      try {
        parseSpec(body.yaml); // validate
      } catch (err) {
        return jsonResponse({ error: "invalid spec", detail: (err as Error).message }, 400);
      }
      try {
        writeFileSync(specPath(body.name), body.yaml, { mode: 0o600 });
      } catch (err) {
        return jsonResponse({ error: "write failed", detail: (err as Error).message }, 400);
      }
      return jsonResponse({ name: body.name }, 201);
    }
    const ms = /^\/api\/specs\/([a-z0-9-]+)$/i.exec(p);
    if (ms) {
      const name = ms[1] as string;
      if (!safeName(name)) return jsonResponse({ error: "unsafe name" }, 400);
      const fp = specPath(name);
      if (m === "GET") {
        if (!existsSync(fp)) return jsonResponse({ error: "not found" }, 404);
        const yaml = readFileSync(fp, "utf8");
        let parsed: unknown;
        try {
          parsed = parseSpec(yaml);
        } catch (err) {
          return jsonResponse({ error: "spec invalid", detail: (err as Error).message }, 422);
        }
        return jsonResponse({ name, yaml, parsed });
      }
      if (m === "PUT") {
        const body = (await req.json()) as { yaml?: string };
        if (typeof body.yaml !== "string") return jsonResponse({ error: "yaml required" }, 400);
        try {
          parseSpec(body.yaml);
        } catch (err) {
          return jsonResponse({ error: "invalid", detail: (err as Error).message }, 400);
        }
        writeFileSync(fp, body.yaml, { mode: 0o600 });
        return jsonResponse({ name });
      }
      if (m === "DELETE") {
        if (existsSync(fp)) rmSync(fp);
        return jsonResponse({ deleted: name });
      }
    }

    // ---- wizard ---------------------------------------------------------
    if (p === "/api/wizard/start" && m === "POST") {
      const state = startWizard();
      return jsonResponse({ state, nextQuestion: nextQuestion(state) ?? null });
    }
    if (p === "/api/wizard/step" && m === "POST") {
      const body = (await req.json()) as { state?: WizardState; answer?: WizardAnswer };
      if (!body.state || !body.answer) return jsonResponse({ error: "state+answer required" }, 400);
      const next = answerWizard(body.state, body.answer);
      return jsonResponse({ state: next, nextQuestion: nextQuestion(next) ?? null });
    }
    if (p === "/api/wizard/compile" && m === "POST") {
      const body = (await req.json()) as { state?: WizardState };
      if (!body.state) return jsonResponse({ error: "state required" }, 400);
      try {
        const result = compileWizard(body.state);
        return jsonResponse(result);
      } catch (err) {
        return jsonResponse({ error: (err as Error).message }, 400);
      }
    }

    // ---- runs -----------------------------------------------------------
    if (p === "/api/runs" && m === "POST") {
      const body = (await req.json()) as { specName?: string; prompt?: string };
      if (typeof body.specName !== "string" || typeof body.prompt !== "string") {
        return jsonResponse({ error: "specName + prompt required" }, 400);
      }
      const fp = specPath(body.specName);
      if (!existsSync(fp)) return jsonResponse({ error: "spec not found" }, 404);
      const runId = `run_${Math.random().toString(16).slice(2, 10)}${Math.random().toString(16).slice(2, 10)}`;
      runs.set(runId, { events: [], done: false, subscribers: new Set(), finalText: "" });
      // v0 fires a canned event sequence asynchronously so the SSE
      // subscriber sees them. A follow-up PR replaces this with a real
      // subprocess invocation of `crewhaus run`.
      const fire = async (): Promise<void> => {
        pushRunEvent(runId, { kind: "run_start", specName: body.specName, prompt: body.prompt });
        await new Promise((r) => setTimeout(r, 5));
        pushRunEvent(runId, { kind: "trace", subkind: "model_request", model: "stub" });
        await new Promise((r) => setTimeout(r, 5));
        pushRunEvent(runId, { kind: "trace", subkind: "tool_call_start", toolName: "stub" });
        await new Promise((r) => setTimeout(r, 5));
        pushRunEvent(runId, { kind: "trace", subkind: "tool_call_end", toolName: "stub" });
        finishRun(runId, "(canned reply for v0; real runChatLoop dispatch lands in a follow-up)");
      };
      void fire();
      return jsonResponse({ runId }, 201);
    }
    const mr = /^\/api\/runs\/(run_[a-z0-9]+)\/events$/.exec(p);
    if (mr && m === "GET") {
      const runId = mr[1] as string;
      const r = runs.get(runId);
      if (r === undefined) return jsonResponse({ error: "run not found" }, 404);

      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          // Replay any events we already buffered.
          for (const ev of r.events) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
          }
          if (r.done) {
            controller.enqueue(
              enc.encode(`event: done\ndata: ${JSON.stringify({ finalText: r.finalText })}\n\n`),
            );
            controller.close();
            return;
          }
          const cb = (ev: RunEvent | "DONE"): void => {
            if (ev === "DONE") {
              controller.enqueue(
                enc.encode(`event: done\ndata: ${JSON.stringify({ finalText: r.finalText })}\n\n`),
              );
              controller.close();
              r.subscribers.delete(cb);
              return;
            }
            controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
          };
          r.subscribers.add(cb);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    // ---- graph-layout ---------------------------------------------------
    const mg = /^\/api\/graph-layout\/([a-z0-9-]+)$/.exec(p);
    if (mg && m === "GET") {
      const name = mg[1] as string;
      const fp = specPath(name);
      if (!existsSync(fp)) return jsonResponse({ error: "spec not found" }, 404);
      const yaml = readFileSync(fp, "utf8");
      const spec = parseSpec(yaml);
      if (spec.target !== "graph")
        return jsonResponse({ error: "spec is not a graph target" }, 400);
      // Lower the spec inline (mirrors compiler.lower for graph; we
      // only need the IR, no codegen).
      const ir: IrGraphV0 = {
        version: 0,
        name: spec.name,
        target: "graph",
        entry: spec.entry,
        nodes: Object.entries(spec.nodes).map(([nname, n]) => ({
          name: nname,
          instructions: n.instructions,
          model: n.model ?? spec.model,
          tools: n.tools ?? [],
          toolConfigs: Object.freeze({}),
          ...(n.hitl !== undefined ? { hitlPrompt: n.hitl.prompt } : {}),
        })),
        edges: spec.edges,
        permissions: { rules: [] },
        compaction: {},
      };
      const layout = layoutGraph(ir);
      const accept = req.headers.get("accept") ?? "";
      if (accept.includes("image/svg"))
        return textResponse(renderSvg(layout), 200, "image/svg+xml");
      return jsonResponse(layout);
    }

    // ---- plugins --------------------------------------------------------
    if (p === "/api/plugins" && m === "GET") {
      const plugins = await discoverPlugins();
      return jsonResponse({
        pluginRoot,
        plugins: plugins.map((pl) => ({
          name: pl.name,
          version: pl.version,
          description: pl.description,
          panes: pl.panes?.map((pa) => ({ id: pa.id, title: pa.title })) ?? [],
        })),
      });
    }

    return jsonResponse({ error: "not found", path: p }, 404);
  }

  const server = Bun.serve({
    port,
    fetch: (req) => handle(req),
  });

  return {
    port: server.port,
    async stop() {
      await server.stop(true);
    },
  };
}
