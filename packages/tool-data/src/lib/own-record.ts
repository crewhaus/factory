/**
 * A `z.record` that keeps a key named `__proto__`.
 *
 * zod rebuilds a record into a fresh object and skips `__proto__` while it
 * does (so the rebuild cannot set the new object's prototype). That is the
 * right call for zod, and the wrong one for a data tool: `{"__proto__": 1}`
 * is valid JSON, `JSON.parse` keeps it as an own property, and CsvParse,
 * FlattenObject and JsonParse hand it back as one. Passed on to TableQuery,
 * CsvWrite or UnflattenObject, the field vanished before the tool ran, with
 * no error: the documented FlattenObject -> UnflattenObject round trip lost
 * it, and a `__proto__` column read by CsvParse was not written by CsvWrite.
 *
 * `ownRecord(values)` is a `ZodRecord` in every way a reader of the schema
 * can see (the model is shown the same JSON Schema, and introspection finds
 * a record), so only the parse differs: after zod's own checks, an own
 * `__proto__` key is validated with the same value schema and put back as
 * an own data property, at its place in the key order. Nothing is ever
 * assigned through `obj.__proto__`, so no prototype changes.
 */
import { z } from "zod";

const PROTO_KEY = "__proto__";

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ZodOwnRecord<Value extends z.ZodTypeAny> extends z.ZodRecord<z.ZodString, Value> {
  override _parse(input: z.ParseInput): z.ParseReturnType<Record<string, Value["_output"]>> {
    const result = super._parse(input);
    const raw = input.data;
    if (!isRecordLike(raw) || !Object.hasOwn(raw, PROTO_KEY)) return result;
    const restore = (
      parsed: z.SyncParseReturnType<Record<string, Value["_output"]>>,
    ): z.SyncParseReturnType<Record<string, Value["_output"]>> => {
      if (parsed.status === "aborted") return parsed;
      const ownValue = this._def.valueType.safeParse(raw[PROTO_KEY]);
      if (!ownValue.success) {
        const ctx = this._getOrReturnCtx(input);
        for (const issue of ownValue.error.issues) {
          z.addIssueToContext(ctx, { ...issue, path: [...input.path, PROTO_KEY, ...issue.path] });
        }
        return z.INVALID;
      }
      // Rebuild in the caller's key order, with `__proto__` as a plain own
      // property where it stood.
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(raw)) {
        const value = key === PROTO_KEY ? ownValue.data : parsed.value[key];
        Object.defineProperty(out, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return { status: parsed.status, value: out };
    };
    return result instanceof Promise ? result.then(restore) : restore(result);
  }
}

/** `z.record(values)`, except that a key named `__proto__` is kept as data. */
export function ownRecord<Value extends z.ZodTypeAny>(
  values: Value,
): z.ZodRecord<z.ZodString, Value> {
  return new ZodOwnRecord<Value>({
    keyType: z.string(),
    valueType: values,
    typeName: z.ZodFirstPartyTypeKind.ZodRecord,
  });
}
