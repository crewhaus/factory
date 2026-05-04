import * as readline from "node:readline/promises";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Slice-scope runtime: a multi-turn streaming chat loop with prompt
 * caching for the system prompt. Maps to catalog R1 runtime-orchestrator
 * (single-turn-cycle slice) and R2 model-adapter (Anthropic only).
 *
 * Future expansion: tool execution, compaction, permission, hooks,
 * multi-provider model adapters, abort handling, recovery — see
 * docs/MODULE-CATALOG.md PART B Layers R1–R2.
 */
export type RunChatLoopOptions = {
  model: string;
  instructions: string;
  maxTokens?: number;
  client?: Anthropic;
};

export async function runChatLoop(opts: RunChatLoopOptions): Promise<void> {
  const client = opts.client ?? new Anthropic();
  const maxTokens = opts.maxTokens ?? 4096;
  const messages: Anthropic.MessageParam[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  process.stdout.write(`agent ready (model: ${opts.model}). type "exit" to quit.\n`);

  try {
    while (true) {
      const userInput = (await rl.question("\nyou> ")).trim();
      if (userInput === "") continue;
      if (userInput === "exit" || userInput === "quit") break;

      messages.push({ role: "user", content: userInput });

      process.stdout.write("agent> ");
      const stream = client.messages.stream({
        model: opts.model,
        max_tokens: maxTokens,
        system: [
          {
            type: "text",
            text: opts.instructions,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages,
      });

      stream.on("text", (chunk) => {
        process.stdout.write(chunk);
      });

      const final = await stream.finalMessage();
      process.stdout.write("\n");

      const assistantText = final.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      messages.push({ role: "assistant", content: assistantText });
    }
  } finally {
    rl.close();
  }
}
