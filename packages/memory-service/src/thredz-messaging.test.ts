/**
 * #401 — the Thredz bridge registers the nine agent-to-agent messaging tools
 * when, and only when, the spec opts in.
 *
 * thredz-mcp v0.3.0 advertises 27 tools and promises "agent-to-agent
 * messaging", but `connectThredz` aliased only the 18 memory-vocabulary ones,
 * so an agent carrying `thredz:` reported the messaging tools as absent — and
 * with `expose.mcp` unwired (#394) that left daemon fleets with no A2A fabric
 * at all. The opt-in itself (`thredz.messaging: true`) had existed in the
 * spec and the IR since Batch G; nothing read it.
 *
 * The opt-in is the design, not a nicety: `thredz:` is the MEMORY knob, and
 * turning memory on must never silently grant outward messaging.
 */
import { describe, expect, test } from "bun:test";
import {
  THREDZ_ALIAS_TOOL_FLAGS,
  THREDZ_ALIAS_TOOL_NAMES,
  THREDZ_MESSAGING_TOOL_NAMES,
  thredzAliasToolNames,
} from "./thredz";

describe("the messaging vocabulary", () => {
  test("is the nine tools thredz-mcp v0.3.0 advertises", () => {
    expect([...THREDZ_MESSAGING_TOOL_NAMES].sort()).toEqual([
      "agent_block",
      "agent_list",
      "agent_register",
      "agent_unblock",
      "agent_update",
      "inbox_poll",
      "message_ack",
      "message_send",
      "thread_get",
    ]);
  });

  test("18 memory tools by default, 27 with messaging — the server's full set", () => {
    expect(thredzAliasToolNames(false)).toHaveLength(18);
    expect(thredzAliasToolNames(true)).toHaveLength(27);
    expect(thredzAliasToolNames()).toEqual(THREDZ_ALIAS_TOOL_NAMES);
  });

  test("the memory set is unchanged by the addition", () => {
    // The default vocabulary is the same object it always was, so a harness
    // that does not opt in registers byte-identically.
    expect(thredzAliasToolNames(false)).toBe(THREDZ_ALIAS_TOOL_NAMES);
    expect(THREDZ_ALIAS_TOOL_NAMES).not.toContain("message_send");
  });

  test("every messaging tool carries flags — an unflagged tool defaults open", () => {
    for (const name of THREDZ_MESSAGING_TOOL_NAMES) {
      expect(`${name}:flagged`).toBe(
        `${name}:${THREDZ_ALIAS_TOOL_FLAGS[name] !== undefined ? "flagged" : "MISSING"}`,
      );
    }
  });
});

describe("the messaging permission posture", () => {
  test("reads are readOnly", () => {
    for (const name of ["agent_list", "inbox_poll", "thread_get"]) {
      expect(`${name}:${JSON.stringify(THREDZ_ALIAS_TOOL_FLAGS[name])}`).toBe(
        `${name}:{"readOnly":true}`,
      );
    }
  });

  test("everything that mutates a directory or a mailbox is destructive", () => {
    for (const name of [
      "agent_register",
      "agent_update",
      "message_ack",
      "agent_block",
      "agent_unblock",
      "message_send",
    ]) {
      expect(`${name}:${THREDZ_ALIAS_TOOL_FLAGS[name]?.destructive === true}`).toBe(`${name}:true`);
    }
  });

  test("message_send — and only message_send — carries the Pillar 3 intent gate", () => {
    // It puts text in front of another agent: the visible-side-effect class
    // the gate exists for, and the one tool here an injection could aim
    // outward. The spec's own `thredz.messaging` docblock promises exactly
    // this ("the send-side tools are destructive + justification-gated").
    // Gating the directory bookkeeping too would only train operators to wave
    // the gate through.
    const gated = THREDZ_MESSAGING_TOOL_NAMES.filter(
      (n) => THREDZ_ALIAS_TOOL_FLAGS[n]?.requireJustification === true,
    );
    expect(gated).toEqual(["message_send"]);
  });

  test("no messaging tool is readOnly AND destructive", () => {
    for (const name of THREDZ_MESSAGING_TOOL_NAMES) {
      const flags = THREDZ_ALIAS_TOOL_FLAGS[name] ?? {};
      expect(`${name}:${flags.readOnly === true && flags.destructive === true}`).toBe(
        `${name}:false`,
      );
    }
  });
});
