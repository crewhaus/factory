/**
 * 0.8.0 §11 — `crewhaus provability show|check|audit|checkers|prune`, driven
 * through `runProvabilityCommand` in temp harness directories with a fixed
 * clock, captured output streams and an injected sandbox: no container, no
 * network, no model.
 *
 * Bundles are produced by the real `verifyDocument` wherever the test is about
 * what the gate decided, and written by hand only where the test is about
 * what the audit makes of a decision (a replay mismatch, a judge waiver) that
 * a live tool or a live judge would have to produce.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proofsDirName } from "@crewhaus/evaluation-service";
import { openEventLog } from "@crewhaus/event-log";
import {
  MANAGED_TENANTS_ROOT_DEFAULT as HANGAR_MANAGED_TENANTS_ROOT_DEFAULT,
  isProofSpecDir,
} from "@crewhaus/hangar-server";
import { OVERRIDE_ENV_KEYS } from "@crewhaus/harness-supervisor";
import { type ParsedArgs, parseArgs } from "@crewhaus/infra-utils";
import {
  type ProofBundle,
  type ProvabilityConfig,
  buildEvidenceIndex,
  bundleHash,
  createBundleStore,
  createFileArtifactStore,
  newProofId,
  proofsRoot,
  recordFromCall,
  renderMarkdownSection,
  sha256Of,
  verifyDocument,
} from "@crewhaus/provability";
import { moneyAdd } from "@crewhaus/tool-math";
import { defaultProvabilityConfig } from "@crewhaus/tool-proof";
import { PROVABILITY_SCHEMA } from "./arg-schemas";
import {
  CHECK_NOTES,
  MANAGED_TENANTS_ROOT_DEFAULT,
  PROVABILITY_ACTIONS,
  PROVABILITY_USAGE,
  type ProvabilityCliDeps,
  ProvabilityCliError,
  RELOCATED_STATE_ROOTS,
  RESTATED_SIMILARITY,
  SHARED_EVIDENCE_MIN_CLAIMS,
  buildAudit,
  bundleProblem,
  parseDurationMs,
  parseSince,
  probeCheckers,
  provabilityDoctorChecks,
  renderAudit,
  renderBundleLong,
  reportTrailerAt,
  runProvabilityCommand,
  ttySafe,
} from "./provability-cli";

/** Any C0/C1 control but the line feed the renderers join lines with. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the assertion is that none reach the terminal
const TTY_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

const NOW = new Date("2026-10-22T12:00:00.000Z");
const DAY = 86_400_000;
const SESS_A = "sess_00000000000000aa";
const SESS_B = "sess_00000000000000bb";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempDir(prefix = "provability-cli-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

type Run = { readonly code: number; readonly out: string; readonly err: string };

function deps(
  cwd: string,
  over: Partial<ProvabilityCliDeps> = {},
): ProvabilityCliDeps & {
  readonly captured: { out: string; err: string };
} {
  const captured = { out: "", err: "" };
  return {
    cwd,
    env: {},
    now: () => NOW,
    out: (text) => {
      captured.out += text;
    },
    err: (text) => {
      captured.err += text;
    },
    // No container in a unit test: every sandbox checker is "unavailable".
    sandboxAvailable: false,
    ...over,
    captured,
  };
}

/** Parse argv as the entry file does (the verb already split off). */
function argsOf(argv: readonly string[]): ParsedArgs {
  return parseArgs([...argv], PROVABILITY_SCHEMA);
}

async function run(
  cwd: string,
  argv: readonly string[],
  over: Partial<ProvabilityCliDeps> = {},
): Promise<Run> {
  const [action = "", ...rest] = argv;
  const d = deps(cwd, over);
  const code = await runProvabilityCommand(action, argsOf(rest), d);
  return { code, out: d.captured.out, err: d.captured.err };
}

/** A grounded bundle the real verifier produced, plus the document it graded. */
async function gradedBundle(
  text: string,
  body: string,
  url = "https://acme.example/policy",
  level: ProvabilityConfig["level"] = "grounded",
): Promise<ProofBundle> {
  const evidence = buildEvidenceIndex([
    recordFromCall({
      toolUseId: "toolu_fetch1",
      toolName: "WebFetch",
      input: { url },
      content: `URL: ${url}\nStatus: 200\n\n${body}`,
      isError: false,
    }),
  ]);
  return verifyDocument(text, {
    config: { ...defaultProvabilityConfig(), level },
    evidence,
    now: () => NOW,
  });
}

const POLICY = "Customers may request a refund within 14 days of delivery for any unopened item.";
const GOOD_ANSWER =
  "Customers may request a refund within 14 days of delivery [1].\n\n[1]: https://acme.example/policy\n";
const BAD_ANSWER =
  "Customers may request a refund within 30 days of purchase for opened electronics [1].\n\n[1]: https://acme.example/policy\n";

async function persist(
  cwd: string,
  spec: string,
  session: string | undefined,
  turn: number,
  bundle: ProofBundle,
  mtimeMs?: number,
): Promise<string> {
  const path = await createBundleStore({ rootDir: proofsRoot(cwd, spec) }).put(bundle, {
    ...(session !== undefined ? { sessionId: session } : {}),
    turnNumber: turn,
  });
  if (mtimeMs !== undefined) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}

/** A hand-written bundle (for the audit), hashed like the real one. */
function handBundle(over: Partial<ProofBundle>): ProofBundle {
  const base: Omit<ProofBundle, "bundleHash"> = {
    version: 1,
    level: "grounded",
    verdict: "pass",
    score: 1,
    threshold: 1,
    achieved: "grounded",
    claims: [],
    claimCount: 0,
    met: 0,
    unmet: 0,
    assumptions: 0,
    sources: 0,
    judgeWaived: 0,
    retryIndex: 0,
    createdAt: NOW.toISOString(),
    ...over,
  };
  return { ...base, bundleHash: bundleHash(base) };
}

