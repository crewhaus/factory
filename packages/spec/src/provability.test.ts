/**
 * 0.8.0 (design/0.8.0-provability-release.md §3) — parse-level tests for the
 * `provability:` block:
 *   - the rung-name shorthand and the strict object form, on every carrier
 *     shape (cli / channel / managed / research / crew);
 *   - every enum, every numeric bound, the checker list's min-1 + uniqueness,
 *     and unknown-key rejection at every level of the object form;
 *   - strict-union rejection on every shape that does not carry the block;
 *   - the parse-time invariants, APPENDED after every existing cross-field
 *     check: `on_fail: escalate` without `agent.model_pool` on the interactive
 *     shapes, and an undeclared `judge.model` profile;
 *   - the `parseSpecIssues` union tie-breaker (`rootTypeMismatch`) this block
 *     introduced, which also sharpens one existing diagnostic (continuity).
 */
import { describe, expect, test } from "bun:test";
import {
  SPEC_PROVABILITY_LEVELS,
  SpecParseError,
  type SpecProvabilityBlock,
  parseSpec,
  parseSpecIssues,
  provabilityLevelOf,
  provabilityObjectOf,
} from "./index";

const cliWith = (block: string, agentExtra = ""): string =>
  [
    "name: c",
    "target: cli",
    "agent:",
    "  model: claude-sonnet-4-5",
    "  instructions: i",
    ...(agentExtra === "" ? [] : [agentExtra]),
    block,
  ].join("\n");

const channelWith = (block: string): string =>
  [
    "name: ch",
    "target: channel",
    "agent: { model: m, instructions: i }",
    "channels: { slack: { botToken: $SLACK_BOT_TOKEN, signingSecret: $SLACK_SIGNING_SECRET } }",
    "routing: { sessionKey: thread }",
    block,
  ].join("\n");

const managedWith = (block: string): string =>
  [
    "name: mg",
    "target: managed",
    "agent: { model: m, instructions: i }",
    "tenants:",
    "  - id: t1",
    "    budget: { maxInputTokens: 1, maxOutputTokens: 1 }",
    block,
  ].join("\n");

const researchWith = (block: string): string =>
  [
    "name: re",
    "target: research",
    "agent: { model: m, instructions: i }",
    "goal: learn",
    block,
  ].join("\n");

const crewWith = (block: string): string =>
  [
    "name: cr",
    "target: crew",
    "model: m",
    "entry: lead",
    "roles:",
    "  lead: { instructions: lead it }",
    block,
  ].join("\n");

const CARRIERS: ReadonlyArray<readonly [string, (block: string) => string]> = [
  ["cli", (b) => cliWith(b)],
  ["channel", channelWith],
  ["managed", managedWith],
  ["research", researchWith],
  ["crew", crewWith],
];

/** The `provability` value a parsed carrier spec holds. */
function provabilityOf(yaml: string): SpecProvabilityBlock | undefined {
  return (parseSpec(yaml) as { readonly provability?: SpecProvabilityBlock }).provability;
}

const POOL = [
  "  model_pool:",
  "    candidates:",
  "      - { model: claude-haiku-4-5, tags: [cheap] }",
  "      - { model: claude-opus-4-8, tags: [strong] }",
].join("\n");

const ESCALATE_MESSAGE =
  "provability.on_fail: escalate re-runs a failing turn on a stronger pool candidate (strategy.cascade.escalate_to, else the strongest candidate), so agent.model_pool must be declared";

