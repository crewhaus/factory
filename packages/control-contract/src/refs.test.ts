import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { FREE_TEXT_ACTOR_FIELDS, walkActorFields } from "./__test__/checkers.js";
import { AT, EXAMPLES, SEAL } from "./__test__/schema-examples.js";
import {
  CORE_MODULE,
  RUN_CAUSE_KINDS,
  SYSTEM_ACTORS,
  TRIGGER_KINDS,
  classifyRunId,
  formatRef,
  formatResumeScope,
  isGrantScope,
  isLaneId,
  isStoredActor,
  mintId,
  mintRunId,
  parseActor,
  parseLinkSubject,
  parseRef,
  parseResumeScope,
} from "./index.js";
import {
  SCHEMAS,
  approverProjection,
  decision,
  link,
  linkCreateRequest,
  run,
  tokenRow,
} from "./schemas/index.js";

const HRN = "hrn_0123456789abcdef";
const SESS = "sess_0123456789abcdef";
const APPR = "appr_0123456789abcdef";
const DIGEST = "z".repeat(26);
const HEX64 = "a".repeat(64);

describe("refs", () => {
  const good: readonly (readonly [string, string, string])[] = [
    ["home", "harness", HRN],
    ["home", "principal", mintId("prn")],
    ["home", "creation", mintId("crs")],
    ["home", "attention", `att_${DIGEST}`],
    [HRN, "deployment", mintId("dep")],
    [HRN, "run", mintRunId()],
    [HRN, "run", "run_abcd1234"],
    [HRN, "run", "run_zz9"],
    [HRN, "exec", "run_0123456789abcdef"],
    [HRN, "evalrun", "run_0123456789abcdef"],
    [HRN, "decision", APPR],
    [HRN, "decision", mintId("dec")],
    [HRN, "rule", mintId("rule")],
    [HRN, "session", SESS],
    [HRN, "change", mintId("chg")],
    ["home", "cmd", mintId("cmd")],
    [HRN, "cmd", mintId("cmd")],
    ["home", "work", mintId("wi")],
    [HRN, "work", mintId("wi")],
    ["home", "connection", mintId("con")],
    [HRN, "connection", mintId("con")],
    ["home", "knowledge", "notes.2026-q4"],
    [HRN, "knowledge", "notes.2026-q4"],
  ];

  test("every kind round-trips in every scope it allows", () => {
    for (const [scope, kind, id] of good) {
      const text = formatRef({ scope, kind, id });
      expect(text).toBe(`${scope}/${kind}/${id}`);
      expect(parseRef(text)).toEqual({ scope, kind, id });
    }
    expect(new Set(good.map(([, kind]) => kind)).size).toBe(CORE_MODULE.refKinds.length);
  });

  const bad: readonly (readonly [string, unknown, string])[] = [
    ["not a string", 7, "not-a-string"],
    ["over 200 characters", `home/knowledge/${"a".repeat(186)}`, "too-long"],
    ["whitespace", `home/harness/${HRN} `, "whitespace"],
    ["a newline", `home/harness/${HRN}\n`, "whitespace"],
    ["a percent sign", "home/knowledge/a%2Fb", "percent"],
    ["too few segments", `home/${HRN}`, "segments"],
    ["an extra segment", `home/harness/${HRN}/x`, "segments"],
    ["an empty scope", `/harness/${HRN}`, "segments"],
    ["an empty kind", `home//${HRN}`, "segments"],
    ["an empty id", "home/harness/", "segments"],
    ["an unknown scope", `nowhere/harness/${HRN}`, "scope"],
    ["a malformed harness scope", "hrn_x/run/run_abcd1234", "scope"],
    ["an unknown kind", `home/nothing/${HRN}`, "kind"],
    ["a harness-only kind at home", `home/session/${SESS}`, "scope-not-allowed"],
    ["a home-only kind in a harness", `${HRN}/principal/${mintId("prn")}`, "scope-not-allowed"],
    ["a misfit id", `${HRN}/session/${APPR}`, "id"],
    ["a run id for a decision", `${HRN}/decision/${mintRunId()}`, "id"],
    ["an execution id for a canonical run", `${HRN}/run/run_0123456789abcdef`, "id"],
    ["a canonical id for an execution", `${HRN}/exec/${mintRunId()}`, "id"],
    ["the bridge literal, though it fits base36", `${HRN}/run/run_channel`, "id"],
    ["a knowledge id with a leading dot", "home/knowledge/.hidden", "id"],
  ];
  for (const [name, value, error] of bad) {
    test(`refused: ${name}`, () => {
      expect(parseRef(value)).toEqual({ error } as never);
    });
  }

  test("exactly 200 characters still parses", () => {
    const ref = `home/knowledge/${"a".repeat(128)}`;
    expect(ref.length).toBeLessThanOrEqual(200);
    expect("error" in parseRef(ref)).toBe(false);
  });

  test("formatRef throws on what would not parse", () => {
    expect(() => formatRef({ scope: "home", kind: "session", id: SESS })).toThrow(
      "scope-not-allowed",
    );
  });
});

