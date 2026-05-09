import { describe, expect, test } from "bun:test";

import { type GatewayClient, createPlayground } from "./server";

const FAKE_GATEWAY: GatewayClient = {
  async startRun({ spec, tier }) {
    void spec;
    return {
      runId: `run-${tier}-${Math.random().toString(36).slice(2, 6)}`,
      status: "queued" as const,
      traceUrl: `/trace/${tier}`,
    };
  },
};

function withSession(sessionId: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers ?? {});
  headers.set("Cookie", `sid=${sessionId}`);
  return { ...init, headers };
}

describe("createPlayground — endpoints (T3)", () => {
  test("GET / returns the SPA shell with a Set-Cookie sid", async () => {
    const playground = createPlayground({
      studioUrl: "http://localhost:4242",
      gatewayClient: FAKE_GATEWAY,
    });
    const r = await playground.fetch(new Request("http://localhost/"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("set-cookie")).toMatch(/^sid=[a-f0-9]+/);
    const body = await r.text();
    expect(body).toContain("CrewHaus Playground");
    expect(body).toContain("__CREWHAUS_PLAYGROUND__");
  });

  test("GET /api/templates returns the template list", async () => {
    const playground = createPlayground({
      studioUrl: "http://localhost:4242",
      gatewayClient: FAKE_GATEWAY,
    });
    const r = await playground.fetch(new Request("http://localhost/api/templates"));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { templates: ReadonlyArray<{ id: string }> };
    expect(body.templates.length).toBeGreaterThan(0);
    expect(body.templates.some((t) => t.id === "cli-coding-agent")).toBe(true);
  });

  test("POST /api/run starts a run + persists it scoped to the session", async () => {
    const playground = createPlayground({
      studioUrl: "http://localhost:4242",
      gatewayClient: FAKE_GATEWAY,
    });
    const r = await playground.fetch(
      new Request(
        "http://localhost/api/run",
        withSession("test-session-1234567", {
          method: "POST",
          body: JSON.stringify({
            spec: "name: x\ntarget: cli\nagent:\n  model: m\n  instructions: i\n",
          }),
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { scopedRunId: string; status: string };
    expect(body.scopedRunId.startsWith("test-session-1234567:")).toBe(true);
    expect(body.status).toBe("queued");
  });

  test("POST /api/run with empty spec → 400", async () => {
    const playground = createPlayground({
      studioUrl: "http://localhost:4242",
      gatewayClient: FAKE_GATEWAY,
    });
    const r = await playground.fetch(
      new Request("http://localhost/api/run", {
        method: "POST",
        body: JSON.stringify({ spec: "" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(r.status).toBe(400);
  });

  test("anonymous tier hits 429 after the cap", async () => {
    const now = 1000;
    const playground = createPlayground({
      studioUrl: "http://localhost:4242",
      gatewayClient: FAKE_GATEWAY,
      now: () => now,
    });
    const sessionId = "quota-test-12345678";
    const post = () =>
      playground.fetch(
        new Request(
          "http://localhost/api/run",
          withSession(sessionId, {
            method: "POST",
            body: JSON.stringify({
              spec: "name: x\ntarget: cli\nagent:\n  model: m\n  instructions: i\n",
            }),
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
    // Anonymous cap is 5; sixth call rejects.
    for (let i = 0; i < 5; i++) {
      const r = await post();
      expect(r.status).toBe(200);
    }
    const r6 = await post();
    expect(r6.status).toBe(429);
    expect(r6.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  test("GET /api/runs/:scopedId 404 across tenants (T8)", async () => {
    const playground = createPlayground({
      studioUrl: "http://localhost:4242",
      gatewayClient: FAKE_GATEWAY,
    });
    // session-a posts a run
    const start = await playground.fetch(
      new Request(
        "http://localhost/api/run",
        withSession("session-a-1234567", {
          method: "POST",
          body: JSON.stringify({
            spec: "name: x\ntarget: cli\nagent:\n  model: m\n  instructions: i\n",
          }),
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const { scopedRunId } = (await start.json()) as { scopedRunId: string };
    // session-a can read it
    const ok = await playground.fetch(
      new Request(`http://localhost/api/runs/${scopedRunId}`, withSession("session-a-1234567")),
    );
    expect(ok.status).toBe(200);
    // session-b cannot
    const denied = await playground.fetch(
      new Request(`http://localhost/api/runs/${scopedRunId}`, withSession("session-b-1234567")),
    );
    expect(denied.status).toBe(404);
  });

  test("POST /api/run with invalid JSON → 400", async () => {
    const playground = createPlayground({
      studioUrl: "http://localhost:4242",
      gatewayClient: FAKE_GATEWAY,
    });
    const r = await playground.fetch(
      new Request("http://localhost/api/run", {
        method: "POST",
        body: "not json{",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(r.status).toBe(400);
  });

  test("unknown route → 404", async () => {
    const playground = createPlayground({
      studioUrl: "http://localhost:4242",
      gatewayClient: FAKE_GATEWAY,
    });
    const r = await playground.fetch(new Request("http://localhost/api/whatever"));
    expect(r.status).toBe(404);
  });

  test("quotaFor() reflects accepted runs", async () => {
    const playground = createPlayground({
      studioUrl: "http://localhost:4242",
      gatewayClient: FAKE_GATEWAY,
    });
    const scope = { sessionId: "quotacheck-1234567" };
    expect(playground.quotaFor(scope).runs.length).toBe(0);
    await playground.fetch(
      new Request(
        "http://localhost/api/run",
        withSession(scope.sessionId, {
          method: "POST",
          body: JSON.stringify({
            spec: "name: x\ntarget: cli\nagent:\n  model: m\n  instructions: i\n",
          }),
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    expect(playground.quotaFor(scope).runs.length).toBe(1);
  });
});
