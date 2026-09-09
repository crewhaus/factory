/**
 * `crewhaus services setup` flag parsing, plan rendering and step driving.
 *
 * The command is an operator tier that holds three short-lived provisioning
 * credentials, so two properties matter more than the rest and are asserted
 * directly: the rendered plan carries NO credential value (only variable
 * names, hostnames and ports), and a step that throws is turned into a
 * reported `failed` change rather than an exception that escapes the run and
 * loses the partial progress already on disk.
 *
 * No network, no ports: the only provider exercised here is Cloudflare, and
 * it is a route-table `fetchImpl` injected through `ctx.deps`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { SetupOptions } from "@crewhaus/service-setup";
import {
  InvalidServicesFlagError,
  type SetupContext,
  type SetupIo,
  type SetupTarget,
  describeEnvTarget,
  describePlan,
  looksLikeHarness,
  parsePortFlag,
  parseServicesFlag,
  parseSpaceTypeFlag,
  readSetupTarget,
  resolveEnvFile,
  runServicesSetup,
  terminalIo,
} from "./services-cmd";

const CF_BASE = "https://cf.invalid/client/v4";
const CF_PREFIX = "/client/v4";
// A value that must never appear in anything the command prints.
const CF_TOKEN = "cf-provisioning-token-do-not-print";

const SPEC_FULL = `name: Secretary Bot
target: channel
gateway:
  port: 8080
channels:
  slack:
    botToken: $SECRETARY_SLACK_BOT_TOKEN
    signingSecret: $SECRETARY_SLACK_SIGNING_SECRET
feedback:
  channelReactions: true
thredz:
  api_key: $THREDZ_API_KEY
  visibility: private
`;

const SPEC_THREDZ_ONLY = `name: Secretary Bot
target: cli
thredz:
  api_key: $THREDZ_API_KEY
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crewhaus-services-cmd-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function harness(yamlText: string): SetupTarget {
  const specPath = join(dir, "crewhaus.yaml");
  writeFileSync(specPath, yamlText, "utf8");
  return readSetupTarget(specPath);
}

function silentIo(): SetupIo {
  return { info: () => undefined, warn: () => undefined };
}

type Reply = { readonly status: number; readonly body: unknown };

function router(routes: Readonly<Record<string, Reply>>): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const bare = `${method} ${parsed.pathname}`;
    calls.push(bare);
    const route = routes[bare];
    if (route === undefined) throw new Error(`no fake route for ${bare}`);
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function cfOk(result: unknown): Reply {
  return { status: 200, body: { success: true, errors: [], messages: [], result } };
}

// ---------------------------------------------------------------------------
// parseServicesFlag
// ---------------------------------------------------------------------------

describe("parseServicesFlag", () => {
  test('absent, empty and "all" all mean every service the spec configures', () => {
    expect(parseServicesFlag(undefined)).toBeUndefined();
    expect(parseServicesFlag("")).toBeUndefined();
    expect(parseServicesFlag("all")).toBeUndefined();
  });

  test("a valid list comes back typed and in the order given", () => {
    expect(parseServicesFlag("slack")).toEqual(["slack"]);
    expect(parseServicesFlag("thredz,cloudflare")).toEqual(["thredz", "cloudflare"]);
    expect(parseServicesFlag("cloudflare,slack,thredz")).toEqual(["cloudflare", "slack", "thredz"]);
  });

  test("whitespace and empty segments are tolerated", () => {
    expect(parseServicesFlag("  slack , thredz  ")).toEqual(["slack", "thredz"]);
    expect(parseServicesFlag("slack,,thredz")).toEqual(["slack", "thredz"]);
    expect(parseServicesFlag(",")).toEqual([]);
  });

  test("an unknown name throws, naming both the bad value and the valid ones", () => {
    const err = (() => {
      try {
        parseServicesFlag("slack,discord");
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InvalidServicesFlagError);
    const message = (err as Error).message;
    expect(message).toContain('"discord"');
    expect(message).toContain("cloudflare, slack, thredz");
    expect(message).toContain('"all"');
  });

  test("every bad name is reported at once, not one per re-run", () => {
    expect(() => parseServicesFlag("discord,teams")).toThrow(/"discord", "teams"/);
  });

  test("the check is case-sensitive — a service id is a literal", () => {
    expect(() => parseServicesFlag("Slack")).toThrow(InvalidServicesFlagError);
  });
});

// ---------------------------------------------------------------------------
// parsePortFlag
// ---------------------------------------------------------------------------

describe("parsePortFlag", () => {
  test("accepts a TCP port", () => {
    expect(parsePortFlag("3000")).toBe(3000);
    expect(parsePortFlag("1")).toBe(1);
    expect(parsePortFlag("65535")).toBe(65535);
  });

  test("absent and empty mean the daemon's own default", () => {
    expect(parsePortFlag(undefined)).toBeUndefined();
    expect(parsePortFlag("")).toBeUndefined();
  });

  test("rejects a port outside 1–65535", () => {
    expect(() => parsePortFlag("0")).toThrow(InvalidServicesFlagError);
    expect(() => parsePortFlag("65536")).toThrow(InvalidServicesFlagError);
    expect(() => parsePortFlag("-1")).toThrow(/1–65535/);
  });

  test("rejects anything that is not an integer", () => {
    expect(() => parsePortFlag("abc")).toThrow(InvalidServicesFlagError);
    expect(() => parsePortFlag("30.5")).toThrow(InvalidServicesFlagError);
    expect(() => parsePortFlag("3000abc")).toThrow(/got "3000abc"/);
  });
});

// ---------------------------------------------------------------------------
// parseSpaceTypeFlag
// ---------------------------------------------------------------------------

describe("parseSpaceTypeFlag", () => {
  test("accepts the two Thredz space types", () => {
    expect(parseSpaceTypeFlag("shared")).toBe("shared");
    expect(parseSpaceTypeFlag("individual")).toBe("individual");
  });

  test("absent and empty defer to the spec's visibility", () => {
    expect(parseSpaceTypeFlag(undefined)).toBeUndefined();
    expect(parseSpaceTypeFlag("")).toBeUndefined();
  });

  test("rejects anything else, quoting what was given", () => {
    expect(() => parseSpaceTypeFlag("private")).toThrow(InvalidServicesFlagError);
    expect(() => parseSpaceTypeFlag("Shared")).toThrow(/got "Shared"/);
  });
});

// ---------------------------------------------------------------------------
// resolveEnvFile
// ---------------------------------------------------------------------------

describe("resolveEnvFile", () => {
  test("defaults to the .env beside the spec", () => {
    const target = harness(SPEC_FULL);
    expect(resolveEnvFile(target, undefined)).toBe(join(dir, ".env"));
  });

  test("an explicit override is resolved to an absolute path", () => {
    const target = harness(SPEC_FULL);
    const relative = resolveEnvFile(target, "fleet.env");
    expect(isAbsolute(relative)).toBe(true);
    expect(relative).toBe(resolve("fleet.env"));

    const absolute = join(dir, "shared", "fleet.env");
    expect(resolveEnvFile(target, absolute)).toBe(absolute);
  });
});

// ---------------------------------------------------------------------------
// describePlan
// ---------------------------------------------------------------------------

describe("describePlan", () => {
  const opts: SetupOptions = { zone: "example.com" };

  test("names the harness, both ports, and marks the control UI as not tunnelled", () => {
    const target = harness(SPEC_FULL);
    const text = describePlan(target, opts, join(dir, ".env")).join("\n");
    expect(text).toContain("Secretary Bot");
    expect(text).toContain("crewhaus.yaml");
    expect(text).toContain("channel target");
    expect(text).toContain(":3000");
    // The gateway port is a SEPARATE control-UI listener; tunnelling it would
    // serve Slack the status page and time out the webhook.
    expect(text).toContain("control UI :8080 (not tunnelled)");
    expect(text).toContain(join(dir, ".env"));
  });

  test("shows the derived hostname on every Cloudflare line and both Slack URLs", () => {
    const text = describePlan(harness(SPEC_FULL), opts, join(dir, ".env")).join("\n");
    expect(text).toContain('find-or-create tunnel "crewhaus"');
    expect(text).toContain("secretary-bot.example.com → http://localhost:3000");
    expect(text).toContain("DNS CNAME secretary-bot.example.com → <tunnel>.cfargotunnel.com");
    expect(text).toContain("https://secretary-bot.example.com/slack/events");
    expect(text).toContain("https://secretary-bot.example.com/slack/actions");
    // Reactions are on in this spec, so the scope count includes reactions:read.
    expect(text).toContain("(8 bot scopes)");
  });

  test("with no zone the hostname renders as (needs --zone) rather than a lie", () => {
    const text = describePlan(harness(SPEC_FULL), {}, join(dir, ".env")).join("\n");
    expect(text).toContain("public hostname (needs --zone)");
    expect(text).toContain("DNS CNAME (needs --zone)");
    expect(text).toContain("https://<host>/slack/events");
    expect(text).not.toContain("undefined");
  });

  test("contains no credential value — only names, hosts and ports", () => {
    writeFileSync(
      join(dir, ".env"),
      [
        `CLOUDFLARE_API_TOKEN=${CF_TOKEN}`,
        "SLACK_CONFIG_TOKEN=xoxe.xoxp-should-not-print",
        "THREDZ_API_KEY=thredz-should-not-print",
      ].join("\n"),
      "utf8",
    );
    const text = describePlan(
      harness(SPEC_FULL),
      { ...opts, spaceSlug: "secretary-bot", tunnelName: "fleet-north" },
      join(dir, ".env"),
    ).join("\n");
    expect(text).not.toContain(CF_TOKEN);
    expect(text).not.toContain("xoxe");
    expect(text).not.toContain("xoxb");
    expect(text).not.toContain("thredz-should-not-print");
    // The .env is named as a destination, which is a path, not a value.
    expect(text).toContain(join(dir, ".env"));
  });

  test("only the sections for the selected services are rendered", () => {
    const target = harness(SPEC_FULL);
    const thredzOnly = describePlan(target, { ...opts, services: ["thredz"] }, ".env").join("\n");
    expect(thredzOnly).toContain("Thredz");
    expect(thredzOnly).not.toContain("Cloudflare");
    expect(thredzOnly).not.toContain("Slack");
    expect(thredzOnly).toContain('find-or-create individual wiki space "Secretary Bot"');
    expect(thredzOnly).toContain("set thredz.space in crewhaus.yaml");
  });

  test("--manual-install changes the install line", () => {
    const target = harness(SPEC_FULL);
    expect(describePlan(target, opts, ".env").join("\n")).toContain(
      "open the install page, capture the bot token through the tunnel",
    );
    expect(describePlan(target, { ...opts, manualInstall: true }, ".env").join("\n")).toContain(
      "print the install URL; you paste the bot token",
    );
  });

  test("a spec with no gateway port renders no control-UI note", () => {
    const text = describePlan(harness(SPEC_THREDZ_ONLY), opts, ".env").join("\n");
    expect(text).not.toContain("control UI");
    expect(text).not.toContain("Slack");
  });
});

// ---------------------------------------------------------------------------
// runServicesSetup
// ---------------------------------------------------------------------------

function context(
  target: SetupTarget,
  options: SetupOptions,
  extras: {
    readonly fetchImpl?: typeof fetch;
    readonly cloudflareApiToken?: string;
  } = {},
): SetupContext {
  return {
    target,
    options,
    credentials:
      extras.cloudflareApiToken === undefined
        ? {}
        : { cloudflareApiToken: extras.cloudflareApiToken },
    io: silentIo(),
    ...(extras.fetchImpl === undefined
      ? {}
      : { deps: { cloudflare: { fetchImpl: extras.fetchImpl, apiBase: CF_BASE } } }),
  };
}

describe("runServicesSetup", () => {
  test("a thrown step becomes a failed result, not a propagated exception", async () => {
    // No Cloudflare token: `applyCloudflare` throws before anything goes out.
    const result = await runServicesSetup(
      context(harness(SPEC_FULL), { zone: "example.com", services: ["cloudflare"] }),
      join(dir, ".env"),
    );
    expect(result.failed).toBe(true);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.outcome).toBe("failed");
    expect(result.changes[0]?.summary).toBe("step failed");
    expect(result.changes[0]?.service).toBe("cloudflare");
    expect(result.changes[0]?.error).toContain("no Cloudflare API token");
    expect(result.followUp).toEqual([]);
  });

  test("the failed change is attributed to the service that threw", async () => {
    const result = await runServicesSetup(
      context(harness(SPEC_THREDZ_ONLY), { services: ["thredz"] }),
      join(dir, ".env"),
    );
    expect(result.failed).toBe(true);
    expect(result.changes[0]?.service).toBe("thredz");
    expect(result.changes[0]?.error).toContain("no Thredz API key");
  });

  test("a Slack step with no hostname fails with a fixable message", async () => {
    const result = await runServicesSetup(
      context(harness(SPEC_FULL), { services: ["slack"] }),
      join(dir, ".env"),
    );
    expect(result.failed).toBe(true);
    expect(result.changes[0]?.service).toBe("slack");
    expect(result.changes[0]?.error).toContain("no public hostname");
  });

  test("selecting nothing is a clean, empty success", async () => {
    const result = await runServicesSetup(
      context(harness(SPEC_THREDZ_ONLY), { services: ["slack"] }),
      join(dir, ".env"),
    );
    expect(result).toEqual({ changes: [], followUp: [], failed: false });
  });

  test("a successful Cloudflare step returns its changes and the connector hint", async () => {
    const { fetchImpl } = router({
      [`GET ${CF_PREFIX}/user/tokens/verify`]: cfOk({ id: "tok1", status: "active" }),
      [`GET ${CF_PREFIX}/zones`]: cfOk([{ id: "zone1", account: { id: "acct1" } }]),
      [`GET ${CF_PREFIX}/accounts/acct1/cfd_tunnel`]: cfOk([]),
      [`POST ${CF_PREFIX}/accounts/acct1/cfd_tunnel`]: cfOk({
        id: "tun1",
        name: "crewhaus",
        config_src: "cloudflare",
        deleted_at: null,
      }),
      [`GET ${CF_PREFIX}/accounts/acct1/cfd_tunnel/tun1/configurations`]: cfOk({ version: 0 }),
      [`PUT ${CF_PREFIX}/accounts/acct1/cfd_tunnel/tun1/configurations`]: cfOk({ version: 1 }),
      [`GET ${CF_PREFIX}/zones/zone1/dns_records`]: cfOk([]),
      [`POST ${CF_PREFIX}/zones/zone1/dns_records`]: cfOk({ id: "rec1" }),
      [`GET ${CF_PREFIX}/accounts/acct1/cfd_tunnel/tun1/token`]: cfOk("connector-token-value"),
    });
    const result = await runServicesSetup(
      context(
        harness(SPEC_FULL),
        { zone: "example.com", services: ["cloudflare"] },
        { fetchImpl, cloudflareApiToken: CF_TOKEN },
      ),
      join(dir, ".env"),
    );
    expect(result.failed).toBe(false);
    expect(result.changes.map((c) => c.outcome)).toEqual(["created", "updated", "created"]);
    // A newly created tunnel has no connector yet, so the run must tell the
    // operator to start one — the command never runs `sudo` itself.
    expect(result.followUp.join("\n")).toContain("sudo cloudflared service install");
  });

  test("a step that fails leaves earlier successful changes reported", async () => {
    const { fetchImpl } = router({
      [`GET ${CF_PREFIX}/user/tokens/verify`]: cfOk({ id: "tok1", status: "active" }),
      [`GET ${CF_PREFIX}/zones`]: cfOk([{ id: "zone1", account: { id: "acct1" } }]),
      [`GET ${CF_PREFIX}/accounts/acct1/cfd_tunnel`]: cfOk([
        // `status: healthy` = a connector is already attached, so this run
        // does not need to fetch the token and re-print the install command.
        {
          id: "tun1",
          name: "crewhaus",
          config_src: "cloudflare",
          deleted_at: null,
          status: "healthy",
        },
      ]),
      [`GET ${CF_PREFIX}/accounts/acct1/cfd_tunnel/tun1/configurations`]: cfOk({ version: 0 }),
      [`PUT ${CF_PREFIX}/accounts/acct1/cfd_tunnel/tun1/configurations`]: cfOk({ version: 1 }),
      [`GET ${CF_PREFIX}/zones/zone1/dns_records`]: cfOk([]),
      [`POST ${CF_PREFIX}/zones/zone1/dns_records`]: cfOk({ id: "rec1" }),
    });
    // Cloudflare succeeds; Thredz then fails for want of a key. Partial
    // progress is REPORTED, never rolled back — every step is idempotent.
    const result = await runServicesSetup(
      context(
        harness(SPEC_FULL),
        { zone: "example.com", services: ["cloudflare", "thredz"] },
        { fetchImpl, cloudflareApiToken: CF_TOKEN },
      ),
      join(dir, ".env"),
    );
    expect(result.failed).toBe(true);
    expect(result.changes).toHaveLength(4);
    expect(result.changes.slice(0, 3).every((c) => c.outcome !== "failed")).toBe(true);
    expect(result.changes[3]?.service).toBe("thredz");
    expect(result.changes[3]?.outcome).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// looksLikeHarness
// ---------------------------------------------------------------------------

describe("looksLikeHarness", () => {
  test("true only when the spec file is really there", () => {
    const specPath = join(dir, "crewhaus.yaml");
    expect(looksLikeHarness(specPath)).toBe(false);
    writeFileSync(specPath, SPEC_THREDZ_ONLY, "utf8");
    expect(looksLikeHarness(specPath)).toBe(true);
    expect(looksLikeHarness(join(dir, "nope", "crewhaus.yaml"))).toBe(false);
  });
});

describe("describeEnvTarget", () => {
  test("names a plain file as itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "svc-envtarget-"));
    const file = join(dir, ".env");
    writeFileSync(file, "A=1\n");
    expect(describeEnvTarget(file)).toBe(file);
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves a symlink so a fleet sees the shared file it is about to edit", () => {
    // A fleet commonly gives each harness `.env -> ../.env`. Writing goes
    // through the link; the plan has to say WHICH file that really is, or the
    // operator cannot tell they are editing every role's variables at once.
    const dir = mkdtempSync(join(tmpdir(), "svc-envtarget-"));
    const shared = join(dir, ".env");
    writeFileSync(shared, "A=1\n");
    const harness = join(dir, "role");
    mkdirSync(harness);
    const link = join(harness, ".env");
    symlinkSync("../.env", link);
    const rendered = describeEnvTarget(link);
    expect(rendered).toContain(link);
    expect(rendered).toContain("→");
    expect(rendered.endsWith(realpathSync(shared))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("falls back to the path when the file does not exist yet", () => {
    const missing = join(tmpdir(), "svc-envtarget-missing", ".env");
    expect(describeEnvTarget(missing)).toBe(missing);
  });
});

describe("regression — the CLI must hand the real seams to the package", () => {
  test("the entry file passes startResponder and portInUse into runServicesSetup", () => {
    // These are optional on SetupDeps so tests can omit them — which meant the
    // CLI could pass `deps: {}` and typecheck cleanly while silently disabling
    // the entire stand-in-responder path: no listener on the events port, no
    // answer to Slack's url_verification, and a fall-through to the manual
    // paste branch, all while the approved plan promised the automated
    // install. Nothing in the type system catches that, so assert the wiring.
    const entry = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const call = entry.slice(entry.indexOf("await runServicesSetup("));
    const args = call.slice(0, call.indexOf("envFile,"));
    expect(args).toContain("startResponder");
    expect(args).toContain("portInUse");
    expect(args).not.toContain("deps: {}");
  });

  test("terminalIo carries an openUrl so the install page can actually open", () => {
    expect(typeof terminalIo().openUrl).toBe("function");
  });
});
