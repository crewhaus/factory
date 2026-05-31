import type { ChannelAdapter, InboundEvent } from "@crewhaus/channel-adapter-slack";
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";

/**
 * Catalog R4 `tool-message-channel` — `SendMessage(channel, text)` for
 * cross-channel addressing. Section 12.
 *
 * `channel` is an opaque routing key (the adapter id is the prefix before
 * the first `:`, e.g. `slack:T123:C456:1700000000.000`). The tool dispatches
 * to the matching adapter registered via `registerChannelAdapter` at boot
 * (the codegen-emitted `daemon.ts` calls this after `createSlackAdapter`).
 *
 * SECURITY: declared `destructive: true` so the permission engine treats it
 * as fail-closed in `default` mode — the agent can only invoke `SendMessage`
 * when an explicit `alwaysAllow` rule names it. The hello-channel example
 * documents this contract.
 */
export class ChannelToolError extends CrewhausError {
  override readonly name = "ChannelToolError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

const adapters = new Map<string, ChannelAdapter>();

export function registerChannelAdapter(id: string, adapter: ChannelAdapter): void {
  adapters.set(id, adapter);
}

export function getChannelAdapter(id: string): ChannelAdapter | undefined {
  return adapters.get(id);
}

/** Test-only — clears the per-process registry between tests. */
export function _resetChannelAdapters(): void {
  adapters.clear();
}

/**
 * Parse a routing key into an adapter id + the InboundEvent fields needed
 * by `sendReply`. The format is intentionally flat and human-typeable so
 * the model can construct routing keys from prior tool results.
 *
 * Slack format: `slack:<workspaceId>:<channelId>[:<threadTs>]`
 * Future channels follow the same shape under their own adapter id.
 */
function parseRoutingKey(channel: string): { adapterId: string; event: InboundEvent } {
  const parts = channel.split(":");
  if (parts.length < 3) {
    throw new ChannelToolError(
      `SendMessage: invalid channel "${channel}" — expected "<adapterId>:<workspaceId>:<channelId>[:<threadTs>]"`,
    );
  }
  const adapterId = parts[0] ?? "";
  const workspaceId = parts[1] ?? "";
  const channelId = parts[2] ?? "";
  const threadTs = parts[3];
  return {
    adapterId,
    event: {
      idempotencyKey: `synthetic_${Date.now()}`,
      workspaceId,
      channelId,
      userId: "<bot>",
      ...(threadTs !== undefined ? { threadTs } : {}),
      ts: threadTs ?? "0",
      text: "",
      subtype: "message" as const,
    },
  };
}

const sendMessageSchema = z.object({
  channel: z.string().min(1),
  text: z.string().min(1),
});

export const sendMessage: RegisteredTool = buildTool({
  name: "SendMessage",
  description:
    'Send a message to a channel/thread/DM identified by a routing key (e.g. "slack:T123:C456:1700000000.000"). Permission-gated.',
  inputSchema: sendMessageSchema,
  destructive: true,
  // Pillar 3 sink-side: channel send is the textbook lateral-comm sink.
  // egress-classifier scans the `text` payload for cross-origin lineage.
  scope: "external",
  // FR-002 — declare the io-capability fact (outbound channel network call).
  ioCapability: "network",
  // Pillar 3 intent gate: sending a message is irreversible-ish and visible
  // to humans on the other end, so demand justification.
  requireJustification: true,
  execute: async (input) => {
    const { adapterId, event } = parseRoutingKey(input.channel);
    const adapter = getChannelAdapter(adapterId);
    if (!adapter) {
      throw new ChannelToolError(
        `SendMessage: no adapter registered for "${adapterId}" — known: [${[...adapters.keys()].join(", ") || "<none>"}]`,
      );
    }
    await adapter.sendReply({ event, text: input.text });
    return `sent to ${input.channel}`;
  },
});
