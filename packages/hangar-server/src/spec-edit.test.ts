/**
 * The spec's write side, its trust tiers, and the builders.
 *
 * The load-bearing assertions here are about REFUSALS and SIDE EFFECTS, not
 * payload shapes:
 *
 *   - a human-owned path cannot be written without the typed confirmation,
 *     and the refusal names the review route (the tier split is enforced on
 *     the SERVER — a UI-only badge would be decoration);
 *   - a preview never touches the file, and a rejected batch leaves the spec
 *     byte-identical (there is no half-applied state);
 *   - the effective-config viewer marks a materialized default as
 *     `default`, because echoing raw YAML is the thing it replaces;
 *   - a credential literal or a never-expanding `$VAR` in an MCP env map is
 *     REFUSED, not masked-and-stored;
 *   - pins/rollbacks shell the audited `deploy` verb rather than writing
 *     `manifest.json`, so the argv itself is the contract.
 *
 * No fixture here carries a realistic secret: the one credential-shaped
 * literal is built from string parts at runtime.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  lintMcpEnv,
  looksLikeCredential,
  newlyMaskedSpan,
  scanGraders,
  scanMcpServers,
  sseUrlCredential,
} from "./builders";
import { makeFixtureHarness } from "./fixture";
import {
  classifyPath,
  declaredPaths,
  effectiveConfig,
  isAutoTunable,
  provenanceOf,
  registryDirName,
  renderDiff,
} from "./spec-edit";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");

/** A VALID cli spec — the fixture synthesizer's default one deliberately is
 *  not, and half of this surface only means anything on a spec that parses. */
