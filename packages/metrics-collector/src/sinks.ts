/**
 * Sinks for the metrics-collector. Each sink owns its own flush/shutdown
 * semantics so the runtime-core orchestrator can call them uniformly in its
 * `finally` block.
 *
 * The stdout-JSON sink intentionally **buffers** everything until `flush()`
 * is called — emitting metrics mid-run would interleave with the model's
 * assistant text on the same fd. Callers may instead pick the textfile or
 * HTTP sink for live observation.
 */
import { writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { Registry } from "./registry";

export type Sink = {
  /** Called by the orchestrator on `runChatLoop` exit. */
  flush(): Promise<void>;
  /** Optional permanent teardown (HTTP listener close, etc). */
  shutdown(): Promise<void>;
};

export function stdoutJson(
  registry: Registry,
  opts: { write?: (chunk: string) => void } = {},
): Sink {
  const writer = opts.write ?? ((chunk: string) => process.stdout.write(chunk));
  let written = false;
  return {
    async flush() {
      if (written) return;
      written = true;
      const snapshot = registry.jsonSnapshot();
      writer(`${JSON.stringify(snapshot, null, 2)}\n`);
    },
    async shutdown() {
      // No-op; flush is the entire lifecycle.
    },
  };
}

export function prometheusTextfile(registry: Registry, path: string): Sink {
  return {
    async flush() {
      await writeFile(path, registry.prometheus(), "utf8");
    },
    async shutdown() {
      // No-op.
    },
  };
}

export type HttpSink = Sink & { readonly port: number; readonly host: string };

/**
 * Loopback by default. The `/metrics` endpoint is **unauthenticated** — anyone
 * who can reach the socket can scrape it — so we bind `127.0.0.1` unless the
 * caller explicitly opts in to a wider interface. Exposing it externally
 * (`0.0.0.0`) is supported but should sit behind the platform's private
 * network / scrape proxy, never on a publicly routable interface.
 */
export const DEFAULT_HTTP_HOST = "127.0.0.1";

/** Minimal request surface the scrape handler reads. */
export type MetricsRequest = { url?: string | undefined };
/**
 * Minimal response surface the scrape handler writes. Structurally compatible
 * with Node's `ServerResponse` (whose `setHeader`/`end` also accept these
 * args) while staying decoupled from its chainable return types so tests can
 * pass lightweight stand-ins.
 */
export type MetricsResponse = {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(chunk?: string): unknown;
};

/**
 * Pull-based scrape handler for the `/metrics` HTTP sink. Extracted from the
 * `createServer` callback so each routing branch (missing URL → 404,
 * `/metrics` → 200 exposition, anything else → 404) is unit-testable without
 * standing up a real socket.
 */
export function handleMetricsRequest(
  registry: Registry,
  req: MetricsRequest,
  res: MetricsResponse,
): void {
  if (!req.url) {
    res.statusCode = 404;
    res.end();
    return;
  }
  if (req.url === "/metrics") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; version=0.0.4");
    res.end(registry.prometheus());
    return;
  }
  res.statusCode = 404;
  res.end();
}

export async function httpServer(
  registry: Registry,
  port: number,
  host: string = DEFAULT_HTTP_HOST,
): Promise<HttpSink> {
  const http = await import("node:http");
  let server: Server | undefined;
  await new Promise<void>((resolve, reject) => {
    server = http.createServer((req, res) => {
      handleMetricsRequest(registry, req, res);
    });
    server.once("error", reject);
    // Bind to `host` (loopback unless an explicit interface was requested) so
    // the unauthenticated endpoint is not reachable off-box by default.
    server.listen(port, host, () => {
      resolve();
    });
  });
  if (!server) throw new Error("metrics http server failed to start");
  const addr = server.address() as { port: number; address: string } | null;
  const boundPort = (addr?.port ?? port) as number;
  const boundHost = addr?.address ?? host;
  return {
    port: boundPort,
    host: boundHost,
    async flush() {
      // HTTP sink has no flush — it's pull-based.
    },
    async shutdown() {
      await new Promise<void>((resolve) => {
        server?.close(() => resolve());
      });
    },
  };
}
