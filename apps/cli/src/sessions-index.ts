/**
 * Item #57 — durable sessions index. Before a session JSONL is evicted (30-day
 * TTL), it is summarized into a compact index entry under
 * `.crewhaus/sessions-index/<id>.json` so the harness retains long-term
 * knowledge (outcome, tools used, ratings, key facts) past raw-transcript
 * retention. These entries feed the memory-store / few-shot / FAQ features.
 *
 * v0.3.0 PR 14: the glue (`parseSessionLog`, `summarizeSessionIntoIndex`,
 * `SESSIONS_INDEX_DIRNAME`) moved into `@crewhaus/session-store` — next to
 * `summarizeSession`, which it always wrapped — so the dream engine's
 * sessions fold-in step can call it without reaching into the CLI. This
 * module stays as a re-export so `crewhaus sessions summarize` (and any
 * other CLI import) is untouched.
 */

export {
  SESSIONS_INDEX_DIRNAME,
  parseSessionLog,
  summarizeSessionIntoIndex,
} from "@crewhaus/session-store";
