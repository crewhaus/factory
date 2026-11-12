/**
 * The manager settings store. Small surface, three properties worth pinning:
 * a patch merges rather than replaces, a torn file degrades to defaults
 * WITHOUT being deleted (an operator may still be able to fix it by hand),
 * and a webhook URL is validated on the way in rather than masked on the way
 * out.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  SETTINGS_FILENAME,
  normalizeWebhookUrl,
  openSettingsStore,
} from "./settings";
import { bootTestServer } from "./testkit";

const root = (): string => mkdtempSync(join(tmpdir(), "hangar-settings-"));

describe("openSettingsStore", () => {
  test("defaults before anything is written; a patch merges and persists", () => {
    const dir = root();
    try {
      const store = openSettingsStore(dir);
      expect(store.get()).toEqual(DEFAULT_SETTINGS);

      store.update({ readOnly: true });
      expect(store.get().readOnly).toBe(true);
      // …and the rules the patch did not mention are still there.
      expect(store.get().notifications.rules).toHaveLength(
        DEFAULT_SETTINGS.notifications.rules.length,
      );

      const reopened = openSettingsStore(dir);
      expect(reopened.get().readOnly).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a torn settings file warns, degrades to defaults, and is NOT deleted", () => {
    const dir = root();
    try {
      const path = join(dir, SETTINGS_FILENAME);
      writeFileSync(path, "{ this is not json");
      const warnings: string[] = [];
      const store = openSettingsStore(dir, { onWarn: (m) => warnings.push(m) });
      expect(store.get()).toEqual(DEFAULT_SETTINGS);
      expect(warnings[0]).toContain("unreadable");
      expect(readFileSync(path, "utf8")).toBe("{ this is not json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a foreign-shaped file is coerced rather than trusted", () => {
    const dir = root();
    try {
      writeFileSync(
        join(dir, SETTINGS_FILENAME),
        JSON.stringify({ readOnly: "yes", notifications: { rules: "nope", mutedGroups: 7 } }),
      );
      const settings = openSettingsStore(dir).get();
      // A string is not `true`.
      expect(settings.readOnly).toBe(false);
      expect(settings.notifications.rules).toHaveLength(
        DEFAULT_SETTINGS.notifications.rules.length,
      );
      expect(settings.notifications.mutedGroups).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an update that names an invalid webhook throws and changes nothing", () => {
    const dir = root();
    try {
      const store = openSettingsStore(dir);
      store.update({ readOnly: true });
      expect(() =>
        store.update({ notifications: { webhookUrl: "ftp://example.test/hook" } }),
      ).toThrow(/http/);
      expect(store.get().readOnly).toBe(true);
      expect(store.get().notifications.webhookUrl).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("normalizeWebhookUrl", () => {
  test("accepts http(s), clears on empty, and refuses schemes and embedded credentials", () => {
    expect(normalizeWebhookUrl("https://hooks.example.test/x").url).toBe(
      "https://hooks.example.test/x",
    );
    expect(normalizeWebhookUrl("").url).toBeNull();
    expect(normalizeWebhookUrl(null).url).toBeNull();
    expect(normalizeWebhookUrl("file:///etc/passwd").error).toContain("http:");
    expect(normalizeWebhookUrl("https://u:p@hooks.example.test/x").error).toContain("credentials");
    expect(normalizeWebhookUrl("not a url").error).toContain("valid URL");
    expect(normalizeWebhookUrl(42).error).toContain("string");
  });
});

describe("the owner's blocks: access and links", () => {
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

  test("survive a notifications update and a read-only toggle, as the file has them now", () => {
    const dir = root();
    try {
      const store = openSettingsStore(dir);
      store.update({ readOnly: false });
      // The owner edits the file by hand while Home runs.
      const path = join(dir, SETTINGS_FILENAME);
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...OWNER }));
      store.update({ notifications: { mutedGroups: ["prod"] } });
      store.update({ readOnly: true });
      const after = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(after["access"]).toEqual(OWNER.access);
      expect(after["links"]).toEqual(OWNER.links);
      expect(after["readOnly"]).toBe(true);
      expect((after["notifications"] as { mutedGroups: string[] }).mutedGroups).toEqual(["prod"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an invalid access block refuses Home's boot, naming the file and the field", () => {
    expect(() =>
      bootTestServer({
        prepare: ({ hangarRoot }) =>
          writeFileSync(
            join(hangarRoot, SETTINGS_FILENAME),
            JSON.stringify({ access: { allowedHosts: [7] } }),
          ),
      }),
    ).toThrow(/settings\.json: access\.allowedHosts\[0\] is not a host name/);
  });

  test("an invalid links.baseUrl is warned about and ignored at boot", async () => {
    const t = bootTestServer({
      prepare: ({ hangarRoot }) =>
        writeFileSync(
          join(hangarRoot, SETTINGS_FILENAME),
          JSON.stringify({ links: { baseUrl: "http://home.example.test" } }),
        ),
    });
    try {
      expect(t.warnings.some((w) => w.includes("links.baseUrl"))).toBe(true);
      // Ignored: its host is not one Home answers to.
      const res = await t.fetchRaw("/healthz-not", { headers: { host: "home.example.test" } });
      expect(res.status).toBe(421);
    } finally {
      await t.stop();
    }
  });
});