describe("provability: — the shorthand and the object form on every carrier shape", () => {
  test("SPEC_PROVABILITY_LEVELS is the ladder, lowest first, off included", () => {
    expect([...SPEC_PROVABILITY_LEVELS]).toEqual(["off", "cited", "grounded", "checked", "proven"]);
  });

  for (const [shape, withBlock] of CARRIERS) {
    test(`${shape} accepts every rung name as shorthand`, () => {
      for (const level of SPEC_PROVABILITY_LEVELS) {
        expect(provabilityOf(withBlock(`provability: ${level}`))).toBe(level);
      }
    });

    test(`${shape} accepts the object form verbatim (no zod-materialised defaults)`, () => {
      // Defaults are the compiler's job (design §4.2): the parsed object is
      // exactly what the author wrote, so a round-trip never grows keys.
      expect(provabilityOf(withBlock("provability: { level: grounded }"))).toEqual({
        level: "grounded",
      });
    });
  }

  test("absent leaves the field undefined", () => {
    expect(provabilityOf(cliWith("permissions: { mode: auto }"))).toBeUndefined();
  });

  test("the full object form round-trips every field", () => {
    const yaml = cliWith(
      [
        "provability:",
        "  level: proven",
        "  on_fail: note",
        "  max_retries: 3",
        "  threshold: 0.75",
        "  scope: turn",
        "  assumptions: forbid",
        "  max_assumptions: 2",
        "  render: json",
        "  sources:",
        '    allow: ["*.gov", arxiv.org]',
        "    deny: [evil.example]",
        "    bibliographic: true",
        "    resolve: head",
        "  grounded: { coverage: 0.6, window_tokens: 120, independent: 2 }",
        "  execution: { allow: [all-money, -moneyRound, evaluate], replay: false, max_replays: 5 }",
        "  formal:",
        "    checkers: [lean4, builtin]",
        "    image: ghcr.io/acme/lean-mathlib:4.9",
        "    forbid: [sorry]",
        "    timeout_ms: 120000",
        "  judge: { model: claude-haiku-4-5, allow_self_judge: true }",
      ].join("\n"),
    );
    expect(provabilityOf(yaml)).toEqual({
      level: "proven",
      on_fail: "note",
      max_retries: 3,
      threshold: 0.75,
      scope: "turn",
      assumptions: "forbid",
      max_assumptions: 2,
      render: "json",
      sources: {
        allow: ["*.gov", "arxiv.org"],
        deny: ["evil.example"],
        bibliographic: true,
        resolve: "head",
      },
      grounded: { coverage: 0.6, window_tokens: 120, independent: 2 },
      execution: { allow: ["all-money", "-moneyRound", "evaluate"], replay: false, max_replays: 5 },
      formal: {
        checkers: ["lean4", "builtin"],
        image: "ghcr.io/acme/lean-mathlib:4.9",
        forbid: ["sorry"],
        timeout_ms: 120000,
      },
      judge: { model: "claude-haiku-4-5", allow_self_judge: true },
    });
  });

  test("provabilityLevelOf / provabilityObjectOf read both forms through one helper", () => {
    expect(provabilityLevelOf(undefined)).toBe("off");
    expect(provabilityLevelOf("checked")).toBe("checked");
    expect(provabilityLevelOf({ level: "cited", on_fail: "halt" })).toBe("cited");
    expect(provabilityObjectOf(undefined)).toBeUndefined();
    expect(provabilityObjectOf("grounded")).toBeUndefined();
    expect(provabilityObjectOf({ level: "off", threshold: 0.5 })).toEqual({
      level: "off",
      threshold: 0.5,
    });
  });
});

