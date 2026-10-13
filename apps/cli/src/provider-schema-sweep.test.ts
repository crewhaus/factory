/**
 * 0.7.1 — provider-limits#2: on OpenAI, a tool whose schema qualifies for
 * Structured-Outputs strict mode is sent with `strict: true`, and strict mode
 * makes the model send every key. The upgrade used to make an optional
 * property nullable, so the only way to leave one out was `null` — which the
 * builtins' validators refuse (`Grep` with `path: null`: "Expected string,
 * received null").
 *
 * This holds the fix over every builtin, as the model sees it: each tool's
 * advertised schema is captured from the run loop (justification field and
 * all) and translated by the real OpenAI adapter. A tool that goes strict must
 * not have gained a required key its own schema left optional, and its
 * strict schema must accept exactly what the tool's validator accepts for a
 * complete call.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { CanonicalTool, ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { toOpenAIChatParams } from "@crewhaus/adapter-openai";
import { createRunContext } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { loadAllBuiltinTools } from "./builtin-tools-for-tests";

type Schema = Record<string, unknown>;

/** The tool list one request carries, captured at the adapter. */
async function advertised(tools: ReadonlyArray<RegisteredTool>): Promise<CanonicalTool[]> {
  let captured: CanonicalTool[] = [];
  const adapter: ProviderAdapter = {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream: (req) => {
      captured = [...(req.tools ?? [])];
      return (async function* () {
        yield { kind: "message_start" } as const;
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } } as const;
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ok" },
        } as const;
        yield { kind: "content_block_stop", index: 0 } as const;
        yield {
          kind: "message_delta",
          stopReason: "end_turn",
          usage: { input: 1, output: 1 },
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
  await runChatLoop({
    model: "test-model",
    instructions: "x",
    runContext: createRunContext(),
    singleTurn: true,
    seedMessages: [{ role: "user", content: "go" }],
    permissionMode: "bypass",
    tools: [...tools],
    stdout: () => {},
    _adapter: adapter,
  });
  return captured;
}

const isObject = (v: unknown): v is Schema =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Paths of keys the strict schema requires that the original left optional,
 * walking both schemas in step (properties, items, anyOf).
 */
function newlyRequired(original: Schema, strict: Schema, path: string, out: string[]): void {
  const oProps = original["properties"];
  const sProps = strict["properties"];
  if (isObject(oProps) && isObject(sProps)) {
    const was = new Set(Array.isArray(original["required"]) ? original["required"] : []);
    const now = Array.isArray(strict["required"]) ? strict["required"] : [];
    for (const key of now) if (!was.has(key)) out.push(`${path}.${String(key)}`);
    for (const [key, child] of Object.entries(sProps)) {
      const before = oProps[key];
      if (isObject(before) && isObject(child)) newlyRequired(before, child, `${path}.${key}`, out);
    }
  }
  if (isObject(original["items"]) && isObject(strict["items"])) {
    newlyRequired(original["items"], strict["items"], `${path}[]`, out);
  }
  const oAny = original["anyOf"];
  const sAny = strict["anyOf"];
  if (Array.isArray(oAny) && Array.isArray(sAny)) {
    sAny.forEach((member, i) => {
      const before = oAny[i];
      if (isObject(before) && isObject(member)) newlyRequired(before, member, `${path}|${i}`, out);
    });
  }
}

const rows: Array<{ name: string; original: Schema; strict: boolean; parameters: Schema }> = [];
beforeAll(async () => {
  const { tools } = await loadAllBuiltinTools();
  // A few requests' worth, so no provider tool-count ceiling is in play.
  for (let i = 0; i < tools.length; i += 64) {
    const batch = await advertised(tools.slice(i, i + 64));
    const params = toOpenAIChatParams({
      model: "gpt-4o",
      system: [],
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16,
      tools: batch,
    });
    for (const [j, t] of (params.tools ?? []).entries()) {
      const fn = t.function as { name: string; strict?: boolean; parameters?: Schema };
      // The loop adds ListTools to every request; count it once.
      if (rows.some((r) => r.name === fn.name)) continue;
      rows.push({
        name: fn.name,
        original: batch[j]?.input_schema as Schema,
        strict: fn.strict === true,
        parameters: fn.parameters ?? {},
      });
    }
  }
}, 120_000);

describe("OpenAI strict mode never makes a builtin's optional argument mandatory", () => {
  test("the sweep saw every builtin, and some still go strict", () => {
    expect(rows.length).toBeGreaterThanOrEqual(500);
    expect(rows.filter((r) => r.strict).length).toBeGreaterThan(0);
  });

  test("no strict tool requires a key its own schema left optional", () => {
    const offenders: string[] = [];
    for (const row of rows.filter((r) => r.strict)) {
      newlyRequired(row.original, row.parameters, row.name, offenders);
    }
    expect(offenders).toEqual([]);
  });

  test("no strict tool gained a null the tool never accepted", () => {
    const gained = rows
      .filter((r) => r.strict)
      .filter(
        (r) =>
          JSON.stringify(r.parameters).split('"null"').length >
          JSON.stringify(r.original).split('"null"').length,
      )
      .map((r) => r.name);
    expect(gained).toEqual([]);
  });

  test("the tools the audit reproduced stay non-strict, so the model can omit an argument", () => {
    for (const name of ["Grep", "Percent", "DiffParse", "JwtDecode"]) {
      const row = rows.find((r) => r.name === name);
      expect({ name, found: row !== undefined, strict: row?.strict }).toEqual({
        name,
        found: true,
        strict: false,
      });
    }
  });
});
