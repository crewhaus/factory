/**
 * Target-derivation tests.
 *
 * Every case writes a real `crewhaus.yaml` into a temp directory and reads it
 * back, because the module's whole job is to be free of naming conventions:
 * the only way to prove that is to hand it specs that name their variables
 * differently and watch the derived target follow the spec rather than a
 * default. Nothing here touches the network or a credential — the "secrets"
 * are `$VAR` refs, which are indirections, not values.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CredentialSlot,
  DEFAULT_EVENTS_PORT,
  SLACK_ACTIONS_PATH,
  SLACK_EVENTS_PATH,
  hostnameLabel,
  publicHostname,
  readSetupTarget,
  slotEnvName,
} from "./target";
import { ServiceSetupError } from "./types";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Write `yaml` as a harness spec and return its absolute path. */
function writeSpec(yaml: string, dirName?: string): string {
  const base = mkdtempSync(join(tmpdir(), "crewhaus-target-"));
  dirs.push(base);
  const harnessDir = dirName === undefined ? base : join(base, dirName);
  if (dirName !== undefined) mkdirSync(harnessDir, { recursive: true });
  const specPath = join(harnessDir, "crewhaus.yaml");
  writeFileSync(specPath, yaml, "utf8");
  return specPath;
}

/** Fail loudly rather than silently skipping an assertion on `undefined`. */
function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}

/** Capture a thrown `ServiceSetupError`, asserting that one was thrown. */
function caught(fn: () => unknown): ServiceSetupError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceSetupError);
    return err as ServiceSetupError;
  }
  throw new Error("expected a ServiceSetupError, but nothing was thrown");
}

const FULL_SPEC = `name: secretary
target: channel
channels:
  slack:
    botToken: $SECRETARY_SLACK_BOT_TOKEN
    signingSecret: $SECRETARY_SLACK_SIGNING_SECRET
feedback:
  channelReactions: true
gateway:
  port: 4601
thredz:
  api_key: $SECRETARY_THREDZ_KEY
  space: crew-secretary
`;

describe("readSetupTarget", () => {
  test("derives every field of a full channel spec", () => {
    const specPath = writeSpec(FULL_SPEC);
    const target = readSetupTarget(specPath);

    expect(target.specPath).toBe(specPath);
    expect(target.harnessDir).toBe(dirname(specPath));
    expect(target.name).toBe("secretary");
    expect(target.shape).toBe("channel");

    // The events port has no spec field: it defaults, and is NOT the gateway.
    expect(target.eventsPort).toBe(DEFAULT_EVENTS_PORT);
    expect(target.eventsPort).toBe(3000);
    expect(target.gatewayPort).toBe(4601);
    expect(target.gatewayPort).not.toBe(target.eventsPort);

    expect(target.slack).toEqual({
      botToken: {
        label: "channels.slack.botToken",
        ref: { kind: "env", name: "SECRETARY_SLACK_BOT_TOKEN" },
      },
      signingSecret: {
        label: "channels.slack.signingSecret",
        ref: { kind: "env", name: "SECRETARY_SLACK_SIGNING_SECRET" },
      },
      channelReactions: true,
    });

    expect(target.thredz).toEqual({
      apiKey: { label: "thredz.api_key", ref: { kind: "env", name: "SECRETARY_THREDZ_KEY" } },
      space: "crew-secretary",
      visibility: "private",
    });
  });

  test("the credential variable names come from the spec, not a convention", () => {
    const slack = present(readSetupTarget(writeSpec(FULL_SPEC)).slack, "slack");
    expect(slotEnvName(slack.botToken)).toBe("SECRETARY_SLACK_BOT_TOKEN");
    expect(slotEnvName(slack.signingSecret)).toBe("SECRETARY_SLACK_SIGNING_SECRET");
  });

  test("opts.eventsPort overrides the default and leaves the gateway alone", () => {
    const specPath = writeSpec(FULL_SPEC);
    const target = readSetupTarget(specPath, { eventsPort: 8123 });
    expect(target.eventsPort).toBe(8123);
    expect(target.gatewayPort).toBe(4601);
  });

  test("name falls back to the harness directory when the spec has none", () => {
    expect(readSetupTarget(writeSpec("target: channel\n", "billing-bot")).name).toBe("billing-bot");
  });

  test("an empty name string also falls back to the directory", () => {
    expect(readSetupTarget(writeSpec('name: ""\ntarget: channel\n', "empty-name")).name).toBe(
      "empty-name",
    );
  });

  test("shape is undefined when the spec declares no target", () => {
    expect(readSetupTarget(writeSpec("name: n\n")).shape).toBeUndefined();
  });

  test("a non-integer or out-of-range gateway port is not a port", () => {
    expect(readSetupTarget(writeSpec("gateway:\n  port: 0\n")).gatewayPort).toBeUndefined();
    expect(readSetupTarget(writeSpec("gateway:\n  port: 65536\n")).gatewayPort).toBeUndefined();
    expect(readSetupTarget(writeSpec("gateway:\n  port: 46.5\n")).gatewayPort).toBeUndefined();
    expect(readSetupTarget(writeSpec('gateway:\n  port: "4601"\n')).gatewayPort).toBeUndefined();
    expect(readSetupTarget(writeSpec("name: n\n")).gatewayPort).toBeUndefined();
    expect(readSetupTarget(writeSpec("gateway:\n  port: 65535\n")).gatewayPort).toBe(65535);
  });
});

