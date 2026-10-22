/**
 * The text of a transcript message, as the graders read it.
 *
 * Moved here from grader-continuity's `artifacts.ts` (design §4.1), which
 * `grader-12-metric-rubric/src/faithfulness.ts` had copied byte for byte: the
 * continuity graders and the faithfulness graders decide what a user said
 * from the same payload, so they read it with one function.
 */

/** Text of a `user_message`/`assistant_message` payload; null for synthetic
 *  runtime-injected messages and for tool_result-only user messages. */
export function messageText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p["synthetic"] === true) return null;
  const content = p["content"];
  if (typeof content === "string") return content.trim() !== "" ? content : null;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string" && b["text"].trim() !== "") {
      texts.push(b["text"]);
    }
  }
  return texts.length > 0 ? texts.join("\n") : null;
}
