/**
 * `specs.schema` through the API: the schema the structured editor renders for one
 * harness and its effective configuration, the same body the per-harness route answers,
 * carrying every field the editor reads, masked at the router's exit, refused for a
 * harness the caller cannot see as every harness read is, and 409 for a folder that is
 * gone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMAS } from "@crewhaus/control-contract/schemas";
import { type V1Home, v1Home } from "../__test__/v1-home";

type Schema = { safeParse(value: unknown): { success: boolean; error?: unknown } };
const schemaOf = (id: string) => (SCHEMAS as unknown as Readonly<Record<string, Schema>>)[id];

/** Built from parts: a value shaped like a credential that is not one. */
const PLANTED = ["thz", "live", "q".repeat(28)].join("_");

const SPEC = [
  "name: creation",
  "target: cli",
  "agent:",
  "  model: claude-opus-5",
  "  instructions: |",
  "    You help.",
  "  max_tokens: 2048",
  "thredz:",
  `  api_key: ${PLANTED}`,
  "",
].join("\n");

let home: V1Home;
let a: { id: string; dir: string };

beforeAll(async () => {
  home = await v1Home();
  a = await home.harness("creation", { noSpec: true });
  writeFileSync(join(a.dir, "crewhaus.yaml"), SPEC);
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

const schemaPath = (id: string) => `/api/v1/harnesses/${id}/spec/schema`;

describe("specs.schema", () => {
  test("answers 200 with its row's shape, the same body the per-harness route answers", async () => {
    const res = await home.call("GET", schemaPath(a.id));
    expect(res.status).toBe(200);
    expect(schemaOf("specSchemaView")?.safeParse(res.body).success).toBe(true);
    expect(res.body["harness"]).toBe(a.id);
    const legacy = await home.t.api(`/api/h/${a.id}/spec/schema`);
    expect(legacy.status).toBe(200);
    for (const field of ["schema", "effective", "rev", "readOnly", "issues", "schemaSource"]) {
      expect(`${field} ${JSON.stringify(res.body[field])}`).toBe(
        `${field} ${JSON.stringify(legacy.body[field])}`,
      );
    }
  });

  test("carries every field the editor reads", async () => {
    const { body } = await home.call("GET", schemaPath(a.id));
    for (const field of [
      "present",
      "schema",
      "effective",
      "effectiveTruncated",
      "rev",
      "readOnly",
      "issues",
      "schemaSource",
      "schemaNote",
    ]) {
      expect(`${field} ${field in body}`).toBe(`${field} true`);
    }
    expect(body["present"]).toBe(true);
    expect(body["effectiveTruncated"]).toBe(false);
    expect(String(body["rev"])).toStartWith("sha256:");
    const rows = body["effective"] as Array<{ path: string; segments: string[]; source: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.segments.join(".")).toBe(row.path);
    expect(rows.find((r) => r.path === "agent.max_tokens")?.source).toBe("declared");
    expect(String(body["schemaNote"])).toContain(`crewhaus harness adopt ${a.id}`);
  });

  test("a credential comes back redacted, in the values and in the schema", async () => {
    const { body } = await home.call("GET", schemaPath(a.id));
    expect(JSON.stringify(body)).not.toContain(PLANTED);
    const rows = body["effective"] as Array<{ path: string; value: unknown }>;
    expect(rows.find((r) => r.path === "thredz.api_key")?.value).toBe("[redacted]");
    // The schema's own property named like a credential is masked by its name, as on every route.
    expect(JSON.stringify(body["schema"])).toContain('"api_key":{"type":"[redacted]"');
  });

  test("a harness the caller cannot see is refused as every harness read refuses it", async () => {
    const b = await home.harness("unseen");
    const svc = await home.service("reader", [a.id]);
    const seen = await home.call("GET", schemaPath(a.id), { secret: svc.secret });
    expect(seen.status).toBe(200);
    const read = await home.call("GET", `/api/v1/harnesses/${b.id}`, { secret: svc.secret });
    const schema = await home.call("GET", schemaPath(b.id), { secret: svc.secret });
    expect(read.status).toBeGreaterThanOrEqual(400);
    expect(schema.status).toBe(read.status);
    const codeOf = (r: { body: Record<string, unknown> }) =>
      (r.body["error"] as Record<string, unknown> | undefined)?.["code"];
    expect(codeOf(schema)).toBe(codeOf(read));
  });

  test("a harness whose folder is gone answers 409 harness_missing", async () => {
    const gone = await home.harness("gone");
    rmSync(gone.dir, { recursive: true, force: true });
    const res = await home.call("GET", schemaPath(gone.id));
    expect(res.status).toBe(409);
    expect((res.body["error"] as Record<string, unknown>)["reason"]).toBe("harness_missing");
  });
});