describe("classifyRunId", () => {
  const cases: readonly (readonly [unknown, string, readonly string[]])[] = [
    [mintRunId(), "canonical", ["run"]],
    ["run_0123456789abcdef", "hex16", ["exec", "evalrun"]],
    ["run_abcd1234", "hex8", ["run"]],
    ["run_channel", "literal", []],
    ["run_zz9", "base36", ["run"]],
    ["wf_0f8fad5b-d9cb-469f-a165-70867728950e", "workflow", []],
    ["grun_0123456789abcdef", "graph", []],
    ["fedrun_abc123", "federation", []],
    ["wf_not-a-uuid", "unknown", []],
    ["run_", "unknown", []],
    ["", "unknown", []],
    [null, "unknown", []],
  ];
  for (const [id, family, refKinds] of cases) {
    test(`${String(id)} is ${family}`, () => {
      expect(classifyRunId(id)).toEqual({ family, refKinds } as never);
    });
  }
});

describe("actors", () => {
  test("each form is named", () => {
    const prn = mintId("prn");
    expect(parseActor(prn)).toEqual({ form: "principal", id: prn });
    expect(parseActor("local:sam@laptop.local")?.form).toBe("local");
    expect(parseActor(`local:#${HEX64}`)?.form).toBe("stored-local");
    for (const name of ["scheduler", "reconcile", "runtime", "executor"]) {
      expect(parseActor(`sys:${name}`)?.form).toBe("system");
    }
  });

  test("the system actors are a closed list, a receiver's delivery among them", () => {
    expect([...SYSTEM_ACTORS]).toEqual([
      "sys:scheduler",
      "sys:reconcile",
      "sys:runtime",
      "sys:executor",
      "sys:slo",
      "sys:ingress",
    ]);
    expect(parseActor("sys:ingress")).toEqual({ form: "system", id: "sys:ingress" });
    expect(isStoredActor("sys:ingress")).toBe(true);
  });

  for (const bad of [
    "sys:nobody",
    "local:sam",
    "local:@host",
    "local:sam@",
    `local:#${"a".repeat(63)}`,
    `local:#${"A".repeat(64)}`,
    "prn_nope",
    "free text",
    42,
  ]) {
    test(`not an actor: ${String(bad)}`, () => {
      expect(parseActor(bad)).toBeNull();
    });
  }

  test("a record may hold anything but a raw local actor", () => {
    expect(isStoredActor(mintId("prn"))).toBe(true);
    expect(isStoredActor("sys:runtime")).toBe(true);
    expect(isStoredActor(`local:#${HEX64}`)).toBe(true);
    expect(isStoredActor("local:sam@laptop")).toBe(false);
    expect(isStoredActor("free text")).toBe(false);
  });

  describe("every actor field of a record refuses a raw local actor", () => {
    /** Schema id, the field's path, and the record with a value at that path. */
    const ACTOR_FIELDS: readonly (readonly [string, string, (actor: string) => unknown])[] = [
      ["run", "by", (by) => ({ ...(EXAMPLES["run"] as object), by })],
      [
        "decision",
        "decidedByPrincipal",
        (decidedByPrincipal) => ({ ...(EXAMPLES["decision"] as object), decidedByPrincipal }),
      ],
      [
        "decision",
        "assignedTo",
        (assignedTo) => ({ ...(EXAMPLES["decision"] as object), assignedTo }),
      ],
      [
        "decision",
        "proposedBy",
        (proposedBy) => ({ ...(EXAMPLES["decision"] as object), proposedBy }),
      ],
      ["decisionOverlays", "assigned.to", (to) => ({ assigned: { to, at: AT } })],
      [
        "commandReceipt",
        "actor",
        (actor) => ({ ...(EXAMPLES["commandReceipt"] as object), actor }),
      ],
      ["grant", "grantedBy", (grantedBy) => ({ ...(EXAMPLES["grant"] as object), grantedBy })],
      ["invite", "createdBy", (createdBy) => ({ ...(EXAMPLES["invite"] as object), createdBy })],
      [
        "standingRule",
        "createdBy",
        (createdBy) => ({ ...(EXAMPLES["standingRule"] as object), createdBy }),
      ],
      [
        "standingRule",
        "revokedBy",
        (revokedBy) => ({ ...(EXAMPLES["standingRule"] as object), revokedBy }),
      ],
      [
        "deployment",
        "activatedBy",
        (activatedBy) => ({ ...(EXAMPLES["deployment"] as object), activatedBy }),
      ],
      ["eventEnvelope", "actor", (actor) => ({ ...(EXAMPLES["eventEnvelope"] as object), actor })],
      [
        "harnessOverview",
        "owner",
        (owner) => ({ ...(EXAMPLES["harnessOverview"] as object), owner }),
      ],
    ];

    for (const [id, path, withActor] of ACTOR_FIELDS) {
      test(`${id}.${path}`, () => {
        const schema = SCHEMAS[id] as z.ZodTypeAny;
        for (const good of [mintId("prn"), `local:#${HEX64}`, "sys:runtime"]) {
          const parsed = schema.safeParse(withActor(good));
          if (!parsed.success) throw new Error(`${good}: ${parsed.error.message}`);
        }
        const refused = schema.safeParse(withActor("local:sam@laptop"));
        expect(refused.success).toBe(false);
        expect(refused.error?.issues[0]?.path.join(".")).toBe(path);
      });
    }

    test("the table is every one the core has", () => {
      expect(ACTOR_FIELDS).toHaveLength(13);
      expect(new Set(ACTOR_FIELDS.map(([id, path]) => `${id}.${path}`)).size).toBe(13);
    });

    test("and a walk of every schema finds no field that takes one", () => {
      const walk = walkActorFields(SCHEMAS);
      expect(walk.holes).toEqual([]);
      for (const name of [
        "activatedBy",
        "actor",
        "assignedTo",
        "by",
        "createdBy",
        "decidedByPrincipal",
        "grantedBy",
        "owner",
        "principal",
        "proposedBy",
        "revokedBy",
        "subjectRef",
        "supersededBy",
        "to",
      ]) {
        expect(walk.names).toContain(name);
      }
      expect(walk.checked).toBeGreaterThanOrEqual(40);
    });

    test("decidedBy is the one exception: display text with no authority", () => {
      expect(FREE_TEXT_ACTOR_FIELDS).toEqual(["decidedBy"]);
      expect(walkActorFields(SCHEMAS).exempt).toEqual(["decidedBy"]);
      const record = { ...(EXAMPLES["decision"] as object), decidedBy: "local:sam@laptop" };
      expect(decision.safeParse(record).success).toBe(true);
    });

    test("the walk reports a planted plain string, at any depth", () => {
      const planted = {
        flat: z.object({ createdBy: z.string() }),
        deep: z.object({ rows: z.array(z.object({ assignedTo: z.string().optional() })) }),
        fine: z.object({ actor: z.string().regex(/^prn_/), note: z.string() }),
      };
      expect(walkActorFields(planted).holes).toEqual(["flat.createdBy", "deep.rows[].assignedTo"]);
      expect(walkActorFields(planted).checked).toBe(3);
    });
  });

  describe("a run row holds a subject only as a keyed digest", () => {
    const base = EXAMPLES["run"] as object;

    test("a digest passes", () => {
      expect(run.safeParse({ ...base, subjectRef: HEX64 }).success).toBe(true);
    });

    for (const subject of ["local:max@laptop", "slack:T1:U1", "github:12345", "max@acme.example"]) {
      test(`refused: ${subject}`, () => {
        const refused = run.safeParse({ ...base, subjectRef: subject });
        expect(refused.success).toBe(false);
        expect(refused.error?.issues[0]?.path).toEqual(["subjectRef"]);
      });
    }
  });

  test("a projected member may carry an end time, and a withdrawn request names its cancelled run", () => {
    const projection = {
      v: 1,
      epoch: 1,
      generatedAt: "2026-01-01T00:00:00Z",
      harness: HRN,
      owner: mintId("prn"),
      governedSince: "2026-01-01T00:00:00Z",
      links: [],
    };
    const member = { principal: mintId("prn"), decide: "operator" };
    for (const [until, ok] of [
      [undefined, true],
      ["2026-02-01T00:00:00Z", true],
      ["whenever", false],
      [7, false],
    ] as const) {
      const members = [{ ...member, ...(until === undefined ? {} : { until }) }];
      expect(approverProjection.safeParse({ ...projection, members }).success).toBe(ok);
    }
    const base = EXAMPLES["decision"] as object;
    expect(decision.safeParse({ ...base, supersededBy: "appr_0123456789abcdef" }).success).toBe(
      true,
    );
    expect(decision.safeParse({ ...base, supersededBy: mintRunId() }).success).toBe(true);
    expect(decision.safeParse({ ...base, supersededBy: "run_0123abcd" }).success).toBe(false);
    expect(decision.safeParse({ ...base, supersededBy: "somebody" }).success).toBe(false);
  });

  test("schemas refuse a raw local link", () => {
    const projection = {
      v: 1,
      epoch: 1,
      generatedAt: "2026-01-01T00:00:00Z",
      harness: HRN,
      owner: mintId("prn"),
      governedSince: "2026-01-01T00:00:00Z",
      members: [],
    };
    const principal = mintId("prn");
    expect(
      approverProjection.safeParse({
        ...projection,
        links: [{ external: "slack:T1:U1", principal }],
      }).success,
    ).toBe(true);
    expect(
      approverProjection.safeParse({
        ...projection,
        links: [{ external: "local:sam@laptop", principal }],
      }).success,
    ).toBe(false);
    expect(linkCreateRequest.safeParse({ subject: "local:sam@laptop", principal }).success).toBe(
      false,
    );
    const row = {
      id: mintId("lnk"),
      principal,
      provider: "local",
      verifiedVia: "owner",
      at: "2026-01-01T00:00:00Z",
    };
    expect(link.safeParse({ ...row, subjectRef: HEX64 }).success).toBe(true);
    expect(link.safeParse({ ...row, subjectRef: "local:sam@laptop" }).success).toBe(false);
  });
});

