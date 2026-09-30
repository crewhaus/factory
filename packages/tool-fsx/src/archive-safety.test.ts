/**
 * What an archive can do to the workspace, pinned.
 *
 *   - ArchiveCreate's zip followed symlinks: a file link packed the outside
 *     file's bytes, and a directory link made zip recurse into the outside
 *     directory (flag-truth-6#2, security-11#3).
 *   - ArchiveExtract judged link targets as text, so a chain whose `..`
 *     passes through another staged link was accepted while the kernel
 *     resolved it outside the destination (security-11#5).
 *   - ArchiveExtract had no ceiling on bytes written: a zip's declared sizes
 *     are not what unzip writes, and a tar.gz's second gzip member was never
 *     listed at all (security-11#6).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { type FixtureEntry, buildTar, buildZip } from "./archive-fixtures";
import { _setExtractCommandForTest, archiveCreate, archiveExtract, archiveList } from "./index";
import { ArchiveFormatError, readArchiveEntries } from "./lib/archive-format";
import { unsafeArchiveLinks } from "./lib/archive-links";
import { measureTree, scanStagedTree, watchTreeSize } from "./staging";

const originalCwd = process.cwd();
let parent: string;
let ws: string;
let out: string;

beforeEach(() => {
  parent = mkdtempSync(path.join(tmpdir(), "crewhaus-fsx-archive-"));
  ws = path.join(parent, "ws");
  out = path.join(parent, "outside");
  mkdirSync(ws);
  mkdirSync(out);
  process.chdir(ws);
});

afterEach(() => {
  _setExtractCommandForTest(undefined);
  process.chdir(originalCwd);
  rmSync(parent, { recursive: true, force: true });
});

function has(cmd: string): boolean {
  try {
    return Bun.spawnSync(["which", cmd]).exitCode === 0;
  } catch {
    return false;
  }
}
const hasTar = has("tar");
const hasZip = has("zip") && has("unzip");

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function run(tool: RegisteredTool, input: unknown): Promise<any> {
  const result = await tool.execute(input);
  if (typeof result !== "string") throw new Error("expected a string result");
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}

const entry = (name: string, extra: Partial<FixtureEntry> = {}): FixtureEntry => ({
  name,
  ...extra,
});

// ---------------------------------------------------------------------------

describe("ArchiveCreate stores links as links in every format (C062)", () => {
  for (const output of ["p.zip", "p.tar", "p.tar.gz"]) {
    const needs = output.endsWith(".zip") ? hasZip : hasTar;
    test.if(needs)(`${output}: no byte from outside the workspace is packed`, async () => {
      mkdirSync(path.join(ws, "pack"));
      writeFileSync(path.join(ws, "pack/ok.txt"), "inside");
      writeFileSync(path.join(out, "secret.txt"), "SECRET-OUTSIDE");
      mkdirSync(path.join(out, "d"));
      writeFileSync(path.join(out, "d/k"), "SECRET-DIR");
      symlinkSync(path.join(out, "secret.txt"), path.join(ws, "pack/link.txt"));
      symlinkSync(path.join(out, "d"), path.join(ws, "pack/dirlink"));

      const created = await run(archiveCreate, { source: "pack", output });
      expect(created.created).toBe(true);
      // Stored as links, and the caller is told ArchiveExtract would refuse them.
      expect(created.linksLeavingArchive).toHaveLength(2);

      let bytes = readFileSync(path.join(ws, output));
      if (output.endsWith(".gz")) bytes = gunzipSync(bytes);
      expect(bytes.includes("SECRET-OUTSIDE")).toBe(false);
      expect(bytes.includes("SECRET-DIR")).toBe(false);

      const listed = await run(archiveList, { path: output });
      const kinds = Object.fromEntries(
        listed.entries.map((e: { name: string; kind: string }) => [e.name, e.kind]),
      );
      expect(kinds["pack/link.txt"]).toBe("symlink");
      expect(kinds["pack/dirlink"]).toBe("symlink");
      expect(listed.entries.some((e: { name: string }) => e.name.startsWith("pack/dirlink/"))).toBe(
        false,
      );
    });
  }

  test.if(hasZip)(
    "a zip of a tree with only in-tree links reports nothing leaving it",
    async () => {
      mkdirSync(path.join(ws, "pack"));
      writeFileSync(path.join(ws, "pack/a.txt"), "A");
      symlinkSync("a.txt", path.join(ws, "pack/alias"));
      const created = await run(archiveCreate, { source: "pack", output: "p.zip" });
      expect(created).toMatchObject({ created: true, entries: 3 });
      expect(created.linksLeavingArchive).toBeUndefined();
      const extracted = await run(archiveExtract, { archive: "p.zip", destination: "x" });
      expect(extracted.extracted).toBe(true);
      expect(readFileSync(path.join(ws, "x/pack/alias"), "utf8")).toBe("A");
    },
  );
});

// ---------------------------------------------------------------------------

describe("link targets are resolved the way the kernel resolves them (C069)", () => {
  // a/b/y leads to the destination root; x then climbs one more level.
  const chain: FixtureEntry[] = [
    entry("a/", { kind: "dir" }),
    entry("a/b/", { kind: "dir" }),
    entry("a/b/y", { kind: "symlink", linkTarget: "../.." }),
    entry("x", { kind: "symlink", linkTarget: "a/b/y/../escaped.txt" }),
  ];

  test("the pure gate: a chain through another link is refused, a contained one is not", () => {
    expect(unsafeArchiveLinks(chain)).toEqual([
      {
        name: "x",
        linkTarget: "a/b/y/../escaped.txt",
        why: "link points outside, through another link",
      },
    ]);
    // Text folding would have said `a/b/escaped.txt`.
    const contained = [
      ...chain.slice(0, 3),
      entry("x", { kind: "symlink", linkTarget: "a/b/y/a/b" }),
      entry("alias", { kind: "symlink", linkTarget: "a/b/../b" }),
    ];
    expect(unsafeArchiveLinks(contained)).toEqual([]);
    // A dangling chain, a deep chain to an absolute path, '..' after a name
    // the archive does not hold, and hard links that climb or pass a link.
    const verdicts = unsafeArchiveLinks([
      ...chain.slice(0, 3),
      entry("dangling", { kind: "symlink", linkTarget: "a/b/y/../nope" }),
      entry("abs", { kind: "symlink", linkTarget: "/etc/hosts" }),
      entry("ghost", { kind: "symlink", linkTarget: "not-here/../../x" }),
      entry("hl-up", { kind: "hardlink", linkTarget: "../x" }),
      entry("hl-via", { kind: "hardlink", linkTarget: "a/b/y/a/f" }),
    ]).map((u) => `${u.name}: ${u.why}`);
    expect(verdicts).toEqual([
      "dangling: link points outside, through another link",
      "abs: link points outside",
      "ghost: link target unresolvable: a '..' follows a name this archive does not contain",
      "hl-up: link points outside",
      "hl-via: hard link through a symlink",
    ]);
  });

  test("a chain of twelve links reaching /etc is refused, not followed", () => {
    const members: FixtureEntry[] = [];
    let dir = "";
    for (let i = 0; i < 12; i++) {
      dir = `${dir}d${i}/`;
      members.push(entry(dir, { kind: "dir" }));
    }
    members.push(entry(`${dir}up`, { kind: "symlink", linkTarget: "../".repeat(12) }));
    members.push(entry("hosts", { kind: "symlink", linkTarget: `${dir}up/../etc/hosts` }));
    expect(unsafeArchiveLinks(members).map((u) => u.name)).toEqual(["hosts"]);
  });

  for (const [label, build, name, enabled] of [
    ["tar", buildTar, "chain.tar", hasTar],
    ["zip", buildZip, "chain.zip", hasZip],
  ] as const) {
    test.if(enabled)(
      `${label}: the chain is refused before extraction, dryRun included`,
      async () => {
        writeFileSync(path.join(ws, name), build(chain));
        mkdirSync(path.join(ws, "dest"));
        for (const dryRun of [true, false]) {
          const result = await run(archiveExtract, { archive: name, destination: "dest", dryRun });
          expect(result.extracted).toBe(false);
          expect(result.reason).toBe("unsafe archive");
          expect(result.refused[0]).toContain("x -> a/b/y/../escaped.txt");
        }
        expect(() => lstatSync(path.join(ws, "dest/x"))).toThrow();
        expect(readdirSync(path.join(ws, "dest"))).toEqual([]);
      },
    );
  }

  test("the post-extraction scan resolves a staged chain through the real tree", () => {
    // What the pre-gate stops, laid out as an extractor would have left it,
    // to prove the second gate does not rely on the first.
    const staging = path.join(ws, "staging");
    mkdirSync(path.join(staging, "a/b"), { recursive: true });
    symlinkSync("../..", path.join(staging, "a/b/y"));
    symlinkSync("a/b/y/../escaped.txt", path.join(staging, "x"));
    symlinkSync("a/b/y/a/b", path.join(staging, "fine"));
    const scan = scanStagedTree(staging);
    expect(scan.escaping).toEqual(["x -> a/b/y/../escaped.txt"]);
    expect(scan.incomplete).toBe(false);
  });

  test("the scan finds a staged file hard-linked from outside the tree", () => {
    const staging = path.join(ws, "staging");
    mkdirSync(staging);
    writeFileSync(path.join(ws, "victim.txt"), "v");
    linkSync(path.join(ws, "victim.txt"), path.join(staging, "planted"));
    writeFileSync(path.join(staging, "own"), "o");
    linkSync(path.join(staging, "own"), path.join(staging, "own-again"));
    const scan = scanStagedTree(staging);
    // Two names inside for `own`: fine. One of two names for `planted`: not.
    expect(scan.linkedOut).toEqual(["planted"]);
    expect(scan.bytes).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe("ArchiveExtract has a byte ceiling, and the listing is the extractor's (C082)", () => {
  const MiB = 1024 * 1024;

  test.if(hasZip)(
    "the total is reported, and a declared total over maxBytes is refused",
    async () => {
      writeFileSync(
        path.join(ws, "big.zip"),
        buildZip([entry("big.bin", { data: "x".repeat(2 * MiB) })]),
      );
      const dry = await run(archiveExtract, {
        archive: "big.zip",
        destination: "out",
        dryRun: true,
      });
      expect(dry.totalBytes).toBe(2 * MiB);
      const listed = await run(archiveList, { path: "big.zip" });
      expect(listed.totalBytes).toBe(2 * MiB);
      const refused = await run(archiveExtract, {
        archive: "big.zip",
        destination: "out",
        maxBytes: MiB,
      });
      expect(refused).toMatchObject({ extracted: false, reason: "too large", totalBytes: 2 * MiB });
      expect(refused.detail).toContain("the archive declares 2.0 MiB");
      // Refused from the index alone, so a dry run gives the same verdict.
      const dryRefused = await run(archiveExtract, {
        archive: "big.zip",
        destination: "out",
        maxBytes: MiB,
        dryRun: true,
      });
      expect(dryRefused).toMatchObject({ extracted: false, reason: "too large" });
      expect(existsSync(path.join(ws, "out/big.bin"))).toBe(false);
      expect(existsSync(path.join(ws, "out/.crewhaus-extract"))).toBe(false);
      // Raised, it extracts.
      const done = await run(archiveExtract, { archive: "big.zip", destination: "out" });
      expect(done).toMatchObject({ extracted: true, bytes: 2 * MiB });
    },
  );

  test.if(hasZip)(
    "a zip whose headers understate a member is refused, nothing promoted",
    async () => {
      writeFileSync(
        path.join(ws, "liar.zip"),
        buildZip([
          entry("zeros.bin", { data: "\0".repeat(2 * MiB), deflate: true, declaredSize: 1000 }),
        ]),
      );
      const listed = await run(archiveList, { path: "liar.zip" });
      expect(listed.totalBytes).toBe(1000); // what the index claims
      const result = await run(archiveExtract, {
        archive: "liar.zip",
        destination: "out",
        maxBytes: MiB,
      });
      expect(result.extracted).toBe(false);
      expect(existsSync(path.join(ws, "out/zeros.bin"))).toBe(false);
      expect(existsSync(path.join(ws, "out/.crewhaus-extract"))).toBe(false);
    },
  );

  test.if(hasZip)("an understated zip under the cap is refused too, for lying", async () => {
    writeFileSync(
      path.join(ws, "liar.zip"),
      buildZip([
        entry("zeros.bin", { data: "\0".repeat(64 * 1024), deflate: true, declaredSize: 10 }),
      ]),
    );
    const result = await run(archiveExtract, { archive: "liar.zip", destination: "out" });
    expect(result.extracted).toBe(false);
    if (result.reason !== undefined) expect(result.detail).toContain("understates");
    expect(existsSync(path.join(ws, "out/zeros.bin"))).toBe(false);
  });

  test("the size watch fires once a tree passes its budget", async () => {
    const dir = path.join(ws, "growing");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "a"), "x".repeat(600));
    expect(measureTree(dir)).toBe(600);
    const watch = watchTreeSize(dir, 500, 5);
    await new Promise<void>((resolve) => {
      if (watch.signal.aborted) resolve();
      else watch.signal.addEventListener("abort", () => resolve());
    });
    watch.stop();
    expect(watch.exceeded()).toBe(true);
    // Under budget, it stays quiet for several intervals.
    const quiet = watchTreeSize(dir, 10_000, 5);
    await Bun.sleep(40);
    quiet.stop();
    expect(quiet.exceeded()).toBe(false);
  });

  // gzip(tar[a.txt] without its end marker) + gzip(tar[keep/other.txt]):
  // `tar -xz` reads both members; Bun.gunzipSync read only the first.
  const concatenated = (): Buffer => {
    const first = buildTar([entry("a.txt", { data: "A" })]);
    const second = buildTar([entry("keep/other.txt", { data: "hidden" })]);
    return Buffer.concat([gzipSync(first.subarray(0, first.length - 1024)), gzipSync(second)]);
  };

  test("the tar.gz listing reads every gzip member, as tar -xz does", () => {
    const names = readArchiveEntries(concatenated(), "tar.gz", 128 * MiB).map((e) => e.name);
    expect(names).toEqual(["a.txt", "keep/other.txt"]);
  });

  test.if(hasTar)("a hidden second gzip member cannot replace an existing directory", async () => {
    writeFileSync(path.join(ws, "two.tar.gz"), concatenated());
    mkdirSync(path.join(ws, "keep"));
    writeFileSync(path.join(ws, "keep/data.txt"), "precious");
    const dry = await run(archiveExtract, {
      archive: "two.tar.gz",
      destination: ".",
      dryRun: true,
    });
    expect(dry.wouldOverwrite).toEqual(["keep"]);
    const refused = await run(archiveExtract, { archive: "two.tar.gz", destination: "." });
    expect(refused).toMatchObject({ extracted: false, reason: "destination entries exist" });
    expect(readFileSync(path.join(ws, "keep/data.txt"), "utf8")).toBe("precious");
  });

  test("a forged gzip size cannot talk the listing past its memory cap", () => {
    const bomb = gzipSync(Buffer.alloc(8 * MiB));
    bomb.writeUInt32LE(65_536, bomb.length - 4); // ISIZE says 64 KiB
    expect(() => readArchiveEntries(bomb, "tar.gz", MiB)).toThrow(ArchiveFormatError);
    expect(() => readArchiveEntries(bomb, "tar.gz", MiB)).toThrow(/more than 1048576 bytes/);
  });

  test.if(hasTar)(
    "a tar made with `tar -C dir .` names its top-level entries as conflicts",
    async () => {
      mkdirSync(path.join(ws, "src"));
      writeFileSync(path.join(ws, "src/a.txt"), "new");
      const made = Bun.spawnSync([
        "tar",
        "-c",
        "-f",
        path.join(ws, "dot.tar"),
        "-C",
        path.join(ws, "src"),
        ".",
      ]);
      expect(made.exitCode).toBe(0);
      mkdirSync(path.join(ws, "dest"));
      writeFileSync(path.join(ws, "dest/a.txt"), "old");
      const refused = await run(archiveExtract, { archive: "dot.tar", destination: "dest" });
      expect(refused).toMatchObject({ extracted: false, conflicts: ["a.txt"] });
      expect(readFileSync(path.join(ws, "dest/a.txt"), "utf8")).toBe("old");
    },
  );
});

// ---------------------------------------------------------------------------

describe("the staged tree decides, whatever the index said", () => {
  /** A tar pax member whose `GNU.sparse.name` renames it on extraction. */
  const sparseNamed = (placeholder: string, real: string): Buffer => {
    const body = ` GNU.sparse.name=${real}\n`;
    let len = body.length + 1;
    while (String(len).length + body.length !== len) len += 1;
    const pax = `${len}${body}`;
    const tar = buildTar([
      entry(`PaxHeaders/${placeholder}`, { data: pax }),
      entry(placeholder, { data: "payload" }),
    ]);
    // Retype the first header as a pax extended header ('x') and fix its checksum.
    tar.write("x", 156, "ascii");
    tar.write("        ", 148, "ascii");
    let sum = 0;
    for (const byte of tar.subarray(0, 512)) sum += byte;
    tar.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    return tar;
  };

  test("the listing names a member the way the extractor will (GNU.sparse.name)", () => {
    const names = readArchiveEntries(sparseNamed("decoy.txt", ".git/config"), "tar").map(
      (e) => e.name,
    );
    expect(names).toEqual([".git/config"]);
  });

  test.if(hasTar)("so a renamed member is reported as the conflict it is", async () => {
    writeFileSync(path.join(ws, "renamed.tar"), sparseNamed("decoy.txt", "keep/x"));
    mkdirSync(path.join(ws, "keep"));
    writeFileSync(path.join(ws, "keep/data.txt"), "precious");
    const dry = await run(archiveExtract, {
      archive: "renamed.tar",
      destination: ".",
      dryRun: true,
    });
    expect(dry.topLevel).toEqual(["keep"]);
    expect(dry.wouldOverwrite).toEqual(["keep"]);
    const refused = await run(archiveExtract, { archive: "renamed.tar", destination: "." });
    expect(refused.reason).toBe("destination entries exist");
    expect(readFileSync(path.join(ws, "keep/data.txt"), "utf8")).toBe("precious");
  });

  // An extractor that reads the archive differently from the index, stood in
  // for by a shell line after the real extraction.
  const extractorThat = (extra: string): void => {
    _setExtractCommandForTest((argv, staging) => [
      "sh",
      "-c",
      `"$@" && cd "${staging}" && ${extra}`,
      "sh",
      ...argv,
    ]);
  };
  const plain = (): void => {
    writeFileSync(path.join(ws, "plain.tar"), buildTar([entry("pkg/a.txt", { data: "A" })]));
  };

  test.if(hasTar)(
    "a top-level entry the index does not list is refused, nothing promoted",
    async () => {
      plain();
      mkdirSync(path.join(ws, ".git"));
      writeFileSync(path.join(ws, ".git/config"), "mine");
      extractorThat("mkdir .git && echo pwned > .git/config");
      const result = await run(archiveExtract, { archive: "plain.tar", destination: "." });
      expect(result).toMatchObject({ extracted: false, reason: "unsafe archive" });
      expect(result.refused).toEqual([".git"]);
      expect(readFileSync(path.join(ws, ".git/config"), "utf8")).toBe("mine");
      expect(existsSync(path.join(ws, "pkg"))).toBe(false);
      expect(existsSync(path.join(ws, ".crewhaus-extract"))).toBe(false);
    },
  );

  test.if(hasTar)("a staged file hard-linked from outside the tree is refused", async () => {
    plain();
    writeFileSync(path.join(out, "victim.txt"), "outside");
    extractorThat(`ln "${path.join(out, "victim.txt")}" pkg/planted`);
    const result = await run(archiveExtract, { archive: "plain.tar", destination: "dest" });
    expect(result).toMatchObject({ extracted: false, reason: "unsafe archive" });
    expect(result.refused).toEqual(["pkg/planted"]);
    expect(existsSync(path.join(ws, "dest/pkg"))).toBe(false);
  });

  test.if(hasTar)("a staged link chain leading out is refused after extraction too", async () => {
    plain();
    // pkg/a/b/y leads to the staging root; x then climbs one level more.
    extractorThat(
      "mkdir -p pkg/a/b && ln -s ../../.. pkg/a/b/y && ln -s a/b/y/../escaped.txt pkg/x",
    );
    const result = await run(archiveExtract, { archive: "plain.tar", destination: "dest" });
    expect(result).toMatchObject({ extracted: false, reason: "unsafe archive" });
    expect(result.refused).toEqual(["pkg/x -> a/b/y/../escaped.txt"]);
    expect(existsSync(path.join(ws, "dest/pkg"))).toBe(false);
  });

  test.if(hasTar)(
    "bytes past maxBytes are refused even where the index declared fewer",
    async () => {
      plain();
      extractorThat("head -c 2097152 /dev/zero > pkg/big");
      const result = await run(archiveExtract, {
        archive: "plain.tar",
        destination: "dest",
        maxBytes: 1024 * 1024,
      });
      expect(result).toMatchObject({ extracted: false, reason: "too large" });
      expect(existsSync(path.join(ws, "dest/pkg"))).toBe(false);
    },
  );

  test.if(hasTar)(
    "an extractor still writing past maxBytes is stopped, not waited for",
    async () => {
      plain();
      // It writes past the cap and then would sit until its timeout: only the
      // size watch can end it early.
      extractorThat("head -c 2097152 /dev/zero > pkg/big && exec sleep 30");
      const started = Date.now();
      const result = await run(archiveExtract, {
        archive: "plain.tar",
        destination: "dest",
        maxBytes: 1024 * 1024,
      });
      expect(result).toMatchObject({ extracted: false, reason: "too large" });
      expect(result.detail).toContain("was stopped");
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(existsSync(path.join(ws, "dest/.crewhaus-extract"))).toBe(false);
    },
    20_000,
  );

  test.if(hasTar)(
    "the same extractor with nothing extra is accepted (the guards' control)",
    async () => {
      plain();
      extractorThat("true");
      const result = await run(archiveExtract, { archive: "plain.tar", destination: "dest" });
      expect(result).toMatchObject({ extracted: true, bytes: 1, entries: ["pkg"] });
    },
  );
});

