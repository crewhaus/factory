import { describe, expect, spyOn, test } from "bun:test";
import {
  APPROVAL_ID_PATTERN,
  APPROVAL_ID_RE,
  CANONICAL_RUN_ID_RE,
  EXECUTION_RUN_ID_RE,
  GRAPH_RUN_ID_RE,
  HARNESS_ID_RE,
  ID_GRAMMARS,
  ISSUED_SECRET_RES,
  SESSION_ID_PATTERN,
  SESSION_ID_RE,
  ULID_PREFIXES,
  type UlidPrefix,
  formatId,
  isId,
  mintId,
  mintRunId,
  mintUlid,
  parseId,
} from "./index.js";

describe("mintUlid", () => {
  const zero = (bytes: Uint8Array) => bytes.fill(0);
  const ones = (bytes: Uint8Array) => bytes.fill(0xff);

  test("known answers", () => {
    expect(mintUlid({ now: 0, random: zero })).toBe("0".repeat(26));
    expect(mintUlid({ now: 2 ** 48 - 1, random: ones })).toBe(`7${"z".repeat(25)}`);
    expect(mintUlid({ now: 32, random: zero }).slice(0, 10)).toBe("0000000010");
  });

  test("the random part carries every byte, in order", () => {
    // 0x01 then zeros: 00000 00100 00000 … so the second character is 4.
    const body = mintUlid({
      now: 0,
      random: (bytes) => {
        bytes.fill(0);
        bytes[0] = 1;
      },
    });
    expect(body.slice(10)).toBe(`04${"0".repeat(14)}`);
  });

  test("the time comes from the clock it is given, and sorts", () => {
    const clock = spyOn(Date, "now").mockReturnValue(1000);
    try {
      const early = mintUlid({ random: zero });
      clock.mockReturnValue(2000);
      const late = mintUlid({ random: zero });
      expect(clock).toHaveBeenCalledTimes(2);
      expect(early < late).toBe(true);
      expect(mintUlid({ now: 1000, random: zero })).toBe(early);
    } finally {
      clock.mockRestore();
    }
  });

  for (const bad of [-1, 2 ** 48, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`a bad time throws RangeError: ${bad}`, () => {
      expect(() => mintUlid({ now: bad })).toThrow(RangeError);
    });
  }
});

describe("mint, parse, format", () => {
  test("every ULID prefix round-trips, and 10,000 mints are unique", () => {
    const seen = new Set<string>();
    for (const prefix of ULID_PREFIXES) {
      for (let i = 0; i < 10_000; i++) {
        const id = mintId(prefix);
        seen.add(id);
        const parsed = parseId(id);
        if (parsed?.prefix !== prefix || parsed.grammar !== "ulid") {
          throw new Error(`${id} parsed as ${JSON.stringify(parsed)}`);
        }
        if (formatId(parsed) !== id) throw new Error(`${id} did not format back`);
      }
    }
    expect(seen.size).toBe(ULID_PREFIXES.length * 10_000);
    expect(ULID_PREFIXES.length).toBeGreaterThanOrEqual(15);
  }, 20_000); // 150,000 mints and parses.

  test("mintId refuses a prefix with no ULID form", () => {
    expect(() => mintId("att" as UlidPrefix)).toThrow("no ULID form");
    expect(() => mintId("hrn" as UlidPrefix)).toThrow("no ULID form");
  });

  test("mintRunId is canonical", () => {
    expect(mintRunId()).toMatch(CANONICAL_RUN_ID_RE);
    expect(mintRunId({ now: 0, random: (b) => b.fill(0) })).toBe(`run_${"0".repeat(26)}`);
  });

  test("hex16 forms parse as hex16", () => {
    for (const prefix of ["hrn", "sess", "appr", "run", "grun"]) {
      const id = `${prefix}_0123456789abcdef`;
      expect(parseId(id)).toEqual({ prefix, body: "0123456789abcdef", grammar: "hex16" });
      expect(isId(prefix, id)).toBe(true);
    }
  });

  test("a digest id is its own grammar, and any first character parses", () => {
    const id = `att_z${"a".repeat(25)}`;
    expect(parseId(id)?.grammar).toBe("digest");
    expect(isId("att", id)).toBe(true);
    expect(isId("run", id)).toBe(false);
  });
});

