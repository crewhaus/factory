/**
 * M3 · SPEC — the builders: the new-spec wizard, the grader builder, the
 * dataset builder, and the MCP connectors tab.
 *
 * These are the four surfaces that CREATE configuration rather than edit it.
 * All four are meant to be thin wrappers over published packages — the
 * manager must not grow a second implementation of any of them — so where a
 * package is not part of this build, the route says so in a typed envelope
 * and names the CLI verb that does the job today. A refusal that explains
 * itself is a feature; a second half-implementation of a dataset builder
 * would be a bug that outlives everyone who wrote it.
 *
 * What IS implemented here, and why it is not a second implementation:
 *
 *   wizard   → a template's SEED spec is a literal document in this module,
 *              and the operator's answers reach it through `applySpecEdits`
 *              — the same atomic, re-validating writer every other spec
 *              write goes through. No YAML is templated from user input.
 *   mcp      → connector writes are spec edits on `mcp_servers:`, applied by
 *              `applySpecEdits` behind the human-owned gate. The connector
 *              list is read leniently so a spec that does not validate (the
 *              exact moment an operator needs this tab) still renders.
 *   graders  → `eval/graders.yaml` is read leniently and written verbatim
 *              from the editor pane; the STRUCTURED builder refuses, because
 *              its serializer is not part of this build.
 *   dataset  → refuses, and points at the dataset routes + `crewhaus
 *              dataset` verbs that own that data.
 *
 * Two traps the connector surface must not re-learn:
 *   - `$FOO` / `${FOO}` inside an MCP `env:` map NEVER expands. A literal
 *     that looks like an env reference is a boot-time `ConfigError` waiting
 *     to happen, and this route says so BEFORE the write.
 *   - a credential pasted as a literal into an MCP config is the single most
 *     common way a secret enters a spec. The write is refused outright — the
 *     value is never masked-and-stored.
 *
 * `POST /api/builders/spec` is the one M3 route that creates a harness
 * DIRECTORY. It takes an absolute `dir` exactly like `POST /api/harnesses`
 * does, validates it the same way, and defaults to a DRY RUN: the first call
 * renders the spec it would write and touches nothing.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { applySpecEdits, isCredentialKey, maskCredentialTokens } from "@crewhaus/spec-patch";
import { MAX_TEXT_BYTES, SAFE_SEGMENT_RE } from "./constants";
import { HttpError } from "./http";
import { readTextCapped } from "./jsonl";
import { type M3Context, type M3Handler, requireTypedConfirm } from "./m3";
import { maskSpecYaml, maskText } from "./mask";
import { commitSpecEdits, previewSpecEdits, readSpecFile, requireWholeSpec } from "./spec-edit";

const SPEC_FILE = "crewhaus.yaml";
const GRADERS_PATH = ["eval", "graders.yaml"] as const;

function refusal(
  code: string,
  reason: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ok: false, code, reason, ...extra };
}

function base(present: boolean, note: string | null, verb: string | null): Record<string, unknown> {
  return { present, note, verb };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hashOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// the wizard's template gallery
// ---------------------------------------------------------------------------

/**
 * One template: a minimal, VALID seed spec for a shape, plus the closed map
 * from an answer key to the spec path that answer writes.
 *
 * The seed is a literal here rather than a string built from the request,
 * and every answer lands through `applySpecEdits` — so the wizard cannot
 * write a field the map does not name, and cannot produce a spec that fails
 * validation without the write being refused.
 */
export type WizardTemplate = {
  readonly id: string;
  readonly title: string;
  readonly target: string;
  readonly summary: string;
  /** What a harness made from this template gets on disk. */
  readonly scaffolds: readonly string[];
  readonly seed: string;
  /** answer key → spec path. Anything else in `answers` is refused. */
  readonly answers: Readonly<Record<string, readonly string[]>>;
};

const AGENT_ANSWERS = {
  name: ["name"],
  model: ["agent", "model"],
  instructions: ["agent", "instructions"],
} as const;

