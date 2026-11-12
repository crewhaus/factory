/**
 * The owner's settings blocks: what Home will trust, checked field by field. A block that
 * is not right is refused with one line naming the file and the field; a base URL that is
 * not right is warned about and ignored; a write changes one block and nothing else.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS_FILENAME, readOwnerSettings, writeOwnerBlock } from "./owner-settings";
import { removeTempDirs, tempDir } from "./test-helpers";

afterAll(removeTempDirs);

const OWNER = {
  access: {
    allowedHosts: ["home.example.test"],
    trustedProxy: {
      header: "X-Auth-User",
      peers: ["127.0.0.1/32"],
      hosts: ["proxy.example.test"],
      secretDigest: "a".repeat(64),
    },
  },
  links: { baseUrl: "https://home.example.test" },
};

function withSettings(body: unknown): string {
  const dir = tempDir();
  writeFileSync(join(dir, SETTINGS_FILENAME), JSON.stringify(body));
  return dir;
}

describe("readOwnerSettings", () => {
  test("a good block reads back, the header lower-cased", () => {
    const read = readOwnerSettings(withSettings(OWNER));
    if (!read.ok) throw new Error(read.reason);
    expect(read.settings).toEqual({
      trustedProxy: {
        header: "x-auth-user",
        peers: ["127.0.0.1/32"],
        hosts: ["proxy.example.test"],
        secretDigest: "a".repeat(64),
      },
      allowedHosts: ["home.example.test"],
      baseUrl: "https://home.example.test",
    });
    expect(read.warnings).toEqual([]);
  });

  test("no file, or a file that is not JSON, holds no owner settings", () => {
    expect(readOwnerSettings(tempDir())).toEqual({
      ok: true,
      settings: { allowedHosts: [] },
      warnings: [],
    });
    const dir = tempDir();
    writeFileSync(join(dir, SETTINGS_FILENAME), "{torn");
    expect(readOwnerSettings(dir).ok).toBe(true);
  });

  test.each([
    [{ access: "on" }, "access must be an object"],
    [
      { access: { trustedProxy: { ...OWNER.access.trustedProxy, peers: ["10.0.0.0/33"] } } },
      "access.trustedProxy.peers[0] is not a CIDR block",
    ],
    [
      { access: { trustedProxy: { ...OWNER.access.trustedProxy, header: "Authorization" } } },
      "access.trustedProxy.header names a header Home reserves",
    ],
    [
      { access: { trustedProxy: { ...OWNER.access.trustedProxy, header: "X-Forwarded-User" } } },
      "access.trustedProxy.header names a header Home reserves",
    ],
    [
      { access: { trustedProxy: { ...OWNER.access.trustedProxy, secretDigest: "nope" } } },
      "access.trustedProxy.secretDigest must be 64 lowercase hex characters",
    ],
    [
      { access: { trustedProxy: { header: "x-user", peers: [], hosts: [] } } },
      "access.trustedProxy needs a proof",
    ],
    [{ access: { allowedHosts: ["not a host"] } }, "access.allowedHosts[0] is not a host name"],
    [{ access: { auth: true } }, "access.auth is not a setting Home knows"],
  ])(
    "an access block that is not right is refused, naming the file and the field (%#)",
    (body, field) => {
      const dir = withSettings(body);
      const read = readOwnerSettings(dir);
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.reason).toContain(join(dir, SETTINGS_FILENAME));
        expect(read.reason).toContain(field);
      }
    },
  );

  test.each([
    ["http://home.example.test"],
    ["ftp://home.example.test"],
    ["https://user:pw@home.example.test"],
    ["not a url"],
  ])("a links.baseUrl of %p is warned about and ignored", (baseUrl) => {
    const read = readOwnerSettings(withSettings({ links: { baseUrl } }));
    if (!read.ok) throw new Error(read.reason);
    expect(read.settings.baseUrl).toBeUndefined();
    expect(read.warnings.join("\n")).toContain("links.baseUrl");
  });

  test("http on this computer is a base URL", () => {
    const read = readOwnerSettings(withSettings({ links: { baseUrl: "http://127.0.0.1:4200/" } }));
    expect(read.ok && read.settings.baseUrl).toBe("http://127.0.0.1:4200");
  });
});

describe("writeOwnerBlock", () => {
  test("sets and removes one block, keeping every other key", () => {
    const dir = withSettings({ readOnly: true, notifications: { mutedGroups: ["prod"] } });
    writeOwnerBlock(dir, "access", OWNER.access);
    expect(readOwnerSettings(dir).ok).toBe(true);
    const path = join(dir, SETTINGS_FILENAME);
    const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(written["readOnly"]).toBe(true);
    expect(written["access"]).toEqual(OWNER.access);
    writeOwnerBlock(dir, "access", undefined);
    const after = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect("access" in after).toBe(false);
    expect(after["notifications"]).toEqual({ mutedGroups: ["prod"] });
  });

  test("refuses a file that is not a JSON object rather than replace it", () => {
    const dir = tempDir();
    writeFileSync(join(dir, SETTINGS_FILENAME), "[1]");
    expect(() => writeOwnerBlock(dir, "access", {})).toThrow(/not a JSON object/);
  });
});
