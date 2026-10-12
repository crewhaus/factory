/**
 * 0.7.1 — where a path-kind operative value lands, as the permission gate
 * reads it (permission-integration#1). The end-to-end cases, through
 * runChatLoop, are in `permission-subject.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type PermissionRule, emptyRuleSet, evaluate } from "@crewhaus/permission-engine";
import { resolveContained } from "@crewhaus/tool-safety/fs";
import {
  MAX_PATH_CHARS,
  canonicalWorkspacePath,
  placeRecordingCanonicalizer,
  workspacePathCanonicalizer,
} from "./path-canonical";

let ws: string;
beforeEach(() => {
  // realpath: on macOS the temp dir is itself behind a symlink (/var → /private/var).
  ws = realpathSync(mkdtempSync(path.join(tmpdir(), "perm-canonical-")));
  mkdirSync(path.join(ws, "src"));
  mkdirSync(path.join(ws, "build"));
  mkdirSync(path.join(ws, ".git", "hooks"), { recursive: true });
  writeFileSync(path.join(ws, "src", "app.ts"), "app");
  symlinkSync("../src", path.join(ws, "build", "link"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

const values = (p: string) => canonicalWorkspacePath(p, ws);

describe("canonicalWorkspacePath", () => {
  test("`..` is collapsed before a rule sees the path", () => {
    const [v] = values("build/../src/app.ts");
    expect(v?.canonical[0]).toBe("src/app.ts");
    expect(v?.spellings).toContain("build/../src/app.ts");
    expect(v?.outsideWorkspace).toBeUndefined();
  });

  test("a symlinked directory is followed to where the tool will act", () => {
    const [v] = values("build/link/app.ts");
    expect(v?.canonical[0]).toBe("src/app.ts");
    // The name the model used is still a spelling a deny can catch.
    expect(v?.spellings).toContain("build/link/app.ts");
  });

  test("a file that does not exist yet resolves through its existing ancestors", () => {
    const [v] = values("build/link/new/deep.ts");
    expect(v?.canonical[0]).toBe("src/new/deep.ts");
  });

  test("a symlink as the LAST component is two places: the link and its target", () => {
    // A tool that replaces the file acts on `src/hook`; one that opens it
    // acts on the hook. An allow must cover both; a deny fires on either.
    // Dangling on purpose: a missing target is still a door.
    symlinkSync("../.git/hooks/pre-commit", path.join(ws, "src", "hook"));
    expect(values("src/hook").map((v) => v.canonical[0])).toEqual([
      "src/hook",
      ".git/hooks/pre-commit",
    ]);
    const decide = (type: PermissionRule["type"], pattern: string) =>
      evaluate(
        {
          toolName: "WriteLike",
          input: { path: "src/hook" },
          operativeValues: values("src/hook"),
          readOnly: false,
          destructive: true,
        },
        "default",
        { ...emptyRuleSet, yaml: [{ type, pattern, source: "yaml" }] },
      );
    expect(decide("alwaysDeny", "WriteLike(.git/**)")).toBe("deny");
    // Not covered by src/** alone: default mode asks.
    expect(decide("alwaysAllow", "WriteLike(src/**)")).toBe("ask");
    // A leaf link pointing out of the workspace brings an outside value.
    symlinkSync(tmpdir(), path.join(ws, "src", "away"));
    expect(values("src/away").map((v) => v.outsideWorkspace === true)).toEqual([false, true]);
  });

  test("an absolute path inside the workspace becomes workspace-relative", () => {
    const [v] = values(path.join(ws, "src", "app.ts"));
    expect(v?.canonical).toEqual(["src/app.ts", "./src/app.ts", path.join(ws, "src", "app.ts")]);
  });

  test("escaping the workspace — lexically or through a symlink — is flagged", () => {
    expect(values("../elsewhere")[0]?.outsideWorkspace).toBe(true);
    expect(values("/etc/passwd")[0]?.outsideWorkspace).toBe(true);
    symlinkSync(tmpdir(), path.join(ws, "out"));
    expect(values("out/x")[0]?.outsideWorkspace).toBe(true);
    // Every path yields at least one value; only a symlinked leaf yields two.
    expect(values("src/app.ts")).toHaveLength(1);
    // Flagged values carry nothing canonical for an allow to match.
    expect(values("../elsewhere")[0]?.canonical).toEqual([]);
  });

  test("the workspace root itself is `.`", () => {
    expect(values(".")[0]?.canonical[0]).toBe(".");
    expect(values("")[0]?.canonical[0]).toBe(".");
  });

  test("a path naming an existing file, or a link to one, is marked notDirectory", () => {
    // A tool that walks a directory (RemovePath, Grep) finds nothing beneath
    // a file, so a deny naming something under the name cannot concern it
    // (final review, 0.7.1). Anything that is, or may become, a directory
    // stays unmarked.
    symlinkSync("app.ts", path.join(ws, "src", "to-file"));
    symlinkSync("../src", path.join(ws, "build", "to-dir"));
    symlinkSync("missing", path.join(ws, "src", "dangling"));
    const marked = (p: string) => values(p).map((v) => v.notDirectory === true);
    expect(marked("src/app.ts")).toEqual([true]);
    // The link and its target: both lead to the file.
    expect(marked("src/to-file")).toEqual([true, true]);
    expect(marked("src")).toEqual([false]);
    expect(marked(".")).toEqual([false]);
    expect(marked("build/to-dir")).toEqual([false, false]);
    expect(marked("src/not-yet")).toEqual([false]);
    expect(marked("src/dangling")).toEqual([false, false]);
  });
});

// The workspace can be reached through a symlinked spelling of its root —
// the shell's $PWD, or a top-level link like macOS's /tmp → /private/tmp —
// while the runtime's cwd is the physical path. A deny written through that
// spelling was dodged by a relative path (0.7.1 review).
describe("a rule that names the workspace through a symlinked spelling of its root", () => {
  const decide = (raw: string, type: PermissionRule["type"], pattern: string, sources = {}) =>
    evaluate(
      {
        toolName: "WriteLike",
        input: { path: raw },
        operativeValues: canonicalWorkspacePath(raw, ws, sources),
        readOnly: false,
        destructive: true,
      },
      "default",
      { ...emptyRuleSet, yaml: [{ type, pattern, source: "yaml" }] },
    );
  let away: string;
  beforeEach(() => {
    away = realpathSync(mkdtempSync(path.join(tmpdir(), "perm-canonical-alias-")));
  });
  afterEach(() => {
    rmSync(away, { recursive: true, force: true });
  });

  test("$PWD: a deny through the logical root fires on the relative spelling", () => {
    const logical = path.join(away, "ws-link");
    symlinkSync(ws, logical);
    const sources = { pwd: logical, topLevelLinks: [] };
    const deny = `WriteLike(${logical}/.crewhaus/**)`;
    expect(decide(".crewhaus/settings.json", "alwaysDeny", deny, sources)).toBe("deny");
    expect(decide("./.crewhaus/settings.json", "alwaysDeny", deny, sources)).toBe("deny");
    expect(decide("src/app.ts", "alwaysDeny", deny, sources)).toBe("ask");
    // A spelling, never a grant: an allow through the logical root still asks.
    expect(decide("src/app.ts", "alwaysAllow", `WriteLike(${logical}/src/**)`, sources)).toBe(
      "ask",
    );
    // Control: a $PWD that is not the workspace adds nothing.
    expect(
      decide(".crewhaus/settings.json", "alwaysDeny", deny, { pwd: away, topLevelLinks: [] }),
    ).toBe("ask");
  });

  test("a top-level link over the root's ancestor: the deny fires through it", () => {
    const top = "/crewhaus-alias-top";
    const sources = { pwd: undefined, topLevelLinks: [[top, path.dirname(ws)] as const] };
    const deny = `WriteLike(${top}/${path.basename(ws)}/.crewhaus/**)`;
    expect(decide(".crewhaus/settings.json", "alwaysDeny", deny, sources)).toBe("deny");
    expect(
      decide(".crewhaus/settings.json", "alwaysDeny", deny, { pwd: undefined, topLevelLinks: [] }),
    ).toBe("ask");
  });

  const logicalTmp = path.resolve(tmpdir());
  test.if(realpathSync(logicalTmp) !== logicalTmp)(
    "on this machine the temp dir is behind a real top-level link, and a deny through it fires",
    () => {
      const deny = `WriteLike(${path.join(logicalTmp, path.basename(ws))}/.crewhaus/**)`;
      expect(decide(".crewhaus/settings.json", "alwaysDeny", deny, { pwd: undefined })).toBe(
        "deny",
      );
    },
  );
});

describe("workspacePathCanonicalizer", () => {
  test("defaults to the working directory, the root the tools resolve against", () => {
    const cwd = process.cwd();
    try {
      process.chdir(ws);
      expect(workspacePathCanonicalizer()("build/link/app.ts")).toEqual(
        canonicalWorkspacePath("build/link/app.ts", ws),
      );
    } finally {
      process.chdir(cwd);
    }
    expect(workspacePathCanonicalizer(ws)("build/link/app.ts")[0]?.canonical[0]).toBe("src/app.ts");
  });
});

describe("placeRecordingCanonicalizer — the places a headless approval is bound to", () => {
  test("gives the rule the same values as the gate's canonicaliser", () => {
    const rec = placeRecordingCanonicalizer(ws);
    for (const p of ["build/link/app.ts", "src/app.ts", "../elsewhere", "."]) {
      expect(rec.canonicalizePath(p)).toEqual(canonicalWorkspacePath(p, ws));
    }
  });

  test("records each path once, ordered, with where it lands — every link followed", () => {
    symlinkSync("../.git/hooks/pre-commit", path.join(ws, "src", "hook"));
    symlinkSync(path.dirname(ws), path.join(ws, "up"));
    const rec = placeRecordingCanonicalizer(ws);
    for (const p of ["src/hook", "build/link/app.ts", "src/app.ts", "up/x", "build/link/app.ts"]) {
      rec.canonicalizePath(p);
    }
    expect(rec.places()).toEqual([
      { path: "build/link/app.ts", at: [`${ws}/src/app.ts`] },
      { path: "src/app.ts", at: [`${ws}/src/app.ts`] },
      // A link as the last component: the link itself, and its target.
      { path: "src/hook", at: [`${ws}/src/hook`, `${ws}/.git/hooks/pre-commit`] },
      // Outside the workspace the rule reads only a flag; the place is still where it is.
      { path: "up/x", at: [`${path.dirname(ws)}/x`] },
    ]);
  });

  test("a path that climbs out lexically is placed where it lands, links followed", () => {
    // ../<name>/x where <name> links back into the workspace: the rule sees
    // only "outside", but the place is the file it reaches.
    const sibling = `${ws}-sibling`;
    symlinkSync(path.join(ws, "src"), sibling);
    try {
      const rec = placeRecordingCanonicalizer(ws);
      expect(rec.canonicalizePath(`../${path.basename(sibling)}/app.ts`)[0]?.outsideWorkspace).toBe(
        true,
      );
      expect(rec.places()[0]?.at).toEqual([`${ws}/src/app.ts`]);
      expect(rec.allAsWritten()).toBe(false);
    } finally {
      rmSync(sibling, { force: true });
    }
  });

  test("a link chain that cannot be followed is placed as unresolved, by its written path", () => {
    symlinkSync("loop-b", path.join(ws, "loop-a"));
    symlinkSync("loop-a", path.join(ws, "loop-b"));
    const rec = placeRecordingCanonicalizer(ws);
    expect(rec.canonicalizePath("loop-a/x")[0]?.outsideWorkspace).toBe(true);
    expect(rec.places()).toEqual([{ path: "loop-a/x", at: [`unresolved:${ws}/loop-a/x`] }]);
  });

  describe("in a directory that can be searched but not read (mode 0300)", () => {
    // critic8: `realpath` fails there on macOS, and listing it fails
    // everywhere; no file tool cares, since opening a name needs only search
    // permission. The rule still reads the outside flag. The place was
    // `unresolved:<path>` (macOS) or the link alone, never where it led (Linux),
    // so it read the same wherever the link pointed, and a grant made for it
    // was spent after an allowed `ln` moved the link to secrets/.
    const d = () => path.join(ws, "d");
    beforeEach(() => {
      mkdirSync(d());
      mkdirSync(path.join(ws, "secrets"));
      symlinkSync("../src/app.ts", path.join(d(), "x.md"));
      chmodSync(d(), 0o300);
    });
    // Before the workspace is removed: removing it lists `d`.
    afterEach(() => chmodSync(d(), 0o755));
    const placesOf = (raw: string) => {
      const rec = placeRecordingCanonicalizer(ws);
      rec.canonicalizePath(raw);
      return rec.places();
    };
    /** Whether this process is refused a listing there (root is not). */
    const unlistable = (): boolean => {
      try {
        readdirSync(d());
        return false;
      } catch {
        return true;
      }
    };

    test("a link there is the link and where it leads, and moving it moves the place", () => {
      if (unlistable()) {
        expect(placeRecordingCanonicalizer(ws).canonicalizePath("d/x.md")).toEqual([
          expect.objectContaining({ outsideWorkspace: true }),
        ]);
      }
      expect(placesOf("d/x.md")).toEqual([
        { path: "d/x.md", at: [`${ws}/d/x.md`, `${ws}/src/app.ts`] },
      ]);
      unlinkSync(path.join(d(), "x.md"));
      symlinkSync("../secrets/x.md", path.join(d(), "x.md"));
      expect(placesOf("d/x.md")).toEqual([
        { path: "d/x.md", at: [`${ws}/d/x.md`, `${ws}/secrets/x.md`] },
      ]);
    });

    test("a name not there yet is its own place; a link made there later is another", () => {
      expect(placesOf("d/new.md")).toEqual([{ path: "d/new.md", at: [`${ws}/d/new.md`] }]);
      symlinkSync("../secrets/x.md", path.join(d(), "new.md"));
      expect(placesOf("d/new.md")).toEqual([
        { path: "d/new.md", at: [`${ws}/d/new.md`, `${ws}/secrets/x.md`] },
      ]);
    });

    test("a link whose target runs through it is placed where it leads", () => {
      symlinkSync("../d/x.md", path.join(ws, "src", "via"));
      symlinkSync("../d", path.join(ws, "src", "to-d"));
      symlinkSync("../d/new.md", path.join(ws, "src", "to-new"));
      expect(placesOf("src/via")).toEqual([
        { path: "src/via", at: [`${ws}/src/via`, `${ws}/src/app.ts`] },
      ]);
      expect(placesOf("src/to-d")).toEqual([
        { path: "src/to-d", at: [`${ws}/src/to-d`, `${ws}/d`] },
      ]);
      expect(placesOf("src/to-new")).toEqual([
        { path: "src/to-new", at: [`${ws}/src/to-new`, `${ws}/d/new.md`] },
      ]);
    });
  });

  test("allAsWritten: every path lands where it reads on its face, and only then", () => {
    const plain = placeRecordingCanonicalizer(ws);
    expect(plain.allAsWritten()).toBe(true); // nothing read
    plain.canonicalizePath("src/app.ts");
    plain.canonicalizePath("src/../src/new.ts");
    plain.canonicalizePath(".");
    plain.canonicalizePath(path.join(ws, "src", "app.ts"));
    expect(plain.allAsWritten()).toBe(true);
    const linked = placeRecordingCanonicalizer(ws);
    linked.canonicalizePath("src/app.ts");
    linked.canonicalizePath("build/link/app.ts");
    expect(linked.allAsWritten()).toBe(false);
    symlinkSync("app.ts", path.join(ws, "src", "alias"));
    const leaf = placeRecordingCanonicalizer(ws);
    leaf.canonicalizePath("src/alias");
    expect(leaf.allAsWritten()).toBe(false);
  });
});

