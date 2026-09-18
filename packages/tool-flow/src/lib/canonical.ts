/**
 * A canonical string for a JSON value.
 *
 * Object keys are emitted in sorted order, so two values that differ only in
 * the order their keys were written compare equal. `JSON.stringify` does not
 * do this — it preserves insertion order — and using it for equality means
 * `{label,confidence}` and `{confidence,label}` are different answers. Two
 * models that agreed would be reported as dissenting, and a decision table
 * would look like it changed when it had only been reformatted.
 *
 * Arrays keep their order, because in an array order is content.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}
