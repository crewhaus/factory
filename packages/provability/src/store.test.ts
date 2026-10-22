import { afterAll, describe, expect, test } from "bun:test";
import {
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
import { isProofId, newProofId } from "./artifact";
import { ProvabilityError } from "./evidence";
import { NO_SESSION, createBundleStore, createFileArtifactStore, proofsRoot } from "./store";
import { artifact, config, now } from "./test-helpers";
import { unverifiedBundle } from "./verify";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prov-store-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const SESSION = "sess_0123456789abcdef";
const bundle = unverifiedBundle(config("grounded"), "x", 0, now);

describe("proofsRoot", () => {
  test("is <cwd>/.crewhaus/proofs/<spec>", () => {
    expect(proofsRoot("/work", "support-bot")).toBe("/work/.crewhaus/proofs/support-bot");
    expect(proofsRoot("/work/./a/..", "v1.2_x")).toBe("/work/.crewhaus/proofs/v1.2_x");
  });

  test("refuses a spec name that could leave it", () => {
    for (const bad of ["..", ".", "a/b", "../etc", "", "a b", "x\0"]) {
      expect(() => proofsRoot("/work", bad)).toThrow(ProvabilityError);
    }
  });
});

describe("createBundleStore", () => {
  test("put writes <session>/turn-<n>.json, mode 0600, and get reads it back", async () => {
    const root = join(tempDir(), "proofs", "spec");
    const store = createBundleStore({ rootDir: root });
    const path = await store.put(bundle, { sessionId: SESSION, turnNumber: 7 });
    expect(path).toBe(join(root, SESSION, "turn-7.json"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(JSON.stringify(bundle)));
    expect(await store.get(SESSION, 7)).toEqual(bundle);
    expect(await store.get(SESSION, 8)).toBeUndefined();
    // No temp files are left beside it.
    expect(readdirSync(join(root, SESSION))).toEqual(["turn-7.json"]);
  });

  test("a run with no session writes under no-session; a retry replaces the turn's bundle", async () => {
    const store = createBundleStore({ rootDir: tempDir() });
    const first = await store.put(bundle, { turnNumber: 1 });
    expect(first.endsWith(join(NO_SESSION, "turn-1.json"))).toBe(true);
    const retried = { ...bundle, retryIndex: 1 };
    await store.put(retried, { turnNumber: 1 });
    expect((await store.get(undefined, 1))?.retryIndex).toBe(1);
  });

  test("refuses a tampered session id or turn before any path is built", async () => {
    const root = tempDir();
    const store = createBundleStore({ rootDir: root });
    for (const sessionId of ["../../etc", "sess_XYZ", "artifacts", `${SESSION}/..`]) {
      await expect(store.put(bundle, { sessionId, turnNumber: 1 })).rejects.toBeInstanceOf(
        ProvabilityError,
      );
    }
    for (const turnNumber of [-1, 1.5, Number.NaN, 1e12]) {
      await expect(store.put(bundle, { sessionId: SESSION, turnNumber })).rejects.toBeInstanceOf(
        ProvabilityError,
      );
    }
    expect(readdirSync(root)).toEqual([]);
  });

  test("never writes through a link planted at the bundle's name", async () => {
    const root = tempDir();
    const target = join(tempDir(), "victim.txt");
    writeFileSync(target, "untouched");
    mkdirSync(join(root, SESSION), { recursive: true });
    symlinkSync(target, join(root, SESSION, "turn-1.json"));
    const store = createBundleStore({ rootDir: root });
    await expect(store.put(bundle, { sessionId: SESSION, turnNumber: 1 })).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("untouched");
    await expect(store.get(SESSION, 1)).rejects.toBeInstanceOf(ProvabilityError);
  });

  test("a file that is not a bundle is reported, not returned", async () => {
    const root = tempDir();
    mkdirSync(join(root, SESSION));
    writeFileSync(join(root, SESSION, "turn-2.json"), '{"hello":1}');
    writeFileSync(join(root, SESSION, "turn-3.json"), "{nope");
    const store = createBundleStore({ rootDir: root });
    await expect(store.get(SESSION, 2)).rejects.toThrow(/not a proof bundle/);
    await expect(store.get(SESSION, 3)).rejects.toThrow(/not valid JSON/);
  });

  test("list is newest first and skips anything that is not a bundle file", async () => {
    const root = tempDir();
    const store = createBundleStore({ rootDir: root });
    const a = await store.put(bundle, { sessionId: SESSION, turnNumber: 1 });
    const b = await store.put(bundle, { sessionId: "sess_ffffffffffffffff", turnNumber: 2 });
    const c = await store.put(bundle, { turnNumber: 3 });
    utimesSync(a, new Date(1_000_000), new Date(1_000_000));
    utimesSync(b, new Date(3_000_000), new Date(3_000_000));
    utimesSync(c, new Date(2_000_000), new Date(2_000_000));
    mkdirSync(join(root, "artifacts"));
    writeFileSync(join(root, "artifacts", "turn-9.json"), "{}");
    writeFileSync(join(root, SESSION, "notes.txt"), "x");
    mkdirSync(join(root, "sess_1111111111111111"));
    symlinkSync(a, join(root, "sess_1111111111111111", "turn-4.json"));
    const listed = await store.list();
    expect(listed.map((l) => [l.sessionId, l.turnNumber])).toEqual([
      ["sess_ffffffffffffffff", 2],
      [NO_SESSION, 3],
      [SESSION, 1],
    ]);
    expect(listed[0]?.path).toBe(b);
  });

  test("prune removes bundles older than the cutoff and the session dirs they leave empty", async () => {
    const root = tempDir();
    const store = createBundleStore({ rootDir: root });
    const day = 86_400_000;
    const t0 = Date.parse("2026-10-22T00:00:00Z");
    const old1 = await store.put(bundle, { sessionId: SESSION, turnNumber: 1 });
    const old2 = await store.put(bundle, { sessionId: SESSION, turnNumber: 2 });
    const fresh = await store.put(bundle, { sessionId: "sess_ffffffffffffffff", turnNumber: 1 });
    for (const p of [old1, old2]) utimesSync(p, new Date(t0 - 100 * day), new Date(t0 - 100 * day));
    utimesSync(fresh, new Date(t0 - day), new Date(t0 - day));
    expect(await store.prune(90 * day, new Date(t0))).toBe(2);
    expect(existsSync(join(root, SESSION))).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(await store.prune(90 * day, new Date(t0))).toBe(0);
    await expect(store.prune(-1)).rejects.toBeInstanceOf(ProvabilityError);
  });
});

describe("createFileArtifactStore", () => {
  test("ids: fresh, well-formed, distinct", () => {
    const ids = new Set(Array.from({ length: 50 }, newProofId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(isProofId(id)).toBe(true);
    for (const bad of [
      "prf_0123",
      "prf_0123456789ABCDEF",
      "../prf_0123456789abcdef",
      "prf_0123456789abcdef/",
    ]) {
      expect(isProofId(bad)).toBe(false);
    }
  });

  test("put writes <root>/artifacts/<id>.json (0600), get and list read it", async () => {
    const root = tempDir();
    const store = createFileArtifactStore({ rootDir: root });
    const a = artifact({ id: newProofId(), checkedAt: "2026-10-22T10:00:00.000Z" });
    const b = artifact({ id: newProofId(), ok: false, checkedAt: "2026-10-22T11:00:00.000Z" });
    await store.put(a);
    await store.put(b);
    const file = join(root, "artifacts", `${a.id}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await store.get(a.id)).toEqual(a);
    expect((await store.list()).map((x) => x.id)).toEqual([b.id, a.id]);
  });

  test("a tampered id never reaches a path: get answers nothing, put refuses", async () => {
    const root = tempDir();
    writeFileSync(
      join(root, "secret.json"),
      JSON.stringify(artifact({ id: "prf_0123456789abcdef" })),
    );
    const store = createFileArtifactStore({ rootDir: join(root, "proofs") });
    for (const id of ["../secret", "prf_../../secret", "prf_0123456789abcdef/../../../secret"]) {
      expect(await store.get(id)).toBeUndefined();
    }
    await expect(store.put(artifact({ id: "../../evil" }))).rejects.toBeInstanceOf(
      ProvabilityError,
    );
    expect(existsSync(join(root, "evil.json"))).toBe(false);
  });

  test("artifacts are immutable, and a malformed one is refused on put and reported on get", async () => {
    const root = tempDir();
    const store = createFileArtifactStore({ rootDir: root });
    const a = artifact({ id: "prf_0123456789abcdef" });
    await store.put(a);
    await expect(store.put({ ...a, ok: false })).rejects.toThrow(/refusing to write/);
    expect((await store.get(a.id))?.ok).toBe(true);
    await expect(
      store.put({ ...a, id: "prf_1111111111111111", axioms: [1] as never }),
    ).rejects.toBeInstanceOf(ProvabilityError);
    writeFileSync(
      join(root, "artifacts", "prf_2222222222222222.json"),
      '{"id":"prf_2222222222222222"}',
    );
    await expect(store.get("prf_2222222222222222")).rejects.toThrow(/malformed/);
    // list skips the malformed one rather than failing.
    expect((await store.list()).map((x) => x.id)).toEqual([a.id]);
  });
});
