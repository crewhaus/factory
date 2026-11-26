/**
 * `repositories:` and, beside it, `intent:` (#514, #516): what they compile to when declared,
 * with the key order guarded, that the intent is in one place, and that a spec declaring
 * neither, or `intent:` alone, keeps its bytes.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSpec } from "@crewhaus/spec";
import { CORPUS_TODAY, corpusFileDigests } from "./__fixtures__/delta-090/regenerate";
import { ABSENT_CORPUS } from "./absent-corpus";
import { compile, lower } from "./index";
import { lowerRepositories } from "./lower/repositories";
import { INTENT_MARKER, REPOSITORIES_CORPUS } from "./repositories-corpus";

const present = JSON.parse(
  readFileSync(
    new URL("./__fixtures__/delta-090/repositories.present.digests.json", import.meta.url),
    "utf8",
  ),
) as Record<string, Record<string, string>>;

const filesOf = (yaml: string) => compile(yaml, { today: CORPUS_TODAY }).files;

/** The one call the block compiles to, its keys in the order the IR gives them. */
const CALL =
  'bindWorkspaceRepositories({"repositories":[{"name":"app","host":"github","repo":"acme/budget-app","base":"trunk","branchPrefix":"steward/","checks":[["bun","install","--frozen-lockfile"],["bun","test"]],"checkTimeoutMs":300000,"checkImage":"oven/bun:1","pullRequests":{"draft":false,"maxFiles":10,"maxLines":400,"revalidate":"refresh","require":["checks","acceptance"]},"server":{"api":"http://127.0.0.1:8098","git":"http://127.0.0.1:8099"},"allowPrivateTarget":true},{"name":"zeta","host":"github","repo":"acme/zeta","base":"main","branchPrefix":"crewhaus/","checks":[],"checkTimeoutMs":600000,"pullRequests":{"draft":true,"maxFiles":20,"maxLines":800,"revalidate":"rebase","require":["acceptance"]},"server":{"api":"https://api.github.com","git":"https://github.com"}}],"tokenEnv":"GITHUB_TOKEN","intent":{"purpose":"Keep the budgeting app reliable and fast.","excludes":["UI redesigns"]}});';

