/**
 * The personal tokens `crewhaus login` keeps, one per Home it signed in to, and the way
 * `crewhaus api` reaches a Home: its own socket or loopback on this computer, or a
 * remote Home by its address with the token kept for it.
 *
 * A token is kept in the operating system's keychain (`Bun.secrets`, service `crewhaus`,
 * named by the Home's origin) or, where there is none, in a `0600` file under
 * `<hangarRoot>/remotes/`. The index of origins holds no secret. No flag ever takes a
 * token. The keychain is injected in tests, so no test touches a real one.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_SOCKET, TOKEN_FILENAME } from "@crewhaus/access-control";
import { loopbackBase, readHangarLock } from "./hangar-cmd";

/** One kept sign-in: the token, the credential it is recorded as, and when it ends. */
export type RemoteToken = {
  readonly origin: string;
  readonly token: string;
  readonly credentialRef?: string;
  readonly expiresAt?: string;
};

/** Where secrets are kept: the keychain, or something that stands in for it. */
export type SecretsStore = {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
};

const SERVICE = "crewhaus";

/** The operating system's keychain, when this runtime has one. */
export function keychain(): SecretsStore | undefined {
  const secrets = (Bun as unknown as { secrets?: unknown }).secrets as
    | {
        get(o: { service: string; name: string }): Promise<string | null>;
        set(o: { service: string; name: string; value: string }): Promise<void>;
        delete(o: { service: string; name: string }): Promise<boolean>;
      }
    | undefined;
  if (secrets === undefined) return undefined;
  return {
    get: (name) => secrets.get({ service: SERVICE, name }),
    set: (name, value) => secrets.set({ service: SERVICE, name, value }),
    delete: (name) => secrets.delete({ service: SERVICE, name }),
  };
}

/** A `0600` file per origin under `<hangarRoot>/remotes/`: the keychain's stand-in. */
export function fileSecrets(hangarRoot: string): SecretsStore {
  const dir = join(hangarRoot, "remotes");
  const fileOf = (name: string) =>
    join(dir, `${createHash("sha256").update(name).digest("hex").slice(0, 32)}.token`);
  return {
    async get(name) {
      try {
        return readFileSync(fileOf(name), "utf8");
      } catch {
        return null;
      }
    },
    async set(name, value) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(fileOf(name), value, { mode: 0o600 });
      chmodSync(fileOf(name), 0o600);
    },
    async delete(name) {
      const file = fileOf(name);
      if (!existsSync(file)) return false;
      rmSync(file, { force: true });
      return true;
    },
  };
}

export type RemoteStore = {
  read(origin: string): Promise<RemoteToken | undefined>;
  write(token: RemoteToken): Promise<void>;
  remove(origin: string): Promise<void>;
  /** The origins signed in to, from the index: no secret in it. */
  origins(): readonly string[];
};

/** The kept tokens of one Hangar root. */
export function remoteStore(hangarRoot: string, secrets?: SecretsStore): RemoteStore {
  const store = secrets ?? keychainOrFile(hangarRoot);
  const indexFile = join(hangarRoot, "remotes", "index.json");
  const readIndex = (): string[] => {
    try {
      const parsed = JSON.parse(readFileSync(indexFile, "utf8")) as { origins?: unknown };
      return Array.isArray(parsed.origins)
        ? parsed.origins.filter((o): o is string => typeof o === "string")
        : [];
    } catch {
      return [];
    }
  };
  const writeIndex = (origins: readonly string[]): void => {
    mkdirSync(join(hangarRoot, "remotes"), { recursive: true, mode: 0o700 });
    writeFileSync(
      indexFile,
      `${JSON.stringify({ v: 1, origins: [...new Set(origins)].sort() })}\n`,
      {
        mode: 0o600,
      },
    );
  };
  return {
    async read(origin) {
      const raw = await store.get(origin);
      if (raw === null) return undefined;
      try {
        const parsed = JSON.parse(raw) as Partial<RemoteToken>;
        return typeof parsed.token === "string"
          ? {
              origin,
              token: parsed.token,
              ...(typeof parsed.credentialRef === "string"
                ? { credentialRef: parsed.credentialRef }
                : {}),
              ...(typeof parsed.expiresAt === "string" ? { expiresAt: parsed.expiresAt } : {}),
            }
          : undefined;
      } catch {
        return undefined;
      }
    },
    async write(token) {
      await store.set(
        token.origin,
        JSON.stringify({
          token: token.token,
          ...(token.credentialRef !== undefined ? { credentialRef: token.credentialRef } : {}),
          ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
        }),
      );
      writeIndex([...readIndex(), token.origin]);
    },
    async remove(origin) {
      await store.delete(origin);
      writeIndex(readIndex().filter((o) => o !== origin));
    },
    origins: readIndex,
  };
}

function keychainOrFile(hangarRoot: string): SecretsStore {
  const chain = keychain();
  if (chain === undefined) return fileSecrets(hangarRoot);
  const file = fileSecrets(hangarRoot);
  // A keychain that refuses (no session, a locked store) falls back to the file.
  return {
    get: async (name) => {
      try {
        return (await chain.get(name)) ?? (await file.get(name));
      } catch {
        return file.get(name);
      }
    },
    set: async (name, value) => {
      try {
        await chain.set(name, value);
      } catch {
        await file.set(name, value);
      }
    },
    delete: async (name) => {
      let removed = false;
      try {
        removed = await chain.delete(name);
      } catch {
        removed = false;
      }
      return (await file.delete(name)) || removed;
    },
  };
}

/** A Home's origin from what a person typed, or the reason it is not one. */
export function originOf(
  server: string,
): { readonly origin: string } | { readonly reason: string } {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return { reason: `"${server}" is not an address, like https://home.example.com` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { reason: `${url.protocol} is not http or https` };
  }
  return { origin: url.origin };
}

/** Whether an address is this computer. */
export function isLoopbackOrigin(origin: string): boolean {
  const host = new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

export type Transport = {
  readonly baseUrl: string;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly token?: string;
};

/**
 * This computer's Home: its own socket when it is there, loopback otherwise, with Home's
 * own key. `undefined` when Home is not running here or its key cannot be read.
 */
export function localTransport(
  hangarRoot: string,
  fetchImpl: typeof fetch = fetch,
): Transport | { readonly reason: string } {
  let token: string;
  try {
    token = readFileSync(join(hangarRoot, TOKEN_FILENAME), "utf8").trim();
  } catch {
    return { reason: "Home is not set up on this computer. Start it with `crewhaus hangar`." };
  }
  const sock = join(hangarRoot, HOME_SOCKET);
  if (existsSync(sock)) {
    return {
      baseUrl: "http://localhost",
      token,
      fetch: (input, init) => fetchImpl(input, { ...init, unix: sock } as RequestInit),
    };
  }
  const lock = readHangarLock(hangarRoot);
  if (lock === undefined) {
    return { reason: "Home is not running on this computer. Start it with `crewhaus hangar`." };
  }
  return {
    baseUrl: loopbackBase(lock.url, lock.port),
    token,
    fetch: (input, init) => fetchImpl(input, init),
  };
}
