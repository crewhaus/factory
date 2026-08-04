/**
 * The credentials + channels + security area, driven against a fixture this
 * suite controls.
 *
 * The shared contract fixture deliberately keeps every store thin, and its
 * `agent.model` sits outside the model-router grammar — so the credential
 * checklist, the channel boot gate, the MCP lint and the audit panel are all
 * legitimately EMPTY over there. This suite supplies the populated
 * counterpart: a spec with a real model, two channels, an MCP server with
 * every lint class in it, a hash-chained audit log, receipts, metrics and a
 * retention policy.
 *
 * The invariants under test are the ones that were bugs before they were
 * rules: a value never comes back out, a listed name is re-contained per
 * file, "unset" writes a stub instead of deleting, the destructive verbs
 * dry-run first, and every honest refusal (Discord's asymmetric signing,
 * iMessage's missing webhook, a verifier's unchecked anchor) is REPORTED
 * rather than hidden behind a disabled button with no reason.
 *
 * Nothing here spawns a process: the job routes are asserted on the record
 * the queue hands back, which is the boundary this module owns.
 */
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AuditRecord, recomputeRecordHash } from "@crewhaus/audit-log";
import { signSynthetic } from "./channels-ops";
import { unsetEnvVar, upsertEnvVar } from "./creds-ops";
import { makeFixtureHarness } from "./fixture";
import { M3_ROUTES } from "./m3-routes";
import { type TestServer, bootTestServer } from "./testkit";
import { readYamlLoose } from "./yaml-scan";

const NOW = Date.parse("2026-08-04T12:00:00.000Z");

/**
 * Credential-shaped literals are built from parts, never written out: the
 * repository's push protection rejects realistic-looking secrets in
 * fixtures, and it is right to.
 */
const SIGNING_SECRET = ["fixture", "signing", "value"].join("-");
const PASTED_LITERAL = ["pasted", "into", "the", "spec"].join("-");

/** A channel + MCP spec with one of every lint class the panels report. */
function specYaml(): string {
  return [
    "channels:",
    "  slack:",
    "    botToken: $SLACK_BOT_TOKEN",
    "    signingSecret: $SLACK_SIGNING_SECRET",
    "  discord:",
    "    applicationId: $DISCORD_APP_ID",
    "    botToken: $DISCORD_BOT_TOKEN",
    "    publicKeyHex: $DISCORD_PUBLIC_KEY",
    "  imessage:",
    "    chatDbPath: /tmp/chat.db",
    "routing:",
    "  sessionKey: thread",
    "gateway:",
    "  port: 8787",
    "  ui: true",
    "observability:",
    "  slo:",
    "    ttft_ms: 1500",
    "    error_rate: 0.05",
    "    mitigation:",
    "      - alert",
    "      - pause-intake",
    "security:",
    "  justification:",
    "    judge: rule-based",
    "    threshold: 0.6",
    "transaction_policy:",
    "  approval: human",
    "  maxValueWei: '1000'",
    "mcp_servers:",
    "  files:",
    "    transport: stdio",
    "    command: bunx",
    "    env:",
    "      UNSET_REF: $MCP_MISSING_TOKEN",
    // NOT credential-shaped, so a `${...}` literal is a WARN the transports
    // would ship verbatim rather than a compile failure.
    "      LITERAL_HOST: ${SHELL_STYLE}",
    // Credential-shaped WITH a malformed `$…`: the compiler rejects this
    // outright, so no daemon can exist to fail at boot.
    "      BROKEN_TOKEN: ${lowercase}",
    `      PASTED_SECRET: ${PASTED_LITERAL}`,
  ].join("\n");
}

/** One hash-chained audit day file. Hashes come from the audit-log package's
 *  own derivation, so `verify()` walks a chain it actually agrees with. */
function writeAuditChain(
  harnessDir: string,
  entries: ReadonlyArray<{ kind: string; payload: unknown }>,
  opts: { anchor?: boolean } = {},
): void {
  const dir = join(harnessDir, ".crewhaus", "audit");
  mkdirSync(dir, { recursive: true });
  let prevHash = "GENESIS";
  const lines: string[] = [];
  let seq = 0;
  for (const entry of entries) {
    const body = {
      ts: NOW - (entries.length - seq) * 1000,
      version: 1 as const,
      kind: entry.kind,
      seq,
      payload: entry.payload,
    };
    const hash = recomputeRecordHash({ ...body, prevHash, hash: "" } as unknown as AuditRecord);
    lines.push(JSON.stringify({ ...body, prevHash, hash }));
    prevHash = hash;
    seq += 1;
  }
  writeFileSync(join(dir, "2026-08-04.jsonl"), `${lines.join("\n")}\n`);
  if (opts.anchor === true) {
    writeFileSync(
      join(dir, "_chain-tail.json"),
      JSON.stringify({ day: "2026-08-04", hash: prevHash, seq: seq - 1 }),
    );
  }
}

