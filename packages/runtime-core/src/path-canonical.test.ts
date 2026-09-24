/**
 * 0.7.1 — where a path-kind operative value lands, as the permission gate
 * reads it (permission-integration#1). The end-to-end cases, through
 * runChatLoop, are in `permission-subject.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