describe("the three thredz forms", () => {
  test("`thredz: true` means the default $THREDZ_API_KEY", () => {
    expect(readSetupTarget(writeSpec("name: n\nthredz: true\n")).thredz).toEqual({
      apiKey: { label: "thredz.api_key", ref: { kind: "env", name: "THREDZ_API_KEY" } },
      space: undefined,
      visibility: "private",
    });
  });

  test("the string shorthand names its own variable", () => {
    const thredz = present(
      readSetupTarget(writeSpec("name: n\nthredz: $MY_KEY\n")).thredz,
      "thredz",
    );
    expect(thredz.apiKey.ref).toEqual({ kind: "env", name: "MY_KEY" });
    expect(thredz.apiKey.label).toBe("thredz");
    expect(slotEnvName(thredz.apiKey)).toBe("MY_KEY");
    expect(thredz.space).toBeUndefined();
    expect(thredz.visibility).toBe("private");
  });

  test("the object form carries key, space and visibility", () => {
    const specPath = writeSpec(
      "name: n\nthredz:\n  api_key: $K\n  space: docs\n  visibility: shared\n",
    );
    expect(readSetupTarget(specPath).thredz).toEqual({
      apiKey: { label: "thredz.api_key", ref: { kind: "env", name: "K" } },
      space: "docs",
      visibility: "shared",
    });
  });

  test("visibility defaults to private, and an unknown value is not shared", () => {
    expect(readSetupTarget(writeSpec("thredz:\n  api_key: $K\n")).thredz?.visibility).toBe(
      "private",
    );
    expect(
      readSetupTarget(writeSpec("thredz:\n  api_key: $K\n  visibility: public\n")).thredz
        ?.visibility,
    ).toBe("private");
  });

  test("`thredz: false` and an absent block are both undefined", () => {
    expect(readSetupTarget(writeSpec("name: n\nthredz: false\n")).thredz).toBeUndefined();
    expect(readSetupTarget(writeSpec("name: n\n")).thredz).toBeUndefined();
  });

  test("an object form with no api_key reports the missing variable rather than throwing", () => {
    const thredz = present(readSetupTarget(writeSpec("thredz:\n  space: docs\n")).thredz, "thredz");
    expect(thredz.apiKey.ref).toEqual({ kind: "env", name: "" });
    expect(slotEnvName(thredz.apiKey)).toBeUndefined();
    expect(thredz.space).toBe("docs");
  });
});

