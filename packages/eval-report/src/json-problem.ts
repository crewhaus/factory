/**
 * What the JSON parser said was wrong with a text, WITHOUT any of the text:
 * `Expected '}'`, `Property name must be a string literal`, `Unexpected EOF`.
 *
 * The parser quotes input in its messages — JavaScriptCore names the bare
 * word it met (`Unexpected identifier "ghp_…"`), V8 a slice of the input —
 * and that word can be a token pasted into the file. Everything from the
 * first double quote on is dropped; what is left is the parser's own words.
 */
export function jsonSyntaxProblem(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  const bare = message.replace(/^JSON Parse error:\s*/, "");
  const quote = bare.indexOf('"');
  const kept = (quote === -1 ? bare : bare.slice(0, quote)).replace(/[\s,:]+$/, "");
  return kept === "" ? "a syntax error" : kept;
}
