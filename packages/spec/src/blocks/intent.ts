import { z } from "zod";
import type { Spec } from "../index";
import type { SpecAddIssue } from "./delta-090";

/**
 * `intent:` — what this harness is for, in its owner's words (#514). Authoring
 * only: no IR field, no lowering and no reader, so a bundle is the same bytes
 * with or without it. Only its owner changes it: the optimizer refuses it on
 * every shape and the spec editor asks for the typed confirmation
 * (`packages/spec-patch/src/owner-keys.ts`).
 */
const intentLine = z.string().trim().min(1).max(200);

export const intentBlock = z
  .object({
    purpose: z.string().trim().min(1).max(500),
    serves: z.array(intentLine).max(8).optional(),
    outcomes: z.array(intentLine).max(8).optional(),
    excludes: z.array(intentLine).max(8).optional(),
  })
  .strict()
  .optional()
  .describe("what this harness is for, in its owner's words; the optimizer never edits it");

/**
 * The one contradiction `intent:` can state: the same line under both
 * `outcomes` and `excludes`, compared case-insensitively on zod's trimmed
 * output. The message never echoes the line, so a validation error carries no
 * intent text.
 */
export function intentIssues(data: Spec, custom: SpecAddIssue): void {
  const { intent } = data;
  if (intent?.outcomes === undefined || intent.excludes === undefined) return;
  const outcomes = new Set(intent.outcomes.map((line) => line.toLowerCase()));
  intent.excludes.forEach((line, i) => {
    if (outcomes.has(line.toLowerCase())) {
      custom(
        ["intent", "excludes", i],
        `intent.excludes[${i}] repeats a line from intent.outcomes: keep it in one list.`,
      );
    }
  });
}