const VALID_SPEC = [
  "name: spec-edit-fixture",
  "target: cli",
  "agent:",
  "  model: anthropic/claude-sonnet-4",
  "  instructions: |",
  "    You are a fixture. Answer briefly.",
  "    Note: this line is prose, not a key.",
  "  max_tokens: 4096",
  "permissions:",
  "  mode: default",
  "memory:",
  "  enabled: true",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// pure units
// ---------------------------------------------------------------------------

describe("the lenient path scan", () => {
  test("block-scalar prose never becomes a path", () => {
    const paths = declaredPaths(VALID_SPEC).map((p) => p.join("."));
    expect(paths).toContain("agent.instructions");
    expect(paths).toContain("agent.max_tokens");
    // `Note: this line is prose` sits inside the block scalar.
    expect(paths.some((p) => p.includes("Note"))).toBe(false);
  });

  test("nesting is tracked by indentation, and siblings pop the stack", () => {
    expect(declaredPaths(VALID_SPEC).map((p) => p.join("."))).toEqual([
      "name",
      "target",
      "agent",
      "agent.model",
      "agent.instructions",
      "agent.max_tokens",
      "permissions",
      "permissions.mode",
      "memory",
      "memory.enabled",
    ]);
  });

  test("a sequence's items are represented by their container, never by index", () => {
    const yaml = [
      "name: x",
      "target: workflow",
      "steps:",
      "  - name: draft",
      "    tools:",
      "      - Fetch",
      "",
    ].join("\n");
    expect(declaredPaths(yaml).map((p) => p.join("."))).toEqual(["name", "target", "steps"]);
  });

  test("a spec a schema version ahead still yields its paths", () => {
    const yaml = ["name: x", "target: cli", "some_future_block:", "  knob: 1", ""].join("\n");
    expect(declaredPaths(yaml).map((p) => p.join("."))).toContain("some_future_block.knob");
  });
});

describe("trust tiers", () => {
  test("agent.instructions is auto-tunable on cli — the same rule the optimizer runs under", () => {
    expect(isAutoTunable("cli", ["agent", "instructions"])).toBe(true);
    expect(classifyPath("cli", ["agent", "instructions"]).tier).toBe("auto-tunable");
  });

  test("permissions and the model roster are human-owned SECURITY surfaces", () => {
    for (const path of [["permissions", "mode"], ["agent", "model"], ["watchme"], ["plugins"]]) {
      const row = classifyPath("cli", path);
      expect(`${path.join(".")}:${row.tier}:${row.securitySurface}`).toBe(
        `${path.join(".")}:human-owned:true`,
      );
      expect(row.reason.length).toBeGreaterThan(10);
    }
  });

  test("a SECURITY surface stays human-owned even when OPTIMIZABLE_PATHS lists it", () => {
    // `transaction_policy`, `chains`, `security.*` and the `model_pool`
    // policy knobs are in BOTH tables. Reading OPTIMIZABLE_PATHS first made
    // the SECURITY_SURFACES rows dead for exactly the paths they were
    // written to gate: the on-chain value ceiling could be raised, and
    // pre-broadcast simulation switched off, with no typed confirmation.
    for (const path of [
      ["transaction_policy"],
      ["transaction_policy", "maxValueWei"],
      ["transaction_policy", "simulationRequired"],
      ["chains"],
      ["chains", "0", "rpcUrls"],
      ["security", "justification"],
      ["agent", "model_pool", "policy"],
    ]) {
      const row = classifyPath("cli", path);
      expect(`${path.join(".")}:${row.tier}:${row.securitySurface}`).toBe(
        `${path.join(".")}:human-owned:true`,
      );
    }
    // The OPTIMIZER's whitelist is untouched — the two tables answer
    // different questions, and the badge's reason says which is which.
    expect(isAutoTunable("cli", ["transaction_policy"])).toBe(true);
    expect(classifyPath("cli", ["transaction_policy"]).reason).toContain("typed confirmation");
  });

  test("a container of tunable fields is itself human-owned, and says why", () => {
    const row = classifyPath("cli", ["agent"]);
    expect(row.tier).toBe("human-owned");
    expect(row.securitySurface).toBe(false);
    expect(row.reason).toContain("auto-tunable");
  });

  // 0.6.0 (design §8.3) — the hybrid-model surfaces demand the interstitial
  // on EVERY host the block hangs off, and a wildcard covers the dynamic key.
  test("models, model_pool.{rules,strategy,reward} and sub_agents.*.allowed_profiles are SECURITY surfaces on every host", () => {
    for (const [target, path] of [
      ["cli", ["models"]],
      ["cli", ["models", "fast", "model"]],
      ["cli", ["models", "fast", "max_tokens"]], // an optimizer dial — still gated for a console click
      ["cli", ["agent", "model_pool", "rules", "0", "use"]],
      ["cli", ["agent", "model_pool", "strategy", "cascade", "escalate_to"]],
      ["cli", ["agent", "model_pool", "reward", "floor", "arm"]],
      ["workflow", ["steps", "0", "model_pool", "rules", "0", "enabled"]],
      ["graph", ["nodes", "draft", "model_pool", "strategy", "shadow", "sample_rate"]],
      ["crew", ["roles", "lead", "model_pool", "reward"]],
      ["cli", ["agent", "sub_agents", "helper", "allowed_profiles"]],
      ["crew", ["roles", "lead", "sub_agents", "helper", "allowed_profiles", "0"]],
    ] as const) {
      const row = classifyPath(target, [...path]);
      expect(`${target}:${path.join(".")}:${row.tier}:${row.securitySurface}`).toBe(
        `${target}:${path.join(".")}:human-owned:true`,
      );
    }
    // The dial rows say the optimizer may tune them, but the console still confirms.
    expect(classifyPath("cli", ["models", "fast", "max_tokens"]).reason).toContain(
      "typed confirmation",
    );
    // A sibling key outside the listed surfaces is NOT swept in by the wildcard.
    expect(
      classifyPath("cli", ["agent", "sub_agents", "helper", "description"]).securitySurface,
    ).toBe(false);
  });

  // 0.6.0 (design §10.3) — the badge runs spec-patch's OWN matcher, so it
  // honours the wildcard segment and the structural rule the write gate does.
  test("isAutoTunable agrees with the optimizer's matcher: wildcard dials yes, structural prefix reach no", () => {
    expect(isAutoTunable("cli", ["models", "fast", "max_tokens"])).toBe(true);
    expect(isAutoTunable("workflow", ["steps", "0", "model_pool", "rules", "1", "enabled"])).toBe(
      true,
    );
    expect(isAutoTunable("workflow", ["steps", "0", "temperature"])).toBe(true);
    expect(isAutoTunable("graph", ["nodes", "a", "judge", "repeats"])).toBe(true);
    // The hand-rolled prefix copy used to say YES to these and the write then
    // refused them; the structural rule says no to both, consistently.
    expect(isAutoTunable("workflow", ["steps", "0", "model_pool", "candidates"])).toBe(false);
    expect(isAutoTunable("crew", ["roles", "lead", "sub_agents", "helper", "tools"])).toBe(false);
    expect(isAutoTunable("cli", ["models", "fast", "tools"])).toBe(false);
    expect(classifyPath("workflow", ["steps", "0", "model_pool", "candidates"]).tier).toBe(
      "human-owned",
    );
    // Unknown target → never auto-tunable.
    expect(isAutoTunable("not-a-target", ["agent", "instructions"])).toBe(false);
  });

  test("an unknown target has no auto-tunable paths (never a permissive default)", () => {
    expect(isAutoTunable("some-future-target", ["agent", "instructions"])).toBe(false);
  });
});

describe("effective config", () => {
  test("a materialized default is marked `default`, a declared key `declared`", () => {
    const rows = effectiveConfig(
      {
        name: "x",
        target: "cli",
        agent: { model: "m", instructions: "i" },
        compaction: { threshold: 0.8 },
      },
      ["name: x", "target: cli", "agent:", "  model: m", "  instructions: i", ""].join("\n"),
    );
    const byPath = new Map(rows.map((r) => [r.path, r]));
    expect(byPath.get("agent.model")?.source).toBe("declared");
    expect(byPath.get("compaction.threshold")?.source).toBe("default");
    expect(byPath.get("compaction.threshold")?.value).toBe(0.8);
  });

  test("a credential-carrying path renders redacted — the row's key is `value`, so the tree masker cannot see it", () => {
    const rows = effectiveConfig(
      { thredz: { api_key: "not-a-real-key" } },
      "thredz:\n  api_key: not-a-real-key\n",
    );
    expect(rows.find((r) => r.path === "thredz.api_key")?.value).toBe("[redacted]");
  });
});

describe("version registry helpers", () => {
  test("a display name maps onto the registry's directory grammar", () => {
    expect(registryDirName("My Agent")).toBe("My-Agent");
    expect(registryDirName("..")).toBe("spec");
    expect(registryDirName("")).toBe("spec");
  });

  test("optimizer provenance is read off the write-back header", () => {
    const yaml =
      "# crewhaus:optimize runId=run_1 mutator=claude scoreBefore=0.4 scoreAfter=0.8\nname: x\n";
    expect(provenanceOf(yaml)).toEqual({
      runId: "run_1",
      mutator: "claude",
      scoreBefore: 0.4,
      scoreAfter: 0.8,
    });
    expect(provenanceOf("name: x\n")).toBeNull();
  });

  test("a rendered diff names the kind, the path and both sides", () => {
    expect(
      renderDiff([
        { kind: "changed", path: "agent.model", before: '"a"', after: '"b"' },
        { kind: "added", path: "budget.usd", after: "10" },
      ]),
    ).toBe('~ agent.model: "a" → "b"\n+ budget.usd: 10');
  });
});

describe("mcp scanning + lint", () => {
  const yaml = [
    "name: x",
    "target: cli",
    "mcp_servers:",
    "  files:",
    "    transport: stdio",
    "    command: bunx",
    '    args: ["-y", "some-server"]',
    "    env:",
    "      SOME_VAR: $NOT_EXPANDED",
    "  remote:",
    "    transport: sse",
    "    url: https://example.invalid/mcp",
    "budget:",
    "  usd: 10",
    "",
  ].join("\n");

  test("servers, transports and env KEYS are read out of the text", () => {
    const servers = scanMcpServers(yaml);
    expect(servers.map((s) => s.name)).toEqual(["files", "remote"]);
    expect(servers[0]?.command).toBe("bunx");
    expect(servers[0]?.args).toEqual(["-y", "some-server"]);
    expect(servers[0]?.envKeys).toEqual(["SOME_VAR"]);
    expect(servers[1]?.transport).toBe("sse");
    expect(servers[1]?.url).toBe("https://example.invalid/mcp");
  });

  test("the block ends at the next top-level key", () => {
    expect(scanMcpServers(yaml).some((s) => s.name === "budget")).toBe(false);
  });

  test("a $VAR in an env map is flagged as never-expanding, not as unset", () => {
    const findings = lintMcpEnv("files", [{ key: "SOME_VAR", value: "$NOT_EXPANDED" }], () => true);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("never_expands");
    expect(findings[0]?.level).toBe("bad");
  });

  test("a credential-shaped literal is flagged, and an unset name is only a warning", () => {
    // Built from parts: a realistic-looking literal must never be committed.
    const literal = ["sk", "-", "x".repeat(24)].join("");
    expect(looksLikeCredential("SOME_NAME", literal)).toBe(true);
    expect(lintMcpEnv("s", [{ key: "SOME_NAME", value: literal }], () => true)[0]?.code).toBe(
      "credential_literal",
    );
    expect(lintMcpEnv("s", [{ key: "PLAIN", value: "ok" }], () => false)[0]?.code).toBe(
      "unset_env",
    );
    expect(lintMcpEnv("s", [{ key: "PLAIN", value: "ok" }], () => true)).toEqual([]);
  });
});

describe("graders scan", () => {
  test("each list item's name and type survive a file one kind ahead", () => {
    const yaml = [
      "graders:",
      "  - name: cites",
      "    type: contains",
      "    substring: http",
      "  - name: future",
      "    type: some_future_kind",
      "",
    ].join("\n");
    expect(scanGraders(yaml)).toEqual([
      { name: "cites", type: "contains" },
      { name: "future", type: "some_future_kind" },
    ]);
  });

  test("a mask span is only 'newly introduced' when the stored file has fewer of it", () => {
    // The hazard: an editor pane prefilled from a MASKED read, saved back.
    expect(newlyMaskedSpan("substring: real-value\n", "substring: ***\n")).toBe("***");
    expect(newlyMaskedSpan('token: "abc"\n', 'token: "[redacted]"\n')).toBe("[redacted]");
    // An operator's own `***` is theirs to keep — a count, not a substring test.
    expect(
      newlyMaskedSpan("criteria: ***bold***\n", "criteria: ***bold*** and brief\n"),
    ).toBeNull();
    // Nothing stored ⇒ this document cannot be a masked view of anything.
    expect(newlyMaskedSpan("", "substring: ***\n")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the routes
// ---------------------------------------------------------------------------

function boot(): TestServer {
  return bootTestServer({ now: () => NOW });
}

async function register(t: TestServer, dir: string): Promise<string> {
  const res = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  return (res.body["entry"] as { id: string }).id;
}

/** A harness whose spec VALIDATES (the fixture default does not). */
function specHarness(t: TestServer, name: string, yaml = VALID_SPEC): string {
  const dir = makeFixtureHarness(join(t.harnessesRoot, name), {
    specName: "spec-edit-fixture",
    noSpec: true,
  });
  writeFileSync(join(dir, "crewhaus.yaml"), yaml);
  return dir;
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const put = (body: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(body) });

describe("the structured editor", () => {
  test("schema + effective config come back per harness, with defaults distinguished", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "schema");
      const id = await register(t, dir);
      const { status, body } = await t.api(`/api/h/${id}/spec/schema`);
      expect(status).toBe(200);
      expect(body["present"]).toBe(true);
      expect(body["target"]).toBe("cli");
      // No node_modules in the fixture ⇒ the manager's copy answers, and the
      // badge says so rather than pretending the harness's schema was used.
      expect(body["schemaSource"]).toBe("manager");
      expect(String(body["note"])).toContain("@crewhaus/spec");
      const effective = body["effective"] as Array<{ path: string; source: string }>;
      expect(effective.find((r) => r.path === "agent.model")?.source).toBe("declared");
      expect(body["declaredCount"]).toBeGreaterThan(0);
      // The schema is narrowed to this harness's shape but keeps the
      // `definitions` namespace, or its own document-absolute $refs dangle.
      const schema = body["schema"] as { $ref: string; definitions: Record<string, unknown> };
      expect(schema.$ref).toBe("#/definitions/cli");
      expect(schema.definitions["cli"]).toBeDefined();
      expect(JSON.stringify(schema).includes('"#/definitions/workflow')).toBe(false);
      // Compile warnings are the compiler's to produce; the verb is the honest
      // stand-in, never an empty list pretending to be a clean bill.
      expect(body["warningsVerb"]).toContain("crewhaus compile");
    } finally {
      await t.stop();
    }
  });

  test("an invalid spec still renders its trust table and its diagnostics", async () => {
    const t = boot();
    try {
      // Deliberately break the spec: `instructions` at the document root is
      // rejected by the cli schema — exactly the state an editor exists for.
      // (This used to lean on the SHARED fixture being invalid, so fixing the
      // fixture silently emptied the assertion instead of failing it.)
      const dir = makeFixtureHarness(join(t.harnessesRoot, "invalid"), { specName: "invalid" });
      writeFileSync(
        join(dir, "crewhaus.yaml"),
        [
          "name: invalid",
          "target: cli",
          "agent:",
          "  model: claude-opus-5",
          "instructions: |",
          "  rootward",
          "",
        ].join("\n"),
      );
      const id = await register(t, dir);
      const trust = await t.api(`/api/h/${id}/spec/trust`);
      expect(trust.status).toBe(200);
      expect((trust.body["paths"] as unknown[]).length).toBeGreaterThan(0);
      const schema = await t.api(`/api/h/${id}/spec/schema`);
      expect((schema.body["issues"] as unknown[]).length).toBeGreaterThan(0);
      expect(String(schema.body["effectiveNote"])).toContain("until the spec validates");
    } finally {
      await t.stop();
    }
  });

  test("an auto-tunable single patch writes the file, comments intact", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "patch");
      const id = await register(t, dir);
      const { status, body } = await t.api(
        `/api/h/${id}/spec/patch`,
        post({ edit: { path: "agent.instructions", value: "Be extremely brief." } }),
      );
      expect(status).toBe(200);
      expect(body["ok"]).toBe(true);
      expect(body["applied"]).toBe(1);
      const onDisk = readFileSync(join(dir, "crewhaus.yaml"), "utf8");
      expect(onDisk).toContain("Be extremely brief.");
      expect(onDisk).toContain("permissions:");
      expect((body["tiers"] as { autoTunable: unknown[] }).autoTunable).toHaveLength(1);
    } finally {
      await t.stop();
    }
  });

  test("a human-owned path is REFUSED without the typed confirmation, and the refusal names the review route", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "gate");
      const id = await register(t, dir);
      const before = readFileSync(join(dir, "crewhaus.yaml"), "utf8");
      const { status, body } = await t.api(
        `/api/h/${id}/spec`,
        put({ edits: [{ path: "permissions.mode", value: "bypass" }] }),
      );
      expect(status).toBe(409);
      expect(String(body["error"])).toContain("permissions.mode");
      expect(String(body["error"])).toContain("/spec/propose");
      expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(before);
    } finally {
      await t.stop();
    }
  });

  test("the same edit applies once the operator types the spec name", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "confirmed");
      const id = await register(t, dir);
      const { status, body } = await t.api(
        `/api/h/${id}/spec`,
        put({
          edits: [{ path: "permissions.mode", value: "auto" }],
          confirmName: "spec-edit-fixture",
        }),
      );
      expect(status).toBe(200);
      expect(body["applied"]).toBe(1);
      expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toContain("mode: auto");
    } finally {
      await t.stop();
    }
  });

  test("a WRONG typed confirmation is refused", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "wrong-confirm");
      const id = await register(t, dir);
      const { status } = await t.api(
        `/api/h/${id}/spec`,
        put({ edits: [{ path: "permissions.mode", value: "auto" }], confirmName: "not-the-name" }),
      );
      expect(status).toBe(409);
      expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toContain("mode: default");
    } finally {
      await t.stop();
    }
  });

  test("a stale expectedHash refuses instead of overwriting a spec that moved", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "stale");
      const id = await register(t, dir);
      const { status, body } = await t.api(
        `/api/h/${id}/spec`,
        put({ edits: [], expectedHash: "sha256:0000" }),
      );
      expect(status).toBe(409);
      expect(String(body["error"])).toContain("changed on disk");
    } finally {
      await t.stop();
    }
  });

  test("a preview is a pure function of its inputs — the file is untouched", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "preview");
      const id = await register(t, dir);
      const before = readFileSync(join(dir, "crewhaus.yaml"), "utf8");
      const { status, body } = await t.api(
        `/api/h/${id}/spec/diff`,
        post({ edits: [{ path: "agent.model", value: "anthropic/claude-opus-4" }] }),
      );
      expect(status).toBe(200);
      expect(body["autoApplicable"]).toBe(false);
      expect(body["confirmName"]).toBe("spec-edit-fixture");
      expect(body["proposeRoute"]).toBe("specPropose");
      expect(String(body["diff"])).toContain("agent.model");
      expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(before);
    } finally {
      await t.stop();
    }
  });

  test("an edit preserves the spec's file mode — a write never chmods the operator's file", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "mode");
      const specPath = join(dir, "crewhaus.yaml");
      // An operator who narrowed their spec on purpose.
      chmodSync(specPath, 0o600);
      // The claim is PRESERVATION, so the comparison is before-vs-after
      // rather than against a literal: Windows has no POSIX mode bits (it
      // reports 0666 for a writable file), and a hardcoded 0600 would test
      // the platform instead of the rename.
      const before = statSync(specPath).mode & 0o777;
      const id = await register(t, dir);
      const { status } = await t.api(
        `/api/h/${id}/spec/patch`,
        post({ edit: { path: "agent.instructions", value: "Be extremely brief." } }),
      );
      expect(status).toBe(200);
      // The write is tmp+rename, and rename replaces the INODE: a hardcoded
      // mode on the temp file silently becomes the spec's mode.
      expect((statSync(specPath).mode & 0o777).toString(8)).toBe(before.toString(8));
      if (process.platform !== "win32") expect(before.toString(8)).toBe("600");
    } finally {
      await t.stop();
    }
  });

  test("a batch that would not validate leaves the spec byte-identical", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "reject");
      const id = await register(t, dir);
      const before = readFileSync(join(dir, "crewhaus.yaml"), "utf8");
      const { status, body } = await t.api(
        `/api/h/${id}/spec/patch`,
        post({ edit: { path: "agent.max_tokens", value: -5 } }),
      );
      expect(status).toBe(200);
      expect(body["ok"]).toBe(false);
      expect(body["code"]).toBe("edit_rejected");
      expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(before);
    } finally {
      await t.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// a capped read is a VIEW, never a source for a write
// ---------------------------------------------------------------------------

/** A VALID cli spec larger than the manager's 256 KiB read cap: one long
 *  block scalar, and REAL configuration after it. The cap cuts inside the
 *  block scalar, so the surviving head still parses and still validates —
 *  which is exactly why writing that head back destroys the tail silently. */
const OVER_CAP_SPEC = [
  "name: spec-edit-fixture",
  "target: cli",
  "agent:",
  "  model: anthropic/claude-sonnet-4",
  "  instructions: |",
  ...Array.from({ length: 12_000 }, (_, i) => `    line ${i} ${"x".repeat(24)}`),
  "  max_tokens: 4096",
  "permissions:",
  "  mode: default",
  "limits:",
  "  max_tool_iterations: 5",
  "",
].join("\n");

describe("a spec past the read cap", () => {
  test("the fixture is genuinely over the cap, and its head genuinely still validates", async () => {
    const bytes = Buffer.from(OVER_CAP_SPEC, "utf8");
    expect(bytes.byteLength).toBeGreaterThan(256 * 1024);
    const head = bytes.subarray(0, 256 * 1024).toString("utf8");
    const { parseSpecIssues } = await import("@crewhaus/spec");
    // Validation cannot save this: the truncated document is a legal spec.
    // The refusal has to be explicit, or the loss is silent.
    expect(parseSpecIssues(head)).toEqual([]);
    expect(head).not.toContain("max_tool_iterations");
  });

  test("every write path REFUSES instead of renaming the head over the file", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "over-cap", OVER_CAP_SPEC);
      const specPath = join(dir, "crewhaus.yaml");
      const before = readFileSync(specPath, "utf8");
      const id = await register(t, dir);
      const edit = { path: "agent.max_tokens", value: 9000 };
      const attempts: Array<[string, string, RequestInit]> = [
        ["batch", `/api/h/${id}/spec`, put({ edits: [edit] })],
        ["patch", `/api/h/${id}/spec/patch`, post({ edit })],
        ["propose", `/api/h/${id}/spec/propose`, post({ edits: [edit] })],
        [
          "connector-write",
          `/api/h/${id}/builders/mcp`,
          post({ name: "files", command: "bunx", args: ["-y", "some-server"] }),
        ],
        [
          "connector-remove",
          `/api/h/${id}/builders/mcp/files?confirmName=spec-edit-fixture`,
          { method: "DELETE" },
        ],
      ];
      for (const [label, path, init] of attempts) {
        const { status, body } = await t.api(path, init);
        expect(`${label}:${status}`).toBe(`${label}:409`);
        expect(`${label}:${String(body["error"])}`).toContain("could not read whole");
      }
      // Nothing written, and no proposal staged from a mutilated candidate.
      expect(readFileSync(specPath, "utf8")).toBe(before);
      expect(existsSync(join(dir, ".crewhaus", "proposals"))).toBe(false);
    } finally {
      await t.stop();
    }
  });

  test("the READS still render the head — and every one of them says it is a head", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "over-cap-reads", OVER_CAP_SPEC);
      const id = await register(t, dir);
      for (const path of [
        `/api/h/${id}/spec/schema`,
        `/api/h/${id}/spec/trust`,
        `/api/h/${id}/builders/mcp`,
      ]) {
        const { status, body } = await t.api(path);
        expect(`${path}:${status}:${body["truncated"]}`).toBe(`${path}:200:true`);
      }
      // The preview is a read too, so it renders — but it stops claiming the
      // batch could be applied straight from the editor.
      const diff = await t.api(
        `/api/h/${id}/spec/diff`,
        post({ edits: [{ path: "agent.max_tokens", value: 9000 }] }),
      );
      expect(diff.status).toBe(200);
      expect(diff.body["truncated"]).toBe(true);
      expect(diff.body["autoApplicable"]).toBe(false);
    } finally {
      await t.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// a security surface is human-owned even where the optimizer may tune it
// ---------------------------------------------------------------------------

/** A VALID cli spec declaring the three surfaces that `OPTIMIZABLE_PATHS`
 *  and `SECURITY_SURFACES` both name. */
const ONCHAIN_SPEC = [
  "name: spec-edit-fixture",
  "target: cli",
  "agent:",
  "  model: anthropic/claude-sonnet-4",
  "  instructions: |",
  "    You are a fixture. Answer briefly.",
  "security:",
  "  justification:",
  "    judge: rule-based",
  "chains:",
  "  - id: mainnet",
  "    kind: evm",
  "    rpcUrls:",
  "      - $RPC_URL",
  "    finality:",
  "      kind: finalized",
  "transaction_policy:",
  '  maxValueWei: "1000"',
  "  simulationRequired: true",
  "",
].join("\n");

describe("the security surfaces the optimizer may also tune", () => {
  test("the badge and the write gate both say human-owned, and the confirmation still applies it", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "onchain", ONCHAIN_SPEC);
      const specPath = join(dir, "crewhaus.yaml");
      const before = readFileSync(specPath, "utf8");
      const id = await register(t, dir);

      const trust = await t.api(`/api/h/${id}/spec/trust`);
      const rows = new Map(
        (
          trust.body["paths"] as Array<{ path: string; tier: string; securitySurface: boolean }>
        ).map((row) => [row.path, row]),
      );
      for (const path of [
        "transaction_policy",
        "transaction_policy.maxValueWei",
        "transaction_policy.simulationRequired",
        "chains",
        "security",
        "security.justification",
      ]) {
        const row = rows.get(path);
        expect(`${path}:${row?.tier}:${row?.securitySurface}`).toBe(`${path}:human-owned:true`);
      }

      // The value ceiling, the simulation switch, the RPC endpoint and the
      // intent judge: each one refused without the typed confirmation.
      for (const edit of [
        { path: "transaction_policy.maxValueWei", value: "999999999999999999999" },
        { path: "transaction_policy.simulationRequired", value: false },
        { path: "chains.0.rpcUrls", value: ["https://rpc.invalid/v1"] },
        { path: "security.justification.judge", value: "claude" },
      ]) {
        const { status, body } = await t.api(`/api/h/${id}/spec/patch`, post({ edit }));
        expect(`${edit.path}:${status}`).toBe(`${edit.path}:409`);
        expect(`${edit.path}:${String(body["error"])}`).toContain(edit.path);
      }
      expect(readFileSync(specPath, "utf8")).toBe(before);

      // Human-owned is not read-only: the operator types the spec name and
      // the same edit lands, unrestricted.
      const confirmed = await t.api(
        `/api/h/${id}/spec/patch`,
        post({
          edit: { path: "transaction_policy.simulationRequired", value: false },
          confirmName: "spec-edit-fixture",
        }),
      );
      expect(confirmed.status).toBe(200);
      expect(confirmed.body["applied"]).toBe(1);
      expect(readFileSync(specPath, "utf8")).toContain("simulationRequired: false");
    } finally {
      await t.stop();
    }
  });
});

