/**
 * One argv parser for the small family modules: positionals in order, and the flags the
 * family's `CLI_FAMILY` declares for a sub-verb, nothing else. A `value` flag is given
 * once, a `values` flag may repeat, a `boolean` flag takes no value. A wrong flag throws
 * a plain Error naming the flags it takes.
 */
export type FamilyArgs = {
  readonly positional: readonly string[];
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly booleans: ReadonlySet<string>;
};

export function parseFamilyArgs(
  label: string,
  argv: readonly string[],
  spec: Readonly<Record<string, "value" | "values" | "boolean">>,
): FamilyArgs {
  const positional: string[] = [];
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const kind = spec[name];
    if (kind === undefined) {
      const known = Object.keys(spec).map((key) => `--${key}`);
      throw new Error(
        `${label}: unknown flag "${arg}"${known.length > 0 ? ` (expected: ${known.join(", ")})` : ""}`,
      );
    }
    if (kind === "boolean") {
      booleans.add(name);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${label}: ${arg} needs a value`);
    i++;
    const list = values.get(name) ?? [];
    if (kind === "value" && list.length > 0) throw new Error(`${label}: ${arg} can be given once`);
    values.set(name, [...list, value]);
  }
  return { positional, values, booleans };
}