function writeSpec(cwd: string, name: string, extra = ""): string {
  const path = join(cwd, "crewhaus.yaml");
  writeFileSync(
    path,
    [
      `name: ${name}`,
      "target: cli",
      "agent:",
      "  model: claude-opus-5",
      "  instructions: answer with citations",
      "tools: [WebFetch, Read]",
      extra,
      "",
    ].join("\n"),
  );
  return path;
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

describe("dispatch", () => {
  test("a bare verb and --help print the usage and exit 0", async () => {
    const cwd = tempDir();
    for (const argv of [[], ["show", "--help"]]) {
      const r = await run(cwd, argv);
      expect(r.code).toBe(0);
      expect(r.out).toBe(PROVABILITY_USAGE);
    }
    for (const action of PROVABILITY_ACTIONS)
      expect(PROVABILITY_USAGE).toContain(`provability ${action}`);
  });

  test("an unknown verb is refused, naming the verbs", async () => {
    await expect(run(tempDir(), ["bogus"])).rejects.toThrow(
      /provability action must be one of: show, check, audit, checkers, prune/,
    );
  });

  test("a flag the verb does not read is refused rather than ignored", async () => {
    await expect(run(tempDir(), ["show", "--level", "grounded"])).rejects.toThrow(
      /provability show does not take --level/,
    );
    await expect(run(tempDir(), ["prune", "--session", SESS_A])).rejects.toThrow(
      /prune does not take --session/,
    );
  });

  test("positional counts are enforced per verb", async () => {
    await expect(run(tempDir(), ["check", "--level", "cited"])).rejects.toThrow(
      /expected exactly one <answer.md>/,
    );
    await expect(run(tempDir(), ["show", "a.yaml", "b.yaml"])).rejects.toThrow(
      /at most one <spec.yaml>/,
    );
  });

  test("errors are CrewhausErrors the entry file routes through die()", async () => {
    const err = await run(tempDir(), ["bogus"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvabilityCliError);
  });
});

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

describe("provability show", () => {
  test("no bundles: says where it looked and how bundles get there", async () => {
    await expect(run(tempDir(), ["show"])).rejects.toThrow(
      /no proof bundle under \.crewhaus\/proofs — bundles are written by a harness whose spec declares provability:/,
    );
  });

  test("defaults to the latest bundle, in long form", async () => {
    const cwd = tempDir();
    const old = await gradedBundle(BAD_ANSWER, POLICY);
    const latest = await gradedBundle(GOOD_ANSWER, POLICY);
    await persist(cwd, "support", SESS_A, 1, old, NOW.getTime() - 2 * DAY);
    await persist(cwd, "support", SESS_B, 4, latest, NOW.getTime() - DAY);
    const r = await run(cwd, ["show"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`proof bundle · .crewhaus/proofs/support/${SESS_B}/turn-4.json`);
    expect(r.out).toContain(`session     ${SESS_B} · turn 4`);
    expect(r.out).toContain("floor       grounded");
    expect(r.out).toContain("verdict     ✓ pass");
    expect(r.out).toContain("score       1/1 claim (100%, threshold 100%)");
    expect(r.out).toContain("achieved    grounded");
    expect(r.out).toContain("1. ✓ met · best grounded · line 1");
    expect(r.out).toContain("[1] ✓ source · rung grounded");
    expect(r.out).toContain("origin    https://acme.example/policy");
    expect(r.out).toContain('excerpt   "Customers may request a refund within 14 days of delivery');
    expect(r.out).toContain(`hash        ${latest.bundleHash}`);
    // The footer line closes the long form, with the bundle's own path.
    expect(r.out.trimEnd().split("\n").at(-1)).toBe(
      `── provability · grounded ✓ · 1/1 claim · 1 source · 0 assumptions · .crewhaus/proofs/support/${SESS_B}/turn-4.json`,
    );
  });

  test("an unmet claim shows its reason and the evidence it failed against", async () => {
    const cwd = tempDir();
    await persist(cwd, "support", SESS_A, 2, await gradedBundle(BAD_ANSWER, POLICY));
    const r = await run(cwd, ["show", "--session", SESS_A]);
    expect(r.out).toContain("verdict     ✗ fail");
    expect(r.out).toContain("1. ✗ unmet");
    expect(r.out).toMatch(/\[1\] ✗ source · rung cited · not found in source/);
    expect(r.out).toContain("why       ");
    expect(r.out).toContain("unmet: [1]");
  });

  test("--session and --turn select one bundle; --turn alone takes the newest such turn", async () => {
    const cwd = tempDir();
    const a1 = await gradedBundle(GOOD_ANSWER, POLICY);
    const a2 = await gradedBundle(BAD_ANSWER, POLICY);
    await persist(cwd, "support", SESS_A, 1, a1, NOW.getTime() - 3 * DAY);
    await persist(cwd, "support", SESS_A, 2, a2, NOW.getTime() - 2 * DAY);
    await persist(cwd, "support", SESS_B, 1, a2, NOW.getTime() - DAY);
    const one = await run(cwd, ["show", "--session", SESS_A, "--turn", "1", "--json"]);
    expect(JSON.parse(one.out)).toEqual(a1);
    const turnOnly = await run(cwd, ["show", "--turn", "1"]);
    expect(turnOnly.out).toContain(`${SESS_B}/turn-1.json`);
    await expect(run(cwd, ["show", "--session", SESS_A, "--turn", "9"])).rejects.toThrow(
      new RegExp(`no proof bundle for session ${SESS_A}, turn 9`),
    );
  });

  test("a retried turn keeps every pass: show reads the last, --pass the one named (the Hangar twin)", async () => {
    const cwd = tempDir();
    const failed = { ...(await gradedBundle(BAD_ANSWER, POLICY)), retryIndex: 0 };
    const fixed = { ...(await gradedBundle(GOOD_ANSWER, POLICY)), retryIndex: 1 };
    const first = await persist(cwd, "support", SESS_A, 1, failed);
    const second = await persist(cwd, "support", SESS_A, 1, fixed);
    expect(first).toEndWith("turn-1.json");
    expect(second).toEndWith("turn-1.2.json");
    const standing = await run(cwd, ["show", "--session", SESS_A, "--turn", "1", "--json"]);
    expect(JSON.parse(standing.out)).toEqual(fixed);
    const earlier = await run(cwd, [
      "show",
      "--session",
      SESS_A,
      "--turn",
      "1",
      "--pass",
      "1",
      "--json",
    ]);
    expect(earlier.out).toBe(readFileSync(first, "utf8"));
    const long = await run(cwd, ["show", "--session", SESS_A, "--turn", "1", "--pass", "2"]);
    expect(long.out).toContain(`session     ${SESS_A} · turn 1 · pass 2`);
    await expect(
      run(cwd, ["show", "--session", SESS_A, "--turn", "1", "--pass", "3"]),
    ).rejects.toThrow(new RegExp(`no proof bundle for session ${SESS_A}, turn 1, pass 3`));
    await expect(run(cwd, ["show", "--pass", "2"])).rejects.toThrow(/give --turn too/);
    await expect(run(cwd, ["show", "--turn", "1", "--pass", "0"])).rejects.toThrow(
      /invalid --pass "0"/,
    );
  });

  test("a proof's hypotheses are counted as assumptions, as the footer counts them", async () => {
    const cwd = tempDir();
    const proof = "prf_0123456789abcdef";
    await persist(
      cwd,
      "support",
      SESS_A,
      1,
      handBundle({
        level: "proven",
        achieved: "proven",
        claims: [],
        assumptions: 1,
        hypotheses: 2,
        checkers: [
          {
            id: "builtin",
            artifact: proof,
            axioms: [],
            assumptions: ["meeting 6 is cancelled", "rooms are booked by the hour"],
          },
        ],
      }),
    );
    const r = await run(cwd, ["show", "--session", SESS_A]);
    expect(r.out).toContain("assumptions 3 (2 proof hypotheses)");
    expect(r.out).toContain(
      `builtin — ${proof} · axioms: none · assumes: meeting 6 is cancelled; rooms are booked by the hour`,
    );
    expect(r.out).toContain("· 3 assumptions");
  });

  test("--json prints the bundle exactly as persisted (the Hangar route's twin)", async () => {
    const cwd = tempDir();
    const bundle = await gradedBundle(GOOD_ANSWER, POLICY);
    const path = await persist(cwd, "support", SESS_A, 3, bundle);
    const r = await run(cwd, ["show", "--session", SESS_A, "--turn", "3", "--json"]);
    expect(r.out).toBe(readFileSync(path, "utf8"));
    expect(JSON.parse(r.out)).toEqual(bundle);
  });

  test("a bundle of a run with no session is reachable as --session no-session", async () => {
    const cwd = tempDir();
    await persist(cwd, "support", undefined, 1, await gradedBundle(GOOD_ANSWER, POLICY));
    const r = await run(cwd, ["show", "--session", "no-session"]);
    expect(r.out).toContain(".crewhaus/proofs/support/no-session/turn-1.json");
  });

  test("a spec narrows the search to the proofs directory the gate files it under", async () => {
    const cwd = tempDir();
    // A name the store would refuse as a path segment is mapped, not refused.
    const spec = writeSpec(cwd, '"support bot"');
    const mapped = proofsDirName("support bot");
    expect(mapped).not.toBe("support bot");
    await persist(
      cwd,
      mapped,
      SESS_A,
      1,
      await gradedBundle(GOOD_ANSWER, POLICY),
      NOW.getTime() - DAY,
    );
    await persist(cwd, "other", SESS_B, 1, await gradedBundle(BAD_ANSWER, POLICY), NOW.getTime());
    const r = await run(cwd, ["show", spec]);
    expect(r.out).toContain(`.crewhaus/proofs/${mapped}/${SESS_A}/turn-1.json`);
    const all = await run(cwd, ["show"]);
    expect(all.out).toContain(`.crewhaus/proofs/other/${SESS_B}/turn-1.json`);
  });

  test("a malformed id is refused before any path is built", async () => {
    await expect(run(tempDir(), ["show", "--session", "../etc"])).rejects.toThrow(
      /invalid --session "\.\.\/etc"/,
    );
    await expect(run(tempDir(), ["show", "--turn", "-1"])).rejects.toThrow(/invalid --turn/);
  });

  test("a link planted in the proofs tree is not followed", async () => {
    const cwd = tempDir();
    const outside = tempDir("provability-outside-");
    await persist(outside, "support", SESS_A, 1, await gradedBundle(GOOD_ANSWER, POLICY));
    mkdirSync(join(cwd, ".crewhaus", "proofs"), { recursive: true });
    symlinkSync(
      join(outside, ".crewhaus", "proofs", "support"),
      join(cwd, ".crewhaus", "proofs", "support"),
    );
    await expect(run(cwd, ["show"])).rejects.toThrow(/no proof bundle/);
  });
});

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

function writeAnswer(cwd: string, text: string, name = "answer.md"): string {
  const path = join(cwd, name);
  writeFileSync(path, text);
  return path;
}

describe("provability check — evidence from a directory of fetched bodies", () => {
  test("a `URL:` first line names the body's page; a supported answer exits 0", async () => {
    const cwd = tempDir();
    const ev = join(cwd, "fetched");
    mkdirSync(ev);
    writeFileSync(join(ev, "policy.txt"), `URL: https://acme.example/policy\n${POLICY}\n`);
    writeAnswer(cwd, GOOD_ANSWER);
    const r = await run(cwd, [
      "check",
      "answer.md",
      "--level",
      "grounded",
      "--evidence",
      "fetched",
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("offline check · answer.md");
    expect(r.out).toContain("config      the defaults at --level grounded");
    expect(r.out).toContain("evidence    1 fetched body from fetched");
    expect(r.out).toContain("verdict     ✓ pass");
    expect(r.out).toContain("── provability · grounded ✓ · 1/1 claim");
  });

  test("a saved WebFetch result (URL/Status/Content-Type header) works as is", async () => {
    const cwd = tempDir();
    const ev = join(cwd, "fetched");
    mkdirSync(join(ev, "nested"), { recursive: true });
    writeFileSync(
      join(ev, "nested", "page.md"),
      `URL: https://acme.example/policy\nStatus: 200\nContent-Type: text/html\n\n${POLICY}\n`,
    );
    writeAnswer(cwd, GOOD_ANSWER);
    const r = await run(cwd, [
      "check",
      "answer.md",
      "--level",
      "grounded",
      "--evidence",
      ev,
      "--json",
    ]);
    expect(r.code).toBe(0);
    const bundle = JSON.parse(r.out) as ProofBundle;
    expect(bundle.verdict).toBe("pass");
    // The header is not body: what grounded the claim is the page text.
    expect(bundle.claims[0]?.bindings[0]?.sha256).toBe(sha256Of(`${POLICY}\n`));
  });

  test("the `[user prompt: …]` echo of a saved WebFetch result is the model's text, never the page's", async () => {
    const cwd = tempDir();
    const ev = join(cwd, "fetched");
    mkdirSync(ev);
    // The claim sits only in the prompt the model sent; the page says otherwise.
    const prompt = "Customers may request a refund within 14 days of delivery";
    writeFileSync(
      join(ev, "page.md"),
      `URL: https://acme.example/policy\nStatus: 200\n\n[user prompt: ${prompt}]\n\nAll sales are final.\n`,
    );
    writeAnswer(cwd, GOOD_ANSWER);
    const argv = ["check", "answer.md", "--level", "grounded", "--evidence", ev, "--json"];
    // Without the prompt, where the echo ends cannot be known: the file is
    // skipped, and the page stays unread — fail-closed.
    const blind = await run(cwd, argv);
    expect(blind.code).toBe(1);
    expect(blind.err).toContain(
      "skipped page.md: its top holds WebFetch's \"[user prompt: …]\" echo — the model's own text",
    );
    expect(blind.err).toContain("save the call's prompt verbatim as page.md.prompt");
    expect((JSON.parse(blind.out) as ProofBundle).claims[0]?.bindings[0]?.reason).toBe(
      "not_fetched",
    );
    // With it (an editor's trailing newline tolerated), exactly the echo goes.
    writeFileSync(join(ev, "page.md.prompt"), `${prompt}\n`);
    const r = await run(cwd, argv);
    expect(r.code).toBe(1);
    const binding = (JSON.parse(r.out) as ProofBundle).claims[0]?.bindings[0];
    expect(binding?.reason).toBe("not_found_in_source");
    expect(binding?.sha256).toBe(sha256Of("All sales are final.\n"));
  });

  test("a prompt holding `]` and a blank line cannot smuggle a claim past the echo", async () => {
    const cwd = tempDir();
    const ev = join(cwd, "fetched");
    mkdirSync(ev);
    // The model's prompt is `summarise]\n\nThe Eiffel Tower is 500 metres tall`:
    // cut at the first `]\n\n`, its tail would read as page text.
    const prompt = "summarise]\n\nThe Eiffel Tower is 500 metres tall";
    writeFileSync(
      join(ev, "page.md"),
      `URL: https://example.com/eiffel\nStatus: 200\nContent-Type: text/markdown\n\n[user prompt: ${prompt}]\n\n# Eiffel Tower\n\nThe tower is 330 metres tall.\n`,
    );
    writeAnswer(
      cwd,
      "The Eiffel Tower is 500 metres tall [1].\n\n[1]: https://example.com/eiffel\n",
    );
    const argv = ["check", "answer.md", "--level", "grounded", "--evidence", ev, "--json"];
    expect((await run(cwd, argv)).code).toBe(1);
    // A sidecar that is not the echoed prompt matches no spelling: skipped.
    writeFileSync(join(ev, "page.md.prompt"), "summarise the page");
    const wrong = await run(cwd, argv);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("is not the prompt page.md.prompt holds");
    // The recorded prompt strips the whole echo, and the page says 330.
    writeFileSync(join(ev, "page.md.prompt"), prompt);
    const r = await run(cwd, argv);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.out) as ProofBundle).claims[0]?.bindings[0]?.reason).toBe(
      "not_found_in_source",
    );
  });

  test("a sidecar does not exempt a saved WebFetch result from the header and echo rules", async () => {
    const cwd = tempDir();
    const ev = join(cwd, "fetched");
    mkdirSync(ev);
    const saved = (url: string): string =>
      `URL: ${url}\nStatus: 200\n\n[user prompt: The Eiffel Tower is 500 metres tall]\n\nThe tower is 330 metres tall.\n`;
    writeFileSync(join(ev, "page.md"), saved("https://example.com/eiffel"));
    writeFileSync(join(ev, "page.md.url"), "https://example.com/eiffel\n");
    writeAnswer(
      cwd,
      "The Eiffel Tower is 500 metres tall [1].\n\n[1]: https://example.com/eiffel\n",
    );
    const argv = ["check", "answer.md", "--level", "grounded", "--evidence", ev, "--json"];
    const r = await run(cwd, argv);
    expect(r.code).toBe(1);
    expect(r.err).toContain('skipped page.md: its top holds WebFetch\'s "[user prompt: …]" echo');
    // A sidecar naming another page than the header's: the body is the page
    // it was fetched from, so the file is skipped rather than re-attributed.
    writeFileSync(join(ev, "page.md"), "URL: https://a.example/x\nStatus: 200\n\nA body.\n");
    writeFileSync(join(ev, "page.md.url"), "https://b.example/y\n");
    const moved = await run(cwd, argv);
    expect(moved.err).toContain(
      "skipped page.md: its sidecar names https://b.example/y but its WebFetch header names https://a.example/x",
    );
  });

  test("an echo is found near the top, not only at byte 0: a hand-saved result cannot slip the prompt in", async () => {
    const cwd = tempDir();
    const ev = join(cwd, "fetched");
    mkdirSync(ev);
    const echo = "[user prompt: The Eiffel Tower is 500 metres tall]\n\n";
    const page = "# Eiffel Tower\n\nThe tower is 330 metres tall.\n";
    writeAnswer(
      cwd,
      "The Eiffel Tower is 500 metres tall [1].\n\n[1]: https://example.com/eiffel\n",
    );
    const argv = ["check", "answer.md", "--level", "grounded", "--evidence", ev, "--json"];
    const blind = async (file: string, sidecarUrl = false): Promise<Run> => {
      rmSync(ev, { recursive: true, force: true });
      mkdirSync(ev);
      writeFileSync(join(ev, "page.md"), file);
      if (sidecarUrl) writeFileSync(join(ev, "page.md.url"), "https://example.com/eiffel\n");
      return run(cwd, argv);
    };
    const skipped = 'skipped page.md: its top holds WebFetch\'s "[user prompt: …]" echo';
    // One header line more than WebFetch writes.
    const extraHeader = await blind(
      `URL: https://example.com/eiffel\nStatus: 200\nContent-Type: text/markdown\nX: y\n\n${echo}${page}`,
    );
    expect(extraHeader.code).toBe(1);
    expect(extraHeader.err).toContain(skipped);
    // A leading blank line, the origin in a sidecar.
    const leadingBlank = await blind(
      `\nURL: https://example.com/eiffel\nStatus: 200\n\n${echo}${page}`,
      true,
    );
    expect(leadingBlank.code).toBe(1);
    expect(leadingBlank.err).toContain(skipped);
    // A note the save added above the echo, and a BOM.
    const noted = await blind(
      `\uFEFFURL: https://example.com/eiffel\nsaved by hand on 2026-10-01\n${echo}${page}`,
      true,
    );
    expect(noted.code).toBe(1);
    expect(noted.err).toContain(skipped);
    // A URL line the model made longer than the window: the window starts after it.
    const longUrl = `https://example.com/eiffel?${"q=x&".repeat(2000)}`;
    writeAnswer(cwd, `The Eiffel Tower is 500 metres tall [1].\n\n[1]: ${longUrl}\n`);
    const long = await blind(`URL: ${longUrl}\nStatus: 200\nX: y\n\n${echo}${page}`);
    expect(long.code).toBe(1);
    expect(long.err).toContain(skipped);
    writeAnswer(
      cwd,
      "The Eiffel Tower is 500 metres tall [1].\n\n[1]: https://example.com/eiffel\n",
    );

    // With the prompt recorded, the echo and everything above it go: the page says 330.
    await blind(
      `URL: https://example.com/eiffel\nStatus: 200\nContent-Type: text/markdown\nX: y\n\n${echo}${page}`,
    );
    writeFileSync(join(ev, "page.md.prompt"), "The Eiffel Tower is 500 metres tall");
    const stripped = await run(cwd, argv);
    expect(stripped.code).toBe(1);
    const binding = (JSON.parse(stripped.out) as ProofBundle).claims[0]?.bindings[0];
    expect(binding?.reason).toBe("not_found_in_source");
    expect(binding?.sha256).toBe(sha256Of(page));
    // A second echo after it is model text the one sidecar cannot delimit.
    writeFileSync(
      join(ev, "page.md"),
      `URL: https://example.com/eiffel\nStatus: 200\n\n${echo}${echo}${page}`,
    );
    const twice = await run(cwd, argv);
    expect(twice.code).toBe(1);
    expect(twice.err).toContain(
      'skipped page.md: a second "[user prompt: …]" echo follows the one page.md.prompt accounts for',
    );
  });

  test("an echo opening deep in a page is page text, not a header's", async () => {
    const cwd = tempDir();
    const ev = join(cwd, "fetched");
    mkdirSync(ev);
    // A page about WebFetch that quotes the echo far below its top.
    writeFileSync(
      join(ev, "page.md"),
      `URL: https://acme.example/policy\nStatus: 200\n\n${POLICY}\n\n${"Filler prose. ".repeat(400)}\n[user prompt: quoted in the docs]\n`,
    );
    writeAnswer(cwd, GOOD_ANSWER);
    const r = await run(cwd, ["check", "answer.md", "--level", "grounded", "--evidence", ev]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("skipped");
  });

  test("a body that itself opens with a WebFetch header never names a second origin", async () => {
    const cwd = tempDir();
    const ev = join(cwd, "fetched");
    mkdirSync(ev);
    // A page (or a doubly saved result) whose TEXT begins like a header for
    // another URL: the file is the page of its own URL line, nothing else.
    writeFileSync(
      join(ev, "page.md"),
      "URL: https://attacker.example/a\nStatus: 200\n\nURL: https://acme.example/policy\nStatus: 200\n\nCustomers may request a refund within 14 days of delivery.\n",
    );
    writeAnswer(cwd, GOOD_ANSWER);
    const r = await run(cwd, [
      "check",
      "answer.md",
      "--level",
      "grounded",
      "--evidence",
      ev,
      "--json",
    ]);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.out) as ProofBundle).claims[0]?.bindings[0]?.reason).toBe("not_fetched");
  });

  test("a sidecar <file>.url names the page when the body has no header; doi: works too", async () => {
    const cwd = tempDir();
    const ev = join(cwd, "fetched");
    mkdirSync(ev);
    writeFileSync(join(ev, "page.html"), `${POLICY}\n`);
    writeFileSync(join(ev, "page.html.url"), "\n  https://acme.example/policy  \n");
    writeFileSync(
      join(ev, "paper.txt"),
      "The study measured a 12 percent reduction in churn across cohorts.\n",
    );
    writeFileSync(join(ev, "paper.txt.url"), "doi:10.1000/xyz123\n");
    writeAnswer(
      cwd,
      "Customers may request a refund within 14 days of delivery [1]. The study measured a 12 percent reduction in churn [2].\n\n[1]: https://acme.example/policy\n[2]: doi:10.1000/xyz123\n",
    );
    const r = await run(cwd, [
      "check",
      "answer.md",
      "--level",
      "grounded",
      "--evidence",
      ev,
      "--json",
    ]);
    const bundle = JSON.parse(r.out) as ProofBundle;
    expect(bundle.claims.map((c) => c.status)).toEqual(["met", "met"]);
    expect(r.code).toBe(0);
  });

  test("a file with no origin is skipped with a note, and its page stays not_fetched (fail-closed)", async () => {
    const cwd = tempDir();
    const ev = join(cwd, "fetched");
    mkdirSync(ev);
    writeFileSync(join(ev, "anonymous.txt"), `${POLICY}\n`);
    writeFileSync(join(ev, ".hidden"), "URL: https://acme.example/policy\nignored\n");
    writeAnswer(cwd, GOOD_ANSWER);
    const r = await run(cwd, ["check", "answer.md", "--level", "grounded", "--evidence", ev]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      'skipped anonymous.txt: no anonymous.txt.url sidecar and no "URL: <url>" first line',
    );
    expect(r.out).toContain("not fetched");
  });

  test("a sidecar naming something that is not a URL skips its body", async () => {
    const cwd = tempDir();
    const ev = join(cwd, "fetched");
    mkdirSync(ev);
    writeFileSync(join(ev, "page.txt"), `${POLICY}\n`);
    writeFileSync(join(ev, "page.txt.url"), "ftp://acme.example/policy\n");
    writeAnswer(cwd, GOOD_ANSWER);
    const r = await run(cwd, [
      "check",
      "answer.md",
      "--level",
      "grounded",
      "--evidence",
      ev,
      "--json",
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('skipped page.txt: its sidecar names "ftp://acme.example/policy"');
  });

  test("an answer the source does not support exits 1 with the reason", async () => {
    const cwd = tempDir();
    const ev = join(cwd, "fetched");
    mkdirSync(ev);
    writeFileSync(join(ev, "policy.txt"), `URL: https://acme.example/policy\n${POLICY}\n`);
    writeAnswer(cwd, BAD_ANSWER);
    const r = await run(cwd, [
      "check",
      "answer.md",
      "--level",
      "grounded",
      "--evidence",
      ev,
      "--json",
    ]);
    expect(r.code).toBe(1);
    const bundle = JSON.parse(r.out) as ProofBundle;
    expect(bundle.verdict).toBe("fail");
    expect(bundle.claims[0]?.bindings[0]?.reason).toBe("not_found_in_source");
  });

  test("the document is never its own evidence — inside the --evidence directory, hard-linked or copied", async () => {
    const cwd = tempDir();
    const out = join(cwd, "out");
    mkdirSync(out);
    // A report that opens with a `URL:` line, saved beside the bodies it was written from.
    const report =
      "URL: https://example.com/policy\n\nEvery customer gets a free car [1].\n\n[1]: https://example.com/policy\n";
    writeFileSync(join(out, "report.md"), report);
    writeFileSync(
      join(out, "page1.md"),
      "URL: https://example.com/other\n\nSomething unrelated.\n",
    );
    writeSpec(cwd, "self-cite", "provability:\n  level: grounded\n  threshold: 0.5\n");
    const argv = ["check", "out/report.md", "--spec", "crewhaus.yaml", "--evidence", "out"];
    const self = await run(cwd, [...argv, "--json"]);
    expect(self.code).toBe(1);
    expect(self.err).toContain(
      "--evidence: skipped report.md: it is the document itself — a document cannot ground its own claims",
    );
    const claim = (JSON.parse(self.out) as ProofBundle).claims.find((c) =>
      c.text.includes("free car"),
    );
    expect(claim?.status).toBe("unmet");
    expect(claim?.bindings[0]?.reason).toBe("not_fetched");

    // A hard link is the same file.
    rmSync(join(out, "report.md"));
    writeFileSync(join(cwd, "report.md"), report);
    linkSync(join(cwd, "report.md"), join(out, "report-link.md"));
    const hard = await run(cwd, [
      "check",
      "report.md",
      "--spec",
      "crewhaus.yaml",
      "--evidence",
      "out",
    ]);
    expect(hard.code).toBe(1);
    expect(hard.out).toContain("skipped report-link.md: it is the document itself");

    // A copy, whole or as the body under a header the save added.
    rmSync(join(out, "report-link.md"));
    writeFileSync(join(out, "copy.md"), report);
    const copy = await run(cwd, [
      "check",
      "report.md",
      "--spec",
      "crewhaus.yaml",
      "--evidence",
      "out",
    ]);
    expect(copy.code).toBe(1);
    expect(copy.out).toContain("skipped copy.md: it is a copy of the document");
    rmSync(join(out, "copy.md"));
    const plain = "Every customer gets a free car [1].\n\n[1]: https://example.com/policy\n";
    writeFileSync(join(cwd, "plain.md"), plain);
    writeFileSync(
      join(out, "wrapped.md"),
      `URL: https://example.com/policy\nStatus: 200\n\n${plain}`,
    );
    const wrapped = await run(cwd, [
      "check",
      "plain.md",
      "--level",
      "grounded",
      "--evidence",
      "out",
    ]);
    expect(wrapped.code).toBe(1);
    expect(wrapped.out).toContain("skipped wrapped.md: it is a copy of the document");
  });

  test("--evidence that is not a directory is an input error", async () => {
    const cwd = tempDir();
    writeAnswer(cwd, GOOD_ANSWER);
    await expect(
      run(cwd, ["check", "answer.md", "--level", "grounded", "--evidence", "nope"]),
    ).rejects.toThrow(/--evidence nope: no such directory/);
    await expect(
      run(cwd, ["check", "answer.md", "--level", "grounded", "--evidence", "answer.md"]),
    ).rejects.toThrow(/not a directory/);
  });
});

describe("provability check — workspace files cited by path are read directly", () => {
  test("a cited workspace file grounds its claim with no run behind it", async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, "docs"));
    writeFileSync(
      join(cwd, "docs", "pricing.md"),
      "The Pro plan costs 49 dollars per seat each month.\n",
    );
    writeAnswer(
      cwd,
      "The Pro plan costs 49 dollars per seat each month [1].\n\n[1]: ./docs/pricing.md#plans\n",
    );
    const r = await run(cwd, ["check", "answer.md", "--level", "grounded"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("evidence    1 workspace file read directly");
    expect(r.out).toContain("origin    docs/pricing.md");
  });

  test("a path outside the workspace is never read, and the verifier says so", async () => {
    const cwd = tempDir();
    const outside = tempDir("provability-secret-");
    writeFileSync(
      join(outside, "secret.md"),
      "The Pro plan costs 49 dollars per seat each month.\n",
    );
    writeAnswer(
      cwd,
      `The Pro plan costs 49 dollars per seat each month [1].\n\n[1]: ${join(outside, "secret.md")}\n`,
    );
    const r = await run(cwd, ["check", "answer.md", "--level", "grounded", "--json"]);
    expect(r.code).toBe(1);
    const bundle = JSON.parse(r.out) as ProofBundle;
    expect(bundle.claims[0]?.bindings[0]?.reason).toBe("path_outside_workspace");
  });

  test("a workspace file linked out of the workspace is not read", async () => {
    const cwd = tempDir();
    const outside = tempDir("provability-secret-");
    writeFileSync(
      join(outside, "secret.md"),
      "The Pro plan costs 49 dollars per seat each month.\n",
    );
    symlinkSync(join(outside, "secret.md"), join(cwd, "pricing.md"));
    writeAnswer(
      cwd,
      "The Pro plan costs 49 dollars per seat each month [1].\n\n[1]: ./pricing.md\n",
    );
    const r = await run(cwd, ["check", "answer.md", "--level", "grounded", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).claims[0].bindings[0].reason).toBe("path_outside_workspace");
  });

  test("at cited, a citation's grammar alone is checked: no definition fails", async () => {
    const cwd = tempDir();
    writeAnswer(cwd, "The refund window is fourteen days for every order [1].\n");
    const r = await run(cwd, ["check", "answer.md", "--level", "cited", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).claims[0].bindings[0].reason).toBe("no_definition");
    expect(r.err).toBe("");
  });

  test("under --json, reading workspace files directly is said on stderr", async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, "docs"));
    writeFileSync(join(cwd, "docs", "policy.md"), "The refund window is 30 days for all orders.\n");
    writeAnswer(cwd, "The refund window is 30 days [1].\n\n[1]: docs/policy.md\n");
    const r = await run(cwd, ["check", "answer.md", "--level", "grounded", "--json"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain(`note: ${CHECK_NOTES.workspace(1)}\n`);
    expect(CHECK_NOTES.workspace(1)).toContain("read directly from disk");
  });

  test("a document never grounds itself — by path, through a link, as a hard link or a copy", async () => {
    const cwd = tempDir();
    const report = (cite: string): string =>
      `The sky is green [1]. Every customer gets a free car [1].\n\n[1]: ./${cite}\n`;
    const check = (doc: string) => run(cwd, ["check", doc, "--level", "grounded", "--json"]);

    writeFileSync(join(cwd, "r.md"), report("r.md"));
    const self = await run(cwd, ["check", "r.md", "--level", "grounded"]);
    expect(self.code).toBe(1);
    expect(self.out).toContain(
      "note        r.md is the document itself — a document cannot ground its own claims",
    );
    expect(self.out).toContain("evidence    none");
    expect(self.out).toContain("not fetched");

    writeFileSync(join(cwd, "s.md"), report("s-link.md"));
    symlinkSync(join(cwd, "s.md"), join(cwd, "s-link.md"));
    const viaLink = await check("s.md");
    expect(viaLink.code).toBe(1);
    expect(viaLink.err).toContain("s-link.md is the document itself");

    writeFileSync(join(cwd, "h.md"), report("h-hard.md"));
    linkSync(join(cwd, "h.md"), join(cwd, "h-hard.md"));
    const viaHard = await check("h.md");
    expect(viaHard.code).toBe(1);
    expect(viaHard.err).toContain("h-hard.md is the document itself");

    writeFileSync(join(cwd, "c.md"), report("c-copy.md"));
    writeFileSync(join(cwd, "c-copy.md"), report("c-copy.md"));
    const copy = await check("c.md");
    expect(copy.code).toBe(1);
    expect(copy.err).toContain("c-copy.md is a copy of the document");
    expect((JSON.parse(copy.out) as ProofBundle).claims.map((c) => c.status)).toEqual([
      "unmet",
      "unmet",
    ]);
  });

  test("a copy of a document that opens with a UTF-8 BOM is still a copy — cited by path or in --evidence, with or without the BOM", async () => {
    // Evidence and workspace files are decoded the way openForRead decodes,
    // which drops a leading BOM; the document must be read the same way or a
    // byte-identical copy of it stops comparing equal and grounds every claim.
    const cwd = tempDir();
    const BOM = "﻿";
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
    expect(bytes(`${BOM}x`).subarray(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));

    // Cited by path: the copy byte for byte, then the copy with the BOM taken off.
    const doc = "The sky is green [1].\n\n[1]: ./c-copy.md\n";
    writeFileSync(join(cwd, "c.md"), bytes(`${BOM}${doc}`));
    for (const copyText of [`${BOM}${doc}`, doc]) {
      writeFileSync(join(cwd, "c-copy.md"), bytes(copyText));
      const cited = await run(cwd, ["check", "c.md", "--level", "grounded", "--json"]);
      expect(cited.code).toBe(1);
      expect(cited.err).toContain(
        "c-copy.md is a copy of the document — a document cannot ground its own claims",
      );
      const claim = (JSON.parse(cited.out) as ProofBundle).claims[0];
      expect(claim?.status).toBe("unmet");
      expect(claim?.bindings[0]?.reason).toBe("not_fetched");
    }

    // In --evidence: a report whose first line names the page it was written from.
    const out = join(cwd, "out");
    mkdirSync(out);
    const report =
      "URL: https://example.com/policy\n\nEvery customer gets a free car [1].\n\n[1]: https://example.com/policy\n";
    writeFileSync(join(cwd, "report.md"), bytes(`${BOM}${report}`));
    writeSpec(cwd, "bom-copy", "provability:\n  level: grounded\n  threshold: 0.5\n");
    for (const copyText of [`${BOM}${report}`, report]) {
      writeFileSync(join(out, "copy.md"), bytes(copyText));
      const r = await run(cwd, [
        "check",
        "report.md",
        "--spec",
        "crewhaus.yaml",
        "--evidence",
        "out",
      ]);
      expect(r.code).toBe(1);
      expect(r.out).toContain(
        "skipped copy.md: it is a copy of the document — a document cannot ground its own claims",
      );
      expect(r.out).toContain("evidence    0 fetched bodies from out");
      expect(r.out).not.toContain("✓ pass");
    }

    // In --evidence under a header the save added: the BOM is then mid-file,
    // where no decoder drops it, so the body opens with U+FEFF. It is still
    // the document — whether or not the document itself opens with a BOM.
    rmSync(join(out, "copy.md"));
    const plain = "Every customer gets a free car [1].\n\n[1]: https://example.com/policy\n";
    for (const docText of [`${BOM}${plain}`, plain]) {
      writeFileSync(join(cwd, "plain.md"), bytes(docText));
      for (const header of [
        "URL: https://example.com/policy\nStatus: 200\n\n",
        "URL: https://example.com/policy\n",
      ]) {
        writeFileSync(join(out, "wrapped.md"), bytes(`${header}${BOM}${plain}`));
        const r = await run(cwd, [
          "check",
          "plain.md",
          "--spec",
          "crewhaus.yaml",
          "--evidence",
          "out",
        ]);
        expect(r.code).toBe(1);
        expect(r.out).toContain(
          "skipped wrapped.md: it is a copy of the document — a document cannot ground its own claims",
        );
        expect(r.out).toContain("evidence    0 fetched bodies from out");
        expect(r.out).not.toContain("✓ pass");
      }
    }
  });

  test("a copy under a header is caught however its origin is named: a sidecar, a bare URL: line, extra BOMs", async () => {
    // The W3-D residual: with a <file>.url sidecar a bare `URL:` first line is
    // page, so the body compared was the whole file — header line and all —
    // and a second BOM ahead of the header hid it from the header parser.
    const cwd = tempDir();
    const BOM = "﻿";
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
    const plain = "Every customer gets a free car [1].\n\n[1]: https://example.com/policy\n";
    writeFileSync(join(cwd, "plain.md"), bytes(plain));
    const out = join(cwd, "out");
    mkdirSync(out);
    const url = "https://example.com/policy";
    // [the saved file, whether a <file>.url sidecar names the origin]
    const cases: ReadonlyArray<readonly [string, boolean]> = [
      [`URL: ${url}\n${plain}`, true],
      [`URL: ${url}\n${BOM}${plain}`, true],
      [`${BOM}${BOM}URL: ${url}\nStatus: 200\n\n${plain}`, true],
      [`${BOM}${BOM}URL: ${url}\nStatus: 200\n\n${BOM}${plain}`, false],
      [`${BOM}${BOM}URL: ${url}\n${plain}`, false],
    ];
    for (const [file, sidecar] of cases) {
      rmSync(out, { recursive: true, force: true });
      mkdirSync(out);
      writeFileSync(join(out, "wrapped.md"), bytes(file));
      if (sidecar) writeFileSync(join(out, "wrapped.md.url"), `${url}\n`);
      const r = await run(cwd, ["check", "plain.md", "--level", "grounded", "--evidence", "out"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain(
        "skipped wrapped.md: it is a copy of the document — a document cannot ground its own claims",
      );
      expect(r.out).not.toContain("✓ pass");
    }
    // A real page under the same shapes still grounds: only a copy is refused.
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out);
    writeFileSync(
      join(out, "page.md"),
      bytes(`${BOM}${BOM}URL: ${url}\nStatus: 200\n\nEvery customer gets a free car.\n`),
    );
    const page = await run(cwd, ["check", "plain.md", "--level", "grounded", "--evidence", "out"]);
    expect(page.code).toBe(0);
  });

  test("nothing under .crewhaus/ or the session-log directory is read — it holds the model's own words", async () => {
    const cwd = tempDir();
    const claim = "The refund window is 90 days for every order";
    mkdirSync(join(cwd, ".crewhaus", "sessions"), { recursive: true });
    writeFileSync(
      join(cwd, ".crewhaus", "sessions", `${SESS_A}.jsonl`),
      `${JSON.stringify({ kind: "assistant_message", payload: { text: claim } })}\n`,
    );
    writeAnswer(cwd, `${claim} [1].\n\n[1]: .crewhaus/sessions/${SESS_A}.jsonl\n`);
    const r = await run(cwd, ["check", "answer.md", "--level", "grounded", "--json"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      `.crewhaus/sessions/${SESS_A}.jsonl is not read: session logs, bundles and state under .crewhaus/ hold the model's own text`,
    );
    expect((JSON.parse(r.out) as ProofBundle).claims[0]?.bindings[0]?.reason).toBe("not_fetched");

    // A relocated session directory (CREWHAUS_SESSION_DIR) is the same.
    mkdirSync(join(cwd, "logs"));
    writeFileSync(join(cwd, "logs", "sess.jsonl"), `${claim}.\n`);
    writeAnswer(cwd, `${claim} [1].\n\n[1]: logs/sess.jsonl\n`);
    const moved = await run(cwd, ["check", "answer.md", "--level", "grounded", "--json"], {
      env: { CREWHAUS_SESSION_DIR: "logs" },
    });
    expect(moved.code).toBe(1);
    expect(moved.err).toContain("logs/sess.jsonl is not read");
    // …and outside that, the same file is ordinary workspace evidence.
    expect((await run(cwd, ["check", "answer.md", "--level", "grounded"])).code).toBe(0);
  });

  test("a tenants root, the knowledge store and every relocated state root are refused too", async () => {
    const cwd = tempDir();
    const claim = "The sky is green";
    const cite = (path: string): string => writeAnswer(cwd, `${claim} [1].\n\n[1]: ./${path}\n`);
    const assistant = `${JSON.stringify({ v: 1, kind: "assistant_message", payload: { text: `${claim}.` } })}\n`;
    const check = (env: Record<string, string> = {}) =>
      run(cwd, ["check", "answer.md", "--level", "grounded", "--json"], { env });

    // A managed daemon's tenants root inside the harness directory (Hangar reads it there).
    mkdirSync(join(cwd, "tenants", "acme", "sessions"), { recursive: true });
    const tenantLog = `tenants/acme/sessions/${SESS_A}.jsonl`;
    writeFileSync(join(cwd, tenantLog), assistant);
    cite(tenantLog);
    for (const value of ["tenants", " tenants ", join(cwd, "tenants")]) {
      const r = await check({ CREWHAUS_TENANTS_ROOT: value });
      expect(r.code).toBe(1);
      expect(r.err).toContain(
        `${tenantLog} is not read: the managed tenants root (CREWHAUS_TENANTS_ROOT) holds each tenant's session logs`,
      );
      expect((JSON.parse(r.out) as ProofBundle).claims[0]?.bindings[0]?.reason).toBe("not_fetched");
    }
    // Unset, the same file is ordinary workspace evidence — the env is what marks it.
    expect((await check()).code).toBe(0);

    // The fleet knowledge store, at its default and where CREWHAUS_SHARED_DIR moves it.
    mkdirSync(join(cwd, ".crewhaus-shared"));
    writeFileSync(join(cwd, ".crewhaus-shared", "memories.jsonl"), assistant);
    cite(".crewhaus-shared/memories.jsonl");
    const shared = await check();
    expect(shared.code).toBe(1);
    expect(shared.err).toContain(
      ".crewhaus-shared/memories.jsonl is not read: the shared knowledge store under .crewhaus-shared/",
    );
    for (const [name, dir] of [
      ["CREWHAUS_SHARED_DIR", "fleet"],
      ["CREWHAUS_DATASETS_DIR", "data"],
      ["CREWHAUS_WATCHME_ROOT", "watch"],
    ] as const) {
      mkdirSync(join(cwd, dir));
      writeFileSync(join(cwd, dir, "x.jsonl"), assistant);
      cite(`${dir}/x.jsonl`);
      const r = await check({ [name]: dir });
      expect(r.code).toBe(1);
      expect(r.err).toContain(`${dir}/x.jsonl is not read: `);
      expect(r.err).toContain(`(${name})`);
    }
  });

  test("every data-root override the supervisor knows is refused, and the tenants root", () => {
    expect(Object.keys(RELOCATED_STATE_ROOTS).sort()).toEqual(
      [...OVERRIDE_ENV_KEYS, "CREWHAUS_TENANTS_ROOT"].sort(),
    );
  });

  test("control characters from a cited file never reach the terminal", async () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, "page.md"),
      "The refund window \u001b]0;PWNED\u0007\u001b[2J\u001b[His 14 days for every order.\n",
    );
    writeAnswer(cwd, "The refund window is 14 days [1].\n\n[1]: page.md\n");
    const r = await run(cwd, ["check", "answer.md", "--level", "grounded"]);
    expect(r.out).not.toMatch(TTY_CONTROL);
    // Visible and inert, not silently dropped.
    expect(r.out).toContain(
      'excerpt   "refund window \uFFFD]0;PWNED\uFFFD\uFFFD[2J\uFFFD[His 14 days"',
    );
  });
});