describe("version history", () => {
  function seedRegistry(dir: string, specName: string): void {
    const root = join(dir, ".crewhaus", "specs", specName);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "manifest.json"),
      JSON.stringify({ versions: ["v1", "v2"], pins: { prod: "v1", staging: "v2" } }, null, 2),
    );
    writeFileSync(
      join(root, "v1.yaml"),
      VALID_SPEC.replace("max_tokens: 4096", "max_tokens: 2048"),
    );
    writeFileSync(join(root, "v2.yaml"), VALID_SPEC);
    writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## v2 — 2026-08-01\n\n- initial\n");
    const tenant = join(dir, ".crewhaus", "specs", "_tenants", "acme");
    mkdirSync(tenant, { recursive: true });
    writeFileSync(join(tenant, `${specName}.json`), JSON.stringify({ prod: "v2" }));
  }

  test("versions, pins, tenant overlays and the changelog all render", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "versions");
      seedRegistry(dir, "spec-edit-fixture");
      const id = await register(t, dir);
      const { status, body } = await t.api(`/api/h/${id}/spec/versions`);
      expect(status).toBe(200);
      expect(body["present"]).toBe(true);
      const versions = body["versions"] as Array<{
        version: string;
        pinnedEnvs: string[];
        isCurrent: boolean;
      }>;
      expect(versions.map((v) => v.version)).toEqual(["v1", "v2"]);
      expect(versions[0]?.pinnedEnvs).toEqual(["prod"]);
      expect(versions[1]?.isCurrent).toBe(true);
      expect(body["tenants"]).toEqual([
        { tenant: "acme", pins: { prod: "v2" }, unreadable: false },
      ]);
      expect(String(body["changelog"])).toContain("## v2");
    } finally {
      await t.stop();
    }
  });

  test("one version's YAML is masked, and a missing one is absence, not an error", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "one-version");
      seedRegistry(dir, "spec-edit-fixture");
      const id = await register(t, dir);
      const found = await t.api(`/api/h/${id}/spec/versions/v1`);
      expect(found.status).toBe(200);
      expect(String(found.body["yaml"])).toContain("max_tokens: 2048");
      const missing = await t.api(`/api/h/${id}/spec/versions/v9`);
      expect(missing.status).toBe(200);
      expect(missing.body["present"]).toBe(false);
      expect(missing.body["yaml"]).toBeNull();
      expect(String(missing.body["verb"])).toContain("crewhaus spec put");
    } finally {
      await t.stop();
    }
  });

  test("a version diffs against the live spec by default and against a named version on request", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "diff-versions");
      seedRegistry(dir, "spec-edit-fixture");
      const id = await register(t, dir);
      const live = await t.api(`/api/h/${id}/spec/versions/v1/diff`);
      expect(live.body["against"]).toBe("live");
      expect(String(live.body["diff"])).toContain("agent.max_tokens");
      const pair = await t.api(`/api/h/${id}/spec/versions/v2/diff?against=v2`);
      expect(pair.body["diff"]).toBe("");
      expect(String(pair.body["note"])).toContain("no structural difference");
    } finally {
      await t.stop();
    }
  });
});

