import { describe, expect, test } from "bun:test";
import {
  MIN_SCRUBBED_VALUE_LENGTH,
  composeScrubbers,
  createEnvScrubber,
  noopScrubber,
  scrubDeep,
} from "./scrub";

// Fixture credentials are assembled from parts so no realistic-shaped
// secret literal is ever committed.
const FAKE_KEY = ["sk", "fixture", "0000111122223333"].join("-");
const FAKE_TOKEN = ["xoxb", "fixture", "44445555"].join("-");

describe("createEnvScrubber", () => {
  test("replaces a known env value with its «NAME» placeholder", () => {
    const scrub = createEnvScrubber({ ANTHROPIC_API_KEY: FAKE_KEY });
    const out = scrub(`provider said: invalid key ${FAKE_KEY} (401)`);
    expect(out).toBe("provider said: invalid key «ANTHROPIC_API_KEY» (401)");
    expect(out).not.toContain(FAKE_KEY);
  });

  test("replaces every occurrence, including inside JSON", () => {
    const scrub = createEnvScrubber({ SLACK_BOT_TOKEN: FAKE_TOKEN });
    const line = JSON.stringify({ kind: "mcp_boot", argv: ["--token", FAKE_TOKEN, FAKE_TOKEN] });
    const out = scrub(line);
    expect(out).not.toContain(FAKE_TOKEN);
    // Still valid JSON — the placeholder cannot break the event stream.
    expect(() => JSON.parse(out)).not.toThrow();
  });

  test("leaves short values alone (scrubbing them would shred the log)", () => {
    const short = "a".repeat(MIN_SCRUBBED_VALUE_LENGTH - 1);
    const scrub = createEnvScrubber({ TINY: short });
    expect(scrub(`value ${short} here`)).toBe(`value ${short} here`);
  });

  test("leaves operational variables alone", () => {
    const scrub = createEnvScrubber({
      CREWHAUS_SESSION_DIR: "/somewhere/else/sessions",
      PORT: "31415926",
      NODE_ENV: "production",
    });
    expect(scrub("sessions at /somewhere/else/sessions on 31415926 (production)")).toBe(
      "sessions at /somewhere/else/sessions on 31415926 (production)",
    );
  });

  test("leaves non-secret-shaped values alone", () => {
    const scrub = createEnvScrubber({ SOME_FLAG: "12345678", OTHER: "false" });
    expect(scrub("12345678 false")).toBe("12345678 false");
  });

  test("longest value wins so a shared prefix cannot leak the remainder", () => {
    const account = "acct000111222";
    const token = `${account}-secret-tail`;
    const scrub = createEnvScrubber({ ACCOUNT: account, TOKEN: token });
    const out = scrub(`token=${token}`);
    expect(out).toBe("token=«TOKEN»");
    expect(out).not.toContain("secret-tail");
  });

  test("extra allowKeys are honoured", () => {
    const scrub = createEnvScrubber(
      { HARNESS_HOME: "/opt/harnesses/support-bot" },
      { allowKeys: ["HARNESS_HOME"] },
    );
    expect(scrub("cwd=/opt/harnesses/support-bot")).toBe("cwd=/opt/harnesses/support-bot");
  });

  test("no eligible variables produces a pass-through scrubber", () => {
    const scrub = createEnvScrubber({ PORT: "3000" });
    expect(scrub("nothing to do")).toBe("nothing to do");
  });
});

describe("scrubDeep", () => {
  test("scrubs string values at every depth, leaving keys and scalars", () => {
    const scrub = createEnvScrubber({ OPENAI_API_KEY: FAKE_KEY });
    const event = {
      kind: "run_failed",
      turn: 3,
      ok: false,
      detail: { message: `bad key ${FAKE_KEY}`, tags: ["a", FAKE_KEY] },
    };
    const out = scrubDeep(event, scrub) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
    expect(out["kind"]).toBe("run_failed");
    expect(out["turn"]).toBe(3);
    expect(out["ok"]).toBe(false);
  });
});

describe("composeScrubbers", () => {
  test("chains left to right", () => {
    const a: (t: string) => string = (t) => t.replace("one", "1");
    const b: (t: string) => string = (t) => t.replace("1", "uno");
    expect(composeScrubbers(a, b)("one")).toBe("uno");
  });

  test("empty composition and the noop scrubber are identities", () => {
    expect(composeScrubbers()("x")).toBe("x");
    expect(noopScrubber("x")).toBe("x");
  });
});