export const WIZARD_TEMPLATES: readonly WizardTemplate[] = [
  {
    id: "cli",
    title: "Single agent (CLI)",
    target: "cli",
    summary: "One agent with instructions and tools, run from a terminal or compiled to a bundle.",
    scaffolds: [SPEC_FILE],
    seed: [
      "name: my-agent",
      "target: cli",
      "agent:",
      "  model: anthropic/claude-sonnet-4",
      "  instructions: |",
      "    You are a helpful assistant. Answer briefly.",
      "",
    ].join("\n"),
    answers: AGENT_ANSWERS,
  },
  {
    id: "channel",
    title: "Chat bot (channel)",
    target: "channel",
    summary: "A long-running daemon that answers in a chat channel, keyed by thread.",
    scaffolds: [SPEC_FILE],
    seed: [
      "name: my-bot",
      "target: channel",
      "agent:",
      "  model: anthropic/claude-sonnet-4",
      "  instructions: |",
      "    You answer questions in chat. Be brief.",
      "channels:",
      "  slack:",
      "    botToken: $SLACK_BOT_TOKEN",
      "    signingSecret: $SLACK_SIGNING_SECRET",
      "routing:",
      "  sessionKey: thread",
      "",
    ].join("\n"),
    answers: AGENT_ANSWERS,
  },
  {
    id: "workflow",
    title: "Sequential workflow",
    target: "workflow",
    summary: "Named steps that run in order, each with its own instructions.",
    scaffolds: [SPEC_FILE],
    seed: [
      "name: my-workflow",
      "target: workflow",
      "model: anthropic/claude-sonnet-4",
      "steps:",
      "  - name: draft",
      "    instructions: |",
      "      Draft an answer to the request.",
      "",
    ].join("\n"),
    answers: { name: ["name"], model: ["model"] },
  },
  {
    id: "graph",
    title: "Branching graph",
    target: "graph",
    summary: "Nodes and edges with an entry node — the shape for conditional routing.",
    scaffolds: [SPEC_FILE],
    seed: [
      "name: my-graph",
      "target: graph",
      "model: anthropic/claude-sonnet-4",
      "entry: start",
      "nodes:",
      "  start:",
      "    instructions: |",
      "      Answer the request.",
      "",
    ].join("\n"),
    answers: { name: ["name"], model: ["model"] },
  },
  {
    id: "crew",
    title: "Multi-role crew",
    target: "crew",
    summary: "Several named roles sharing one loop, entered through a lead role.",
    scaffolds: [SPEC_FILE],
    seed: [
      "name: my-crew",
      "target: crew",
      "model: anthropic/claude-sonnet-4",
      "entry: researcher",
      "roles:",
      "  researcher:",
      "    instructions: |",
      "      Research the question and report back.",
      "",
    ].join("\n"),
    answers: { name: ["name"], model: ["model"] },
  },
];

const TEMPLATE_NOTE =
  "these are the seed shapes this build ships; the full starter catalog lives with `crewhaus init`";

/**
 * `GET /api/builders/templates` — the wizard's template gallery.
 *
 * Fleet-wide (no harness yet): the templates the wizard picks from, each
 * with its target shape, what it scaffolds, and the answer fields the form
 * renders.
 */
export const wizardTemplates: M3Handler = () => ({
  ...base(true, TEMPLATE_NOTE, "crewhaus init"),
  templates: WIZARD_TEMPLATES.map((t) => ({
    id: t.id,
    title: t.title,
    target: t.target,
    summary: t.summary,
    scaffolds: t.scaffolds,
    // `answer`, not `key`: `key` is one of the names the outbound tree
    // masker redacts wholesale, and a form whose fields are all "[redacted]"
    // is not a form.
    fields: Object.entries(t.answers).map(([answer, path]) => ({
      answer,
      path: path.join("."),
    })),
    // Served verbatim, and deliberately so: a seed is a literal in THIS
    // module (never data off a disk), and `maskSpecYaml` is a line scanner
    // that redacts by key name — it turns `sessionKey: thread` into
    // `[redacted]`, which YAML then reads as a one-item list. A corrupted
    // preview would be a worse answer than an unmasked constant. The seeds
    // are asserted credential-free by this module's own test.
    preview: t.seed,
  })),
});

/**
 * `POST /api/builders/spec` — materialize a new harness from wizard answers.
 *
 * Body: `{ dir, template, answers, dryRun?, confirmName? }`. `dir` is
 * absolute and validated like `POST /api/harnesses` validates one. DRY RUN
 * IS THE DEFAULT: the first call renders the spec and touches nothing, and
 * only `{"dryRun": false}` plus the typed spec name writes it.
 *
 * The manager registers nothing itself — the answer names the registration
 * route so the Library picks the new harness up on the console's next call.
 * `scaffold-evals` is offered next, never done implicitly.
 */
