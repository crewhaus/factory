/**
 * The function-call ids Gemini sent, by the tool_use id the stream gave the
 * call.
 *
 * Gemini usually sends no function-call id, so stream.ts always gives a call
 * a synthetic id, `gemini_<name>_<nonce><index>`: unique within a run, and a
 * string translate.ts can read the function name back out of when the
 * call's tool_use block has left the window (after compaction) —
 * `functionResponse.name` must be the declared function name. When Gemini
 * does send an id, the tool_use id stays synthetic (an API id carries no
 * name, so an orphaned result could no longer be named) and the API's id is
 * kept here, so the result goes back to Gemini under the id it gave the
 * call.
 *
 * In-process and bounded: a resumed session, or a call older than the last
 * {@link MAX_REMEMBERED} this process saw, answers with the synthetic id,
 * which is what every call carried before 0.7.1.
 */

export const MAX_REMEMBERED = 10_000;

const apiIds = new Map<string, string>();

/** Keep Gemini's own id for the call the stream named `toolUseId`. */
export function rememberGeminiCallId(toolUseId: string, apiId: string): void {
  apiIds.delete(toolUseId);
  apiIds.set(toolUseId, apiId);
  if (apiIds.size > MAX_REMEMBERED) {
    const oldest = apiIds.keys().next().value;
    if (oldest !== undefined) apiIds.delete(oldest);
  }
}

/** The id Gemini gave the call the stream named `toolUseId`, when it gave one. */
export function geminiCallIdFor(toolUseId: string): string | undefined {
  return apiIds.get(toolUseId);
}