describe("the slack block", () => {
  test("no channels.slack means no slack half", () => {
    expect(readSetupTarget(writeSpec("name: n\n")).slack).toBeUndefined();
    expect(readSetupTarget(writeSpec("name: n\nchannels: {}\n")).slack).toBeUndefined();
    expect(readSetupTarget(writeSpec("name: n\nchannels:\n  slack: {}\n")).slack).toBeUndefined();
  });

  test("channelReactions is false when feedback is absent or does not opt in", () => {
    const bare = readSetupTarget(writeSpec("channels:\n  slack:\n    botToken: $T\n"));
    expect(bare.slack?.channelReactions).toBe(false);
    const off = readSetupTarget(
      writeSpec("channels:\n  slack:\n    botToken: $T\nfeedback:\n  channelReactions: false\n"),
    );
    expect(off.slack?.channelReactions).toBe(false);
    const stringy = readSetupTarget(
      writeSpec('channels:\n  slack:\n    botToken: $T\nfeedback:\n  channelReactions: "true"\n'),
    );
    expect(stringy.slack?.channelReactions).toBe(false);
  });

  test("a declared slack block with a missing credential still yields both slots", () => {
    const slack = present(
      readSetupTarget(writeSpec("channels:\n  slack:\n    botToken: $T\n")).slack,
      "slack",
    );
    expect(slack.botToken.ref).toEqual({ kind: "env", name: "T" });
    expect(slack.signingSecret.ref).toEqual({ kind: "env", name: "" });
    expect(slack.signingSecret.label).toBe("channels.slack.signingSecret");
    expect(slotEnvName(slack.signingSecret)).toBeUndefined();
  });

  test("the gateway route shape is the documented one", () => {
    expect(SLACK_EVENTS_PATH).toBe("/slack/events");
    expect(SLACK_ACTIONS_PATH).toBe("/slack/actions");
  });
});

describe("literal credentials", () => {
  test("a non-$ credential lowers to a literal and has no env name to write", () => {
    const slack = present(
      readSetupTarget(
        writeSpec(
          "channels:\n  slack:\n    botToken: xoxb-inline-not-a-ref\n    signingSecret: $S\n",
        ),
      ).slack,
      "slack",
    );
    expect(slack.botToken.ref).toEqual({ kind: "literal", value: "xoxb-inline-not-a-ref" });
    expect(slotEnvName(slack.botToken)).toBeUndefined();
    expect(slotEnvName(slack.signingSecret)).toBe("S");
  });

  test("slotEnvName is undefined for an env ref to nothing", () => {
    const empty: CredentialSlot = { label: "x", ref: { kind: "env", name: "" } };
    expect(slotEnvName(empty)).toBeUndefined();
  });
});

describe("malformed env refs", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["braces", "$" + "{SLACK_BOT_TOKEN}"],
    ["lowercase", "$slack_token"],
    ["a leading digit", "$1PASSWORD"],
  ];

  for (const [label, value] of cases) {
    test(`${label} throws a harness-scoped error naming the field`, () => {
      const specPath = writeSpec(`name: n\nchannels:\n  slack:\n    botToken: "${value}"\n`);
      const err = caught(() => readSetupTarget(specPath));
      expect(err.service).toBe("harness");
      expect(err.message).toContain("channels.slack.botToken");
      expect(err.message).toContain(value);
      expect(err.message).toContain("environment reference");
      expect(err.options.fix).toContain("$UPPER_SNAKE");
      expect(err.failureClass).toBe("config");
    });
  }

  test("a malformed signingSecret is caught as well", () => {
    const err = caught(() =>
      readSetupTarget(
        writeSpec("channels:\n  slack:\n    botToken: $T\n    signingSecret: $sig\n"),
      ),
    );
    expect(err.message).toContain("channels.slack.signingSecret");
    expect(err.options.fix).toContain("channels.slack.signingSecret");
  });

  test("a malformed thredz shorthand throws under the `thredz` label", () => {
    const err = caught(() => readSetupTarget(writeSpec('name: n\nthredz: "${THREDZ_KEY}"\n')));
    expect(err.service).toBe("harness");
    expect(err.message).toContain("thredz value");
    expect(err.options.fix).toContain("$UPPER_SNAKE");
  });

  test("a malformed thredz.api_key throws under the object label", () => {
    const err = caught(() => readSetupTarget(writeSpec("thredz:\n  api_key: $my_key\n")));
    expect(err.message).toContain("thredz.api_key");
  });
});