describe("provability: — every enum accepts its members and rejects anything else", () => {
  const enums: ReadonlyArray<readonly [string, ReadonlyArray<string>, string]> = [
    ["on_fail", ["retry", "halt", "note", "escalate"], "explode"],
    ["scope", ["session", "turn"], "forever"],
    ["assumptions", ["allow", "forbid"], "maybe"],
    ["render", ["footer", "none", "json"], "html"],
  ];
  for (const [key, members, bad] of enums) {
    test(`${key}: ${members.join(" | ")}`, () => {
      for (const member of members) {
        // escalate needs a pool on cli (the invariant tested below).
        const yaml = cliWith(
          `provability: { level: cited, ${key}: ${member} }`,
          member === "escalate" ? POOL : "",
        );
        expect(provabilityObjectOf(provabilityOf(yaml))?.[key as "scope"]).toBe(member as "turn");
      }
      expect(() => parseSpec(cliWith(`provability: { level: cited, ${key}: ${bad} }`))).toThrow(
        SpecParseError,
      );
    });
  }

  test("sources.resolve: off | head", () => {
    for (const member of ["off", "head"]) {
      expect(
        provabilityObjectOf(
          provabilityOf(cliWith(`provability: { level: cited, sources: { resolve: ${member} } }`)),
        )?.sources?.resolve,
      ).toBe(member as "head");
    }
    expect(() =>
      parseSpec(cliWith("provability: { level: cited, sources: { resolve: get } }")),
    ).toThrow(SpecParseError);
  });

  test("formal.checkers: builtin | smt | lean4, at least one, each once", () => {
    for (const checker of ["builtin", "smt", "lean4"]) {
      expect(
        provabilityObjectOf(
          provabilityOf(
            cliWith(`provability: { level: proven, formal: { checkers: [${checker}] } }`),
          ),
        )?.formal?.checkers,
      ).toEqual([checker as "smt"]);
    }
    expect(() =>
      parseSpec(cliWith("provability: { level: proven, formal: { checkers: [coq] } }")),
    ).toThrow(SpecParseError);
    expect(() =>
      parseSpec(cliWith("provability: { level: proven, formal: { checkers: [] } }")),
    ).toThrow(SpecParseError);
    const dupe = cliWith(
      "provability: { level: proven, formal: { checkers: [smt, builtin, smt] } }",
    );
    expect(() => parseSpec(dupe)).toThrow(
      "provability.formal.checkers lists a checker twice — each checker appears once",
    );
  });

  test("level is a rung name; the object form requires it", () => {
    expect(() => parseSpec(cliWith("provability: { level: verified }"))).toThrow(SpecParseError);
    expect(() => parseSpec(cliWith("provability: { on_fail: halt }"))).toThrow(SpecParseError);
    expect(() => parseSpec(cliWith("provability: verified"))).toThrow(
      "expected a rung name (off | cited | grounded | checked | proven) or an object { level: <rung>, … }",
    );
    expect(() => parseSpec(cliWith("provability: true"))).toThrow(SpecParseError);
  });
});

/** The message `parseSpec` throws for `yaml` (what compile / run / lint print). */
function parseMessage(yaml: string): string {
  try {
    parseSpec(yaml);
  } catch (err) {
    if (err instanceof SpecParseError) return err.message;
    throw err;
  }
  throw new Error("expected parseSpec to throw");
}

describe("provability: — parseSpec names the key that is wrong (compile / run / lint print this)", () => {
  // An enum or type error inside the object form fails the union as a whole,
  // and zod reports a union's own message; before the provability errorMap
  // read the object branch, every one of these printed the same generic line.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["{ level: cited, on_fail: retries }", "provability.on_fail: Invalid enum value"],
    ["{ level: grounding }", "provability.level: Invalid enum value"],
    [
      "{ level: proven, formal: { checkers: [z3] } }",
      "provability.formal.checkers.0: Invalid enum value. Expected 'builtin' | 'smt' | 'lean4', received 'z3'",
    ],
    ["{ level: cited, render: markdown }", "provability.render: Invalid enum value"],
    [
      "{ level: cited, sources: { allow: arxiv.org } }",
      "provability.sources.allow: Expected array",
    ],
    [
      "{ level: checked, execution: { replay: 'yes' } }",
      "provability.execution.replay: Expected boolean, received string",
    ],
  ];
  for (const [block, want] of cases) {
    test(`provability: ${block}`, () => {
      const message = parseMessage(cliWith(`provability: ${block}`));
      expect(message).toContain(want);
      expect(message).not.toContain("whose keys are all known");
    });
  }

  test("every failing key is named, and parseSpecIssues agrees on which", () => {
    const yaml = cliWith("provability: { level: cited, on_fail: retries, render: markdown }");
    const message = parseMessage(yaml);
    expect(message).toContain("provability.on_fail: Invalid enum value");
    expect(message).toContain("provability.render: Invalid enum value");
    // Two problems in the object branch used to lose to the shorthand
    // branch's ONE "expected a rung name, received object": a branch whose
    // type matched now always wins.
    expect(parseSpecIssues(yaml).map((i) => i.path.join("."))).toEqual([
      "provability.on_fail",
      "provability.render",
    ]);
  });

  test("an object form without level says the object form needs one, and that absent = off", () => {
    const message = parseMessage(cliWith("provability: { on_fail: halt }"));
    expect(message).toContain("provability.level: the object form must say which rung it sets");
    expect(message).toContain("an absent provability: block is off");
    expect(parseSpecIssues(cliWith("provability: { on_fail: halt }"))[0]?.path).toEqual([
      "provability",
      "level",
    ]);
  });

  test("a value that is neither a rung name nor an object says what it received", () => {
    expect(parseMessage(cliWith("provability: verified"))).toContain(
      'or an object { level: <rung>, … }, received "verified"',
    );
    expect(parseMessage(cliWith("provability: true"))).toContain("received boolean");
    expect(parseMessage(cliWith("provability: [cited]"))).toContain("received a list");
    expect(parseMessage(cliWith("provability: 3"))).toContain("received number");
    // An empty key (a block whose every child is commented out) is YAML null;
    // `typeof null` is "object", which once made this say "received object".
    const empty = parseMessage(cliWith("provability:\n#  level: grounded"));
    expect(empty).toContain("received nothing (an empty provability: key)");
    expect(empty).not.toContain("received object");
  });

  test("design §3's `formal.image: null` is refused with how to say 'no override'", () => {
    const message = parseMessage(
      cliWith("provability: { level: proven, formal: { checkers: [builtin, smt], image: null } }"),
    );
    expect(message).toContain(
      "provability.formal.image: expected a sandbox image name; omit the key to use the checker's default image",
    );
    expect(
      provabilityObjectOf(
        provabilityOf(cliWith("provability: { level: proven, formal: { checkers: [lean4] } }")),
      )?.formal?.image,
    ).toBeUndefined();
  });
});