/** A session log with one WebFetch and one MoneyAdd call, as runtime-core writes it. */
async function writeSession(
  cwd: string,
  sessionId: string,
  calls: ReadonlyArray<{
    id: string;
    name: string;
    input: unknown;
    content: string;
    isError?: boolean;
  }>,
): Promise<void> {
  const log = await openEventLog(sessionId, { rootDir: join(cwd, ".crewhaus", "sessions") });
  for (const call of calls) {
    await log.append({
      kind: "tool_use",
      payload: { id: call.id, name: call.name, input: call.input },
    });
    await log.append({
      kind: "tool_result",
      payload: { toolUseId: call.id, content: call.content, isError: call.isError ?? false },
    });
  }
  await log.close();
}

async function moneyAddResult(input: unknown): Promise<string> {
  const result = await moneyAdd.execute(moneyAdd.inputSchema.parse(input), {} as never);
  return typeof result === "string" ? result : JSON.stringify(result);
}

describe("provability check — evidence from a session log", () => {
  test("a fetched body in the session grounds the answer", async () => {
    const cwd = tempDir();
    await writeSession(cwd, SESS_A, [
      {
        id: "toolu_fetch1",
        name: "WebFetch",
        input: { url: "https://acme.example/policy" },
        content: `URL: https://acme.example/policy\nStatus: 200\n\n${POLICY}`,
      },
    ]);
    writeAnswer(cwd, GOOD_ANSWER);
    const r = await run(cwd, ["check", "answer.md", "--level", "grounded", "--session", SESS_A]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`evidence    1 tool call from ${SESS_A}`);
  });

  test("CREWHAUS_SESSION_DIR is where the log is read from, as the runtime writes it", async () => {
    const cwd = tempDir();
    const elsewhere = tempDir("provability-sessions-");
    await writeSession(elsewhere, SESS_A, [
      {
        id: "toolu_fetch1",
        name: "WebFetch",
        input: { url: "https://acme.example/policy" },
        content: `URL: https://acme.example/policy\nStatus: 200\n\n${POLICY}`,
      },
    ]);
    writeAnswer(cwd, GOOD_ANSWER);
    const r = await run(cwd, ["check", "answer.md", "--level", "grounded", "--session", SESS_A], {
      env: { CREWHAUS_SESSION_DIR: join(elsewhere, ".crewhaus", "sessions") },
    });
    expect(r.code).toBe(0);
  });

  test("a session with no log is an input error, not an empty pass", async () => {
    const cwd = tempDir();
    writeAnswer(cwd, GOOD_ANSWER);
    await expect(
      run(cwd, ["check", "answer.md", "--level", "grounded", "--session", SESS_B]),
    ).rejects.toThrow(new RegExp(`no event log for ${SESS_B}`));
    await expect(
      run(cwd, ["check", "answer.md", "--level", "grounded", "--session", "no-session"]),
    ).rejects.toThrow(/invalid --session/);
  });

  const INPUT = { currency: "USD", amountsMinor: ["100050", "28400"] };

  test("checked: a computation the run made, cited by tool id, passes — without a catalog it is not replayed", async () => {
    const cwd = tempDir();
    const content = await moneyAddResult(INPUT);
    expect(content).toContain("1284.50");
    await writeSession(cwd, SESS_A, [
      { id: "toolu_sum1", name: "MoneyAdd", input: INPUT, content },
    ]);
    writeAnswer(cwd, "The invoice total is 1,284.50 USD [1].\n\n[1]: tool:toolu_sum1\n");
    const r = await run(cwd, [
      "check",
      "answer.md",
      "--level",
      "checked",
      "--session",
      SESS_A,
      "--json",
    ]);
    expect(r.code).toBe(0);
    const binding = (JSON.parse(r.out) as ProofBundle).claims[0]?.bindings[0];
    expect(binding).toMatchObject({
      kind: "execution",
      rung: "checked",
      ok: true,
      replayed: false,
    });
  });

  test("checked: with the catalog, a pure tool is replayed — and a tampered result is caught", async () => {
    const cwd = tempDir();
    const honest = await moneyAddResult(INPUT);
    await writeSession(cwd, SESS_A, [
      { id: "toolu_sum1", name: "MoneyAdd", input: INPUT, content: honest },
      // Same value in the text, but not what the tool says for this input.
      {
        id: "toolu_sum2",
        name: "MoneyAdd",
        input: INPUT,
        content: `${honest}\n(and 1,284.50 again)`,
      },
    ]);
    let built = 0;
    const loadCatalog = async () => {
      built += 1;
      return [moneyAdd];
    };
    writeAnswer(
      cwd,
      "The invoice total is 1,284.50 USD [1].\n\n[1]: tool:toolu_sum1\n",
      "honest.md",
    );
    const ok = await run(
      cwd,
      ["check", "honest.md", "--level", "checked", "--session", SESS_A, "--json"],
      {
        loadCatalog,
      },
    );
    expect(ok.code).toBe(0);
    expect((JSON.parse(ok.out) as ProofBundle).claims[0]?.bindings[0]?.replayed).toBe(true);
    writeAnswer(
      cwd,
      "The invoice total is 1,284.50 USD [1].\n\n[1]: tool:toolu_sum2\n",
      "tampered.md",
    );
    const bad = await run(
      cwd,
      ["check", "tampered.md", "--level", "checked", "--session", SESS_A, "--json"],
      {
        loadCatalog,
      },
    );
    expect(bad.code).toBe(1);
    expect((JSON.parse(bad.out) as ProofBundle).claims[0]?.bindings[0]?.reason).toBe(
      "replay_mismatch",
    );
    expect(built).toBe(2);
  });

  test("the catalog is not built when nothing cites a tool", async () => {
    const cwd = tempDir();
    writeAnswer(cwd, GOOD_ANSWER);
    let built = 0;
    await run(cwd, ["check", "answer.md", "--level", "checked"], {
      loadCatalog: async () => {
        built += 1;
        return [];
      },
    });
    expect(built).toBe(0);
  });

  test("an evidence-directory body can never be cited as execution evidence", async () => {
    const cwd = tempDir();
    const ev = join(cwd, "fetched");
    mkdirSync(ev);
    writeFileSync(join(ev, "policy.txt"), `URL: https://acme.example/policy\n${POLICY}\n`);
    writeAnswer(cwd, "The refund window is 14 days [1].\n\n[1]: tool:offline evidence 1\n");
    const r = await run(cwd, [
      "check",
      "answer.md",
      "--level",
      "checked",
      "--evidence",
      ev,
      "--json",
    ]);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.out) as ProofBundle).claims[0]?.bindings[0]?.reason).toBe("tool_missing");
  });
});

