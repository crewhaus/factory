/**
 * The inspect browsers — driven over a live server, because the guards these
 * routes depend on (id resolution, param shape, the containment closure, the
 * outbound `maskDeep`) live at the dispatch site, and a unit test that called
 * the handlers directly would be testing a different thing than ships.
 *
 * What is pinned here is the security boundary, not the prose:
 *   - the allowlist is CLOSED — an unknown store 404s;
 *   - `secrets/`, the raw audit files and `.env*` are refused EVERYWHERE,
 *     including from the generic raw browser and from its directory listing;
 *   - containment is per FILE — a symlink planted inside a listed directory
 *     is reported, never followed;
 *   - `identity.json`'s private key never leaves the process, by projection
 *     AND by masking;
 *   - reads never write;
 *   - the one write is gated by a server-verified typed confirmation and
 *     lands atomically.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFixtureHarness } from "./fixture";
import { exclusionFor, maskRawText, settingsDiff, validateSettings } from "./inspect";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-04T00:00:00.000Z");

/** A harness with every inspectable store populated, plus the three excluded
 *  subtrees, so the exclusions are proven against files that really exist. */
function inspectHarness(t: TestServer): string {
  const dir = makeFixtureHarness(join(t.harnessesRoot, "inspect"), {
    specName: "inspect-harness",
    envLines: ["OPENAI_API_KEY=placeholder-not-a-credential"],
  });
  const ch = join(dir, ".crewhaus");
  const write = (rel: string, body: string): void => {
    const full = join(ch, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  };

  write("scope-audit/baseline.json", `${JSON.stringify({ findings: [] }, null, 2)}\n`);
  write("prompt-cache/inspect-harness.json", `${JSON.stringify({ marker: 2 })}\n`);
  write("logs/heartbeat.log", "boot\nturn ok\n");
  write("skills/faq/SKILL.md", "# FAQ\nAnswers distilled from feedback.\n");
  write("skills/faq/notes.md", "raw notes\n");
  write("commands/ship.md", "# /ship\nShip it.\n");
  write("preferences/max.md", "- prefers short answers\n");
  write(
    "settings.json",
    `${JSON.stringify({ permissions: { allow: ["Read"], deny: [] }, hooks: [] }, null, 2)}\n`,
  );
  write("knowledge.json", `${JSON.stringify({ share: true })}\n`);
  write("meta.json", `${JSON.stringify({ memories: 2 })}\n`);
  write("environments.json", `${JSON.stringify({ protected: ["prod"] })}\n`);
  // The identity file as `runtime-core` mints it — key material included, so
  // the projection has something real to refuse to serve. Built from parts:
  // a realistic-shaped literal in a fixture is what push protection blocks.
  write(
    "identity.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        agentId: "a".repeat(64),
        algorithm: "ed25519",
        publicKey: `MCowBQYDK2Vw${"A".repeat(20)}`,
        privateKey: `MC4CAQAwBQYDK2Vw${"Z".repeat(40)}`,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      null,
      2,
    )}\n`,
  );

  // The exclusions, all present on disk.
  write("secrets/vault.json", `${JSON.stringify({ token: "placeholder-not-a-credential" })}\n`);
  write("audit/2026-08-01.jsonl", `${JSON.stringify({ kind: "tool_call" })}\n`);
  // The raw child capture: unscrubbed by construction, which is exactly why
  // it is not browsable. The value below is the one in the harness `.env`.
  write("run/logs/run_00000000000000aa.log", "boot\nkey=placeholder-not-a-credential\n");

  return dir;
}

async function register(t: TestServer, dir: string): Promise<string> {
  const { body } = await t.api("/api/harnesses", {
    method: "POST",
    body: JSON.stringify({ dir }),
  });
  return (body["entry"] as { id: string }).id;
}

describe("inspect — pure helpers", () => {
  test("the exclusions are matched by NAME anywhere in the path, not by prefix", () => {
    expect(exclusionFor([".crewhaus", "secrets", "vault.json"])?.path).toBe(".crewhaus/secrets/");
    expect(exclusionFor([".crewhaus", "audit", "2026-08-01.jsonl"])?.path).toBe(".crewhaus/audit/");
    expect(exclusionFor([".env"])?.path).toBe(".env, .env.*");
    expect(exclusionFor([".env.local"])?.path).toBe(".env, .env.*");
    // The RAW capture: the scrubber lives on the run read path, not on the
    // file, so a generic text browser over it would undo the run console's
    // masking entirely.
    expect(exclusionFor([".crewhaus", "run", "logs"])?.path).toBe(".crewhaus/run/logs/");
    expect(exclusionFor([".crewhaus", "run", "logs", "run_00000000000000aa.log"])).not.toBeNull();
    // …but the ledger beside it is ordinary, masked state.
    expect(exclusionFor([".crewhaus", "run", "runs.jsonl"])).toBeNull();
    // A nested `secrets/` anywhere is refused too — over-refusing a browser
    // is recoverable, under-refusing it is not.
    expect(exclusionFor(["dist", "secrets", "x"])).not.toBeNull();
    expect(exclusionFor([".crewhaus", "skills", "faq"])).toBeNull();
  });

  test("the exclusions are CASE-FOLDED — the default filesystem here is not case-sensitive", () => {
    // APFS (darwin) and NTFS resolve these to the real directories, and
    // `resolveContained` answers with the caller's casing rather than the
    // realpath, so a branch compared case-SENSITIVELY is a suggestion rather
    // than a boundary. Two of the four were, and `.crewhaus/AUDIT/…` walked
    // through them.
    for (const segments of [
      [".crewhaus", "AUDIT", "2026-08-01.jsonl"],
      [".crewhaus", "Audit"],
      [".CREWHAUS", "audit", "2026-08-01.jsonl"],
      [".crewhaus", "run", "LOGS", "run_00000000000000aa.log"],
      [".crewhaus", "Run", "Logs"],
      [".CrewHaus", "RUN", "logs"],
      [".crewhaus", "SECRETS", "vault.json"],
      [".ENV"],
      [".Env.Local"],
    ]) {
      expect(`${segments.join("/")}:${exclusionFor(segments) === null}`).toBe(
        `${segments.join("/")}:false`,
      );
    }
  });

  test("raw text masking redacts a PEM private-key block the shape masker cannot see", () => {
    const pem = ["-----BEGIN PRIVATE KEY-----", "b".repeat(64), "-----END PRIVATE KEY-----"].join(
      "\n",
    );
    const masked = maskRawText(`before\n${pem}\nafter`);
    expect(masked).toContain("[redacted private key block]");
    expect(masked).not.toContain("b".repeat(64));
    expect(masked).toContain("before");
  });

  test("raw text masking is KEY-aware, so it agrees with maskSpecYaml about an inline literal", () => {
    // The literal `lowerCredential` compiles for any non-`$` value. SHORT on
    // purpose: under 32 characters, so every opaque-token rule in the shape
    // masker is out of reach and only reading the KEY off the line can catch
    // it — which is precisely how the raw browser came to serve in cleartext
    // what the spec view redacted.
    const inline = ["2a3b", "4c5d", "6e7f", "8a9b"].join("");
    expect(maskRawText(`    signingSecret: ${inline}`)).not.toContain(inline);
    expect(maskRawText(`  botToken: "${inline}" ?? "",`)).not.toContain(inline);
    expect(maskRawText(`  "api_key": "${inline}",`)).not.toContain(inline);
    // A REFERENCE is a name, not a value, and stays readable in both
    // spellings — the raw browser is where an operator goes to check exactly
    // that.
    expect(maskRawText("  signingSecret: $SLACK_SIGNING_SECRET")).toContain(
      "$SLACK_SIGNING_SECRET",
    );
    // Ordinary prose under an ordinary key is left alone: over-refusing a
    // browser is recoverable, but a masker that chews up every line is a
    // browser nobody reads.
    expect(maskRawText("  model: claude-opus-5")).toBe("  model: claude-opus-5");
  });

  test("settings validation mirrors what the loaders require, and passes unknown keys", () => {
    expect(validateSettings({ permissions: { allow: ["Read"] }, hooks: [] })).toEqual([]);
    // A key this manager version has never heard of must not be rejected —
    // that would make the console the thing that breaks a newer CLI.
    expect(validateSettings({ somethingNew: { a: 1 } })).toEqual([]);
    expect(validateSettings([])[0]?.message).toContain("must be a JSON object");
    expect(validateSettings({ hooks: {} })[0]?.path).toBe("hooks");
    expect(validateSettings({ hooks: [{ event: "PreToolUse" }] })[0]?.path).toBe(
      "hooks[0].command",
    );
    expect(validateSettings({ permissions: { allow: [1] } })[0]?.path).toBe("permissions.allow");
  });

  test("the diff is line-level and masked", () => {
    const diff = settingsDiff('{\n  "a": 1\n}\n', '{\n  "a": 2\n}\n');
    expect(diff).toEqual(['-   "a": 1', '+   "a": 2']);
  });
});

describe("inspect — the store index", () => {
  test("every allowlisted store is reported, the exclusions are named, and unmodelled dirs are offered to the raw browser", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const id = await register(t, inspectHarness(t));
      const { status, body } = await t.api(`/api/h/${id}/inspect`);
      expect(status).toBe(200);
      expect(body["present"]).toBe(true);
      const stores = body["stores"] as Array<Record<string, unknown>>;
      expect(stores.map((s) => s["store"]).sort()).toEqual(
        [
          "commands",
          "environments",
          "identity",
          "knowledge",
          "logs",
          "meta",
          "preferences",
          "prompt-cache",
          "scope-audit",
          "settings",
          "skills",
        ].sort(),
      );
      expect(stores.find((s) => s["store"] === "skills")?.["entries"]).toBe(1);
      expect(stores.find((s) => s["store"] === "settings")?.["present"]).toBe(true);

      // The exclusions are DATA, so the console can say why they are absent.
      const excluded = body["excluded"] as Array<Record<string, unknown>>;
      expect(excluded).toHaveLength(4);
      expect(excluded.map((e) => e["path"])).toContain(".crewhaus/secrets/");
      expect(excluded.map((e) => e["path"])).toContain(".crewhaus/run/logs/");

      // …and the "we have no rich view for this yet" list names the rest of
      // the tree without pretending it is empty.
      const unmodelled = body["unmodelled"] as string[];
      expect(unmodelled).toContain("sessions");
      expect(unmodelled).not.toContain("secrets");
      expect(unmodelled).not.toContain("audit");
    } finally {
      await t.stop();
    }
  });

  test("a harness that has written nothing is an empty state naming the verb, never a 500", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const id = await register(t, makeFixtureHarness(join(t.harnessesRoot, "bare")));
      const { status, body } = await t.api(`/api/h/${id}/inspect`);
      expect(status).toBe(200);
      expect(body["present"]).toBe(false);
      expect(body["verb"]).toBe("crewhaus run crewhaus.yaml");
      expect((body["stores"] as unknown[]).length).toBe(11);
    } finally {
      await t.stop();
    }
  });
});

describe("inspect — one store", () => {
  test("a directory store lists its entries; a file store returns the parsed document", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const id = await register(t, inspectHarness(t));
      const skills = await t.api(`/api/h/${id}/inspect/skills`);
      expect(skills.status).toBe(200);
      expect(skills.body["kind"]).toBe("dir");
      expect((skills.body["entries"] as Array<{ name: string }>).map((e) => e.name)).toEqual([
        "faq",
      ]);

      const settings = await t.api(`/api/h/${id}/inspect/settings`);
      expect(settings.status).toBe(200);
      expect(settings.body["kind"]).toBe("file");
      expect((settings.body["summary"] as Record<string, unknown>)["permissionRules"]).toEqual({
        allow: 1,
        deny: 0,
        ask: 0,
      });
    } finally {
      await t.stop();
    }
  });

  test("identity is PROJECTED to the fingerprint — the key material is presence only", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const id = await register(t, inspectHarness(t));
      const { status, body } = await t.api(`/api/h/${id}/inspect/identity`);
      expect(status).toBe(200);
      const doc = body["document"] as Record<string, unknown>;
      expect(doc["fingerprint"]).toBe("a".repeat(64));
      expect(doc["algorithm"]).toBe("ed25519");
      expect(doc["privateKeyPresent"]).toBe(true);
      expect(doc["publicKeyPresent"]).toBe(true);
      // Neither key VALUE appears anywhere in the serialized payload.
      const wire = JSON.stringify(body);
      expect(wire).not.toContain("Z".repeat(40));
      expect(wire).not.toContain("A".repeat(20));
      expect(body["text"]).toBeNull();
    } finally {
      await t.stop();
    }
  });

  test("an unknown store 404s — the allowlist is the boundary, not a filter", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const id = await register(t, inspectHarness(t));
      for (const store of ["secrets", "audit", "sessions", "memories"]) {
        const { status } = await t.api(`/api/h/${id}/inspect/${store}`);
        expect(`${store}:${status}`).toBe(`${store}:404`);
      }
    } finally {
      await t.stop();
    }
  });

  test("an absent store is an empty state with its verb, never an error", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const id = await register(t, makeFixtureHarness(join(t.harnessesRoot, "bare2")));
      const { status, body } = await t.api(`/api/h/${id}/inspect/scope-audit`);
      expect(status).toBe(200);
      expect(body["present"]).toBe(false);
      expect(String(body["verb"])).toContain("crewhaus lint");
    } finally {
      await t.stop();
    }
  });
});

describe("inspect — one entry", () => {
  test("a skill directory renders its SKILL.md body and its file list", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const id = await register(t, inspectHarness(t));
      const { status, body } = await t.api(`/api/h/${id}/inspect/skills/faq`);
      expect(status).toBe(200);
      expect(body["kind"]).toBe("dir");
      expect(String(body["text"])).toContain("Answers distilled from feedback");
      expect((body["files"] as Array<{ name: string }>).map((f) => f.name)).toEqual([
        "SKILL.md",
        "notes.md",
      ]);
    } finally {
      await t.stop();
    }
  });

  test("a single-file store says where its document is rather than 404ing on an entry", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const id = await register(t, inspectHarness(t));
      const { status, body } = await t.api(`/api/h/${id}/inspect/settings/anything`);
      expect(status).toBe(200);
      expect(body["present"]).toBe(false);
      expect(String(body["note"])).toContain(".crewhaus/settings.json");
    } finally {
      await t.stop();
    }
  });

  test("containment is per FILE: a symlink planted inside a listed store is reported, not followed", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = inspectHarness(t);
      const outside = join(t.workspace, "outside.md");
      writeFileSync(outside, "SECRET NOTES OUTSIDE THE HARNESS\n");
      symlinkSync(outside, join(dir, ".crewhaus", "commands", "escape.md"));
      const id = await register(t, dir);

      const listing = await t.api(`/api/h/${id}/inspect/commands`);
      const planted = (listing.body["entries"] as Array<Record<string, unknown>>).find(
        (e) => e["name"] === "escape.md",
      );
      expect(planted?.["kind"]).toBe("other");
      expect(String(planted?.["note"])).toContain("outside the harness");

      const entry = await t.api(`/api/h/${id}/inspect/commands/escape.md`);
      expect(entry.status).toBe(200);
      expect(entry.body["present"]).toBe(false);
      expect(JSON.stringify(entry.body)).not.toContain("SECRET NOTES");
    } finally {
      await t.stop();
    }
  });
});

describe("inspect — the generic raw browser", () => {
  test("with no ?path= it lists .crewhaus, hiding the excluded subtrees and naming them", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const id = await register(t, inspectHarness(t));
      const { status, body } = await t.api(`/api/h/${id}/inspect/raw`);
      expect(status).toBe(200);
      expect(body["kind"]).toBe("dir");
      const names = (body["entries"] as Array<{ name: string }>).map((e) => e.name);
      expect(names).toContain("skills");
      expect(names).not.toContain("secrets");
      expect(names).not.toContain("audit");
      expect(body["excludedHere"]).toEqual(expect.arrayContaining(["secrets", "audit"]));
    } finally {
      await t.stop();
    }
  });

  test("the exclusions are refused server-side, by path AND by name", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const id = await register(t, inspectHarness(t));
      const refused = [
        ".crewhaus/secrets",
        ".crewhaus/secrets/vault.json",
        ".crewhaus/audit",
        ".crewhaus/audit/2026-08-01.jsonl",
        ".env",
        ".env.local",
        ".crewhaus/run/logs",
        ".crewhaus/run/logs/run_00000000000000aa.log",
      ];
      for (const path of refused) {
        const { status, body } = await t.api(
          `/api/h/${id}/inspect/raw?path=${encodeURIComponent(path)}`,
        );
        expect(`${path}:${status}`).toBe(`${path}:403`);
        expect(`${path}:${JSON.stringify(body).includes("placeholder-not-a-credential")}`).toBe(
          `${path}:false`,
        );
      }
    } finally {
      await t.stop();
    }
  });

  test("the exclusions survive a case-varied ?path= on a case-insensitive filesystem", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const id = await register(t, inspectHarness(t));
      // Each of these resolves to the real, excluded file on APFS/NTFS. The
      // exclusion list IS the boundary here — there is no second gate
      // downstream — so a case-sensitive comparison hands over the raw
      // hash-chained audit records and the raw child capture.
      const refused = [
        ".crewhaus/AUDIT",
        ".crewhaus/Audit/2026-08-01.jsonl",
        ".CREWHAUS/audit/2026-08-01.jsonl",
        ".crewhaus/run/LOGS",
        ".crewhaus/Run/Logs/run_00000000000000aa.log",
        ".crewhaus/SECRETS/vault.json",
        ".ENV",
      ];
      for (const path of refused) {
        const { status, body } = await t.api(
          `/api/h/${id}/inspect/raw?path=${encodeURIComponent(path)}`,
        );
        expect(`${path}:${status}`).toBe(`${path}:403`);
        expect(`${path}:${JSON.stringify(body).includes("placeholder-not-a-credential")}`).toBe(
          `${path}:false`,
        );
      }
    } finally {
      await t.stop();
    }
  });

  test("an inline spec credential is redacted by the raw browser exactly as by /spec", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      // The one condition the whole stack models — `creds-ops` lints it,
      // `lowerCredential` compiles it — and the one the harness `.env`
      // scrubber by definition cannot help with, because the value is in the
      // spec rather than in any env file. Under 32 characters, so no
      // opaque-token rule can reach it and only the KEY can.
      const inline = ["2a3b", "4c5d", "6e7f", "8a9b"].join("");
      const dir = makeFixtureHarness(join(t.harnessesRoot, "inline"), {
        specName: "inline",
        target: "channel",
        specExtra: [
          "channels:",
          "  slack:",
          "    botToken: $SLACK_BOT_TOKEN",
          `    signingSecret: ${inline}`,
        ].join("\n"),
        // `lowerCredential` bakes a non-`$` value into the compiled bundle as
        // `{kind:"literal"}`, so the SAME secret sits in a file the raw
        // browser also serves as text. A `.yaml`-only rule would miss it.
        bundle: { entry: "agent.ts", body: `  signingSecret: "${inline}" ?? "",\n` },
      });
      mkdirSync(join(dir, ".crewhaus", "specs", "inline"), { recursive: true });
      writeFileSync(
        join(dir, ".crewhaus", "specs", "inline", "v1.yaml"),
        `name: inline\nchannels:\n  slack:\n    signingSecret: ${inline}\n`,
      );
      const id = await register(t, dir);

      const spec = await t.api(`/api/h/${id}/spec`);
      expect(spec.body["yaml"] as string).not.toContain(inline);

      for (const path of ["crewhaus.yaml", ".crewhaus/specs/inline/v1.yaml", "dist/agent.ts"]) {
        const { status, body } = await t.api(
          `/api/h/${id}/inspect/raw?path=${encodeURIComponent(path)}`,
        );
        expect(`${path}:${status}`).toBe(`${path}:200`);
        expect(`${path}:${JSON.stringify(body).includes(inline)}`).toBe(`${path}:false`);
      }
      // The env REFERENCE beside it is a name, not a value: still readable,
      // because "which variable does this harness want?" is the question the
      // raw browser exists to answer.
      const yaml = await t.api(
        `/api/h/${id}/inspect/raw?path=${encodeURIComponent("crewhaus.yaml")}`,
      );
      expect(String(yaml.body["text"])).toContain("$SLACK_BOT_TOKEN");
    } finally {
      await t.stop();
    }
  });

  test("a store symlinked out of the tree is REFUSED, not reported absent", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const outside = join(t.workspace, "real-settings.json");
      writeFileSync(outside, `${JSON.stringify({ permissions: { allow: ["Read"] } })}\n`);
      const dir = makeFixtureHarness(join(t.harnessesRoot, "escaped"), { specName: "escaped" });
      mkdirSync(join(dir, ".crewhaus"), { recursive: true });
      symlinkSync(outside, join(dir, ".crewhaus", "settings.json"));
      const id = await register(t, dir);

      // "Nothing there yet" and "there IS something there and this server
      // refuses to follow it" are different facts, and only one of them is an
      // empty state. Reporting the first offered the CLI verb that CREATES
      // the store, over a file that already exists somewhere else.
      const store = await t.api(`/api/h/${id}/inspect/settings`);
      expect(store.status).toBe(200);
      expect(store.body["present"]).toBe(false);
      expect(String(store.body["note"])).toContain("outside the harness directory");
      expect(store.body["verb"]).toBeNull();
      expect(JSON.stringify(store.body)).not.toContain("Read");

      // The index tells the same story as the store, and as the raw browser,
      // which already said the true thing.
      const index = await t.api(`/api/h/${id}/inspect`);
      const row = (index.body["stores"] as Array<Record<string, unknown>>).find(
        (s) => s["store"] === "settings",
      );
      expect(String(row?.["note"])).toContain("outside the harness directory");
      expect(row?.["verb"]).toBeNull();
    } finally {
      await t.stop();
    }
  });

  test("a modelled path says a rich view exists; an unmodelled one says it does not", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const id = await register(t, inspectHarness(t));
      const modelled = await t.api(`/api/h/${id}/inspect/raw?path=.crewhaus%2Fskills%2Ffaq`);
      expect(modelled.body["modelled"]).toBe("skills");
      const unmodelled = await t.api(`/api/h/${id}/inspect/raw?path=.crewhaus%2Fsessions`);
      expect(unmodelled.body["modelled"]).toBeNull();
      expect(String(unmodelled.body["modelledNote"])).toContain("raw fallback");
    } finally {
      await t.stop();
    }
  });

  test("the run dir is browsable but its raw capture is not, and the listing says so", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const id = await register(t, inspectHarness(t));
      const { status, body } = await t.api(`/api/h/${id}/inspect/raw?path=.crewhaus%2Frun`);
      expect(status).toBe(200);
      expect((body["entries"] as Array<{ name: string }>).map((e) => e.name)).not.toContain("logs");
      expect(body["excludedHere"]).toEqual(["logs"]);
    } finally {
      await t.stop();
    }
  });

  test("a raw text document is scrubbed of the harness's own credential VALUES, not just shapes", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = inspectHarness(t);
      // A scheduled unit's log, under the browsable `.crewhaus/logs/`, quoting
      // a value that is in this harness's `.env`. Shape masking alone would
      // walk past it — the env scrubber is what catches it.
      writeFileSync(
        join(dir, ".crewhaus", "logs", "nightly.log"),
        "starting\nusing placeholder-not-a-credential\ndone\n",
      );
      const id = await register(t, dir);
      const { status, body } = await t.api(`/api/h/${id}/inspect/logs/nightly.log`);
      expect(status).toBe(200);
      expect(String(body["text"])).not.toContain("placeholder-not-a-credential");
      expect(String(body["text"])).toContain("OPENAI_API_KEY");
    } finally {
      await t.stop();
    }
  });

  test("a JSONL document is parsed line by line so KEY-based redaction applies to it too", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = inspectHarness(t);
      writeFileSync(
        join(dir, ".crewhaus", "scope-audit", "2026-08-01.jsonl"),
        `${JSON.stringify({ id: 1, headers: { authorization: "Bearer abcdefghijkl" } })}\n{oops\n`,
      );
      const id = await register(t, dir);
      const { status, body } = await t.api(`/api/h/${id}/inspect/scope-audit/2026-08-01.jsonl`);
      expect(status).toBe(200);
      const rows = body["document"] as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.["headers"]).toEqual({ authorization: "[redacted]" });
      // One torn line is reported, never fatal, and never hides the rest.
      expect(String(body["parseError"])).toContain("torn");
    } finally {
      await t.stop();
    }
  });

  test("traversal and escape are refused; absence is an empty state", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const id = await register(t, inspectHarness(t));
      const up = await t.api(`/api/h/${id}/inspect/raw?path=${encodeURIComponent("../..")}`);
      expect(up.status).toBe(400);
      const missing = await t.api(`/api/h/${id}/inspect/raw?path=.crewhaus%2Fnope`);
      expect(missing.status).toBe(200);
      expect(missing.body["present"]).toBe(false);
    } finally {
      await t.stop();
    }
  });

  test("reads never write", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = inspectHarness(t);
      const id = await register(t, dir);
      const settingsPath = join(dir, ".crewhaus", "settings.json");
      const before = statSync(settingsPath).mtimeMs;
      for (const path of [
        `/api/h/${id}/inspect`,
        `/api/h/${id}/inspect/settings`,
        `/api/h/${id}/inspect/skills`,
        `/api/h/${id}/inspect/skills/faq`,
        `/api/h/${id}/inspect/raw?path=.crewhaus`,
      ]) {
        expect((await t.api(path)).status).toBe(200);
      }
      expect(statSync(settingsPath).mtimeMs).toBe(before);
    } finally {
      await t.stop();
    }
  });
});

describe("inspect — the settings.json write", () => {
  test("a dry run shows the masked diff and writes nothing", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = inspectHarness(t);
      const id = await register(t, dir);
      const path = join(dir, ".crewhaus", "settings.json");
      const before = readFileSync(path, "utf8");
      const { status, body } = await t.api(`/api/h/${id}/inspect/settings`, {
        method: "PUT",
        body: JSON.stringify({
          settings: { permissions: { allow: ["Read", "Write"] } },
          dryRun: true,
        }),
      });
      expect(status).toBe(200);
      expect(body["applied"]).toBe(false);
      expect((body["diff"] as string[]).length).toBeGreaterThan(0);
      expect(body["confirmName"]).toBe("inspect-harness");
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      await t.stop();
    }
  });

  test("the typed confirmation is verified by the SERVER, not by the client", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = inspectHarness(t);
      const id = await register(t, dir);
      const path = join(dir, ".crewhaus", "settings.json");
      const before = readFileSync(path, "utf8");

      const noConfirm = await t.api(`/api/h/${id}/inspect/settings`, {
        method: "PUT",
        body: JSON.stringify({ settings: { permissions: { allow: [] } } }),
      });
      expect(noConfirm.status).toBe(409);

      const wrongName = await t.api(`/api/h/${id}/inspect/settings`, {
        method: "PUT",
        body: JSON.stringify({
          settings: { permissions: { allow: [] } },
          confirmName: "some-other-harness",
        }),
      });
      expect(wrongName.status).toBe(409);
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      await t.stop();
    }
  });

  test("a confirmed write lands atomically and is visible on re-read; a malformed one is refused", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = inspectHarness(t);
      const id = await register(t, dir);
      const path = join(dir, ".crewhaus", "settings.json");

      const bad = await t.api(`/api/h/${id}/inspect/settings`, {
        method: "PUT",
        body: JSON.stringify({
          settings: { hooks: [{ event: "PreToolUse" }] },
          confirmName: "inspect-harness",
        }),
      });
      expect(bad.status).toBe(400);

      const ok = await t.api(`/api/h/${id}/inspect/settings`, {
        method: "PUT",
        body: JSON.stringify({
          settings: {
            permissions: { allow: ["Read", "Write"], deny: ["Bash"] },
            hooks: [{ event: "PreToolUse", command: "echo hi" }],
          },
          confirmName: "inspect-harness",
        }),
      });
      expect(ok.status).toBe(200);
      expect(ok.body["applied"]).toBe(true);

      // Effect visible on re-read, and no temp file left behind.
      const after = await t.api(`/api/h/${id}/inspect/settings`);
      expect((after.body["summary"] as Record<string, unknown>)["permissionRules"]).toEqual({
        allow: 2,
        deny: 1,
        ask: 0,
      });
      expect(JSON.parse(readFileSync(path, "utf8"))["hooks"]).toHaveLength(1);
      const strays = (
        await t.api(`/api/h/${id}/inspect/raw?path=${encodeURIComponent(".crewhaus")}`)
      ).body["entries"] as Array<{ name: string }>;
      expect(strays.some((e) => e.name.includes("hangar-tmp"))).toBe(false);
    } finally {
      await t.stop();
    }
  });
});