describe("provability: — sources.allow / deny are host globs (design §3, §6.1)", () => {
  const sources = (list: "allow" | "deny", entries: ReadonlyArray<string>): string =>
    cliWith(
      `provability: { level: cited, sources: { ${list}: [${entries.map((e) => JSON.stringify(e)).join(", ")}] } }`,
    );

  test("a host, *.<host>, * and an IPv4 or punycode host are accepted, case-insensitively", () => {
    const ok = [
      "arxiv.org",
      "*.gov",
      "*",
      "docs.acme.example",
      "EVIL.Example",
      "93.184.216.34",
      "xn--bcher-kva.example",
      "my_host.internal",
    ];
    for (const list of ["allow", "deny"] as const) {
      expect(provabilityObjectOf(provabilityOf(sources(list, ok)))?.sources?.[list]).toEqual(ok);
    }
  });

  test("a URL, a port, a path, whitespace or a stray wildcard is refused, naming the entry", () => {
    const bad = [
      "https://evil.example/",
      "evil.example:443",
      "arxiv.org/abs",
      "https://x.com/a?b",
      "../../etc",
      " arxiv.org",
      "arxiv org",
      "evil.example\u0000",
      "*.",
      "a..b",
      ".gov",
      "docs.*.example",
      "**",
      "user@evil.example",
    ];
    for (const list of ["allow", "deny"] as const) {
      for (const entry of bad) {
        const message = parseMessage(sources(list, ["arxiv.org", entry]));
        expect({ list, entry, message }).toEqual({
          list,
          entry,
          message: expect.stringContaining(
            `provability.sources.${list}.1: ${JSON.stringify(entry)} is not a host glob`,
          ),
        });
      }
    }
  });

  test("a deny entry written as a URL cannot slip through and fail open", () => {
    // The host of a cited https://evil.example/x is `evil.example`; a deny
    // entry `https://evil.example/` would never equal it, so the author's
    // block would never fire. It is a parse error instead.
    expect(() => parseSpec(sources("deny", ["https://evil.example/"]))).toThrow(SpecParseError);
    expect(parseSpecIssues(sources("deny", ["https://evil.example/"]))).toEqual([
      {
        path: ["provability", "sources", "deny", 0],
        message:
          '"https://evil.example/" is not a host glob — deny entries are a host (arxiv.org), *.<host> (*.gov) or *, with no scheme, port, path or spaces',
        code: "custom",
      },
    ]);
  });
});

