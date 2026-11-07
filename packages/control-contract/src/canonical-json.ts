/**
 * Canonical JSON: object keys sorted, no whitespace, `undefined` properties
 * dropped. Written by hand so the main entry stays free of dependencies. A value
 * JSON cannot hold faithfully throws; that is a programmer error here.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new RangeError("control-contract: canonical JSON has no non-finite number");
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const record = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const item = record[key];
        if (item !== undefined) parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`control-contract: canonical JSON cannot hold a ${typeof value}`);
  }
}
