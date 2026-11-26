import { describe, expect, test } from "bun:test";
import { parse as parseYaml, stringify } from "yaml";
import { repositoriesIssues } from "./blocks/repositories";
import { DELTA_090_ISSUES, REPOSITORY_DEFAULTS, parseSpec } from "./index";

const CLI = {
  name: "steward",
  target: "cli",
  agent: { model: "claude-opus-4-7", instructions: "Help." },
};
const APP = { host: "github", repo: "acme/app" };

function parse(binding: Record<string, unknown>, name = "app") {
  return parseSpec(stringify({ ...CLI, repositories: { [name]: { ...APP, ...binding } } }));
}
function refusal(binding: Record<string, unknown>, name = "app"): string {
  try {
    parse(binding, name);
  } catch (err) {
    return (err as Error).message;
  }
  return "";
}

describe("repositories", () => {
  test("a binding needs a host and a repository, and nothing else", () => {
    const spec = parse({}) as { repositories?: Record<string, unknown> };
    expect(spec.repositories).toEqual({ app: APP });
    expect(REPOSITORY_DEFAULTS).toMatchObject({ base: "main", maxFiles: 20, maxLines: 800 });
  });

  test("is placed on the five shapes that deliver work, and rejected on the others", () => {
    const shapes: Record<string, string> = {
      cli: "",
      graph: "model: claude-opus-4-7\nentry: a\nnodes: {a: {instructions: x}}\nedges: []\n",
      research: "goal: Map the field\nbranchingFactor: 2\n",
      browser: "limits: {turn_timeout_ms: 30000}\n",
    };
    for (const [target, rest] of Object.entries(shapes)) {
      const agent = target === "graph" ? "" : "agent: {model: claude-opus-4-7, instructions: x}\n";
      const yaml = `name: x\ntarget: ${target}\n${agent}${rest}repositories: {app: {host: github, repo: acme/app}}\n`;
      const parses = (): unknown => parseSpec(yaml);
      if (target === "cli") expect(parses).not.toThrow();
      else expect(parses).toThrow(/repositories/);
    }
  });

  const bad: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["another host", { host: "gitlab" }],
    ["no owner", { repo: "app" }],
    ["a repository path", { repo: "a/b/c" }],
    ["a branch that is an option", { base: "-main" }],
    ["a branch with ..", { base: "a..b" }],
    ["a branch git refuses", { base: "main.lock" }],
    ["a prefix with no slash", { branch_prefix: "crewhaus" }],
    ["a prefix in capitals", { branch_prefix: "Crew/" }],
    ["an empty part in a prefix", { branch_prefix: "a//" }],
    ["no checks in the list", { checks: [] }],
    ["a check with no program", { checks: [[]] }],
    ["a shell", { checks: [["sh", "-c", "bun test"]] }],
    ["a shell by its path", { checks: [["bin/bash", "run.sh"]] }],
    ["an absolute program", { checks: [["/usr/bin/make"]] }],
    ["a program above the checkout", { checks: [["../run"]] }],
    ["a check line", { checks: ["bun test"] }],
    ["a line break in a word", { checks: [["bun", "a\nb"]] }],
    ["a timeout past an hour", { check_timeout: "2h" }],
    ["a timeout of nothing", { check_timeout: "0s" }],
    ["an image that is an option", { check_image: "--privileged" }],
    ["too many files", { pull_requests: { max_files: 1001 } }],
    ["another revalidation", { pull_requests: { revalidate: "merge" } }],
    ["no requirement", { pull_requests: { require: [] } }],
    ["a requirement twice", { pull_requests: { require: ["acceptance", "acceptance"] } }],
    ["another requirement", { pull_requests: { require: ["review"] } }],
    ["an origin with a path", { server: { api: "https://ghe.example.com/api/v3" } }],
    ["an origin with a user", { server: { api: "https://u:p@ghe.example.com" } }],
    ["an unknown key", { token: "x" }],
  ];
  for (const [what, binding] of bad) {
    test(`refuses ${what}`, () => {
      expect(refusal(binding)).not.toBe("");
    });
  }

  test("a binding's name is plain, and there are at most eight", () => {
    expect(refusal({}, "App")).not.toBe("");
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`r${i}`, APP]));
    expect(() => parseSpec(stringify({ ...CLI, repositories: many }))).toThrow(/at most 8/);
    expect(() => parseSpec(stringify({ ...CLI, repositories: {} }))).toThrow(/at least one/);
  });

  test("a loopback server needs the binding's own opt-in; http is for an admitted one only", () => {
    for (const origin of ["http://127.0.0.1:8080", "http://localhost:8080", "http://[::1]:8080"]) {
      expect(refusal({ server: { api: origin } })).toContain("allow_private_target");
      expect(refusal({ server: { git: origin }, allow_private_target: true })).toBe("");
    }
    expect(
      refusal({ server: { api: "http://ghe.example.com" }, allow_private_target: true }),
    ).toContain("must be https");
    expect(refusal({ server: { api: "https://ghe.example.com" } })).toBe("");
  });

  test("a private address is refused whatever the binding says, without repeating it", () => {
    for (const origin of [
      "https://10.0.0.4",
      "https://192.168.1.2:8443",
      "https://172.16.0.1",
      "https://169.254.169.254",
      "https://100.64.0.1",
      "https://0.0.0.0",
      "https://[fd00::1]",
      "https://[fe80::1]",
    ]) {
      for (const allow of [{}, { allow_private_target: true }]) {
        const message = refusal({ server: { api: origin }, ...allow });
        expect(message).toContain("private address");
        expect(message).not.toContain(new URL(origin).hostname);
      }
    }
  });

  test("requiring checks needs checks", () => {
    expect(refusal({ pull_requests: { require: ["checks"] } })).toContain("no checks are declared");
    expect(refusal({ checks: [["bun", "test"]], pull_requests: { require: ["checks"] } })).toBe("");
  });

  test("its cross-field check is appended after every older one", () => {
    expect(DELTA_090_ISSUES.indexOf(repositoriesIssues)).toBe(DELTA_090_ISSUES.length - 1);
    expect(parseYaml("a: 1")).toEqual({ a: 1 });
  });
});
