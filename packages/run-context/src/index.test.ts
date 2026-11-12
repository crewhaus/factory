import { describe, expect, test } from "bun:test";
import { CANONICAL_RUN_ID_RE, mintId, mintRunId } from "@crewhaus/control-contract";
import { type LogFields, type Logger, createLogger } from "@crewhaus/logging";
import { TraceEventBus } from "@crewhaus/trace-event-bus";
import {
  type AgentIdentity,
  DATA_LINEAGE_CAP,
  MAX_TOKEN_TAGS,
  createRunContext,
  formatAgentIdentity,
  lineageOf,
  pushOrigin,
  runWithScope,
  tagContent,
} from "./index";

describe("createRunContext defaults", () => {
  test("generates run/session ids with expected prefixes", () => {
    const ctx = createRunContext();
    // The one canonical run id: `run_` and a 26-character ULID body.
    expect(ctx.runId).toMatch(CANONICAL_RUN_ID_RE);
    // session-store path-traversal guard requires sess_<16 hex>; the
    // default factory matches that format so runtime-core can hand the
    // id straight to sessionStore.create({ id }).
    expect(ctx.sessionId).toMatch(/^sess_[0-9a-f]{16}$/);
  });

  test("starts turnNumber at 0", () => {
    const ctx = createRunContext();
    expect(ctx.turnNumber).toBe(0);
  });

  test("turnNumber is mutable in place", () => {
    const ctx = createRunContext();
    ctx.turnNumber += 1;
    expect(ctx.turnNumber).toBe(1);
  });

  test("default abortSignal is not aborted", () => {
    const ctx = createRunContext();
    expect(ctx.abortSignal.aborted).toBe(false);
  });

  test("two contexts get different run/session ids", () => {
    const a = createRunContext();
    const b = createRunContext();
    expect(a.runId).not.toBe(b.runId);
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  test("logger child binds runId/sessionId on every log line", () => {
    const lines: string[] = [];
    const logger = createLogger({
      format: "json",
      sink: (line) => {
        lines.push(line);
      },
    });
    const ctx = createRunContext({ logger });
    ctx.logger.info("hello");
    expect(lines.length).toBe(1);
    const line = lines[0];
    if (line === undefined) throw new Error("expected a log line");
    const parsed = JSON.parse(line);
    expect(parsed.runId).toBe(ctx.runId);
    expect(parsed.sessionId).toBe(ctx.sessionId);
    expect(parsed.msg).toBe("hello");
  });
});

describe("createRunContext overrides", () => {
  test("custom runId/sessionId pass through verbatim", () => {
    const ctx = createRunContext({ runId: "run_custom", sessionId: "sess_custom" });
    expect(ctx.runId).toBe("run_custom");
    expect(ctx.sessionId).toBe("sess_custom");
  });

  test("custom abortSignal is exposed", () => {
    const ac = new AbortController();
    const ctx = createRunContext({ abortSignal: ac.signal });
    expect(ctx.abortSignal.aborted).toBe(false);
    ac.abort();
    expect(ctx.abortSignal.aborted).toBe(true);
  });
});

describe("createRunContext eventBus", () => {
  test("default eventBus carries the run/session ids", () => {
    const ctx = createRunContext();
    expect(ctx.eventBus).toBeInstanceOf(TraceEventBus);
    expect(ctx.eventBus.runId).toBe(ctx.runId);
    expect(ctx.eventBus.sessionId).toBe(ctx.sessionId);
  });

  test("custom eventBus is wired through verbatim", () => {
    const bus = new TraceEventBus({ runId: "run_custom", sessionId: "sess_custom" });
    const ctx = createRunContext({ runId: "run_custom", sessionId: "sess_custom", eventBus: bus });
    expect(ctx.eventBus).toBe(bus);
  });
});

describe("pushOrigin", () => {
  test("appends to undefined originStack", () => {
    const ctx = createRunContext();
    const next = pushOrigin(ctx, "subagent");
    expect(next.originStack).toEqual(["subagent"]);
    expect(ctx.originStack).toBeUndefined();
  });

  test("appends to existing originStack without mutating input", () => {
    const ctx = createRunContext({ originStack: ["subagent"] });
    const next = pushOrigin(ctx, "mcp");
    expect(next.originStack).toEqual(["subagent", "mcp"]);
    expect(ctx.originStack).toEqual(["subagent"]);
  });
});

describe("tagContent (Pillar 3 data-lineage)", () => {
  test("lazy-creates dataLineage on first tag", () => {
    const ctx = createRunContext();
    expect(ctx.dataLineage).toBeUndefined();
    tagContent(ctx, "subagent-returned payload of meaningful length", "subagent");
    expect(ctx.dataLineage).toBeInstanceOf(Map);
    expect(ctx.dataLineage?.size).toBe(1);
  });

  test("records origin per tagged string", () => {
    const ctx = createRunContext();
    tagContent(ctx, "first tagged string from a subagent return", "subagent");
    tagContent(ctx, "second tagged string from an MCP tool result", "mcp");
    expect(ctx.dataLineage?.get("first tagged string from a subagent return")).toBe("subagent");
    expect(ctx.dataLineage?.get("second tagged string from an MCP tool result")).toBe("mcp");
  });

  test("ignores content shorter than 16 chars (egress-floor parity)", () => {
    const ctx = createRunContext();
    tagContent(ctx, "tiny", "subagent");
    expect(ctx.dataLineage).toBeUndefined();
  });

  test("re-tagging refreshes recency (most-recent insertion order)", () => {
    const ctx = createRunContext();
    tagContent(ctx, "first string of taggable length here", "subagent");
    tagContent(ctx, "second string of taggable length here", "mcp");
    tagContent(ctx, "first string of taggable length here", "subagent"); // refresh
    const keys = [...(ctx.dataLineage?.keys() ?? [])];
    // After refresh, "first..." should be the most-recent (last in iteration).
    expect(keys[keys.length - 1]).toBe("first string of taggable length here");
  });

  test("evicts oldest beyond DATA_LINEAGE_CAP", () => {
    const ctx = createRunContext();
    for (let i = 0; i < DATA_LINEAGE_CAP + 5; i++) {
      tagContent(ctx, `tagged string number ${i.toString().padStart(4, "0")} payload`, "subagent");
    }
    expect(ctx.dataLineage?.size).toBe(DATA_LINEAGE_CAP);
    // The first 5 should have been evicted.
    expect(ctx.dataLineage?.has("tagged string number 0000 payload")).toBe(false);
    expect(ctx.dataLineage?.has("tagged string number 0004 payload")).toBe(false);
    expect(ctx.dataLineage?.has("tagged string number 0005 payload")).toBe(true);
  });

  test("ignores non-string input gracefully", () => {
    const ctx = createRunContext();
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime guard
    tagContent(ctx, 123 as any, "subagent");
    expect(ctx.dataLineage).toBeUndefined();
  });

  // SECURITY: partial-reflection coverage. A secret line copied out of a large
  // multi-line response must still be attributed — whole-blob-only tagging
  // missed it because the fragment isn't the full tagged string.
  test("tags each substantial line of a multi-line blob", () => {
    const ctx = createRunContext();
    const blob = [
      "here is a long unremarkable preamble line",
      "API_KEY=sk-supersecret-value-1234567890",
      "and a trailing unremarkable footer line",
    ].join("\n");
    tagContent(ctx, blob, "mcp");
    expect(ctx.dataLineage?.get(blob)).toBe("mcp");
    // Reflecting JUST the secret line is now still attributed to mcp.
    expect(ctx.dataLineage?.get("API_KEY=sk-supersecret-value-1234567890")).toBe("mcp");
  });

  test("single-line content still yields exactly one lineage entry", () => {
    const ctx = createRunContext();
    tagContent(ctx, "a single line of clearly taggable length", "subagent");
    expect(ctx.dataLineage?.size).toBe(1);
  });

  test("skips lines under the 16-char floor", () => {
    const ctx = createRunContext();
    tagContent(ctx, "this whole blob is definitely long enough\nshort\n", "mcp");
    expect(ctx.dataLineage?.has("short")).toBe(false);
  });
});

// SECURITY (audit follow-up R2): credential-shaped TOKEN tagging. Line pieces
// miss the realistic exfil unit — the model extracting just the secret out of
// its line — because the fragment isn't the full tagged line.
describe("tagContent — token-level tagging", () => {
  test("tags a credential-prefixed token embedded mid-line", () => {
    const ctx = createRunContext();
    tagContent(ctx, "The deploy key is sk-AbC123xyz9 — do not share it.", "mcp");
    expect(ctx.dataLineage?.get("sk-AbC123xyz9")).toBe("mcp");
  });

  test("tags long hex runs and UUIDs but not short hex", () => {
    const ctx = createRunContext();
    tagContent(
      ctx,
      "session deadbeefcafe123456789abc opened for 550e8400-e29b-41d4-a716-446655440000 (ref a1b2c3d4)",
      "tool",
    );
    expect(ctx.dataLineage?.has("deadbeefcafe123456789abc")).toBe(true);
    expect(ctx.dataLineage?.has("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(ctx.dataLineage?.has("a1b2c3d4")).toBe(false);
  });

  test("tags base64-ish runs only with mixed character classes", () => {
    const ctx = createRunContext();
    tagContent(
      ctx,
      "blob QWxhZGRpbjpvcGVuIHNlc2FtZQ9x here, word internationalizations there",
      "tool",
    );
    expect(ctx.dataLineage?.has("QWxhZGRpbjpvcGVuIHNlc2FtZQ9x")).toBe(true);
    expect(ctx.dataLineage?.has("internationalizations")).toBe(false);
  });

  test("tags values of secret-keyed assignments regardless of shape", () => {
    const ctx = createRunContext();
    tagContent(ctx, "config loaded: password=hunter2-x9 region=us-east-1a", "tool");
    expect(ctx.dataLineage?.get("hunter2-x9")).toBe("tool");
    // A value under a non-secret key is NOT tagged.
    expect(ctx.dataLineage?.has("us-east-1a")).toBe(false);
  });

  test("does NOT tag ordinary identifiers (no charset-diversity heuristic)", () => {
    const ctx = createRunContext();
    tagContent(ctx, "function parseData12(myVar123: Config456) { return myVar123; }", "tool");
    // Only the whole blob qualifies — none of the identifiers are
    // credential-shaped, so no token pieces exist.
    expect(ctx.dataLineage?.size).toBe(1);
  });

  test("caps token tags at MAX_TOKEN_TAGS, keeping the longest", () => {
    const ctx = createRunContext();
    const tokens = Array.from({ length: 24 }, (_, i) => `ghp_${"a".repeat(10 + i)}Z9`);
    tagContent(ctx, tokens.join(" "), "mcp");
    // Match single tokens only — the whole blob also starts with "ghp_".
    const tokenEntries = [...(ctx.dataLineage?.keys() ?? [])].filter((k) => /^ghp_a+Z9$/.test(k));
    expect(tokenEntries.length).toBe(MAX_TOKEN_TAGS);
    // The longest candidate survived the cap.
    expect(ctx.dataLineage?.has(`ghp_${"a".repeat(33)}Z9`)).toBe(true);
  });

  test("CREWHAUS_DISABLE_TOKEN_LINEAGE=1 disables token pieces (escape hatch)", () => {
    const prev = process.env["CREWHAUS_DISABLE_TOKEN_LINEAGE"];
    process.env["CREWHAUS_DISABLE_TOKEN_LINEAGE"] = "1";
    try {
      const ctx = createRunContext();
      tagContent(ctx, "The deploy key is sk-AbC123xyz9 — do not share it.", "mcp");
      expect(ctx.dataLineage?.has("sk-AbC123xyz9")).toBe(false);
      // Blob/line tagging still applies.
      expect(ctx.dataLineage?.size).toBe(1);
    } finally {
      process.env["CREWHAUS_DISABLE_TOKEN_LINEAGE"] = prev ?? "";
    }
  });
});

describe("tagContent — the value of a NAME=value line", () => {
  // Secret-shaped values are built from parts at runtime.
  const githubPat = `${"gh"}${"p_"}${"a1B2c3D4".repeat(4)}`;
  const stripeKey = `${"sk_"}${"live_"}${"e5F6g7H8".repeat(3)}`;
  const awsKeyId = `${"AK"}${"IA"}${"QWERTY234567ASDF"}`;
  const pemBody = `${"MI"}${"IE"}${"vQIBADANBgkqhkiG9w0BAQEFAASC"}`;

  test("a credential-shaped value is tagged on its own, whatever the name", () => {
    for (const [name, value] of [
      ["GITHUB_PAT", githubPat],
      ["STRIPE", stripeKey],
      ["AWS_ACCESS_KEY_ID", awsKeyId],
      ["GH_APP_PEM", pemBody],
    ] as const) {
      const ctx = createRunContext();
      tagContent(ctx, `# read from the file\n${name}=${value}\n`, "tool");
      expect({ name, origin: ctx.dataLineage?.get(value) }).toEqual({ name, origin: "tool" });
    }
  });

  test("quotes and a leading export are read past", () => {
    const ctx = createRunContext();
    tagContent(ctx, `GITHUB_PAT="${githubPat}"\nexport STRIPE='${stripeKey}'`, "tool");
    expect(ctx.dataLineage?.get(githubPat)).toBe("tool");
    expect(ctx.dataLineage?.get(stripeKey)).toBe("tool");
  });

  test("a value with no credential shape is not tagged", () => {
    const ctx = createRunContext();
    tagContent(ctx, "see LOG_LEVEL=debug-verbose-mode for details", "tool");
    expect(ctx.dataLineage?.has("debug-verbose-mode")).toBe(false);
    expect(ctx.dataLineage?.size).toBe(1);
  });

  test("a secret-named line keeps its value tagged", () => {
    const ctx = createRunContext();
    const value = `${"sk-"}${"ant-"}${"i9J0k1L2".repeat(3)}`;
    tagContent(ctx, `ANTHROPIC_API_KEY=${value}`, "tool");
    expect(ctx.dataLineage?.get(value)).toBe("tool");
  });

  test("a URL's query value stays inside its token", () => {
    const cursor = `${"ey"}${"J"}${"hbGciOiJIUzI1NiJ9abcDEF"}`;
    const ctx = createRunContext();
    tagContent(ctx, `next page: https://api.example.com/items?cursor=${cursor} and more`, "tool");
    expect(ctx.dataLineage?.has(cursor)).toBe(false);
  });

  test("only an upper-case name counts as NAME=value", () => {
    const cursor = `${"ey"}${"J"}${"hbGciOiJIUzI1NiJ9abcDEF"}`;
    const ctx = createRunContext();
    tagContent(ctx, `first cursor=${cursor} then the rest of the sentence`, "tool");
    expect(ctx.dataLineage?.has(cursor)).toBe(false);
    expect(ctx.dataLineage?.has(`cursor=${cursor}`)).toBe(true);
  });

  test("eight lines take eight token tags, not more", () => {
    const values = Array.from(
      { length: 8 },
      (_, i) => `${"gh"}${"p_"}${"m3N4p5Q6".repeat(3)}${i}x`,
    );
    const content = values.map((value, i) => `SERVICE_${i}=${value}`).join("\n");
    const ctx = createRunContext();
    tagContent(ctx, content, "tool");
    const keys = [...(ctx.dataLineage?.keys() ?? [])];
    // The whole blob, each line once, and each value once.
    expect(keys.length).toBe(1 + 8 + 8);
    expect(keys.filter((k) => values.includes(k)).length).toBe(8);
  });

  test("a pair takes no token slot, so a full cap holds that many values", () => {
    const values = Array.from(
      { length: MAX_TOKEN_TAGS },
      (_, i) => `${"Secret"}${"Value"}9x${"a".repeat(30)}${i}`,
    );
    const content = values.map((value, i) => `SERVICE_${i}_TOKEN=${value}`).join("\n");
    const ctx = createRunContext();
    tagContent(ctx, content, "tool");
    expect(values.filter((value) => ctx.dataLineage?.get(value) !== "tool")).toEqual([]);
  });
});

describe("tagContent — the value of an assignment, wherever it sits in its token", () => {
  // Built from parts at runtime.
  const secret = `${"gh"}${"p_"}${"a1B2c3D4".repeat(4)}`;
  const shaped = `${"Zx9"}${"kQ2w".repeat(7)}`;

  const tagsAlone = (text: string, value: string = secret): boolean => {
    const ctx = createRunContext();
    tagContent(ctx, text, "tool");
    return ctx.dataLineage?.has(value) === true;
  };

  const forms: ReadonlyArray<readonly [string, string]> = [
    ["a file:line: prefix", `deploy.conf:2:GITHUB_PAT=${secret}`],
    ["a commented-out line", `#OLD_PAT=${secret}`],
    ["a patch's added line", `+GITHUB_PAT=${secret}`],
    ["a leading underscore", `_GITHUB_PAT=${secret}`],
    ["`:=`", `GITHUB_PAT:=${secret}`],
    ["`?=`", `GITHUB_PAT?=${secret}`],
    ["`+=`", `GITHUB_PAT+=${secret}`],
    ["`:`", `GITHUB_PAT:${secret}`],
    ["a flag", `--env=GITHUB_PAT=${secret}`],
    ["a shell's scope", `$env:GITHUB_PAT=${secret}`],
    ["a name assigned to a name", `GITHUB_PAT=PREFIX=${secret}`],
    ["a quoted key", `"GITHUB_PAT":"${secret}"`],
  ];
  for (const [name, text] of forms) {
    test(`${name}: the value is tagged alone`, () => {
      expect(tagsAlone(text)).toBe(true);
      // A value with no well-known prefix takes the same path.
      expect(tagsAlone(text.replace(secret, shaped), shaped)).toBe(true);
    });
  }

  test("minified JSON: a string leaf is read", () => {
    expect(tagsAlone(`{"GITHUB_PAT":"${secret}"}`)).toBe(true);
    expect(tagsAlone(JSON.stringify({ env: `GITHUB_PAT=${shaped}` }), shaped)).toBe(true);
    expect(tagsAlone(JSON.stringify([{ deep: [{ text: shaped }] }]), shaped)).toBe(true);
  });

  test("JSON that does not parse: an escaped line break still starts a new token", () => {
    const cut = `{"patch":"diff\\n+++ b/deploy.conf\\nGITHUB_PAT=${shaped}\\nDEBUG=1`;
    expect(tagsAlone(cut, shaped)).toBe(true);
    expect(tagsAlone(`{"patch":"x\\n+GITHUB_PAT=${shaped}`, shaped)).toBe(true);
  });

  test("the tail of a longer word is not a name", () => {
    expect(tagsAlone(`fooBAR=${shaped}`, shaped)).toBe(false);
    expect(tagsAlone(`foo_BAR=${shaped}`, shaped)).toBe(false);
    expect(tagsAlone(`1BAR=${shaped}`, shaped)).toBe(false);
  });

  test("a URL's query stays whole, in either case", () => {
    expect(tagsAlone(`https://example.test/list?cursor=${shaped}`, shaped)).toBe(false);
    expect(tagsAlone(`https://example.test/list?CURSOR=${shaped}`, shaped)).toBe(false);
    expect(tagsAlone(`https://example.test/list?a=1&CURSOR=${shaped}`, shaped)).toBe(false);
  });

  test("a base64 value's own tail does not hide the value", () => {
    const padded = `${shaped}/ABC=`;
    expect(tagsAlone(`GITHUB_PAT=${padded}`, padded)).toBe(true);
  });

  test("a token of nothing but assignments is read to its end and tags nothing", () => {
    // A value test per assignment would be quadratic here; only the last few
    // are read. bun's per-test deadline is what fails if that stops holding.
    const ctx = createRunContext();
    tagContent(ctx, "A=".repeat(200_000), "tool");
    expect([...(ctx.dataLineage?.keys() ?? [])].every((k) => k.startsWith("A=A=A="))).toBe(true);
  });
});

describe("formatAgentIdentity", () => {
  test("undefined identity renders as <top-level>", () => {
    expect(formatAgentIdentity(undefined)).toBe("<top-level>");
  });

  test("empty identity object renders as <top-level>", () => {
    expect(formatAgentIdentity({})).toBe("<top-level>");
  });

  test("renders a single skillId field", () => {
    expect(formatAgentIdentity({ skillId: "code-review" })).toBe("skill=code-review");
  });

  test("renders a single subAgentId field", () => {
    expect(formatAgentIdentity({ subAgentId: "sub-7" })).toBe("subagent=sub-7");
  });

  test("renders a single roleId field", () => {
    expect(formatAgentIdentity({ roleId: "reviewer" })).toBe("role=reviewer");
  });

  test("joins all present fields in skill;subagent;role order", () => {
    const id: AgentIdentity = { skillId: "s1", subAgentId: "a1", roleId: "r1" };
    expect(formatAgentIdentity(id)).toBe("skill=s1;subagent=a1;role=r1");
  });

  test("omits undefined fields while keeping order for the rest", () => {
    expect(formatAgentIdentity({ skillId: "s1", roleId: "r1" })).toBe("skill=s1;role=r1");
  });
});

/** A logger that counts its warnings, whatever child it is asked for. */
function countingLogger(): { logger: Logger; warns: Array<{ msg: string; fields?: LogFields }> } {
  const warns: Array<{ msg: string; fields?: LogFields }> = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg, fields) => {
      warns.push({ msg, ...(fields !== undefined ? { fields } : {}) });
    },
    error: () => {},
    child: () => logger,
  };
  return { logger, warns };
}

describe("run lineage", () => {
  test("options set every lineage field, and an unset one is absent", () => {
    const wi = mintId("wi");
    const parent = mintRunId();
    const ctx = createRunContext({
      parent,
      resumeScope: `run:${parent}`,
      continues: parent,
      workItem: wi,
      trigger: { kind: "schedule", lane: "schedule" },
    });
    expect(ctx.parent).toBe(parent);
    expect(ctx.resumeScope).toBe(`run:${parent}`);
    expect(ctx.continues).toBe(parent);
    expect(ctx.workItem).toBe(wi);
    expect(ctx.trigger).toEqual({ kind: "schedule", lane: "schedule" });
    const bare = createRunContext({ trigger: { kind: "cli" } });
    expect(Object.keys(bare).filter((k) => k === "parent" || k === "workItem")).toEqual([]);
  });

  test("a resumeScope that does not fit its grammar is dropped, with one warning naming the field", () => {
    const { logger, warns } = countingLogger();
    const ctx = createRunContext({ logger, resumeScope: "job:has a space" });
    expect("resumeScope" in ctx).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields).toEqual({ field: "resumeScope" });
    // The value is never echoed.
    expect(JSON.stringify(warns)).not.toContain("has a space");
  });

  test("a workItem that does not fit its grammar is dropped, with one warning naming the field", () => {
    const { logger, warns } = countingLogger();
    const ctx = createRunContext({ logger, workItem: "work-42" });
    expect("workItem" in ctx).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields).toEqual({ field: "workItem" });
    expect(JSON.stringify(warns)).not.toContain("work-42");
  });

  test("a misfit from the ambient scope is dropped the same way, and a fitting one warns nothing", () => {
    const { logger, warns } = countingLogger();
    const dropped = runWithScope({ resumeScope: "lane:nightly", workItem: "wi_nope" }, () =>
      createRunContext({ logger }),
    );
    expect("resumeScope" in dropped).toBe(false);
    expect("workItem" in dropped).toBe(false);
    expect(warns.map((w) => w.fields?.["field"])).toEqual(["resumeScope", "workItem"]);
    const kept = runWithScope({ resumeScope: "lane:schedule:nightly" }, () =>
      createRunContext({ logger }),
    );
    expect(kept.resumeScope).toBe("lane:schedule:nightly");
    expect(warns).toHaveLength(2);
  });

  test("lineageOf names the parent and carries resumeScope, trigger and workItem, never continues", () => {
    const wi = mintId("wi");
    const root = mintRunId();
    const parent = createRunContext({
      resumeScope: `work:${wi}`,
      trigger: { kind: "queue" },
      workItem: wi,
      continues: root,
      parent: root,
    });
    expect(lineageOf(parent)).toEqual({
      parent: parent.runId,
      resumeScope: `work:${wi}`,
      trigger: { kind: "queue" },
      workItem: wi,
    });
    const child = createRunContext(lineageOf(parent));
    expect(child.parent).toBe(parent.runId);
    expect("continues" in child).toBe(false);
    // A parent with no lineage gives its child only `parent`.
    const plain = createRunContext();
    expect(lineageOf(plain)).toEqual({ parent: plain.runId });
  });
});
