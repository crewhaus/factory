/**
 * `crewhaus access` through `runAccessCommand`, against temporary roots and an injected
 * identity. HOME, the Hangar root, the registry root and the watchme root are all set, so
 * nothing reaches the real `~/.crewhaus`, and no Home process runs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import { type AccessCommandResult, parseDuration, runAccessCommand } from "./access-cmd";

let base: string;
let hangarRoot: string;
let harnessDir: string;
let env: Record<string, string | undefined>;
let clock: number;

const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const ME = { username: "max", hostname: "laptop" };
const OTHER = { username: "eve", hostname: "laptop" };

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-access-cmd-")));
  hangarRoot = join(base, "hangar");
  harnessDir = join(base, "alpha");
  mkdirSync(harnessDir);
  writeFileSync(join(harnessDir, "crewhaus.yaml"), "name: alpha\ntarget: cli\n");
  env = {
    HOME: join(base, "home"),
    CREWHAUS_HANGAR_ROOT: hangarRoot,
    CREWHAUS_REGISTRY_ROOT: join(base, "registry"),
    CREWHAUS_WATCHME_ROOT: join(base, "watchme"),
  };
  clock = T0;
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function run(argv: readonly string[], identity = ME): Promise<AccessCommandResult> {
  return runAccessCommand(argv, { env, now: () => clock, identity, isPidAlive: () => false });
}

/** Register the fixture harness, in a group, through the real registry. */
function registerHarness(group?: string): string {
  const registry = openHangarRegistry({ env, now: () => clock });
  const entry = registry.upsert({ dir: harnessDir, specName: "alpha", target: "cli" });
  if (group !== undefined) {
    registry.addGroup({ name: group });
    registry.setGroups(entry.id, [group]);
  }
  return entry.id;
}

function treeOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    if (!existsSync(at)) return;
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path)] = readFileSync(path, "utf8");
    }
  };
  walk(dir);
  return out;
}

const approversOf = (dir: string): string =>
  join(dir, ".crewhaus", "run", "control", "approvers.json");

function projection(): { epoch: number; members: { principal: string; decide: string }[] } {
  return JSON.parse(readFileSync(approversOf(harnessDir), "utf8"));
}

async function membersJson(): Promise<{
  members: { id: string; displayName?: string; grants: { id: string }[] }[];
}> {
  const out = await run(["members", "--json"]);
  return JSON.parse(out.lines.join("\n"));
}

describe("help", () => {
  test("bare access, --help and -h print usage on stdout and exit 0", async () => {
    for (const argv of [[], ["--help"], ["-h"], ["grant", "--help"]]) {
      const out = await run(argv);
      expect(out.exitCode).toBe(0);
      expect(out.lines[0]).toBe("usage:");
      expect(out.lines.join("\n")).toContain("crewhaus access sync");
    }
    expect(existsSync(hangarRoot)).toBe(false);
  });

  test("an unknown verb or flag throws, naming what is expected", async () => {
    await expect(run(["nope"])).rejects.toThrow(/expected: members, invite/);
    await expect(run(["members", "--bogus"])).rejects.toThrow(/unknown flag "--bogus"/);
  });
});

describe("reads over a Home nobody else uses", () => {
  test("members and tokens print the single-owner view and create nothing", async () => {
    mkdirSync(hangarRoot);
    writeFileSync(join(hangarRoot, "token"), `${"ab".repeat(32)}\n`);
    const before = treeOf(base);
    const members = await run(["members"]);
    expect(members).toEqual({ lines: ["Only you have access to this Home."], exitCode: 0 });
    const tokens = await run(["tokens"]);
    expect(tokens.exitCode).toBe(0);
    expect(tokens.lines[0]).toContain("No access tokens yet");
    expect((await run(["members", "--json"])).exitCode).toBe(0);
    expect((await run(["tokens", "--json"])).exitCode).toBe(0);
    expect((await run(["sync"])).exitCode).toBe(0);
    expect(treeOf(base)).toEqual(before);
    expect(existsSync(join(hangarRoot, "access"))).toBe(false);
  });

  test("after setup with only the owner, members still says only you", async () => {
    await run(["link", "github:1", "--member", "me"]);
    expect((await run(["members"])).lines).toEqual([
      "Only you have access to this Home.",
      "max (Home's owner): owner on all of this Home; linked: GitHub",
    ]);
    await run(["unlink", "github:1"]);
    expect((await run(["members"])).lines).toEqual(["Only you have access to this Home."]);
  });
});