describe("repositories", () => {
  test("the present golden covers exactly the five specs", () => {
    expect(Object.keys(present)).toEqual([
      "batch-repositories",
      "channel-repositories",
      "cli-repositories",
      "managed-repositories",
      "workflow-repositories",
    ]);
  });

  for (const [name, yaml] of Object.entries(REPOSITORIES_CORPUS)) {
    test(`${name}: every file matches the present golden`, () => {
      expect(corpusFileDigests(yaml)).toEqual(present[name] as Record<string, string>);
    });

    test(`${name}: one call, its keys in order, and the intent nowhere else`, () => {
      const files = filesOf(yaml);
      const code = files.map((f) => f.content).join("\n");
      expect(code).toContain(CALL);
      for (const file of files) {
        const rest = file.content.split(CALL).join("");
        expect({ path: file.path, holds: rest.includes(INTENT_MARKER) }).toEqual({
          path: file.path,
          holds: false,
        });
        expect({ path: file.path, holds: rest.includes("UI redesigns") }).toEqual({
          path: file.path,
          holds: false,
        });
      }
      const readme = files.find((f) => f.path === "README.md")?.content ?? "";
      expect(readme).toContain("configured by `repositories`");
      expect(readme).not.toContain("acme/budget-app");
      // The token's variable is named; nothing reads it at boot.
      expect(code).not.toContain("process.env.GITHUB_TOKEN");
    });

    test(`${name}: no warning says the block or the codehost key does nothing`, () => {
      const codes = compile(yaml, { today: CORPUS_TODAY }).warnings.filter(
        (w) => w.code === "tool-unwired" || w.code === "tool-config-unused",
      );
      expect(codes).toEqual([]);
    });
  }

  test("a spec with intent alone, or neither key, compiles to the same bytes on every shape", () => {
    for (const [shape, yaml] of Object.entries(ABSENT_CORPUS)) {
      expect({
        shape,
        files: corpusFileDigests(`${yaml}intent: {purpose: "${INTENT_MARKER}"}\n`),
      }).toEqual({
        shape,
        files: corpusFileDigests(yaml),
      });
      const ir = lower(parseSpec(`${yaml}intent: {purpose: "x"}\n`)) as Record<string, unknown>;
      expect({ shape, keys: ["intent", "repositories"].filter((k) => k in ir) }).toEqual({
        shape,
        keys: [],
      });
    }
    expect(lowerRepositories({})).toEqual({});
    expect(lowerRepositories({ intent: { purpose: "x" } })).toEqual({});
    expect(lowerRepositories({ repositories: {} })).toEqual({});
  });

  test("the block with no workspace tool changes no byte and says so; a tool with no block says so too", () => {
    const base = ABSENT_CORPUS.cli;
    const alone = `${base}repositories: {app: {host: github, repo: acme/app}}\n`;
    expect(corpusFileDigests(alone)).toEqual(corpusFileDigests(base));
    expect(
      compile(alone, { today: CORPUS_TODAY }).warnings.find((w) => w.path === "repositories"),
    ).toMatchObject({ code: "tool-config-unused" });
    const unwired = `${base}tools: [workspaceOpen]\n`;
    const warning = compile(unwired, { today: CORPUS_TODAY }).warnings.find(
      (w) => w.code === "tool-unwired",
    );
    expect(warning?.message).toContain("repositories:");
    expect(
      filesOf(unwired)
        .map((f) => f.content)
        .join("\n"),
    ).not.toContain("bindWorkspaceRepositories");
  });

  test("a text that is a variable's name is emitted as that text, and no boot reads it", () => {
    for (const yaml of Object.values(REPOSITORIES_CORPUS)) {
      const named = yaml.replace(`${INTENT_MARKER}.`, "$HOME");
      const code = filesOf(named)
        .map((f) => f.content)
        .join("\n");
      expect(code).toContain('"intent":{"purpose":"$HOME"');
      expect(code).not.toContain("applyToolConfig(bindWorkspaceRepositories");
      expect(code).not.toContain('process.env["HOME"]');
    }
  });

  test("the judge is the spec's own in-loop judge, its one model or the first of its panel", () => {
    const yaml = REPOSITORIES_CORPUS["cli-repositories"] as string;
    const one = `${yaml}evaluation: {grader: {type: llm_judge, criteria: good, model: claude-sonnet-5}}\n`;
    expect(
      filesOf(one)
        .map((f) => f.content)
        .join("\n"),
    ).toContain('"judge":{"model":"claude-sonnet-5"}});');
    const panel = `${yaml}evaluation: {grader: {type: llm_judge, criteria: good, judges: [claude-opus-4-7, claude-sonnet-5]}}\n`;
    expect(
      filesOf(panel)
        .map((f) => f.content)
        .join("\n"),
    ).toContain('"judge":{"model":"claude-opus-4-7"}});');
  });

  test("a token variable written with a $ is not copied, and two that differ stop the compile", () => {
    const yaml = REPOSITORIES_CORPUS["cli-repositories"] as string;
    const code = filesOf(yaml.replace("token_env: GITHUB_TOKEN", "token_env: $GITHUB_TOKEN"))
      .map((f) => f.content)
      .join("\n");
    expect(code).not.toContain('"tokenEnv"');
    const two = `name: two
target: workflow
model: claude-opus-4-7
steps:
  - {name: a, instructions: One., tools: [workspaceOpen], tool_config: {codehost: {token_env: A_TOKEN}}}
  - {name: b, instructions: Two., tools: [workspacePublish], tool_config: {codehost: {token_env: B_TOKEN}}}
repositories: {app: {host: github, repo: acme/app}}
`;
    expect(() => compile(two, { today: CORPUS_TODAY })).toThrow(/different variables/);
  });
});
