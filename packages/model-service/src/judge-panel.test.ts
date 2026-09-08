/**
 * 0.6.0 §6.2 (PR 13b) — the shared judge-panel emit fragment.
 *
 * Five judge sites render this: the three `renderEvaluation` copies (cli /
 * channel-bot / managed) and the two `JUDGE_GATE_HELPER` call sites (workflow
 * / graph). ONE renderer for all five, the `renderSubAgentDef` precedent —
 * so the field order and the absent-key discipline are pinned here rather
 * than five times over.
 */
import { describe, expect, test } from "bun:test";
import { JUDGE_PANEL_IMPORT, judgeInstrumentId, renderJudgePanelFields } from "./index";

describe("renderJudgePanelFields", () => {
  test("no knobs → nothing at all", () => {
    expect(renderJudgePanelFields({}, "  ")).toBe("");
  });

  test("a bare model renders one field (the pre-panel single judge call)", () => {
    expect(renderJudgePanelFields({ model: "claude-haiku-4-5" }, "      ")).toBe(
      '\n      model: "claude-haiku-4-5",',
    );
  });

  test("every knob renders in a fixed order, at the caller's indent", () => {
    expect(
      renderJudgePanelFields(
        {
          model: "claude-haiku-4-5",
          judges: ["a", "b"],
          repeats: 3,
          temperature: 0.2,
          target: "transcript",
          params: { maxTokens: 512 },
        },
        "  ",
      ),
    ).toBe(
      [
        '\n  model: "claude-haiku-4-5",',
        '\n  judges: ["a", "b"],',
        "\n  repeats: 3,",
        "\n  temperature: 0.2,",
        '\n  target: "transcript",',
        '\n  params: {"maxTokens":512},',
      ].join(""),
    );
  });

  test("an empty panel renders no `judges` field (the grader would refuse it)", () => {
    expect(renderJudgePanelFields({ model: "m", judges: [] }, "  ")).toBe('\n  model: "m",');
  });

  test("user-controlled strings are escaped, never interpolated raw", () => {
    const rendered = renderJudgePanelFields({ model: 'ev"il\nmodel', judges: ['x"y'] }, "  ");
    expect(rendered).not.toContain('model: "ev"il');
    expect(rendered).toContain("\\n");
    expect(rendered).toContain('\\"');
  });

  test("the import names exactly what the rendered call uses", () => {
    expect(JUDGE_PANEL_IMPORT).toBe(
      'import { gradeWithJudgePanel, inLoopRunResult } from "@crewhaus/eval-judge";',
    );
  });
});

describe("judgeInstrumentId", () => {
  test("a single judge is its own model; the fallback fills in when none is declared", () => {
    expect(judgeInstrumentId({ model: "claude-haiku-4-5" }, "primary")).toBe("claude-haiku-4-5");
    expect(judgeInstrumentId({}, "primary")).toBe("primary");
  });

  test("a panel is named by its members, joined with + in declaration order", () => {
    expect(judgeInstrumentId({ model: "ignored", judges: ["a", "b", "c"] }, "primary")).toBe(
      "a+b+c",
    );
  });
});
