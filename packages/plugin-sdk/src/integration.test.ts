/**
 * `integration` (#522): what a plugin asks Home for, held to its exact shape
 * where a plugin installs or loads, and signed with the rest of the manifest.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_PLUGIN_IO_SCHEMA_BYTES,
  PLUGIN_INTEGRATION_EVENT_FAMILIES,
  PLUGIN_INTEGRATION_READS,
  PLUGIN_NAME_PATTERN,
  type PluginManifest,
  PluginSdkError,
  manifestPayloadForSigning,
  pluginIntegrationProblem,
  validatePluginManifest,
  validatePluginManifestRecord,
} from "./index";

const base = { name: "notes-pane", version: "1.0.0" };

const valid = {
  protocol: "crewhaus.hangar.v1",
  events: ["run", "decision"],
  data: { reads: ["run.lifecycle", "costs"] },
  io: {
    input: { type: "object", properties: { q: { type: "string" } } },
    output: { type: "object" },
  },
};

function refusal(integration: unknown): string {
  try {
    validatePluginManifest({ ...base, integration });
  } catch (err) {
    expect(err).toBeInstanceOf(PluginSdkError);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

/** A schema nested `depth` objects deep. */
function nested(depth: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: "string" };
  for (let i = 1; i < depth; i += 1) schema = { items: schema };
  return schema;
}

describe("the integration section", () => {
  test("a valid section is accepted as written, and so is an empty one", () => {
    expect(validatePluginManifest({ ...base, integration: valid }).integration).toEqual(
      valid as PluginManifest["integration"],
    );
    expect(validatePluginManifest({ ...base, integration: {} }).integration).toEqual({});
    expect(validatePluginManifest(base).integration).toBeUndefined();
  });

  test("every event family and every read is accepted", () => {
    const integration = {
      events: [...PLUGIN_INTEGRATION_EVENT_FAMILIES],
      data: { reads: [...PLUGIN_INTEGRATION_READS] },
    };
    expect(validatePluginManifest({ ...base, integration }).integration).toEqual(integration);
  });

  test("each refusal names the field", () => {
    const cases: Array<[unknown, string]> = [
      [[], "`integration` must be an object"],
      [null, "`integration` must be an object"],
      [{ extra: 1 }, '`integration` has an unknown key "extra"'],
      [{ protocol: "crewhaus.v1" }, '`integration.protocol` must be "crewhaus.hangar.v1"'],
      [{ events: "run" }, "`integration.events` must be an array"],
      [{ events: ["runs"] }, '`integration.events` entry "runs" is not one of'],
      [{ events: ["run", "run"] }, '`integration.events` lists "run" twice'],
      [{ data: [] }, "`integration.data` must be an object"],
      [{ data: { writes: [] } }, '`integration.data` has an unknown key "writes"'],
      [{ data: { reads: ["secrets"] } }, '`integration.data.reads` entry "secrets" is not one of'],
      [{ data: { reads: ["costs", "costs"] } }, '`integration.data.reads` lists "costs" twice'],
      [{ io: "x" }, "`integration.io` must be an object"],
      [{ io: { schema: {} } }, '`integration.io` has an unknown key "schema"'],
      [{ io: { input: [] } }, "`integration.io.input` must be a JSON Schema object"],
      [{ io: { output: "string" } }, "`integration.io.output` must be a JSON Schema object"],
    ];
    for (const [integration, why] of cases) {
      expect(refusal(integration)).toContain(why);
    }
  });

  test("a schema over 16 KiB of canonical JSON is refused; one at the limit is not", () => {
    const pad = (n: number) => ({ description: "x".repeat(n) });
    // `{"description":"…"}` is 18 bytes of framing.
    const atLimit = pad(MAX_PLUGIN_IO_SCHEMA_BYTES - 18);
    expect(() =>
      validatePluginManifest({ ...base, integration: { io: { input: atLimit } } }),
    ).not.toThrow();
    expect(refusal({ io: { input: pad(MAX_PLUGIN_IO_SCHEMA_BYTES - 17) } })).toContain(
      "`integration.io.input` is larger than 16 KiB",
    );
  });

  test("a schema nested deeper than 32 is refused; one 32 deep is not", () => {
    expect(() =>
      validatePluginManifest({ ...base, integration: { io: { output: nested(32) } } }),
    ).not.toThrow();
    expect(refusal({ io: { output: nested(33) } })).toContain(
      "`integration.io.output` nests deeper than 32",
    );
  });

  test("pluginIntegrationProblem answers the same reason without throwing", () => {
    expect(pluginIntegrationProblem(valid)).toBeUndefined();
    expect(pluginIntegrationProblem({ events: ["runs"] })).toContain(
      '`integration.events` entry "runs" is not one of',
    );
  });

  test("a registry record whose integration is malformed still lists (a 0.8-style reader)", () => {
    const record = { ...base, integration: { events: ["nope"], extra: true } };
    expect(validatePluginManifestRecord(record).name).toBe("notes-pane");
    expect(() => validatePluginManifest(record)).toThrow(PluginSdkError);
  });

  test("the signed payload covers the section", () => {
    const a = manifestPayloadForSigning({ ...base, integration: valid } as PluginManifest);
    const b = manifestPayloadForSigning({
      ...base,
      integration: { ...valid, data: { reads: ["run.lifecycle", "costs", "run.trace"] } },
    } as PluginManifest);
    expect(a).toContain('"integration"');
    expect(a).not.toBe(b);
  });
});

describe("PLUGIN_NAME_PATTERN", () => {
  test("is the grammar the manifest name is held to", () => {
    for (const name of ["abc", "notes-pane", `a${"b".repeat(62)}c`]) {
      expect(PLUGIN_NAME_PATTERN.test(name)).toBe(true);
      expect(() => validatePluginManifestRecord({ ...base, name })).not.toThrow();
    }
    for (const name of ["ab", "Notes", "notes-", "1abc", `a${"b".repeat(63)}c`]) {
      expect(PLUGIN_NAME_PATTERN.test(name)).toBe(false);
      expect(() => validatePluginManifestRecord({ ...base, name })).toThrow(PluginSdkError);
    }
  });
});