describe("a revoke with Home stopped rewrites the projection", () => {
  test("grant puts the member in approvers.json; revoke takes them out and moves the epoch", async () => {
    const hrn = registerHarness();
    const granted = await run([
      "grant",
      "--member",
      "Ana",
      "--create",
      "--role",
      "operator",
      "--harness",
      hrn,
    ]);
    expect(granted.exitCode).toBe(0);
    expect(granted.lines).toContain("Ana is now an operator on alpha.");
    const ana = (await membersJson()).members.find((member) => member.displayName === "Ana");
    if (ana === undefined) throw new Error("Ana is not listed");
    const first = projection();
    expect(first.members).toEqual([{ principal: ana.id, decide: "operator" }]);
    const grantId = ana.grants[0]?.id as string;
    expect(granted.lines.join("\n")).toContain(`crewhaus access revoke ${grantId}`);
    clock += 60_000;
    const revoked = await run(["revoke", grantId]);
    expect(revoked).toEqual({ lines: ["Revoked the operator role on alpha."], exitCode: 0 });
    const second = projection();
    expect(second.members).toEqual([]);
    expect(second.epoch).toBeGreaterThan(first.epoch);
  });

  test("a harness given by directory resolves; an unregistered one names `crewhaus harness add`", async () => {
    registerHarness("team");
    expect(
      (
        await run([
          "grant",
          "--member",
          "Bo",
          "--create",
          "--role",
          "viewer",
          "--harness",
          harnessDir,
        ])
      ).exitCode,
    ).toBe(0);
    await expect(
      run(["grant", "--member", "Bo", "--role", "viewer", "--harness", join(base, "nowhere")]),
    ).rejects.toThrow(/crewhaus harness add <dir>/);
    await expect(
      run(["grant", "--member", "Bo", "--role", "viewer", "--group", "nogroup"]),
    ).rejects.toThrow(/crewhaus harness group/);
    expect(
      (await run(["grant", "--member", "Bo", "--role", "operator", "--group", "team"])).exitCode,
    ).toBe(0);
    expect(projection().members.map((member) => member.decide)).toEqual(["operator"]);
  });

  test("the verb never writes the registry", async () => {
    registerHarness();
    const registryFile = join(base, "registry", "harnesses.json");
    rmSync(harnessDir, { recursive: true });
    const before = readFileSync(registryFile, "utf8");
    const out = await run(["grant", "--member", "Ana", "--create", "--role", "operator", "--home"]);
    expect(readFileSync(registryFile, "utf8")).toBe(before);
    // The vanished harness is governed now and could not be written: say so and name sync.
    expect(out.exitCode).toBe(1);
    expect(out.lines.join("\n")).toContain("crewhaus access sync");
    expect(out.lines.join("\n")).toContain("Ana is now an operator on all of this Home.");
  });
});