describe("pins and rollback", () => {
  test("a pin shells the audited deploy verb — the manifest is never written here", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "pin");
      const root = join(dir, ".crewhaus", "specs", "spec-edit-fixture");
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({ versions: ["v1", "v2"], pins: { prod: "v1" } }),
      );
      const id = await register(t, dir);
      const { status, body } = await t.api(
        `/api/h/${id}/spec/pin`,
        post({ env: "prod", version: "v2", confirmName: "spec-edit-fixture" }),
      );
      expect(status).toBe(200);
      expect(body["ok"]).toBe(true);
      expect(body["replaces"]).toBe("v1");
      const job = body["job"] as { argv: string[]; kind: string };
      expect(job.kind).toBe("spec-pin");
      expect(job.argv.slice(0, 5)).toEqual([
        "deploy",
        "rollback",
        "spec-edit-fixture",
        "prod",
        "v2",
      ]);
      expect(job.argv).toContain("--require-approval");
      // The manifest is the deploy verb's to write, not this route's.
      expect(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).pins).toEqual({
        prod: "v1",
      });
    } finally {
      await t.stop();
    }
  });

  test("pinning an unknown version is a first-class refusal that lists the known ones", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "pin-unknown");
      const id = await register(t, dir);
      const { status, body } = await t.api(
        `/api/h/${id}/spec/pin`,
        post({ env: "prod", version: "v9", confirmName: "spec-edit-fixture" }),
      );
      expect(status).toBe(200);
      expect(body["ok"]).toBe(false);
      expect(body["code"]).toBe("unknown_version");
      expect(body["known"]).toEqual([]);
    } finally {
      await t.stop();
    }
  });

  test("a pin with no typed confirmation is refused before anything is submitted", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "pin-unconfirmed");
      const id = await register(t, dir);
      const { status } = await t.api(`/api/h/${id}/spec/pin`, post({ env: "prod", version: "v1" }));
      expect(status).toBe(409);
      expect(
        t.server.processes.jobs.pending().length + t.server.processes.jobs.running().length,
      ).toBe(0);
    } finally {
      await t.stop();
    }
  });

  test("rolling back to the version already pinned is a refusal, not a no-op job", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "rollback");
      const root = join(dir, ".crewhaus", "specs", "spec-edit-fixture");
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({ versions: ["v1"], pins: { prod: "v1" } }),
      );
      const id = await register(t, dir);
      const { body } = await t.api(
        `/api/h/${id}/spec/rollback`,
        post({ env: "prod", version: "v1", confirmName: "spec-edit-fixture" }),
      );
      expect(body["code"]).toBe("already_pinned");
      expect(
        t.server.processes.jobs.pending().length + t.server.processes.jobs.running().length,
      ).toBe(0);
    } finally {
      await t.stop();
    }
  });
});