describe("rejections", () => {
  const body = "0".repeat(26);
  const cases: readonly (readonly [string, unknown])[] = [
    ["uppercase body", `run_${"A".repeat(26)}`],
    ["uppercase prefix", `RUN_${body}`],
    ["excluded letter i", `run_i${"0".repeat(25)}`],
    ["excluded letter l", `run_l${"0".repeat(25)}`],
    ["excluded letter o", `run_o${"0".repeat(25)}`],
    ["excluded letter u", `run_u${"0".repeat(25)}`],
    ["short body", `dep_${"0".repeat(25)}`],
    ["long body", `dep_${"0".repeat(27)}`],
    ["hex16 on a ULID-only prefix", "dep_0123456789abcdef"],
    ["ULID on a hex16-only prefix", `hrn_${body}`],
    ["trailing newline", `dep_${body}\n`],
    ["unknown prefix", `zzz_${body}`],
    ["no prefix", `_${body}`],
    ["no separator", body],
    ["not a string", 12],
    ["null", null],
  ];
  for (const [name, value] of cases) {
    test(name, () => {
      expect(parseId(value)).toBeNull();
    });
  }
});

describe("grammars", () => {
  const regexes = {
    SESSION_ID_RE,
    APPROVAL_ID_RE,
    HARNESS_ID_RE,
    EXECUTION_RUN_ID_RE,
    GRAPH_RUN_ID_RE,
    CANONICAL_RUN_ID_RE,
    ...ISSUED_SECRET_RES,
  };

  test("every RegExp has empty flags", () => {
    const entries = Object.entries(regexes);
    expect(entries).toHaveLength(11);
    for (const [name, regex] of entries) expect(`${name}:${regex.flags}`).toBe(`${name}:`);
  });

  test("a grammar matches repeatedly, and a library may reset lastIndex on it", () => {
    const id = "sess_0123456789abcdef";
    expect(SESSION_ID_RE.test(id)).toBe(true);
    expect(SESSION_ID_RE.test(id)).toBe(true);
    // zod's `.regex()` assigns this; on a frozen RegExp the assignment throws.
    SESSION_ID_RE.lastIndex = 0;
    expect(SESSION_ID_RE.test(id)).toBe(true);
  });

  test("the literal bodies are the ones minted today", () => {
    expect(SESSION_ID_RE.source).toBe("^sess_[0-9a-f]{16}$");
    expect(APPROVAL_ID_RE.source).toBe("^appr_[0-9a-f]{16}$");
    expect(HARNESS_ID_RE.source).toBe("^hrn_[0-9a-f]{16}$");
    expect(EXECUTION_RUN_ID_RE.source).toBe("^run_[0-9a-f]{16}$");
    expect(GRAPH_RUN_ID_RE.source).toBe("^grun_[0-9a-f]{16}$");
    expect(CANONICAL_RUN_ID_RE.source).toBe("^run_[0-9a-hjkmnp-tv-z]{26}$");
    expect(`^${SESSION_ID_PATTERN}$`).toBe(SESSION_ID_RE.source);
    expect(`^${APPROVAL_ID_PATTERN}$`).toBe(APPROVAL_ID_RE.source);
  });

  test("the declared grammars, pinned", () => {
    expect(ID_GRAMMARS.map((g) => `${g.prefix}:${g.grammar}`)).toEqual([
      "dep:ulid",
      "run:ulid",
      "dec:ulid",
      "rule:ulid",
      "cmd:ulid",
      "prn:ulid",
      "grt:ulid",
      "inv:ulid",
      "crd:ulid",
      "lnk:ulid",
      "dev:ulid",
      "wi:ulid",
      "con:ulid",
      "crs:ulid",
      "chg:ulid",
      "att:digest",
      "hrn:hex16",
      "sess:hex16",
      "appr:hex16",
      "run:hex16",
      "grun:hex16",
    ]);
  });

  test("issued secrets: shape only, built from parts", () => {
    const body = "A".repeat(43);
    expect(ISSUED_SECRET_RES.session.test(`${"cha"}_${body}`)).toBe(true);
    expect(ISSUED_SECRET_RES.personal.test(`${"chp"}_${body}`)).toBe(true);
    expect(ISSUED_SECRET_RES.service.test(`${"chs"}_${body}`)).toBe(true);
    expect(ISSUED_SECRET_RES.invite.test(`${"chi"}_${body}`)).toBe(true);
    expect(ISSUED_SECRET_RES.scoped.test(`${"chx"}_payload.mac`)).toBe(true);
    expect(ISSUED_SECRET_RES.session.test(`${"cha"}_${body}A`)).toBe(false);
    expect(ISSUED_SECRET_RES.scoped.test(`${"chx"}_payload`)).toBe(false);
  });
});
