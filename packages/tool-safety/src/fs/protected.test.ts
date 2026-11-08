/**
 * The runtime-state roots a run hands its tools (`protectedRootsOf`), and
 * where a path stands against them: inside one (`protectedRootHolding`), or
 * above one (`protectedRootBeneath`, `protectedRootsBeneath`) — through a
 * link too, in either direction.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialRootsOf,
  foldedName,
  gitDirectoryWriteRefusal,
  heldFileRefusal,
  heldInTree,
  isCredentialFileName,
  isHeldFile,
  landsInGitDirectory,
  namesGitDirectory,
  protectedRootBeneath,
  protectedRootHolding,
  protectedRootLinkedInto,
  protectedRootsBeneath,
  protectedRootsOf,
  protectedWriteRefusal,
  rootsBesideStore,
} from "./protected";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "tool-safety-protected-"));
  mkdirSync(join(ws, ".crewhaus", "sessions"), { recursive: true });
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("protected roots", () => {
  test("read off the bridge; anything else is none", () => {
    expect(protectedRootsOf({ bridge: { protectedRoots: ["a", "", 3, "b"] } })).toEqual(["a", "b"]);
    for (const ctx of [undefined, {}, { bridge: null }, { bridge: { protectedRoots: "a" } }]) {
      expect(protectedRootsOf(ctx)).toEqual([]);
    }
  });

  test("inside, above, and neither — relative roots read against cwd", () => {
    const roots = [".crewhaus/sessions"];
    expect(protectedRootHolding(join(ws, ".crewhaus/sessions/x.jsonl"), roots, ws)).toBe(
      ".crewhaus/sessions",
    );
    expect(protectedRootHolding(join(ws, ".crewhaus"), roots, ws)).toBeUndefined();
    expect(protectedRootBeneath(join(ws, ".crewhaus"), roots, ws)).toBe(".crewhaus/sessions");
    expect(protectedRootBeneath(ws, roots, ws)).toBe(".crewhaus/sessions");
    expect(protectedRootBeneath(join(ws, "src"), roots, ws)).toBeUndefined();
    expect(protectedRootsBeneath(ws, roots, ws)).toEqual([
      { root: ".crewhaus/sessions", rel: join(".crewhaus", "sessions") },
    ]);
  });

  test("a link on the way neither hides a root nor invents one", () => {
    const real = realpathSync(ws);
    symlinkSync(join(ws, ".crewhaus"), join(ws, "state-link"));
    const roots = [join(real, ".crewhaus", "sessions")];
    // Through the link, the sessions directory is inside.
    expect(protectedRootHolding(join(ws, "state-link", "sessions", "x"), roots, ws)).toBe(roots[0]);
    // The link itself stands above it.
    expect(protectedRootBeneath(join(ws, "state-link"), roots, ws)).toBe(roots[0]);
    expect(protectedRootsBeneath(join(ws, "state-link"), roots, ws)).toEqual([
      { root: roots[0] as string, rel: "sessions" },
    ]);
  });

  test("an exact-file root holds that file and nothing it is a prefix of", () => {
    // The settings file is protected as one file: a directory root and a
    // file root are compared the same way, name by name, never as strings.
    const settings = join(".crewhaus", "settings.json");
    const roots = [settings, join(ws, settings)];
    expect(protectedRootHolding(join(ws, settings), roots, ws)).toBe(settings);
    expect(protectedRootHolding(settings, roots, ws)).toBe(settings);
    for (const neighbour of [
      join(".crewhaus", "settings.json.bak"),
      join(".crewhaus", "settings.jsonx"),
      join(".crewhaus", "notes.md"),
    ]) {
      expect({ neighbour, held: protectedRootHolding(neighbour, roots, ws) }).toEqual({
        neighbour,
        held: undefined,
      });
    }
    // The directory that holds it: removing or replacing `.crewhaus` removes it.
    expect(protectedRootBeneath(join(ws, ".crewhaus"), roots, ws)).toBe(settings);
    expect(protectedRootBeneath(".crewhaus", roots, ws)).toBe(settings);
    expect(protectedRootBeneath(join(ws, "src"), roots, ws)).toBeUndefined();
  });

  test("the refusal names the record and the files that control the run, and says nothing was written", () => {
    const text = protectedWriteRefusal("MovePath", "moving onto .crewhaus/settings.json");
    expect(text).toContain(
      "would write where the runtime keeps its own record of the run (session logs, spilled tool results, proof bundles)",
    );
    expect(text).toContain(
      "or the files that control it (the harness's run files, settings, gate records, environment files, compiled bundle and dependencies, Hangar's directory)",
    );
    expect(text).toContain("Nothing was written.");
    expect(
      text.startsWith("MovePath: refused — moving onto .crewhaus/settings.json would write"),
    ).toBe(true);
  });
});

describe("foldedName: a name as a filesystem that does not tell names apart compares it", () => {
  test("the folds, the code points HFS+ ignores, and what Windows trims", () => {
    for (const [name, folded] of [
      ["SETTINGS.JSON", "settings.json"],
      ["\u017Fettings.json", "settings.json"],
      ["se\u00DFions", "sessions"],
      ["SE\u1E9EIONS", "sessions"],
      ["\u212Aey", "key"],
      ["\uFB01x", "fix"],
      ["li\uFB05s", "lists"],
      ["li\uFB06s", "lists"],
      ["caf\u0065\u0301", "caf\u00E9"],
      ["\u03A3\u03A3", "\u03C3\u03C3"],
      ["a\u200Cb\uFEFF", "ab"],
      ["settings.json.", "settings.json"],
      ["settings.json .", "settings.json"],
      ["settings.json::$DATA", "settings.json"],
      ["run:$I30:$INDEX_ALLOCATION", "run"],
      // Only dots and spaces, or a leading colon: nothing to trim to.
      ["..", ".."],
      ["...", "..."],
      [" ", " "],
      [":x", ":x"],
      // Would fold to nothing, `.` or `..`: still a name.
      ["\u200C", "\u200C"],
      [".\u200C", ".\u200C"],
      ["..\u200C", "..\u200C"],
    ] as const) {
      expect({ name, folded: foldedName(name) }).toEqual({ name, folded });
    }
  });

  test("the fold is stable: folding twice changes nothing", () => {
    for (let cp = 0x80; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const once = foldedName(`x${String.fromCodePoint(cp)}y`);
      expect(foldedName(once)).toBe(once);
    }
  }, 20_000); // two folds per code point of the plane

  test("where the volume folds, it never reads a code point as a letter the fold does not", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tool-safety-fold-")));
    try {
      writeFileSync(join(dir, "probe"), "");
      let folds = false;
      try {
        lstatSync(join(dir, "PROBE"));
        folds = true;
      } catch {}
      // A volume that keeps case has nothing to compare with.
      if (!folds) return;
      const byInode = new Map<number, string>();
      for (const name of [
        ..."abcdefghijklmnopqrstuvwxyz",
        "ss",
        "st",
        "ff",
        "fi",
        "fl",
        "ffi",
        "ffl",
      ]) {
        const at = join(dir, `x${name}y`);
        writeFileSync(at, "");
        byInode.set(lstatSync(at).ino, `x${name}y`);
      }
      const missed: string[] = [];
      for (let cp = 0x80; cp <= 0xffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        const written = `x${String.fromCodePoint(cp)}y`;
        let stored: string | undefined;
        try {
          stored = byInode.get(lstatSync(join(dir, written)).ino);
        } catch {}
        if (stored !== undefined && foldedName(written) !== stored) {
          missed.push(`U+${cp.toString(16)} is ${stored} on this volume`);
        }
      }
      expect(missed).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000); // one lstat per code point of the plane
});

describe("a root under another spelling, the name not there yet", () => {
  const roots = () => [
    join(ws, ".crewhaus", "settings.json"),
    join(ws, ".crewhaus", "run"),
    join(ws, ".crewhaus", "sessions"),
  ];
  test("a path in one is held; a neighbour is not", () => {
    for (const rel of [
      join(".crewhaus", "SETTINGS.JSON"),
      join(".crewhaus", "\u017Fetting\u017F.json"),
      join(".crewhau\u017F", "run", "x"),
      join(".CREWHAUS", "RUN", "x"),
      join(".crewhaus", "settings.json."),
      join(".crewhaus", "settings.json::$DATA"),
      join(".crewhaus", "run", "..\u200C", "x"),
    ]) {
      expect({ rel, held: protectedRootHolding(join(ws, rel), roots()) !== undefined }).toEqual({
        rel,
        held: true,
      });
    }
    for (const rel of [
      join(".crewhaus", "settings.json.bak"),
      join(".crewhaus", "runbook", "x"),
      join(".crewhaus", "notes.md"),
    ]) {
      expect({ rel, held: protectedRootHolding(join(ws, rel), roots()) !== undefined }).toEqual({
        rel,
        held: false,
      });
    }
  });
  test("a directory above one is found, and the root's own names come back below it", () => {
    rmSync(join(ws, ".crewhaus"), { recursive: true, force: true });
    const dir = join(ws, ".crewhau\u017F");
    expect(protectedRootBeneath(dir, roots())).toBeDefined();
    expect(protectedRootsBeneath(dir, [join(ws, ".crewhaus", "run")])).toEqual([
      { root: join(ws, ".crewhaus", "run"), rel: "run" },
    ]);
    expect(protectedRootsBeneath(ws, [join(ws, ".crewhaus", "run")])).toEqual([
      { root: join(ws, ".crewhaus", "run"), rel: join(".crewhaus", "run") },
    ]);
    const cased = join(ws, "Home", "Hangar");
    expect(protectedRootsBeneath(ws, [cased])).toEqual([
      { root: cased, rel: join("Home", "Hangar") },
    ]);
    expect(protectedRootsBeneath(join(ws, "HOME"), [cased])).toEqual([
      { root: cased, rel: "Hangar" },
    ]);
  });
});

// What foldedName says of Windows, asked of Windows. Depending on the path form
// the runtime uses, the volume opens each of these spellings as the plain name
// or keeps it as written; foldedName reads the plain name either way, so the
// floor refuses both.
test.if(process.platform === "win32")(
  "Windows stores each of these as the plain name or as written, and foldedName reads the plain name",
  () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tool-safety-names-")));
    try {
      for (const written of ["probe.", "probe ", "probe. .", "probe::$DATA"]) {
        writeFileSync(join(dir, written), written);
        const stored = readdirSync(dir);
        const name = stored[0] ?? "";
        expect({
          written,
          stored: stored.length,
          plainOrWritten: name === "probe" || name === written,
        }).toEqual({
          written,
          stored: 1,
          plainOrWritten: true,
        });
        if (name === "probe") expect(readFileSync(join(dir, "probe"), "utf8")).toBe(written);
        expect(foldedName(written)).toBe("probe");
        rmSync(join(dir, name), { force: true });
      }
      // A directory spelling opens the plain directory or names one that does
      // not exist; the write never lands anywhere else.
      mkdirSync(join(dir, "held"));
      for (const [spelling, file] of [
        ["held::$INDEX_ALLOCATION", "x"],
        ["held.", "y"],
      ] as const) {
        let wrote = true;
        try {
          writeFileSync(join(dir, spelling, file), file);
        } catch {
          wrote = false;
        }
        if (wrote) expect(readFileSync(join(dir, "held", file), "utf8")).toBe(file);
        expect(readdirSync(dir)).toEqual(["held"]);
        expect(foldedName(spelling)).toBe("held");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

describe("protectedRootLinkedInto", () => {
  const roots = [".crewhaus/sessions", ".crewhaus/settings.json"];
  test("a path with no link on it is none of its business, inside a root or not", () => {
    const real = realpathSync(ws);
    for (const rel of ["notes/x", ".crewhaus/sessions/s.jsonl"]) {
      const abs = join(real, rel);
      expect({ rel, root: protectedRootLinkedInto(abs, abs, roots, real) }).toEqual({
        rel,
        root: undefined,
      });
    }
  });
  test("a link into a root names it, whether or not the target exists yet", () => {
    const real = realpathSync(ws);
    const named = join(real, "x", "s.jsonl");
    const landsAt = join(real, ".crewhaus", "settings.json");
    expect(protectedRootLinkedInto(named, landsAt, roots, real)).toBe(".crewhaus/settings.json");
  });
  test("a name inside one root that a link takes to another names the other", () => {
    const real = realpathSync(ws);
    const named = join(real, ".crewhaus", "sessions", "out.jsonl");
    const landsAt = join(real, ".crewhaus", "settings.json");
    expect(protectedRootLinkedInto(named, landsAt, roots, real)).toBe(".crewhaus/settings.json");
  });
  test("a name that stays in its root is not carried, when a link above holds the root", () => {
    const real = realpathSync(ws);
    mkdirSync(join(real, "data", "crew", "sessions"), { recursive: true });
    const linked = join(real, "harness");
    mkdirSync(linked);
    symlinkSync(join("..", "data", "crew"), join(linked, ".crewhaus"));
    const named = join(linked, ".crewhaus", "sessions", "s.jsonl");
    const landsAt = join(real, "data", "crew", "sessions", "s.jsonl");
    expect(protectedRootLinkedInto(named, landsAt, roots, linked)).toBe(undefined);
  });
  test("no roots, no answer", () => {
    expect(protectedRootLinkedInto("a", "b", [], realpathSync(ws))).toBe(undefined);
  });
});

describe("rootsBesideStore: the root a tool keeps its own store in, left out", () => {
  const STORE = ".crewhaus/datasets";
  test("the store's spellings go, every other root stays", () => {
    const real = realpathSync(ws);
    const roots = [
      join(real, STORE),
      join(".crewhaus", "datasets"),
      join(real, ".crewhaus", "run"),
      join(".crewhaus", "run"),
      join(real, ".crewhaus", "datasets.bak"),
    ];
    expect(rootsBesideStore(STORE, roots, real)).toEqual([
      join(real, ".crewhaus", "run"),
      join(".crewhaus", "run"),
      join(real, ".crewhaus", "datasets.bak"),
    ]);
  });
  test("a store that is no root changes nothing", () => {
    const real = realpathSync(ws);
    const roots = [join(real, ".crewhaus", "run"), join(".crewhaus", "run")];
    expect(rootsBesideStore(STORE, roots, real)).toEqual(roots);
  });
  test("a root that holds the store, and one inside it, stay", () => {
    const real = realpathSync(ws);
    const roots = [real, join(real, STORE, "inner")];
    expect(rootsBesideStore(STORE, roots, real)).toEqual(roots);
  });
  test("an operator's link above the store: the place it leads to goes with it", () => {
    const real = realpathSync(ws);
    mkdirSync(join(real, "data", "crew"), { recursive: true });
    const linked = join(real, "harness");
    mkdirSync(linked);
    symlinkSync(join("..", "data", "crew"), join(linked, ".crewhaus"));
    const roots = [
      join(linked, STORE),
      join(".crewhaus", "datasets"),
      join(real, "data", "crew", "datasets"),
      join(real, "data", "crew", "run"),
    ];
    expect(rootsBesideStore(STORE, roots, linked)).toEqual([join(real, "data", "crew", "run")]);
  });
  test("a working directory reached through a link: a root's relative name goes with it", () => {
    const real = realpathSync(ws);
    mkdirSync(join(real, "target", "harness", "data", "crew"), { recursive: true });
    symlinkSync(join(real, "target"), join(real, "via"));
    const cwd = join(real, "via", "harness");
    symlinkSync(join("data", "crew"), join(cwd, ".crewhaus"));
    const roots = [
      join(cwd, STORE),
      join(".crewhaus", "datasets"),
      join("data", "crew", "datasets"),
      join("data", "crew", "run"),
    ];
    expect(rootsBesideStore(STORE, roots, cwd)).toEqual([join("data", "crew", "run")]);
  });
  test("a link at the store itself keeps where it leads, so another root still holds it", () => {
    const real = realpathSync(ws);
    mkdirSync(join(real, ".crewhaus", "run"), { recursive: true });
    symlinkSync("run", join(real, ".crewhaus", "datasets"));
    const run = join(real, ".crewhaus", "run");
    const roots = [join(real, STORE), run];
    const beside = rootsBesideStore(STORE, roots, real);
    expect(beside).toEqual([run]);
    expect(protectedRootHolding(STORE, beside, real)).toBe(run);
  });
  test("no roots, no store's", () => {
    expect(rootsBesideStore(STORE, [], realpathSync(ws))).toEqual([]);
  });
});

describe("namesGitDirectory", () => {
  test("a name git treats as its own directory, in each spelling that opens it", () => {
    for (const path of [
      ".git",
      ".git/config",
      "n/.git",
      "n/.git/HEAD",
      "n\\.git\\config",
      ".GIT/config",
      ".Git/config",
      ".git./config",
      ".git /config",
      ".git::$INDEX_ALLOCATION/config",
      "git~1/config",
      "GIT~1",
    ]) {
      expect({ path, named: namesGitDirectory(path) }).toEqual({ path, named: true });
    }
  });

  test("a name that only starts or ends like one does not count", () => {
    for (const path of [
      ".gitignore",
      ".gitattributes",
      ".gitmodules",
      ".github/x",
      "foo.git/x",
      "git/config",
      "git~2/config",
      "",
      ".",
    ]) {
      expect({ path, named: namesGitDirectory(path) }).toEqual({ path, named: false });
    }
  });
});

describe("landsInGitDirectory", () => {
  test("reads a path as resolved and with its links followed, from the workspace", () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-safety-git-")));
    try {
      mkdirSync(join(ws, ".git"));
      mkdirSync(join(ws, "plain"));
      symlinkSync(".git", join(ws, "lnk"));
      symlinkSync("plain", join(ws, "other"));
      expect(landsInGitDirectory(join(ws, ".git", "config"), ws)).toBe(true);
      expect(landsInGitDirectory(join(ws, "n", ".git", "config"), ws)).toBe(true);
      expect(landsInGitDirectory("lnk/config", ws)).toBe(true);
      expect(landsInGitDirectory("lnk", ws)).toBe(true);
      expect(landsInGitDirectory("other/config", ws)).toBe(false);
      expect(landsInGitDirectory("plain/.gitignore", ws)).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("a workspace that itself sits under such a name is not inside one", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-safety-git-")));
    try {
      const ws = join(base, ".git", "ws");
      mkdirSync(ws, { recursive: true });
      expect(landsInGitDirectory("notes.md", ws)).toBe(false);
      expect(landsInGitDirectory(".git/config", ws)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("gitDirectoryWriteRefusal", () => {
  test("names the tool and what it refused, and says nothing was written", () => {
    const out = gitDirectoryWriteRefusal("StateImport", "importing n/.git/config");
    expect(out).toContain("StateImport: refused — importing n/.git/config");
    expect(out).toContain("a repository's git directory");
    expect(out).toContain("Nothing was written.");
  });
});

describe("credential files", () => {
  test("isHeldFile: by name, written or where a link leads, and inside a held root", () => {
    const cwd = realpathSync(ws);
    mkdirSync(join(cwd, "sub"), { recursive: true });
    mkdirSync(join(cwd, "kept"), { recursive: true });
    writeFileSync(join(cwd, "sub", ".env"), "x");
    writeFileSync(join(cwd, "kept", "file"), "x");
    writeFileSync(join(cwd, "notes.md"), "x");
    symlinkSync(join(cwd, "sub", ".env"), join(cwd, "linked"));
    const held = ["kept"];
    for (const path of ["sub/.env", ".ENV", ".env.", ".env.local", "linked", "kept/file", "kept"]) {
      expect([path, isHeldFile(path, held, cwd)]).toEqual([path, true]);
    }
    for (const path of ["notes.md", ".env.example", "kept2"]) {
      expect([path, isHeldFile(path, held, cwd)]).toEqual([path, false]);
    }
  });

  test("heldInTree: a tree's files against the roots, by name and by place", () => {
    const cwd = realpathSync(ws);
    const held = ["a/secret.conf", "a/dir", "elsewhere/x"];
    const inA = heldInTree("a", held, cwd);
    for (const rel of ["secret.conf", "SECRET.CONF", "dir/one", "b/.env", ".npmrc"]) {
      expect([rel, inA(rel)]).toEqual([rel, true]);
    }
    for (const rel of ["secret.conf.bak", "dirt/one", "notes.md", ".env.example"]) {
      expect([rel, inA(rel)]).toEqual([rel, false]);
    }
    const atTop = heldInTree(".", held, cwd);
    expect(atTop("a/secret.conf")).toBe(true);
    expect(atTop("a/secret.conf.bak")).toBe(false);
    expect(atTop("elsewhere/x")).toBe(true);
    // Inside a root, all of it is held; with no roots, nothing is.
    expect(heldInTree("a/dir", held, cwd)("anything")).toBe(true);
    expect(heldInTree("a", [], cwd)(".env")).toBe(false);
  });

  test("the refusal says what was named and that nothing was written", () => {
    const text = heldFileRefusal("Tool", "importing x");
    expect(text).toContain("importing x names a credential file");
    expect(text).toContain("Nothing was written.");
  });

  test("the name table", () => {
    const named = (name: string): readonly [string, boolean] => [name, isCredentialFileName(name)];
    for (const name of [
      ".env",
      ".env.local",
      ".env.staging",
      ".env.production.local",
      ".env.example.local",
      ".env.a",
      ".npmrc",
      ".ENV",
      ".Env.Local",
      ".NPMRC",
    ]) {
      expect(named(name)).toEqual([name, true]);
    }
    for (const name of [
      "",
      "env",
      ".env.",
      ".env.example",
      ".env.sample",
      ".env.template",
      ".ENV.EXAMPLE",
      ".envrc",
      ".env-local",
      "notes.env",
      "my.npmrc",
      ".npmrc.bak",
      "sub/.env",
      "sub\\.env",
      ".env.a/b",
      ".env.a\\b",
    ]) {
      expect(named(name)).toEqual([name, false]);
    }
  });

  test("the roots are read off the bridge; anything else is none", () => {
    expect(credentialRootsOf({ bridge: { credentialRoots: ["a", "", 3, "b"] } })).toEqual([
      "a",
      "b",
    ]);
    for (const ctx of [
      undefined,
      {},
      { bridge: null },
      { bridge: {} },
      { bridge: { credentialRoots: "a" } },
      { bridge: { protectedRoots: ["a"] } },
    ]) {
      expect(credentialRootsOf(ctx)).toEqual([]);
    }
    // The two lists stay apart.
    expect(protectedRootsOf({ bridge: { credentialRoots: ["a"] } })).toEqual([]);
  });
});
