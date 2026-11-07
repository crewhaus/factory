/**
 * What the control contract puts on the wire must come back from Hangar's masker
 * unchanged, because every response passes it. This runs the real `maskDeep` over
 * real values, in volume, since a masker rule fires only on the rare value that
 * spells a context word.
 */
import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_NAMES,
  CROCKFORD,
  CURSOR_SOURCES,
  type Cursor,
  ERROR_CODES,
  EVENT_TYPES,
  ID_GRAMMARS,
  OPERATIONS,
  PERMISSIONS,
  SYSTEM_ACTORS,
  ULID_PREFIXES,
  encodeCursor,
  isRef,
  mintId,
  mintRunId,
} from "../packages/control-contract/src/index";
import { maskDeep } from "../packages/hangar-server/src/mask";

const SAMPLES = 10_000;

function randomText(alphabet: string, length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet.charAt(byte % alphabet.length)).join("");
}

const HEX = "0123456789abcdef";
const hrn = () => `hrn_${randomText(HEX, 16)}`;
const digest = () => randomText(CROCKFORD, 26);

function randomCursor(): Cursor {
  const bytes = new Uint32Array(5);
  crypto.getRandomValues(bytes);
  const [a = 0, b = 0, c = 0, d = 0, e = 0] = bytes;
  const source = CURSOR_SOURCES[a % CURSOR_SOURCES.length] ?? "rows";
  const position = { seg: b, off: c + 1, tail: randomText(HEX, 8) };
  switch (a % 3) {
    case 0:
      return { v: 1, kind: "fleet", epoch: d, seq: e };
    case 1:
      return { v: 1, kind: "vector", sources: { [source]: [position] } };
    default:
      return { v: 1, kind: "page", sources: { [source]: [position] }, direction: "older" };
  }
}

/** How many of these strings the masker changed, naming the first few. */
function altered(generate: () => string, samples = SAMPLES): { count: number; first: string[] } {
  let count = 0;
  const first: string[] = [];
  for (let i = 0; i < samples; i++) {
    const value = generate();
    if (maskDeep(value) !== value) {
      count++;
      if (first.length < 3) first.push(value);
    }
  }
  return { count, first };
}

const CLEAN = { count: 0, first: [] };

describe("values the masker never touches", () => {
  test("ids of every prefix, digest ids, refs, actors and cursors", () => {
    let families = 0;
    for (const prefix of ULID_PREFIXES) {
      families++;
      expect(altered(() => mintId(prefix))).toEqual(CLEAN);
    }
    for (const decl of ID_GRAMMARS) {
      if (decl.grammar === "ulid") continue;
      families++;
      const body = decl.grammar === "digest" ? digest : () => randomText(HEX, 16);
      expect(altered(() => `${decl.prefix}_${body()}`)).toEqual(CLEAN);
    }
    const refs: readonly (() => string)[] = [
      () => `home/harness/${hrn()}`,
      () => `home/principal/${mintId("prn")}`,
      () => `home/creation/${mintId("crs")}`,
      () => `home/attention/att_${digest()}`,
      () => `${hrn()}/deployment/${mintId("dep")}`,
      () => `${hrn()}/run/${mintRunId()}`,
      () => `${hrn()}/run/run_${randomText(HEX, 8)}`,
      () => `${hrn()}/exec/run_${randomText(HEX, 16)}`,
      () => `${hrn()}/evalrun/run_${randomText(HEX, 16)}`,
      () => `${hrn()}/decision/appr_${randomText(HEX, 16)}`,
      () => `${hrn()}/decision/${mintId("dec")}`,
      () => `${hrn()}/rule/${mintId("rule")}`,
      () => `${hrn()}/session/sess_${randomText(HEX, 16)}`,
      () => `${hrn()}/change/${mintId("chg")}`,
      () => `home/cmd/${mintId("cmd")}`,
      () => `${hrn()}/work/${mintId("wi")}`,
      () => `home/connection/${mintId("con")}`,
    ];
    for (const ref of refs) {
      families++;
      expect(isRef(ref())).toBe(true);
      expect(altered(ref)).toEqual(CLEAN);
    }
    for (const actor of [
      () => mintId("prn"),
      () => `local:#${randomText(HEX, 64)}`,
      () => "local:sam@laptop.local",
    ]) {
      families++;
      expect(altered(actor)).toEqual(CLEAN);
    }
    families++;
    expect(altered(() => encodeCursor(randomCursor()))).toEqual(CLEAN);
    expect(families).toBeGreaterThanOrEqual(15 + 5 + 17 + 3 + 1);
  }, 20_000); // It masks hundreds of thousands of strings.

  test("every code, event, permission, capability, operation id and system actor", () => {
    const values = [
      ...Object.keys(ERROR_CODES),
      ...EVENT_TYPES,
      ...PERMISSIONS,
      ...CAPABILITY_NAMES,
      ...OPERATIONS.map((op) => op.id),
      ...SYSTEM_ACTORS,
    ];
    expect(values.length).toBeGreaterThanOrEqual(17 + 46 + 30 + 8 + 59 + 4);
    expect(values.filter((value) => maskDeep(value) !== value)).toEqual([]);
  });
});

describe("the masker is awake, and the caveat is real", () => {
  test("a keyed opaque value is masked", () => {
    const value = `prefix${"-"}${"key"}${"A".repeat(40)}`;
    expect(maskDeep(value)).not.toBe(value);
  });

  test("a knowledge ref can spell one, which is why its ids are opaque once registered", () => {
    const ref = `home/knowledge/${"api-keys-"}${"a".repeat(40)}`;
    expect(isRef(ref)).toBe(true);
    expect(maskDeep(ref)).not.toBe(ref);
  });
});