/**
 * 0.7.1 review — on a filesystem that ignores case or Unicode normal form
 * (macOS APFS and Windows by default), `.ENV` opens `.env`. The last path
 * component was kept as written, so `alwaysDeny Read(**\/.env)` was dodged by
 * `Read(.ENV)`, and `alwaysDeny Write(.crewhaus/settings.json)` by
 * `.crewhaus/SETTINGS.JSON` — a standing-permission escalation, because
 * settings.json outranks the spec.
 *
 * Asked of the filesystem the tests run on, so a case-sensitive one (Linux
 * CI) skips the case tests cleanly instead of passing them vacuously, and a
 * case-insensitive one skips the one test that needs case to matter.
 */
function tempFsIgnoresCase(): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), "perm-case-probe-"));
  try {
    writeFileSync(path.join(dir, "probe"), "x");
    return existsSync(path.join(dir, "PROBE"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const IGNORES_CASE = tempFsIgnoresCase();

describe("a name spelled another way the filesystem treats as the same", () => {
  const decide = (
    tool: string,
    raw: string,
    ...list: Array<[PermissionRule["type"], string]>
  ): string =>
    evaluate(
      {
        toolName: tool,
        input: { path: raw },
        operativeValues: values(raw),
        readOnly: false,
        destructive: true,
      },
      "default",
      {
        ...emptyRuleSet,
        yaml: list.map(([type, pattern]) => ({ type, pattern, source: "yaml" as const })),
      },
    );

  test.skipIf(!IGNORES_CASE)(
    "an existing file named in another case is written the way the directory stores it",
    () => {
      writeFileSync(path.join(ws, ".env"), "SECRET=x");
      for (const spelling of [".env", ".ENV", ".Env"]) {
        const [v] = values(spelling);
        expect({ spelling, canonical: v?.canonical[0] }).toEqual({ spelling, canonical: ".env" });
        expect(
          decide("Read", spelling, ["alwaysDeny", "Read(**/.env)"], ["alwaysAllow", "Read"]),
        ).toBe("deny");
      }
      // The name as written is still a spelling, and an allow for the file
      // covers every way of naming it.
      expect(values(".ENV")[0]?.spellings).toContain(".ENV");
      expect(decide("Read", ".ENV", ["alwaysAllow", "Read(.env)"])).toBe("allow");
    },
  );

  test.skipIf(!IGNORES_CASE)(
    "a deny on a file not created yet fires on another case of its name",
    () => {
      // Created as SETTINGS.JSON, it is what the loader opens as settings.json.
      mkdirSync(path.join(ws, ".crewhaus"));
      const guard: Array<[PermissionRule["type"], string]> = [
        ["alwaysDeny", "Write(.crewhaus/settings.json)"],
        ["alwaysAllow", "Write"],
      ];
      for (const spelling of [".crewhaus/SETTINGS.JSON", ".CREWHAUS/Settings.json"]) {
        expect({ spelling, decision: decide("Write", spelling, ...guard) }).toEqual({
          spelling,
          decision: "deny",
        });
      }
      // And the other way round: a deny written in another case than the file.
      writeFileSync(path.join(ws, ".env"), "SECRET=x");
      expect(decide("Read", ".env", ["alwaysDeny", "Read(.ENV)"], ["alwaysAllow", "Read"])).toBe(
        "deny",
      );
      // Case folding is for denies and asks only: an allow still needs the
      // name the file will have.
      expect(values("NEW.md")[0]?.caseInsensitive).toBe(true);
      expect(decide("Write", "NEW.md", ["alwaysAllow", "Write(new.md)"])).toBe("ask");
    },
  );

  test.skipIf(IGNORES_CASE)("where case matters, another case is another file", () => {
    writeFileSync(path.join(ws, ".env"), "SECRET=x");
    expect(values(".ENV")[0]?.canonical[0]).toBe(".ENV");
    expect(values(".ENV")[0]?.caseInsensitive).toBeUndefined();
    expect(decide("Read", ".ENV", ["alwaysDeny", "Read(**/.env)"], ["alwaysAllow", "Read"])).toBe(
      "allow",
    );
  });

  test("a deny fires on another Unicode normal form of the name, on every filesystem", () => {
    const nfc = "café.env";
    const nfd = "café.env";
    const guard: Array<[PermissionRule["type"], string]> = [
      ["alwaysDeny", `Read(${nfc})`],
      ["alwaysAllow", "Read"],
    ];
    // Not created yet: compared in normal form C.
    expect(decide("Read", nfd, ...guard)).toBe("deny");
    // Created: where the filesystem folds the forms, the stored name is canonical.
    writeFileSync(path.join(ws, nfc), "SECRET=x");
    expect(decide("Read", nfd, ...guard)).toBe("deny");
    if (existsSync(path.join(ws, nfd))) expect(values(nfd)[0]?.canonical[0]).toBe(nfc);
  });
});

/**
 * 0.7.1 review — a path no filesystem can hold is not walked.
 *
 * The walk to a path's deepest existing name took one name off per step and
 * handed the whole rest of the path to `path.dirname` and `path.basename`
 * each time — twice here (`resolveLocation`, then `ignoresCase`), on the
 * runtime's thread, before any rule was read: about 4·d² characters for d
 * missing names, a count the model picks (10⁹ at d = 16,384). The walk now
 * works by index, and a path past MAX_PATH_CHARS — twice the longest any
 * platform opens — is `outside` before it starts: every deny and ask fires,
 * no allow grants it. Nothing here is timed: the work is counted.
 */
describe("a path longer than any path can be is outside, and the walk is linear", () => {
  /** A path below `secrets/prod.db` whose absolute form is exactly `abs` characters. */
  const deepTo = (abs: number): string => {
    const prefix = "secrets/prod.db/";
    const tail = abs - (ws.length + 1 + prefix.length);
    const pairs = Math.floor((tail - 1) / 2);
    return `${prefix}${"a/".repeat(pairs)}${"b".repeat(tail - 2 * pairs)}`;
  };
  const decide = (
    raw: string,
    got: ReturnType<typeof values>,
    ...list: Array<[PermissionRule["type"], string]>
  ) =>
    evaluate(
      {
        toolName: "WriteLike",
        input: { path: raw },
        operativeValues: got,
        readOnly: false,
        destructive: true,
      },
      "default",
      {
        ...emptyRuleSet,
        yaml: list.map(([type, pattern]) => ({ type, pattern, source: "yaml" as const })),
      },
    );
  const seed = () => {
    mkdirSync(path.join(ws, "secrets"));
    writeFileSync(path.join(ws, "secrets", "prod.db"), "db");
  };

  test("at the limit the path is walked and named whole; one character more is outside", () => {
    seed();
    const at = deepTo(MAX_PATH_CHARS);
    expect(path.resolve(ws, at).length).toBe(MAX_PATH_CHARS);
    const [v, ...rest] = values(at);
    expect(rest).toEqual([]);
    expect(v?.outsideWorkspace).toBeUndefined();
    expect(v?.canonical[0] === at).toBe(true);
    expect(v?.canonical[2] === `${ws}/${at}`).toBe(true);
    expect(decide(at, values(at), ["alwaysAllow", "WriteLike(secrets/**)"])).toBe("allow");
    expect(
      decide(
        at,
        values(at),
        ["alwaysDeny", "WriteLike(elsewhere/**)"],
        ["alwaysAllow", "WriteLike"],
      ),
    ).toBe("allow");

    const over = `${at}b`;
    expect(path.resolve(ws, over).length).toBe(MAX_PATH_CHARS + 1);
    const got = values(over);
    expect(got.map((g) => ({ outside: g.outsideWorkspace, canonical: g.canonical }))).toEqual([
      { outside: true, canonical: [] },
    ]);
    // What the model sent is still a spelling a deny reads.
    expect(got[0]?.spellings[0] === over).toBe(true);
    expect(decide(over, got, ["alwaysAllow", "WriteLike(secrets/**)"])).toBe("ask");
    expect(decide(over, got, ["alwaysAllow", "WriteLike(**)"])).toBe("ask");
    // Outside: a deny fires whatever it names.
    expect(
      decide(over, got, ["alwaysDeny", "WriteLike(elsewhere/**)"], ["alwaysAllow", "WriteLike"]),
    ).toBe("deny");
  });

  test("65,535 to 65,537 names (where Bun's path.join wraps) are far past the limit: outside", () => {
    seed();
    for (const n of [65_535, 65_536, 65_537]) {
      const raw = `secrets/prod.db/${Array.from({ length: n }, () => "a").join("/")}`;
      const got = values(raw);
      expect({ n, outside: got.map((g) => g.outsideWorkspace) }).toEqual({ n, outside: [true] });
      expect({ n, allow: decide(raw, got, ["alwaysAllow", "WriteLike(secrets/**)"]) }).toEqual({
        n,
        allow: "ask",
      });
      expect({ n, deny: decide(raw, got, ["alwaysDeny", "WriteLike(secrets/prod.db)"]) }).toEqual({
        n,
        deny: "deny",
      });
    }
  });

  test("the walk's work is linear in the path, and a path past the limit is not walked at all", () => {
    // In a process of its own, so node:path and node:fs are wrapped before
    // the canonicaliser (or anything else) imports them: Bun's namespace
    // takes the export object's functions as they are at the first import.
    // The walk probes each name with lstat, so a path refused before the
    // walk makes no lstat call; one refused after it makes one per name.
    const script = path.join(ws, "count.ts");
    writeFileSync(
      script,
      `const req = require("node:path");
let chars = 0;
for (const k of Object.keys(req)) {
  const f = req[k];
  if (typeof f !== "function") continue;
  req[k] = (...a) => { for (const x of a) if (typeof x === "string") chars += x.length; return f(...a); };
}
const fs = require("node:fs");
let lstats = 0;
const lstat = fs.lstatSync;
fs.lstatSync = (...a) => { lstats++; return lstat(...a); };
const { canonicalWorkspacePath, MAX_PATH_CHARS } = await import(${JSON.stringify(path.join(import.meta.dir, "path-canonical.ts"))});
const root = fs.realpathSync(fs.mkdtempSync(require("node:os").tmpdir() + "/count-"));
fs.writeFileSync(root + "/f.db", "x");
const out = [];
const d = Math.floor((MAX_PATH_CHARS - root.length - 16) / 4);
const past = Math.floor((MAX_PATH_CHARS - root.length - 5) / 2) + 1;
for (const n of [d, 2 * d, past, 65_537]) {
  const raw = "f.db/" + Array.from({ length: n }, () => "a").join("/");
  chars = 0;
  lstats = 0;
  const got = canonicalWorkspacePath(raw, root, { pwd: undefined, topLevelLinks: [] });
  const abs = root.length + 1 + raw.length;
  out.push({ n, abs, over: abs > MAX_PATH_CHARS, chars, lstats, whole: got.length === 1 && got[0].canonical[0] === raw, outside: got.length === 1 && got[0].outsideWorkspace === true });
}
fs.rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify(out));
`,
    );
    const run = Bun.spawnSync([process.execPath, script], { stderr: "pipe" });
    expect(run.stderr.toString()).toBe("");
    type Row = {
      n: number;
      abs: number;
      chars: number;
      lstats: number;
      whole: boolean;
      outside: boolean;
      over: boolean;
    };
    const [atD, at2D, ...past] = JSON.parse(run.stdout.toString()) as Row[];
    // Both resolve to the whole path, under the limit.
    expect([atD?.whole, at2D?.whole]).toEqual([true, true]);
    expect((at2D?.abs ?? 0) <= MAX_PATH_CHARS).toBe(true);
    // Linear: a bounded number of characters per character of path (the walk
    // that copied the rest of the path per name read ~900 per character at
    // d = 400, and ~4x as much at 2d).
    for (const r of [atD, at2D]) {
      expect({ n: r?.n, perChar: Math.ceil((r?.chars ?? 0) / (r?.abs ?? 1)) <= 40 }).toEqual({
        n: r?.n,
        perChar: true,
      });
    }
    expect((at2D?.chars ?? 0) / (atD?.chars ?? 1)).toBeLessThan(2.5);
    // Past the limit — one name past it, and 65,537 names — it is outside,
    // and refused before the walk: not one name was probed.
    expect(
      past.map((r) => ({
        n: r.n,
        over: r.over,
        outside: r.outside,
        lstats: r.lstats,
      })),
    ).toEqual(past.map((r) => ({ n: r.n, over: true, outside: true, lstats: 0 })));
    expect(past).toHaveLength(2);
  }, 30_000);
});

// critic8 (0.7.1): a command word that names a file — a program run by its
// path, a script handed to an interpreter — lands where the kernel takes it:
// each link followed BEFORE the `..` after it. And a headless grant is bound
// to where it lands, like a path.
describe("placeRecordingCanonicalizer — command words read where the kernel finds them", () => {
  beforeEach(() => {
    for (const d of ["secrets/deep", "safe", "bin", "loop"]) {
      mkdirSync(path.join(ws, d), { recursive: true });
    }
    for (const f of ["safe/run.sh", "secrets/run.sh", "run.sh"]) {
      writeFileSync(path.join(ws, f), "#!/bin/sh\n");
    }
    symlinkSync("secrets/deep", path.join(ws, "link"));
    symlinkSync("safe", path.join(ws, "tools"));
    symlinkSync("../safe/run.sh", path.join(ws, "bin", "tool"));
    symlinkSync("b", path.join(ws, "loop", "a"));
    symlinkSync("a", path.join(ws, "loop", "b"));
  });

  test("a `..` after a symlink climbs out of the link's target", () => {
    const view = placeRecordingCanonicalizer(ws);
    expect(view.readProgramPath("link/../run.sh", undefined)).toEqual({
      at: `${ws}/secrets/run.sh`,
      inWorkspace: "secrets/run.sh",
      asWritten: `${ws}/run.sh`,
      writtenInWorkspace: true,
    });
    // From a directory reached through the link, the same.
    expect(view.readProgramPath("../run.sh", "link")).toMatchObject({
      at: `${ws}/secrets/run.sh`,
      inWorkspace: "secrets/run.sh",
    });
    // A `..` with no link before it lands where the text says.
    expect(view.readProgramPath("./bin/../run.sh", undefined)).toMatchObject({
      at: `${ws}/run.sh`,
      asWritten: `${ws}/run.sh`,
    });
  });

  test("a symlinked directory is followed; the program's own link is kept, and where it leads is read too", () => {
    const view = placeRecordingCanonicalizer(ws);
    expect(view.readProgramPath("./tools/run.sh", undefined)).toEqual({
      at: `${ws}/safe/run.sh`,
      inWorkspace: "safe/run.sh",
      asWritten: `${ws}/tools/run.sh`,
      writtenInWorkspace: true,
    });
    expect(view.readProgramPath("./bin/tool", undefined)).toEqual({
      at: `${ws}/bin/tool`,
      inWorkspace: "bin/tool",
      asWritten: `${ws}/bin/tool`,
      writtenInWorkspace: true,
      target: { at: `${ws}/safe/run.sh`, inWorkspace: "safe/run.sh" },
    });
    // Climbing out of the workspace: absolute, and not inside it.
    const out = view.readProgramPath("../elsewhere/x", undefined);
    expect(out?.inWorkspace).toBeUndefined();
    expect(out?.writtenInWorkspace).toBe(false);
  });

  test("a loop of links is placed nowhere, and the place says so", () => {
    const view = placeRecordingCanonicalizer(ws);
    expect(view.readProgramPath("./loop/a/x", undefined)).toBeUndefined();
    expect(view.places()).toEqual([{ path: "./loop/a/x", at: [`unresolved:${ws}/loop/a/x`] }]);
    // Longer than any path can be: the kernel refuses to run it.
    expect(view.readProgramPath(`./${"a/".repeat(MAX_PATH_CHARS)}x`, undefined)).toBeUndefined();
  });

  test("each word is a place an approval is bound to, after the paths, keyed by where it runs", () => {
    const view = placeRecordingCanonicalizer(ws);
    view.canonicalizePath("src/app.ts");
    view.readProgramPath("./tools/run.sh", undefined);
    view.readProgramPath("../run.sh", "link/");
    view.readProgramPath("./bin/tool", undefined);
    expect(view.places()).toEqual([
      { path: "src/app.ts", at: [`${ws}/src/app.ts`] },
      { path: "./bin/tool", at: [`${ws}/bin/tool`, `${ws}/safe/run.sh`] },
      { path: "./tools/run.sh", at: [`${ws}/safe/run.sh`] },
      { path: "link/../run.sh", at: [`${ws}/secrets/run.sh`] },
    ]);
    // Through a link, a word does not land where it reads on its face, so a
    // grant written before approvals were bound does not cover it.
    expect(view.allAsWritten()).toBe(false);
    const plain = placeRecordingCanonicalizer(ws);
    plain.canonicalizePath("src/app.ts");
    plain.readProgramPath("./run.sh", undefined);
    expect(plain.allAsWritten()).toBe(true);
  });

  test("a bare word an interpreter is handed is a place only where it names an entry", () => {
    // `bun run build`, `python -m pytest`: a subcommand or a module is not a
    // file, and a card listing one would name a file that is not there.
    const view = placeRecordingCanonicalizer(ws);
    expect(view.readProgramPath("build", undefined)).toMatchObject({ at: `${ws}/build` });
    expect(view.readProgramPath("pytest", undefined)).toMatchObject({ at: `${ws}/pytest` });
    expect(view.readProgramPath("run.sh", ".")).toMatchObject({ at: `${ws}/run.sh` });
    expect(view.readProgramPath("run.sh", "safe/")).toMatchObject({ at: `${ws}/safe/run.sh` });
    expect(view.places()).toEqual([
      { path: "build", at: [`${ws}/build`] },
      { path: "run.sh", at: [`${ws}/run.sh`] },
      { path: "safe/run.sh", at: [`${ws}/safe/run.sh`] },
    ]);
  });

  test("an argument is a place only where it lands elsewhere than it reads, or is a link", () => {
    // `git add src/a.ts` names its files on their face: the card stays
    // short. `caffeinate ./tools/run.sh` does not: a grant is bound to it.
    const view = placeRecordingCanonicalizer(ws);
    const argument = { argument: true } as const;
    expect(view.readProgramPath("safe/run.sh", undefined, argument)).toMatchObject({
      at: `${ws}/safe/run.sh`,
    });
    expect(view.readProgramPath("./bin/../run.sh", undefined, argument)).toMatchObject({
      at: `${ws}/run.sh`,
    });
    expect(view.readProgramPath("./tools/run.sh", undefined, argument)).toMatchObject({
      at: `${ws}/safe/run.sh`,
    });
    expect(view.readProgramPath("./bin/tool", undefined, argument)).toMatchObject({
      target: { at: `${ws}/safe/run.sh` },
    });
    // Text no path can be (a long base64 word) is no file the call names.
    expect(view.readProgramPath(`a/${"b".repeat(MAX_PATH_CHARS)}`, undefined, argument)).toBe(
      undefined,
    );
    expect(view.places()).toEqual([
      { path: "./bin/tool", at: [`${ws}/bin/tool`, `${ws}/safe/run.sh`] },
      { path: "./tools/run.sh", at: [`${ws}/safe/run.sh`] },
    ]);
  });
});

// command-dotdot review (0.7.1): words read after a `cd` or an `env -C`
// are each walked from that directory. Walked again for every word, a deep
// directory and many words cost their product; it is walked once per call.
describe("placeRecordingCanonicalizer — a directory many words are read from is walked once", () => {
  test("each extra word costs the same few steps, however deep the directory", () => {
    const child = Bun.spawnSync(
      [process.execPath, path.join(import.meta.dir, "__test__", "program-dir-walk.ts")],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect({ exitCode: child.exitCode, stderr: child.stderr.toString().slice(-2_000) }).toEqual({
      exitCode: 0,
      stderr: expect.any(String),
    });
    type Reading = { depth: number; words: number; joins: number };
    const rows: Reading[] = child.stdout
      .toString()
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Reading);
    expect(rows.map((r) => [r.depth, r.words])).toEqual([
      [64, 1],
      [64, 65],
      [128, 1],
      [128, 65],
    ]);
    const perWord = (depth: number) => {
      const one = rows.find((r) => r.depth === depth && r.words === 1) as Reading;
      const many = rows.find((r) => r.depth === depth && r.words === 65) as Reading;
      // Two readings per word: after a `cd`, and after an `env -C`.
      return (many.joins - one.joins) / (2 * 64);
    };
    // The directory is walked once: a word costs a step or two of its own,
    // not one per name of the directory.
    expect(perWord(64)).toBeLessThanOrEqual(4);
    expect(perWord(128)).toBe(perWord(64));
  }, 60_000);
});
