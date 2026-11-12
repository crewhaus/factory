/**
 * Custody: each place the space key can be kept, and each way it cannot be reached. A
 * key that cannot be reached is `locked` with the reason, never "no profiles".
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KEYCHAIN_SERVICE, keyFileOf, probeKeychain } from "./custody";
import { VaultError } from "./files";
import { OWNER, fakeSecrets, mustOpen, removeTempDirs, tempDir } from "./test-helpers";

afterAll(removeTempDirs);

const KEY = "ab".repeat(32);

function freshRoot(): { base: string; root: string } {
  const base = tempDir();
  return { base, root: join(base, "hangar", "people") };
}

async function refusal(run: () => Promise<unknown>): Promise<VaultError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof VaultError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("keychain", () => {
  test("present: set up stores the key under the service and opens with it", async () => {
    const { root } = freshRoot();
    const secrets = fakeSecrets();
    const vault = mustOpen({ root, secrets });
    expect(await vault.probeKeychain()).toBe(true);
    const made = await vault.setUp({ custody: "keychain", owner: OWNER });
    expect(made.status.state).toBe("ready");
    const names = [...secrets.items.keys()];
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(
      new RegExp(`^${KEYCHAIN_SERVICE.replace(/\./g, "\\.")}\\|[0-9a-f]{16}/spc_[0-9a-z]{26}/v1$`),
    );
    expect(secrets.items.get(names[0] as string)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("throwing: the probe says no, and a ready vault reads as locked with the reason", async () => {
    const { root } = freshRoot();
    const secrets = fakeSecrets();
    const vault = mustOpen({ root, secrets });
    await vault.setUp({ custody: "keychain", owner: OWNER });
    secrets.throwing = true;
    expect(await vault.probeKeychain()).toBe(false);
    const status = await mustOpen({ root, secrets }).status();
    expect(status).toEqual(
      expect.objectContaining({
        state: "locked",
        reason: "The credential store could not be read: no secret service.",
      }),
    );
  });

  test("absent: an item that is gone reads as locked, and no port refuses set up", async () => {
    const { root } = freshRoot();
    const secrets = fakeSecrets();
    await mustOpen({ root, secrets }).setUp({ custody: "keychain", owner: OWNER });
    secrets.items.clear();
    expect(await mustOpen({ root, secrets }).status()).toEqual(
      expect.objectContaining({
        state: "locked",
        reason: "The profile key is not in this computer's credential store.",
      }),
    );
    const other = freshRoot();
    const noPort = mustOpen({ root: other.root });
    expect(await noPort.probeKeychain()).toBe(false);
    const err = await refusal(() => noPort.setUp({ custody: "keychain", owner: OWNER }));
    expect(err.message).toBe("This computer's credential store can't be reached from here.");
    expect(existsSync(other.root)).toBe(false);
  });
});

describe("environment", () => {
  test("valid: the variable's key opens the vault", async () => {
    const { root } = freshRoot();
    const env = { CREWHAUS_PEOPLE_SPACE_KEY: KEY };
    await mustOpen({ root, env }).setUp({ custody: "environment", owner: OWNER });
    expect((await mustOpen({ root, env }).status()).state).toBe("ready");
  });

  test("malformed and missing are refused at set up, creating nothing", async () => {
    for (const [env, reason] of [
      [{ CREWHAUS_PEOPLE_SPACE_KEY: "xyz" }, "CREWHAUS_PEOPLE_SPACE_KEY is not 64 hex characters."],
      [{}, "CREWHAUS_PEOPLE_SPACE_KEY is not set."],
    ] as const) {
      const { base, root } = freshRoot();
      const err = await refusal(() =>
        mustOpen({ root, env }).setUp({ custody: "environment", owner: OWNER }),
      );
      expect(err.code).toBe("locked");
      expect(err.message.startsWith(reason)).toBe(true);
      expect(readdirSync(base)).toEqual([]);
    }
  });

  test("malformed, missing or another key later reads as locked with the reason", async () => {
    const { root } = freshRoot();
    await mustOpen({ root, env: { CREWHAUS_PEOPLE_SPACE_KEY: KEY } }).setUp({
      custody: "environment",
      owner: OWNER,
    });
    const cases: [Record<string, string>, string][] = [
      [
        { CREWHAUS_PEOPLE_SPACE_KEY: "nothex" },
        "CREWHAUS_PEOPLE_SPACE_KEY is not 64 hex characters.",
      ],
      [{}, "CREWHAUS_PEOPLE_SPACE_KEY is not set."],
      [
        { CREWHAUS_PEOPLE_SPACE_KEY: "cd".repeat(32) },
        "The key in CREWHAUS_PEOPLE_SPACE_KEY does not open these profiles.",
      ],
    ];
    for (const [env, reason] of cases) {
      expect(await mustOpen({ root, env }).status()).toEqual(
        expect.objectContaining({ state: "locked", reason }),
      );
    }
  });
});

describe("file", () => {
  test("a key file at 0600 opens", async () => {
    const { root } = freshRoot();
    const vault = mustOpen({ root });
    const made = await vault.setUp({ custody: "file", owner: OWNER });
    expect(made.status.state).toBe("ready");
    expect((await mustOpen({ root }).status()).state).toBe("ready");
  });

  test.skipIf(process.platform === "win32")(
    "a key file at 0640 or 0604 is refused, naming the fix",
    async () => {
      const { root } = freshRoot();
      const made = await mustOpen({ root }).setUp({ custody: "file", owner: OWNER });
      const space = made.status.state === "ready" ? made.status.space : "";
      const rel = keyFileOf(space, 1);
      for (const mode of [0o640, 0o604]) {
        chmodSync(join(root, rel), mode);
        expect(await mustOpen({ root }).status()).toEqual(
          expect.objectContaining({
            state: "locked",
            reason: `The key file ${rel} can be read by other users. Run \`chmod 600\` on it.`,
          }),
        );
      }
      chmodSync(join(root, rel), 0o600);
      expect((await mustOpen({ root }).status()).state).toBe("ready");
    },
  );
});

test("no custody named and none chosen: set up refuses and names the three choices", async () => {
  const { base, root } = freshRoot();
  const err = await refusal(() =>
    mustOpen({ root, secrets: fakeSecrets() }).setUp({ owner: OWNER }),
  );
  expect(err.message).toBe("Choose where the profile key is kept: keychain, environment or file.");
  expect(readdirSync(base)).toEqual([]);
  expect(await probeKeychain(undefined)).toBe(false);
});

test("set up twice leaves the first vault as it is", async () => {
  const { root } = freshRoot();
  const secrets = fakeSecrets();
  const first = await mustOpen({ root, secrets }).setUp({ custody: "keychain", owner: OWNER });
  const again = await mustOpen({ root, secrets }).setUp({ custody: "file", owner: OWNER });
  expect(again.created).toBe(false);
  expect(again.status).toEqual(first.status);
  expect(secrets.items.size).toBe(1);
});
