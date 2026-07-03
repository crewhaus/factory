import { describe, expect, test } from "bun:test";
import {
  type GitPrDriver,
  type OpenedPr,
  type ProposalPrPlan,
  ProposeError,
  assembleProposal,
  buildProposalAuditPayload,
  buildProposalPrPlan,
  proposalId,
  specContentHash,
} from "./propose";

const CURRENT = `name: concierge
version: 1
target: cli
agent:
  model: claude-sonnet-4-5
  instructions: Be helpful.
`;

const PROPOSED = `name: concierge
version: 1
target: cli
agent:
  model: claude-opus-4-1
  instructions: Be helpful and concise.
`;

const NOW = () => new Date("2026-07-02T12:00:00.000Z");

describe("assembleProposal", () => {
  test("builds patch.json diff, changelog, PR body with eval delta", () => {
    const a = assembleProposal({
      specName: "concierge",
      currentYaml: CURRENT,
      proposedYaml: PROPOSED,
      source: "optimize",
      runId: "run_abc",
      evalDelta: { scoreBefore: 0.6, scoreAfter: 0.9, datasetName: "smoke" },
      proposedVersion: "v2",
      now: NOW,
    });
    expect(a.hasStructuralChange).toBe(true);
    // the model + instructions both changed
    const paths = a.patch.diff.map((d) => d.path);
    expect(paths.some((p) => p.includes("model"))).toBe(true);
    expect(a.patch.provenance.source).toBe("optimize");
    expect(a.patch.provenance.patchHash).toBe(specContentHash(PROPOSED));
    expect(a.patch.evalDelta?.scoreAfter).toBe(0.9);
    expect(a.prTitle).toContain("concierge");
    expect(a.prBody).toContain("0.600 → 0.900");
    expect(a.prBody).toContain("no auto-merge");
    // patchJson round-trips
    expect(JSON.parse(a.patchJson).specName).toBe("concierge");
  });

  test("throws when the proposed spec is byte-identical", () => {
    expect(() =>
      assembleProposal({
        specName: "c",
        currentYaml: CURRENT,
        proposedYaml: CURRENT,
        source: "manual",
        proposedVersion: "v2",
        now: NOW,
      }),
    ).toThrow(ProposeError);
  });

  test("comments-only change assembles with a structural-empty note", () => {
    const withComment = `${CURRENT}# added a trailing comment\n`;
    const a = assembleProposal({
      specName: "c",
      currentYaml: CURRENT,
      proposedYaml: withComment,
      source: "manual",
      proposedVersion: "v2",
      now: NOW,
    });
    expect(a.hasStructuralChange).toBe(false);
    expect(a.prBody).toContain("no structural changes");
  });
});

describe("proposalId", () => {
  test("is slug-safe and stamped", () => {
    const id = proposalId("My Agent", "v2", "abcd1234ef", new Date("2026-07-02T12:00:00Z"));
    expect(id).toMatch(/^My-Agent-v2-abcd1234-2026-07-02T12-00-00$/);
  });
});

describe("buildProposalPrPlan", () => {
  test("writes the spec + review bundle on a propose/ branch", () => {
    const a = assembleProposal({
      specName: "concierge",
      currentYaml: CURRENT,
      proposedYaml: PROPOSED,
      source: "advise",
      proposedVersion: "v2",
      now: NOW,
    });
    const { plan, proposalId: id } = buildProposalPrPlan({
      assembled: a,
      proposedYaml: PROPOSED,
      specRelPath: "crewhaus.yaml",
      proposedVersion: "v2",
      now: NOW,
    });
    expect(plan.branch).toBe(`propose/${id}`);
    expect(plan.files["crewhaus.yaml"]).toBe(PROPOSED);
    expect(Object.keys(plan.files).some((f) => f.endsWith("patch.json"))).toBe(true);
    expect(Object.keys(plan.files).some((f) => f.endsWith("CHANGELOG-entry.md"))).toBe(true);
    expect(plan.commitMessage).toContain("concierge");
  });
});

describe("driver seam", () => {
  test("a stub driver receives the plan and returns the opened PR", async () => {
    const a = assembleProposal({
      specName: "concierge",
      currentYaml: CURRENT,
      proposedYaml: PROPOSED,
      source: "optimize",
      proposedVersion: "v2",
      now: NOW,
    });
    const { plan } = buildProposalPrPlan({
      assembled: a,
      proposedYaml: PROPOSED,
      specRelPath: "crewhaus.yaml",
      proposedVersion: "v2",
      now: NOW,
    });
    let received: ProposalPrPlan | undefined;
    const driver: GitPrDriver = async (p) => {
      received = p;
      return { prNumber: 99, url: "https://github.com/acme/repo/pull/99", branch: p.branch };
    };
    const opened: OpenedPr = await driver(plan);
    expect(received?.title).toBe(a.prTitle);
    expect(opened.prNumber).toBe(99);

    const payload = buildProposalAuditPayload(a, opened, "v2", () => 555);
    expect(payload.prNumber).toBe(99);
    expect(payload.prUrl).toContain("/pull/99");
    expect(payload.patchHash).toBe(a.patch.provenance.patchHash);
    expect(payload.ts).toBe(555);
  });
});
