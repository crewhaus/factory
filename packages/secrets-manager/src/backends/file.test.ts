/**
 * Section 27 — `file` backend coverage.
 *
 * `node:fs` is fully mocked with an in-memory store so no real disk I/O
 * occurs (no tmp dirs, no leaked handles, deterministic). `crypto` is the
 * real WebCrypto for the auto-generate path, but we only assert its shape
 * (64 hex chars), so it stays deterministic in intent. `mock.restore()` does
 * NOT undo `mock.module`, and Bun shares one module registry across all test
 * files (nondeterministic order) — so the `afterAll` below reinstalls the
 * real `node:fs`, keeping the in-memory fake from leaking into sibling files.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Captured BEFORE the mock below so afterAll can reinstall the real module.
const realFs = require("node:fs") as typeof import("node:fs");

/** In-memory filesystem state shared with the node:fs mock. */
type FsState = {
  files: Map<string, { content: string; mode?: number }>;
  dirs: Set<string>;
  writes: Array<{ path: string; content: string; mode?: number }>;
  renames: Array<{ from: string; to: string }>;
};

let fsState: FsState;

function freshState(): FsState {
  return { files: new Map(), dirs: new Set(), writes: [], renames: [] };
}

// Initialise before the module under test is imported.
fsState = freshState();

mock.module("node:fs", () => ({
  existsSync: (p: string) => fsState.files.has(p) || fsState.dirs.has(p),
  readFileSync: (p: string, _enc?: string) => {
    const f = fsState.files.get(p);
    if (!f) {
      const err = new Error(`ENOENT: no such file ${p}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return f.content;
  },
  writeFileSync: (p: string, data: string, opts?: { mode?: number }) => {
    fsState.files.set(p, { content: data, mode: opts?.mode });
    fsState.writes.push({ path: p, content: data, mode: opts?.mode });
  },
  renameSync: (from: string, to: string) => {
    const f = fsState.files.get(from);
    if (f) {
      fsState.files.set(to, f);
      fsState.files.delete(from);
    }
    fsState.renames.push({ from, to });
  },
  mkdirSync: (p: string, _opts?: { recursive?: boolean; mode?: number }) => {
    fsState.dirs.add(p);
  },
  readdirSync: (p: string) => {
    if (!fsState.dirs.has(p)) {
      const err = new Error(`ENOENT: no such dir ${p}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    const prefix = `${p}/`;
    const out: string[] = [];
    for (const key of fsState.files.keys()) {
      if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
    }
    return out;
  },
}));

// Import AFTER the mock is registered so the SUT binds to the fake fs.
const { createFileBackend } = await import("../backends/file");
const { SecretsError } = await import("../index");

const ROOT = "/fake/secrets";

beforeEach(() => {
  fsState = freshState();
  fsState.dirs.add(ROOT);
});

afterEach(() => {
  // Reset the in-memory store so each test starts from a clean slate.
  fsState = freshState();
});

afterAll(() => {
  // Reinstall the real module so the in-memory fake cannot outlive this file.
  mock.module("node:fs", () => realFs);
});

describe("file backend — get()", () => {
  test("returns file contents (utf8, whitespace preserved)", async () => {
    fsState.files.set(`${ROOT}/API_KEY`, { content: "  secret with spaces \n" });
    const backend = createFileBackend({ rootDir: ROOT });
    expect(await backend.get("API_KEY")).toBe("  secret with spaces \n");
  });

  test("throws SecretsError when the file is missing, leaking neither name nor path", async () => {
    const backend = createFileBackend({ rootDir: ROOT });
    expect(backend.get("MISSING")).rejects.toBeInstanceOf(SecretsError);
    await backend.get("MISSING").catch((e: unknown) => {
      const msg = (e as Error).message;
      expect(msg).toBe("secret file read failed (not found)");
      // the secret name and the on-disk path must not appear in the message.
      expect(msg).not.toContain("MISSING");
      expect(msg).not.toContain(ROOT);
    });
  });

  test("rejects path-traversal names before touching fs, without echoing the name", async () => {
    const backend = createFileBackend({ rootDir: ROOT });
    expect(backend.get("../../etc/passwd")).rejects.toBeInstanceOf(SecretsError);
    await backend.get("../../etc/passwd").catch((e: unknown) => {
      const msg = (e as Error).message;
      expect(msg).toContain("invalid secret name");
      expect(msg).not.toContain("../../etc/passwd");
    });
  });
});

describe("file backend — rotate()", () => {
  test("writes to a .tmp file (mode 0o600) then renames atomically", async () => {
    const backend = createFileBackend({ rootDir: ROOT });

    const v = await backend.rotate("TOKEN", { newValue: "fresh-token" });

    expect(v).toBe("fresh-token");
    // The committed file holds the new value...
    expect(fsState.files.get(`${ROOT}/TOKEN`)?.content).toBe("fresh-token");
    // ...written first to the tmp path with restrictive mode...
    const tmpWrite = fsState.writes.find((w) => w.path === `${ROOT}/TOKEN.tmp`);
    expect(tmpWrite).toBeDefined();
    expect(tmpWrite?.mode).toBe(0o600);
    // ...and committed via rename(tmp -> final).
    expect(fsState.renames).toContainEqual({
      from: `${ROOT}/TOKEN.tmp`,
      to: `${ROOT}/TOKEN`,
    });
  });

  test("auto-generates a 64-char hex secret when newValue is omitted", async () => {
    const backend = createFileBackend({ rootDir: ROOT });
    const v = await backend.rotate("AUTO");
    expect(v).toMatch(/^[a-f0-9]{64}$/);
    expect(fsState.files.get(`${ROOT}/AUTO`)?.content).toBe(v);
  });

  test("rejects malformed names without writing", async () => {
    const backend = createFileBackend({ rootDir: ROOT });
    expect(backend.rotate("path/with/slash")).rejects.toBeInstanceOf(SecretsError);
    expect(fsState.writes.length).toBe(0);
  });

  test("creates the root dir on first rotate instead of failing with ENOENT", async () => {
    const freshRoot = "/fake/brand-new/secrets";
    expect(fsState.dirs.has(freshRoot)).toBe(false);
    const backend = createFileBackend({ rootDir: freshRoot });

    const v = await backend.rotate("TOKEN", { newValue: "fresh" });

    expect(v).toBe("fresh");
    expect(fsState.dirs.has(freshRoot)).toBe(true);
    expect(fsState.files.get(`${freshRoot}/TOKEN`)?.content).toBe("fresh");
  });
});

describe("file backend — list()", () => {
  test("lists committed secrets, skipping .tmp and dotfiles", async () => {
    fsState.files.set(`${ROOT}/A`, { content: "1" });
    fsState.files.set(`${ROOT}/B`, { content: "2" });
    fsState.files.set(`${ROOT}/C.tmp`, { content: "x" });
    fsState.files.set(`${ROOT}/.hidden`, { content: "y" });
    const backend = createFileBackend({ rootDir: ROOT });

    const names = await backend.list?.();

    expect([...(names ?? [])].sort()).toEqual(["A", "B"]);
  });

  test("returns [] when the root dir does not exist", async () => {
    const backend = createFileBackend({ rootDir: "/fake/does-not-exist" });
    expect(await backend.list?.()).toEqual([]);
  });

  test("returns [] when the root dir exists but is empty", async () => {
    const backend = createFileBackend({ rootDir: ROOT });
    expect(await backend.list?.()).toEqual([]);
  });
});
