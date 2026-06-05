import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createLogger } from "./index";

const fixedTime = () => new Date("2026-05-04T12:00:00.000Z");

describe("createLogger - pretty format", () => {
  test("emits a single line with uppercased padded level", () => {
    const lines: string[] = [];
    const log = createLogger({
      format: "pretty",
      level: "info",
      sink: (l) => lines.push(l),
      now: fixedTime,
    });
    log.info("hello");
    expect(lines).toEqual(["2026-05-04T12:00:00.000Z INFO  hello\n"]);
  });

  test("appends fields as space-separated key=value pairs", () => {
    const lines: string[] = [];
    const log = createLogger({
      format: "pretty",
      sink: (l) => lines.push(l),
      now: fixedTime,
    });
    log.warn("compiled", { files: 1, target: "cli" });
    expect(lines[0]).toBe("2026-05-04T12:00:00.000Z WARN  compiled files=1 target=cli\n");
  });

  test("quotes string values that contain whitespace", () => {
    const lines: string[] = [];
    const log = createLogger({
      format: "pretty",
      sink: (l) => lines.push(l),
      now: fixedTime,
    });
    log.info("x", { msg: "hello world" });
    expect(lines[0]).toContain('msg="hello world"');
  });
});

describe("createLogger - json format", () => {
  test("emits one JSON object per line", () => {
    const lines: string[] = [];
    const log = createLogger({
      format: "json",
      level: "info",
      sink: (l) => lines.push(l),
      now: fixedTime,
    });
    log.error("boom", { code: "compiler" });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed).toEqual({
      time: "2026-05-04T12:00:00.000Z",
      level: "error",
      msg: "boom",
      code: "compiler",
    });
  });
});

describe("level filtering", () => {
  test("debug is suppressed at info level", () => {
    const lines: string[] = [];
    const log = createLogger({
      format: "json",
      level: "info",
      sink: (l) => lines.push(l),
      now: fixedTime,
    });
    log.debug("nope");
    log.info("yep");
    expect(lines).toHaveLength(1);
  });

  test("at debug level all four severities emit", () => {
    const lines: string[] = [];
    const log = createLogger({
      format: "json",
      level: "debug",
      sink: (l) => lines.push(l),
      now: fixedTime,
    });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines).toHaveLength(4);
  });

  test("at error level lower severities are suppressed", () => {
    const lines: string[] = [];
    const log = createLogger({
      format: "json",
      level: "error",
      sink: (l) => lines.push(l),
      now: fixedTime,
    });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines).toHaveLength(1);
  });
});

describe("child loggers", () => {
  test("merge bindings without mutating the parent", () => {
    const lines: string[] = [];
    const parent = createLogger({
      format: "json",
      sink: (l) => lines.push(l),
      now: fixedTime,
      bindings: { app: "cli" },
    });
    const child = parent.child({ run: "abc" });
    child.info("x");
    parent.info("y");
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ app: "cli", run: "abc", msg: "x" });
    const parentRecord = JSON.parse(lines[1] ?? "");
    expect(parentRecord).toMatchObject({ app: "cli", msg: "y" });
    expect(parentRecord["run"]).toBeUndefined();
  });

  test("explicit fields override bindings", () => {
    const lines: string[] = [];
    const log = createLogger({
      format: "json",
      sink: (l) => lines.push(l),
      now: fixedTime,
      bindings: { run: "default" },
    });
    log.info("x", { run: "override" });
    expect(JSON.parse(lines[0] ?? "")["run"]).toBe("override");
  });
});

describe("default sink + default clock (coverage of the no-options paths)", () => {
  // The default sink writes to process.stderr; spy on it so nothing actually
  // reaches the terminal and we can assert the exact line that was emitted.
  test("default sink writes the rendered line to process.stderr", () => {
    const writeSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // No `sink` → exercises the default `(line) => process.stderr.write(line)`.
      const log = createLogger({ format: "json", level: "info", now: fixedTime });
      log.info("via-default-sink", { k: "v" });
      expect(writeSpy).toHaveBeenCalledTimes(1);
      const written = String(writeSpy.mock.calls[0]?.[0] ?? "");
      expect(JSON.parse(written)).toMatchObject({
        time: "2026-05-04T12:00:00.000Z",
        level: "info",
        msg: "via-default-sink",
        k: "v",
      });
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("default clock (no `now`) stamps a real ISO-8601 time", () => {
    const lines: string[] = [];
    // No `now` → exercises the default `() => new Date()` clock arrow.
    const log = createLogger({ format: "json", level: "info", sink: (l) => lines.push(l) });
    log.info("real-clock");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "");
    // ISO-8601 from a real Date, e.g. 2026-06-04T12:34:56.789Z.
    expect(parsed.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(parsed.time))).toBe(false);
  });
});

describe("env-driven configuration (envLevel / envFormat)", () => {
  const prevFormat = process.env["CREWHAUS_LOG"];
  const prevLevel = process.env["CREWHAUS_LOG_LEVEL"];

  afterEach(() => {
    // Restore the ambient env so no other test (or package) is affected.
    if (prevFormat === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_LOG");
    else process.env["CREWHAUS_LOG"] = prevFormat;
    if (prevLevel === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_LOG_LEVEL");
    else process.env["CREWHAUS_LOG_LEVEL"] = prevLevel;
  });

  test("CREWHAUS_LOG=json is honoured when no explicit format is given", () => {
    process.env["CREWHAUS_LOG"] = "json";
    Reflect.deleteProperty(process.env, "CREWHAUS_LOG_LEVEL");
    const lines: string[] = [];
    // No `format` → createLogger consults envFormat(), which returns "json".
    const log = createLogger({ level: "info", sink: (l) => lines.push(l), now: fixedTime });
    log.info("env-json", { a: 1 });
    expect(lines).toHaveLength(1);
    // JSON format proves envFormat() resolved to "json".
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ msg: "env-json", a: 1 });
  });

  test("CREWHAUS_LOG_LEVEL=error suppresses lower severities when no explicit level is given", () => {
    process.env["CREWHAUS_LOG_LEVEL"] = "error";
    process.env["CREWHAUS_LOG"] = "json";
    const lines: string[] = [];
    // No `level` → createLogger consults envLevel(), which returns "error".
    const log = createLogger({ sink: (l) => lines.push(l), now: fixedTime });
    log.info("dropped");
    log.warn("dropped");
    log.error("kept");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")["msg"]).toBe("kept");
  });

  test("an unrecognised CREWHAUS_LOG value falls back to pretty (envFormat returns undefined)", () => {
    process.env["CREWHAUS_LOG"] = "yaml-nonsense";
    Reflect.deleteProperty(process.env, "CREWHAUS_LOG_LEVEL");
    const lines: string[] = [];
    const log = createLogger({ level: "info", sink: (l) => lines.push(l), now: fixedTime });
    log.info("fallback");
    // Pretty (not JSON) output → the unknown env value was ignored.
    expect(lines[0]).toBe("2026-05-04T12:00:00.000Z INFO  fallback\n");
  });
});
