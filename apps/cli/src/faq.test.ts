import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiiRedactor } from "@crewhaus/pii-redactor";
import { discoverSkills, parseSkillFile } from "@crewhaus/skills-registry";
import { SYNTHESIZE_PII_DETECTORS } from "./dataset-mine";
import { buildFaqSkill, distillFaq } from "./faq";
import type { FeedbackRecord, SessionTurn } from "./feedback";

function turn(sessionId: string, turnNumber: number, input: string, output: string): SessionTurn {
  return { sessionId, turnNumber, input, output, toolNames: [] };
}

function upRating(sessionId: string, turnNumber: number, thumbs: "up" | "down"): FeedbackRecord {
  return {
    schemaVersion: 1,
    id: `${sessionId}_${turnNumber}`,
    sessionId,
    turnNumber,
    modality: "binary",
    rating: { thumbs },
    source: "user",
    ts: `2026-07-01T00:00:0${turnNumber}.000Z`,
  };
}

const S1 = "sess_00000000000000b1";
const S2 = "sess_00000000000000b2";
const S3 = "sess_00000000000000b3";

describe("distillFaq (#55)", () => {
  test("clusters recurring questions and pairs the best-rated answer", async () => {
    const turns = [
      turn(S1, 1, "how do I deploy my agent?", "Run crewhaus deploy."),
      turn(S2, 1, "how do I deploy the agent", "Use crewhaus deploy to ship it."),
      turn(S3, 1, "what is the weather", "I cannot check the weather."),
    ];
    const feedback = [upRating(S1, 1, "up"), upRating(S2, 1, "up"), upRating(S3, 1, "up")];
    const entries = await distillFaq(turns, feedback);
    // The two deploy questions cluster (occurrences ≥ 2); the weather one is a
    // singleton and is dropped.
    expect(entries).toHaveLength(1);
    expect(entries[0]?.occurrences).toBe(2);
    expect(entries[0]?.sessionCount).toBe(2);
    expect(entries[0]?.question).toContain("deploy");
    // Best answer is one of the two up-rated deploy answers.
    expect(entries[0]?.answer.toLowerCase()).toContain("deploy");
  });

  test("drops a cluster with no qualifying (up-rated) answer", async () => {
    const turns = [
      turn(S1, 1, "how do I deploy?", "answer 1"),
      turn(S2, 1, "how do I deploy", "answer 2"),
    ];
    // Both rated down → no qualifying answer.
    const entries = await distillFaq(turns, [upRating(S1, 1, "down"), upRating(S2, 1, "down")]);
    expect(entries).toHaveLength(0);
  });

  test("redacts a pasted credential from the FAQ answer", async () => {
    // Build a Slack-token-shaped secret at RUNTIME from parts (push-protection).
    const secret = ["xoxb", "-", "1".repeat(12), "-", "A".repeat(24)].join("");
    const turns = [
      turn(S1, 1, "what is the token?", `the token is ${secret}`),
      turn(S2, 1, "what is the token", `token: ${secret}`),
    ];
    const redactor = createPiiRedactor({ regexDetectors: SYNTHESIZE_PII_DETECTORS });
    const entries = await distillFaq(turns, [upRating(S1, 1, "up"), upRating(S2, 1, "up")], {
      redact: async (t) => (await redactor.redact(t)).text,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.answer).not.toContain(secret);
  });
});

describe("buildFaqSkill (#55)", () => {
  test("emits a SKILL.md valid per skills-registry parseSkillFile", () => {
    const md = buildFaqSkill(
      [
        {
          question: "how do I deploy?",
          answer: "Run crewhaus deploy.",
          sessionCount: 2,
          occurrences: 3,
        },
      ],
      { harnessName: "demo" },
    );
    const { frontmatter, body } = parseSkillFile(md);
    expect(frontmatter.name).toBe("faq");
    expect(frontmatter.description.length).toBeGreaterThan(0);
    expect(body).toContain("how do I deploy?");
    expect(body).toContain("Run crewhaus deploy.");
  });

  test("emitted skill is auto-discovered by discoverSkills", async () => {
    const home = mkdtempSync(join(tmpdir(), "faq-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "faq-cwd-"));
    try {
      const skillDir = join(cwd, ".crewhaus", "skills", "faq");
      mkdirSync(skillDir, { recursive: true });
      const md = buildFaqSkill(
        [{ question: "q?", answer: "a.", sessionCount: 2, occurrences: 2 }],
        { harnessName: "demo" },
      );
      writeFileSync(join(skillDir, "SKILL.md"), md);
      const skills = await discoverSkills({ cwd, homeDir: home });
      expect(skills.map((s) => s.name)).toContain("faq");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
