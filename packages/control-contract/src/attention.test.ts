/**
 * The attention module: its ids round-trip through the core's grammar and ref parser, its
 * field names survive Home's masker, its vocabularies are closed and consistent, its reads
 * take a home permission, and its writes name their harness, with a real twin each.
 */
import { describe, expect, test } from "bun:test";
import { isCredentialKey } from "@crewhaus/spec-patch";
import type { z } from "zod";
import { walkFieldNames } from "./__test__/checkers.js";
import {
  ATTENTION_ACTION_EVENTS,
  ATTENTION_ACT_CHOICES,
  ATTENTION_BANDS,
  ATTENTION_CHOICE_ROWS,
  ATTENTION_ID_RE,
  ATTENTION_KINDS,
  ATTENTION_KIND_ROWS,
  ATTENTION_MODULE,
  CAUSE_KINDS,
  CROSS_HARNESS_CAUSES,
  DEPLOY_QUORUM_KIND,
  EVENT_TAXONOMY,
  MACHINES,
  OPERATIONS,
  TITLE_TEMPLATES,
  attIdFromDigest,
  attentionBandOf,
  attentionChoiceDoes,
  attentionKey,
  attentionRef,
  canTransition,
  encodeCursor,
  isId,
  mintId,
  parseRef,
  renderTwin,
} from "./index.js";
import { ATTENTION_SCHEMAS } from "./schemas/attention.js";
import { decision, eventEnvelope } from "./schemas/core.js";

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
  const rows = OPERATIONS.filter((op) => op.id.startsWith("attention."));

  test("three reads on a home permission, each with its own twin, and the discussion on content", () => {
    const reads = rows.filter((op) => op.method === "GET");
    expect(reads.map((op) => op.id).sort()).toEqual([
      "attention.get",
      "attention.list",
      "attention.messages.list",
      "attention.metrics",
    ]);
    for (const row of reads) {
      expect(row.permission).toBe(
        row.id === "attention.messages.list" ? "h.read.content" : "home.read",
      );
      expect(row.receipt).toBe("none");
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

  test("every write names its harness in the path, is receipted there, and has a twin or says why not", () => {
    const writes = rows.filter((op) => op.method !== "GET");
    expect(writes.map((op) => op.id).sort()).toEqual([
      "attention.acknowledge",
      "attention.assign",
      "attention.defer",
      "attention.dismiss",
      "attention.messages.add",
      "attention.reopen",
      "attention.resolve",
      "attention.snooze",
      "attention.unassign",
      "attention.undefer",
    ]);
    for (const row of writes) {
      expect(row.method).toBe("POST");
      expect(row.receipt).toBe("harness");
      const snooze = row.id === "attention.snooze";
      expect(`${row.id}: ${row.path.startsWith("/api/v1/harnesses/{h}/attention/{ref}/")}`).toBe(
        `${row.id}: ${!snooze}`,
      );
      expect(row.permission).toBe(snooze ? "self.preferences" : "h.decision.resolve");
      if (row.cliTwin === null) expect(row.noTwinReason).toContain("crewhaus inbox discuss");
      else expect(row.cliTwin.argv[0]).toBe("inbox");
    }
    // What the caller may decide is checked against the item's class as well.
    const classed = writes.filter((op) => (op.qualifiers as readonly string[]).includes("class"));
    expect(classed.map((op) => op.id).sort()).toEqual([
      "attention.defer",
      "attention.resolve",
      "attention.undefer",
    ]);
  });

  test("each choice belongs to a kind, once, and resolve carries out only the ones that do something", () => {
    const seen = new Set<string>();
    for (const row of ATTENTION_CHOICE_ROWS) {
      expect(ATTENTION_KINDS).toContain(row.kind);
      expect(seen.has(`${row.kind}.${row.choice}`)).toBe(false);
      seen.add(`${row.kind}.${row.choice}`);
    }
    // A question is answered, never allowed or refused: it offers no choice.
    expect(ATTENTION_CHOICE_ROWS.some((row) => (row.kind as string) === "question")).toBe(false);
    for (const row of ATTENTION_CHOICE_ROWS) {
      expect(attentionChoiceDoes(row.kind, row.choice)).toBe(row.does);
    }
    expect(attentionChoiceDoes("permission", "promote")).toBeUndefined();
    expect(attentionChoiceDoes("question", "grant")).toBeUndefined();
    for (const open of ["inspect", "open", "adopt", "review", "raise-spec", "raise-period"]) {
      expect(ATTENTION_ACT_CHOICES).not.toContain(open);
    }
    expect(ATTENTION_SCHEMAS.attentionResolveRequest.safeParse({ choice: "grant" }).success).toBe(
      true,
    );
    expect(ATTENTION_SCHEMAS.attentionResolveRequest.safeParse({ choice: "inspect" }).success).toBe(
      false,
    );
  });

  test("an action's event is a type of the attention family, and a snooze is its member's own", () => {
    const [family] = ATTENTION_MODULE.eventFamilies;
    expect(family.family).toBe("attention");
    expect(family.types.map((row) => row.type) as string[]).toEqual(
      ATTENTION_ACTION_EVENTS.map((event) => `attention.${event}`),
    );
    for (const row of family.types) {
      expect(EVENT_TAXONOMY[row.type]).toEqual({
        family: "attention",
        sensitivity: row.type === "attention.snoozed" ? "restricted" : "internal",
      });
    }
  });

  test("an event names the item by its ref, and nothing else fits there", () => {
    const base = {
      v: 1,
      id: encodeCursor({ v: 1, kind: "fleet", epoch: 1, seq: 2 }),
      type: "attention.resolved",
      at: "2026-11-19T00:00:00.000Z",
      ingestedAt: "2026-11-19T00:00:00.000Z",
      harness: "hrn_0123456789abcdef",
      sensitivity: "internal",
    };
    const ref = attentionRef(attIdFromDigest(digest(5)));
    expect(eventEnvelope.safeParse({ ...base, attention: ref }).success).toBe(true);
    expect(eventEnvelope.safeParse({ ...base, attention: "call jane" }).success).toBe(false);
  });

  test("a protected environment's quorum parses as a decision, bound to one version", () => {
    const subject = {
      spec: "support-bot",
      environment: "prod",
      version: "v1",
      specHash: `sha256:${"0".repeat(64)}`,
    };
    const row = {
      id: mintId("dec"),
      kind: DEPLOY_QUORUM_KIND,
      createdAt: "2026-11-19T00:00:00.000Z",
      state: "pending",
      requiredClass: "maintainer",
      subject,
    };
    expect(decision.safeParse(row).success).toBe(true);
    for (const bad of [
      { ...subject, environment: "--prod" },
      { ...subject, spec: "call jane" },
      { ...subject, specHash: "0".repeat(64) },
    ]) {
      expect(decision.safeParse({ ...row, subject: bad }).success).toBe(false);
    }
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
