/**
 * 0.7.1 — where a path-kind operative value lands, as the permission gate
 * reads it (permission-integration#1). The end-to-end cases, through
 * runChatLoop, are in `permission-subject.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type PermissionRule, emptyRuleSet, evaluate } from "@crewhaus/permission-engine";
import { canonicalWorkspacePath, workspacePathCanonicalizer } from "./path-canonical";

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