export const wizardCreate: M3Handler = (ctx) => {
  const rawDir = ctx.body["dir"];
  if (typeof rawDir !== "string" || rawDir === "") throw new HttpError(400, 'missing "dir"');
  if (rawDir.includes("\0")) throw new HttpError(400, '"dir" is not a path');
  if (!isAbsolute(rawDir)) throw new HttpError(400, '"dir" must be an absolute path');
  const dir = resolve(rawDir);
  const templateId = ctx.body["template"];
  if (typeof templateId !== "string" || templateId === "") {
    throw new HttpError(400, 'missing "template"');
  }
  const template = WIZARD_TEMPLATES.find((t) => t.id === templateId);
  if (template === undefined) {
    throw new HttpError(
      400,
      `unknown template "${templateId}" — GET /api/builders/templates lists the ones this build ships`,
    );
  }
  const rawAnswers = ctx.body["answers"];
  if (rawAnswers !== undefined && !isPlainObject(rawAnswers)) {
    throw new HttpError(400, '"answers" must be an object');
  }
  const edits: Array<{ path: readonly string[]; value: unknown }> = [];
  for (const [key, value] of Object.entries(rawAnswers ?? {})) {
    const path = template.answers[key];
    if (path === undefined) {
      throw new HttpError(
        400,
        `template "${template.id}" has no answer "${key}" (it takes: ${Object.keys(template.answers).join(", ")})`,
      );
    }
    if (typeof value !== "string" || value === "") {
      throw new HttpError(400, `answer "${key}" must be a non-empty string`);
    }
    edits.push({ path, value });
  }

  let yaml: string;
  try {
    yaml = applySpecEdits(template.seed, edits).yaml;
  } catch (err) {
    return refusal("invalid_answers", maskText(err instanceof Error ? err.message : String(err)), {
      template: template.id,
      target: template.target,
    });
  }
  const specPath = `${dir}/${SPEC_FILE}`;
  const dirExists = existsSync(dir);
  const specExists = existsSync(specPath);
  const dryRun = ctx.body["dryRun"] !== false;
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      dir,
      template: template.id,
      target: template.target,
      dirExists,
      specExists,
      willCreate: specExists ? [] : [SPEC_FILE],
      yaml: maskSpecYaml(yaml),
      // The name the operator has to type to turn this plan into files.
      confirmName: readSeedName(yaml),
      next: { scaffoldEvals: "crewhaus scaffold-evals", register: "addHarness" },
      note: specExists
        ? "a crewhaus.yaml already exists in that directory — this wizard never overwrites one"
        : 'dry run: nothing was written. Send {"dryRun": false, "confirmName": "<name>"} to create it.',
    };
  }
  if (specExists) {
    return refusal("spec_exists", `${specPath} already exists — the wizard never overwrites one`, {
      dir,
      verb: "crewhaus init",
    });
  }
  requireTypedConfirm(ctx.body, readSeedName(yaml));
  if (dirExists && !statSync(dir).isDirectory()) {
    throw new HttpError(400, '"dir" exists and is not a directory');
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(specPath, yaml, { mode: 0o644 });
  } catch (err) {
    return refusal("not_writable", maskText(err instanceof Error ? err.message : String(err)), {
      dir,
    });
  }
  return {
    ok: true,
    dryRun: false,
    created: true,
    dir,
    template: template.id,
    target: template.target,
    files: [SPEC_FILE],
    yaml: maskSpecYaml(yaml),
    // The manager's registry is not reachable from a route handler, so the
    // console completes the flow with the registration route it already has.
    registerWith: { route: "addHarness", dir },
    next: { scaffoldEvals: "crewhaus scaffold-evals" },
    note: "the harness exists on disk; register it to see it in the Library",
  };
};

