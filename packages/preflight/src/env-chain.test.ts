import { describe, expect, test } from "bun:test";
import { type EnvChainFile, envChainItems } from "./env-chain";
import { runPreflight } from "./preflight";

const shared = (present: boolean): EnvChainFile => ({
  declaredAs: "../.env",
  path: "/fleet/.env",
  scope: "shared",
  present,
});
const local: EnvChainFile = {
  declaredAs: ".env",
  path: "/fleet/member/.env",
  scope: "harness",
  present: true,
};

describe("envChainItems", () => {
  test("no files, no items — a harness whose keys all come from process.env", () => {
    expect(envChainItems([])).toEqual([]);
  });

  test("a shared file is named with the path it resolved to", () => {
    const [item] = envChainItems([shared(true)]);
    expect(item?.area).toBe("env");
    expect(item?.level).toBe("info");
    expect(item?.message).toContain("../.env");
    expect(item?.message).toContain("/fleet/.env");
  });

  test("a declared-but-absent shared file warns and says what to do", () => {
    const [item] = envChainItems([shared(false)]);
    expect(item?.level).toBe("warn");
    expect(item?.message).toContain("not readable");
    expect(item?.remediation).toContain("manager.envFiles");
  });

  test("an absent shared file is a WARN, never blocking", () => {
    // The keys may already be in process.env; the credentials area is what
    // refuses a genuinely missing key.
    expect(envChainItems([shared(false)]).every((i) => i.level !== "blocking")).toBe(true);
  });

  test("order is preserved — the report reads lowest precedence first", () => {
    expect(envChainItems([shared(true), local]).map((i) => i.message)).toEqual([
      expect.stringContaining("shared env file"),
      expect.stringContaining("harness env file .env"),
    ]);
  });

  test("ids are stable and unique across the chain", () => {
    const ids = envChainItems([shared(false), local]).map((i) => i.id);
    expect(ids).toEqual(["env.shared-missing.0", "env.file.1"]);
  });
});

describe("the env area inside runPreflight", () => {
  test("the chain is reported before credentials, so file-vs-key reads in order", async () => {
    const report = await runPreflight({
      specYaml: "name: demo\ntarget: cli\nagent:\n  model: claude-sonnet-4-5\n  instructions: hi\n",
      env: {},
      envFiles: [shared(true)],
    });
    const areas = report.items.map((i) => i.area);
    expect(areas).toContain("credentials");
    expect(areas.indexOf("env")).toBeGreaterThan(areas.indexOf("spec"));
    expect(areas.indexOf("env")).toBeLessThan(areas.indexOf("credentials"));
  });

  test("omitting envFiles leaves the area empty rather than guessing", async () => {
    const report = await runPreflight({ specYaml: "name: demo\ntarget: cli\n", env: {} });
    expect(report.items.filter((i) => i.area === "env")).toEqual([]);
  });

  test("a missing shared file never makes the report un-ok on its own", async () => {
    const report = await runPreflight({
      specYaml: "name: demo\ntarget: cli\n",
      env: {},
      envFiles: [shared(false)],
    });
    expect(report.blocking.filter((i) => i.area === "env")).toEqual([]);
  });
});
