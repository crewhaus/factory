import { describe, expect, test } from "bun:test";
import {
  ErrorCode,
  GatewayProtocolError,
  PROTOCOL_VERSION,
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