/** The `name:` a rendered seed carries — the typed-confirm target. */
function readSeedName(yaml: string): string {
  const m = yaml.match(/^name:\s*(.+)$/m);
  return (m?.[1] ?? "").trim().replace(/^["']|["']$/g, "") || "spec";
}

// ---------------------------------------------------------------------------
// graders
// ---------------------------------------------------------------------------

/** Lenient scan of a `graders.yaml`: the `name`/`type` of each list item.
 *  A parse would refuse a file one grader-kind ahead of this manager; the
 *  panel has to render it anyway. */
export function scanGraders(yamlText: string): Array<{ name: string | null; type: string | null }> {
  const out: Array<{ name: string | null; type: string | null }> = [];
  let current: { name: string | null; type: string | null } | null = null;
  for (const raw of yamlText.split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item !== null) {
      if (current !== null) out.push(current);
      current = { name: null, type: null };
      applyGraderField(current, item[1] ?? "");
      continue;
    }
    if (current !== null) applyGraderField(current, line.trim());
  }
  if (current !== null) out.push(current);
  return out.filter((g) => g.name !== null || g.type !== null);
}

function applyGraderField(into: { name: string | null; type: string | null }, text: string): void {
  const m = text.match(/^(name|type)\s*:\s*(.+)$/);
  if (m === null) return;
  const value = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
  if (m[1] === "name") into.name = value;
  else into.type = value;
}

const GRADERS_VERB = "crewhaus graders suggest -o eval/graders.yaml";

/**
 * `GET /api/h/:id/builders/graders` — this harness's `eval/graders.yaml`,
 * rendered with the hash a run's `gradersHash` is compared against, so an
 * operator can see WHICH graders a run was scored by.
 */
export const graderCatalog: M3Handler = (ctx) => {
  const path = ctx.contain([...GRADERS_PATH]);
  const present = existsSync(path);
  const read = present ? readTextCapped(path, MAX_TEXT_BYTES) : { text: "", truncated: false };
  return {
    ...base(present, present ? null : "this harness has no eval/graders.yaml yet", GRADERS_VERB),
    path: GRADERS_PATH.join("/"),
    graders: present ? scanGraders(read.text) : [],
    /** MASKED, and capped — a VIEW of the file. {@link graderWrite} refuses
     *  to take this string back, because saving it would rename the mask
     *  over whatever it hid. */
    yaml: present ? maskSpecYaml(read.text) : null,
    hash: present ? hashOf(read.text) : null,
    truncated: read.truncated,
    cardVerb: "crewhaus graders card eval/graders.yaml",
    // The structured builder is a published package this build does not
    // bundle; the YAML pane below it is the write path that works today.
    structuredBuilder: false,
  };
};

/** The two spans this server's maskers leave behind: `[redacted]` from the
 *  key-name redactor, `***` from the token-shape one. */
const MASK_MARKS = ["[redacted]", "***"] as const;

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * The mark an incoming document INTRODUCES relative to the stored one, or
 * null when it introduces none.
 *
 * A count, not a substring test: an operator's own `***` already in the file
 * is theirs to keep, and only an increase means a masked span is arriving
 * where real content used to be. A document with nothing stored behind it
 * cannot be a masked view of anything, so that case never asks.
 */
export function newlyMaskedSpan(stored: string, incoming: string): string | null {
  if (stored === "") return null;
  for (const mark of MASK_MARKS) {
    if (countOf(incoming, mark) > countOf(stored, mark)) return mark;
  }
  return null;
}

/**
 * `POST /api/h/:id/builders/graders` — write `eval/graders.yaml`.
 *
 * `{ yaml, confirmName }` writes the editor pane verbatim, containment
 * checked, then re-reads so the response is what is actually on disk. A
 * STRUCTURED `{ graders: [...] }` write is refused: its serializer lives in
 * the published grader-builder, and hand-rolling a second one is exactly the
 * duplication this surface exists to avoid.
 *
 * Two refusals guard the round trip, because the pane the console posts back
 * was prefilled from {@link graderCatalog} — a MASKED, CAPPED read:
 *
 *   - a body that introduces a mask span the stored file does not have is
 *     the masked view being saved over the real document. Persisting `***`
 *     would replace whatever it hid: silent data loss dressed up as safety.
 *   - a stored file past the read cap cannot be compared (and the pane only
 *     ever held its head), so the write is refused rather than allowed to
 *     truncate it.
 *
 * Both name the verb that does the job. A masked or capped read is a VIEW,
 * never a source for a write.
 */
export const graderWrite: M3Handler = (ctx) => {
  const yaml = ctx.body["yaml"];
  const path = ctx.contain([...GRADERS_PATH]);
  if (typeof yaml !== "string") {
    return refusal(
      "structured_writer_unavailable",
      "the structured grader builder ships in the published grader-builder package, which this manager does not bundle",
      {
        ...base(existsSync(path), null, GRADERS_VERB),
        path: GRADERS_PATH.join("/"),
        accepts: '{ "yaml": "<graders.yaml text>", "confirmName": "<spec name>" }',
      },
    );
  }
  if (yaml.trim() === "") throw new HttpError(400, '"yaml" is empty');
  const file = readSpecFile(ctx);
  requireTypedConfirm(ctx.body, file.specName);
  const stored = existsSync(path)
    ? readTextCapped(path, MAX_TEXT_BYTES)
    : { text: "", truncated: false };
  if (stored.truncated) {
    throw new HttpError(
      409,
      `the existing ${GRADERS_PATH.join("/")} is larger than this server reads (${MAX_TEXT_BYTES} bytes) — refusing to replace a file it could only show you the head of. Edit it with \`${GRADERS_VERB}\` or an editor.`,
    );
  }
  const mark = newlyMaskedSpan(stored.text, yaml);
  if (mark !== null) {
    throw new HttpError(
      409,
      `this body introduces a masked span (${mark}) the stored ${GRADERS_PATH.join("/")} does not have — the editor pane is served MASKED, and saving it would replace what the mask hid. Edit the file with \`${GRADERS_VERB}\` or an editor.`,
    );
  }
  const dir = ctx.contain([GRADERS_PATH[0]]);
  mkdirSync(dir, { recursive: true });
  // In PLACE, not tmp+rename: `mode` applies only when the file is created,
  // so an existing graders.yaml keeps the permissions its author gave it.
  // (A rename would replace the inode and impose this mode — which is the
  // trap `writeSpecFile` has to work around.)
  writeFileSync(path, yaml.endsWith("\n") ? yaml : `${yaml}\n`, { mode: 0o644 });
  // Re-read: the answer is what is on disk, not what was sent.
  const onDisk = readTextCapped(path, MAX_TEXT_BYTES).text;
  return {
    ok: true,
    path: GRADERS_PATH.join("/"),
    graders: scanGraders(onDisk),
    yaml: maskSpecYaml(onDisk),
    hash: hashOf(onDisk),
    verb: GRADERS_VERB,
    note: "runs scored after this write carry a new gradersHash — earlier runs keep the graders they were scored by",
  };
};

// ---------------------------------------------------------------------------
// dataset builder
// ---------------------------------------------------------------------------

const DATASET_NOTE =
  "the dataset builder's state machine ships in the published dataset-builder package, which this manager does not bundle";
const DATASET_VERB = "crewhaus dataset mine|synthesize";

/**
 * `GET /api/h/:id/builders/dataset` — the dataset builder's current state.
 *
 * Honestly empty in this build: the machine is a published package, and the
 * datasets themselves are owned by the dataset registry routes.
 */
export const datasetBuilder: M3Handler = () => ({
  ...base(false, DATASET_NOTE, DATASET_VERB),
  state: null,
  events: [],
  registryRoute: "datasets",
});

/**
 * `POST /api/h/:id/builders/dataset` — advance the dataset builder.
 *
 * The machine owns the transitions; this route encodes none of them, so with
 * the machine absent it refuses rather than inventing a second one.
 */
export const datasetBuilderStep: M3Handler = (ctx) => {
  const event = ctx.body["event"];
  if (typeof event !== "string" || event === "") throw new HttpError(400, 'missing "event"');
  return refusal("builder_unavailable", DATASET_NOTE, {
    event,
    verb: DATASET_VERB,
    registryRoute: "datasets",
  });
};

// ---------------------------------------------------------------------------
// MCP connectors
// ---------------------------------------------------------------------------

/** The spec block MCP servers live under. */
const MCP_KEY = "mcp_servers";

export type McpServerRow = {
  readonly name: string;
  readonly transport: string;
  readonly command: string | null;
  readonly url: string | null;
  readonly args: readonly string[];
  /** Env NAMES only — a value never leaves this process. */
  readonly envKeys: readonly string[];
};

/**
 * A lint row. The env variable's NAME is carried as `envName`, never `key`:
 * every M3 payload passes the tree masker on the way out, `key` is one of the
 * credential-container key names it redacts wholesale, and a redacted lint
 * row would name no variable at all.
 */
export type McpFinding = {
  readonly server: string;
  readonly envName: string | null;
  readonly level: "bad" | "warn" | "info";
  readonly code: string;
  readonly message: string;
};

type ScannedEnv = { readonly key: string; readonly value: string };
type ScannedServer = McpServerRow & { readonly env: readonly ScannedEnv[] };

/**
 * Lenient scan of the spec's `mcp_servers:` block.
 *
 * A parse would refuse a spec that does not validate — which is exactly when
 * an operator opens this tab — so the connector list comes from the text.
 * Values are read ONLY to lint them; nothing but names reaches a payload.
 */
export function scanMcpServers(yamlText: string): ScannedServer[] {
  const lines = yamlText.split("\n").map((l) => l.replace(/\t/g, "  "));
  const out: ScannedServer[] = [];
  let blockIndent: number | null = null;
  let server: {
    name: string;
    indent: number;
    transport: string | null;
    command: string | null;
    url: string | null;
    args: string[];
    env: ScannedEnv[];
    envIndent: number | null;
  } | null = null;
  const flush = (): void => {
    if (server === null) return;
    out.push({
      name: server.name,
      transport: server.transport ?? (server.url !== null ? "sse" : "stdio"),
      command: server.command,
      url: server.url,
      args: server.args,
      envKeys: server.env.map((e) => e.key),
      env: server.env,
    });
    server = null;
  };
  for (const line of lines) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (blockIndent === null) {
      if (new RegExp(`^${MCP_KEY}\\s*:\\s*(?:#.*)?$`).test(line)) {
        blockIndent = 0;
        continue;
      }
      continue;
    }
    if (indent <= blockIndent) {
      flush();
      blockIndent = null;
      continue;
    }
    const entry = line.match(/^(\s*)([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/);
    if (entry === null) continue;
    const keyIndent = (entry[1] ?? "").length;
    const key = entry[2] as string;
    const value = (entry[3] ?? "").trim();
    if (server === null || keyIndent <= server.indent) {
      flush();
      server = {
        name: key,
        indent: keyIndent,
        transport: null,
        command: null,
        url: null,
        args: [],
        env: [],
        envIndent: null,
      };
      continue;
    }
    if (server.envIndent !== null && keyIndent > server.envIndent) {
      server.env.push({ key, value: unquote(value) });
      continue;
    }
    server.envIndent = null;
    if (key === "env") {
      server.envIndent = keyIndent;
      continue;
    }
    if (key === "transport") server.transport = unquote(value);
    else if (key === "command") server.command = unquote(value);
    else if (key === "url") server.url = unquote(value);
    else if (key === "args") server.args = parseInlineList(value);
  }
  flush();
  return out;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && /^(".*"|'.*')$/.test(trimmed)) return trimmed.slice(1, -1);
  return trimmed;
}

function parseInlineList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return [];
  return trimmed
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((part) => unquote(part))
    .filter((part) => part !== "");
}