describe("propose", () => {
  test("a batch that changes nothing is refused before a branch is opened", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "propose-noop");
      const id = await register(t, dir);
      const { status, body } = await t.api(`/api/h/${id}/spec/propose`, post({ edits: [] }));
      expect(status).toBe(200);
      expect(body["code"]).toBe("no_change");
      expect(
        t.server.processes.jobs.pending().length + t.server.processes.jobs.running().length,
      ).toBe(0);
    } finally {
      await t.stop();
    }
  });

  test("a real batch stages the candidate spec and dry-runs the propose verb by default", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "propose");
      const id = await register(t, dir);
      const { body } = await t.api(
        `/api/h/${id}/spec/propose`,
        post({ edits: [{ path: "permissions.mode", value: "auto" }], title: "loosen ask mode" }),
      );
      expect(body["ok"]).toBe(true);
      expect(body["dryRun"]).toBe(true);
      const staged = String(body["staged"]);
      expect(staged.startsWith(".crewhaus/proposals/hangar-")).toBe(true);
      expect(existsSync(join(dir, staged))).toBe(true);
      // Staged, not applied: the live spec is untouched.
      expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toContain("mode: default");
      const job = body["job"] as { argv: string[] };
      expect(job.argv).toEqual([
        "propose",
        staged,
        "--current",
        "crewhaus.yaml",
        "--source",
        "manual",
        "--dry-run",
      ]);
    } finally {
      await t.stop();
    }
  });
});