describe("provability: — numeric bounds", () => {
  /** [yaml fragment inside the block, accepted values, rejected values] */
  const bounds: ReadonlyArray<
    readonly [string, ReadonlyArray<string>, ReadonlyArray<string>, (v: string) => string]
  > = [
    ["max_retries", ["0", "5"], ["-1", "6", "1.5"], (v) => `max_retries: ${v}`],
    ["threshold", ["0", "1", "0.5"], ["-0.1", "1.1"], (v) => `threshold: ${v}`],
    ["max_assumptions", ["0", "40"], ["-1", "1.5"], (v) => `max_assumptions: ${v}`],
    ["grounded.coverage", ["0", "1"], ["-0.01", "1.01"], (v) => `grounded: { coverage: ${v} }`],
    [
      "grounded.window_tokens",
      ["4", "2000"],
      ["3", "2001", "60.5"],
      (v) => `grounded: { window_tokens: ${v} }`,
    ],
    [
      "grounded.independent",
      ["1", "5"],
      ["0", "6", "1.5"],
      (v) => `grounded: { independent: ${v} }`,
    ],
    [
      "execution.max_replays",
      ["1", "200"],
      ["0", "201", "2.5"],
      (v) => `execution: { max_replays: ${v} }`,
    ],
    [
      "formal.timeout_ms",
      ["1000", "600000"],
      ["999", "600001", "1500.5"],
      (v) => `formal: { timeout_ms: ${v} }`,
    ],
  ];
  for (const [label, ok, bad, render] of bounds) {
    test(`${label}: accepts ${ok.join(", ")}; rejects ${bad.join(", ")}`, () => {
      for (const v of ok) {
        expect(() =>
          parseSpec(cliWith(`provability: { level: grounded, ${render(v)} }`)),
        ).not.toThrow();
      }
      for (const v of bad) {
        expect(() => parseSpec(cliWith(`provability: { level: grounded, ${render(v)} }`))).toThrow(
          SpecParseError,
        );
      }
    });
  }

  test("empty strings are refused where a name is expected", () => {
    for (const fragment of [
      'sources: { allow: [""] }',
      'sources: { deny: [""] }',
      'execution: { allow: [""] }',
      'formal: { image: "" }',
      'formal: { forbid: [""] }',
      'judge: { model: "" }',
    ]) {
      expect(() => parseSpec(cliWith(`provability: { level: grounded, ${fragment} }`))).toThrow(
        SpecParseError,
      );
    }
  });
});

describe("provability: — strict at every level of the object form", () => {
  test("an unknown top-level key fails the build, naming it", () => {
    expect(() => parseSpec(cliWith("provability: { level: cited, treshold: 0.5 }"))).toThrow(
      "Unrecognized key(s) in object: 'treshold'",
    );
  });

  for (const sub of ["sources", "grounded", "execution", "formal", "judge"]) {
    test(`an unknown ${sub}.* key fails the build`, () => {
      const judgeModel = sub === "judge" ? "model: m, " : "";
      expect(() =>
        parseSpec(cliWith(`provability: { level: cited, ${sub}: { ${judgeModel}bogus: 1 } }`)),
      ).toThrow("Unrecognized key(s) in object: 'bogus'");
    });
  }

  test("judge.model is required inside a judge block", () => {
    expect(() =>
      parseSpec(cliWith("provability: { level: grounded, judge: { allow_self_judge: true } }")),
    ).toThrow(SpecParseError);
  });
});