const ENV_REF_ANYWHERE_RE = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/;

/**
 * Does this `KEY: value` pair look like a pasted credential?
 *
 * Two layers, and the second is why the key is glued to the value before the
 * masker sees it: the token-shape masker only masks a generic opaque string
 * when a key-ish word precedes it, and here the key IS that context.
 */
/**
 * Which part of an SSE URL looks like a credential, or undefined when none
 * does. Checks the three places a key actually rides:
 *
 *   userinfo      — `https://user:KEY@host/…` (also leaks via Referer)
 *   path segment  — `/v2/<32+ opaque chars>`, the Alchemy/Infura shape
 *   query value   — `?apiKey=…`, by key name OR by opaque shape
 *
 * Deliberately refuses rather than masks: this value is written into the
 * harness's committed `crewhaus.yaml`.
 */
export function sseUrlCredential(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined; // not a URL we can reason about; the spec editor path applies
  }
  if (parsed.username !== "" || parsed.password !== "") return "userinfo";
  for (const segment of parsed.pathname.split("/")) {
    if (OPAQUE_URL_PART_RE.test(segment)) return "a path segment";
  }
  for (const [key, value] of parsed.searchParams) {
    if (value !== "" && (isCredentialKey(key) || OPAQUE_URL_PART_RE.test(value))) {
      return `the "${key}" query parameter`;
    }
  }
  return undefined;
}

