import { afterEach, beforeEach, describe, expect, it } from "bun:test";
/**
 * The two seams the tools are built on, tested directly: the overlay
 * filesystem that makes a dry run the real run, and the readers that refuse
 * to report an unreadable thing as an empty one.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonlObjects } from "@crewhaus/harness-advice/advise-rules";
import { FixFsError, commitWrites, createOverlayFs } from "./lib/overlay-fs";
import {
  loadSpecText,
  readContained,
  readJsonlDirectory,
  renderPath,
  resolveInput,
  writeContained,
} from "./lib/sources";

let previousCwd = process.cwd();
let workspace = "";

beforeEach(() => {
  previousCwd = process.cwd();
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "specops-lib-")));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(workspace, { recursive: true, force: true });
});

describe("the overlay filesystem", () => {
  it("reads from disk, and holds every write in memory", () => {
    writeFileSync(join(workspace, "spec.yaml"), "name: a\n");
    const fs = createOverlayFs("T");
    expect(fs.read("spec.yaml")).toBe("name: a\n");
    fs.write("spec.yaml", "name: b\n");
    // The write is visible to the next reader...
    expect(fs.read("spec.yaml")).toBe("name: b\n");
    // ...and nowhere else. This is the whole reason a dry run can run the
    // real fixer: the fixer cannot tell, and the disk cannot either.
    expect(readFileSync(join(workspace, "spec.yaml"), "utf8")).toBe("name: a\n");
    console.log(`OVERLAY ${JSON.stringify(fs.captured())}`);
  });

  it("answers exists() for a pending write and for a pending directory's children", () => {
    const fs = createOverlayFs("T");
    expect(fs.exists("crewhaus.yaml")).toBe(false);
    fs.write("crewhaus.yaml", "name: a\n");
    expect(fs.exists("crewhaus.yaml")).toBe(true);
    fs.mkdirp(".crewhaus");
    expect(fs.exists(".crewhaus/sessions")).toBe(true);
  });

  it("keeps only the last content written to a path", () => {
    const fs = createOverlayFs("T");
    fs.write("a.txt", "one");
    fs.write("a.txt", "two");
    const captured = fs.captured();
    expect(captured).toEqual([{ kind: "file", path: "a.txt", content: "two" }]);
  });

  it("refuses a path outside the workspace on every operation", () => {
    const fs = createOverlayFs("T");
    // Not "returns false" and not "writes somewhere harmless": each of these
    // has to be a refusal a caller sees, because exists() answering false
    // would send a fixer straight into creating the file.
    expect(() => fs.read("../outside.yaml")).toThrow(FixFsError);
    expect(() => fs.write("../outside.yaml", "x")).toThrow(FixFsError);
    expect(() => fs.exists("../outside.yaml")).toThrow(FixFsError);
    expect(() => fs.mkdirp("/etc/crewhaus")).toThrow(FixFsError);
  });

  it("refuses to read a file over the cap, naming the size", () => {
    writeFileSync(join(workspace, "big.yaml"), "x".repeat(4096));
    const fs = createOverlayFs("T", 1024);
    expect(() => fs.read("big.yaml")).toThrow(/4096 bytes, over the 1024 limit/);
  });

  it("commits captured writes in order, creating a captured directory first", () => {
    const fs = createOverlayFs("T");
    fs.mkdirp("state");
    fs.write("state/notes.txt", "hello");
    const result = commitWrites("T", fs.captured());
    console.log(`COMMIT ${JSON.stringify(result)}`);
    expect(result.error).toBeUndefined();
    expect(readFileSync(join(workspace, "state", "notes.txt"), "utf8")).toBe("hello");
    expect(result.committed.map((c) => c.path)).toEqual(["state", "state/notes.txt"]);
  });

  it("refuses the whole commit when a destination directory is missing, writing nothing", () => {
    const fs = createOverlayFs("T");
    fs.write("first.txt", "a");
    fs.write("missing/second.txt", "b");
    const result = commitWrites("T", fs.captured());
    console.log(`COMMIT_REFUSED ${JSON.stringify(result)}`);
    // The reason, and the fact that the FIRST write did not land either.
    expect(result.committed).toEqual([]);
    expect(String(result.error)).toMatch(/needs the directory "missing"/);
    expect(() => readFileSync(join(workspace, "first.txt"), "utf8")).toThrow();
  });

  it("reports bytes in UTF-8, not UTF-16 code units", () => {
    const fs = createOverlayFs("T");
    fs.write("a.txt", "héllo");
    const result = commitWrites("T", fs.captured());
    expect(result.committed[0]?.bytes).toBe(6);
  });
});

describe("the readers", () => {
  it("refuses a NUL in a path before any syscall sees it", () => {
    const withNul = `spec${String.fromCharCode(0)}.yaml`;
    const out = resolveInput("T", withNul);
    console.log(`NUL ${JSON.stringify(out)}`);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("refused");
    expect(out.message).toMatch(/NUL byte/);
  });

  it("neutralises control characters and truncates the path it echoes back", () => {
    const hostile = `a${String.fromCharCode(27)}[31mred${String.fromCharCode(13)}`;
    const shown = renderPath(hostile);
    console.log(`RENDER ${JSON.stringify(shown)}`);
    expect(shown).not.toContain(String.fromCharCode(27));
    expect(shown).not.toContain(String.fromCharCode(13));
    expect(renderPath("z".repeat(400)).length).toBeLessThan(250);
  });

  it("separates a directory, a missing file and an over-size file", () => {
    mkdirSync(join(workspace, "adir"));
    writeFileSync(join(workspace, "big.txt"), "x".repeat(200));
    const dir = readContained("T", "adir", 1000);
    const missing = readContained("T", "nope.txt", 1000);
    const big = readContained("T", "big.txt", 10);
    console.log(
      `READS ${JSON.stringify([dir, missing, big].map((r) => (r.ok ? "ok" : `${r.code}: ${r.message}`)))}`,
    );
    expect([dir.ok, missing.ok, big.ok]).toEqual([false, false, false]);
    if (dir.ok || missing.ok || big.ok) return;
    expect(dir.code).toBe("not-a-file");
    expect(missing.code).toBe("missing");
    expect(big.code).toBe("too-large");
    // The cap is applied to the size on disk: the message proves the file was
    // measured, not read and then rejected.
    expect(big.message).toMatch(/200 bytes, over the 10 limit/);
  });

  it("takes either inline text or a path, never both and never neither", () => {
    const both = loadSpecText("T", { spec: "name: a", path: "x.yaml" });
    const neither = loadSpecText("T", {});
    expect([both.ok, neither.ok]).toEqual([false, false]);
    if (both.ok || neither.ok) return;
    expect(both.message).toMatch(/not both/);
    expect(neither.message).toMatch(/pass the spec/);
  });

  it("writes UTF-8 bytes and reports them", () => {
    const written = writeContained("T", "out.txt", "héllo");
    expect(written.ok && written.value).toBe(6);
    expect(readFileSync(join(workspace, "out.txt"), "utf8")).toBe("héllo");
  });

  describe("a JSONL directory", () => {
    function seed(files: Record<string, string>): void {
      mkdirSync(join(workspace, "logs"), { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(workspace, "logs", name), content);
      }
    }

    it("reads in name order and counts the lines it could not parse", () => {
      seed({
        "b.jsonl": '{"kind":"x"}\nNOT JSON\n',
        "a.jsonl": '{"kind":"y"}\n\n',
        "ignored.txt": "whatever",
      });
      const out = readJsonlDirectory("T", "logs", parseJsonlObjects, 1_000_000, 10);
      console.log(
        `JSONL ${out.files.map((f) => `${f.name}:${f.lines.length}:${f.malformed}`).join(" ")}`,
      );
      // Sorted by name, never readdir order, so the same directory always
      // mines the same way.
      expect(out.files.map((f) => f.name)).toEqual(["a.jsonl", "b.jsonl"]);
      expect(out.files.map((f) => f.malformed)).toEqual([0, 1]);
      expect(out.unreadable).toEqual([]);
      expect(out.unavailable).toBeUndefined();
    });

    it("names a file it could not read instead of counting it as empty", () => {
      seed({ "a.jsonl": '{"kind":"y"}\n' });
      mkdirSync(join(workspace, "logs", "b.jsonl"));
      const out = readJsonlDirectory("T", "logs", parseJsonlObjects, 1_000_000, 10);
      console.log(`JSONL_UNREADABLE ${JSON.stringify(out.unreadable)}`);
      expect(out.files.map((f) => f.name)).toEqual(["a.jsonl"]);
      expect(out.unreadable.length).toBe(1);
      expect(out.unreadable[0]?.reason).toMatch(/not a file/);
    });

    it("says when it stopped early rather than presenting a partial listing as whole", () => {
      seed({ "a.jsonl": "{}\n", "b.jsonl": "{}\n", "c.jsonl": "{}\n" });
      const out = readJsonlDirectory("T", "logs", parseJsonlObjects, 1_000_000, 2);
      console.log(`JSONL_TRUNCATED ${String(out.truncated)}`);
      expect(out.files.length).toBe(2);
      expect(String(out.truncated)).toMatch(/only the first 2 of 3/);
      // On its OWN field, never `unavailable`. A caller entitled to shrug off
      // an absent optional directory must not inherit that licence over a
      // directory that was there and was read in part.
      expect(out.unavailable).toBeUndefined();
    });

    it("stops on the total-bytes budget and names it, rather than reading a fleet's worth", () => {
      seed({ "a.jsonl": `${"{}\n".repeat(50)}`, "b.jsonl": "{}\n", "c.jsonl": "{}\n" });
      const out = readJsonlDirectory("T", "logs", parseJsonlObjects, 1_000_000, 10, 100);
      console.log(`JSONL_BUDGET files=${out.files.length} ${String(out.truncated)}`);
      // A per-file cap alone bounds one file, not a pass: this is the pass.
      expect(out.files.map((f) => f.name)).toEqual(["a.jsonl"]);
      expect(String(out.truncated)).toMatch(/maxTotalBytes/);
      expect(out.unavailable).toBeUndefined();
    });

    it("distinguishes a directory that is not there from one holding no logs", () => {
      const absent = readJsonlDirectory("T", "logs", parseJsonlObjects, 1000, 10);
      mkdirSync(join(workspace, "empty"));
      const empty = readJsonlDirectory("T", "empty", parseJsonlObjects, 1000, 10);
      console.log(`JSONL_ABSENT ${String(absent.unavailable)} EMPTY ${String(empty.unavailable)}`);
      expect(String(absent.unavailable)).toMatch(/does not exist/);
      // Absent is `unavailable`, never `truncated`: three states, three
      // answers, and the caller's exemption attaches to exactly one of them.
      expect(absent.truncated).toBeUndefined();
      // An empty directory IS a complete read of nothing, and says so by
      // carrying no reason at all.
      expect(empty.unavailable).toBeUndefined();
      expect(empty.truncated).toBeUndefined();
      expect(empty.files).toEqual([]);
    });

    it("refuses a directory outside the workspace with a reason, not an empty listing", () => {
      const out = readJsonlDirectory("T", "../elsewhere", parseJsonlObjects, 1000, 10);
      expect(String(out.unavailable)).toMatch(/escapes the workspace/);
    });
  });
});
