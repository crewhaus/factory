/**
 * Where the space key is kept. Three custodies, never a silent fallback between them:
 *
 * - `keychain`: the OS credential store, through a port shaped like `Bun.secrets`, which
 *   the caller passes. Service `ai.crewhaus.people`, name `<root digest>/<space>/v<n>`.
 * - `environment`: `CREWHAUS_PEOPLE_SPACE_KEY`, 64 hex characters. It cannot store or
 *   destroy a key, so a rotation takes its new key from the caller.
 * - `file`: `keys/<space>.v<n>.kek` beside the vault, refused when other users can read it.
 *
 * Environment and file custody are weaker: anything running as this user can read them.
 */
import { realpathSync } from "node:fs";
import type { VaultCustody } from "@crewhaus/control-contract";
import { KEY_HEX_RE, bytesOf, hexOf, sha256Hex } from "./crypto";
import { readWithMode, removeFile, writeText } from "./files";

/** The part of `Bun.secrets` the vault uses. Tests inject one; the CLI passes `Bun.secrets`. */
export type SecretsPort = {
  get(options: { readonly service: string; readonly name: string }): Promise<string | null>;
  set(options: {
    readonly service: string;
    readonly name: string;
    readonly value: string;
  }): Promise<void>;
  delete(options: { readonly service: string; readonly name: string }): Promise<boolean>;
};

export const KEYCHAIN_SERVICE = "ai.crewhaus.people";
export const SPACE_KEY_ENV = "CREWHAUS_PEOPLE_SPACE_KEY";

export type KeyRead =
  | { readonly state: "present"; readonly key: Uint8Array }
  | { readonly state: "absent"; readonly reason: string }
  | { readonly state: "unreachable"; readonly reason: string };

export type Custodian = {
  readonly kind: VaultCustody;
  get(version: number): Promise<KeyRead>;
  /** Keep this version. Environment custody keeps it for this process only. */
  put(version: number, key: Uint8Array): Promise<void>;
  /** Destroy this version: `kept` when custody cannot (an environment variable). */
  destroy(version: number): Promise<"destroyed" | "absent" | "kept">;
};

export type CustodyContext = {
  readonly root: string;
  readonly space: string;
  readonly secrets?: SecretsPort;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
};

/** The file a version of the space key lives in, under file custody. */
export function keyFileOf(space: string, version: number): string {
  return `keys/${space}.v${version}.kek`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parsed(text: string, where: string): KeyRead {
  const key = KEY_HEX_RE.test(text) ? bytesOf(text) : undefined;
  return key === undefined
    ? { state: "unreachable", reason: `${where} is not 64 hex characters.` }
    : { state: "present", key };
}

/** First 16 hex of sha256 of the vault root's real path: two vaults never share a name. */
async function rootDigest(root: string): Promise<string> {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // Not created yet: its resolved name stands in.
  }
  return (await sha256Hex(real)).slice(0, 16);
}

function keychain(ctx: CustodyContext): Custodian {
  const nameOf = async (version: number) =>
    `${await rootDigest(ctx.root)}/${ctx.space}/v${version}`;
  const store = (): SecretsPort => {
    if (ctx.secrets === undefined) {
      throw new Error("this computer's credential store can't be reached from here");
    }
    return ctx.secrets;
  };
  return {
    kind: "keychain",
    async get(version) {
      let value: string | null;
      try {
        value = await store().get({ service: KEYCHAIN_SERVICE, name: await nameOf(version) });
      } catch (err) {
        return {
          state: "unreachable",
          reason: `The credential store could not be read: ${message(err)}.`,
        };
      }
      if (value === null) {
        return {
          state: "absent",
          reason: "The profile key is not in this computer's credential store.",
        };
      }
      return parsed(value, "The key in the credential store");
    },
    async put(version, key) {
      await store().set({
        service: KEYCHAIN_SERVICE,
        name: await nameOf(version),
        value: hexOf(key),
      });
    },
    async destroy(version) {
      const gone = await store().delete({
        service: KEYCHAIN_SERVICE,
        name: await nameOf(version),
      });
      return gone ? "destroyed" : "absent";
    },
  };
}

function environment(ctx: CustodyContext): Custodian {
  // A key a rotation was handed, for the rest of this process: the variable still holds
  // the old one until the person replaces it.
  const handed = new Map<number, Uint8Array>();
  return {
    kind: "environment",
    async get(version) {
      const given = handed.get(version);
      if (given !== undefined) return { state: "present", key: given };
      const value = ctx.env[SPACE_KEY_ENV];
      if (value === undefined || value === "") {
        return { state: "unreachable", reason: `${SPACE_KEY_ENV} is not set.` };
      }
      return parsed(value.trim(), SPACE_KEY_ENV);
    },
    async put(version, key) {
      handed.set(version, key);
    },
    async destroy() {
      return "kept";
    },
  };
}

function file(ctx: CustodyContext): Custodian {
  return {
    kind: "file",
    async get(version) {
      const rel = keyFileOf(ctx.space, version);
      let read: ReturnType<typeof readWithMode>;
      try {
        read = readWithMode(ctx.root, rel, 65);
      } catch (err) {
        return { state: "unreachable", reason: `${rel} cannot be read: ${message(err)}.` };
      }
      if (read.state === "absent") {
        return { state: "absent", reason: `The key file ${rel} is missing.` };
      }
      if (ctx.platform !== "win32" && (read.mode & 0o077) !== 0) {
        return {
          state: "unreachable",
          reason: `The key file ${rel} can be read by other users. Run \`chmod 600\` on it.`,
        };
      }
      if (!read.text.endsWith("\n")) {
        return { state: "unreachable", reason: `${rel} is not 64 hex characters.` };
      }
      return parsed(read.text.slice(0, -1), rel);
    },
    async put(version, key) {
      writeText(ctx.root, keyFileOf(ctx.space, version), `${hexOf(key)}\n`, false);
    },
    async destroy(version) {
      const rel = keyFileOf(ctx.space, version);
      const before = readWithMode(ctx.root, rel, 65);
      if (before.state === "absent") return "absent";
      removeFile(ctx.root, rel);
      return "destroyed";
    },
  };
}

export function custodianFor(kind: VaultCustody, ctx: CustodyContext): Custodian {
  switch (kind) {
    case "keychain":
      return keychain(ctx);
    case "environment":
      return environment(ctx);
    case "file":
      return file(ctx);
  }
}

/** Whether the credential store answers at all. Reads one name; writes nothing. */
export async function probeKeychain(secrets: SecretsPort | undefined): Promise<boolean> {
  if (secrets === undefined) return false;
  try {
    await secrets.get({ service: KEYCHAIN_SERVICE, name: "probe" });
    return true;
  } catch {
    return false;
  }
}
