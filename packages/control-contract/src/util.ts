/** Exhaustiveness guard for a `switch` over a closed union. */
export function assertNever(value: never): never {
  throw new Error(`control-contract: unhandled case ${String(value)}`);
}

/**
 * Freeze a table all the way down, so a consumer can never edit shared vocabulary
 * at runtime. A `RegExp` stays as it is: every grammar here has empty flags, so
 * `lastIndex` means nothing, but a library may still assign it (zod's `.regex()`
 * does), and on a frozen object that assignment throws.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || value instanceof RegExp) return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
