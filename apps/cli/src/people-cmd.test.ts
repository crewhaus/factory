/**
 * `crewhaus people` through `runPeopleCommand`, against temporary roots, an injected
 * identity, an injected credential store and lines given in place of stdin. Nothing
 * reaches the real `~/.crewhaus` or the real credential store.
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
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretsPort } from "@crewhaus/people/vault";
import { type PeopleCommandResult, runPeopleCommand } from "./people-cmd";

let base: string;
let hangarRoot: string;
let env: Record<string, string | undefined>;
let clock: number;
let secrets: SecretsPort & { items: Map<string, string> };
let prompts: string[];

const T0 = Date.parse("2026-11-12T09:00:00.000Z");
const ME = { username: "sam", hostname: "laptop" };
const OTHER = { username: "eve", hostname: "laptop" };

function memorySecrets(): SecretsPort & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    async get({ service, name }) {
      return items.get(`${service}|${name}`) ?? null;
    },
    async set({ service, name, value }) {
      items.set(`${service}|${name}`, value);
    },
    async delete({ service, name }) {
      return items.delete(`${service}|${name}`);
    },
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-people-cmd-")));
  hangarRoot = join(base, "hangar");
  env = {
    HOME: join(base, "home"),
    CREWHAUS_HANGAR_ROOT: hangarRoot,
    CREWHAUS_REGISTRY_ROOT: join(base, "registry"),
    CREWHAUS_WATCHME_ROOT: join(base, "watchme"),
  };
  clock = T0;
  secrets = memorySecrets();
  prompts = [];
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function run(
  argv: readonly string[],
  input: readonly string[] = [],
  identity = ME,
): Promise<PeopleCommandResult> {
  const lines = [...input];
  return runPeopleCommand(argv, {
    env,
    now: () => clock,
    identity,
    secrets,
    isTTY: false,
    stdin: async () => lines.shift(),
    prompt: (text) => prompts.push(text),
    openRegistry: () => ({ list: () => [] }) as never,
  });
}

async function setUp(): Promise<void> {
  const out = await run(["init"]);
  expect(out.exitCode).toBe(0);
}

async function addMe(): Promise<string> {
  const out = await run(["add", "--kind", "personal"], ["Sam"]);
  expect(out.exitCode).toBe(0);
  const psn = /psn_[0-9a-z]{26}/.exec(out.lines[0] ?? "")?.[0];
  if (psn === undefined) throw new Error(out.lines.join("\n"));
  return psn;
}

describe("help and unknown verbs", () => {
  test("bare, --help and a sub-verb's --help print the same usage and touch nothing", async () => {
    const bare = await run([]);
    expect(bare.exitCode).toBe(0);
    expect(bare.lines[0]).toBe("usage:");
    for (const argv of [["--help"], ["-h"], ["note", "--help"], ["erase", "-h"]]) {
      expect((await run(argv)).lines).toEqual(bare.lines);
    }
    expect(readdirSync(base)).toEqual([]);
  });

  test("an unknown verb lists the family's verbs, in order", async () => {
    await expect(run(["grant"])).rejects.toThrow(
      "(expected: init | keys | list | add | show | set | note | edit | review | export | activity | erase)",
    );
  });
});

describe("reads on a fresh Hangar root", () => {
  test("each read answers not set up and leaves the root empty", async () => {
    for (const argv of [
      ["keys"],
      ["list"],
      ["show", "psn_01jc0000000000000000000000"],
      ["activity", "psn_01jc0000000000000000000000"],
      ["export", "psn_01jc0000000000000000000000", "--dry-run"],
      ["erase", "psn_01jc0000000000000000000000", "--dry-run"],
      ["review", "psn_01jc0000000000000000000000"],
    ]) {
      const out = await run(argv);
      expect(`${argv[0]}: ${out.lines[0]}`).toBe(
        `${argv[0]}: Profiles aren't set up on this computer yet.`,
      );
      expect(out.exitCode).toBe(0);
    }
    expect(existsSync(hangarRoot)).toBe(false);
    expect(readdirSync(base)).toEqual([]);
  });

  test("a write on a fresh root says so too, and creates nothing", async () => {
    const out = await run(["add", "--kind", "personal"], ["Sam"]);
    expect(out).toEqual({
      lines: ["Profiles aren't set up on this computer yet.", "Set them up: crewhaus people init"],
      exitCode: 1,
    });
    expect(existsSync(hangarRoot)).toBe(false);
  });
});

describe("init and keys", () => {
  test("init uses the credential store when it answers, and keys says where the key is, never the key", async () => {
    await setUp();
    expect(secrets.items.size).toBe(1);
    const key = [...secrets.items.values()][0] as string;
    const keys = await run(["keys"]);
    expect(keys.lines[0]).toBe(
      "The profile key is kept in this computer's credential store (version 1).",
    );
    const json = await run(["keys", "--json"]);
    expect(JSON.parse(json.lines.join("\n"))).toEqual({
      state: "ready",
      custody: "keychain",
      kekVersion: 1,
    });
    expect(JSON.stringify([keys, json]).includes(key)).toBe(false);
    expect((await run(["init"])).lines[0]).toContain("Profiles are already set up.");
  });

  test("init with no store and no --custody refuses, names the three choices, and creates nothing", async () => {
    secrets.get = async () => {
      throw new Error("no secret service");
    };
    const out = await run(["init"]);
    expect(out.exitCode).toBe(1);
    for (const custody of ["keychain", "environment", "file"]) {
      expect(out.lines.some((line) => line.includes(`--custody ${custody}`))).toBe(true);
    }
    expect(existsSync(hangarRoot)).toBe(false);
  });

  test("environment custody says it is weaker, and rotating reads the new key from stdin", async () => {
    env["CREWHAUS_PEOPLE_SPACE_KEY"] = "ab".repeat(32);
    const init = await run(["init", "--custody", "environment"]);
    expect(init.lines[0]).toBe(
      "Profiles are set up. Their key is kept in CREWHAUS_PEOPLE_SPACE_KEY.",
    );
    expect(init.lines[1]).toContain("the credential store is safer");
    const none = await run(["keys", "--rotate"]);
    expect(none.exitCode).toBe(1);
    const rotated = await run(["keys", "--rotate"], ["cd".repeat(32)]);
    expect(rotated.lines).toEqual([
      "Replaced the profile key (now version 2).",
      "Put the new key in CREWHAUS_PEOPLE_SPACE_KEY before your next `crewhaus people` command.",
    ]);
    expect((await run(["list"])).exitCode).toBe(1);
    env["CREWHAUS_PEOPLE_SPACE_KEY"] = "cd".repeat(32);
    expect((await run(["list"])).lines[0]).toBe("No profiles yet.");
  });

  test("--backup-days dates the backups an erasure cannot reach", async () => {
    await setUp();
    expect((await run(["init", "--backup-days", "30"])).lines[0]).toBe(
      "Backups are now taken to keep files for 30 days.",
    );
    const psn = await addMe();
    const plan = await run(["erase", psn, "--dry-run"]);
    expect(plan.lines).toContain("  backups made before today, until 2026-12-12");
  });
});

describe("profiles and notes", () => {
  test("add, note, show, edit, review and list work from typed lines", async () => {
    await setUp();
    expect((await run(["list"])).lines).toEqual([
      "No profiles yet.",
      "Start with one about you: crewhaus people add --kind personal",
    ]);
    const psn = await addMe();
    const note = await run(
      ["note", psn, "--area", "communication"],
      ["Prefers short updates.", "on weekdays"],
    );
    expect(note.exitCode).toBe(0);
    const pcl = /pcl_[0-9a-z]{26}/.exec(note.lines[0] ?? "")?.[0] as string;
    const health = await run(
      ["note", psn, "--area", "health", "--type", "health"],
      ["Gets migraines.", ""],
    );
    expect(health.lines[1]).toBe("It's sensitive, so it waits in review until you keep it:");
    const show = await run(["show", psn]);
    expect(show.lines[0]).toBe(`Sam · Personal · ${psn}`);
    expect(show.lines).toContain(
      `  [communication] Prefers short updates. (when on weekdays)  ${pcl}`,
    );
    expect(show.lines).toContain("What needs review");
    expect(show.lines.at(-1)).toBe("  No harness uses this profile yet.");
    const edited = await run(["edit", pcl], ["Prefers very short updates.", ""]);
    expect(edited.lines).toEqual(["Updated the note (revision 2)."]);
    const stale = await run(["edit", pcl, "--expect", "1"], ["x", ""]);
    expect(stale.exitCode).toBe(1);
    expect(stale.lines[0]).toBe("This note changed since you opened it. It now says:");
    expect(stale.lines[1]).toContain("Prefers very short updates. (when on weekdays)");
    const unknown = await run(["edit", "pcl_01jc0000000000000000000000"], ["never asked"]);
    expect(unknown).toEqual({ lines: ["No profile or note with that id."], exitCode: 1 });
    const tray = await run(["review", psn]);
    expect(tray.lines[0]).toContain("[health] Gets migraines.");
    const healthId = /pcl_[0-9a-z]{26}/.exec(tray.lines[0] ?? "")?.[0] as string;
    expect((await run(["review", healthId, "--as", "keep"])).lines).toEqual([
      "Kept. The note now counts.",
    ]);
    expect((await run(["review", psn])).lines).toEqual(["Nothing to review."]);
    expect((await run(["list"])).lines).toEqual([`Sam · Personal · ${psn}`]);
  });

  test("a note's words or a name never come from a flag or an extra argument", async () => {
    await setUp();
    const psn = await addMe();
    await expect(run(["note", psn, "--area", "comm", "--value", "x"])).rejects.toThrow(
      'people note: unknown flag "--value"',
    );
    await expect(run(["note", psn, "Prefers email", "--area", "comm"])).rejects.toThrow(
      'people note: unexpected argument "Prefers email"',
    );
    await expect(run(["add", "--kind", "personal", "Sam"])).rejects.toThrow(
      'people add: unexpected argument "Sam"',
    );
    await expect(run(["add", "--kind", "personal", "--name", "Sam"])).rejects.toThrow(
      'people add: unknown flag "--name"',
    );
    await expect(run(["note", psn, "--area", "comm"], [])).rejects.toThrow(
      "people note: a note's words are typed or piped in",
    );
    const show = await run(["show", psn, "--json"]);
    expect(JSON.parse(show.lines.join("\n")).notes).toEqual([]);
  });

  test("the value from stdin is the value stored", async () => {
    await setUp();
    const psn = await addMe();
    await run(
      ["note", psn, "--area", "comm", "--purpose", "drafting"],
      ["  Writes in British English.  ", ""],
    );
    const json = JSON.parse((await run(["show", psn, "--json"])).lines.join("\n")) as {
      notes: { value: string; purposes: string[]; situation?: string }[];
    };
    expect(json.notes).toEqual([
      expect.objectContaining({ value: "Writes in British English.", purposes: ["drafting"] }),
    ]);
    expect(json.notes[0]?.situation).toBeUndefined();
  });

  test("another user of this computer is refused, for reads and for changes", async () => {
    await setUp();
    const psn = await addMe();
    for (const argv of [["list"], ["show", psn]]) {
      expect(await run(argv, [], OTHER)).toEqual({
        lines: ["This Home belongs to another user on this computer."],
        exitCode: 1,
      });
    }
    expect(await run(["note", psn, "--area", "comm"], ["x"], OTHER)).toEqual({
      lines: ["This Home belongs to another user on this computer."],
      exitCode: 1,
    });
  });

  test("set changes off-limits areas and the name, which is typed in", async () => {
    await setUp();
    const psn = await addMe();
    expect(
      (await run(["set", psn, "--off-limits", "family", "--rename"], ["Samuel"])).lines,
    ).toEqual(["Updated Samuel."]);
    const show = await run(["show", psn]);
    expect(show.lines[0]).toBe(`Samuel · Personal · ${psn}`);
    expect(show.lines).toContain("Off-limits: family");
    const refused = await run(["note", psn, "--area", "family"], ["Has a sister.", ""]);
    expect(refused).toEqual({
      lines: ["The area family is off-limits on this profile."],
      exitCode: 1,
    });
  });
});

describe("export and erase", () => {
  test("export writes the file it previewed, and says it can't be recalled first", async () => {
    await setUp();
    const psn = await addMe();
    await run(["note", psn, "--area", "comm"], ["Short updates.", ""]);
    const preview = await run(["export", psn, "--dry-run"]);
    const sha = preview.lines.find((l) => l.startsWith("Fingerprint"))?.split(": ")[1];
    expect(prompts).toEqual([]);
    const out = join(base, "sam.json");
    const done = await run(["export", psn, "--out", out]);
    expect(prompts[0]).toContain("A downloaded file can't be recalled.");
    expect(done.lines).toEqual([`Wrote 1 note to ${out}.`, `Fingerprint (sha256): ${sha}`]);
    expect(JSON.parse(readFileSync(out, "utf8")).format).toBe("crewhaus.people.v1");
    const again = await run(["export", psn, "--out", out]);
    expect(again.lines[0]).toBe(`${out} already exists. Add --force to replace it.`);
    const stdout = await run(["export", psn]);
    expect(JSON.parse(stdout.lines.join("\n")).notes).toHaveLength(1);
    const activity = await run(["activity", psn]);
    expect(activity.lines[0]).toBe("2026-11-12 09:00  exported 1 note, by you");
  });

  test("erase without the typed name, or with a wrong one, writes nothing; with it, the profile is gone", async () => {
    await setUp();
    const psn = await addMe();
    const ledger = join(hangarRoot, "control", "commands");
    const count = () => readdirSync(ledger).length;
    const files = () => readdirSync(join(hangarRoot, "people"), { recursive: true }).length;
    const before = [count(), files()];
    expect(await run(["erase", psn], [])).toEqual({ lines: ["Nothing was erased."], exitCode: 1 });
    expect(await run(["erase", psn], ["Samuel"])).toEqual({
      lines: ["That isn't the profile's name. Nothing was erased."],
      exitCode: 1,
    });
    expect([count(), files()]).toEqual(before);
    expect(prompts.join("")).toContain("These stay, and CrewHaus can't remove them:");
    const erased = await run(["erase", psn], ["Sam"]);
    expect(erased.lines).toEqual([
      "Erased. A record that an erasure happened is kept; it contains nothing from the profile.",
    ]);
    expect((await run(["show", psn])).lines).toEqual(["No profile or note with that id."]);
    expect((await run(["keys"])).lines[0]).toContain("(version 2)");
  });
});

test("the vault is refused inside a git work tree, naming the fix", async () => {
  mkdirSync(join(base, ".git"));
  const out = await run(["init"]);
  expect(out.exitCode).toBe(1);
  expect(out.lines[0]).toContain("Set CREWHAUS_HANGAR_ROOT to a directory outside it.");
  expect(existsSync(hangarRoot)).toBe(false);
});
