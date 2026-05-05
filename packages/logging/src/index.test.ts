import { describe, expect, test } from "bun:test";
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
