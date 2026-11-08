/**
 * The text a structured value carries, for classifying a value that reaches a
 * model or a run as data: every string it holds, one per line, in document
 * order, then the object keys and `type` labels. Reading the strings as text,
 * not as JSON, means an instruction reads the same in a payload as in a
 * message: its line breaks are line breaks, and two neighbouring fields read as
 * neighbouring lines. Keys and `type` labels come last so they do not sit
 * between two fields; a run of content blocks reads as its text.
 *
 * A string is returned as written. Map and Set entries are read, and a value
 * with a `toJSON` is read as what it serializes to. Numbers, booleans and null
 * hold no text.
 *
 * `undefined` when the value cannot be read: a cycle, a throwing accessor, a
 * nesting too deep to walk, or a BigInt, which no JSON encoder can send. What
 * the check cannot read, a caller refuses.
 */
export function valueText(value: unknown): string | undefined {
  const strings: string[] = [];
  const labels = new Set<string>();
  const finished = new WeakSet<object>();
  const open = new Set<object>();

  const walk = (node: unknown, isLabel: boolean): void => {
    if (typeof node === "string") {
      if (isLabel) labels.add(node);
      else if (node !== "") strings.push(node);
      return;
    }
    if (typeof node === "bigint") throw new TypeError("a BigInt has no JSON text");
    if (typeof node !== "object" || node === null) return;
    if (open.has(node)) throw new TypeError("a cycle has no JSON text");
    if (finished.has(node) || ArrayBuffer.isView(node) || node instanceof ArrayBuffer) return;
    open.add(node);
    if (node instanceof String) {
      walk(node.valueOf(), isLabel);
    } else if (node instanceof BigInt) {
      throw new TypeError("a BigInt has no JSON text");
    } else if (typeof (node as { toJSON?: unknown }).toJSON === "function") {
      walk((node as { toJSON: () => unknown }).toJSON(), isLabel);
    } else if (node instanceof Map) {
      for (const [k, v] of node) {
        walk(k, true);
        walk(v, false);
      }
    } else if (node instanceof Set || Array.isArray(node)) {
      for (const v of node) walk(v, false);
    } else {
      for (const [k, v] of Object.entries(node)) {
        labels.add(k);
        walk(v, k === "type");
      }
    }
    open.delete(node);
    finished.add(node);
  };

  try {
    walk(value, false);
  } catch {
    return undefined;
  }
  return [...strings, ...labels].join("\n");
}