describe("the verbs", () => {
  test("grant without --create is refused, and with it works; a name in use cannot be created twice", async () => {
    const refused = await run(["grant", "--member", "Ana", "--role", "viewer", "--home"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.lines.join("\n")).toContain("Add --create");
    expect(
      (await run(["grant", "--member", "Ana", "--create", "--role", "viewer", "--home"])).exitCode,
    ).toBe(0);
    const twice = await run(["grant", "--member", "ana", "--create", "--role", "viewer", "--home"]);
    expect(twice.exitCode).toBe(1);
    expect(twice.lines.join("\n")).toContain("already in use");
    expect((await run(["grant", "--member", "ana", "--role", "operator", "--home"])).exitCode).toBe(
      0,
    );
  });

  test("link slack:T0:U0 --member me links the local owner", async () => {
    const out = await run(["link", "slack:T0:U0", "--member", "me"]);
    expect(out.exitCode).toBe(0);
    expect(out.lines).toContain("Linked slack:T0:U0 to max.");
    expect((await run(["members"])).lines).toContain(
      "max (Home's owner): owner on all of this Home; linked: Slack",
    );
  });

  test("mint prints chs_… once, and tokens never shows it", async () => {
    const hrn = registerHarness();
    const minted = await run([
      "mint",
      "--service",
      "ci",
      "--permission",
      "h.decision.resolve",
      "--harness",
      hrn,
    ]);
    expect(minted.exitCode).toBe(0);
    const secrets = minted.lines.filter((line) => /^chs_[A-Za-z0-9_-]{43}$/.test(line));
    expect(secrets).toHaveLength(1);
    const secret = secrets[0] as string;
    const listed = await run(["tokens"]);
    const json = await run(["tokens", "--json"]);
    for (const out of [listed, json]) {
      expect(out.lines.join("\n")).not.toContain(secret.slice(8));
      expect(out.lines.join("\n")).not.toContain("sha256");
    }
    expect(listed.lines).toEqual([
      `ci (service): ${secret.slice(0, 8)}…, active, until 2027-04-30`,
    ]);
    expect(JSON.stringify(treeOf(base))).not.toContain(secret.slice(4));
  });

  test("every mutating verb refuses an OS user the Home does not belong to", async () => {
    const hrn = registerHarness();
    expect((await run(["link", "github:5", "--member", "me"])).exitCode).toBe(0);
    const before = treeOf(join(hangarRoot, "access"));
    for (const argv of [
      ["invite", "--role", "viewer", "--home"],
      ["grant", "--member", "Eve", "--create", "--role", "owner", "--home"],
      ["revoke", "--member", "max"],
      ["link", "slack:T0:U0", "--member", "me"],
      ["unlink", "github:5"],
      ["mint", "--service", "x", "--permission", "home.read"],
      ["sync"],
      ["revoke", "grt_01m6wfq4a6mvwrzywdy10enb4t"],
      ["grant", "--member", "Eve", "--create", "--role", "viewer", "--harness", hrn],
    ]) {
      const out = await run(argv, OTHER);
      expect(`${argv[0]} ${out.exitCode} ${out.lines.at(-1)}`).toBe(
        `${argv[0]} 1 This Home belongs to another user on this computer.`,
      );
    }
    expect(treeOf(join(hangarRoot, "access"))).toEqual(before);
  });

  test("invite prints the path when Home is not running, and the full link when it is", async () => {
    const stopped = await run(["invite", "--role", "viewer", "--home"]);
    expect(stopped.exitCode).toBe(0);
    expect(stopped.lines.some((line) => /^\/invite#c=chi_[A-Za-z0-9_-]{43}$/.test(line))).toBe(
      true,
    );
    expect(stopped.lines.join("\n")).toContain("open this path on Home's address");
    writeFileSync(
      join(hangarRoot, "hangar.lock"),
      JSON.stringify({ pid: 4242, startedAt: "x", port: 4321, url: "http://127.0.0.1:4321/" }),
    );
    const running = await runAccessCommand(
      ["invite", "--role", "operator", "--home", "--expires", "30m"],
      {
        env,
        now: () => clock,
        identity: ME,
        isPidAlive: (pid) => pid === 4242,
      },
    );
    expect(
      running.lines.some((line) =>
        /^http:\/\/127\.0\.0\.1:4321\/invite#c=chi_[A-Za-z0-9_-]{43}$/.test(line),
      ),
    ).toBe(true);
    const stale = await run(["invite", "--role", "viewer", "--home"]);
    expect(stale.lines.some((line) => line.startsWith("/invite#c="))).toBe(true);
  });

  test("a bad duration, a bound, a bad role and a bad subject name the expected form", async () => {
    await expect(run(["invite", "--role", "viewer", "--home", "--expires", "1w"])).rejects.toThrow(
      /like 30m, 24h or 7d/,
    );
    await expect(run(["invite", "--role", "viewer", "--home", "--expires", "8d"])).rejects.toThrow(
      /at most 7 days/,
    );
    await expect(
      run(["mint", "--service", "s", "--permission", "home.read", "--expires", "181d"]),
    ).rejects.toThrow(/at most 180 days/);
    await expect(run(["invite", "--role", "boss", "--home"])).rejects.toThrow(
      /viewer, operator, maintainer, owner/,
    );
    await expect(run(["invite", "--role", "viewer"])).rejects.toThrow(
      /--home, --group <name> or --harness/,
    );
    const subject = await run(["link", "slack:lowercase:u0", "--member", "me"]);
    expect(subject.exitCode).toBe(1);
    expect(subject.lines.at(-1)).toBe(
      "A link is slack:<team>:<user>, github:<numeric id> or proxy:<header>:<value>.",
    );
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("24h")).toBe(24 * 3_600_000);
    expect(parseDuration("7d")).toBe(7 * 86_400_000);
  });

  test("revoke --member erases the member; the owner and the bootstrap stay", async () => {
    mkdirSync(hangarRoot, { recursive: true });
    writeFileSync(join(hangarRoot, "token"), `${"cd".repeat(32)}\n`);
    expect((await run(["link", "slack:T9:U9", "--member", "Zed", "--create"])).exitCode).toBe(0);
    const removed = await run(["revoke", "--member", "Zed"]);
    expect(removed.exitCode).toBe(0);
    expect(JSON.stringify(treeOf(join(hangarRoot, "access")))).not.toContain("Zed");
    expect(JSON.stringify(treeOf(join(hangarRoot, "access")))).not.toContain("slack:T9:U9");
    const owner = await run(["revoke", "--member", "me"]);
    expect(owner.exitCode).toBe(1);
    const tokens = JSON.parse((await run(["tokens", "--json"])).lines.join("\n")) as {
      tokens: { id: string; kind: string }[];
    };
    const bootstrap = tokens.tokens.find((token) => token.kind === "bootstrap");
    expect((await run(["revoke", bootstrap?.id as string])).lines.at(-1)).toBe(
      "Home's own sign-in token cannot be revoked here.",
    );
  });

  test("the undo line a grant prints works, even for a grant the owner gave themselves", async () => {
    const hrn = registerHarness();
    const granted = await run(["grant", "--member", "me", "--role", "viewer", "--harness", hrn]);
    expect(granted.exitCode).toBe(0);
    const undo = granted.lines.find((line) => line.startsWith("To undo: crewhaus access "));
    if (undo === undefined) throw new Error("no undo line");
    const argv = undo.slice("To undo: crewhaus access ".length).split(" ");
    expect(argv[0]).toBe("revoke");
    expect(await run(argv)).toEqual({ lines: ["Revoked the viewer role on alpha."], exitCode: 0 });
  });

  test("--expires on a role that may approve is refused; on a viewer it works", async () => {
    const hrn = registerHarness();
    const refused = await run([
      "grant",
      "--member",
      "Ana",
      "--create",
      "--role",
      "operator",
      "--harness",
      hrn,
      "--expires",
      "1h",
    ]);
    expect(refused.exitCode).toBe(1);
    expect(refused.lines.at(-1)).toContain("Only the viewer role can be given with an end date.");
    expect(existsSync(approversOf(harnessDir))).toBe(false);
    const viewer = await run([
      "grant",
      "--member",
      "Ana",
      "--create",
      "--role",
      "viewer",
      "--harness",
      hrn,
      "--expires",
      "1h",
    ]);
    expect(viewer.exitCode).toBe(0);
  });

  test("the same user on a renamed computer still administers; another user name does not", async () => {
    const hrn = registerHarness();
    const first = { username: "max", hostname: "Maxs-MacBook-Pro.local" };
    expect((await run(["link", "github:7", "--member", "me"], first)).exitCode).toBe(0);
    const renamed = { username: "max", hostname: "maxs-macbook-pro" };
    const granted = await run(
      ["grant", "--member", "Ana", "--create", "--role", "operator", "--harness", hrn],
      renamed,
    );
    expect(granted.exitCode).toBe(0);
    expect((await run(["sync"], renamed)).exitCode).toBe(0);
    const before = treeOf(join(hangarRoot, "access"));
    const stranger = await run(["sync"], { username: "eve", hostname: "maxs-macbook-pro" });
    expect(stranger).toEqual({
      lines: ["This Home belongs to another user on this computer."],
      exitCode: 1,
    });
    expect(treeOf(join(hangarRoot, "access"))).toEqual(before);
  });

  test("a list ahead of the records is still brought to the revoke", async () => {
    const hrn = registerHarness();
    await run(["grant", "--member", "Ana", "--create", "--role", "operator", "--harness", hrn]);
    const ana = (await membersJson()).members.find((member) => member.displayName === "Ana");
    const grantId = ana?.grants[0]?.id as string;
    const planted = { ...projection(), epoch: projection().epoch + 50 };
    writeFileSync(approversOf(harnessDir), JSON.stringify(planted));
    const revoked = await run(["revoke", grantId]);
    expect(revoked).toEqual({ lines: ["Revoked the operator role on alpha."], exitCode: 0 });
    expect(projection().members).toEqual([]);
    expect(projection().epoch).toBe(planted.epoch + 1);
  });

  test("a harness whose list could not be updated is named, and the verb exits 1 naming sync", async () => {
    const hrn = registerHarness();
    await run(["grant", "--member", "Ana", "--create", "--role", "operator", "--harness", hrn]);
    const ana = (await membersJson()).members.find((member) => member.displayName === "Ana");
    rmSync(harnessDir, { recursive: true, force: true });
    const revoked = await run(["revoke", ana?.grants[0]?.id as string]);
    expect(revoked.exitCode).toBe(1);
    expect(revoked.lines).toEqual([
      "Revoked the operator role on alpha.",
      "Could not update who may approve on alpha: the harness directory is missing.",
      "The change is recorded. Once that is fixed, run `crewhaus access sync`.",
    ]);
    const synced = await run(["sync"]);
    expect(synced.exitCode).toBe(1);
    expect(synced.lines[0]).toBe("Updated 0 of 1 approver lists.");
  });

  test("sync rewrites an approver list that was deleted", async () => {
    registerHarness();
    expect(
      (await run(["grant", "--member", "Ana", "--create", "--role", "operator", "--home"]))
        .exitCode,
    ).toBe(0);
    rmSync(approversOf(harnessDir));
    const synced = await run(["sync"]);
    expect(synced.exitCode).toBe(0);
    expect(synced.lines[0]).toBe("Updated 1 of 1 approver lists; the rest were current.");
    expect(existsSync(approversOf(harnessDir))).toBe(true);
  });
});

describe("access proxy", () => {
  const settingsOf = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(hangarRoot, "settings.json"), "utf8")) as Record<string, unknown>;

  test("with nothing set, says Home trusts no proxy", async () => {
    const out = await run(["proxy"]);
    expect(out.exitCode).toBe(0);
    expect(out.lines.join("\n")).toContain("trusts no reverse proxy");
  });

  test("writes the block, prints the secret once, and stores only its digest", async () => {
    mkdirSync(hangarRoot, { recursive: true });
    writeFileSync(
      join(hangarRoot, "settings.json"),
      JSON.stringify({ readOnly: true, access: { allowedHosts: ["nas.local"] } }),
    );
    const out = await run([
      "proxy",
      "--header",
      "X-Auth-User",
      "--peer",
      "127.0.0.1/32",
      "--host",
      "home.example.test",
    ]);
    expect(out.exitCode).toBe(0);
    const text = out.lines.join("\n");
    const match = /CrewHaus-Proxy-Secret: ([A-Za-z0-9_-]{43})/i.exec(text);
    expect(match).not.toBeNull();
    const secret = match?.[1] as string;
    expect(text.split(secret).length).toBe(2); // printed once
    expect(text).toContain("Restart Home");
    const settings = settingsOf();
    const access = settings["access"] as {
      trustedProxy: Record<string, unknown>;
      allowedHosts: string[];
    };
    expect(access.allowedHosts).toEqual(["nas.local"]);
    expect(settings["readOnly"]).toBe(true);
    expect(access.trustedProxy).toEqual({
      header: "x-auth-user",
      peers: ["127.0.0.1/32"],
      hosts: ["home.example.test"],
      secretDigest: Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
      ).toString("hex"),
    });
    expect(readFileSync(join(hangarRoot, "settings.json"), "utf8")).not.toContain(secret);
    // Reading it back names no digest and no secret.
    const shown = (await run(["proxy"])).lines.join("\n");
    expect(shown).toContain("x-auth-user");
    expect(shown).not.toContain(access.trustedProxy["secretDigest"] as string);
    expect(shown).not.toContain(secret);
  });

  test("--socket stores no secret and points the proxy at Home's proxy socket", async () => {
    if (process.platform === "win32") return;
    const out = await run(["proxy", "--header", "x-auth-user", "--socket"]);
    expect(out.exitCode).toBe(0);
    expect(out.lines.join("\n")).toContain(join(hangarRoot, "proxy.sock"));
    const proxy = (settingsOf()["access"] as { trustedProxy: Record<string, unknown> })
      .trustedProxy;
    expect(proxy["socket"]).toBe(true);
    expect(proxy["secretDigest"]).toBeUndefined();
  });

  test("--off removes the block and keeps the rest", async () => {
    await run(["proxy", "--header", "x-auth-user", "--peer", "10.0.0.0/8"]);
    const out = await run(["proxy", "--off"]);
    expect(out.exitCode).toBe(0);
    expect("access" in settingsOf()).toBe(false);
  });

  test("refuses bad input before writing anything, and another user of this computer", async () => {
    await expect(
      run(["proxy", "--header", "x-auth-user", "--peer", "10.0.0.0/33"]),
    ).rejects.toThrow(/not a CIDR block/);
    await expect(run(["proxy", "--header", "x-auth-user"])).rejects.toThrow(/--peer/);
    await expect(run(["proxy", "--off", "--header", "x"])).rejects.toThrow(/cannot be combined/);
    expect(existsSync(join(hangarRoot, "settings.json"))).toBe(false);
    await run(["members"]);
    expect(
      (await run(["grant", "--member", "Ana", "--create", "--role", "viewer", "--home"])).exitCode,
    ).toBe(0);
    const eve = await run(["proxy", "--header", "x-auth-user", "--peer", "10.0.0.0/8"], OTHER);
    expect(eve.exitCode).toBe(1);
    expect(eve.lines.join(" ")).toContain("belongs to another user");
    expect(existsSync(join(hangarRoot, "settings.json"))).toBe(false);
  });
});

