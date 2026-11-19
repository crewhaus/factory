/**
 * The attention module: its ids round-trip through the core's grammar and ref parser, its
 * field names survive Home's masker, its vocabularies are closed and consistent, and its
 * rows read with a home permission and a real twin.
 */
import { describe, expect, test } from "bun:test";
import { isCredentialKey } from "@crewhaus/spec-patch";
import type { z } from "zod";
import { walkFieldNames } from "./__test__/checkers.js";
import {
  ATTENTION_BANDS,
  ATTENTION_ID_RE,
  ATTENTION_KINDS,
  ATTENTION_KIND_ROWS,
  ATTENTION_MODULE,
  CAUSE_KINDS,
  CROSS_HARNESS_CAUSES,
  MACHINES,
  OPERATIONS,
  TITLE_TEMPLATES,
  attIdFromDigest,
  attentionBandOf,
  attentionKey,
  attentionRef,
  canTransition,
  isId,
  parseRef,
  renderTwin,
} from "./index.js";
import { ATTENTION_SCHEMAS } from "./schemas/attention.js";

const digest = (seed: number) => new Uint8Array(32).map((_, i) => (i * 31 + seed) % 256);

describe("ids", () => {
  test("a digest's id is an att_ id, and its ref parses as a home attention ref", () => {
    for (let seed = 0; seed < 64; seed++) {
      const id = attIdFromDigest(digest(seed));
      expect(isId("att", id)).toBe(true);
      expect(ATTENTION_ID_RE.test(id)).toBe(true);
      const parsed = parseRef(attentionRef(id));
      expect(parsed).toEqual({ scope: "home", kind: "attention", id } as never);
    }
  });

  test("the key is versioned and names its scope, kind and key in order", () => {
    expect(attentionKey("hrn_0123456789abcdef", "permission", "appr:appr_0123456789abcdef")).toBe(
      "v1|hrn_0123456789abcdef|permission|appr:appr_0123456789abcdef",
    );
    expect(attentionKey("home", "credential", "credential:anthropic:X@0011")).toBe(
      "v1|home|credential|credential:anthropic:X@0011",
    );
  });

  test("a digest too short for 26 characters is refused", () => {
    expect(() => attIdFromDigest(new Uint8Array(16))).toThrow(RangeError);
  });
});

describe("vocabularies", () => {
  test("every kind has one band, and every band has a kind", () => {
    expect(new Set(ATTENTION_KINDS).size).toBe(ATTENTION_KIND_ROWS.length);
    for (const row of ATTENTION_KIND_ROWS) expect(attentionBandOf(row.kind)).toBe(row.band);
    for (const band of ATTENTION_BANDS) {
      expect(ATTENTION_KIND_ROWS.some((row) => row.band === band)).toBe(true);
    }
    expect(attentionBandOf("constructor")).toBeUndefined();
    expect(attentionBandOf("nothing")).toBeUndefined();
  });

  test("the cross-harness causes are causes, and the templates are unique", () => {
    for (const kind of CROSS_HARNESS_CAUSES) expect(CAUSE_KINDS).toContain(kind);
    expect(new Set(TITLE_TEMPLATES).size).toBe(TITLE_TEMPLATES.length);
  });

  test("no kind, band or cause word is a key the masker hides", () => {
    // These words travel as values (`kind: "credential"`), never as keys; this pins why.
    expect(isCredentialKey("credential")).toBe(true);
    for (const row of ATTENTION_KIND_ROWS) expect(row).toEqual({ kind: row.kind, band: row.band });
  });
});

describe("field names survive the masker", () => {
  test("every field of every attention schema, the cause and the item included", () => {
    const hits: string[] = [];
    const seen = new Set<string>();
    for (const [id, schema] of Object.entries(ATTENTION_SCHEMAS)) {
      walkFieldNames(schema as z.ZodTypeAny, (name, path) => {
        seen.add(name);
        if (isCredentialKey(name)) hits.push(`${id}.${path}`);
      });
    }
    expect(hits).toEqual([]);
    // The walk reached the fields a masked name would hide.
    for (const name of ["cause", "id", "evidenceRev", "decidedVia", "unreachable", "body"]) {
      expect(seen.has(name)).toBe(true);
    }
    expect(isCredentialKey("key")).toBe(true);
  });
});

describe("the module", () => {
  test("three reads, each on a home permission with its own twin", () => {
    const rows = OPERATIONS.filter((op) => op.id.startsWith("attention."));
    expect(rows.map((op) => op.id).sort()).toEqual([
      "attention.get",
      "attention.list",
      "attention.metrics",
    ]);
    for (const row of rows) {
      expect(row.permission).toBe("home.read");
      expect(row.receipt).toBe("none");
      expect(row.method).toBe("GET");
      expect(row.cliTwin?.argv[0]).toBe("inbox");
    }
    const show = ATTENTION_MODULE.operations.find((op) => op.id === "attention.get");
    const id = attIdFromDigest(digest(3));
    expect(renderTwin(show?.cliTwin as never, { att: id })).toEqual({
      argv: ["inbox", "show", id],
    });
    expect(renderTwin(show?.cliTwin as never, { att: "appr_0123456789abcdef" })).toEqual({
      invalid: ["att"],
    });
  });

  test("the lifecycle: open first, three ends, and no way back from one", () => {
    expect(MACHINES.attention.entry).toEqual(["open"]);
    expect(MACHINES.attention.terminal).toEqual(["resolved", "expired", "superseded"]);
    expect(canTransition("attention", "open", "resolved")).toBe(true);
    expect(canTransition("attention", "deferred", "open")).toBe(true);
    expect(canTransition("attention", "resolved", "open")).toBe(false);
    expect(canTransition("attention", "superseded", "open")).toBe(false);
  });
});