/** A standalone opaque token: long, and not a word. Mirrors the read-side
 *  rule in `mask.ts` so the write refusal and the display masking agree. */
const OPAQUE_URL_PART_RE = /^[A-Za-z0-9_-]{32,}$/;

export function looksLikeCredential(key: string, value: string): boolean {
  if (value === "") return false;
  if (isCredentialKey(key)) return true;
  const probe = `${key}: ${value}`;
  return maskCredentialTokens(probe) !== probe;
}

/**
 * Lint one connector's env map. Two findings matter more than the rest:
 *
 *   never_expands — `$FOO` inside an MCP `env:` map is passed through as the
 *     six literal characters. The server sees `$FOO`, not the secret, and
 *     the failure surfaces at boot as a ConfigError. Say it before the write.
 *   credential_literal — a value that looks like a secret IS one. The write
 *     is refused; masking it and continuing would put it in the spec.
 */
export function lintMcpEnv(
  server: string,
  env: readonly ScannedEnv[],
  present: (key: string) => boolean,
): McpFinding[] {
  const findings: McpFinding[] = [];
  for (const { key, value } of env) {
    if (ENV_REF_ANYWHERE_RE.test(value)) {
      findings.push({
        server,
        envName: key,
        level: "bad",
        code: "never_expands",
        message: `"${key}" is set to an env REFERENCE, and an MCP env map never expands one — the server receives the literal text. Set the value in this harness's .env instead and leave the key out of the spec.`,
      });
      continue;
    }
    if (looksLikeCredential(key, value)) {
      findings.push({
        server,
        envName: key,
        level: "bad",
        code: "credential_literal",
        message: `"${key}" carries a literal value that looks like a credential. Move it to this harness's .env — the spec is committed, and a value here is a leak.`,
      });
      continue;
    }
    if (!present(key)) {
      findings.push({
        server,
        envName: key,
        level: "warn",
        code: "unset_env",
        message: `"${key}" is not set in this harness's environment — the server will boot without it.`,
      });
    }
  }
  return findings;
}

/**
 * `GET /api/builders/mcp-catalog` — the curated MCP connector catalog.
 *
 * Fleet-wide, harness-independent, and deliberately small: it is a starting
 * point for the form, never a whitelist. Custom entries are typed by hand
 * into the same fields.
 */
