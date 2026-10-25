/**
 * 0.8.0 (design/0.8.0-provability-release.md §5.4) — the run-result path
 * carries a run's proof bundle to the client untouched.
 *
 * The daemon's handler (target-managed's emitted `runs.create` /
 * `runs.continue`) returns `{ runId, sessionId, tenantId, reply, proof? }`;
 * the server wraps whatever the handler returns in the success envelope. This
 * pins that the bundle survives both the in-process `handle` and the HTTP
 * listener's JSON round trip byte for byte, that the result validates against
 * the protocol's `RunsCreateResult` / `RunsContinueResult`, and that a result
 * without one gains no `proof` key on the way.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunsContinueResult, RunsCreateResult } from "@crewhaus/gateway-protocol";
import { buildTenant } from "@crewhaus/tenancy";
import { createGatewayServer, signJwt } from "./index";

const SECRET = "proof-result-secret-0000";

/** A bundle as the provability gate writes one (shape only; values are fixed). */
const PROOF = {
  version: 1,
  level: "grounded",
  verdict: "pass",
  score: 1,
  threshold: 1,
  achieved: "grounded",
  claims: [
    {
      index: 0,
      text: "Refunds are accepted within 14 days of purchase.",
      line: 1,
      status: "met",
      best: "grounded",
      bindings: [
        {
          ref: "[1]",
          kind: "source",
          rung: "grounded",
          ok: true,
          origin: "https://acme.example/policy",
          sha256: `sha256:${"a".repeat(64)}`,
          excerpt: "Refunds are accepted within 14 days of purchase",
        },
      ],
    },
  ],
  claimCount: 1,
  met: 1,
  unmet: 0,
  assumptions: 0,
  sources: 1,
  judgeWaived: 0,
  retryIndex: 0,
  createdAt: "2026-10-22T12:00:00.000Z",
  bundleHash: `sha256:${"b".repeat(64)}`,
} as const;

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gateway-proof-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function serverWith(withProof: boolean) {
  const tenant = buildTenant("tenant-a", { tenantsRoot: tmp });
  return createGatewayServer({
    jwtSecret: SECRET,
    tenantsRoot: tmp,
    tenantOverrides: { "tenant-a": tenant },
    handler: async ({ method, tenant: t }) => ({
      runId: "run_abc12345",
      sessionId: "sess_0123456789abcdef",
      tenantId: t.id,
      reply: `answered ${method}`,
      ...(withProof ? { proof: PROOF } : {}),
    }),
  });
}

const body = (method: "runs.create" | "runs.continue") => ({
  protocol: "crewhaus.v1",
  id: "1",
  method,
  params:
    method === "runs.create"
      ? { spec: "s", input: "refunds?" }
      : { sessionId: "sess_0123456789abcdef", input: "refunds?" },
});

describe("gateway-server — the proof bundle on the run result (0.8.0 §5.4)", () => {
  test("handle(): runs.create and runs.continue carry proof verbatim and validate", async () => {
    const server = serverWith(true);
    const bearer = signJwt({ tenant_id: "tenant-a" }, SECRET);
    for (const [method, schema] of [
      ["runs.create", RunsCreateResult],
      ["runs.continue", RunsContinueResult],
    ] as const) {
      const res = (await server.handle({ bearer, body: body(method) })) as { result?: unknown };
      const parsed = schema.parse(res.result);
      expect(parsed.proof).toEqual(PROOF);
      expect(parsed.reply).toBe(`answered ${method}`);
    }
  });

  test("over HTTP: the JSON round trip keeps the bundle byte for byte", async () => {
    const server = serverWith(true);
    const handle = await server.listen(0, "127.0.0.1");
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${signJwt({ tenant_id: "tenant-a" }, SECRET)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body("runs.create")),
      });
      expect(res.status).toBe(200);
      const envelope = (await res.json()) as { result: Record<string, unknown> };
      expect(JSON.stringify(envelope.result["proof"])).toBe(JSON.stringify(PROOF));
      expect(RunsCreateResult.parse(envelope.result).proof?.bundleHash).toBe(PROOF.bundleHash);
    } finally {
      await handle.close();
    }
  });

  test("a result without a bundle gains no proof key", async () => {
    const server = serverWith(false);
    const res = (await server.handle({
      bearer: signJwt({ tenant_id: "tenant-a" }, SECRET),
      body: body("runs.create"),
    })) as { result: Record<string, unknown> };
    expect("proof" in res.result).toBe(false);
    expect(RunsCreateResult.parse(res.result).proof).toBeUndefined();
  });
});
