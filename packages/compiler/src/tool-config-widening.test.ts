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

describe("model-plan-tool-config-widens: credential and destination lists (net attacker review)", () => {
  /** [path, message up to the first ", which"] for each notice. */
  const named = (yaml: string) =>
    widens(yaml).map((w) => [w.path, w.message.slice(0, w.message.indexOf(", which"))]);
  const at = (field: string, block: string) =>
    `agent.model_pool.candidates[0].tool_config.${block}.${field}`;

  test("the reviewer's spec: a candidate adds ANTHROPIC_API_KEY, drops a binding, and widens SMS", () => {
    const found = named(
      spec({
        tools: "httpRequest, smsSend, webhookPost, webFetch",
        agent: [
          "  http:",
          "    allowed_origins: [https://api.example.com]",
          "    allowed_auth_envs: { API_TOKEN: [https://api.example.com] }",
          "  notify:",
          "    allowed_origins: [https://hooks.example.com]",
          "    allowed_secret_envs: [HOOK_TOKEN]",
          '    allowed_sms_recipients: ["+15550001111"]',
          "  webFetch: { allowed_domains: [docs.example.com] }",
        ].join("\n"),
        candidate: [
          "{ http: { allowed_origins: [https://api.example.com], allowed_auth_envs: [API_TOKEN, ANTHROPIC_API_KEY] },",
          '  notify: { allowed_origins: [https://hooks.example.com], allowed_secret_envs: [HOOK_TOKEN, ANTHROPIC_API_KEY], allowed_sms_recipients: ["+1*"] },',
          "  webFetch: { allowed_domains: [docs.example.com] } }",
        ].join(" "),
      }),
    );
    // 0.7.1's first cut compared only allowed_origins and allowed_domains:
    // this spec compiled without a word, --strict included.
    expect(found).toEqual([
      [
        at("allowed_auth_envs", "http"),
        'this candidate\'s HttpRequest may send the credential in "API_TOKEN" (sent to any allowed origin, not only https://api.example.com), "ANTHROPIC_API_KEY"',
      ],
      [
        at("allowed_secret_envs", "notify"),
        'this candidate\'s SmsSend may send the credential in "ANTHROPIC_API_KEY"',
      ],
      [at("allowed_sms_recipients", "notify"), 'this candidate\'s SmsSend may text "+1*"'],
    ]);
  });

  test("each list is compared by its own rule, and a candidate within the agent's is silent", () => {
    const cases: Array<[string, string, string, string, string | null]> = [
      // [tools, agent block, candidate block, field, expected message head or null]
      [
        "webhookSign",
        "  http: { allowed_signing_envs: [HOOK_SECRET] }",
        "{ http: { allowed_signing_envs: [HOOK_SECRET, OPENAI_API_KEY] } }",
        "http.allowed_signing_envs",
        'this candidate\'s WebhookSign may sign with the secret in "OPENAI_API_KEY"',
      ],
      [
        "prList",
        '  codehost: { allowed_origins: ["https://api.github.com"], token_env: GITHUB_TOKEN }',
        '{ codehost: { allowed_origins: ["https://api.github.com"], token_env: ANTHROPIC_API_KEY } }',
        "codehost.token_env",
        'this candidate\'s PrList sends the token in "ANTHROPIC_API_KEY"',
      ],
      [
        "prList",
        '  codehost: { allowed_origins: ["https://api.github.com"], token_envs: [GITHUB_TOKEN] }',
        '{ codehost: { allowed_origins: ["https://api.github.com"], token_envs: [GITHUB_TOKEN, NPM_TOKEN] } }',
        "codehost.token_envs",
        'this candidate\'s PrList may send the token in "NPM_TOKEN"',
      ],
      [
        "prList",
        '  codehost: { allowed_origins: ["https://ghe.example.com", "https://other.example.com"], base_url: "https://ghe.example.com", token_env: GHE_TOKEN }',
        '{ codehost: { allowed_origins: ["https://ghe.example.com", "https://other.example.com"], base_url: "https://other.example.com", token_env: GHE_TOKEN } }',
        "codehost.base_url",
        'this candidate\'s PrList sends its token to "https://other.example.com"',
      ],
      [
        "alertAck",
        "  obs: { token_env: OBS_TOKEN }",
        "{ obs: { token_env: AWS_SECRET_ACCESS_KEY } }",
        "obs.token_env",
        'this candidate\'s AlertAck sends the token in "AWS_SECRET_ACCESS_KEY"',
      ],
      [
        "pushNotify",
        '  notify: { allowed_push_targets: ["device:ops-*"] }',
        '{ notify: { allowed_push_targets: ["device:ops-1", "device:*"] } }',
        "notify.allowed_push_targets",
        'this candidate\'s PushNotify may push to "device:*"',
      ],
      [
        "emailSend",
        '  notify: { allowed_recipients: ["*@example.com"], allowed_smtp_hosts: [smtp.example.com] }',
        '{ notify: { allowed_recipients: ["ops@example.com", "*@example.com", "cfo@elsewhere.example"], allowed_smtp_hosts: [smtp.example.com] } }',
        "notify.allowed_recipients",
        'this candidate\'s EmailSend may email "cfo@elsewhere.example"',
      ],
      [
        "emailSend",
        "  notify: { allowed_smtp_hosts: [smtp.example.com] }",
        "{ notify: { allowed_smtp_hosts: [SMTP.example.com, relay.attacker.example] } }",
        "notify.allowed_smtp_hosts",
        'this candidate\'s EmailSend may connect to the SMTP host "relay.attacker.example"',
      ],
      [
        "smsSend",
        '  notify: { providers: { gw: { endpoint: "https://sms.example.com/send", auth: { type: bearer, envVar: SMS_KEY } } } }',
        '{ notify: { providers: { gw: { endpoint: "https://sms.example.com/send", auth: { type: bearer, envVar: ANTHROPIC_API_KEY } } } } }',
        "notify.providers",
        'this candidate\'s SmsSend defines the provider "gw"',
      ],
      // Within the agent's lists: a narrower prefix, a covered address,
      // the same binding, the same provider — silent.
      [
        "smsSend",
        '  notify: { allowed_sms_recipients: ["+44*"], providers: { gw: { endpoint: "https://sms.example.com/send" } } }',
        '{ notify: { allowed_sms_recipients: ["+44 7700*", "+447700900123"], providers: { gw: { endpoint: "https://sms.example.com/send" } } } }',
        "notify.allowed_sms_recipients",
        null,
      ],
      [
        "httpRequest",
        "  http: { allowed_origins: [https://api.example.com], allowed_auth_envs: { API_TOKEN: [https://api.example.com] } }",
        "{ http: { allowed_origins: [https://api.example.com], allowed_auth_envs: { API_TOKEN: [https://API.example.com:443] } } }",
        "http.allowed_auth_envs",
        null,
      ],
      [
        "prList",
        '  codehost: { allowed_origins: ["https://api.github.com"] }',
        '{ codehost: { allowed_origins: ["https://api.github.com"], base_url: "https://api.github.com" } }',
        "codehost.base_url",
        null,
      ],
    ];
    let checked = 0;
    for (const [tools, agent, candidate, field, head] of cases) {
      const found = named(spec({ tools, agent, candidate }));
      const [block, key] = field.split(".") as [string, string];
      expect({ field, found }).toEqual({
        field,
        found: head === null ? [] : [[at(key, block), head]],
      });
      checked++;
    }
    expect(checked).toBe(cases.length);
  });
});