describe("provability: — strict-union rejection on every shape that does not carry it", () => {
  const SHAPES: ReadonlyArray<readonly [string, string]> = [
    [
      "graph",
      [
        "name: g",
        "target: graph",
        "model: m",
        "entry: a",
        "nodes:",
        "  a: { instructions: hi }",
        "edges: []",
      ].join("\n"),
    ],
    [
      "workflow",
      [
        "name: wf",
        "target: workflow",
        "model: m",
        "steps:",
        "  - { name: s, instructions: i }",
      ].join("\n"),
    ],
    [
      "pipeline",
      [
        "name: p",
        "target: pipeline",
        "agent: { model: m, instructions: i }",
        "retrieve: { embedderModel: e }",
        "indexing:",
        "  documents:",
        "    - { id: d1, text: hello }",
      ].join("\n"),
    ],
    [
      "batch",
      [
        "name: b",
        "target: batch",
        "agent: { model: m, instructions: i }",
        "queue: { adapter: in-memory }",
      ].join("\n"),
    ],
    [
      "voice",
      [
        "name: v",
        "target: voice",
        "agent: { model: m, instructions: i }",
        "voice: { provider: openai }",
      ].join("\n"),
    ],
    ["browser", ["name: br", "target: browser", "agent: { model: m, instructions: i }"].join("\n")],
    [
      "eval",
      [
        "name: e",
        "target: eval",
        "agent: { model: m, instructions: i }",
        "dataset: { name: d, version: '1' }",
        "graders:",
        "  - { name: exact }",
      ].join("\n"),
    ],
    [
      "onchain",
      [
        "name: oc",
        "target: onchain",
        "agent: { model: m, instructions: i }",
        "chains:",
        "  - { id: base, kind: evm, rpcUrls: [$BASE_RPC_URL], finality: { kind: finalized } }",
        "triggers:",
        "  - { kind: block, chainId: base, scanIntervalMs: 5000 }",
      ].join("\n"),
    ],
    [
      "onchain-game",
      [
        "name: og",
        "target: onchain-game",
        "agent: { model: m, instructions: i }",
        "chain: { id: base, kind: evm, rpcUrls: [$BASE_RPC_URL], finality: { kind: finalized } }",
        "wallet: { id: w1, chainId: base, custody: local, keyRef: $WALLET_KEY }",
        "game:",
        "  contract: { id: game, chainId: base, address: '0x1', abiRef: 'abi://erc20' }",
        "  stateReader: getState",
      ].join("\n"),
    ],
  ];
  for (const [shape, yaml] of SHAPES) {
    test(`${shape} parses without the block and rejects it loudly`, () => {
      expect(() => parseSpec(yaml)).not.toThrow();
      expect(() => parseSpec(`${yaml}\nprovability: cited`)).toThrow(
        "Unrecognized key(s) in object: 'provability'",
      );
    });
  }
});

