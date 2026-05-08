/**
 * Catalog R5 `a2a-protocol` — Section 22.
 *
 * In-crew agent-to-agent peer messaging. Distinct from Section 12's
 * channel-bot `SendMessage` (which posts to Slack/etc.) — this one routes
 * INSIDE the crew via the orchestrator's mailbox.
 *
 * Wire shape (the Google A2A inspiration):
 *   { from, to, kind, payload, traceparent }
 *
 * `traceparent` is the W3C trace-context header. The orchestrator's
 * mailbox stamps it from the bus's `currentTraceparent()` so subscribers
 * see every A2A message under the same trace id, even when the
 * receiving role's `runChatLoop` opens its own spans. The crew's OTel
 * exporter therefore stitches every role's spans into one trace.
 *
 * The tool itself is synchronous-from-the-sender's-POV: `SendMessage`
 * waits for the target role's reply and returns it as the tool result
 * so the sender's model can continue its turn with the answer in hand.
 */
import type { CrewMailbox, RuntimeBridge } from "@crewhaus/agent-context-isolation";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";

/** Wire envelope an A2A SendMessage produces. */
export type A2AEnvelope = {
  readonly from: string;
  readonly to: string;
  readonly kind: A2AMessageKind;
  readonly payload: string;
  readonly traceparent: string;
};

export type A2AMessageKind = "question" | "answer" | "notify";

export type CreateSendMessageA2AToolOptions = {
  readonly from: string;
  readonly targets: ReadonlyArray<string>;
};

const inputSchemaTemplate = z
  .object({
    target: z
      .string()
      .min(1)
      .describe("Role name to message — must be a peer in this crew, not yourself."),
    payload: z
      .string()
      .min(1)
      .describe(
        "The question or notification you want to send. The peer agent runs once with this as its input and returns a single reply string.",
      ),
    kind: z
      .enum(["question", "answer", "notify"])
      .optional()
      .describe(
        "Optional message classifier. Defaults to 'question'. Used by trace subscribers to colour-code A2A flows; semantically a no-op.",
      ),
  })
  .strict();

/**
 * Build the description with the live target list so the model sees
 * which peers are actually addressable.
 */
function describe(opts: CreateSendMessageA2AToolOptions): string {
  const others = opts.targets.filter((t) => t !== opts.from);
  if (others.length === 0) {
    return "Ask a peer agent in this crew a question and receive its reply. (No other roles defined — calling SendMessage will return an error.)";
  }
  return `Ask a peer agent in this crew a question and receive its reply synchronously. Use this when you need a brief, focused response from another role WITHOUT yielding control. The peer runs one turn with your payload as input and returns a single reply. Available peers: ${others.join(", ")}.`;
}

export function createSendMessageA2ATool(opts: CreateSendMessageA2AToolOptions): RegisteredTool {
  return buildTool({
    name: "SendMessage",
    description: describe(opts),
    inputSchema: inputSchemaTemplate,
    concurrencySafe: false,
    readOnly: true,
    destructive: false,
    // The peer reply is model-generated text — keep the post-tool
    // injection classifier on (default) so prompt-injection hidden in a
    // peer's response is caught.
    execute: async (input, ctx) => {
      const bridge = ctx?.bridge as RuntimeBridge | undefined;
      const mailbox: CrewMailbox | undefined = bridge?.crewMailbox;
      if (mailbox === undefined) {
        return "[A2A error] crew mailbox is not available — SendMessage can only be invoked from inside a crew-orchestrator turn.";
      }
      if (input.target === opts.from) {
        return `[A2A error] cannot send a message to yourself ("${opts.from}").`;
      }
      if (!mailbox.knownRoles.includes(input.target)) {
        return `[A2A error] unknown peer "${input.target}". Known peers: ${mailbox.knownRoles.join(", ")}.`;
      }
      try {
        const reply = await mailbox.sendA2A(input.target, input.payload);
        return reply;
      } catch (err) {
        return `[A2A error] ${(err as Error).message ?? String(err)}`;
      }
    },
  });
}

/**
 * Compose a wire envelope from raw fields. Exported so the orchestrator
 * (which actually emits the trace event) can build a consistent object
 * shape; tests also use it to assert envelope structure.
 */
export function buildEnvelope(args: {
  from: string;
  to: string;
  kind?: A2AMessageKind;
  payload: string;
  traceparent: string;
}): A2AEnvelope {
  return {
    from: args.from,
    to: args.to,
    kind: args.kind ?? "question",
    payload: args.payload,
    traceparent: args.traceparent,
  };
}

export { createSendMessageA2ATool as default };
