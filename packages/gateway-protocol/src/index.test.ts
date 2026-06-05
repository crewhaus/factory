import { describe, expect, test } from "bun:test";
import {
  ErrorCode,
  GatewayProtocolError,
  Method,
  PROTOCOL_VERSION,
  RequestEnvelope,
  ResponseEnvelope,
  decodeRequest,
  encodeError,
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
