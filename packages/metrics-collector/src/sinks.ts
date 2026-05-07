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

export type HttpSink = Sink & { readonly port: number };

export async function httpServer(registry: Registry, port: number): Promise<HttpSink> {
  const http = await import("node:http");
  let server: Server | undefined;
  await new Promise<void>((resolve, reject) => {
    server = http.createServer((req, res) => {
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
    });
    server.once("error", reject);
    server.listen(port, () => {
      resolve();
    });
  });
  if (!server) throw new Error("metrics http server failed to start");
  const boundPort = ((server.address() as { port: number } | null)?.port ?? port) as number;
  return {
    port: boundPort,
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
