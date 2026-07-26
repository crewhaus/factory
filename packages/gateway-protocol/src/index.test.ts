import { describe, expect, test } from "bun:test";
import {
  ErrorCode,
  GatewayProtocolError,
  MAX_FEEDBACK_TEXT,
  Method,
  PROTOCOL_VERSION,
  RequestEnvelope,
  ResponseEnvelope,
  RunsSubscribeParams,
  SSE_CONTENT_TYPE,
  decodeRequest,
  encodeError,
  encodeSseComment,
  encodeSseEvent,
  encodeSuccess,
} from "./index";

describe("envelope", () => {
  test("PROTOCOL_VERSION is the v1 string", () => {
    expect(PROTOCOL_VERSION).toBe("crewhaus.v1");
  });

  test("decodeRequest accepts a well-formed runs.create", () => {
    const raw = {
      protocol: "crewhaus.v1",
      id: "abc",
      method: "runs.create",
      params: { spec: "x", input: "hi" },
    };
    const r = decodeRequest(raw);
    expect(r.method).toBe("runs.create");
    expect((r.params as { spec: string }).spec).toBe("x");
  });

  test("rejects wrong protocol version", () => {
    const raw = {
      protocol: "crewhaus.v0",
      id: "abc",
      method: "runs.create",
      params: { spec: "x", input: "" },
    };
    expect(() => decodeRequest(raw)).toThrow(GatewayProtocolError);
  });

  test("rejects unknown method", () => {
    const raw = {
      protocol: "crewhaus.v1",
      id: "abc",
      method: "runs.nuke",
      params: {},
    };
    expect(() => decodeRequest(raw)).toThrow(/unknown method "runs.nuke"/);
  });

  test("rejects invalid params for known method", () => {
    const raw = {
      protocol: "crewhaus.v1",
      id: "abc",
      method: "runs.create",
      params: { spec: 1 }, // wrong type
    };
    expect(() => decodeRequest(raw)).toThrow(/invalid params/);
  });

  test("rejects extra unknown fields on the envelope (.strict)", () => {
    const raw = {
      protocol: "crewhaus.v1",
      id: "abc",
      method: "runs.create",
      params: { spec: "x", input: "" },
      foo: "bar",
    };
    expect(() => decodeRequest(raw)).toThrow(GatewayProtocolError);
  });
});

describe("response encoders", () => {
  test("encodeSuccess shape", () => {
    const r = encodeSuccess("id-1", { ok: true });
    expect(r).toEqual({ protocol: "crewhaus.v1", id: "id-1", result: { ok: true } });
  });

  test("encodeError shape with no data", () => {
    const r = encodeError("id-1", ErrorCode.NotFound, "missing");
    expect(r).toEqual({
      protocol: "crewhaus.v1",
      id: "id-1",
      error: { code: "not_found", message: "missing" },
    });
  });

  test("encodeError shape with data", () => {
    const r = encodeError("id-1", ErrorCode.BadRequest, "bad", { field: "x" });
    expect(r).toEqual({
      protocol: "crewhaus.v1",
      id: "id-1",
      error: { code: "bad_request", message: "bad", data: { field: "x" } },
    });
  });
});

describe("standard error codes are wire-stable", () => {
  test("expected codes exist", () => {
    expect(ErrorCode.Unauthorized).toBe("unauthorized");
    expect(ErrorCode.Forbidden).toBe("forbidden");
    expect(ErrorCode.NotFound).toBe("not_found");
    expect(ErrorCode.BadRequest).toBe("bad_request");
    expect(ErrorCode.BudgetExceeded).toBe("budget_exceeded");
    expect(ErrorCode.InternalError).toBe("internal_error");
  });
});

describe("error-message path formatting", () => {
  // The issue-formatter uses `i.path.join(".") || "<root>"`. A top-level
  // failure (raw is not an object at all) yields an empty Zod path, which
  // must surface as "<root>" rather than an empty string.
  test("envelope failure on a non-object surfaces <root>", () => {
    expect(() => decodeRequest("not-an-object")).toThrow(/<root>: /);
  });

  test("param failure on a non-object surfaces <root>", () => {
    const raw = {
      protocol: "crewhaus.v1",
      id: "abc",
      method: "runs.cancel",
      params: null,
    };
    expect(() => decodeRequest(raw)).toThrow(/invalid params for runs.cancel: <root>: /);
  });

  test("named-field failure surfaces the field path, not <root>", () => {
    const raw = {
      protocol: "crewhaus.v1",
      id: "abc",
      method: "runs.create",
      params: { spec: 1, input: "hi" },
    };
    // `spec` is the offending path; it must appear and <root> must not.
    expect(() => decodeRequest(raw)).toThrow(/spec: /);
    try {
      decodeRequest(raw);
    } catch (e) {
      expect((e as Error).message).not.toContain("<root>");
    }
  });
});