export const mcpCatalog: M3Handler = () => ({
  ...base(
    true,
    "a starting point for the form — any stdio or SSE server can be typed by hand",
    null,
  ),
  connectors: [
    {
      id: "custom-stdio",
      title: "stdio server",
      transport: "stdio",
      command: "bunx",
      args: ["-y", "<package>"],
      envRefs: [],
      summary: "A server the harness spawns and speaks to over stdio — the common case.",
    },
    {
      id: "custom-sse",
      title: "SSE endpoint",
      transport: "sse",
      command: null,
      args: [],
      envRefs: [],
      summary:
        "A hosted server the harness connects to over SSE. Its auth headers are a spec edit, not a connector field.",
    },
  ],
});

/**
 * `GET /api/h/:id/builders/mcp` — this harness's `mcp_servers:` block plus
 * the lint.
 *
 * Every server's env refs resolve to PRESENCE booleans (never values), with
 * the never-expanding `$FOO` literals and credential-shaped literals flagged
 * next to the editor.
 */
export const mcpConnectors: M3Handler = (ctx) => {
  const file = readSpecFile(ctx);
  const present = (key: string): boolean => {
    const value = ctx.env[key];
    return value !== undefined && value !== "";
  };
  const scanned = file.present ? scanMcpServers(file.text) : [];
  const findings: McpFinding[] = [];
  const servers = scanned.map((server) => {
    findings.push(...lintMcpEnv(server.name, server.env, present));
    return {
      name: server.name,
      transport: server.transport,
      command: server.command,
      url: server.url,
      args: server.args,
      // Names + presence only — a value never crosses this boundary. The
      // field is `envRefs[].name`, not `env[].key`: both `env` and `key` are
      // names the outbound tree masker redacts wholesale, which would leave
      // the panel listing "[redacted]" instead of the variable to go set.
      envRefs: server.envKeys.map((name) => ({ name, set: present(name) })),
    };
  });
  return {
    ...base(
      servers.length > 0,
      servers.length > 0
        ? null
        : file.present
          ? "this spec declares no MCP servers"
          : `no ${SPEC_FILE} in this harness`,
      "crewhaus mcp doctor",
    ),
    specName: file.specName,
    target: file.target,
    block: MCP_KEY,
    servers,
    findings,
    confirmName: file.specName,
    catalogRoute: "mcpCatalog",
    /** True ⇒ this list was scanned from the HEAD of an over-cap spec, so a
     *  server declared past the cap is missing from it — and both connector
     *  writes refuse rather than round-trip that read. */
    truncated: file.truncated,
  };
};

/** Validate the connector body into the spec value `mcp_servers.<name>`
 *  carries. Refuses the two traps outright — a refused write is the point. */
function connectorValue(ctx: M3Context): { name: string; value: Record<string, unknown> } {
  const name = ctx.body["name"];
  if (typeof name !== "string" || !SAFE_SEGMENT_RE.test(name)) {
    throw new HttpError(400, '"name" must be a plain server name');
  }
  const transport = ctx.body["transport"] ?? "stdio";
  if (transport !== "stdio" && transport !== "sse") {
    throw new HttpError(400, '"transport" must be "stdio" or "sse"');
  }
  const envRaw = ctx.body["env"];
  const env: Record<string, string> = {};
  if (envRaw !== undefined) {
    if (!isPlainObject(envRaw)) throw new HttpError(400, '"env" must be an object');
    for (const [key, value] of Object.entries(envRaw)) {
      if (typeof value !== "string") throw new HttpError(400, `env "${key}" must be a string`);
      if (ENV_REF_ANYWHERE_RE.test(value)) {
        throw new HttpError(
          400,
          `env "${key}" is an env REFERENCE, and an MCP env map never expands one — the server would receive the literal text. Set it in this harness's .env and drop it from the spec.`,
        );
      }
      if (looksLikeCredential(key, value)) {
        throw new HttpError(
          400,
          `env "${key}" carries a literal that looks like a credential — put it in this harness's .env instead. The spec is committed; a value here is a leak.`,
        );
      }
      env[key] = value;
    }
  }
  if (transport === "sse") {
    const url = ctx.body["url"];
    if (typeof url !== "string" || url === "") throw new HttpError(400, 'sse needs a "url"');
    // The URL is a credential carrier too, and the read-side masker cannot
    // save us here: masking a value that has already been written is not the
    // same as refusing to write it. An Alchemy/Infura-style key rides in a
    // PATH SEGMENT (`/v2/<key>`), a query value, or userinfo — and this value
    // lands in `crewhaus.yaml`, which is committed to the operator's repo.
    const credentialPart = sseUrlCredential(url);
    if (credentialPart !== undefined) {
      throw new HttpError(
        400,
        `sse "url" carries ${credentialPart} that looks like a credential — put it in this harness's .env and reference it, or add the connector as a spec edit through the editor. The spec is committed; a value here is a leak.`,
      );
    }
    if (ctx.body["headers"] !== undefined) {
      // SSE auth headers are credential carriers with their own lowering
      // rules. This form refuses to guess them: they are a spec edit, made
      // deliberately, through the trust-gated editor.
      throw new HttpError(
        400,
        'sse "headers" carry credentials — add them as a spec edit through the editor, not through this form',
      );
    }
    return { name, value: { transport: "sse", url } };
  }
  const command = ctx.body["command"];
  if (typeof command !== "string" || command === "") {
    throw new HttpError(400, 'stdio needs a "command"');
  }
  const argsRaw = ctx.body["args"] ?? [];
  if (!Array.isArray(argsRaw) || argsRaw.some((a) => typeof a !== "string")) {
    throw new HttpError(400, '"args" must be an array of strings');
  }
  return {
    name,
    value: {
      transport: "stdio",
      command,
      args: argsRaw as string[],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    },
  };
}

