import { describe, expect, test } from "bun:test";
import { isCredentialKey } from "@crewhaus/spec-patch";
import { z } from "zod";
import { walkFieldNames } from "./__test__/checkers.js";
import { CAPABILITY_NAMES, CURSOR_SOURCES, OPERATIONS } from "./index.js";
import { SCHEMAS } from "./schemas/index.js";

/**
 * Hangar masks every response by key name, so a contract field named like a
 * credential would come back masked. A hit fails unless the contract marks that
 * field secret. Nothing is exempt, and this list stays empty.
 */
const EXCEPTIONS: readonly string[] = [];

/** Every column an operation row can carry, whether or not a row uses it yet. */
const ROW_COLUMNS = [
  "id",
  "method",
  "path",
  "permission",
  "receipt",
  "request",
  "response",
  "cliTwin",
  "qualifiers",
  "noReceiptReason",
  "idempotency",
  "stream",
  "secretFields",
  "noTwinReason",
  "modelBound",
];

function hitsIn(schemas: Readonly<Record<string, z.ZodTypeAny>>, secret: ReadonlySet<string>) {
  const hits: string[] = [];
  let fields = 0;
  for (const [id, schema] of Object.entries(schemas)) {
    walkFieldNames(schema, (name, path) => {
      fields++;
      if (isCredentialKey(name) && !secret.has(name) && !EXCEPTIONS.includes(name)) {
        hits.push(`${id}.${path}`);
      }
    });
  }
  return { hits, fields };
}

const SECRET_FIELDS = new Set(OPERATIONS.flatMap((op) => op.secretFields ?? []));

describe("field names survive the masker", () => {
  test("every schema field is safe, or marked secret", () => {
    const { hits, fields } = hitsIn(SCHEMAS, SECRET_FIELDS);
    expect(hits).toEqual([]);
    expect(Object.keys(SCHEMAS).length).toBeGreaterThanOrEqual(93);
    expect(fields).toBeGreaterThan(900);
    expect(EXCEPTIONS).toEqual([]);
  });

  test("operation ids, capabilities, limits, cursor sources and row columns", () => {
    const limits = (SCHEMAS["discovery"] as z.ZodObject<z.ZodRawShape>).shape["limits"];
    const limitNames: string[] = [];
    walkFieldNames(limits as z.ZodTypeAny, (name) => limitNames.push(name));
    const names = [
      ...OPERATIONS.map((op) => op.id),
      ...CAPABILITY_NAMES,
      ...limitNames,
      ...CURSOR_SOURCES,
      ...ROW_COLUMNS,
      ...OPERATIONS.flatMap((op) => Object.keys(op)),
    ];
    expect(limitNames).toHaveLength(3);
    expect(names.length).toBeGreaterThanOrEqual(59 + 8 + 3 + 8 + 15);
    expect(names.filter(isCredentialKey)).toEqual([]);
  });

  test("the run fields and params added for the control API's runs survive the masker", () => {
    for (const name of [
      "sensitivity",
      "hidden",
      "idempotency",
      "runId",
      "inputFile",
      "apiRun",
      "stdinFile",
    ]) {
      expect(`${name} ${isCredentialKey(name)}`).toBe(`${name} false`);
    }
    // The name idempotency must never travel under: the masker eats it.
    expect(isCredentialKey("idempotencyKey")).toBe(true);
  });

  test("the names the masker would eat are not in use", () => {
    const seen = new Set<string>();
    for (const schema of Object.values(SCHEMAS)) walkFieldNames(schema, (name) => seen.add(name));
    for (const name of ["auth", "publicKey", "token", "env", "headers", "key"]) {
      expect(seen.has(name)).toBe(false);
    }
    expect(seen.has("signIn")).toBe(true);
    expect(seen.has("deviceJwk")).toBe(true);
  });
});

describe("the walk sees a planted defect", () => {
  test("a credential-shaped field is reported, at any depth", () => {
    const planted = {
      flat: z.object({ resumeKey: z.string() }),
      deep: z.object({ a: z.array(z.object({ b: z.record(z.object({ apiToken: z.string() })) })) }),
    };
    const { hits } = hitsIn(planted, new Set());
    expect(hits).toEqual(["flat.resumeKey", "deep.a[].b{}.apiToken"]);
  });

  test("a field the contract marks secret passes", () => {
    const planted = { flat: z.object({ resumeKey: z.string() }) };
    expect(hitsIn(planted, new Set(["resumeKey"])).hits).toEqual([]);
  });

  test("an unknown wrapper throws instead of hiding its fields", () => {
    const planted = { odd: z.object({ fine: z.promise(z.object({ apiToken: z.string() })) }) };
    expect(() => hitsIn(planted, new Set())).toThrow('unhandled zod type at "fine": ZodPromise');
  });
});
