/**
 * 0.7.1 — a model_pool candidate's `tool_config` REPLACES the agent-level
 * block for that tool while it serves (config-delivery#10). That is the
 * documented design, but the compiler called tool_config a "narrowing" knob
 * and said nothing when a candidate's allow-list was wider: an empty
 * `webFetch.allowed_domains` on one candidate meant every host beside an
 * agent-level list of one domain. Now it is named, informationally.
 */
import { describe, expect, test } from "bun:test";
import { compile } from "./index";

/** A cli spec with an agent-level tool_config and one pool candidate block. */
function spec(opts: { tools: string; agent?: string; candidate: string }): string {
  return [
    "name: c",
    "target: cli",
    "agent:",
    "  model: claude-sonnet-4-6",
    "  instructions: i",
    "  model_pool:",
    "    candidates:",
    "      - model: claude-haiku-4-5",
    `        tool_config: ${opts.candidate}`,
    "      - model: claude-opus-4-8",
    `tools: [${opts.tools}]`,
    ...(opts.agent !== undefined ? ["tool_config:", opts.agent] : []),
    "",
  ].join("\n");
}

const widens = (yaml: string) =>
  compile(yaml).warnings.filter((w) => w.code === "model-plan-tool-config-widens");

describe("model-plan-tool-config-widens", () => {
  test("an empty WebFetch allowed_domains on a candidate is named: it admits every host", () => {
    const found = widens(
      spec({
        tools: "webFetch",
        agent: "  webFetch: { allowed_domains: [docs.example.com] }",
        candidate: "{ webFetch: { allowed_domains: [] } }",
      }),
    );
    // 0.7.0 compiled this silently, --strict included.
    expect(found).toEqual([
      {
        code: "model-plan-tool-config-widens",
        path: "agent.model_pool.candidates[0].tool_config.webFetch.allowed_domains",
        message:
          "this candidate's WebFetch reaches every public host (an empty allowed_domains admits all), which tool_config.webFetch.allowed_domains does not allow. A candidate's tool_config block REPLACES the agent-level block for that tool while the candidate serves; it does not narrow it. List only what the agent-level block allows if that was the intent.",
      },
    ]);
  });

  test("a domain the agent-level list does not cover is named; a subdomain of one is not", () => {
    const found = widens(
      spec({
        tools: "webFetch",
        agent: "  webFetch: { allowed_domains: [docs.example.com] }",
        candidate: "{ webFetch: { allowed_domains: [api.docs.example.com, attacker.example] } }",
      }),
    );
    expect(found.map((w) => w.message.split(",")[0])).toEqual([
      'this candidate\'s WebFetch reaches "attacker.example"',
    ]);
  });

  test("an origin outside the agent-level allowed_origins is named once per block", () => {
    const found = widens(
      spec({
        tools: "httpRequest, headRequest, fetch",
        agent:
          '  http: { allowed_origins: ["https://api.example.com"] }\n  fetch: { allowed_origins: ["https://api.example.com"] }',
        candidate:
          '{ http: { allowed_origins: ["https://API.example.com:443", "https://other.example"] }, fetch: { allowed_origins: [] } }',
      }),
    );
    // Two http tools read the one block: one notice. The canonical spelling
    // of the listed origin is not "wider"; an empty fetch list admits nothing.
    expect(found.map((w) => [w.path, w.message.split(",")[0]])).toEqual([
      [
        "agent.model_pool.candidates[0].tool_config.http.allowed_origins",
        'this candidate\'s HttpRequest reaches "https://other.example"',
      ],
    ]);
  });

  test("silent when the candidate is within the agent's list, or the agent has no block", () => {
    const quiet = [
      spec({
        tools: "webFetch",
        agent: "  webFetch: { allowed_domains: [docs.example.com] }",
        candidate: "{ webFetch: { allowed_domains: [docs.example.com] } }",
      }),
      // No agent-level list to undermine: the candidate's block is the only one.
      spec({ tools: "webFetch", candidate: "{ webFetch: { allowed_domains: [] } }" }),
      // An empty agent-level WebFetch list already admits every host.
      spec({
        tools: "webFetch",
        agent: "  webFetch: { allowed_domains: [] }",
        candidate: "{ webFetch: { allowed_domains: [anything.example] } }",
      }),
    ];
    expect(quiet.map((yaml) => widens(yaml).length)).toEqual([0, 0, 0]);
  });

  test("the single-model refusal no longer calls tool_config a narrowing", () => {
    const yaml = [
      "name: c",
      "target: cli",
      "models:",
      "  open: { model: claude-haiku-4-5, tool_config: { webFetch: { allowed_domains: [] } } }",
      "agent:",
      "  model: $open",
      "  instructions: i",
      "tools: [webFetch]",
      "",
    ].join("\n");
    let message = "";
    try {
      compile(yaml);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("models.open.tool_config");
    expect(message).toContain("declare the setting on the shape itself");
    expect(message).not.toContain("declare the narrowing");
  });
});