/** Build the populated harness and register it. Returns its id + dir. */
async function seed(
  t: TestServer,
  opts: { anchor?: boolean; envLines?: readonly string[] } = {},
): Promise<{ id: string; dir: string }> {
  const dir = makeFixtureHarness(join(t.harnessesRoot, "area"), {
    specName: "area-harness",
    target: "channel",
    model: "claude-opus-5",
    specExtra: specYaml(),
    envLines: opts.envLines ?? [
      "SLACK_BOT_TOKEN=bot",
      `SLACK_SIGNING_SECRET=${SIGNING_SECRET}`,
      "# DISCORD_APP_ID=",
    ],
  });
  writeAuditChain(
    dir,
    [
      {
        kind: "egress_decision",
        payload: {
          sinkId: "fetch",
          sinkScope: "https://example.invalid",
          verdict: "warn",
          originsFound: ["tool_result:search"],
          matchCount: 2,
        },
      },
      {
        kind: "permission_justification_evaluated",
        payload: {
          toolName: "Fetch",
          justification: "the user asked me to read the changelog",
          verdict: "deny",
          reason: "no explicit user intent for an external read",
          judgeModel: "rule-based",
          confidence: 0.4,
        },
      },
      {
        kind: "alert_raised",
        payload: {
          metric: "ttftP95Seconds",
          observed: 4,
          threshold: 2,
          baselineSessions: 7,
          detail: "trailing p95 x 1.5",
        },
      },
    ],
    opts.anchor === true ? { anchor: true } : {},
  );
  const metricsDir = join(dir, ".crewhaus", "metrics");
  mkdirSync(metricsDir, { recursive: true });
  writeFileSync(
    join(metricsDir, "sessions.jsonl"),
    `${JSON.stringify({
      sessionId: "sess_00000000000000aa",
      ts: "2026-08-04T11:00:00.000Z",
      modelCalls: 10,
      errorRate: 0.1,
      turnP95Seconds: 3,
      ttftP95Seconds: 2,
      costBurnUsdPerMin: 0.5,
      egressBlocked: 2,
    })}\n`,
  );
  writeFileSync(
    join(dir, ".crewhaus", "retention.json"),
    JSON.stringify({ version: 1, sessions: { maxAgeDays: 45 }, pins: ["sess_00000000000000aa"] }),
  );
  const onchainDir = join(dir, ".crewhaus", "onchain");
  mkdirSync(onchainDir, { recursive: true });
  writeFileSync(
    join(onchainDir, "receipts.jsonl"),
    `${JSON.stringify({
      ts: NOW,
      walletId: "w1",
      chainId: "1",
      contractId: "vault",
      valueWei: "500",
      status: "0x1",
      simulated: true,
    })}\n`,
  );
  const added = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  return { id: (added.body["entry"] as { id: string }).id, dir };
}

function boot(): TestServer {
  return bootTestServer({ now: () => NOW, runJob: () => Promise.resolve({ exitCode: 0 }) });
}

// ---------------------------------------------------------------------------
// Area coverage — which routes are REAL
// ---------------------------------------------------------------------------

/** Path params for the three groups' templates. */
const PARAMS: Readonly<Record<string, string>> = {
  key: "SLACK_BOT_TOKEN",
  channel: "slack",
  decisionId: "egr_0",
  name: "smoke",
};

/** Minimal accepted bodies, one per write. Deliberately the SMALLEST body
 *  each route accepts, so the test also pins what is required. */
const BODIES: Readonly<Record<string, unknown>> = {
  envSet: { key: "SLACK_BOT_TOKEN", value: "placeholder-not-a-credential" },
  credentialsSetAcross: { key: "SHARED", value: "placeholder", harnessIds: [] },
  doctorRun: {},
  secretsRotate: { value: "placeholder", confirmName: "area-harness" },
  channelVerify: { offline: true },
  channelProvisionRun: { confirm: true },
  channelProbe: {},
  channelSynthetic: { confirm: true },
  auditVerify: {},
  egressReview: { verdict: "allow" },
  piiTune: { policy: {}, dryRun: true },
  justificationCalibrate: {},
  justificationPreflight: { tool: "Fetch" },
  securityCorpusCheck: {},
  onchainTune: { policy: {}, dryRun: true },
  complianceEvidence: { framework: "soc2" },
  retentionSweep: { dryRun: true },
  retentionPurge: { dryRun: true },
};