describe("provability: — parse-time invariants (crossFieldIssues, appended last)", () => {
  test("on_fail: escalate without agent.model_pool is refused on cli / channel / managed", () => {
    const block = "provability: { level: grounded, on_fail: escalate }";
    for (const yaml of [cliWith(block), channelWith(block), managedWith(block)]) {
      expect(parseSpecIssues(yaml)).toEqual([
        { path: ["provability", "on_fail"], message: ESCALATE_MESSAGE, code: "custom" },
      ]);
      expect(() => parseSpec(yaml)).toThrow(ESCALATE_MESSAGE);
    }
  });

  test("the wording matches the evaluation.on_fail: escalate check's", () => {
    const evaluation = parseSpecIssues(
      cliWith("evaluation:\n  grader: { type: contains, value: ok }\n  on_fail: escalate"),
    );
    expect(evaluation[0]?.message).toBe(ESCALATE_MESSAGE.replace("provability.", "evaluation."));
  });

  test("on_fail: escalate WITH a model_pool parses", () => {
    expect(
      parseSpecIssues(cliWith("provability: { level: grounded, on_fail: escalate }", POOL)),
    ).toEqual([]);
  });

  test("research and crew are not refused (their lowering degrades escalate to note)", () => {
    const block = "provability: { level: cited, on_fail: escalate }";
    expect(parseSpecIssues(researchWith(block))).toEqual([]);
    expect(parseSpecIssues(crewWith(block))).toEqual([]);
  });

  test("an inert level: off block with on_fail: escalate is accepted (the compiler warns instead)", () => {
    // Design §3: a `level: off` block with other keys set is accepted, and
    // the compiler reports `provability-inert-block` — an escalate that can
    // never run contradicts nothing.
    expect(parseSpecIssues(cliWith("provability: { level: off, on_fail: escalate }"))).toEqual([]);
  });

  test("judge.model naming an undeclared profile is refused; a declared one parses", () => {
    expect(
      parseSpecIssues(cliWith("provability: { level: grounded, judge: { model: $cheap } }")),
    ).toEqual([
      {
        path: ["provability", "judge", "model"],
        message:
          'provability.judge.model: unknown profile "$cheap" — this spec declares no models: block',
        code: "custom",
      },
    ]);
    const registry = "models:\n  cheap: { model: claude-haiku-4-5 }";
    expect(
      parseSpecIssues(
        `${cliWith("provability: { level: grounded, judge: { model: $cheap } }")}\n${registry}`,
      ),
    ).toEqual([]);
    // A near miss names the declared profile.
    const near = parseSpecIssues(
      `${cliWith("provability: { level: grounded, judge: { model: $chaep } }")}\n${registry}`,
    );
    expect(near[0]?.message).toContain('did you mean "$cheap"?');
  });

  test("an undeclared judge profile is refused at every level, off included (a typo is a typo)", () => {
    expect(
      parseSpecIssues(cliWith("provability: { level: off, judge: { model: $nope } }")),
    ).toHaveLength(1);
    expect(
      parseSpecIssues(crewWith("provability: { level: cited, judge: { model: $nope } }")),
    ).toHaveLength(1);
  });

  test("a self-judging waiver, sandbox-only checkers and a source-less grounded floor are NOT parse errors", () => {
    // They describe valid specs: `crewhaus lint` and the compiler say so.
    expect(
      parseSpecIssues(
        cliWith(
          [
            "provability:",
            "  level: grounded",
            "  formal: { checkers: [smt] }",
            "  judge: { model: claude-sonnet-4-5 }",
          ].join("\n"),
        ),
      ),
    ).toEqual([]);
  });

  test("the provability checks are APPENDED: an earlier cross-field issue keeps its place", () => {
    const yaml = cliWith(
      [
        "evaluation:",
        "  grader: { type: contains, value: ok }",
        "  on_fail: escalate",
        "provability: { level: cited, on_fail: escalate }",
      ].join("\n"),
    );
    const issues = parseSpecIssues(yaml);
    expect(issues.map((i) => i.path.join("."))).toEqual([
      "evaluation.on_fail",
      "provability.on_fail",
    ]);
    // parseSpec throws the FIRST issue — the 0.7.x one — unchanged.
    expect(() => parseSpec(yaml)).toThrow(ESCALATE_MESSAGE.replace("provability.", "evaluation."));
  });
});

describe("parseSpecIssues — the union tie-breaker prefers the branch whose TYPE matched", () => {
  test("an object with a bad level reports the level, not 'expected a string'", () => {
    expect(parseSpecIssues(cliWith("provability: { level: bogus }"))).toEqual([
      {
        path: ["provability", "level"],
        message:
          "Invalid enum value. Expected 'off' | 'cited' | 'grounded' | 'checked' | 'proven', received 'bogus'",
        code: "invalid_enum_value",
      },
    ]);
  });

  test("a bad rung name reports the enum, not 'expected an object'", () => {
    expect(parseSpecIssues(cliWith("provability: bogus"))).toEqual([
      {
        path: ["provability"],
        message:
          "Invalid enum value. Expected 'off' | 'cited' | 'grounded' | 'checked' | 'proven', received 'bogus'",
        code: "invalid_enum_value",
      },
    ]);
  });

  test("a deliberate diagnostics change for an existing union: continuity's object branch now wins", () => {
    // 0.7.x reported `continuity: Expected boolean, received object` for this
    // spec — the boolean branch, whose type cannot match an object. The
    // tie-breaker added for provability points at the field actually wrong.
    expect(parseSpecIssues(cliWith("continuity:\n  plan: yes-please"))).toEqual([
      {
        path: ["continuity", "plan"],
        message: "Expected boolean, received string",
        code: "invalid_type",
      },
    ]);
  });
});
