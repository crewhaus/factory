/**
 * `fakeThredz`: the Thredz REST API on loopback, attached through a harness's
 * `thredz.base_url` set to `${fake.url}/api`. It answers what a test registers
 * and 404s anything else the way the real API does.
 */
import { maskBody, parseBody } from "./record";
import { type FakeService, jsonResponse, serveLoopback } from "./serve";

export type FakeThredzCall = {
  readonly method: string;
  /** The path with the `/api` prefix removed. */
  readonly path: string;
  readonly search: string;
  /** Whether each auth header was there. A recording never holds its value. */
  readonly authorization: "present" | "absent";
  readonly apiKeyHeader: "present" | "absent";
  readonly idempotencyKey: string | null;
  readonly body: unknown;
};

export type FakeThredzReply = { readonly status: number; readonly body: unknown };
export type FakeThredzRoute = FakeThredzReply | ((call: FakeThredzCall) => FakeThredzReply);

export type FakeThredzOptions = {
  /** `"GET /wiki/stats"` → reply. These sit on top of the status defaults. */
  readonly routes?: Readonly<Record<string, FakeThredzRoute>>;
};

export type FakeThredz = FakeService & {
  /** `${url}/api`, the value for a harness's `thredz.base_url`. */
  readonly baseUrl: string;
  route(key: string, reply: FakeThredzRoute): void;
  calls(): readonly FakeThredzCall[];
};

/** What the console's status probe asks for on every Thredz screen. */
const STATUS_DEFAULTS: Readonly<Record<string, FakeThredzReply>> = {
  "GET /wiki/stats": { status: 200, body: { articles: 0 } },
  "GET /keys": { status: 403, body: { message: "Admin permission required" } },
  "GET /listeners/usage": { status: 200, body: { used: 0, limit: 3, locked: false } },
};

const presence = (value: string | null): "present" | "absent" =>
  value === null ? "absent" : "present";

/** Start a fake Thredz. */
export function fakeThredz(opts: FakeThredzOptions = {}): FakeThredz {
  const routes = new Map<string, FakeThredzRoute>([
    ...Object.entries(STATUS_DEFAULTS),
    ...Object.entries(opts.routes ?? {}),
  ]);
  const calls: FakeThredzCall[] = [];
  const notFound = (): Response => jsonResponse(404, { message: "Not found" });

  const server = serveLoopback(async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return notFound();
    const text = await req.text();
    const call: FakeThredzCall = {
      method: req.method,
      path: url.pathname.slice("/api".length),
      search: url.search,
      authorization: presence(req.headers.get("authorization")),
      apiKeyHeader: presence(req.headers.get("x-api-key")),
      idempotencyKey: req.headers.get("idempotency-key"),
      body: maskBody(parseBody(req.headers.get("content-type"), text)),
    };
    calls.push(call);
    const handler = routes.get(`${req.method} ${call.path}`);
    if (handler === undefined) return notFound();
    const reply = typeof handler === "function" ? handler(call) : handler;
    return jsonResponse(reply.status, reply.body);
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port as number,
    baseUrl: `http://127.0.0.1:${server.port}/api`,
    route: (key, reply) => {
      routes.set(key, reply);
    },
    calls: () => [...calls],
    stop: async () => {
      await server.stop();
    },
  };
}
