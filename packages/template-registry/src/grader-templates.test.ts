/**
 * E47 — the `grader-template` manifest kind and the first-party eval-template
 * family library.
 *
 * The load-bearing guarantees under test:
 *   1. the new optional fields do NOT change the canonical JSON of a manifest
 *      that omits them (an already-signed spec template keeps verifying),
 *   2. a grader template signs/verifies/tampers exactly like a spec template,
 *      INCLUDING the nested evalAssets block (a nested key-order change must
 *      not silently produce a second valid signature),
 *   3. every shipped family is structurally valid and round-trips through the
 *      registry sources (the graders.yaml is separately parsed against the
 *      real grader schema in apps/cli, which owns that dependency).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVAL_ASSETS_TARGET,
  FIRST_PARTY_GRADER_TEMPLATES,
  GRADER_TEMPLATE_FAMILIES,
  LocalRegistrySource,
  StaticRegistrySource,
  type TemplateManifest,
  TemplateRegistryError,
  _canonicalManifestJsonForTest,
  firstPartyGraderTemplates,
  generateSigningKeypair,
  graderTemplateCatalog,
  signManifest,
  templateKind,
  validateGraderTemplate,
  verifyManifest,
  verifyingRegistry,
} from "./index";

const specManifest = {
  name: "hello-cli-template",
  version: "1.0.0",
  description: "A CLI hello-world template",
  author: "test",
  target: "cli",
  yaml: "name: hello\ntarget: cli\n",
};

const graderManifest: TemplateManifest = {
  name: "rag-custom",
  version: "0.1.0",
  description: "custom rag graders",
  author: "test",
  target: EVAL_ASSETS_TARGET,
  yaml: "graders:\n  - name: g\n    type: contains\n    substring: x\n",
  kind: "grader-template",
  evalAssets: {
    gradersYaml: "graders:\n  - name: g\n    type: contains\n    substring: x\n",
    notes: "review the anchors",
    seedDataset: [{ id: "s1", input: "hello", metadata: { family: "rag" } }],
  },
};

describe("manifest kinds are backward compatible", () => {
  test("a kind-less manifest is a spec-template and canonicalizes byte-identically", () => {
    expect(templateKind(specManifest)).toBe("spec-template");
    // The canonical JSON is the SIGNED payload: if E47's new optional keys
    // leaked into it for kind-less manifests, every signature in every
    // existing registry would break.
    expect(_canonicalManifestJsonForTest(specManifest)).toBe(
      JSON.stringify({
        name: specManifest.name,
        version: specManifest.version,
        description: specManifest.description,
        author: specManifest.author,
        target: specManifest.target,
        yaml: specManifest.yaml,
      }),
    );
    expect(_canonicalManifestJsonForTest(specManifest)).not.toContain("kind");
    expect(_canonicalManifestJsonForTest(specManifest)).not.toContain("evalAssets");
  });

  test("a signature made before the kind field still verifies", () => {
    const { privateKey, publicKey } = generateSigningKeypair();
    const signature = signManifest({ ...specManifest, publicKey }, privateKey);
    expect(
      verifyManifest({ ...specManifest, publicKey, signature }, { publicKeys: [publicKey] }).ok,
    ).toBe(true);
  });
});

describe("grader-template signing", () => {
  test("sign + verify round-trips with the evalAssets block", () => {
    const { privateKey, publicKey } = generateSigningKeypair();
    const signature = signManifest({ ...graderManifest, publicKey }, privateKey);
    const signed: TemplateManifest = { ...graderManifest, publicKey, signature };
    expect(verifyManifest(signed, { publicKeys: [publicKey] }).ok).toBe(true);
  });

  test("tampering with the graders.yaml INSIDE evalAssets breaks the signature", () => {
    const { privateKey, publicKey } = generateSigningKeypair();
    const signature = signManifest({ ...graderManifest, publicKey }, privateKey);
    const tampered: TemplateManifest = {
      ...graderManifest,
      publicKey,
      signature,
      evalAssets: {
        ...graderManifest.evalAssets,
        gradersYaml: "graders:\n  - name: g\n    type: contains\n    substring: attacker\n",
      } as TemplateManifest["evalAssets"],
    };
    const result = verifyManifest(tampered, { publicKeys: [publicKey] });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("signature does not verify");
  });

  test("evalAssets key ORDER does not change the signed payload", () => {
    const reordered: TemplateManifest = {
      ...graderManifest,
      evalAssets: {
        seedDataset: graderManifest.evalAssets?.seedDataset,
        notes: graderManifest.evalAssets?.notes,
        gradersYaml: graderManifest.evalAssets?.gradersYaml as string,
      },
    };
    expect(_canonicalManifestJsonForTest(reordered)).toBe(
      _canonicalManifestJsonForTest(graderManifest),
    );
  });

  test("a grader template flows through verifyingRegistry like any other kind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-grader-template-"));
    try {
      const { privateKey, publicKey } = generateSigningKeypair();
      const source = new LocalRegistrySource({ rootDir: dir });
      const signature = signManifest({ ...graderManifest, publicKey }, privateKey);
      source.put({ ...graderManifest, publicKey, signature });
      const verifying = verifyingRegistry({ source, trustRoot: { publicKeys: [publicKey] } });
      const fetched = await verifying.fetch(graderManifest.name);
      expect(templateKind(fetched)).toBe("grader-template");
      expect(validateGraderTemplate(fetched).ok).toBe(true);
      // The listing carries the kind without the payload, so a gallery can
      // filter grader templates out of a spec-template row.
      const listed = await verifying.list();
      expect(listed[0]?.kind).toBe("grader-template");
      expect((listed[0] as { yaml?: string }).yaml).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("validateGraderTemplate is strict", () => {
  test("accepts a well-formed grader template", () => {
    expect(validateGraderTemplate(graderManifest)).toEqual({ ok: true });
  });

  test("refuses a spec-template", () => {
    const result = validateGraderTemplate(specManifest as TemplateManifest);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("spec-template");
  });

  test("refuses missing / empty eval assets", () => {
    expect(validateGraderTemplate({ ...graderManifest, evalAssets: undefined }).reason).toContain(
      "carries no evalAssets",
    );
    expect(
      validateGraderTemplate({
        ...graderManifest,
        evalAssets: { gradersYaml: "   " },
      }).reason,
    ).toContain("non-empty string");
  });

  test("refuses unknown keys rather than dropping them", () => {
    const result = validateGraderTemplate({
      ...graderManifest,
      evalAssets: {
        gradersYaml: "graders: []\n",
        postInstallScript: "curl example.com | sh",
      } as unknown as TemplateManifest["evalAssets"],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("postInstallScript");
  });

  test("refuses malformed / duplicate seed samples", () => {
    const withSeeds = (seedDataset: unknown): { ok: boolean; reason?: string } =>
      validateGraderTemplate({
        ...graderManifest,
        evalAssets: {
          gradersYaml: "graders: []\n",
          seedDataset,
        } as unknown as TemplateManifest["evalAssets"],
      });
    expect(withSeeds([]).reason).toContain("non-empty array");
    expect(withSeeds([{ id: "a", input: "" }]).reason).toContain("input");
    expect(withSeeds([{ id: "", input: "x" }]).reason).toContain("id");
    expect(withSeeds([{ id: "a", input: "x", surprise: 1 }]).reason).toContain("surprise");
    expect(
      withSeeds([
        { id: "a", input: "x" },
        { id: "a", input: "y" },
      ]).reason,
    ).toContain("duplicate seed sample id");
  });
});

describe("the first-party family library", () => {
  test("ships every advertised family, each structurally valid", () => {
    expect(FIRST_PARTY_GRADER_TEMPLATES.map((m) => m.name)).toEqual([...GRADER_TEMPLATE_FAMILIES]);
    for (const manifest of FIRST_PARTY_GRADER_TEMPLATES) {
      expect(templateKind(manifest)).toBe("grader-template");
      expect(manifest.target).toBe(EVAL_ASSETS_TARGET);
      expect(validateGraderTemplate(manifest)).toEqual({ ok: true });
      expect(manifest.evalAssets?.gradersYaml).toContain("graders:");
      expect(manifest.evalAssets?.seedDataset?.length ?? 0).toBeGreaterThan(0);
      expect(manifest.evalAssets?.notes ?? "").not.toBe("");
    }
  });

  test("classify grades deterministically and ships golds; the judge families do not", () => {
    const classify = FIRST_PARTY_GRADER_TEMPLATES.find((m) => m.name === "classify");
    expect(classify?.evalAssets?.gradersYaml).toContain("type: expected_contains");
    expect(classify?.evalAssets?.gradersYaml).not.toContain("llm_judge");
    for (const s of classify?.evalAssets?.seedDataset ?? []) {
      expect(s.expected_output ?? "").not.toBe("");
    }
    // A gold-less family must NOT ship expected_output — the eval preflight
    // refuses gold-needing graders over gold-less data, and vice versa a
    // stray gold would teach the wrong shape.
    const rag = FIRST_PARTY_GRADER_TEMPLATES.find((m) => m.name === "rag");
    expect(rag?.evalAssets?.gradersYaml).toContain("llm_judge");
    for (const s of rag?.evalAssets?.seedDataset ?? []) {
      expect(s.expected_output).toBeUndefined();
    }
  });

  test("every judge rubric is FULLY anchored (that is the whole point)", () => {
    for (const manifest of FIRST_PARTY_GRADER_TEMPLATES) {
      const yaml = manifest.evalAssets?.gradersYaml ?? "";
      if (!yaml.includes("llm_judge")) continue;
      if (yaml.includes("kind: categorical")) {
        expect(yaml).toContain("passing_labels:");
        continue;
      }
      // One anchor line per level, for every criterion.
      const criteria = (yaml.match(/^\s+- name: /gm) ?? []).length - 1; // minus the grader
      for (const level of ["1", "2", "3", "4", "5"]) {
        expect((yaml.match(new RegExp(`"${level}": `, "g")) ?? []).length).toBe(criteria);
      }
      expect(yaml).toContain("passing_score:");
    }
  });

  test("safety keeps a benign control sample so over-refusal stays measurable", () => {
    const safety = FIRST_PARTY_GRADER_TEMPLATES.find((m) => m.name === "safety");
    expect(safety?.evalAssets?.gradersYaml).toContain("over_refused");
    const controls = (safety?.evalAssets?.seedDataset ?? []).filter(
      (s) => s.metadata?.["adversarial"] !== true,
    );
    expect(controls.length).toBeGreaterThan(0);
  });

  test("the embedded source lists + fetches families offline", async () => {
    const source = firstPartyGraderTemplates();
    const listed = await source.list();
    expect(listed.map((m) => m.name).sort()).toEqual([...GRADER_TEMPLATE_FAMILIES].sort());
    const rag = await source.fetch("rag");
    expect(rag.evalAssets?.gradersYaml).toContain("groundedness");
    await expect(source.fetch("nope")).rejects.toThrow(TemplateRegistryError);
    expect(graderTemplateCatalog().map((c) => c.name)).toEqual([...GRADER_TEMPLATE_FAMILIES]);
    for (const entry of graderTemplateCatalog()) expect(entry.description).not.toBe("");
  });

  test("StaticRegistrySource refuses a duplicated name", () => {
    expect(() => new StaticRegistrySource([graderManifest, graderManifest])).toThrow(
      TemplateRegistryError,
    );
  });
});
