/**
 * The compiler worker's exits (#514). The compiler cannot reach this package, so
 * they are scanned here. A worker exit must not carry `intent`, and the controls
 * prove each scan can see a marker. `/loop` and `/validate` answer 200 with
 * `ok: false` on a refused spec, so each asserts `ok: true`: otherwise a rejected
 * `intent` would pass as a clean body.
 */
import { describe, expect, test } from "bun:test";
import { ABSENT_CORPUS } from "@crewhaus/compiler/sentinel";
import worker from "./index";

const env = { ALLOWED_ORIGINS: "https://studio.crewhaus.ai", MAX_BODY_BYTES: "262144" };
const MARKER = "ZZINTENTMARKERZZ";
const INTENT = `intent:
  purpose: purpose ${MARKER}
  serves: [serves ${MARKER}]
  outcomes: [outcome ${MARKER}]
  excludes: [exclude ${MARKER}]
`;

type Target = keyof typeof ABSENT_CORPUS;
const TARGETS = Object.keys(ABSENT_CORPUS) as Target[];
const EDGE_TARGETS: Target[] = ["cli", "workflow", "graph"];

async function post(path: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await worker.fetch(
    new Request(`https://compiler.crewhaus.ai${path}`, {
      method: "POST",
      headers: { origin: "https://studio.crewhaus.ai", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, text: await res.text() };
}

const declared = (target: Target): string => `${ABSENT_CORPUS[target]}${INTENT}`;
const renamed = (target: Target): string =>
  ABSENT_CORPUS[target].replace(/^name: .*$/m, `name: ${MARKER}`);

describe("intent reaches no worker exit", () => {
  for (const target of TARGETS) {
    test(`${target}: POST /compile`, async () => {
      const { status, text } = await post("/compile", { yaml: declared(target) });
      expect(status).toBe(200);
      expect(text).toContain('"bundle"');
      expect(text).not.toContain(MARKER);
    });

    test(`${target}: POST /loop`, async () => {
      const { status, text } = await post("/loop", { yaml: declared(target) });
      expect(status).toBe(200);
      expect((JSON.parse(text) as { ok: boolean }).ok).toBe(true);
      expect(text).not.toContain(MARKER);
    });

    test(`${target}: POST /validate`, async () => {
      const { status, text } = await post("/validate", { yaml: declared(target) });
      expect(status).toBe(200);
      expect((JSON.parse(text) as { ok: boolean }).ok).toBe(true);
      expect(text).not.toContain(MARKER);
    });
  }

  for (const target of EDGE_TARGETS) {
    test(`${target}: POST /compile with emitAs cf-worker`, async () => {
      const { status, text } = await post("/compile", {
        yaml: declared(target),
        emitAs: "cf-worker",
      });
      expect(status).toBe(200);
      expect(text).toContain('"bundle"');
      expect(text).not.toContain(MARKER);
    });
  }
});

describe("the scans can see a marker", () => {
  test("a marker in name: is in the local /compile body", async () => {
    const { status, text } = await post("/compile", { yaml: renamed("cli") });
    expect(status).toBe(200);
    expect(text).toContain(MARKER);
  });

  for (const target of EDGE_TARGETS) {
    test(`${target}: a marker in name: is in the cf-worker /compile body`, async () => {
      const { status, text } = await post("/compile", {
        yaml: renamed(target),
        emitAs: "cf-worker",
      });
      expect(status).toBe(200);
      expect(text).toContain(MARKER);
    });
  }

  test("an unrecognized key named by the marker is in /validate's error", async () => {
    const { status, text } = await post("/validate", {
      yaml: `${ABSENT_CORPUS.cli}${MARKER}: 1\n`,
    });
    expect(status).toBe(200);
    expect((JSON.parse(text) as { ok: boolean }).ok).toBe(false);
    expect(text).toContain(MARKER);
  });

  test("a model name is in /loop's body", async () => {
    const { status, text } = await post("/loop", { yaml: ABSENT_CORPUS.cli });
    expect(status).toBe(200);
    expect(text).toContain("claude-opus-4-7");
  });
});