describe("lanes", () => {
  for (const good of ["heartbeat", "schedule", "schedule:nightly", "schedule:a-1"]) {
    test(`lane: ${good}`, () => expect(isLaneId(good)).toBe(true));
  }
  for (const bad of [
    "schedule:Nightly",
    "schedule:",
    "schedule:1a",
    "cron",
    `schedule:${"a".repeat(33)}`,
  ]) {
    test(`not a lane: ${bad}`, () => expect(isLaneId(bad)).toBe(false));
  }
});

describe("resume scopes", () => {
  const good = [
    ["session", SESS],
    ["job", "job-1:with/punctuation"],
    ["lane", "schedule:nightly"],
    ["run", mintRunId()],
    ["work", mintId("wi")],
  ] as const;
  for (const [kind, id] of good) {
    test(`${kind} round-trips`, () => {
      const text = formatResumeScope({ kind, id });
      expect(parseResumeScope(text)).toEqual({ kind, id });
    });
  }
  for (const bad of [
    "session:nope",
    "job:",
    "job:has space",
    `job:${"a".repeat(257)}`,
    "lane:schedule:Nightly",
    "run:run_abcd1234",
    "work:wi_nope",
    "tenant:x",
    "nokind",
    ":x",
    7,
  ]) {
    test(`refused: ${String(bad)}`, () => expect(parseResumeScope(bad)).toBeNull());
  }
  test("256 characters is the longest job id", () => {
    expect(parseResumeScope(`job:${"a".repeat(256)}`)).not.toBeNull();
  });
  test("formatResumeScope throws on what would not parse", () => {
    expect(() => formatResumeScope({ kind: "run", id: "run_abcd1234" })).toThrow("run scope");
  });
});

