/**
 * Which recorded tool names are builtins (`@crewhaus/tool-categories`), and
 * the three whose result formats the evidence index reads.
 */
import { builtinKeyForName } from "@crewhaus/tool-categories";

/** tool-web's fetcher: its result opens with a `URL: …\nStatus: …` header. */
export const WEB_FETCH = "WebFetch";
/** tool-fetch's fetcher: its result opens with `HTTP <status>` and the headers. */
export const FETCH = "Fetch";
/** tool-fs's reader: its result is the file's text. */
export const READ = "Read";
/** tool-retrieve's tool (pipeline and every `knowledge:` corpus): `[n] id=… doc=… score=…` hits. */
export const RETRIEVE = "Retrieve";

/** Builtin keys by recorded name, memoized: the table is 500+ entries long. */
const keys = new Map<string, string | undefined>();

/** The builtin spec key a recorded tool name maps to (case-insensitively), or `undefined`. */
export function builtinKey(name: string): string | undefined {
  if (!keys.has(name)) keys.set(name, builtinKeyForName(name));
  return keys.get(name);
}
