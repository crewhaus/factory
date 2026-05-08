/**
 * Catalog R10 `agent-handoff` — Section 22.
 *
 * `Handoff(targetRole, reason, context?)` is an in-band baton-pass tool.
 * Unlike Section 13's `Task` (which forks an isolated child session), a
 * handoff stays inside the SAME crew session — only the active role
 * changes. The receiver inherits the parent transcript via the
 * orchestrator's `resume` plumbing.
 *
 * Flow:
 *   1. Sender's model calls `Handoff(target, reason, context?)`.
 *   2. The tool records the request on the bridge's `crewMailbox` and
 *      returns a single confirmation string. The model is expected to
 *      end its turn after seeing this result.
 *   3. The crew-orchestrator picks up `consumePendingHandoff()` after the
 *      sender's `runChatLoop` returns and dispatches to the target role
 *      with the reason (and any opaque context) as the seed message.
 *
 * Refusal protocol: a target may refuse by issuing a Handoff back to the
 * original sender. The orchestrator counts `depth` and trips a refusal-
 * loop guard at a configured depth (default 2) so two-way ping-pong
 * terminates cleanly with `HandoffRefusedError`.
 */
import type { RuntimeBridge } from "@crewhaus/agent-context-isolation";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";

export type CreateHandoffToolOptions = {
  /** Name of the role that owns this Handoff tool instance. Used for trace events. */
  readonly from: string;
  /** Allowed handoff targets (role names). Excluding self is enforced at execute-time. */
  readonly targets: ReadonlyArray<string>;
};

/**
 * Build the input schema dynamically so the model sees the exact set of
 * legal target role names in the JSON schema. Excludes `from` itself —
 * self-handoffs are always refused.
 */
function buildInputSchema(opts: CreateHandoffToolOptions): z.ZodTypeAny {
  const others = opts.targets.filter((t) => t !== opts.from);
  if (others.length === 0) {
    // Crew has only one role — Handoff is unusable. We still build the
    // tool (so the bundle compiles) but every call returns an error.
    return z
      .object({
        target: z.string().min(1).describe("Role name to hand control to."),
        reason: z.string().min(1).describe("Why control is being passed."),
        context: z
          .unknown()
          .optional()
          .describe("Optional opaque payload threaded to the receiver."),
      })
      .strict();
  }
  // Enum for IDE-style suggestion in the JSON schema; runtime validation
  // mirrors this AND adds the "must not be self" check.
  const targetEnum = z.enum(others as [string, ...string[]]);
  return z
    .object({
      target: targetEnum.describe(`Role to yield control to. One of: ${others.join(", ")}.`),
      reason: z
        .string()
        .min(1)
        .describe("Concise rationale — why this role is the right next owner."),
      context: z
        .unknown()
        .optional()
        .describe(
          "Optional opaque payload (object or string) that the receiver will see verbatim alongside `reason`.",
        ),
    })
    .strict();
}

export function createHandoffTool(opts: CreateHandoffToolOptions): RegisteredTool {
  const inputSchema = buildInputSchema(opts);
  const others = opts.targets.filter((t) => t !== opts.from);
  const description =
    others.length === 0
      ? "Yield control to another role. (No other roles defined — calling Handoff will return an error.)"
      : `Yield control to another role in this crew. End your turn after calling this tool — the orchestrator will activate the target role with your \`reason\` (and any \`context\`) as input. Available targets: ${others.join(", ")}.`;

  return buildTool({
    name: "Handoff",
    description,
    inputSchema,
    concurrencySafe: false,
    readOnly: true,
    destructive: false,
    // The Handoff tool's output is a controlled string — no risk of
    // attacker injection through the tool result, so opt out of the
    // post-tool classifier (it would re-route the model's natural
    // turn-ending nudge through a redaction pipeline).
    classifyOutput: false,
    execute: async (input, ctx) => {
      const parsed = input as { target: string; reason: string; context?: unknown };
      const bridge = ctx?.bridge as RuntimeBridge | undefined;
      if (bridge?.crewMailbox === undefined) {
        return "[Handoff error] crew mailbox is not available — Handoff can only be invoked from inside a crew-orchestrator turn.";
      }
      if (parsed.target === opts.from) {
        return `[Handoff error] cannot hand off to self ("${opts.from}"). End your turn instead.`;
      }
      const known = bridge.crewMailbox.knownRoles;
      if (!known.includes(parsed.target)) {
        return `[Handoff error] unknown role "${parsed.target}". Known roles: ${known.join(", ")}.`;
      }
      try {
        bridge.crewMailbox.requestHandoff(parsed.target, parsed.reason, parsed.context);
      } catch (err) {
        return `[Handoff error] ${(err as Error).message ?? String(err)}`;
      }
      return `Handoff queued: ${opts.from} → ${parsed.target}. End your turn now to transfer control.`;
    },
  });
}

export { createHandoffTool as default };