describe("decodeRequest accepts every declared method", () => {
  const cases: Array<[string, unknown]> = [
    ["runs.create", { spec: "s", input: "" }],
    ["runs.continue", { sessionId: "sess", input: "more" }],
    ["runs.cancel", { runId: "r1" }],
    ["runs.subscribe", { runId: "r1" }],
    ["sessions.list", {}],
    ["sessions.fork", { sessionId: "sess", atEventTs: 0 }],
    ["audit.tail", { tenantId: "t1" }],
    ["feedback.submit", { sessionId: "sess_00000000000000aa", turnNumber: 1, thumbs: "up" }],
  ];
  for (const [method, params] of cases) {
    test(`decodes ${method}`, () => {
      const r = decodeRequest({ protocol: "crewhaus.v1", id: "id", method, params });
      expect(r.method).toBe(method as (typeof r)["method"]);
      expect(r.protocol).toBe("crewhaus.v1");
      expect(r.params).toEqual(params);
    });
  }

  test("Method enum lists exactly the routed methods", () => {
    expect([...Method.options].sort()).toEqual(
      [...cases.map(([m]) => m as (typeof Method.options)[number])].sort(),
    );
  });
});

describe("envelope id/method minimums", () => {
  test("rejects empty id", () => {
    const raw = {
      protocol: "crewhaus.v1",
      id: "",
      method: "runs.create",
      params: { spec: "x", input: "" },
    };
    expect(() => decodeRequest(raw)).toThrow(GatewayProtocolError);
  });

  test("rejects empty method", () => {
    const raw = { protocol: "crewhaus.v1", id: "abc", method: "", params: {} };
    expect(() => decodeRequest(raw)).toThrow(GatewayProtocolError);
  });

  test("optional sessionId is accepted on runs.create", () => {
    const r = decodeRequest({
      protocol: "crewhaus.v1",
      id: "abc",
      method: "runs.create",
      params: { spec: "x", input: "hi", sessionId: "sess" },
    });
    expect((r.params as { sessionId?: string }).sessionId).toBe("sess");
  });
});

describe("encoder ↔ schema round-trips", () => {
  test("encodeSuccess output validates against ResponseEnvelope", () => {
    expect(ResponseEnvelope.safeParse(encodeSuccess("i", { ok: true })).success).toBe(true);
  });

  test("encodeError output validates against ResponseEnvelope (no data)", () => {
    expect(ResponseEnvelope.safeParse(encodeError("i", "not_found", "missing")).success).toBe(true);
  });

  test("encodeError output validates against ResponseEnvelope (with data)", () => {
    const parsed = ResponseEnvelope.safeParse(encodeError("i", "bad_request", "bad", { f: 1 }));
    expect(parsed.success).toBe(true);
  });

  // Distinct from the no-arg call: passing `data: undefined` explicitly must
  // still omit the key (the `data !== undefined` guard), keeping the wire
  // form identical to the success/no-data shape.
  test("encodeError with explicit undefined data omits the data key", () => {
    const r = encodeError("id-1", ErrorCode.InternalError, "boom", undefined);
    expect(r).toEqual({
      protocol: "crewhaus.v1",
      id: "id-1",
      error: { code: "internal_error", message: "boom" },
    });
    expect("data" in (r as { error: Record<string, unknown> }).error).toBe(false);
  });

  test("encodeError preserves a falsy-but-defined data value", () => {
    const r = encodeError("id-1", ErrorCode.BadRequest, "bad", null);
    expect((r as { error: { data?: unknown } }).error.data).toBeNull();
    expect("data" in (r as { error: Record<string, unknown> }).error).toBe(true);
  });
});