describe("builders", () => {
  test("every shipped template renders a spec that validates", async () => {
    const t = boot();
    try {
      const { status, body } = await t.api("/api/builders/templates");
      expect(status).toBe(200);
      const templates = body["templates"] as Array<{ id: string; target: string; preview: string }>;
      expect(templates.length).toBeGreaterThan(0);
      const { parseSpecIssues } = await import("@crewhaus/spec");
      for (const template of templates) {
        expect(`${template.id}:${JSON.stringify(parseSpecIssues(template.preview))}`).toBe(
          `${template.id}:[]`,
        );
      }
    } finally {
      await t.stop();
    }
  });

  test("no template seed carries a credential literal — every one is an env reference", async () => {
    // The seeds are served verbatim (masking a line-scanned YAML constant
    // corrupts it: `sessionKey: thread` would redact to a one-item list), so
    // "there is nothing in them to mask" has to be an assertion, not a hope.
    const { WIZARD_TEMPLATES } = await import("./builders");
    const { isCredentialKey, maskCredentialTokens } = await import("@crewhaus/spec-patch");
    for (const template of WIZARD_TEMPLATES) {
      // Nothing token-shaped anywhere in the document…
      expect(`${template.id}:masked`).toBe(
        `${template.id}:${maskCredentialTokens(template.seed) === template.seed ? "masked" : "CHANGED"}`,
      );
      for (const line of template.seed.split("\n")) {
        const m = line.match(/^\s*([A-Za-z0-9_.-]+):\s+(\S.*)$/);
        if (m === null || !isCredentialKey(m[1] as string)) continue;
        // …and every credential-KEYED value is either an env reference or a
        // one-word schema enum (`sessionKey: thread` trips the key matcher's
        // `*Key` suffix rule without being a secret).
        expect(`${template.id}:${m[1]}:${m[2]}`).toMatch(/:(?:\$[A-Z_]+|[a-z][a-z0-9-]{0,15})$/);
      }
    }
  });

  test("the wizard dry-runs by default and writes only on the typed confirmation", async () => {
    const t = boot();
    try {
      const target = join(t.workspace, "wizard-made");
      const plan = await t.api(
        "/api/builders/spec",
        post({ dir: target, template: "cli", answers: { name: "made-by-wizard" } }),
      );
      expect(plan.status).toBe(200);
      expect(plan.body["dryRun"]).toBe(true);
      expect(plan.body["confirmName"]).toBe("made-by-wizard");
      expect(existsSync(target)).toBe(false);

      const made = await t.api(
        "/api/builders/spec",
        post({
          dir: target,
          template: "cli",
          answers: { name: "made-by-wizard" },
          dryRun: false,
          confirmName: "made-by-wizard",
        }),
      );
      expect(made.body["created"]).toBe(true);
      expect(readFileSync(join(target, "crewhaus.yaml"), "utf8")).toContain("name: made-by-wizard");
      // The registry is not reachable from a handler: the answer says how the
      // console finishes the job rather than pretending it is registered.
      expect((made.body["registerWith"] as { route: string }).route).toBe("addHarness");

      // Second write refuses rather than overwriting somebody's spec.
      const again = await t.api(
        "/api/builders/spec",
        post({
          dir: target,
          template: "cli",
          answers: {},
          dryRun: false,
          confirmName: "my-agent",
        }),
      );
      expect(again.body["code"]).toBe("spec_exists");
    } finally {
      await t.stop();
    }
  });

  test("an answer the template does not declare is refused rather than written somewhere", async () => {
    const t = boot();
    try {
      const { status, body } = await t.api(
        "/api/builders/spec",
        post({
          dir: join(t.workspace, "nope"),
          template: "cli",
          answers: { permissions: "bypass" },
        }),
      );
      expect(status).toBe(400);
      expect(String(body["error"])).toContain("no answer");
    } finally {
      await t.stop();
    }
  });

  test("connectors list env NAMES with presence, never values, and lint what they find", async () => {
    const t = boot();
    try {
      const yaml =
        VALID_SPEC +
        [
          "mcp_servers:",
          "  files:",
          "    transport: stdio",
          "    command: bunx",
          "    env:",
          "      SOME_VAR: $NOT_EXPANDED",
          "",
        ].join("\n");
      const dir = specHarness(t, "connectors", yaml);
      const id = await register(t, dir);
      const { status, body } = await t.api(`/api/h/${id}/builders/mcp`);
      expect(status).toBe(200);
      const servers = body["servers"] as Array<{
        name: string;
        envRefs: Array<{ name: string; set: boolean }>;
      }>;
      expect(servers[0]?.name).toBe("files");
      expect(servers[0]?.envRefs).toEqual([{ name: "SOME_VAR", set: false }]);
      expect(JSON.stringify(body)).not.toContain("NOT_EXPANDED");
      const findings = body["findings"] as Array<{ code: string }>;
      expect(findings[0]?.code).toBe("never_expands");
    } finally {
      await t.stop();
    }
  });

  test("a connector write previews first, then applies on the typed confirmation", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "mcp-write");
      const id = await register(t, dir);
      const preview = await t.api(
        `/api/h/${id}/builders/mcp`,
        post({ name: "files", command: "bunx", args: ["-y", "some-server"] }),
      );
      expect(preview.body["dryRun"]).toBe(true);
      expect(String(preview.body["diff"])).toContain("mcp_servers");
      expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).not.toContain("mcp_servers");

      const applied = await t.api(
        `/api/h/${id}/builders/mcp`,
        post({
          name: "files",
          command: "bunx",
          args: ["-y", "some-server"],
          dryRun: false,
          confirmName: "spec-edit-fixture",
        }),
      );
      expect(applied.body["ok"]).toBe(true);
      expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toContain("mcp_servers:");

      // …and removing it is the same gate, with the confirmation in the query.
      const plan = await t.api(`/api/h/${id}/builders/mcp/files`, { method: "DELETE" });
      expect(plan.body["dryRun"]).toBe(true);
      expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toContain("mcp_servers:");
      const removed = await t.api(`/api/h/${id}/builders/mcp/files?confirmName=spec-edit-fixture`, {
        method: "DELETE",
      });
      expect(removed.body["ok"]).toBe(true);
      expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).not.toContain("mcp_servers:");
    } finally {
      await t.stop();
    }
  });

  test("a $VAR or a credential literal in an MCP env map is REFUSED, never masked and stored", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "mcp-refuse");
      const id = await register(t, dir);
      const expansion = await t.api(
        `/api/h/${id}/builders/mcp`,
        post({ name: "files", command: "bunx", env: { SOME_VAR: "$SOME_VAR" } }),
      );
      expect(expansion.status).toBe(400);
      expect(String(expansion.body["error"])).toContain("never expands");

      const literal = ["sk", "-", "x".repeat(24)].join("");
      const pasted = await t.api(
        `/api/h/${id}/builders/mcp`,
        post({ name: "files", command: "bunx", env: { SOME_NAME: literal } }),
      );
      expect(pasted.status).toBe(400);
      expect(String(pasted.body["error"])).toContain(".env");
      expect(String(pasted.body["error"])).not.toContain(literal);
      expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).not.toContain("mcp_servers");
    } finally {
      await t.stop();
    }
  });

  test("graders: the YAML pane writes, the structured builder says why it cannot", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "graders");
      const id = await register(t, dir);
      const empty = await t.api(`/api/h/${id}/builders/graders`);
      expect(empty.body["present"]).toBe(false);
      expect(String(empty.body["verb"])).toContain("crewhaus graders suggest");

      const structured = await t.api(`/api/h/${id}/builders/graders`, post({ graders: [] }));
      expect(structured.status).toBe(200);
      expect(structured.body["code"]).toBe("structured_writer_unavailable");

      const written = await t.api(
        `/api/h/${id}/builders/graders`,
        post({
          yaml: "graders:\n  - name: cites\n    type: contains\n    substring: http\n",
          confirmName: "spec-edit-fixture",
        }),
      );
      expect(written.body["ok"]).toBe(true);
      expect(written.body["graders"]).toEqual([{ name: "cites", type: "contains" }]);
      expect(existsSync(join(dir, "eval", "graders.yaml"))).toBe(true);
      const reread = await t.api(`/api/h/${id}/builders/graders`);
      expect(reread.body["present"]).toBe(true);
      expect(reread.body["hash"]).toBe(written.body["hash"]);
    } finally {
      await t.stop();
    }
  });

  test("graders: the pane is served MASKED, and saving that pane back is REFUSED", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "graders-mask");
      const gradersPath = join(dir, "eval", "graders.yaml");
      mkdirSync(join(dir, "eval"), { recursive: true });
      // Built from parts: a realistic-looking literal must never be committed.
      const literal = ["sk", "-", "live", "-", "A".repeat(24)].join("");
      const stored = `graders:\n  - name: cites\n    type: contains\n    substring: ${literal}\n`;
      writeFileSync(gradersPath, stored);
      const id = await register(t, dir);

      // What the console's editor pane is prefilled with.
      const read = await t.api(`/api/h/${id}/builders/graders`);
      const pane = String(read.body["yaml"]);
      expect(pane).not.toContain(literal);
      expect(pane).toContain("***");

      // Clicking Save on that pane would rename the mask over what it hid.
      const saved = await t.api(
        `/api/h/${id}/builders/graders`,
        post({ yaml: pane, confirmName: "spec-edit-fixture" }),
      );
      expect(saved.status).toBe(409);
      expect(String(saved.body["error"])).toContain("masked span");
      expect(readFileSync(gradersPath, "utf8")).toBe(stored);

      // An edit that carries the real content through is still a normal save.
      const real = `graders:\n  - name: cites\n    type: contains\n    substring: ${literal}\n  - name: brief\n    type: max_words\n`;
      const ok = await t.api(
        `/api/h/${id}/builders/graders`,
        post({ yaml: real, confirmName: "spec-edit-fixture" }),
      );
      expect(ok.status).toBe(200);
      expect(readFileSync(gradersPath, "utf8")).toContain(literal);
    } finally {
      await t.stop();
    }
  });

  test("the dataset builder refuses honestly instead of growing a second state machine", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "dataset");
      const id = await register(t, dir);
      const read = await t.api(`/api/h/${id}/builders/dataset`);
      expect(read.body["present"]).toBe(false);
      expect(String(read.body["verb"])).toContain("crewhaus dataset");
      const step = await t.api(`/api/h/${id}/builders/dataset`, post({ event: "start" }));
      expect(step.status).toBe(200);
      expect(step.body["code"]).toBe("builder_unavailable");
    } finally {
      await t.stop();
    }
  });
});

