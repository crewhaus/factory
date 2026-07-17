/**
 * Loop contract 0.4 — Batch B verifier smoke test (worker slice): the
 * `GET /schema` handler serves the FULL spec grammar, and the per-target
 * definitions carry the Batch A/B loop keys — `limits` on every agent-loop
 * shape, `evaluation` on the three single-agent shapes it lands on
 * (cli/channel/managed; workflow/graph get judging via `kind: "judge"`
 * steps/nodes instead of a top-level key).
 */
import { describe, expect, test } from "bun:test";
import worker from "./index";

const env = {
  ALLOWED_ORIGINS: "https://studio.crewhaus.ai",
  MAX_BODY_BYTES: "262144",
};

function request(path: string): Request {
  return new Request(`https://compiler.crewhaus.ai${path}`, {
    headers: { origin: "https://studio.crewhaus.ai" },
  });
}

type TargetDefinition = { properties?: Record<string, unknown> };
type SchemaBody = {
  version: string;
  schema: { $ref: string; definitions: Record<string, TargetDefinition> };
};

describe("Batch B smoke — GET /schema exposes evaluation + limits", () => {
  test("per-target properties include the new loop keys", async () => {
    const res = await worker.fetch(request("/schema"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SchemaBody;
    expect(body.schema.$ref).toBe("#/definitions/CrewhausSpec");

    for (const target of ["cli", "channel", "managed"]) {
      const props = Object.keys(body.schema.definitions[target]?.properties ?? {});
      expect(props).toContain("evaluation");
      expect(props).toContain("limits");
    }
    // Orchestration shapes: limits yes; judging rides steps/nodes, not a
    // top-level evaluation key.
    for (const target of ["workflow", "graph"]) {
      const props = Object.keys(body.schema.definitions[target]?.properties ?? {});
      expect(props).toContain("limits");
      expect(props).not.toContain("evaluation");
    }
  });
});
