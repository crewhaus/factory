import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommitOptions,
  DRAFT_ID_RE,
  MAX_SPEC_BYTES,
  clearPostCommitHooks,
  commitSpec,
  createSpecFile,
  parseYamlOnly,
  readSpecDraft,
  registerPostCommitHook,
  specDraftPath,
  specRev,
  specStateDir,
} from "./commit";
import { isCredentialKey } from "./redact";
import { RENAME_WARNING } from "./surfaces";

const SPEC = `# the demo harness
name: demo
target: cli
agent:
  model: claude-opus-5
  instructions: |
    You help.
`;

const dirs: string[] = [];
function harness(text = SPEC): string {
  const dir = mkdtempSync(join(tmpdir(), "spec-commit-"));
  dirs.push(dir);
  const path = join(dir, "crewhaus.yaml");
  writeFileSync(path, text);
  return path;
}

afterEach(() => {
  clearPostCommitHooks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const base = (expectedRev: string, extra: Partial<CommitOptions> = {}): CommitOptions => ({
  expectedRev,
  writer: "home.spec",
  actor: { kind: "person" },
  onWarn: () => undefined,
  ...extra,
});

const instructions = (text: string) => ({
  kind: "edits" as const,
  edits: [{ path: ["agent", "instructions"], value: text }],
});

describe("commitSpec: the revision check", () => {
  test("a change computed from the file on disk is written, keeping every untouched byte", async () => {
    const path = harness();
    const result = await commitSpec({ specPath: path }, instructions("You help kindly.\n"), {
      ...base(specRev(SPEC)),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wrote).toBe(true);
    expect(result.formatting).toBe("kept");
    expect(result.fromRev).toBe(specRev(SPEC));
    const after = readFileSync(path, "utf8");
    expect(after).toBe(SPEC.replace("You help.", "You help kindly."));
    expect(result.rev).toBe(specRev(after));
  });

  test("a writer that read before another writer committed is refused, and its change is kept as a draft", async () => {
    const path = harness();
    const rev0 = specRev(SPEC);
    let other: Awaited<ReturnType<typeof commitSpec>> | undefined;
    const mine = await commitSpec({ specPath: path }, instructions("Mine.\n"), {
      ...base(rev0),
      hooks: {
        afterRead: async () => {
          // A second writer commits between the first writer's read and its write.
          other = await commitSpec({ specPath: path }, instructions("Theirs.\n"), base(rev0));
        },
      },
    });
    expect(other?.ok).toBe(true);
    expect(mine.ok).toBe(false);
    if (mine.ok) return;
    expect(mine.code).toBe("conflict");
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).toContain("Theirs.");
    expect(mine.current?.rev).toBe(specRev(onDisk));
    const draftId = mine.draft?.id ?? "";
    expect(draftId).toMatch(DRAFT_ID_RE);
    const draft = readSpecDraft(path, draftId);
    expect(draft?.baseRev).toBe(rev0);
    expect(draft?.edits).toEqual([{ path: ["agent", "instructions"], value: "Mine.\n" }]);
    expect(statSync(mine.draft?.path ?? "").mode & 0o777).toBe(0o600);
  });

  test("a stale revision writes nothing", async () => {
    const path = harness();
    const result = await commitSpec(
      { specPath: path },
      instructions("x\n"),
      base(specRev("name: other\n")),
    );
    expect(result.ok === false && result.code).toBe("conflict");
    expect(readFileSync(path, "utf8")).toBe(SPEC);
  });

  test('"absent" refuses a file that exists, and createSpecFile never replaces one', async () => {
    const path = harness();
    const commit = await commitSpec(
      { specPath: path },
      { kind: "text", text: SPEC },
      base("absent"),
    );
    expect(commit.ok === false && commit.code).toBe("conflict");
    const created = createSpecFile(path, "name: other\ntarget: cli\n");
    expect(created).toEqual({ ok: false, code: "exists", reason: expect.any(String) });
    expect(readFileSync(path, "utf8")).toBe(SPEC);
  });

  test('"absent" creates the file when there is none', async () => {
    const path = harness();
    rmSync(path);
    const result = await commitSpec(
      { specPath: path },
      { kind: "text", text: SPEC },
      base("absent"),
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(SPEC);
  });

  test("createSpecFile creates a new spec", () => {
    const path = harness();
    rmSync(path);
    expect(createSpecFile(path, SPEC)).toEqual({ ok: true });
    expect(readFileSync(path, "utf8")).toBe(SPEC);
  });

  test("a spec past the read limit is refused whole", async () => {
    const path = harness(`${SPEC}# ${"x".repeat(MAX_SPEC_BYTES)}\n`);
    const result = await commitSpec({ specPath: path }, instructions("x\n"), base("whatever"));
    expect(result.ok === false && result.code).toBe("too-large");
  }, 20_000); // writes and reads a file past 4 MiB
});

describe("commitSpec: the file it writes", () => {
  for (const mode of [0o600, 0o644]) {
    test(`a ${mode.toString(8)} spec keeps its mode`, async () => {
      const path = harness();
      chmodSync(path, mode);
      const result = await commitSpec(
        { specPath: path },
        instructions("Hi.\n"),
        base(specRev(SPEC)),
      );
      expect(result.ok).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(mode);
    });
  }

  test("a spec that is a link is written where the link leads, and stays a link", async () => {
    const real = harness();
    const dir = mkdtempSync(join(tmpdir(), "spec-link-"));
    dirs.push(dir);
    const link = join(dir, "crewhaus.yaml");
    symlinkSync(real, link);
    const result = await commitSpec(
      { specPath: link },
      instructions("Linked.\n"),
      base(specRev(SPEC)),
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(real, "utf8")).toContain("Linked.");
    expect(readFileSync(link, "utf8")).toContain("Linked.");
    expect(specStateDir(link)).toBe(join(specStateDir(real)));
  });

  test("a result identical to the file writes nothing and leaves its mtime", async () => {
    const path = harness();
    utimesSync(path, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    const before = statSync(path).mtimeMs;
    const result = await commitSpec(
      { specPath: path },
      instructions("You help.\n"),
      base(specRev(SPEC)),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wrote).toBe(false);
    expect(statSync(path).mtimeMs).toBe(before);
    expect(existsSync(join(specStateDir(path), "commits.jsonl"))).toBe(false);
  });

  test("text changes are validated by the writer's parse, and keep the writer's text as given", async () => {
    const path = harness();
    const text =
      "name: demo\ntarget: cli\nagent:\n  model: claude-opus-5\n  instructions: Hi.\n  surprise: 1\n";
    const strict = await commitSpec(
      { specPath: path },
      { kind: "text", text },
      base(specRev(SPEC)),
    );
    expect(strict.ok === false && strict.code).toBe("invalid");
    const lenient = await commitSpec(
      { specPath: path },
      { kind: "text", text },
      base(specRev(SPEC), { parse: parseYamlOnly }),
    );
    expect(lenient.ok && lenient.formatting).toBe("as-given");
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  test("an edit that sets an unknown key passes with a lenient parse and fails without it", async () => {
    const path = harness();
    const change = { kind: "edits" as const, edits: [{ path: ["agent", "surprise"], value: 1 }] };
    const strict = await commitSpec({ specPath: path }, change, base(specRev(SPEC)));
    expect(strict.ok === false && strict.code).toBe("invalid");
    const lenient = await commitSpec(
      { specPath: path },
      change,
      base(specRev(SPEC), { parse: parseYamlOnly }),
    );
    expect(lenient.ok).toBe(true);
  });

  test("a validator's read-only answer writes nothing", async () => {
    const path = harness();
    const result = await commitSpec(
      { specPath: path },
      instructions("x\n"),
      base(specRev(SPEC), {
        validate: async () => ({ ok: false, code: "read-only", reason: "read-only", paths: ["a"] }),
      }),
    );
    expect(result.ok === false && result.code).toBe("read-only");
    expect(readFileSync(path, "utf8")).toBe(SPEC);
  });
});

describe("commitSpec: confirmations", () => {
  test("a rename needs the current name typed when the writer asks a person", async () => {
    const path = harness();
    const rename = { kind: "edits" as const, edits: [{ path: ["name"], value: "renamed" }] };
    const asked = await commitSpec(
      { specPath: path },
      rename,
      base(specRev(SPEC), { confirm: {} }),
    );
    expect(asked.ok).toBe(false);
    if (asked.ok) return;
    expect(asked.code).toBe("needs-confirmation");
    expect(asked.needs).toBe("typed-name");
    expect(asked.reason).toBe(RENAME_WARNING);
    expect(readFileSync(path, "utf8")).toBe(SPEC);
    const typed = await commitSpec(
      { specPath: path },
      rename,
      base(specRev(SPEC), { confirm: { name: "demo" } }),
    );
    expect(typed.ok).toBe(true);
  });

  test("a writer that asks nobody is never asked", async () => {
    const path = harness();
    const rename = { kind: "edits" as const, edits: [{ path: ["name"], value: "renamed" }] };
    const result = await commitSpec({ specPath: path }, rename, base(specRev(SPEC)));
    expect(result.ok).toBe(true);
  });

  test("a budget raise needs the security confirmation", async () => {
    const path = harness(`${SPEC}budget:\n  usd: 5\n`);
    const raise = { kind: "edits" as const, edits: [{ path: ["budget", "usd"], value: 50 }] };
    const result = await commitSpec(
      { specPath: path },
      raise,
      base(specRev(readFileSync(path, "utf8")), { confirm: {} }),
    );
    expect(result.ok === false && result.needs).toBe("h.spec.edit.security");
  });
});

describe("commitSpec: what it keeps", () => {
  test("one content-free line per commit, every field name outside the credential masker", async () => {
    const sentinel = "SENTINEL-VALUE-91c2";
    const path = harness();
    const at = new Date("2026-11-12T10:00:00Z");
    const result = await commitSpec(
      { specPath: path },
      instructions(`${sentinel}\n`),
      base(specRev(SPEC), {
        writer: "cli.optimize",
        actor: { kind: "person", by: "prn_abc" },
        now: () => at,
        register: async () => ({ version: "v3" }),
      }),
    );
    expect(result.ok && result.registered).toBe("v3");
    const ledgerPath = join(specStateDir(path), "commits.jsonl");
    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(sentinel);
    const line = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(line).toEqual({
      v: 1,
      at: at.toISOString(),
      fromRev: specRev(SPEC),
      toRev: specRev(readFileSync(path, "utf8")),
      writer: "cli.optimize",
      actor: { kind: "person", by: "prn_abc" },
      paths: ["agent"],
      registered: "v3",
      formatting: "kept",
    });
    expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
    const names = (value: unknown): string[] =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.entries(value).flatMap(([k, v]) => [k, ...names(v)])
        : [];
    const draftFields = ["v", "at", "baseRev", "writer", "actor", "kind", "by", "edits", "text"];
    for (const field of [...names(line), ...draftFields, "path", "value", "rationale"]) {
      expect(isCredentialKey(field)).toBe(false);
    }
  });

  test("an actor that is not a principal id is recorded by kind only", async () => {
    const path = harness();
    await commitSpec(
      { specPath: path },
      instructions("x\n"),
      base(specRev(SPEC), { actor: { kind: "person", by: "alice@laptop" } }),
    );
    const line = readFileSync(join(specStateDir(path), "commits.jsonl"), "utf8");
    expect(line).not.toContain("alice");
    expect(JSON.parse(line).actor).toEqual({ kind: "person" });
  });

  test("a registration that fails leaves the commit written, with a note", async () => {
    const path = harness();
    const result = await commitSpec(
      { specPath: path },
      instructions("x\n"),
      base(specRev(SPEC), {
        register: async () => {
          throw new Error("registry offline");
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registered).toBeUndefined();
    expect(result.note).toContain("registry offline");
  });

  test("drafts older than thirty days are pruned on the next commit, younger ones kept", async () => {
    const path = harness();
    const now = new Date("2026-11-12T12:00:00Z");
    const drafts = join(specStateDir(path), "drafts");
    mkdirSync(drafts, { recursive: true });
    const stamp = (d: Date) =>
      d
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");
    const day = 24 * 60 * 60 * 1000;
    const old = `${stamp(new Date(now.getTime() - 31 * day))}-0000aaaa`;
    const young = `${stamp(new Date(now.getTime() - 29 * day))}-0000bbbb`;
    for (const id of [old, young]) writeFileSync(join(drafts, `${id}.json`), "{}");
    await commitSpec(
      { specPath: path },
      instructions("x\n"),
      base(specRev(SPEC), { now: () => now }),
    );
    expect(readdirSync(drafts).sort()).toEqual([`${young}.json`]);
  });

  test("a draft reader refuses an id that is not a draft id", () => {
    const path = harness();
    for (const id of ["../x", "/etc/passwd", `20261112T120000Z-0000aaaa${"0".repeat(64)}`, ""]) {
      expect(specDraftPath(path, id)).toBeUndefined();
      expect(readSpecDraft(path, id)).toBeUndefined();
    }
  });
});

describe("commitSpec: the commit state stays inside the spec's directory", () => {
  function outsideDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "spec-outside-"));
    dirs.push(dir);
    return dir;
  }

  test("a .crewhaus that links outside is refused as unwritable, and nothing is created where it leads", async () => {
    const path = harness();
    const outside = outsideDir();
    symlinkSync(outside, join(path, "..", ".crewhaus"));
    for (const rev of [specRev(SPEC), specRev("name: stale\n")]) {
      const result = await commitSpec({ specPath: path }, instructions("Mine.\n"), base(rev));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("unwritable");
      expect(result.draft).toBeUndefined();
      expect(result.reason).toContain("not a plain directory");
    }
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(SPEC);
  });

  test("a drafts directory that links outside keeps no draft there, and no draft is read through it", async () => {
    const path = harness();
    const outside = outsideDir();
    const state = specStateDir(path);
    mkdirSync(state, { recursive: true });
    symlinkSync(outside, join(state, "drafts"));
    const result = await commitSpec(
      { specPath: path },
      instructions("Mine.\n"),
      base(specRev("name: stale\n")),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unwritable");
    expect(result.draft).toBeUndefined();
    expect(readdirSync(outside)).toEqual([]);
    const id = "20261112T120000Z-0000aaaa";
    writeFileSync(join(outside, `${id}.json`), JSON.stringify({ v: 1, text: "planted" }));
    expect(readSpecDraft(path, id)).toBeUndefined();
  });
});

describe("commitSpec: post-commit hooks", () => {
  test("a hook is told the revisions and the top-level paths", async () => {
    const path = harness();
    const seen: unknown[] = [];
    registerPostCommitHook((event) => {
      seen.push(event);
    });
    const result = await commitSpec({ specPath: path }, instructions("x\n"), base(specRev(SPEC)));
    expect(result.ok).toBe(true);
    expect(seen).toEqual([
      {
        specDir: expect.any(String),
        fromRev: specRev(SPEC),
        toRev: specRev(readFileSync(path, "utf8")),
        paths: ["agent"],
        writer: "home.spec",
        actor: { kind: "person" },
      },
    ]);
  });

  test("a hook that throws leaves the commit ok and is reported", async () => {
    const path = harness();
    registerPostCommitHook(() => {
      throw new Error("hook broke");
    });
    const warnings: string[] = [];
    const result = await commitSpec(
      { specPath: path },
      instructions("x\n"),
      base(specRev(SPEC), { onWarn: (m) => warnings.push(m) }),
    );
    expect(result.ok).toBe(true);
    expect(warnings.join("\n")).toContain("hook broke");
  });
});
