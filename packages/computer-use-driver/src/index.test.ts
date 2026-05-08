import { describe, expect, test } from "bun:test";
import { ComputerUseDriverError, type Driver, createDriver } from "./index.js";

describe("createDriver", () => {
  test("dispatches on backend tag", () => {
    const chromium = createDriver({ backend: "chromium" });
    expect(chromium.backend).toBe("chromium");
    const host = createDriver({ backend: "host" });
    expect(host.backend).toBe("host");
    const remote = createDriver({ backend: "remote" });
    expect(remote.backend).toBe("remote");
  });

  test("unknown backend throws", () => {
    expect(() => createDriver({ backend: "bogus" as unknown as "host" })).toThrow(
      /unknown backend/,
    );
  });

  test("host backend rejects connect (T8 — kickoff explicitly forbids)", async () => {
    const d = createDriver({ backend: "host" });
    await expect(d.connect()).rejects.toThrow(ComputerUseDriverError);
  });

  test("remote backend rejects connect (v0 stub)", async () => {
    const d = createDriver({ backend: "remote" });
    await expect(d.connect()).rejects.toThrow(/not implemented in v0/);
  });

  test("_injected returns the injected driver verbatim (test seam)", async () => {
    const recorded: string[] = [];
    const stub: Driver = {
      backend: "chromium",
      async connect() {
        recorded.push("connect");
      },
      async goto() {
        recorded.push("goto");
      },
      async screenshot() {
        recorded.push("screenshot");
        return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
      },
      async click() {
        recorded.push("click");
      },
      async type() {
        recorded.push("type");
      },
      async key() {
        recorded.push("key");
      },
      async scroll() {
        recorded.push("scroll");
      },
      async getViewport() {
        return { width: 800, height: 600, devicePixelRatio: 1 };
      },
      async disconnect() {
        recorded.push("disconnect");
      },
    };
    const d = createDriver({ backend: "chromium", _injected: stub });
    await d.connect();
    await d.goto("about:blank");
    await d.screenshot();
    await d.click(100, 200);
    await d.type("hi");
    await d.key("Enter");
    await d.scroll(0, 200);
    await d.disconnect();
    expect(recorded).toEqual([
      "connect",
      "goto",
      "screenshot",
      "click",
      "type",
      "key",
      "scroll",
      "disconnect",
    ]);
  });

  test("chromium driver throws clean diagnostic when used before connect()", async () => {
    const d = createDriver({ backend: "chromium" });
    await expect(d.screenshot()).rejects.toThrow(/not connected/);
    await expect(d.click(0, 0)).rejects.toThrow(/not connected/);
  });
});
