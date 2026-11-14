import { describe, expect, test } from "bun:test";
import type { ApproverRead } from "@crewhaus/control-records";
import { ownerCheck } from "./owner-check";

describe("ownerCheck", () => {
  const reader = (read: ApproverRead) => (_dir: string) => read;

  test("no approver projection: single-owner mode, the local user is the owner", () => {
    expect(ownerCheck("/h", reader({ state: "absent" }), {})).toEqual({ ok: true });
  });

  test("a projection: the owner, named for the record", () => {
    const projection = { owner: "prn_owner" } as unknown as Extract<
      ApproverRead,
      { state: "present" }
    >["projection"];
    expect(ownerCheck("/h", reader({ state: "present", projection }), {})).toEqual({
      ok: true,
      principal: "prn_owner",
    });
  });

  test("a projection that cannot be read refuses, naming the verb that rewrites it", () => {
    const out = ownerCheck(
      "/h",
      reader({ state: "unreadable", reason: "its version is not 1" }),
      {},
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("its version is not 1");
      expect(out.reason).toContain("`crewhaus access sync`");
    }
  });

  const projection = { owner: "prn_owner" } as unknown as Extract<
    ApproverRead,
    { state: "present" }
  >["projection"];

  test("a command started by an agent's tool is refused before the projection is read", () => {
    const env = { CREWHAUS_AGENT_TOOL: "Bash" };
    for (const read of [{ state: "absent" }, { state: "present", projection }] as const) {
      let calls = 0;
      const counting = (_dir: string): ApproverRead => {
        calls++;
        return read;
      };
      expect(ownerCheck("/h", counting, env)).toEqual({
        ok: false,
        reason: "this command was started by an agent's tool; a person makes this change",
      });
      expect(calls).toBe(0);
    }
  });

  test("an unset or empty agent-tool variable keeps the owner answers", () => {
    for (const env of [{}, { CREWHAUS_AGENT_TOOL: "" }]) {
      expect(ownerCheck("/h", reader({ state: "absent" }), env)).toEqual({ ok: true });
      expect(ownerCheck("/h", reader({ state: "present", projection }), env)).toEqual({
        ok: true,
        principal: "prn_owner",
      });
    }
  });
});