/**
 * `POST /api/h/:id/builders/mcp` — add/replace one MCP server entry.
 *
 * `mcp_servers:` is human-owned, so this is dry-run-first: the default call
 * answers the credential-redacted diff plus the lint, and only
 * `{"dryRun": false, "confirmName": "<spec name>"}` applies it — through
 * `applySpecEdits`, never by splicing YAML text.
 */
export const mcpConnectorWrite: M3Handler = async (ctx) => {
  const file = readSpecFile(ctx);
  if (!file.present) {
    return refusal("no_spec", `this harness has no ${SPEC_FILE} to write into`, {
      verb: "crewhaus init",
    });
  }
  // A connector write is a spec edit, so it inherits the write path's
  // refusal — but it has to fire HERE, before the dry run: a preview built
  // from the head of an over-cap spec would show a clean diff for a batch
  // that can never be applied.
  requireWholeSpec(file);
  const { name, value } = connectorValue(ctx);
  const edits = [{ path: [MCP_KEY, name], value }];
  const preview = previewSpecEdits(file.text, edits);
  const dryRun = ctx.body["dryRun"] !== false;
  if (!preview.ok) {
    return refusal("edit_rejected", preview.error ?? "the connector does not apply", {
      name,
      confirmName: file.specName,
    });
  }
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      name,
      replaces: scanMcpServers(file.text).some((s) => s.name === name),
      entries: preview.entries,
      diff: preview.diff,
      confirmName: file.specName,
      note: '`mcp_servers` is human-owned: review the diff, then send {"dryRun": false, "confirmName": "<spec name>"}.',
    };
  }
  requireTypedConfirm(ctx.body, file.specName);
  const committed = await commitSpecEdits(ctx, edits);
  return { ...committed, name, action: "write" };
};

/**
 * `DELETE /api/h/:id/builders/mcp/:name` — remove one MCP server entry.
 *
 * A spec edit like any other, so it is confirm-gated and goes through the
 * spec write path rather than a YAML splice. A DELETE carries no body, so
 * the typed confirmation arrives as `?confirmName=<spec name>`; without it
 * the route answers the PLAN (what would be removed, and the diff).
 */
export const mcpConnectorRemove: M3Handler = async (ctx) => {
  const file = readSpecFile(ctx);
  // Before the "is it declared?" answer, which would otherwise be read off
  // the head of an over-cap spec and report a server past the cap as absent.
  requireWholeSpec(file);
  const name = ctx.params["name"] as string;
  const declared = scanMcpServers(file.text).map((s) => s.name);
  if (!declared.includes(name)) {
    return refusal("not_declared", `this spec declares no MCP server "${name}"`, {
      name,
      servers: declared,
    });
  }
  // Removing the LAST server takes the block with it: an empty `mcp_servers:
  // {}` is valid but reads as a leftover, and the next author has to guess
  // whether it means "none" or "not finished".
  const edits = declared.length === 1 ? [{ path: [MCP_KEY] }] : [{ path: [MCP_KEY, name] }];
  const preview = previewSpecEdits(file.text, edits);
  const confirmName = ctx.query.get("confirmName");
  if (confirmName !== file.specName) {
    return {
      ok: true,
      dryRun: true,
      name,
      entries: preview.entries,
      diff: preview.diff,
      confirmName: file.specName,
      note: `removing an MCP server is a human-owned spec edit — repeat this call with ?confirmName=${file.specName}`,
    };
  }
  const committed = await commitSpecEdits(ctx, edits);
  return { ...committed, name, action: "remove" };
};
