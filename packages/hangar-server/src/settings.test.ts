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