describe("area coverage", () => {
  test("every creds/channels/security route is real except the one that cannot be", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const stubbed: string[] = [];
      for (const route of M3_ROUTES) {
        if (!["creds", "channels", "security"].includes(route.group)) continue;
        const path = route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, name: string) =>
          name === "id" ? id : (PARAMS[name] ?? "x"),
        );
        const writes = route.method === "POST" || route.method === "PUT";
        const { status, body } = await t.api(path, {
          method: route.method,
          ...(writes ? { body: JSON.stringify(BODIES[route.key] ?? {}) } : {}),
        });
        if (status === 501) {
          stubbed.push(route.key);
          continue;
        }
        expect(`${route.key}:${status}`).toBe(`${route.key}:200`);
        expect(`${route.key}:${JSON.stringify(body).includes(SIGNING_SECRET)}`).toBe(
          `${route.key}:false`,
        );
      }
      // Rotation is the ONE route this area cannot build honestly: the
      // sanctioned writer is not a dependency of this package, and the CLI
      // fallback would put the value in argv. See `secretsRotate`.
      expect(stubbed).toEqual(["secretsRotate"]);
    } finally {
      await t.stop();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// The env writer — the ONE path a value takes into a file
// ---------------------------------------------------------------------------

describe("upsertEnvVar", () => {
  test("preserves comments and ordering, and promotes a stub in place", () => {
    const t = boot();
    try {
      const path = join(t.workspace, ".env");
      writeFileSync(
        path,
        ["# a leading comment", "FIRST=one", "# SECOND=", "THIRD=three", ""].join("\n"),
      );
      const promoted = upsertEnvVar(path, "SECOND", "two");
      expect(promoted.how).toBe("uncommented");
      // The promoted key keeps its POSITION — the operator put it there.
      expect(readFileSync(path, "utf8").split("\n").slice(0, 4)).toEqual([
        "# a leading comment",
        "FIRST=one",
        "SECOND=two",
        "THIRD=three",
      ]);
      expect(upsertEnvVar(path, "FIRST", "changed").how).toBe("replaced");
      expect(upsertEnvVar(path, "FOURTH", "four").how).toBe("appended");
      const lines = readFileSync(path, "utf8").split("\n");
      expect(lines[1]).toBe("FIRST=changed");
      expect(lines[4]).toBe("FOURTH=four");
    } finally {
      void t.stop();
    }
  });

  test("unset writes a `# NAME=` stub — there is no delete", () => {
    const t = boot();
    try {
      const path = join(t.workspace, "unset.env");
      writeFileSync(path, "KEEP=yes\nDROP=no\n");
      const result = unsetEnvVar(path, "DROP");
      expect(result.state).toBe("commented-stub");
      expect(readFileSync(path, "utf8")).toBe("KEEP=yes\n# DROP=\n");
      // Idempotent: unsetting a stub leaves exactly one stub.
      unsetEnvVar(path, "DROP");
      expect(readFileSync(path, "utf8")).toBe("KEEP=yes\n# DROP=\n");
    } finally {
      void t.stop();
    }
  });

  test("quotes values that bare text would re-read differently, and holds 0600", () => {
    const t = boot();
    try {
      const path = join(t.workspace, "quoted.env");
      writeFileSync(path, "", { mode: 0o644 });
      upsertEnvVar(path, "SPACED", 'a b "c" # d');
      const line = readFileSync(path, "utf8").trim();
      expect(line).toBe('SPACED="a b \\"c\\" # d"');
      // `writeFileSync`'s mode only applies at CREATION, so an already-loose
      // file has to be chmod'ed — otherwise a 0644 .env stays 0644 forever.
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      void t.stop();
    }
  });

  test("refuses a value a `.env` cannot represent, naming only the KEY", () => {
    const t = boot();
    try {
      const path = join(t.workspace, "multi.env");
      let message = "";
      try {
        upsertEnvVar(path, "MULTI", "line one\nline two");
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("MULTI");
      // The refusal must not echo the value it refused.
      expect(message).not.toContain("line one");
    } finally {
      void t.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe("credentials", () => {
  test("reports presence, source and the four cell states — never a value", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const { status, body } = await t.api(`/api/h/${id}/env`);
      expect(status).toBe(200);
      const keys = body["keys"] as Array<Record<string, unknown>>;
      const byName = new Map(keys.map((key) => [String(key["name"]), key]));
      expect(byName.get("SLACK_BOT_TOKEN")?.["state"]).toBe("set");
      expect(byName.get("SLACK_BOT_TOKEN")?.["source"]).toBe("harness .env");
      // A `# NAME=` stub holds the requirement's place.
      expect(byName.get("DISCORD_APP_ID")?.["state"]).toBe("commented-stub");
      expect(byName.get("DISCORD_BOT_TOKEN")?.["state"]).toBe("missing");
      // Either-or: the model needs one of two, and the unset sibling of a
      // set one is INFORMATIONAL, not a failure.
      expect(byName.get("ANTHROPIC_AUTH_TOKEN")?.["state"]).toBe("missing");
      expect(byName.get("ANTHROPIC_AUTH_TOKEN")?.["alternatives"]).toEqual(["ANTHROPIC_API_KEY"]);
      // Byte-level: the file's own value appears nowhere in the response.
      expect(JSON.stringify(body)).not.toContain(SIGNING_SECRET);
    } finally {
      await t.stop();
    }
  });

  test("a set is visible on re-read as PRESENCE, and the value never returns", async () => {
    const t = boot();
    try {
      const { id, dir } = await seed(t);
      const value = ["written", "by", "the", "console"].join("-");
      const set = await t.api(`/api/h/${id}/env`, {
        method: "POST",
        body: JSON.stringify({ key: "DISCORD_BOT_TOKEN", value }),
      });
      expect(set.status).toBe(200);
      expect(JSON.stringify(set.body)).not.toContain(value);
      // The write really landed in the harness's own file.
      expect(readFileSync(join(dir, ".env"), "utf8")).toContain(`DISCORD_BOT_TOKEN=${value}`);
      const after = await t.api(`/api/h/${id}/env`);
      const keys = after.body["keys"] as Array<Record<string, unknown>>;
      expect(keys.find((key) => key["name"] === "DISCORD_BOT_TOKEN")?.["state"]).toBe("set");
      expect(JSON.stringify(after.body)).not.toContain(value);

      const unset = await t.api(`/api/h/${id}/env/DISCORD_BOT_TOKEN`, { method: "DELETE" });
      expect(unset.status).toBe(200);
      expect(readFileSync(join(dir, ".env"), "utf8")).toContain("# DISCORD_BOT_TOKEN=");
    } finally {
      await t.stop();
    }
  });

  test("the fleet matrix grids NAMES, and its cells survive masking", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const { status, body } = await t.api("/api/credentials");
      expect(status).toBe(200);
      const harnesses = body["harnesses"] as Array<Record<string, unknown>>;
      const row = harnesses.find((entry) => entry["id"] === id);
      const cells = row?.["cells"] as Array<Record<string, unknown>>;
      // The cell field is `name`: a field called `key` would be redacted by
      // `maskDeep` on the way out and the grid would lose its columns.
      expect(cells.some((cell) => cell["name"] === "SLACK_BOT_TOKEN")).toBe(true);
      expect(JSON.stringify(body)).not.toContain("[redacted]");
      expect(JSON.stringify(body)).not.toContain(SIGNING_SECRET);
    } finally {
      await t.stop();
    }
  });

  test("set-across needs the typed key, reports per harness, and keeps nothing", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const value = ["fleet", "wide", "value"].join("-");
      const refused = await t.api("/api/credentials/set", {
        method: "POST",
        body: JSON.stringify({
          key: "SHARED_TOKEN",
          value,
          harnessIds: [id],
          confirmName: "the-wrong-thing",
        }),
      });
      expect(refused.status).toBe(409);

      const ok = await t.api("/api/credentials/set", {
        method: "POST",
        body: JSON.stringify({
          key: "SHARED_TOKEN",
          value,
          harnessIds: [id, "hrn_0000000000000000"],
          confirmName: "SHARED_TOKEN",
        }),
      });
      expect(ok.status).toBe(200);
      // A partial failure is reported PER HARNESS, never collapsed.
      expect((ok.body["written"] as unknown[]).length).toBe(1);
      expect((ok.body["refused"] as unknown[]).length).toBe(1);
      expect(JSON.stringify(ok.body)).not.toContain(value);
    } finally {
      await t.stop();
    }
  });

  test("doctor shows the Anthropic precedence rule explicitly", async () => {
    const t = bootTestServer({
      now: () => NOW,
      env: { ANTHROPIC_AUTH_TOKEN: `sk-ant-oat-${"x".repeat(8)}`, ANTHROPIC_API_KEY: "also-set" },
      runJob: () => Promise.resolve({ exitCode: 0 }),
    });
    try {
      const { id } = await seed(t);
      const { body } = await t.api(`/api/h/${id}/doctor`);
      const anthropic = body["anthropic"] as Record<string, unknown>;
      expect(anthropic["mode"]).toBe("oauth");
      expect(anthropic["winner"]).toBe("ANTHROPIC_AUTH_TOKEN");
      expect(String(anthropic["note"])).toContain("OAuth");
    } finally {
      await t.stop();
    }
  });

  test("the MCP lint predicts the boot failure and names every literal class", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const { body } = await t.api(`/api/h/${id}/mcp/lint`);
      const findings = body["findings"] as Array<Record<string, unknown>>;
      const kinds = findings.map((finding) => String(finding["kind"]));
      // An unset `$VAR` is the ConfigError a boot would die with.
      expect(kinds).toContain("unset-env-ref");
      const unset = findings.find((finding) => finding["kind"] === "unset-env-ref");
      expect(String(unset?.["message"])).toContain("will not boot");
      expect(unset?.["envVar"]).toBe("MCP_MISSING_TOKEN");
      // `${FOO}` is a literal the transports never expand.
      expect(kinds).toContain("unexpanded-literal");
      // A credential-shaped key holding a plain literal.
      expect(kinds).toContain("inline-credential");
      // A credential-shaped key whose `$…` is malformed fails COMPILATION.
      expect(kinds).toContain("compile-error");
    } finally {
      await t.stop();
    }
  });

  test("secret rotation refuses honestly instead of leaking or lying", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const { status, body } = await t.api(`/api/h/${id}/secrets/smoke/rotate`, {
        method: "POST",
        body: JSON.stringify({ value: "x", confirmName: "area-harness" }),
      });
      expect(status).toBe(501);
      expect(String(body["error"])).toContain("argv");
    } finally {
      await t.stop();
    }
  });

  test("a `.env` symlinked out of the harness is not this harness's `.env`", async () => {
    const t = boot();
    try {
      const outside = join(t.workspace, "outside.env");
      writeFileSync(outside, "ESCAPED=yes\n");
      const dir = makeFixtureHarness(join(t.harnessesRoot, "escape"), {
        specName: "escape-harness",
        model: "claude-opus-5",
      });
      symlinkSync(outside, join(dir, ".env"));
      const added = await t.api("/api/harnesses", {
        method: "POST",
        body: JSON.stringify({ dir }),
      });
      const id = (added.body["entry"] as { id: string }).id;
      const { status, body } = await t.api(`/api/h/${id}/env`);
      expect(status).toBe(200);
      // Containment is per FILE: the planted link is refused, so the chain
      // reads as empty rather than reaching outside the tree.
      expect(body["files"]).toEqual([]);
      expect(JSON.stringify(body)).not.toContain("ESCAPED");
    } finally {
      await t.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

describe("channels", () => {
  test("tier 2 is offered for symmetric platforms and REFUSED with a reason otherwise", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const { body } = await t.api(`/api/h/${id}/channels`);
      const rows = body["channels"] as Array<Record<string, unknown>>;
      const byPlatform = new Map(rows.map((row) => [String(row["platform"]), row]));

      const slack = byPlatform.get("slack")?.["tier2"] as Record<string, unknown>;
      expect(slack["available"]).toBe(true);

      const discord = byPlatform.get("discord")?.["tier2"] as Record<string, unknown>;
      expect(discord["available"]).toBe(false);
      expect(String(discord["reason"])).toContain("Ed25519");

      const imessage = byPlatform.get("imessage")?.["tier2"] as Record<string, unknown>;
      expect(imessage["available"]).toBe(false);
      expect(String(imessage["reason"])).toContain("poller");
      // iMessage has no inbound webhook at all, so tier 1 is refused too.
      expect((byPlatform.get("imessage")?.["tier1"] as Record<string, unknown>)["available"]).toBe(
        false,
      );
    } finally {
      await t.stop();
    }
  });

  test("a `thread` sessionKey is flagged as collecting no reaction feedback", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const { body } = await t.api(`/api/h/${id}/channels`);
      const routing = body["routing"] as Record<string, unknown>;
      // `sessionKeyMode`, because a field named `sessionKey` is redacted on
      // the way out — the rename is what keeps the caveat readable.
      expect(routing["sessionKeyMode"]).toBe("thread");
      expect(routing["specPath"]).toBe("routing.sessionKey");
      expect(routing["collectsReactions"]).toBe(false);
      expect(String(routing["reactionsNote"])).toContain("channel");
    } finally {
      await t.stop();
    }
  });

  test("a configured channel never becomes a green LIVE light on its own", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const { body } = await t.api(`/api/h/${id}/channels`);
      // The daemon is not running, so there is no /status to believe.
      expect(body["liveChannels"]).toBeNull();
      expect(body["statusSource"]).toBe("none");
      expect(typeof body["statusReason"]).toBe("string");
    } finally {
      await t.stop();
    }
  });

  test("both test tiers refuse a stopped daemon as a FACT, not an error", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      for (const route of ["probe", "synthetic"]) {
        const { status, body } = await t.api(`/api/h/${id}/channels/slack/${route}`, {
          method: "POST",
          body: JSON.stringify({ confirm: true }),
        });
        expect(`${route}:${status}`).toBe(`${route}:200`);
        expect(body["code"]).toBe("daemon_not_running");
        expect(body["expected"]).toBe(true);
      }
    } finally {
      await t.stop();
    }
  });

  test("the provisioning plan is printed and executes nothing", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const plan = await t.api(`/api/h/${id}/channels/slack/provision`);
      expect(plan.status).toBe(200);
      expect(plan.body["executes"]).toBe(false);
      const manifest = String((plan.body["plan"] as Record<string, unknown>)["manifest"]);
      expect(manifest).toContain("app_mentions:read");
      // A manifest declares scopes and URLs — never a credential.
      expect(manifest).not.toContain(SIGNING_SECRET);
      // Without a public origin there is nothing a platform could call back.
      expect(plan.body["baseUrlSupplied"]).toBe(false);

      const run = await t.api(`/api/h/${id}/channels/slack/provision`, {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });
      expect(run.body["submitted"]).toBe(false);
      expect(run.body["code"]).toBe("no_base_url");

      const withUrl = await t.api(`/api/h/${id}/channels/slack/provision`, {
        method: "POST",
        body: JSON.stringify({ confirm: true, baseUrl: "https://example.invalid" }),
      });
      expect(withUrl.body["submitted"]).toBe(true);
      const job = withUrl.body["job"] as { argv: string[] };
      expect(job.argv).toEqual([
        "channel",
        "provision",
        "--platform",
        "slack",
        "--base-url",
        "https://example.invalid",
      ]);
    } finally {
      await t.stop();
    }
  });

  test("offline verify answers inline; a live verify goes through the queue", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const offline = await t.api(`/api/h/${id}/channels/verify`, {
        method: "POST",
        body: JSON.stringify({ offline: true }),
      });
      expect(offline.body["mode"]).toBe("offline");
      // Discord's refs are unset in this fixture, so the gate is not green.
      expect(offline.body["ok"]).toBe(false);
      expect((offline.body["failing"] as string[]).some((line) => line.startsWith("discord"))).toBe(
        true,
      );

      const live = await t.api(`/api/h/${id}/channels/verify`, {
        method: "POST",
        body: JSON.stringify({ offline: false, platform: "slack" }),
      });
      expect(live.body["mode"]).toBe("live");
      expect((live.body["job"] as { argv: string[] }).argv).toEqual([
        "channel",
        "verify",
        "--platform",
        "slack",
      ]);
    } finally {
      await t.stop();
    }
  });

  test("the synthetic signer mirrors each platform's grammar and keeps the secret", () => {
    const spec = {
      yaml: "",
      specName: "sig",
      target: "channel",
      doc: {
        channels: {
          slack: { signingSecret: "$SLACK_SIGNING_SECRET" },
          telegram: { secretToken: "$TELEGRAM_SECRET_TOKEN" },
          whatsapp: { appSecret: "$WHATSAPP_APP_SECRET" },
          discord: { publicKeyHex: "$DISCORD_PUBLIC_KEY" },
        },
      },
    };
    const env = {
      SLACK_SIGNING_SECRET: SIGNING_SECRET,
      TELEGRAM_SECRET_TOKEN: "telegram-shared-value",
      WHATSAPP_APP_SECRET: "whatsapp-app-value",
    };
    const stamp = Math.floor(NOW / 1000);

    const slack = signSynthetic("slack", spec, "hello", NOW, env);
    if ("missing" in slack) throw new Error(slack.missing);
    // The exact grammar `verifySlackSignature` checks: v0 over the
    // timestamp AND the body, so a replayed body with a new stamp fails.
    expect(slack.headers["x-slack-request-timestamp"]).toBe(String(stamp));
    expect(slack.headers["x-slack-signature"]).toBe(
      `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${stamp}:${slack.body}`).digest("hex")}`,
    );
    // The secret itself is nowhere in what goes on the wire.
    expect(JSON.stringify(slack)).not.toContain(SIGNING_SECRET);

    // Telegram does NOT sign the body — the shared token IS the proof, so it
    // travels as a header value by design.
    const telegram = signSynthetic("telegram", spec, "hello", NOW, env);
    if ("missing" in telegram) throw new Error(telegram.missing);
    expect(telegram.headers["x-telegram-bot-api-secret-token"]).toBe("telegram-shared-value");

    const whatsapp = signSynthetic("whatsapp", spec, "hello", NOW, env);
    if ("missing" in whatsapp) throw new Error(whatsapp.missing);
    expect(whatsapp.headers["x-hub-signature-256"]).toBe(
      `sha256=${createHmac("sha256", "whatsapp-app-value").update(whatsapp.body).digest("hex")}`,
    );

    // Discord has no symmetric grammar at all — the refusal names the ENV
    // reference, never a value.
    const discord = signSynthetic("discord", spec, "hello", NOW, env);
    expect("missing" in discord).toBe(true);

    // An unset ref refuses by NAME.
    const unset = signSynthetic("slack", spec, "hello", NOW, {});
    expect("missing" in unset && unset.missing).toContain("$SLACK_SIGNING_SECRET");
  });

  test("the gateway panel offers the block it is missing rather than an error", async () => {
    const t = boot();
    try {
      const dir = makeFixtureHarness(join(t.harnessesRoot, "nogw"), {
        specName: "nogw-harness",
        model: "claude-opus-5",
      });
      const added = await t.api("/api/harnesses", {
        method: "POST",
        body: JSON.stringify({ dir }),
      });
      const id = (added.body["entry"] as { id: string }).id;
      const { status, body } = await t.api(`/api/h/${id}/gateway`);
      expect(status).toBe(200);
      expect(body["declared"]).toBe(false);
      expect((body["addBlock"] as Record<string, unknown>)["path"]).toBe("gateway");
      expect(body["verb"]).not.toBeNull();
    } finally {
      await t.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe("security", () => {
  test("audit records are RENDERED, hash-checked, and carry no file path", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const { status, body } = await t.api(`/api/h/${id}/audit`);
      expect(status).toBe(200);
      const records = body["records"] as Array<Record<string, unknown>>;
      expect(records.length).toBe(3);
      expect(records.every((record) => record["hashOk"] === true)).toBe(true);
      // Rendered records only: no path, no filename, no raw file body.
      expect(JSON.stringify(body)).not.toContain(".jsonl");
      expect(JSON.stringify(body)).not.toContain("/.crewhaus/");
      const kinds = (body["kinds"] as Array<Record<string, unknown>>).map((entry) =>
        String(entry["kind"]),
      );
      expect(kinds).toContain("egress_decision");
    } finally {
      await t.stop();
    }
  });

  test("verify reports its unchecked anchors as designed limitations", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const { body } = await t.api(`/api/h/${id}/audit/verify`, {
        method: "POST",
        body: "{}",
      });
      expect(body["ok"]).toBe(true);
      expect(body["recordsChecked"]).toBe(3);
      // No on-host anchor was written for this harness, so tail truncation
      // could not be ruled out — and the response says exactly that.
      expect(body["anchorChecked"]).toBe(false);
      expect(body["externalAnchorChecked"]).toBe(false);
      const limitations = body["limitations"] as string[];
      expect(limitations.length).toBe(2);
      expect(limitations.join(" ")).toContain("DESIGNED limitation");
    } finally {
      await t.stop();
    }
  });

  test("verify reports anchorChecked TRUE when the on-host anchor is present", async () => {
    const t = boot();
    try {
      const { id } = await seed(t, { anchor: true });
      const { body } = await t.api(`/api/h/${id}/audit/verify`, { method: "POST", body: "{}" });
      expect(body["ok"]).toBe(true);
      expect(body["anchorChecked"]).toBe(true);
      // The off-host anchor is a different, stronger claim and stays false.
      expect(body["externalAnchorChecked"]).toBe(false);
    } finally {
      await t.stop();
    }
  });

  test("egress rows carry lineage, and a triage is an APPEND beside the decision", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const listed = await t.api(`/api/h/${id}/security/egress`);
      const decisions = listed.body["decisions"] as Array<Record<string, unknown>>;
      expect(decisions.length).toBe(1);
      expect(decisions[0]?.["origins"]).toEqual(["tool_result:search"]);
      expect(String(listed.body["payloadNote"])).toContain("LINEAGE");
      const decisionId = String(decisions[0]?.["decisionId"]);

      const unknown = await t.api(`/api/h/${id}/security/egress/egr_999`, {
        method: "POST",
        body: JSON.stringify({ verdict: "allow" }),
      });
      // A verdict on a decision that does not exist is reported, not stored.
      expect(unknown.body["recorded"]).toBe(false);

      const recorded = await t.api(`/api/h/${id}/security/egress/${decisionId}`, {
        method: "POST",
        body: JSON.stringify({ verdict: "acknowledge", note: "known-good flow" }),
      });
      expect(recorded.body["recorded"]).toBe(true);
      const after = await t.api(`/api/h/${id}/security/egress`);
      const settled = (after.body["decisions"] as Array<Record<string, unknown>>)[0];
      expect((settled?.["triage"] as Record<string, unknown>)["verdict"]).toBe("acknowledge");
      expect(after.body["open"]).toBe(0);
    } finally {
      await t.stop();
    }
  });

  test("justification preflight projects from the record and never executes the tool", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const { body } = await t.api(`/api/h/${id}/security/justification/preflight`, {
        method: "POST",
        body: JSON.stringify({ tool: "Fetch" }),
      });
      expect(body["executed"]).toBe(false);
      expect(body["mode"]).toBe("historical-projection");
      expect(body["likelyVerdict"]).toBe("deny");
      const history = body["history"] as Record<string, unknown>;
      expect(history["evaluations"]).toBe(1);
      expect(history["denials"]).toBe(1);
      const judge = body["judge"] as Record<string, unknown>;
      expect(judge["configured"]).toBe("rule-based");
      expect(judge["threshold"]).toBe(0.6);
    } finally {
      await t.stop();
    }
  });

  test("a justification body is masked as free text", async () => {
    const t = boot();
    try {
      const dir = makeFixtureHarness(join(t.harnessesRoot, "just"), {
        specName: "just-harness",
        model: "claude-opus-5",
      });
      // An agent that pasted a token into its own rationale must not have it
      // re-served: key-based redaction cannot see into a sentence.
      const leaked = `I used ${["sk", "ant", "api03"].join("-")}-${"a".repeat(40)} to call it`;
      writeAuditChain(dir, [
        {
          kind: "permission_justification_evaluated",
          payload: {
            toolName: "Fetch",
            justification: leaked,
            verdict: "allow",
            judgeModel: "rule-based",
          },
        },
      ]);
      const added = await t.api("/api/harnesses", {
        method: "POST",
        body: JSON.stringify({ dir }),
      });
      const id = (added.body["entry"] as { id: string }).id;
      const { body } = await t.api(`/api/h/${id}/security/justification`);
      const records = body["records"] as Array<Record<string, unknown>>;
      expect(String(records[0]?.["justification"])).not.toContain("a".repeat(40));
    } finally {
      await t.stop();
    }
  });

  test("the SLO panel converts seconds to the declared millisecond target", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const { body } = await t.api(`/api/h/${id}/slo`);
      expect(body["declared"]).toBe(true);
      const targets = body["targets"] as Array<Record<string, unknown>>;
      const ttft = targets.find((target) => target["metric"] === "ttft_ms");
      // Observed 2 s against a 1500 ms target: the conversion is the whole
      // difference between "breached" and "1000x under".
      expect(ttft?.["observed"]).toBe(2000);
      expect(ttft?.["breached"]).toBe(true);
      const errorRate = targets.find((target) => target["metric"] === "error_rate");
      expect(errorRate?.["observed"]).toBe(0.1);
      expect(errorRate?.["breached"]).toBe(true);
      // egress_block_rate has no field on the metrics line — it is derived.
      const egressRate = targets.find((target) => target["metric"] === "egress_block_rate");
      expect(egressRate?.["observed"]).toBe(0.2);
      expect(body["ladder"]).toEqual(["alert", "pause-intake"]);
      expect((body["alerts"] as unknown[]).length).toBe(1);
      const exporters = body["exporters"] as Record<string, unknown>;
      expect(exporters["otlpEndpointConfigured"]).toBe(false);
    } finally {
      await t.stop();
    }
  });

  test("retention reads the policy's pins and refuses a real run without the typed name", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const console_ = await t.api(`/api/h/${id}/security/retention`);
      expect(console_.body["fromFile"]).toBe(true);
      expect(console_.body["sessionMaxAgeDays"]).toBe(45);
      expect(console_.body["pins"]).toEqual(["sess_00000000000000aa"]);

      for (const action of ["sweep", "purge"]) {
        const plan = await t.api(`/api/h/${id}/security/retention/${action}`, {
          method: "POST",
          body: JSON.stringify({ dryRun: true }),
        });
        expect(plan.body["dryRun"]).toBe(true);
        expect((plan.body["job"] as { argv: string[] }).argv).toEqual([
          "retention",
          action,
          "--dry-run",
        ]);

        // An OMITTED dryRun must never mean "do it".
        const defaulted = await t.api(`/api/h/${id}/security/retention/${action}`, {
          method: "POST",
          body: "{}",
        });
        expect(defaulted.body["dryRun"]).toBe(true);

        const refused = await t.api(`/api/h/${id}/security/retention/${action}`, {
          method: "POST",
          body: JSON.stringify({ dryRun: false }),
        });
        expect(refused.status).toBe(409);

        const real = await t.api(`/api/h/${id}/security/retention/${action}`, {
          method: "POST",
          body: JSON.stringify({ dryRun: false, confirmName: "area-harness" }),
        });
        expect(real.body["dryRun"]).toBe(false);
        expect((real.body["job"] as { argv: string[] }).argv).toEqual(["retention", action]);
      }
    } finally {
      await t.stop();
    }
  });

  test("a retention.json symlinked out of the harness is refused, not followed", async () => {
    const t = boot();
    try {
      const outside = join(t.workspace, "someone-elses-retention.json");
      writeFileSync(outside, JSON.stringify({ version: 1, pins: ["sess_00000000000000ff"] }));
      const dir = makeFixtureHarness(join(t.harnessesRoot, "linkret"), {
        specName: "linkret-harness",
        model: "claude-opus-5",
      });
      mkdirSync(join(dir, ".crewhaus"), { recursive: true });
      symlinkSync(outside, join(dir, ".crewhaus", "retention.json"));
      const added = await t.api("/api/harnesses", {
        method: "POST",
        body: JSON.stringify({ dir }),
      });
      const id = (added.body["entry"] as { id: string }).id;
      const { status, body } = await t.api(`/api/h/${id}/security/retention`);
      expect(status).toBe(200);
      // The policy library joins its own path, so containment is checked
      // BEFORE it is handed the directory — otherwise the pins of a harness
      // nobody asked about would show up here.
      expect(body["pins"]).toEqual([]);
      expect(body["fromFile"]).toBe(false);
      expect(String(body["note"])).toContain("outside");
    } finally {
      await t.stop();
    }
  });

  test("a malformed retention.json is a refusal, never a guess at the defaults", async () => {
    const t = boot();
    try {
      const dir = makeFixtureHarness(join(t.harnessesRoot, "badret"), {
        specName: "badret-harness",
        model: "claude-opus-5",
        retention: { sessions: { maxAgeDays: -1 } },
      });
      const added = await t.api("/api/harnesses", {
        method: "POST",
        body: JSON.stringify({ dir }),
      });
      const id = (added.body["entry"] as { id: string }).id;
      const { status, body } = await t.api(`/api/h/${id}/security/retention`);
      expect(status).toBe(200);
      expect(body["malformed"]).toBe(true);
      expect(body["sessionMaxAgeDays"]).toBeNull();
    } finally {
      await t.stop();
    }
  });

  test("the pii tuner previews before it writes, and the write needs the typed name", async () => {
    const t = boot();
    try {
      const { id, dir } = await seed(t);
      const policy = { version: 1, allow: [{ kind: "email", hash: "abc" }] };
      const preview = await t.api(`/api/h/${id}/security/pii`, {
        method: "POST",
        body: JSON.stringify({ policy, dryRun: true }),
      });
      expect(preview.body["wrote"]).toBe(false);
      expect((preview.body["preview"] as Record<string, unknown>)["changed"]).toBe(true);

      const refused = await t.api(`/api/h/${id}/security/pii`, {
        method: "POST",
        body: JSON.stringify({ policy, dryRun: false }),
      });
      expect(refused.status).toBe(409);

      const wrote = await t.api(`/api/h/${id}/security/pii`, {
        method: "POST",
        body: JSON.stringify({ policy, dryRun: false, confirmName: "area-harness" }),
      });
      expect(wrote.body["wrote"]).toBe(true);
      expect(readFileSync(join(dir, ".crewhaus", "pii-policy.json"), "utf8")).toContain("email");
    } finally {
      await t.stop();
    }
  });

  test("the onchain tuner NEVER writes the spec — it hands the edit to the spec path", async () => {
    const t = boot();
    try {
      const { id, dir } = await seed(t);
      const before = readFileSync(join(dir, "crewhaus.yaml"), "utf8");
      const policy = { approval: "auto", maxValueWei: "999999" };
      const applied = await t.api(`/api/h/${id}/security/onchain/tune`, {
        method: "POST",
        body: JSON.stringify({ policy, dryRun: false, confirmName: "area-harness" }),
      });
      expect(applied.body["wrote"]).toBe(false);
      expect((applied.body["specEdit"] as Record<string, unknown>)["path"]).toBe(
        "transaction_policy",
      );
      expect(applied.body["handoff"]).toBe("PUT /api/h/:id/spec");
      // The spec on disk is untouched: one writer, one diff, one review.
      expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(before);
    } finally {
      await t.stop();
    }
  });

  test("the onchain panel leads with transaction_policy and folds the receipt history", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const panel = await t.api(`/api/h/${id}/security/onchain`);
      expect(panel.body["approvalMode"]).toBe("human");
      expect((panel.body["receipts"] as unknown[]).length).toBe(1);
      const sentinel = await t.api(`/api/h/${id}/security/onchain/sentinel`);
      const baselines = sentinel.body["baselines"] as Array<Record<string, unknown>>;
      expect(baselines[0]).toMatchObject({ contractId: "vault", maxValueWei: "500" });
    } finally {
      await t.stop();
    }
  });

  test("sandbox doctor says what would happen to a tool call right now", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const { body } = await t.api(`/api/h/${id}/security/sandbox`);
      expect(body["declared"]).toBe(false);
      expect(String(body["wouldHappen"])).toContain("directly in the daemon's process");
      expect((body["backends"] as unknown[]).length).toBe(2);
    } finally {
      await t.stop();
    }
  });

  test("compliance evidence goes through the queue with a resolvable period", async () => {
    const t = boot();
    try {
      const { id } = await seed(t);
      const bad = await t.api(`/api/h/${id}/security/compliance`, {
        method: "POST",
        body: JSON.stringify({ framework: "not-a-framework" }),
      });
      expect(bad.status).toBe(400);
      const ok = await t.api(`/api/h/${id}/security/compliance`, {
        method: "POST",
        body: JSON.stringify({ framework: "soc2" }),
      });
      expect((ok.body["job"] as { argv: string[] }).argv).toEqual([
        "compliance",
        "evidence",
        "--framework",
        "soc2",
        "--period",
        "current",
      ]);
      const browser = await t.api(`/api/h/${id}/security/compliance`);
      expect(String(browser.body["retireNote"])).toContain("retire");
    } finally {
      await t.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// The lenient spec reader
// ---------------------------------------------------------------------------

describe("readYamlLoose", () => {
  test("reads the block subset specs are written in", () => {
    const doc = readYamlLoose(
      [
        "name: demo",
        "agent:",
        "  model: claude-opus-5",
        "  model_fallbacks:",
        "    - openai/gpt-5",
        "    - gemini/gemini-2.0",
        "instructions: |",
        "  first line",
        "  second line",
        "budget:",
        "  usd: 10",
        "  enabled: true",
        "schedule: { }",
        "list: [a, b]",
      ].join("\n"),
    ) as Record<string, unknown>;
    expect(doc["name"]).toBe("demo");
    expect((doc["agent"] as Record<string, unknown>)["model_fallbacks"]).toEqual([
      "openai/gpt-5",
      "gemini/gemini-2.0",
    ]);
    expect(doc["instructions"]).toBe("first line\nsecond line");
    expect((doc["budget"] as Record<string, unknown>)["usd"]).toBe(10);
    expect((doc["budget"] as Record<string, unknown>)["enabled"]).toBe(true);
    expect(doc["list"]).toEqual(["a", "b"]);
  });

  test("keeps a `#` inside a quoted scalar and drops a trailing comment", () => {
    const doc = readYamlLoose(
      ['cron: "0 */6 * * *" # every six hours', "plain: value # trailing"].join("\n"),
    ) as Record<string, unknown>;
    expect(doc["cron"]).toBe("0 */6 * * *");
    expect(doc["plain"]).toBe("value");
  });

  test("a sequence of maps keeps each item whole", () => {
    const doc = readYamlLoose(
      ["triggers:", "  - name: one", "    every: 1h", "  - name: two", "    every: 2h"].join("\n"),
    ) as Record<string, unknown>;
    expect(doc["triggers"]).toEqual([
      { name: "one", every: "1h" },
      { name: "two", every: "2h" },
    ]);
  });

  test("an unreadable document is `undefined`, never a throw", () => {
    expect(readYamlLoose("")).toEqual({});
    // Junk that is not block YAML still yields a value the callers can treat
    // as "nothing declared" — a fleet page must not 500 on a bad spec.
    expect(() => readYamlLoose(":::\n\t- [")).not.toThrow();
  });
});
