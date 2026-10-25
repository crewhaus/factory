/**
 * §2.4 proof ladder verification: evidence resolves against session JSONLs
 * (parent + sub-agent children via `sub_agent_start` brackets), rejects
 * missing ids and `isError: true` results with instructive errors, and pins
 * cited sessions in retention.json.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceError, appendRetentionPins, resolveEvidence, verifyEvidence } from "./evidence";

let tmp: string;
let sessionsDir: string;

const PARENT = "sess_aaaaaaaaaaaaaaaa";
const CHILD = "sess_bbbbbbbbbbbbbbbb";
const GRANDCHILD = "sess_cccccccccccccccc";

const fixedNow = (): Date => new Date("2026-07-13T00:00:00.000Z");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "continuity-evidence-"));
  sessionsDir = join(tmp, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Append events in the exact event-log wire shape. */
function logEvents(sessionId: string, events: Array<{ kind: string; payload: unknown }>): void {
  const path = join(sessionsDir, `${sessionId}.jsonl`);
  for (const [i, ev] of events.entries()) {
    appendFileSync(path, `${JSON.stringify({ ts: 1000 + i, version: 1, ...ev })}\n`);
  }
}

function toolPair(
  id: string,
  opts: { name?: string; input?: unknown; content?: unknown; isError?: boolean } = {},
): Array<{ kind: string; payload: unknown }> {
  return [
    {
      kind: "tool_use",
      payload: { id, name: opts.name ?? "Bash", input: opts.input ?? { cmd: "ls" } },
    },
    {
      kind: "tool_result",
      payload: { toolUseId: id, content: opts.content ?? "ok", isError: opts.isError ?? false },
    },
  ];
}

