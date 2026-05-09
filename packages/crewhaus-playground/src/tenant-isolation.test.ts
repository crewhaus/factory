import { describe, expect, test } from "bun:test";

import {
  PlaygroundTenantError,
  isolatedRunStore,
  parseRunIdScope,
  scopeRunId,
} from "./tenant-isolation";

describe("scopeRunId / parseRunIdScope (T1)", () => {
  test("round-trips a scoped id", () => {
    const scoped = scopeRunId({ sessionId: "abcdefgh1234" }, "run-001");
    expect(scoped).toBe("abcdefgh1234:run-001");
    const parsed = parseRunIdScope(scoped);
    expect(parsed).toEqual({ sessionId: "abcdefgh1234", runId: "run-001" });
  });

  test("rejects malformed sessionId", () => {
    expect(() => scopeRunId({ sessionId: "short" }, "run-1")).toThrow(PlaygroundTenantError);
    expect(() => scopeRunId({ sessionId: "has spaces!" }, "run-1")).toThrow();
  });

  test("rejects malformed runId", () => {
    expect(() => scopeRunId({ sessionId: "abcdefgh1234" }, "bad space")).toThrow();
    expect(() => scopeRunId({ sessionId: "abcdefgh1234" }, "")).toThrow();
  });

  test("parseRunIdScope returns null for invalid shape", () => {
    expect(parseRunIdScope("nope")).toBeNull();
    expect(parseRunIdScope("short:run")).toBeNull();
  });
});

describe("isolatedRunStore (T8 — cross-tenant isolation)", () => {
  test("session A cannot read session B's runs", () => {
    const store = isolatedRunStore<{ value: string }>();
    const sa = { sessionId: "session-a-1234567" };
    const sb = { sessionId: "session-b-1234567" };
    const idA = store.put(sa, "run-1", { value: "from-a" });
    const idB = store.put(sb, "run-1", { value: "from-b" });
    // Each session sees its own.
    expect(store.get(sa, idA)?.value).toBe("from-a");
    expect(store.get(sb, idB)?.value).toBe("from-b");
    // Cross-tenant reads return null.
    expect(store.get(sb, idA)).toBeNull();
    expect(store.get(sa, idB)).toBeNull();
  });

  test("list() returns only the requesting session's runs", () => {
    const store = isolatedRunStore<{ value: string }>();
    const sa = { sessionId: "session-a-1234567" };
    const sb = { sessionId: "session-b-1234567" };
    store.put(sa, "run-1", { value: "a1" });
    store.put(sa, "run-2", { value: "a2" });
    store.put(sb, "run-1", { value: "b1" });
    const aList = store.list(sa);
    const bList = store.list(sb);
    expect(aList.length).toBe(2);
    expect(bList.length).toBe(1);
  });

  test("guessing another session's scoped id still gets denied", () => {
    const store = isolatedRunStore<{ value: string }>();
    const sa = { sessionId: "session-a-1234567" };
    const sb = { sessionId: "session-b-1234567" };
    const idA = store.put(sa, "run-1", { value: "secret" });
    // Even though sb knows the scoped id, get() guards on sessionId match.
    expect(store.get(sb, idA)).toBeNull();
  });
});
