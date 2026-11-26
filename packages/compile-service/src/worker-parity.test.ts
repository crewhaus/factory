/**
 * The hosted compiler's `POST /validate` and `checkSpec` answer the same
 * issues for the same spec: the Worker reflects `parseSpecIssues`, which is
 * where `checkSpec` takes its list from.
 */
import { describe, expect, test } from "bun:test";
import worker from "@crewhaus/compiler-worker";
import { ABSENT_CORPUS } from "../../compiler/src/absent-corpus";
import { checkSpec } from "./check-spec";

const ENV = { ALLOWED_ORIGINS: "https://studio.crewhaus.ai", MAX_BODY_BYTES: "262144" };

/** The Worker's message redaction, as it reflects an issue (its own copy is private). */
function redacted(message: string): string {
  return message
    .replace(/sk-ant-[A-Za-z0-9_\-]{20,}/g, "sk-ant-REDACTED")
    .replace(/sk-[A-Za-z0-9_\-]{20,}/g, "sk-REDACTED")
    .replace(/ghp_[A-Za-z0-9]{20,}/g, "ghp_REDACTED")
    .replace(/gho_[A-Za-z0-9]{20,}/g, "gho_REDACTED");
}

type Row = { path: unknown; code: unknown; message: unknown };
const rows = (issues: ReadonlyArray<Row>) =>
  issues.map((i) => ({ path: i.path, code: i.code, message: redacted(String(i.message)) }));

async function validate(yaml: string): Promise<ReadonlyArray<Row>> {
  const res = await worker.fetch(
    new Request("https://compiler.crewhaus.ai/validate", {
      method: "POST",
      headers: { origin: "https://studio.crewhaus.ai", "content-type": "application/json" },
      body: JSON.stringify({ yaml }),
    }),
    ENV,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; issues?: Row[] };
  return body.issues ?? [];
}

const FAILING = [
  "name: t\ntarget: cli\nagent:\n  model: 5\n",
  "name: t\ntarget: cli\nagent:\n  model: claude-opus-4-7\n  instructions: hi\nfuture_block: {}\n",
  [
    "name: t",
    "target: cli",
    "agent:",
    "  model: claude-opus-4-7",
    "  instructions: hi",
    "models:",
    "  a: { model: cheapest, price: { input_per_1m: 1, output_per_1m: 2 } }",
    "  b: { model: strongest, price: { input_per_1m: 1, output_per_1m: 2 } }",
    "",
  ].join("\n"),
];

describe("POST /validate and checkSpec", () => {
  test("answer the same issues over the corpus and three failing specs", async () => {
    let compared = 0;
    let failing = 0;
    for (const yaml of [...Object.values(ABSENT_CORPUS), ...FAILING]) {
      const hosted = rows(await validate(yaml));
      const local = rows(checkSpec(yaml).issues);
      expect(hosted).toEqual(local);
      if (local.length > 0) failing += 1;
      compared += 1;
    }
    expect(compared).toBe(17);
    expect(failing).toBe(3);
  });
});
