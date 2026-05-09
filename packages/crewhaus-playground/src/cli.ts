/**
 * `bun run play:server` entry point. Stands up the playground SPA on
 * `:3001` against a stubbed gateway client (production wires §20
 * gateway-server). Useful for local development and smoke probes.
 */
import type { Tier } from "./quota";
import { type GatewayClient, createPlayground } from "./server";

const stubGateway: GatewayClient = {
  async startRun({ spec, tier }: { spec: string; tier: Tier }) {
    void spec;
    return {
      runId: `stub-${Math.random().toString(36).slice(2, 10)}`,
      status: "queued" as const,
      traceUrl: `/trace/${tier}`,
    };
  },
};

const port = Number(process.env["PORT"] ?? 3001);
const studioUrl = process.env["CREWHAUS_STUDIO_URL"] ?? "http://localhost:4242";

const playground = createPlayground({
  studioUrl,
  gatewayClient: stubGateway,
});

const server = Bun.serve({
  port,
  fetch: (req) => playground.fetch(req),
});
process.stdout.write(`[playground] listening on http://localhost:${server.port}\n`);

const shutdown = (signal: string): void => {
  process.stdout.write(`[playground] received ${signal}, stopping...\n`);
  void server.stop(true);
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