describe("grant scopes and link subjects", () => {
  for (const good of ["home", "group:platform team", `harness:${HRN}`]) {
    test(`scope: ${good}`, () => expect(isGrantScope(good)).toBe(true));
  }
  for (const bad of [
    "group:",
    "group:a/b",
    `group:${"a".repeat(129)}`,
    "harness:nope",
    "tenant:x",
  ]) {
    test(`not a scope: ${bad}`, () => expect(isGrantScope(bad)).toBe(false));
  }
  const subjects = [
    ["slack:T123:U456", "slack"],
    ["github:12345", "github"],
    ["proxy:X-User:sam", "proxy"],
    ["local:sam@laptop", "local"],
  ] as const;
  for (const [subject, provider] of subjects) {
    test(`subject: ${subject}`, () => expect(parseLinkSubject(subject)).toBe(provider));
  }
  for (const bad of [
    "slack:t1:u1",
    `slack:${"T".repeat(33)}:U`,
    "github:abc",
    `github:${"1".repeat(21)}`,
    "email:a@b",
  ]) {
    test(`not a subject: ${bad}`, () => expect(parseLinkSubject(bad)).toBeNull());
  }
});

describe("run-row vocabulary, pinned", () => {
  test("trigger kinds and failure causes", () => {
    expect([...TRIGGER_KINDS]).toEqual([
      "queue",
      "heartbeat",
      "schedule",
      "approval-resume",
      "eval",
      "rehearsal",
      "api",
      "cli",
      "channel",
      "managed",
      "resume",
      "retry",
    ]);
    expect([...RUN_CAUSE_KINDS]).toEqual([
      "provider",
      "tool",
      "mcp",
      "connection",
      "budget",
      "spec",
      "config",
    ]);
  });

  test("the example seal is what schemas accept", () => {
    expect(SEAL.kty).toBe("EC");
    expect(
      tokenRow.safeParse({ id: mintId("crd"), principal: mintId("prn"), kind: "service" }).success,
    ).toBe(true);
  });
});