describe("the outbound masker does not eat this surface's own labels", () => {
  // Everything an M3 route returns passes `maskDeep`, which redacts every
  // value under a key named `env`, `key`, `token`, … wholesale. A payload
  // that labels its own fields with one of those names comes back as a page
  // full of "[redacted]" — so these are the field names, pinned.
  test("a pin reports the environment it moved, and the wizard reports its answer names", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "masking");
      const root = join(dir, ".crewhaus", "specs", "spec-edit-fixture");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "manifest.json"), JSON.stringify({ versions: ["v1"], pins: {} }));
      const id = await register(t, dir);
      const pin = await t.api(
        `/api/h/${id}/spec/pin`,
        post({ env: "prod", version: "v1", confirmName: "spec-edit-fixture" }),
      );
      expect(pin.body["envName"]).toBe("prod");

      const templates = await t.api("/api/builders/templates");
      const first = (
        templates.body["templates"] as Array<{ fields: Array<{ answer: string }> }>
      )[0];
      expect(first?.fields.map((f) => f.answer)).toContain("name");

      const connectors = await t.api(`/api/h/${id}/builders/mcp`);
      expect(JSON.stringify(connectors.body)).not.toContain("[redacted]");
    } finally {
      await t.stop();
    }
  });
});

describe("reads never mutate", () => {
  test("every GET on this surface leaves the harness byte-identical", async () => {
    const t = boot();
    try {
      const dir = specHarness(t, "immutable");
      const specPath = join(dir, "crewhaus.yaml");
      const before = readFileSync(specPath, "utf8");
      const id = await register(t, dir);
      for (const path of [
        `/api/h/${id}/spec/schema`,
        `/api/h/${id}/spec/trust`,
        `/api/h/${id}/spec/versions`,
        `/api/h/${id}/spec/versions/v1`,
        `/api/h/${id}/spec/versions/v1/diff`,
        `/api/h/${id}/builders/mcp`,
        `/api/h/${id}/builders/graders`,
        `/api/h/${id}/builders/dataset`,
        "/api/builders/templates",
        "/api/builders/mcp-catalog",
      ]) {
        const { status } = await t.api(path);
        expect(`${path}:${status}`).toBe(`${path}:200`);
      }
      expect(readFileSync(specPath, "utf8")).toBe(before);
      expect(existsSync(join(dir, ".crewhaus", "specs"))).toBe(false);
    } finally {
      await t.stop();
    }
  });
});

describe("the MCP connector form refuses a credential in an SSE url", () => {
  // Masking a value that has ALREADY been written is not the same as
  // refusing to write it: this url lands in the harness's committed
  // crewhaus.yaml, where the read-side masker can no longer help the
  // operator who pushed it.
  test("userinfo, opaque path segments and key-ish query values are each refused", () => {
    const key = ["kZ8b", "Qw3n", "Rt5v", "Xy7m", "Ab1c", "De4f", "Gh6j", "Kl9p"].join("");
    expect(sseUrlCredential(`https://user:${key}@mcp.example.com/sse`)).toBe("userinfo");
    expect(sseUrlCredential(`https://eth-mainnet.example.com/v2/${key}`)).toBe("a path segment");
    expect(sseUrlCredential(`https://mcp.example.com/sse?apiKey=${key}`)).toBe(
      'the "apiKey" query parameter',
    );
    // …and an ordinary endpoint is left alone.
    expect(sseUrlCredential("https://mcp.example.com/sse")).toBeUndefined();
    expect(sseUrlCredential("https://mcp.example.com/v2/events?mode=stream")).toBeUndefined();
  });
});