describe("unreadable and invalid specs", () => {
  test("an unreadable path throws with a useful fix", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-target-"));
    dirs.push(dir);
    const missing = join(dir, "nope", "crewhaus.yaml");
    const err = caught(() => readSetupTarget(missing));
    expect(err.service).toBe("harness");
    expect(err.message).toBe(`cannot read ${missing}`);
    expect(err.options.fix).toContain("crewhaus.yaml");
    expect(err.failureClass).toBe("config");
  });

  test("a directory in place of the spec is also unreadable", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-target-"));
    dirs.push(dir);
    expect(caught(() => readSetupTarget(dir)).message).toContain("cannot read");
  });

  test("invalid YAML throws naming the file and the parser's reason", () => {
    const specPath = writeSpec('name: "unterminated\nchannels: [a, b\n');
    const err = caught(() => readSetupTarget(specPath));
    expect(err.service).toBe("harness");
    expect(err.message).toStartWith("crewhaus.yaml is not valid YAML: ");
    expect(err.message.length).toBeGreaterThan("crewhaus.yaml is not valid YAML: ".length);
    expect(err.options.fix).toContain("crewhaus lint");
  });

  test("a spec that parses to a scalar or a list still reads as an empty record", () => {
    const scalar = readSetupTarget(writeSpec("just-a-string\n", "scalar-spec"));
    expect(scalar.name).toBe("scalar-spec");
    expect(scalar.slack).toBeUndefined();
    expect(scalar.thredz).toBeUndefined();
    const list = readSetupTarget(writeSpec("- one\n- two\n", "list-spec"));
    expect(list.name).toBe("list-spec");
    expect(list.gatewayPort).toBeUndefined();
  });
});

describe("hostnameLabel", () => {
  test("lowercases and collapses runs of non-label characters", () => {
    expect(hostnameLabel("Secretary")).toBe("secretary");
    expect(hostnameLabel("Crew Secretary")).toBe("crew-secretary");
    expect(hostnameLabel("acme.corp/bot_01")).toBe("acme-corp-bot-01");
    expect(hostnameLabel("a   b")).toBe("a-b");
    expect(hostnameLabel("Ops—Bot")).toBe("ops-bot");
  });

  test("trims leading and trailing dashes", () => {
    expect(hostnameLabel("--edge--")).toBe("edge");
    expect(hostnameLabel(" .Bot. ")).toBe("bot");
  });

  test("caps at 63 characters and never ends in a dash", () => {
    const long = hostnameLabel("a".repeat(80));
    expect(long).toHaveLength(63);
    expect(long).toBe("a".repeat(63));

    // Truncation must not leave the label ending in "-": the 63rd character
    // here is the separator introduced by the space.
    const cut = hostnameLabel(`${"b".repeat(62)} tail`);
    expect(cut.length).toBeLessThanOrEqual(63);
    expect(cut.endsWith("-")).toBe(false);
    expect(cut).toBe("b".repeat(62));
  });

  test("throws when the name slugifies to nothing", () => {
    for (const name of ["", "   ", "!!!", "___", "---"]) {
      const err = caught(() => hostnameLabel(name));
      expect(err.service).toBe("harness");
      expect(err.message).toBe(`cannot derive a hostname label from "${name}"`);
      expect(err.options.fix).toContain("--hostname");
    }
  });
});

describe("publicHostname", () => {
  test("composes subdomain and zone", () => {
    expect(publicHostname("example.com", "secretary")).toBe("secretary.example.com");
    expect(publicHostname("crewhaus.ai", hostnameLabel("Crew Secretary"))).toBe(
      "crew-secretary.crewhaus.ai",
    );
  });
});