describe("RequestEnvelope is the exported request schema", () => {
  test("validates a well-formed envelope shape directly", () => {
    const parsed = RequestEnvelope.safeParse({
      protocol: "crewhaus.v1",
      id: "abc",
      method: "anything.goes",
      params: 42,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("runs.subscribe params", () => {
  test("requires a non-empty runId (.strict, min 1)", () => {
    expect(RunsSubscribeParams.safeParse({ runId: "run_1" }).success).toBe(true);
    expect(RunsSubscribeParams.safeParse({ runId: "" }).success).toBe(false);
    expect(RunsSubscribeParams.safeParse({}).success).toBe(false);
    // Extra fields are rejected — the subscribe params are a closed shape.
    expect(RunsSubscribeParams.safeParse({ runId: "run_1", extra: 1 }).success).toBe(false);
  });

  test("decodeRequest routes runs.subscribe and validates its runId", () => {
    const r = decodeRequest({
      protocol: "crewhaus.v1",
      id: "id",
      method: "runs.subscribe",
      params: { runId: "run_abc" },
    });
    expect(r.method).toBe("runs.subscribe");
    expect((r.params as { runId: string }).runId).toBe("run_abc");
    expect(() =>
      decodeRequest({
        protocol: "crewhaus.v1",
        id: "id",
        method: "runs.subscribe",
        params: { runId: "" },
      }),
    ).toThrow(/invalid params for runs.subscribe/);
  });
});

describe("SSE framing (runs.subscribe wire format)", () => {
  test("SSE_CONTENT_TYPE is the event-stream MIME", () => {
    expect(SSE_CONTENT_TYPE).toBe("text/event-stream");
  });

  test("encodeSseEvent is a single data: frame ended by a blank line", () => {
    const frame = encodeSseEvent({ kind: "turn_start", turn: 1 });
    expect(frame).toBe('data: {"kind":"turn_start","turn":1}\n\n');
    // Exactly one data: line — the JSON body carries no literal newline.
    expect(frame.split("\n").filter((l) => l.startsWith("data:")).length).toBe(1);
  });

  test("encodeSseEvent escapes embedded newlines inside the JSON (stays one line)", () => {
    // A string field with a newline must not break the single-line data: frame.
    const frame = encodeSseEvent({ kind: "run_failed", message: "line1\nline2" });
    const body = frame.slice("data: ".length, -2); // strip "data: " and trailing \n\n
    expect(body).not.toContain("\n"); // JSON.stringify escaped it to \\n
    expect(JSON.parse(body)).toEqual({ kind: "run_failed", message: "line1\nline2" });
  });

  test("encodeSseComment is a :-prefixed frame with newlines collapsed", () => {
    expect(encodeSseComment("heartbeat")).toBe(": heartbeat\n\n");
    // An injected newline can't split one comment into two frames.
    expect(encodeSseComment("a\nb")).toBe(": a b\n\n");
  });
});

describe("GatewayProtocolError", () => {
  test("carries the config code and preserves its cause", () => {
    const cause = new Error("underlying");
    const err = new GatewayProtocolError("nope", cause);
    expect(err).toBeInstanceOf(GatewayProtocolError);
    expect(err.name).toBe("GatewayProtocolError");
    expect(err.code).toBe("config");
    expect(err.message).toBe("nope");
    expect(err.cause).toBe(cause);
  });

  test("is constructible without a cause", () => {
    const err = new GatewayProtocolError("solo");
    expect(err.cause).toBeUndefined();
    expect(err.code).toBe("config");
  });
});

describe("feedback.submit param grammar", () => {
  const envelope = (params: unknown): unknown => ({
    protocol: "crewhaus.v1",
    id: "id",
    method: "feedback.submit",
    params,
  });
  const VALID_SESSION = "sess_00000000000000aa";

  test("refuses a session id outside the store's grammar", () => {
    // Accepting it would write a durable line every reader silently drops
    // (isFeedbackRecord pins the same regex), and the managed daemon
    // interpolates the id into a filesystem path.
    for (const bad of ["sess_1", "sess_00000000000000AA", "../../etc/passwd", "run_abcdef"]) {
      expect(() =>
        decodeRequest(envelope({ sessionId: bad, turnNumber: 1, thumbs: "up" })),
      ).toThrow(GatewayProtocolError);
    }
  });

  test("refuses oversize free text instead of silently truncating it", () => {
    const tooLong = "x".repeat(MAX_FEEDBACK_TEXT + 1);
    for (const field of ["comment", "correction", "rater"] as const) {
      expect(() =>
        decodeRequest(
          envelope({ sessionId: VALID_SESSION, turnNumber: 1, thumbs: "up", [field]: tooLong }),
        ),
      ).toThrow(GatewayProtocolError);
    }
    // Exactly at the bound still passes.
    const atBound = "x".repeat(MAX_FEEDBACK_TEXT);
    expect(() =>
      decodeRequest(
        envelope({ sessionId: VALID_SESSION, turnNumber: 1, thumbs: "up", comment: atBound }),
      ),
    ).not.toThrow();
  });
});
