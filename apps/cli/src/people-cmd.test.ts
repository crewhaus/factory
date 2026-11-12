/**
 * `crewhaus people` through `runPeopleCommand`, against temporary roots, an injected
 * identity, an injected credential store and lines given in place of stdin. Nothing
 * reaches the real `~/.crewhaus` or the real credential store.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAVED_KEY_ROTATION } from "@crewhaus/people-service";
import type { SecretsPort } from "@crewhaus/people/vault";
import { type PeopleCommandResult, isRegularFileFd, runPeopleCommand } from "./people-cmd";

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

type Stdin = {
  readonly isTTY?: boolean;
  readonly stdinIsFile?: boolean;
  readonly hideInput?: () => (() => void) | undefined;
};

function run(
  argv: readonly string[],
  input: readonly string[] = [],
  identity = ME,
  stdin: Stdin = {},
): Promise<PeopleCommandResult> {
  const lines = [...input];
  return runPeopleCommand(argv, {
    env,
    now: () => clock,
    identity,
    secrets,
    isTTY: stdin.isTTY ?? false,
    stdinIsFile: stdin.stdinIsFile ?? false,
    ...(stdin.hideInput !== undefined ? { hideInput: stdin.hideInput } : {}),
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

  test("environment custody says it is weaker, and a key piped in is refused with nothing changed", async () => {
    env["CREWHAUS_PEOPLE_SPACE_KEY"] = "ab".repeat(32);
    const init = await run(["init", "--custody", "environment"]);
    expect(init.lines[0]).toBe(
      "Profiles are set up. Their key is kept in CREWHAUS_PEOPLE_SPACE_KEY.",
    );
    expect(init.lines[1]).toContain("the credential store is safer");
    await addMe();
    const none = await run(["keys", "--rotate"], [], ME, { stdinIsFile: true });
    expect(none.exitCode).toBe(1);
    const piped = await run(["keys", "--rotate"], ["cd".repeat(32)]);
    expect(piped.exitCode).toBe(1);
    expect(piped.lines[0]).toContain("never a pipe");
    expect(piped.lines).toContain(`  ${SAVED_KEY_ROTATION}`);
    // Refused before anything was re-wrapped: the key the person holds still opens.
    expect((await run(["list"])).lines[0]).toContain("Sam");
    expect((await run(["keys"])).lines[0]).toContain("(version 1)");
  });

  test("rotated the way it says, the profiles open with the key saved in new.key", async () => {
    env["CREWHAUS_PEOPLE_SPACE_KEY"] = "ab".repeat(32);
    await run(["init", "--custody", "environment"]);
    await addMe();
    // openssl rand -hex 32 > new.key && crewhaus people keys --rotate < new.key
    const saved = join(base, "new.key");
    writeFileSync(saved, `${randomBytes(32).toString("hex")}\n`);
    const fromFile = readFileSync(saved, "utf8").split("\n");
    const rotated = await run(["keys", "--rotate"], fromFile, ME, { stdinIsFile: true });
    expect(rotated.exitCode).toBe(0);
    expect(rotated.lines).toEqual([
      "Replaced the profile key (now version 2).",
      "Set CREWHAUS_PEOPLE_SPACE_KEY to the new key before your next `crewhaus people` command. The old key no longer opens your profiles.",
    ]);
    expect((await run(["list"])).exitCode).toBe(1);
    // Then set CREWHAUS_PEOPLE_SPACE_KEY to the key in new.key.
    env["CREWHAUS_PEOPLE_SPACE_KEY"] = readFileSync(saved, "utf8").trim();
    const listed = await run(["list"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.lines[0]).toContain("Sam");
  });

  test("typed at a terminal, the new key is hidden and asked for twice", async () => {
    env["CREWHAUS_PEOPLE_SPACE_KEY"] = "ab".repeat(32);
    await run(["init", "--custody", "environment"]);
    const echo: string[] = [];
    const hideInput = () => {
      echo.push("off");
      return () => void echo.push("on");
    };
    const tty = { isTTY: true, hideInput };
    const mismatch = await run(["keys", "--rotate"], ["cd".repeat(32), "ce".repeat(32)], ME, tty);
    expect(mismatch.exitCode).toBe(1);
    expect(mismatch.lines).toEqual(["Nothing was rotated: the two keys you typed don't match."]);
    expect(echo).toEqual(["off", "on"]);
    expect(prompts.some((p) => p.includes("not shown"))).toBe(true);
    expect((await run(["keys"])).lines[0]).toContain("(version 1)");
    const cannotHide = await run(["keys", "--rotate"], ["cd".repeat(32)], ME, {
      isTTY: true,
      hideInput: () => undefined,
    });
    expect(cannotHide.exitCode).toBe(1);
    expect(cannotHide.lines[0]).toContain("can't hide a typed key");
    const typed = await run(["keys", "--rotate"], ["cd".repeat(32), "cd".repeat(32)], ME, tty);
    expect(typed.exitCode).toBe(0);
    expect(echo).toEqual(["off", "on", "off", "on"]);
    env["CREWHAUS_PEOPLE_SPACE_KEY"] = "cd".repeat(32);
    expect((await run(["list"])).lines[0]).toBe("No profiles yet.");
  });

  test("no guidance pipes a generated key straight into --rotate", async () => {
    env["CREWHAUS_PEOPLE_SPACE_KEY"] = "ab".repeat(32);
    await run(["init", "--custody", "environment"]);
    const psn = await addMe();
    const shown = [
      ...(await run(["keys"])).lines,
      ...(await run(["keys", "--rotate"], ["cd".repeat(32)])).lines,
      ...(await run(["keys", "--rotate"], [], ME, { stdinIsFile: true })).lines,
      ...(await run(["erase", psn, "--dry-run"])).lines,
    ];
    const mentions = shown.filter((line) => line.includes("keys --rotate"));
    expect(mentions).toHaveLength(4);
    for (const line of mentions) {
      expect(line).toContain("> new.key");
      expect(line).toContain("--rotate < new.key");
      expect(line).not.toMatch(/\|\s*crewhaus people keys --rotate/);
    }
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

describe("where stdin comes from", () => {
  test("a file redirected in is a regular file; a device is not", () => {
    const file = join(base, "new.key");
    writeFileSync(file, "x\n");
    const fd = openSync(file, "r");
    try {
      expect(isRegularFileFd(fd)).toBe(true);
    } finally {
      closeSync(fd);
    }
    const dev = openSync(process.platform === "win32" ? "NUL" : "/dev/null", "r");
    try {
      expect(isRegularFileFd(dev)).toBe(false);
    } finally {
      closeSync(dev);
    }
  });

  test("a descriptor that cannot be read says so, not no", () => {
    expect(isRegularFileFd(987_654)).toBeUndefined();
  });
});