describe("a FIFO, device or socket member is never extracted (0.7.1 review)", () => {
  // 0.7.1 before this listed `pkg/data.csv` as kind "other" with nothing
  // flagged, dryRun found no problem, and the extraction promoted a real
  // FIFO: the next tool to open data.csv blocked until a writer appeared.
  const fifoTar = (): void => {
    writeFileSync(
      path.join(ws, "evil.tar"),
      buildTar([
        entry("pkg/README.md", { data: "hello" }),
        entry("pkg/data.csv", { kind: "fifo" }),
      ]),
    );
  };

  test("ArchiveList flags it", async () => {
    fifoTar();
    const listed = await run(archiveList, { path: "evil.tar" });
    expect(listed.specialEntries).toEqual(["pkg/data.csv (fifo)"]);
    expect(listed.entries).toContainEqual({
      name: "pkg/data.csv",
      kind: "other",
      size: 0,
      special: "fifo",
    });
    expect(listed.unsafeEntries).toEqual([]);
  });

  test("an ordinary archive lists no specialEntries at all", async () => {
    writeFileSync(path.join(ws, "plain.tar"), buildTar([entry("pkg/a.txt", { data: "A" })]));
    expect("specialEntries" in (await run(archiveList, { path: "plain.tar" }))).toBe(false);
  });

  test("a zip whose unix mode says FIFO is flagged the same way", async () => {
    writeFileSync(
      path.join(ws, "evil.zip"),
      buildZip([entry("pkg/a.txt", { data: "A" }), entry("pkg/pipe", { kind: "fifo" })]),
    );
    const listed = await run(archiveList, { path: "evil.zip" });
    expect(listed.specialEntries).toEqual(["pkg/pipe (fifo)"]);
  });

  test("dryRun and the real call refuse it before anything is written", async () => {
    fifoTar();
    for (const dryRun of [true, false]) {
      const result = await run(archiveExtract, { archive: "evil.tar", destination: "out", dryRun });
      expect(result).toMatchObject({ extracted: false, reason: "unsafe archive", refusedCount: 1 });
      expect(result.refused).toEqual([
        "pkg/data.csv (fifo): only files, directories and links are extracted",
      ]);
      // The reason is the member's kind, not an escape: nothing here leads
      // outside the destination, and the detail must not say it does.
      expect(result.detail).toBe(
        "one or more members are FIFOs, devices or sockets, which are never extracted; nothing was extracted",
      );
    }
    expect(existsSync(path.join(ws, "out"))).toBe(false);
  });

  test.if(hasTar)(
    "one the extractor makes although the index did not list it is refused too",
    async () => {
      writeFileSync(path.join(ws, "plain.tar"), buildTar([entry("pkg/a.txt", { data: "A" })]));
      if (Bun.spawnSync(["which", "mkfifo"]).exitCode !== 0) return;
      _setExtractCommandForTest((argv, staging) => [
        "sh",
        "-c",
        `"$@" && cd "${staging}" && mkfifo pkg/pipe`,
        "sh",
        ...argv,
      ]);
      const result = await run(archiveExtract, { archive: "plain.tar", destination: "dest" });
      expect(result).toMatchObject({ extracted: false, reason: "unsafe archive" });
      expect(result.detail).toContain("FIFOs, devices or sockets");
      expect(result.refused).toEqual(["pkg/pipe (fifo)"]);
      expect(existsSync(path.join(ws, "dest/pkg"))).toBe(false);
    },
  );
});