describe("verifyEvidence", () => {
  test("verifies a tool_use/tool_result pair in the cited session and freezes the excerpt", async () => {
    logEvents(
      PARENT,
      toolPair("tu_001", { name: "Bash", input: { cmd: "bun test" }, content: "42 pass" }),
    );
    const proofs = await verifyEvidence([{ toolUseId: "tu_001", sessionId: PARENT }], {
      sessionRootDir: sessionsDir,
      now: fixedNow,
    });
    expect(proofs.length).toBe(1);
    const proof = proofs[0];
    expect(proof?.toolUseId).toBe("tu_001");
    expect(proof?.sessionId).toBe(PARENT);
    expect(proof?.toolName).toBe("Bash");
    expect(proof?.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(proof?.resultDigest).toBe("42 pass");
    expect(proof?.verifiedAt).toBe("2026-07-13T00:00:00.000Z");
  });

  test("uses defaultSessionId for refs without a sessionId", async () => {
    logEvents(PARENT, toolPair("tu_002"));
    const proofs = await verifyEvidence([{ toolUseId: "tu_002" }], {
      sessionRootDir: sessionsDir,
      defaultSessionId: PARENT,
    });
    expect(proofs[0]?.sessionId).toBe(PARENT);
  });

  test("missing id rejects with the instructive design error text", async () => {
    logEvents(PARENT, toolPair("tu_real"));
    await expect(
      verifyEvidence([{ toolUseId: "tu_fake", sessionId: PARENT }], {
        sessionRootDir: sessionsDir,
      }),
    ).rejects.toThrow(
      "no verified evidence for tu_fake: run the action first, then complete the step with its toolUseId.",
    );
  });

  test("isError: true results reject — a failed call proves nothing", async () => {
    logEvents(PARENT, toolPair("tu_err", { isError: true }));
    const err = await verifyEvidence([{ toolUseId: "tu_err", sessionId: PARENT }], {
      sessionRootDir: sessionsDir,
    }).catch((e) => e as EvidenceError);
    expect(err).toBeInstanceOf(EvidenceError);
    expect((err as EvidenceError).verdict).toBe("error_result");
    expect((err as EvidenceError).message).toContain("isError: true");
  });

  test("a tool_use with no tool_result counts as missing (the call never finished)", async () => {
    logEvents(PARENT, [{ kind: "tool_use", payload: { id: "tu_hang", name: "Bash", input: {} } }]);
    const err = await verifyEvidence([{ toolUseId: "tu_hang", sessionId: PARENT }], {
      sessionRootDir: sessionsDir,
    }).catch((e) => e as EvidenceError);
    expect((err as EvidenceError).verdict).toBe("missing");
  });

  test("walks sub_agent_start brackets into child (and grandchild) session logs", async () => {
    logEvents(PARENT, [
      { kind: "sub_agent_start", payload: { name: "researcher", childSessionId: CHILD } },
      { kind: "sub_agent_end", payload: { name: "researcher", isError: false } },
    ]);
    logEvents(CHILD, [
      { kind: "sub_agent_start", payload: { name: "nested", childSessionId: GRANDCHILD } },
      { kind: "sub_agent_end", payload: { name: "nested", isError: false } },
    ]);
    logEvents(GRANDCHILD, toolPair("tu_deep", { name: "Fetch", content: "fetched" }));
    const proofs = await verifyEvidence([{ toolUseId: "tu_deep", sessionId: PARENT }], {
      sessionRootDir: sessionsDir,
    });
    expect(proofs[0]?.sessionId).toBe(GRANDCHILD);
    expect(proofs[0]?.toolName).toBe("Fetch");
  });

  test("no session anywhere → missing, even when child logs are absent", async () => {
    logEvents(PARENT, [{ kind: "sub_agent_start", payload: { name: "r", childSessionId: CHILD } }]);
    // CHILD's jsonl was TTL-evicted / never written — must not throw ENOENT.
    await expect(
      verifyEvidence([{ toolUseId: "tu_gone", sessionId: PARENT }], {
        sessionRootDir: sessionsDir,
      }),
    ).rejects.toThrow(/no verified evidence for tu_gone/);
  });

  test("empty refs reject (proven always needs evidence)", async () => {
    await expect(verifyEvidence([], { sessionRootDir: sessionsDir })).rejects.toThrow(
      EvidenceError,
    );
  });

  test("a ref with neither sessionId nor default rejects instructively", async () => {
    await expect(
      verifyEvidence([{ toolUseId: "tu_x" }], { sessionRootDir: sessionsDir }),
    ).rejects.toThrow(/no sessionId to resolve it against/);
  });

  test("result digest collapses whitespace and clips long outputs", async () => {
    logEvents(
      PARENT,
      toolPair("tu_long", { content: `a${" \n\t ".repeat(3)}b ${"x".repeat(500)}` }),
    );
    const proofs = await verifyEvidence([{ toolUseId: "tu_long", sessionId: PARENT }], {
      sessionRootDir: sessionsDir,
    });
    const digest = proofs[0]?.resultDigest ?? "";
    expect(digest.startsWith("a b ")).toBe(true);
    expect(digest.length).toBeLessThanOrEqual(240);
    expect(digest.endsWith("…")).toBe(true);
  });

  test("block-array tool_result content digests its text blocks", async () => {
    logEvents(PARENT, [
      { kind: "tool_use", payload: { id: "tu_blocks", name: "Screenshot", input: {} } },
      {
        kind: "tool_result",
        payload: {
          toolUseId: "tu_blocks",
          content: [
            { type: "text", text: "first" },
            { type: "image", source: {} },
            { type: "text", text: "second" },
          ],
          isError: false,
        },
      },
    ]);
    const proofs = await verifyEvidence([{ toolUseId: "tu_blocks", sessionId: PARENT }], {
      sessionRootDir: sessionsDir,
    });
    expect(proofs[0]?.resultDigest).toBe("first second");
  });
});

describe("resolveEvidence (non-throwing)", () => {
  test("returns one verdict per ref, in order", async () => {
    logEvents(PARENT, [...toolPair("tu_ok"), ...toolPair("tu_bad", { isError: true })]);
    const res = await resolveEvidence(
      [
        { toolUseId: "tu_ok", sessionId: PARENT },
        { toolUseId: "tu_bad", sessionId: PARENT },
        { toolUseId: "tu_nope", sessionId: PARENT },
      ],
      { sessionRootDir: sessionsDir },
    );
    expect(res.map((r) => r.verdict)).toEqual(["verified", "error_result", "missing"]);
    expect(res[0]?.proof?.toolUseId).toBe("tu_ok");
    expect(res[1]?.proof).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// design/0.8.0 §6.3 — a log that cannot be read to its end is read up to the
// bad line, as provability's `checked` rung reads it; never a raw throw
// ---------------------------------------------------------------------------

/** A crash mid-append: half a JSON line, no newline. */
function tearLog(sessionId: string): void {
  appendFileSync(
    join(sessionsDir, `${sessionId}.jsonl`),
    '{"ts":9,"version":1,"kind":"assistant_mess',
  );
}

describe("resolveEvidence — a session log that cannot be read to its end", () => {
  test("a torn line AFTER a verified pair: the id still verifies, and the log is reported once", async () => {
    logEvents(PARENT, toolPair("tu_sum", { name: "MoneyAdd", content: "1284.50" }));
    tearLog(PARENT);
    const unreadable: Array<{ sessionId: string; message: string }> = [];
    const res = await resolveEvidence(
      [
        { toolUseId: "tu_sum", sessionId: PARENT },
        { toolUseId: "tu_sum", sessionId: PARENT },
      ],
      { sessionRootDir: sessionsDir, onUnreadable: (i) => unreadable.push(i) },
    );
    expect(res.map((r) => r.verdict)).toEqual(["verified", "verified"]);
    expect(res[0]?.proof?.resultDigest).toBe("1284.50");
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]?.sessionId).toBe(PARENT);
    expect(unreadable[0]?.message).toMatch(/malformed JSON on line 3/);
    // The throwing wrapper the proven transition uses agrees.
    const proofs = await verifyEvidence([{ toolUseId: "tu_sum", sessionId: PARENT }], {
      sessionRootDir: sessionsDir,
    });
    expect(proofs[0]?.toolName).toBe("MoneyAdd");
  });

  test("an id the torn line cuts off is missing — a verdict naming the log, not a RuntimeError", async () => {
    logEvents(PARENT, [{ kind: "tool_use", payload: { id: "tu_cut", name: "Bash", input: {} } }]);
    tearLog(PARENT);
    // The result was appended after the tear; the reader never gets to it.
    appendFileSync(
      join(sessionsDir, `${PARENT}.jsonl`),
      `\n${JSON.stringify({ ts: 10, version: 1, kind: "tool_result", payload: { toolUseId: "tu_cut", content: "ok", isError: false } })}\n`,
    );
    const [res] = await resolveEvidence([{ toolUseId: "tu_cut", sessionId: PARENT }], {
      sessionRootDir: sessionsDir,
    });
    expect(res?.verdict).toBe("missing");
    expect(res?.detail).toContain(
      `no verified evidence for tu_cut: the session log ${PARENT} could not be read to its end (event-log: malformed JSON on line 2 of`,
    );
    expect(res?.detail).toContain(
      "and tu_cut does not resolve before that point. Run the action again, then complete the step with the new toolUseId.",
    );
    const err = await verifyEvidence([{ toolUseId: "tu_cut", sessionId: PARENT }], {
      sessionRootDir: sessionsDir,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvidenceError);
    expect((err as EvidenceError).verdict).toBe("missing");
    expect((err as EvidenceError).toolUseId).toBe("tu_cut");
  });

  test("a torn child log does not stop the walk: a sibling child still resolves", async () => {
    logEvents(PARENT, [
      { kind: "sub_agent_start", payload: { name: "a", childSessionId: CHILD } },
      { kind: "sub_agent_start", payload: { name: "b", childSessionId: GRANDCHILD } },
    ]);
    logEvents(CHILD, [{ kind: "tool_use", payload: { id: "tu_x", name: "Bash", input: {} } }]);
    tearLog(CHILD);
    logEvents(GRANDCHILD, toolPair("tu_fetch", { name: "Fetch", content: "fetched" }));
    const unreadable: string[] = [];
    const proofs = await verifyEvidence([{ toolUseId: "tu_fetch", sessionId: PARENT }], {
      sessionRootDir: sessionsDir,
      onUnreadable: (i) => unreadable.push(i.sessionId),
    });
    expect(proofs[0]?.sessionId).toBe(GRANDCHILD);
    expect(unreadable).toEqual([CHILD]);
  });

  test("a link where the log should be is refused by event-log — reported as missing, not thrown", async () => {
    const real = join(tmp, "elsewhere.jsonl");
    writeFileSync(
      real,
      toolPair("tu_linked")
        .map((ev, i) => JSON.stringify({ ts: i, version: 1, ...ev }))
        .join("\n"),
    );
    symlinkSync(real, join(sessionsDir, `${PARENT}.jsonl`));
    const [res] = await resolveEvidence([{ toolUseId: "tu_linked", sessionId: PARENT }], {
      sessionRootDir: sessionsDir,
    });
    expect(res?.verdict).toBe("missing");
    expect(res?.detail).toContain(`the session log ${PARENT} could not be read to its end`);
  });
});

describe("appendRetentionPins", () => {
  test("creates retention.json with pins when absent", async () => {
    const path = join(tmp, "retention.json");
    const { added } = await appendRetentionPins([PARENT], path, tmp);
    expect(added).toEqual([PARENT]);
    const config = JSON.parse(readFileSync(path, "utf8")) as { version: number; pins: string[] };
    expect(config.version).toBe(1);
    expect(config.pins).toEqual([PARENT]);
  });

  test("preserves existing keys verbatim and dedupes pins", async () => {
    const path = join(tmp, "retention.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        sessions: { maxAgeDays: 60 },
        pins: [PARENT],
        auditWindows: [{ frameworkId: "soc2", controlId: "CC6.1", expiresAt: "2027-01-01" }],
      }),
    );
    const { added } = await appendRetentionPins([PARENT, CHILD], path, tmp);
    expect(added).toEqual([CHILD]);
    const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect((config["sessions"] as { maxAgeDays: number }).maxAgeDays).toBe(60);
    expect(config["pins"]).toEqual([PARENT, CHILD]);
    expect(Array.isArray(config["auditWindows"])).toBe(true);
  });

  test("no-op (no rewrite) when every pin already exists", async () => {
    const path = join(tmp, "retention.json");
    writeFileSync(path, JSON.stringify({ pins: [PARENT] }));
    const before = readFileSync(path, "utf8");
    const { added } = await appendRetentionPins([PARENT], path, tmp);
    expect(added).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("invalid session ids are never written as pins", async () => {
    const path = join(tmp, "retention.json");
    const { added } = await appendRetentionPins(["../../etc/passwd", "sess_nothex"], path, tmp);
    expect(added).toEqual([]);
  });

  test("malformed retention.json fails closed with an instructive error", async () => {
    const path = join(tmp, "retention.json");
    writeFileSync(path, "{not json");
    await expect(appendRetentionPins([PARENT], path, tmp)).rejects.toThrow(/malformed JSON/);
  });
});
