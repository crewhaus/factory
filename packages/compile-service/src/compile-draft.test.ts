/**
 * `compileDraft` returns exactly the files `crewhaus compile` would write, in
 * memory: the compiler's files plus the pinned dependency manifest, with the
 * stamp and the digest a build is known by.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { compile, lowerWithWarnings } from "@crewhaus/compiler";
import { bundleDigest, specRevision } from "@crewhaus/ir/policy";
import { parseSpec } from "@crewhaus/spec";
import { ABSENT_CORPUS } from "../../compiler/src/absent-corpus";
import { buildBundlePackageJson, collectCrewhausDeps } from "./bundle-stamp";
import { emitCfWorkerBundle } from "./cf-worker-emit";
import { compileDraft } from "./compile-draft";

const VERSION = "9.8.7";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("compileDraft", () => {
  test("for every shape: compile()'s files plus the pinned package.json, the stamp and the digest", async () => {
    let shapes = 0;
    for (const [shape, text] of Object.entries(ABSENT_CORPUS)) {
      const draft = await compileDraft(text, { compiledWith: VERSION });
      const compiled = compile(text).files;
      const stamp = { specHash: specRevision(text), compiledWith: VERSION };
      expect(draft.stamp, shape).toEqual(stamp);
      const shipsOwn = compiled.some((f) => f.path === "package.json");
      const expected = shipsOwn
        ? compiled
        : [
            ...compiled,
            {
              path: "package.json",
              content: buildBundlePackageJson(collectCrewhausDeps(compiled), VERSION, stamp),
            },
          ];
      expect(
        draft.files.map((f) => f.path),
        shape,
      ).toEqual(expected.map((f) => f.path));
      for (const [i, f] of expected.entries()) {
        expect(draft.files[i]?.content === f.content, `${shape} ${f.path}`).toBe(true);
      }
      expect(draft.digest, shape).toBe(
        bundleDigest(expected.map((f) => ({ path: f.path, sha256: sha(f.content) }))),
      );
      expect((await compileDraft(text, { compiledWith: VERSION })).digest, shape).toBe(
        draft.digest,
      );
      shapes += 1;
    }
    expect(shapes).toBe(14);
  }, 20_000); // compiles every shape twice

  test("a cf-worker draft is the Worker build, which ships its own package.json", async () => {
    const text = ABSENT_CORPUS.cli;
    const draft = await compileDraft(text, { compiledWith: VERSION, emitAs: "cf-worker" });
    const spec = parseSpec(text);
    const emitted = emitCfWorkerBundle(spec, lowerWithWarnings(spec).ir);
    expect(draft.files).toEqual(emitted.files);
    expect(draft.files.filter((f) => f.path === "package.json").length).toBe(1);
    expect(draft.files.find((f) => f.path === "package.json")?.content).not.toContain(
      "crewhaus-compiled-bundle",
    );
  });

  test("readme: false leaves the README out, and the spec text changes the stamp", async () => {
    const text = ABSENT_CORPUS.cli;
    const bare = await compileDraft(text, { compiledWith: VERSION, readme: false });
    expect(bare.files.some((f) => f.path === "README.md")).toBe(false);
    const other = await compileDraft(`${text}# a comment\n`, { compiledWith: VERSION });
    expect(other.stamp.specHash).not.toBe(bare.stamp.specHash);
  });

  test("a spec the compiler refuses throws the compiler's error", async () => {
    await expect(compileDraft("name: t\ntarget: cli\n", { compiledWith: VERSION })).rejects.toThrow(
      "spec validation failed",
    );
  });
});