describe("access approve", () => {
  test("allows a waiting sign-in as the local member, and the other computer collects it", async () => {
    const { ensureAccessSetUp, localActorOf, openDeviceRequests } = await import(
      "@crewhaus/access-control"
    );
    // Access set up with this OS user as the owner, as Home's first sign-in does.
    const setUp = await ensureAccessSetUp(hangarRoot, {
      localActor: localActorOf(ME),
      now: () => clock,
    });
    expect(setUp.ok).toBe(true);
    const devices = openDeviceRequests(hangarRoot, { now: () => clock });
    const start = await devices.start({ clientName: "laptop" });
    if (!start.ok) throw new Error(start.reason);
    const allowed = await run(["approve", start.userCode.toLowerCase()]);
    expect(allowed.exitCode).toBe(0);
    expect(allowed.lines.join("\n")).toContain("Allowed a sign-in from laptop");
    clock += 6_000;
    const polled = await devices.poll(start.pollRef);
    expect(polled.ok && polled.state).toBe("allowed");
  });

  test("--deny denies it, and a wrong code is refused in words", async () => {
    const { ensureAccessSetUp, localActorOf, openDeviceRequests } = await import(
      "@crewhaus/access-control"
    );
    const setUp = await ensureAccessSetUp(hangarRoot, {
      localActor: localActorOf(ME),
      now: () => clock,
    });
    expect(setUp.ok).toBe(true);
    const devices = openDeviceRequests(hangarRoot, { now: () => clock });
    const start = await devices.start({});
    if (!start.ok) throw new Error(start.reason);
    const denied = await run(["approve", start.userCode, "--deny"]);
    expect(denied.exitCode).toBe(0);
    expect(denied.lines.join("\n")).toContain("Denied");
    const wrong = await run(["approve", "BBBB-BBBB"]);
    expect(wrong.exitCode).toBe(1);
    expect(wrong.lines.join("\n")).toContain("does not match");
  });
});