describe("provability check — proof artifacts and configuration", () => {
  test("proven: a ProofCheck artifact under .crewhaus/proofs/<spec>/artifacts backs the claim", async () => {
    const cwd = tempDir();
    const id = newProofId();
    const claim = "No two of the six meetings overlap.";
    await createFileArtifactStore({ rootDir: proofsRoot(cwd, "scheduler") }).put({
      version: 1,
      id,
      checker: "builtin",
      claim,
      statement: "forall i, j in 1..6, i != j: disjoint(m_i, m_j)",
      proof: "1. ... by cases",
      ok: true,
      assumptions: ["the six meetings are the ones listed"],
      axioms: [],
      output: "accepted",
      outputDigest: sha256Of("accepted"),
      checkedAt: NOW.toISOString(),
    });
    writeAnswer(cwd, `${claim} [1]\n\n[1]: proof:${id}\n`);
    const r = await run(cwd, ["check", "answer.md", "--level", "proven"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("statement forall i, j in 1..6");
    expect(r.out).toContain(`builtin — ${id} · axioms: none`);
    // No run log at hand, so the stored artifact is all there is — and the
    // note says the live gate would also require the ProofCheck call.
    expect(r.out).toContain("checked against the stored artifacts alone");

    // With the session's log at hand, its ProofCheck call is required, as live.
    await writeSession(cwd, SESS_A, [
      {
        id: "toolu_fetch1",
        name: "WebFetch",
        input: { url: "https://acme.example" },
        content: "x",
      },
    ]);
    const held = await run(cwd, ["check", "answer.md", "--level", "proven", "--session", SESS_A]);
    expect(held.code).toBe(1);
    expect(held.out).toContain("no ProofCheck call in this run's evidence");
    expect(held.out).not.toContain("checked against the stored artifacts alone");
  });

  test("--level is required unless --spec carries a block", async () => {
    const cwd = tempDir();
    writeAnswer(cwd, GOOD_ANSWER);
    await expect(run(cwd, ["check", "answer.md"])).rejects.toThrow(/--level <rung> is required/);
    await expect(run(cwd, ["check", "answer.md", "--level", "bogus"])).rejects.toThrow(
      /invalid --level "bogus" — expected one of cited, grounded, checked, proven/,
    );
    const spec = writeSpec(cwd, "plain");
    await expect(run(cwd, ["check", "answer.md", "--spec", spec])).rejects.toThrow(
      /crewhaus\.yaml declares no provability block — pass --level <rung>/,
    );
    const fallback = await run(cwd, ["check", "answer.md", "--spec", spec, "--level", "cited"]);
    expect(fallback.out).toContain(
      "the defaults at --level cited (crewhaus.yaml declares no provability block)",
    );
  });

  test("--spec's lowered block configures the gate, and --level overrides only its floor", async () => {
    const cwd = tempDir();
    // `sources.deny` refuses the host the answer cites.
    const spec = writeSpec(
      cwd,
      "support",
      "provability:\n  level: cited\n  sources:\n    deny: [acme.example]\n",
    );
    writeAnswer(cwd, GOOD_ANSWER);
    const r = await run(cwd, ["check", "answer.md", "--spec", spec, "--json"]);
    expect(r.code).toBe(1);
    const bundle = JSON.parse(r.out) as ProofBundle;
    expect(bundle.level).toBe("cited");
    expect(bundle.claims[0]?.bindings[0]?.reason).toBe("host_denied");
    const text = await run(cwd, ["check", "answer.md", "--spec", spec, "--level", "grounded"]);
    expect(text.out).toContain("config      crewhaus.yaml's provability block at --level grounded");
    expect(text.out).toContain("floor       grounded");
  });

  test("resolve: head sends no request offline and says so; the judge and scope: turn likewise", async () => {
    const cwd = tempDir();
    const spec = writeSpec(
      cwd,
      "support",
      "provability:\n  level: cited\n  scope: turn\n  sources:\n    resolve: head\n  judge:\n    model: claude-haiku-4-5\n",
    );
    writeAnswer(cwd, GOOD_ANSWER);
    const r = await run(cwd, ["check", "answer.md", "--spec", spec, "--json"]);
    // `cited` with resolve: head would fail every URL with no HEAD wired; offline it is lexical.
    expect(r.code).toBe(0);
    expect(r.err).toContain(`note: ${CHECK_NOTES.head}`);
    expect(r.err).toContain(`note: ${CHECK_NOTES.judge}`);
    expect(r.err).toContain(`note: ${CHECK_NOTES.scope}`);
    const text = await run(cwd, ["check", "answer.md", "--spec", spec]);
    expect(text.out).toContain(`note        ${CHECK_NOTES.head}`);
  });

  test("an unreadable or missing document is an input error", async () => {
    const cwd = tempDir();
    await expect(run(cwd, ["check", "missing.md", "--level", "cited"])).rejects.toThrow(
      /cannot read "missing.md"/,
    );
    mkdirSync(join(cwd, "adir"));
    await expect(run(cwd, ["check", "adir", "--level", "cited"])).rejects.toThrow(
      /not a regular file/,
    );
  });

  test("a zero-claim document is a vacuous pass", async () => {
    const cwd = tempDir();
    writeAnswer(cwd, "Which order do you mean?\n");
    const r = await run(cwd, ["check", "answer.md", "--level", "proven"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("vacuous: no claims to prove");
    expect(r.out).toContain("evidence    none (only the citations themselves can be checked)");
  });
});

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

/** One claim, met by `origin`. */
function metClaim(index: number, text: string, origin: string): ProofBundle["claims"][number] {
  return {
    index,
    text,
    status: "met",
    best: "grounded",
    bindings: [{ ref: "[1]", kind: "source", rung: "grounded", ok: true, origin }],
  };
}

describe("provability audit", () => {
  test("nothing persisted: an empty, well-formed roll-up", async () => {
    const r = await run(tempDir(), ["audit", "--json"]);
    expect(r.code).toBe(0);
    const audit = JSON.parse(r.out);
    expect(audit.bundles.count).toBe(0);
    expect(audit.assumptionRate).toBeNull();
    expect(audit.passes.count).toBe(0);
    expect(audit.gaming).toEqual({ sharedEvidence: [], replayMismatches: [], restatedProofs: [] });
  });

  test("rolls up verdicts, achieved rungs, floors, unmet reasons, assumptions and waivers", async () => {
    const cwd = tempDir();
    await persist(cwd, "support", SESS_A, 1, await gradedBundle(GOOD_ANSWER, POLICY));
    await persist(cwd, "support", SESS_A, 2, await gradedBundle(BAD_ANSWER, POLICY));
    await persist(
      cwd,
      "support",
      SESS_B,
      1,
      handBundle({
        level: "checked",
        verdict: "fail",
        achieved: "cited",
        score: 0,
        claimCount: 3,
        met: 1,
        unmet: 1,
        assumptions: 1,
        assumptionsRefused: 0,
        judgeWaived: 1,
        sources: 1,
        claims: [
          {
            ...metClaim(
              0,
              "The policy allows refunds within fourteen days.",
              "https://acme.example/policy",
            ),
            bindings: [
              {
                ref: "[1]",
                kind: "source",
                rung: "grounded",
                ok: true,
                origin: "https://acme.example/policy",
                judgeWaived: true,
              },
            ],
          },
          {
            index: 1,
            text: "Shipping is free on every order.",
            status: "unmet",
            best: "none",
            bindings: [],
          },
          {
            index: 2,
            text: "The fiscal year starts in April.",
            status: "assumption",
            best: "none",
            bindings: [
              {
                ref: "[A1]",
                kind: "assumption",
                rung: "none",
                ok: false,
                origin: "the fiscal year starts in April",
              },
            ],
          },
        ],
      }),
    );
    const { audit } = await buildAudit({
      cwd,
      sessionRootDir: join(cwd, ".crewhaus", "sessions"),
      now: NOW,
    });
    expect(audit.bundles).toMatchObject({
      count: 3,
      unreadable: 0,
      verdicts: { pass: 1, fail: 2, unverified: 0 },
      floors: { cited: 0, grounded: 2, checked: 1, proven: 0 },
    });
    expect(audit.bundles.achieved.grounded).toBe(1);
    expect(audit.claims).toEqual({
      total: 5,
      met: 2,
      unmet: 2,
      assumptions: 1,
      assumptionsRefused: 0,
    });
    expect(audit.unmetReasons).toEqual([
      { reason: "no_citation", count: 1 },
      { reason: "not_found_in_source", count: 1 },
    ]);
    expect(audit.assumptionRate).toBe(0.2);
    expect(audit.judgeWaivers).toEqual({ bindings: 1, okSourceBindings: 2, rate: 0.5, bundles: 1 });
  });

  test("every pass of a retried turn is read: the failing pass a retry fixed is not left unread", async () => {
    const cwd = tempDir();
    await persist(cwd, "support", SESS_A, 1, {
      ...(await gradedBundle(BAD_ANSWER, POLICY)),
      retryIndex: 0,
    });
    await persist(cwd, "support", SESS_A, 1, {
      ...(await gradedBundle(GOOD_ANSWER, POLICY)),
      retryIndex: 1,
    });
    await persist(cwd, "support", SESS_A, 2, await gradedBundle(GOOD_ANSWER, POLICY));
    const { audit } = await buildAudit({
      cwd,
      sessionRootDir: join(cwd, ".crewhaus", "sessions"),
      now: NOW,
    });
    expect(audit.bundles).toMatchObject({
      count: 3,
      turns: 2,
      verdicts: { pass: 2, fail: 1, unverified: 0 },
    });
    // The failing pass's unmet claim is read, though a retry fixed the turn.
    expect(audit.unmetReasons).toEqual([{ reason: "not_found_in_source", count: 1 }]);
    const r = await run(cwd, ["audit"]);
    expect(r.out).toContain(
      "bundles     2 graded turns (3 bundles: every pass of a retried turn) · ✓ 2 pass · ✗ 1 fail",
    );
  });

  test("reads provability_graded lines: passes, retries, escalations and judge spend", async () => {
    const cwd = tempDir();
    const log = await openEventLog(SESS_A, { rootDir: join(cwd, ".crewhaus", "sessions") });
    const line = {
      level: "grounded",
      threshold: 1,
      claims: 2,
      met: 1,
      unmet: 1,
      assumptions: 0,
      bundleHash: "x",
      maxRetries: 1,
      turnNumber: 1,
    };
    await log.append({
      kind: "provability_graded",
      payload: {
        ...line,
        verdict: "fail",
        achieved: "cited",
        score: 0.5,
        retryIndex: 0,
        judgeCostUsdMicros: 40,
      },
    });
    await log.append({
      kind: "provability_graded",
      payload: {
        ...line,
        verdict: "pass",
        achieved: "grounded",
        score: 1,
        retryIndex: 1,
        escalatedTo: "claude-opus-5",
      },
    });
    await log.append({ kind: "tool_use", payload: { id: "t1", name: "Read", input: {} } });
    await log.close();
    const r = await run(cwd, ["audit", "--json"]);
    const audit = JSON.parse(r.out);
    expect(audit.passes).toEqual({
      count: 2,
      sessions: 1,
      verdicts: { pass: 1, fail: 1, unverified: 0 },
      achieved: { none: 0, cited: 1, grounded: 1, checked: 0, proven: 0 },
      retries: 1,
      escalations: 1,
      judgeCostUsdMicros: 40,
    });
  });

  test("--since leaves out older bundles and log lines", async () => {
    const cwd = tempDir();
    await persist(
      cwd,
      "support",
      SESS_A,
      1,
      await gradedBundle(GOOD_ANSWER, POLICY),
      NOW.getTime() - 10 * DAY,
    );
    await persist(
      cwd,
      "support",
      SESS_A,
      2,
      await gradedBundle(BAD_ANSWER, POLICY),
      NOW.getTime() - DAY,
    );
    const r = await run(cwd, ["audit", "--since", "7d", "--json"]);
    const audit = JSON.parse(r.out);
    expect(audit.since).toBe(new Date(NOW.getTime() - 7 * DAY).toISOString());
    expect(audit.bundles.count).toBe(1);
    expect(audit.bundles.verdicts.fail).toBe(1);
    const iso = await run(cwd, ["audit", "--since", "2026-10-01", "--json"]);
    expect(JSON.parse(iso.out).bundles.count).toBe(2);
    await expect(run(cwd, ["audit", "--since", "yesterday"])).rejects.toThrow(
      /invalid --since "yesterday"/,
    );
  });

  test("gaming: one source bound to many unrelated claims is flagged; one page with related claims is not", async () => {
    const cwd = tempDir();
    const unrelated = [
      "The refund window lasts fourteen days.",
      "Shipping to Canada takes five business days.",
      "Our office closes early on Fridays during summer.",
      "Gift cards never expire under state law.",
    ].map((text, i) => metClaim(i, text, "https://acme.example/everything"));
    const related = [
      "Refunds are issued within fourteen days of a return request.",
      "Refunds are issued to the original payment method within fourteen days.",
      "Refunds within fourteen days require the original receipt.",
      "Refunds within fourteen days exclude opened electronics.",
    ].map((text, i) => metClaim(i, text, "https://acme.example/refunds"));
    expect(unrelated.length).toBe(SHARED_EVIDENCE_MIN_CLAIMS);
    await persist(
      cwd,
      "support",
      SESS_A,
      1,
      handBundle({ claims: unrelated, claimCount: 4, met: 4 }),
    );
    await persist(
      cwd,
      "support",
      SESS_A,
      2,
      handBundle({ claims: related, claimCount: 4, met: 4 }),
    );
    const { audit } = await buildAudit({ cwd, sessionRootDir: join(cwd, "none"), now: NOW });
    expect(audit.gaming.sharedEvidence).toHaveLength(1);
    expect(audit.gaming.sharedEvidence[0]).toMatchObject({
      bundle: `.crewhaus/proofs/support/${SESS_A}/turn-1.json`,
      origin: "https://acme.example/everything",
      kind: "source",
      claims: 4,
    });
    expect(audit.gaming.sharedEvidence[0]?.overlap).toBeLessThan(0.2);
  });

  test("gaming: replay mismatches and proofs that restate the prose are listed", async () => {
    const cwd = tempDir();
    const prose = "No two of the six meetings overlap on Tuesday.";
    await persist(
      cwd,
      "support",
      SESS_A,
      1,
      handBundle({
        level: "proven",
        claimCount: 2,
        met: 1,
        unmet: 1,
        claims: [
          {
            index: 0,
            text: "The invoice total is 1,284.50.",
            status: "unmet",
            best: "none",
            bindings: [
              {
                ref: "[1]",
                kind: "execution",
                rung: "none",
                ok: false,
                reason: "replay_mismatch",
                origin: "toolu_sum2",
                replayed: true,
              },
            ],
          },
          {
            index: 1,
            text: prose,
            status: "met",
            best: "proven",
            bindings: [
              {
                ref: "[2]",
                kind: "formal",
                rung: "proven",
                ok: true,
                origin: "prf_0123456789abcdef",
                checker: "builtin",
                statement: "no two of the six meetings overlap on tuesday",
              },
            ],
          },
        ],
      }),
    );
    const { audit } = await buildAudit({ cwd, sessionRootDir: join(cwd, "none"), now: NOW });
    expect(audit.gaming.replayMismatches).toEqual([
      {
        bundle: `.crewhaus/proofs/support/${SESS_A}/turn-1.json`,
        ref: "[1]",
        origin: "toolu_sum2",
        claim: "The invoice total is 1,284.50.",
      },
    ]);
    expect(audit.gaming.restatedProofs).toHaveLength(1);
    expect(audit.gaming.restatedProofs[0]?.similarity).toBeGreaterThanOrEqual(RESTATED_SIMILARITY);
    const r = await run(cwd, ["audit"]);
    expect(r.out).toContain("replay mismatches (1)");
    expect(r.out).toContain("proof statements near-identical to the prose (1)");
    expect(r.out).toContain("prf_0123456789abcdef (similarity 1)");
  });

  test("a spec narrows bundles and graded lines to that spec", async () => {
    const cwd = tempDir();
    const spec = writeSpec(cwd, "support");
    await persist(cwd, "support", SESS_A, 1, await gradedBundle(GOOD_ANSWER, POLICY));
    await persist(cwd, "other", SESS_B, 1, await gradedBundle(BAD_ANSWER, POLICY));
    const sessions = join(cwd, ".crewhaus", "sessions");
    for (const sid of [SESS_A, SESS_B]) {
      const log = await openEventLog(sid, { rootDir: sessions });
      await log.append({
        kind: "provability_graded",
        payload: { verdict: "pass", achieved: "grounded", retryIndex: 0 },
      });
      await log.close();
    }
    const narrowed = JSON.parse((await run(cwd, ["audit", spec, "--json"])).out);
    expect(narrowed.spec).toBe("support");
    expect(narrowed.bundles.count).toBe(1);
    expect(narrowed.passes.count).toBe(1);
    const all = JSON.parse((await run(cwd, ["audit", "--json"])).out);
    expect(all.bundles.count).toBe(2);
    expect(all.passes.count).toBe(2);
  });

  test("a malformed bundle is counted unreadable, not fatal; the text report names it", async () => {
    const cwd = tempDir();
    await persist(cwd, "support", SESS_A, 1, await gradedBundle(GOOD_ANSWER, POLICY));
    const bad = join(proofsRoot(cwd, "support"), SESS_A, "turn-2.json");
    writeFileSync(bad, '{"version": 1}');
    const r = await run(cwd, ["audit"]);
    expect(r.out).toContain("1 graded turn · ✓ 1 pass · ✗ 0 fail · ? 0 unverified · 1 unreadable");
    expect(r.out).toContain(
      `note: unreadable bundle .crewhaus/proofs/support/${SESS_A}/turn-2.json`,
    );
  });

  test("a bundle with a valid top level but malformed contents is unreadable, never a crash or a null total", async () => {
    const cwd = tempDir();
    await persist(cwd, "support", SESS_A, 1, await gradedBundle(GOOD_ANSWER, POLICY));
    const dir = join(proofsRoot(cwd, "support"), SESS_B);
    mkdirSync(dir, { recursive: true });
    // Each passes the store's shape check (version, level, verdict, claims[],
    // hash): a full bundle whose claim is null, the reviewer's bare repro,
    // and one with no counts.
    const nullClaim = { ...handBundle({}), claims: [null] };
    writeFileSync(join(dir, "turn-1.json"), JSON.stringify(nullClaim));
    writeFileSync(
      join(dir, "turn-3.json"),
      JSON.stringify({
        version: 1,
        level: "grounded",
        verdict: "pass",
        claims: [null],
        bundleHash: "x",
      }),
    );
    const { bundleHash: _h, ...rest } = handBundle({});
    const { claimCount: _c, met: _m, unmet: _u, ...noCounts } = rest;
    writeFileSync(
      join(dir, "turn-2.json"),
      JSON.stringify({
        ...noCounts,
        bundleHash: "x",
        claims: [{ index: 0, text: "t", status: "met", best: "grounded", bindings: [] }],
      }),
    );
    const r = await run(cwd, ["audit", "--json"]);
    const audit = JSON.parse(r.out);
    expect(audit.bundles).toMatchObject({ count: 1, unreadable: 3 });
    expect(audit.claims).toEqual({
      total: 1,
      met: 1,
      unmet: 0,
      assumptions: 0,
      assumptionsRefused: 0,
    });
    expect(audit.judgeWaivers.bindings).toBe(0);
    expect(r.err).toContain(`${SESS_B}/turn-1.json: claims[0] is not an object`);
    expect(r.err).toContain(`${SESS_B}/turn-2.json: claimCount is not a number`);
    expect(r.err).toContain(`${SESS_B}/turn-3.json: achieved is not a rung`);
    // The text report renders too.
    expect((await run(cwd, ["audit"])).out).toContain("3 unreadable");

    // show: the long form refuses it with a ProvabilityCliError naming the
    // file (the entry file's die()), and --json still prints it as stored.
    await expect(run(cwd, ["show", "--session", SESS_B, "--turn", "1"])).rejects.toThrow(
      new RegExp(
        `${SESS_B}/turn-1\\.json is not a readable proof bundle \\(claims\\[0\\] is not an object\\) — --json prints it as stored`,
      ),
    );
    await expect(run(cwd, ["show", "--session", SESS_B, "--turn", "1"])).rejects.toBeInstanceOf(
      ProvabilityCliError,
    );
    const raw = await run(cwd, ["show", "--session", SESS_B, "--turn", "1", "--json"]);
    expect(JSON.parse(raw.out)).toEqual(nullClaim);
  });

  test("bundleProblem: every field the renderers and the audit read is checked", () => {
    const good = handBundle({
      claimCount: 1,
      met: 1,
      claims: [
        {
          index: 0,
          text: "t",
          status: "met",
          best: "grounded",
          bindings: [{ ref: "[1]", kind: "source", rung: "grounded", ok: true, origin: "o" }],
        },
      ],
      checkers: [{ id: "builtin", artifact: "prf_0000000000000000", axioms: [] }],
    });
    expect(bundleProblem(good)).toBeUndefined();
    const claim = good.claims[0] as ProofBundle["claims"][number];
    const binding = claim.bindings[0] as ProofBundle["claims"][number]["bindings"][number];
    const cases: Array<[unknown, string]> = [
      [{ ...good, verdict: "maybe" }, "verdict is not pass, fail or unverified"],
      [{ ...good, achieved: "golden" }, "achieved is not a rung"],
      [{ ...good, score: "1" }, "score is not a number"],
      [{ ...good, judgeWaived: Number.NaN }, "judgeWaived is not a number"],
      [{ ...good, assumptionsRefused: "2" }, "assumptionsRefused is not a number"],
      [{ ...good, error: 5 }, "error is not a string"],
      [{ ...good, claims: [{ ...claim, status: "toString" }] }, "claims[0].status is not met"],
      [{ ...good, claims: [{ ...claim, index: -1 }] }, "claims[0].index is not a claim index"],
      [{ ...good, claims: [{ ...claim, bindings: null }] }, "claims[0].bindings is not an array"],
      [
        { ...good, claims: [{ ...claim, bindings: [{ ...binding, ok: "yes" }] }] },
        "claims[0].bindings[0].ok is not a boolean",
      ],
      [
        { ...good, claims: [{ ...claim, bindings: [{ ...binding, excerpt: 7 }] }] },
        "claims[0].bindings[0].excerpt is not a string",
      ],
      [{ ...good, checkers: [{ id: "x" }] }, "checkers[0] is not {id, artifact, axioms}"],
    ];
    for (const [bad, problem] of cases) expect(bundleProblem(bad)).toContain(problem);
  });
});

// ---------------------------------------------------------------------------
// the managed shape: bundles under the tenants root
// ---------------------------------------------------------------------------

describe("managed bundles under the tenants root", () => {
  /** A bundle filed as a managed turn files it: `<root>/<tenant>/proofs/<spec>/<session>/`. */
  async function persistTenant(
    root: string,
    tenant: string,
    spec: string,
    session: string,
    turn: number,
    bundle: ProofBundle,
    mtimeMs?: number,
  ): Promise<string> {
    const path = await createBundleStore({ rootDir: join(root, tenant, "proofs", spec) }).put(
      bundle,
      { sessionId: session, turnNumber: turn },
    );
    if (mtimeMs !== undefined) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
    return path;
  }

  test("the default tenants root is the one the managed emitter writes — and Hangar names", () => {
    expect(PROVABILITY_USAGE).toContain(`${MANAGED_TENANTS_ROOT_DEFAULT} when the spec's target`);
    expect(HANGAR_MANAGED_TENANTS_ROOT_DEFAULT).toBe(MANAGED_TENANTS_ROOT_DEFAULT);
    const emitter = readFileSync(
      join(import.meta.dir, "..", "..", "..", "packages", "target-managed", "src", "index.ts"),
      "utf8",
    );
    expect(emitter).toContain(
      `const TENANTS_ROOT = process.env.CREWHAUS_TENANTS_ROOT ?? "${MANAGED_TENANTS_ROOT_DEFAULT}";`,
    );
  });

  test("show finds a tenant's bundle through --tenants-root or CREWHAUS_TENANTS_ROOT", async () => {
    const cwd = tempDir();
    const tenants = tempDir("provability-tenants-");
    await persistTenant(
      tenants,
      "acme",
      "support",
      SESS_A,
      1,
      await gradedBundle(GOOD_ANSWER, POLICY),
    );
    await expect(run(cwd, ["show"])).rejects.toThrow(/--tenants-root <dir>/);
    const r = await run(cwd, ["show", "--tenants-root", tenants]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`session     ${SESS_A} · turn 1 · tenant acme`);
    expect(r.out).toContain(join(tenants, "acme", "proofs", "support", SESS_A, "turn-1.json"));
    const viaEnv = await run(cwd, ["show", "--session", SESS_A, "--json"], {
      env: { CREWHAUS_TENANTS_ROOT: tenants },
    });
    expect(JSON.parse(viaEnv.out).verdict).toBe("pass");
    await expect(run(cwd, ["show", "--tenants-root", join(cwd, "nope")])).rejects.toThrow(
      /--tenants-root .*: no such directory/,
    );
  });

  test("a managed spec with no CREWHAUS_TENANTS_ROOT looks where the daemon files them", async () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, "crewhaus.yaml"),
      "name: w3d-managed-probe\ntarget: managed\nagent:\n  model: claude-opus-5\n  instructions: hi\ntenants:\n  - {id: t1, budget: {maxInputTokens: 10, maxOutputTokens: 10}}\n",
    );
    await expect(run(cwd, ["show", "--session", "sess_fffffffffffffff1"])).rejects.toThrow(
      `or the tenants root ${MANAGED_TENANTS_ROOT_DEFAULT} (managed default, spec w3d-managed-probe only)`,
    );
  });

  test("the cwd spec narrows a shared tenants root to its own spec; links in the tree are not followed", async () => {
    const cwd = tempDir();
    writeSpec(cwd, "support");
    const tenants = tempDir("provability-tenants-");
    const bundle = await gradedBundle(GOOD_ANSWER, POLICY);
    await persistTenant(tenants, "acme", "support", SESS_A, 1, bundle);
    await persistTenant(tenants, "acme", "billing", SESS_B, 1, bundle);
    // A planted tenant that is a link out of the root, and a bad tenant name.
    const elsewhere = tempDir("provability-elsewhere-");
    await persistTenant(elsewhere, "x", "support", SESS_B, 2, bundle);
    symlinkSync(join(elsewhere, "x"), join(tenants, "linked"));
    await persistTenant(tenants, ".hidden", "support", SESS_B, 3, bundle);
    const audit = JSON.parse((await run(cwd, ["audit", "--tenants-root", tenants, "--json"])).out);
    expect(audit.tenantsRoot).toBe(tenants);
    expect(audit.bundles.count).toBe(1);
  });

  test("audit reads the tenants' provability_graded lines too", async () => {
    const cwd = tempDir();
    writeSpec(cwd, "support");
    const tenants = tempDir("provability-tenants-");
    const path = await persistTenant(
      tenants,
      "acme",
      "support",
      SESS_A,
      1,
      await gradedBundle(GOOD_ANSWER, POLICY),
    );
    const log = await openEventLog(SESS_A, { rootDir: join(tenants, "acme", "sessions") });
    await log.append({
      kind: "provability_graded",
      payload: { verdict: "pass", achieved: "grounded", retryIndex: 0, bundlePath: path },
    });
    await log.close();
    const other = await openEventLog(SESS_B, { rootDir: join(tenants, "acme", "sessions") });
    await other.append({
      kind: "provability_graded",
      payload: {
        verdict: "fail",
        achieved: "none",
        retryIndex: 0,
        bundlePath: join(tenants, "acme", "proofs", "billing", SESS_B, "turn-1.json"),
      },
    });
    await other.close();
    const audit = JSON.parse(
      (await run(cwd, ["audit", "--json"], { env: { CREWHAUS_TENANTS_ROOT: tenants } })).out,
    );
    expect(audit.bundles.count).toBe(1);
    expect(audit.passes).toMatchObject({ count: 1, sessions: 1 });
    expect(audit.passes.verdicts).toEqual({ pass: 1, fail: 0, unverified: 0 });
  });

  test("prune manages tenant bundles' size too", async () => {
    const cwd = tempDir();
    const tenants = tempDir("provability-tenants-");
    const bundle = await gradedBundle(GOOD_ANSWER, POLICY);
    const old = await persistTenant(
      tenants,
      "acme",
      "support",
      SESS_A,
      1,
      bundle,
      NOW.getTime() - 100 * DAY,
    );
    const fresh = await persistTenant(
      tenants,
      "acme",
      "support",
      SESS_B,
      1,
      bundle,
      NOW.getTime() - DAY,
    );
    const dry = await run(cwd, [
      "prune",
      "--older-than",
      "30d",
      "--dry-run",
      "--tenants-root",
      tenants,
    ]);
    expect(dry.out).toContain("would remove 1 bundle");
    expect(dry.out).toContain(old);
    expect(dry.out).toContain(`tenants root ${tenants} (--tenants-root) included`);
    const r = await run(cwd, ["prune", "--older-than", "30d", "--json", "--tenants-root", tenants]);
    expect(JSON.parse(r.out)).toMatchObject({ removed: 1, tenantsRoot: tenants });
    expect(() => readFileSync(old)).toThrow();
    expect(readFileSync(fresh, "utf8")).not.toBe("");
  });

  test("Hangar's spec-directory rule is provability's store rule", () => {
    const storeAccepts = (name: string): boolean => {
      try {
        proofsRoot(".", name);
        return true;
      } catch {
        return false;
      }
    };
    for (const name of [
      "support",
      "-agent",
      ".agent",
      "a.b-c_d",
      "x".repeat(140),
      "..",
      ".",
      "a b",
      "a/b",
      "é",
    ]) {
      expect(isProofSpecDir(name)).toBe(storeAccepts(name));
    }
  });
});

// ---------------------------------------------------------------------------
// checkers + doctor's probe
// ---------------------------------------------------------------------------

/** A sandbox whose image healthchecks answer `exitCode`. */
function fakeSandbox(exitCode: number): NonNullable<ProvabilityCliDeps["createSandbox"]> {
  return () => ({
    backend: "docker",
    async exec() {
      return { exitCode, stdout: "", stderr: exitCode === 0 ? "" : "image not found" };
    },
  });
}

describe("provability checkers", () => {
  test("with no sandbox: builtin is available, the sandbox checkers say why not", async () => {
    const r = await run(tempDir(), ["checkers", "--json"]);
    const report = JSON.parse(r.out);
    expect(report.checkers.map((c: { id: string }) => c.id)).toEqual(["builtin", "smt", "lean4"]);
    const [builtin, smt, lean4] = report.checkers;
    expect(builtin).toMatchObject({ available: true, configured: true });
    expect(builtin.language.length).toBeGreaterThan(40);
    expect(smt.available).toBe(false);
    expect(smt.reason).toMatch(/sandbox/i);
    expect(smt.configured).toBe(true);
    expect(lean4.configured).toBe(false);
    expect(lean4.image).toBeString();
  });

  test("with a healthy sandbox every checker is available; the text names images and languages", async () => {
    const r = await run(tempDir(), ["checkers"], {
      sandboxAvailable: true,
      createSandbox: fakeSandbox(0),
    });
    expect(r.out).toContain("sandbox  docker (available)");
    expect(r.out).toContain("✓ builtin  available · configured");
    expect(r.out).toMatch(/✓ smt {2}available · configured · image \S+/);
    expect(r.out).toMatch(/✓ lean4 {2}available · image \S+/);
  });

  test("an unhealthy image is reported with the probe's reason", async () => {
    const report = await probeCheckers(defaultProvabilityConfig(), {
      env: {},
      sandboxAvailable: true,
      createSandbox: fakeSandbox(1),
    });
    const smt = report.checkers.find((c) => c.id === "smt");
    expect(smt?.available).toBe(false);
    expect(smt?.reason).toContain("image not found");
  });

  test("CREWHAUS_SANDBOX naming no backend is reported as such", async () => {
    const report = await probeCheckers(defaultProvabilityConfig(), {
      env: { CREWHAUS_SANDBOX: "kubernetes" },
    });
    expect(report.sandbox).toMatchObject({ backend: null, available: false });
    expect(report.sandbox.reason).toContain("is not a sandbox backend");
  });

  test("the cwd spec's formal block decides what is configured and the lean4 image", async () => {
    const cwd = tempDir();
    writeSpec(
      cwd,
      "prover",
      "provability:\n  level: proven\n  formal:\n    checkers: [lean4]\n    image: ghcr.io/acme/lean-mathlib:4.9\n",
    );
    const report = JSON.parse((await run(cwd, ["checkers", "--json"])).out);
    expect(report.spec).toBe("prover");
    expect(report.checkers.map((c: { id: string }) => c.id)).toEqual(["lean4", "builtin", "smt"]);
    expect(report.checkers[0]).toMatchObject({
      configured: true,
      image: "ghcr.io/acme/lean-mathlib:4.9",
    });
    expect(report.checkers[2]).toMatchObject({ id: "smt", configured: false });
  });
});

describe("doctor's proof-checker probe", () => {
  const withCheckers = (checkers: ProvabilityConfig["formal"]["checkers"]): ProvabilityConfig => {
    const base = defaultProvabilityConfig();
    return { ...base, level: "proven", formal: { ...base.formal, checkers } };
  };

  const PROBE = { probe: true } as const;

  test("no block, or only the builtin checker: no lines at all", async () => {
    for (const opts of [PROBE, { probe: false }]) {
      expect(await provabilityDoctorChecks(undefined, { env: {} }, opts)).toEqual([]);
      expect(await provabilityDoctorChecks(withCheckers(["builtin"]), { env: {} }, opts)).toEqual(
        [],
      );
    }
  });

  test("without --probe no sandbox runs: one ~ line says what --probe would check", async () => {
    let created = 0;
    const checks = await provabilityDoctorChecks(
      withCheckers(["builtin", "smt", "lean4"]),
      {
        env: {},
        sandboxAvailable: true,
        createSandbox: (...a) => {
          created += 1;
          return fakeSandbox(0)(...a);
        },
      },
      { probe: false },
    );
    expect(created).toBe(0);
    expect(checks).toEqual([
      {
        label: "provability checkers smt, lean4",
        pass: true,
        warn: true,
        reason: expect.stringContaining("not probed — `crewhaus doctor --probe`"),
      },
    ]);
    expect(checks[0]?.reason).toContain("may pull the image");
  });

  test("an unavailable sandbox checker is a warning that names the fallback", async () => {
    const checks = await provabilityDoctorChecks(
      withCheckers(["smt"]),
      {
        env: {},
        sandboxAvailable: false,
      },
      PROBE,
    );
    expect(checks.map((c) => c.label.split(" (")[0])).toEqual([
      "provability checker smt",
      "provability checker builtin",
    ]);
    expect(checks[0]).toMatchObject({ pass: true, warn: true });
    expect(checks[0]?.reason).toContain("fall back to the builtin checker");
    expect(checks[1]).toEqual({ label: "provability checker builtin", pass: true });
  });

  // 0.8.0 §11 — doctor probes the checkers a harness USES. Every gated spec
  // lowers formal.checkers [builtin, smt], but below proven on those defaults
  // no ProofCheck is wired, so nothing ever runs smt: no line, no probe, no
  // Z3 image pulled for a cited harness.
  test("a harness that never runs a checker gets no line, probed or not — unless it lists proofCheck", async () => {
    for (const level of ["cited", "grounded", "checked"] as const) {
      const config = { ...defaultProvabilityConfig(), level };
      expect(config.formal.checkers).toEqual(["builtin", "smt"]);
      for (const opts of [PROBE, { probe: false }]) {
        let created = 0;
        const checks = await provabilityDoctorChecks(
          config,
          {
            env: {},
            sandboxAvailable: true,
            createSandbox: (...a) => {
              created += 1;
              return fakeSandbox(0)(...a);
            },
          },
          { ...opts, tools: ["webFetch", "read"] },
        );
        expect(checks).toEqual([]);
        expect(created).toBe(0);
      }
      // A spec that listed the proof tool runs the checkers at any floor (the
      // gate swaps in its bound twin), so it is probed.
      const listed = await provabilityDoctorChecks(
        config,
        { env: {}, sandboxAvailable: false },
        { probe: false, tools: ["webFetch", "proofCheck"] },
      );
      expect(listed.map((c) => c.label)).toEqual(["provability checker smt"]);
    }
  });

  test("a cited spec in the harness directory: doctor's lines and the checkers' configured marks agree", async () => {
    const cwd = tempDir();
    writeSpec(cwd, "rcited", "provability: cited\n");
    const report = JSON.parse((await run(cwd, ["checkers", "--json"])).out);
    expect(report.spec).toBe("rcited");
    expect(report.note).toContain("never runs a proof checker");
    expect(report.checkers.every((c: { configured: boolean }) => !c.configured)).toBe(true);
    const text = (await run(cwd, ["checkers"])).out;
    expect(text).toContain("note     rcited never runs a proof checker");
    expect(text).not.toContain("· configured");

    writeSpec(cwd, "rprover", "provability: proven\n");
    const proven = JSON.parse((await run(cwd, ["checkers", "--json"])).out);
    expect(proven.note).toBeUndefined();
    expect(
      proven.checkers
        .filter((c: { configured: boolean }) => c.configured)
        .map((c: { id: string }) => c.id),
    ).toEqual(["builtin", "smt"]);
  });

  test("a healthy sandbox checker passes", async () => {
    const checks = await provabilityDoctorChecks(
      withCheckers(["builtin", "lean4"]),
      {
        env: {},
        sandboxAvailable: true,
        createSandbox: fakeSandbox(0),
      },
      PROBE,
    );
    expect(checks.every((c) => c.pass && c.warn === undefined)).toBe(true);
    expect(checks.map((c) => c.label.split(" (")[0])).toEqual([
      "provability checker builtin",
      "provability checker lean4",
    ]);
  });
});

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

describe("provability prune", () => {
  async function seeded(): Promise<{ cwd: string; old: string; fresh: string; artifact: string }> {
    const cwd = tempDir();
    const bundle = await gradedBundle(GOOD_ANSWER, POLICY);
    const old = await persist(cwd, "support", SESS_A, 1, bundle, NOW.getTime() - 100 * DAY);
    const fresh = await persist(cwd, "support", SESS_B, 1, bundle, NOW.getTime() - DAY);
    const id = newProofId();
    await createFileArtifactStore({ rootDir: proofsRoot(cwd, "support") }).put({
      version: 1,
      id,
      checker: "builtin",
      claim: "c",
      statement: "s",
      proof: "p",
      ok: true,
      assumptions: [],
      axioms: [],
      output: "o",
      outputDigest: sha256Of("o"),
      checkedAt: new Date(NOW.getTime() - 200 * DAY).toISOString(),
    });
    const artifact = join(proofsRoot(cwd, "support"), "artifacts", `${id}.json`);
    utimesSync(artifact, (NOW.getTime() - 200 * DAY) / 1000, (NOW.getTime() - 200 * DAY) / 1000);
    return { cwd, old, fresh, artifact };
  }

  test("--dry-run lists what would go and deletes nothing", async () => {
    const { cwd, old, fresh } = await seeded();
    const r = await run(cwd, ["prune", "--older-than", "90d", "--dry-run"]);
    expect(r.out).toContain("would remove 1 bundle last written before 2026-07-24T12:00:00.000Z");
    expect(r.out).toContain(`.crewhaus/proofs/support/${SESS_A}/turn-1.json`);
    expect(readFileSync(old, "utf8")).not.toBe("");
    expect(readFileSync(fresh, "utf8")).not.toBe("");
  });

  test("removes only bundles older than the cutoff; proof artifacts are kept", async () => {
    const { cwd, old, fresh, artifact } = await seeded();
    const r = await run(cwd, ["prune", "--older-than", "90d", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ dryRun: false, removed: 1, olderThan: "90d" });
    expect(() => readFileSync(old)).toThrow();
    expect(readFileSync(fresh, "utf8")).not.toBe("");
    expect(readFileSync(artifact, "utf8")).toContain('"checker": "builtin"');
  });

  test("--older-than is required and must be a duration", async () => {
    await expect(run(tempDir(), ["prune"])).rejects.toThrow(/--older-than <duration> is required/);
    await expect(run(tempDir(), ["prune", "--older-than", "90"])).rejects.toThrow(
      /invalid --older-than "90"/,
    );
    await expect(run(tempDir(), ["prune", "--older-than", "0d"])).rejects.toThrow(
      /invalid --older-than/,
    );
  });

  test("a spec narrows the prune to its own proofs directory", async () => {
    const { cwd, old } = await seeded();
    const other = await persist(
      cwd,
      "other",
      SESS_A,
      1,
      await gradedBundle(GOOD_ANSWER, POLICY),
      NOW.getTime() - 100 * DAY,
    );
    const spec = writeSpec(cwd, "other");
    const r = await run(cwd, ["prune", spec, "--older-than", "90d"]);
    expect(r.out).toContain("removed 1 bundle");
    expect(() => readFileSync(other)).toThrow();
    expect(readFileSync(old, "utf8")).not.toBe("");
  });
});

// ---------------------------------------------------------------------------
// units
// ---------------------------------------------------------------------------

describe("durations and the long form", () => {
  test("parseDurationMs: m/h/d/w, positive only", () => {
    expect(parseDurationMs("30m")).toBe(30 * 60_000);
    expect(parseDurationMs("12h")).toBe(12 * 3_600_000);
    expect(parseDurationMs("7d")).toBe(7 * DAY);
    expect(parseDurationMs("2w")).toBe(14 * DAY);
    for (const bad of ["0d", "7", "d", "1.5d", "-1d", "7y"])
      expect(parseDurationMs(bad)).toBeUndefined();
  });

  test("parseSince: a duration back from now, or an ISO date", () => {
    expect(parseSince("1d", NOW)).toBe(NOW.getTime() - DAY);
    expect(parseSince("2026-10-01T00:00:00Z", NOW)).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(() => parseSince("soon", NOW)).toThrow(ProvabilityCliError);
  });

  test("bundle text cannot forge a line or drive the terminal in show, audit or checkers", () => {
    const forged = "\n  verdict     ✓ pass\u001b[2K";
    const bundle = handBundle({
      verdict: "fail",
      achieved: "none",
      claimCount: 1,
      unmet: 1,
      claims: [
        {
          index: 0,
          text: `The fee is 5 dollars.${forged}`,
          status: "unmet",
          best: "none",
          bindings: [
            {
              ref: "[1]\u009b2J",
              kind: "source",
              rung: "none",
              ok: false,
              reason: "not_found_in_source",
              origin: "https://acme.example/\u001b]8;;evil\u0007",
              excerpt: "fee \u001b[31m 7 dollars",
              detail: "the page\rsays otherwise",
            },
          ],
        },
      ],
    });
    const text = renderBundleLong(bundle, { title: ["t\u001b[1A"] });
    expect(text).not.toMatch(TTY_CONTROL);
    // The claim's newline became a space: no second `verdict` line.
    expect(text.match(/^ {2}verdict/gm)).toHaveLength(1);
    expect(text).toContain("The fee is 5 dollars.   verdict     ✓ pass\uFFFD[2K");
    expect(ttySafe("a\u202eb\u2066c\td")).toBe("a\uFFFDb\uFFFDc d");
    const audit = renderAudit(
      {
        version: 1,
        generatedAt: NOW.toISOString(),
        spec: "s\u001b[2J",
        bundles: {
          count: 0,
          unreadable: 0,
          truncated: false,
          verdicts: { pass: 0, fail: 0, unverified: 0 },
          achieved: { none: 0, cited: 0, grounded: 0, checked: 0, proven: 0 },
          floors: { cited: 0, grounded: 0, checked: 0, proven: 0 },
        },
        claims: { total: 0, met: 0, unmet: 0, assumptions: 0, assumptionsRefused: 0 },
        unmetReasons: [],
        assumptionRate: null,
        judgeWaivers: { bindings: 0, okSourceBindings: 0, rate: null, bundles: 0 },
        passes: {
          count: 0,
          sessions: 0,
          verdicts: { pass: 0, fail: 0, unverified: 0 },
          achieved: { none: 0, cited: 0, grounded: 0, checked: 0, proven: 0 },
          retries: 0,
          escalations: 0,
          judgeCostUsdMicros: 0,
        },
        gaming: {
          sharedEvidence: [],
          replayMismatches: [{ bundle: "b", ref: "[1]", claim: "x\n  replay mismatches (0)" }],
          restatedProofs: [],
        },
      },
      ["a note \u001b]0;t\u0007"],
    );
    expect(audit).not.toMatch(TTY_CONTROL);
    expect(audit.match(/^ {2}replay mismatches \(/gm)).toHaveLength(1);
    expect(audit).toContain('"x   replay mismatches (0)"');
  });

  test("an unverified bundle says the verifier failed instead of printing a verdict mark", () => {
    const bundle = handBundle({
      verdict: "unverified",
      achieved: "none",
      error: "sandbox exploded",
    });
    const text = renderBundleLong(bundle, { title: "t" });
    expect(text).toContain("verdict     ? unverified — sandbox exploded");
    expect(text).toContain("── provability · grounded ? unverified — sandbox exploded");
  });
});

// ---------------------------------------------------------------------------
// check --report: a research report graded as its gate graded it (§5.4, §11)
// ---------------------------------------------------------------------------

describe("provability check --report — a gated research report", () => {
  const SNIPPET = "Customers may request a refund within 14 days of delivery";

  /**
   * A report the way report-writer's `writeProvableReport` writes it: the
   * text its gate verifies (title, definitions, one branch), then the
   * writer's trailer — `## Citations` (the visible list) and `## Provability`
   * (the section rendered from the bundle the gate produced). The writer's
   * own source is held to this shape below.
   */
  async function researchReport(): Promise<{ report: string; gated: ProofBundle }> {
    const verified = [
      "# What is the refund window?",
      "",
      `[1]: https://acme.example/policy "${SNIPPET}"`,
      "",
      "## What is the refund window?",
      "",
      "Customers may request a refund within 14 days of delivery [1].",
      "",
    ].join("\n");
    const gated = await gradedBundle(verified, POLICY);
    const trailer = ["## Citations", "", "[1] https://acme.example/policy", `    ${SNIPPET}`].join(
      "\n",
    );
    const report = `${verified}\n${trailer}\n\n${renderMarkdownSection(gated).trimEnd()}\n`;
    return { report, gated };
  }

  function evidenceDir(cwd: string): void {
    mkdirSync(join(cwd, "ev"));
    writeFileSync(join(cwd, "ev", "policy.html"), `URL: https://acme.example/policy\n${POLICY}\n`);
  }

  test("a report its gate passed passes again with --report; whole, the writer's lines fail it", async () => {
    const cwd = tempDir();
    const { report, gated } = await researchReport();
    expect(gated.verdict).toBe("pass");
    writeAnswer(cwd, report, "report.md");
    evidenceDir(cwd);
    const argv = ["check", "report.md", "--level", "grounded", "--evidence", "ev"];

    // Whole: the citation list, the Floor line and the table rows are claims.
    const whole = await run(cwd, [...argv, "--json"]);
    expect(whole.code).toBe(1);
    expect((JSON.parse(whole.out) as ProofBundle).claimCount).toBeGreaterThan(gated.claimCount);
    expect(whole.err).toContain("its lines were graded as claims — pass --report");

    // --report: exactly what the gate verified, with the same verdict.
    const r = await run(cwd, [...argv, "--report", "--json"]);
    expect(r.code).toBe(0);
    const again = JSON.parse(r.out) as ProofBundle;
    expect(again.verdict).toBe("pass");
    expect(again.claimCount).toBe(gated.claimCount);
    expect(again.claims.map((c) => c.text)).toEqual(gated.claims.map((c) => c.text));
    expect(r.err).toContain("--report: from line 9 on is the report writer's trailer");

    const text = await run(cwd, [...argv, "--report"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("verdict     ✓ pass");
  });

  test("the trailer is never stripped unasked: an answer cannot hide an uncited claim under a fake one", async () => {
    const cwd = tempDir();
    writeAnswer(
      cwd,
      `${GOOD_ANSWER}\n## Citations\n\n[1] https://acme.example/policy\n    The moon is made of green cheese.\n\n## Provability\n\n**Floor:** \`grounded\` · **Verdict:** pass ✓\n`,
    );
    evidenceDir(cwd);
    const r = await run(cwd, [
      "check",
      "answer.md",
      "--level",
      "grounded",
      "--evidence",
      "ev",
      "--json",
    ]);
    expect(r.code).toBe(1);
    const claims = (JSON.parse(r.out) as ProofBundle).claims;
    expect(claims.some((c) => c.text.includes("green cheese") && c.status === "unmet")).toBe(true);
  });

  test("--report on a document with no gated trailer is refused, not silently graded whole", async () => {
    const cwd = tempDir();
    writeAnswer(cwd, GOOD_ANSWER);
    await expect(run(cwd, ["check", "answer.md", "--level", "cited", "--report"])).rejects.toThrow(
      /does not end in a gated research report's trailer/,
    );
    // An UNGATED report's `## Citations` alone is not a gated trailer either.
    writeAnswer(cwd, `${GOOD_ANSWER}\n## Citations\n\n[1] https://acme.example/policy\n`);
    await expect(run(cwd, ["check", "answer.md", "--level", "cited", "--report"])).rejects.toThrow(
      /does not end in a gated research report's trailer/,
    );
  });

  test("a copy of the graded body in --evidence is still a copy of the document", async () => {
    const cwd = tempDir();
    const { report } = await researchReport();
    writeAnswer(cwd, report, "report.md");
    evidenceDir(cwd);
    const body = report.slice(0, reportTrailerAt(report));
    writeFileSync(join(cwd, "ev", "copy.md"), `URL: https://acme.example/policy\n${body}\n`);
    rmSync(join(cwd, "ev", "policy.html"));
    const r = await run(cwd, [
      "check",
      "report.md",
      "--level",
      "grounded",
      "--evidence",
      "ev",
      "--report",
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("skipped copy.md: it is a copy of the document");
  });

  test("the trailer rule is report-writer's: verifiedReportText and the writer's layout, held to its source", () => {
    // apps/cli does not depend on report-writer, so the rule is mirrored in
    // reportTrailerAt — and this reads the writer's SOURCE (the
    // target-managed precedent above) so the two cannot drift apart.
    const writer = readFileSync(
      join(import.meta.dir, "..", "..", "..", "packages", "report-writer", "src", "provability.ts"),
      "utf8",
    );
    expect(writer.includes('const TRAILER = "\\n\\n## Citations\\n";')).toBe(true);
    expect(writer.includes("const at = markdown.lastIndexOf(TRAILER);")).toBe(true);
    expect(writer.includes('!markdown.slice(at).includes("\\n## Provability\\n")')).toBe(true);
    expect(writer.includes("return `${markdown.slice(0, at)}\\n`;")).toBe(true);
    expect(
      writer.includes(
        "const markdown = `${verified}\\n${trailer}\\n\\n${renderMarkdownSection(proof).trimEnd()}\\n`;",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// check --tenant: a managed answer's evidence under the tenants root (§8, §11)
// ---------------------------------------------------------------------------

describe("provability check --tenant — a managed answer's evidence", () => {
  const MANAGED_SPEC =
    "name: mgd\ntarget: managed\nagent:\n  model: claude-opus-5\n  instructions: hi\ntenants:\n  - {id: acme, budget: {maxInputTokens: 10, maxOutputTokens: 10}}\nprovability:\n  level: proven\n";

  /** A managed tenant's tree as the daemon leaves it: a session log and a ProofCheck artifact. */
  async function managedTree(): Promise<{ cwd: string; tenants: string; proofId: string }> {
    const cwd = tempDir();
    const tenants = join(cwd, "tenants");
    writeFileSync(join(cwd, "crewhaus.yaml"), MANAGED_SPEC);
    const proofId = newProofId();
    await createFileArtifactStore({ rootDir: join(tenants, "acme", "proofs", "mgd") }).put({
      version: 1,
      id: proofId,
      checker: "builtin",
      claim: "No two of the six meetings overlap.",
      statement: "forall i, j in 1..6, i != j: disjoint(m_i, m_j)",
      proof: "1. ... by cases",
      ok: true,
      assumptions: [],
      axioms: [],
      output: "accepted",
      outputDigest: sha256Of("accepted"),
      checkedAt: NOW.toISOString(),
    });
    const log = await openEventLog(SESS_A, { rootDir: join(tenants, "acme", "sessions") });
    const content = await moneyAddResult({ currency: "USD", amountsMinor: ["100050", "28400"] });
    await log.append({
      kind: "tool_use",
      payload: {
        id: "toolu_sum1",
        name: "MoneyAdd",
        input: { currency: "USD", amountsMinor: ["100050", "28400"] },
      },
    });
    await log.append({
      kind: "tool_result",
      payload: { toolUseId: "toolu_sum1", content, isError: false },
    });
    await log.close();
    return { cwd, tenants, proofId };
  }

  test("a proof: artifact a tenant's ProofCheck filed backs the claim with --tenant — and only then", async () => {
    const { cwd, tenants, proofId } = await managedTree();
    writeAnswer(cwd, `No two of the six meetings overlap [1].\n\n[1]: proof:${proofId}\n`);
    const argv = ["check", "answer.md", "--spec", "crewhaus.yaml"];

    // Without the tenant: the artifact is not found, and the note says why.
    const without = await run(cwd, argv, { env: { CREWHAUS_TENANTS_ROOT: "tenants" } });
    expect(without.code).toBe(1);
    expect(without.out).toContain("proof missing");
    expect(without.out).toContain("name the tenant with --tenant <id>");

    for (const over of [
      { argv: ["--tenant", "acme", "--tenants-root", tenants], env: {} },
      { argv: ["--tenant", "acme"], env: { CREWHAUS_TENANTS_ROOT: "tenants" } },
    ]) {
      const r = await run(cwd, [...argv, ...over.argv], { env: over.env });
      expect(r.code).toBe(0);
      expect(r.out).toContain("verdict     ✓ pass");
      expect(r.out).toContain("tenant acme under");
    }
  });

  test("a tool: citation is found in the tenant's own session log", async () => {
    const { cwd, tenants } = await managedTree();
    writeAnswer(cwd, "The invoice total is 1,284.50 USD [1].\n\n[1]: tool:toolu_sum1\n");
    const argv = ["check", "answer.md", "--level", "checked", "--session", SESS_A];
    await expect(run(cwd, argv, { env: { CREWHAUS_TENANTS_ROOT: "tenants" } })).rejects.toThrow(
      /no event log for sess_00000000000000aa under \.crewhaus\/sessions — a managed harness logs each tenant's sessions under .*: name the tenant with --tenant <id>/,
    );
    const r = await run(cwd, [...argv, "--tenant", "acme", "--tenants-root", tenants, "--json"]);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as ProofBundle).claims[0]?.bindings[0]).toMatchObject({
      kind: "execution",
      ok: true,
    });
  });

  test("one tenant, named and real: another tenant's evidence never grounds the answer", async () => {
    const { cwd, tenants, proofId } = await managedTree();
    writeAnswer(cwd, `No two of the six meetings overlap [1].\n\n[1]: proof:${proofId}\n`);
    mkdirSync(join(tenants, "globex"));
    const argv = ["check", "answer.md", "--spec", "crewhaus.yaml", "--tenants-root", tenants];
    const other = await run(cwd, [...argv, "--tenant", "globex"]);
    expect(other.code).toBe(1);
    expect(other.out).toContain("proof missing");
    await expect(run(cwd, argv)).rejects.toThrow(/--tenants-root needs --tenant <id>/);
    await expect(run(cwd, [...argv, "--tenant", "../acme"])).rejects.toThrow(/invalid --tenant/);
    await expect(run(cwd, [...argv, "--tenant", "initech"])).rejects.toThrow(
      /no tenant initech under the tenants root/,
    );
    // A tenant directory that is a link is not followed into.
    symlinkSync(join(tenants, "acme"), join(tenants, "linked"));
    await expect(run(cwd, [...argv, "--tenant", "linked"])).rejects.toThrow(/no tenant linked/);
    // No root at all (a cli spec, nothing in the env): the tenant cannot be found.
    rmSync(join(cwd, "crewhaus.yaml"));
    await expect(
      run(cwd, ["check", "answer.md", "--level", "proven", "--tenant", "acme"]),
    ).rejects.toThrow(/--tenant acme needs a tenants root/);
  });

  test("a path citation into a --tenants-root inside the workspace is state, never a source", async () => {
    const { cwd, tenants } = await managedTree();
    const claim = "The refund window is 90 days for every order";
    writeFileSync(join(tenants, "acme", "note.md"), claim);
    writeAnswer(cwd, `${claim} [1].\n\n[1]: tenants/acme/note.md\n`);
    const r = await run(cwd, [
      "check",
      "answer.md",
      "--level",
      "grounded",
      "--tenant",
      "acme",
      "--tenants-root",
      "tenants",
      "--json",
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "tenants/acme/note.md is not read: the managed tenants root (--tenants-root)",
    );
  });
});

// ---------------------------------------------------------------------------
// research runs: the report bundle beside report.md (§5.4, §8)
// ---------------------------------------------------------------------------

describe("research report bundles — .crewhaus/research/<run>/proof.json", () => {
  const RUN = "run_00000000000000cc";

  /** A research run as the report gate leaves it: report.md, report.json and proof.json. */
  async function researchRun(cwd: string, run = RUN, mtimeMs?: number): Promise<ProofBundle> {
    const bundle = await gradedBundle(GOOD_ANSWER, POLICY);
    const dir = join(cwd, ".crewhaus", "research", run);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.md"), "# report\n");
    writeFileSync(join(dir, "report.json"), "{}\n");
    const path = join(dir, "proof.json");
    writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`);
    if (mtimeMs !== undefined) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
    return bundle;
  }

  test("show finds a research run's bundle — the latest, or by its run id (the Hangar twin)", async () => {
    const cwd = tempDir();
    const bundle = await researchRun(cwd);
    const latest = await run(cwd, ["show"]);
    expect(latest.code).toBe(0);
    expect(latest.out).toContain(`proof bundle · .crewhaus/research/${RUN}/proof.json`);
    expect(latest.out).toContain(`run         ${RUN} · research report`);
    // The exact command Hangar's proof route names for this row.
    const twin = await run(cwd, ["show", "--session", RUN, "--turn", "1", "--json"]);
    expect(JSON.parse(twin.out)).toEqual(JSON.parse(JSON.stringify(bundle)));
    await expect(run(cwd, ["show", "--session", "run_00000000000000dd"])).rejects.toThrow(
      /no proof bundle for session run_00000000000000dd/,
    );
    // check's --session is a session log: a run id is not one.
    writeAnswer(cwd, GOOD_ANSWER);
    await expect(
      run(cwd, ["check", "answer.md", "--level", "cited", "--session", RUN]),
    ).rejects.toThrow(/invalid --session/);
  });

  test("a research spec narrows to its runs; another spec's verbs do not read them", async () => {
    const cwd = tempDir();
    await researchRun(cwd);
    writeFileSync(
      join(cwd, "research.yaml"),
      "name: digest\ntarget: research\nagent:\n  model: claude-opus-5\n  instructions: research\ngoal: learn\nprovability: cited\n",
    );
    expect((await run(cwd, ["show", "research.yaml"])).code).toBe(0);
    const spec = writeSpec(cwd, "support");
    await expect(run(cwd, ["show", spec])).rejects.toThrow(/no proof bundle/);
  });

  test("audit counts research bundles; links and malformed files are not read as bundles", async () => {
    const cwd = tempDir();
    await researchRun(cwd);
    // A run directory linked out of the harness, and a proof.json that is a link.
    const elsewhere = tempDir("provability-research-outside-");
    await researchRun(elsewhere, "run_00000000000000ee");
    symlinkSync(
      join(elsewhere, ".crewhaus", "research", "run_00000000000000ee"),
      join(cwd, ".crewhaus", "research", "run_00000000000000ee"),
    );
    mkdirSync(join(cwd, ".crewhaus", "research", "run_00000000000000ff"));
    symlinkSync(
      join(elsewhere, ".crewhaus", "research", "run_00000000000000ee", "proof.json"),
      join(cwd, ".crewhaus", "research", "run_00000000000000ff", "proof.json"),
    );
    // Not a run id, and a torn bundle.
    mkdirSync(join(cwd, ".crewhaus", "research", "notes"));
    writeFileSync(join(cwd, ".crewhaus", "research", "notes", "proof.json"), "{}");
    mkdirSync(join(cwd, ".crewhaus", "research", "run_0000000000000011"));
    writeFileSync(join(cwd, ".crewhaus", "research", "run_0000000000000011", "proof.json"), "{");
    const audit = JSON.parse((await run(cwd, ["audit", "--json"])).out);
    expect(audit.bundles.count).toBe(1);
    expect(audit.bundles.unreadable).toBe(1);
    expect(audit.bundles.verdicts.pass).toBe(1);
  });

  test("prune removes a stale research bundle and keeps the run's report", async () => {
    const cwd = tempDir();
    await researchRun(cwd, RUN, NOW.getTime() - 100 * DAY);
    await researchRun(cwd, "run_00000000000000dd", NOW.getTime() - DAY);
    const dry = await run(cwd, ["prune", "--older-than", "90d", "--dry-run", "--json"]);
    expect(JSON.parse(dry.out)).toMatchObject({
      wouldRemove: 1,
      bundles: [`.crewhaus/research/${RUN}/proof.json`],
    });
    const r = await run(cwd, ["prune", "--older-than", "90d"]);
    expect(r.out).toContain("removed 1 bundle");
    expect(r.out).toContain("research runs lose only their proof.json");
    const dir = join(cwd, ".crewhaus", "research", RUN);
    expect(readdirSync(dir).sort()).toEqual(["report.json", "report.md"]);
    expect(readdirSync(join(cwd, ".crewhaus", "research", "run_00000000000000dd")).sort()).toEqual([
      "proof.json",
      "report.json",
      "report.md",
    ]);
  });
});
