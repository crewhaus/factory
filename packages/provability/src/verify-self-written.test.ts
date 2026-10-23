/**
 * Design §10's residual — "a model that fetches a page it wrote itself" —
 * is surfaced, not assumed away: a claim that grounds in a body only
 * because an earlier call of the run wrote the words there still grounds
 * (the file does say it now), but the binding names the call that wrote it
 * (`writtenBy`), the bundle counts the origin (`selfWritten`), and the
 * footer, the long form and the report section show it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderFooter, renderMarkdownSection } from "./render";
import { summarizeBundle } from "./summary";
import { type CallSpec, config, evidenceOf, fetched, now } from "./test-helpers";
import type { ProofBinding, ProofBundle, VerifyOptions } from "./types";
import { verifyDocument } from "./verify";

const workspace = mkdtempSync(join(tmpdir(), "prov-self-"));
mkdirSync(join(workspace, "notes"), { recursive: true });
mkdirSync(join(workspace, "docs"), { recursive: true });
const POLICY_TEXT = "The refund window is 30 days from the date of purchase.";
writeFileSync(join(workspace, "notes", "policy.md"), `${POLICY_TEXT}\n`);
writeFileSync(join(workspace, "docs", "policy.md"), `${POLICY_TEXT}\n`);
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

const ANSWER = "The refund window is 30 days from the date of purchase [1].";
const cite = (source: string): string => `${ANSWER}\n\n[1]: ${source}`;

const write = (id: string, path: string, content = POLICY_TEXT, isError = false): CallSpec => ({
  id,
  name: "Write",
  input: { path, content },
  content: isError ? "error: refused" : `wrote ${content.length} bytes to ${path}`,
  isError,
});
const read = (id: string, path: string, content = `${POLICY_TEXT}\n`): CallSpec => ({
  id,
  name: "Read",
  input: { path },
  content,
});

async function verify(
  text: string,
  calls: ReadonlyArray<CallSpec>,
  opts: Partial<VerifyOptions> = {},
): Promise<ProofBundle> {
  return verifyDocument(text, {
    config: config("grounded"),
    evidence: evidenceOf(calls, workspace),
    workspaceRoot: workspace,
    now,
    ...opts,
  });
}

const binding = (bundle: ProofBundle): ProofBinding | undefined => bundle.claims[0]?.bindings[0];

describe("a source the run wrote itself (design §10)", () => {
  test("Write, then Read, then cite it: grounds, and says the run wrote it (the ws-self run)", async () => {
    const bundle = await verify(cite("./notes/policy.md"), [
      write("toolu_w", "notes/policy.md"),
      read("toolu_r", "notes/policy.md"),
    ]);
    expect(bundle.verdict).toBe("pass");
    expect(binding(bundle)).toMatchObject({
      ok: true,
      rung: "grounded",
      origin: "notes/policy.md",
      writtenBy: { toolUseId: "toolu_w", toolName: "Write" },
    });
    expect(bundle.sources).toBe(1);
    expect(bundle.selfWritten).toBe(1);
    expect(summarizeBundle(bundle).selfWritten).toBe(1);
    expect(renderFooter(bundle)).toContain("1 source (1 written by this run)");
    expect(renderMarkdownSection(bundle)).toContain("written by this run");
  });

  test("an Edit's new text counts as the run's own", async () => {
    const bundle = await verify(cite("./notes/policy.md"), [
      {
        id: "toolu_e",
        name: "Edit",
        input: {
          path: "notes/policy.md",
          oldString: "The refund window is 14 days",
          newString: "The refund window is 30 days from the date of purchase.",
        },
        content: "edited notes/policy.md",
      },
      read("toolu_r", "notes/policy.md"),
    ]);
    expect(binding(bundle)?.writtenBy).toEqual({ toolUseId: "toolu_e", toolName: "Edit" });
  });

  test("written elsewhere, copied or moved here, then read: followed back through the copy", async () => {
    const bundle = await verify(cite("./notes/policy.md"), [
      write("toolu_w", "drafts/tmp.md"),
      {
        id: "toolu_mv",
        name: "MovePath",
        input: { source: "drafts/tmp.md", destination: "notes/policy.md" },
        content: "moved drafts/tmp.md to notes/policy.md",
      },
      read("toolu_r", "notes/policy.md"),
    ]);
    expect(binding(bundle)?.writtenBy).toEqual({ toolUseId: "toolu_w", toolName: "Write" });
    // A whole directory copied: each file beneath it maps back.
    const dir = await verify(cite("./notes/policy.md"), [
      write("toolu_w", "drafts/policy.md"),
      {
        id: "toolu_cp",
        name: "CopyPath",
        input: { source: "drafts", destination: "notes" },
        content: "copied drafts to notes",
      },
      read("toolu_r", "notes/policy.md"),
    ]);
    expect(dir.selfWritten).toBe(1);
  });

  test("a PUT to a URL, then a fetch of it: the page is the run's own", async () => {
    const url = "https://wiki.acme.example/policy";
    const bundle = await verify(cite(url), [
      {
        id: "toolu_put",
        name: "HttpRequest",
        input: { url, method: "PUT", body: POLICY_TEXT },
        content: "HTTP 201",
      },
      { id: "toolu_f", name: "WebFetch", input: { url }, content: fetched(url, POLICY_TEXT) },
    ]);
    expect(binding(bundle)).toMatchObject({
      ok: true,
      writtenBy: { toolUseId: "toolu_put", toolName: "HttpRequest" },
    });
  });

  test("not the run's own: read before it was written, written elsewhere, written by an errored call, or only searched for", async () => {
    // Read first: the body read is the file as it was.
    const before = await verify(cite("./notes/policy.md"), [
      read("toolu_r", "notes/policy.md"),
      write("toolu_w", "notes/policy.md"),
    ]);
    expect(binding(before)?.writtenBy).toBeUndefined();
    expect(before.selfWritten).toBeUndefined();
    // The same words written to another file the run never copied here.
    const elsewhere = await verify(cite("./docs/policy.md"), [
      write("toolu_w", "report.md", `Draft: ${POLICY_TEXT}`),
      read("toolu_r", "docs/policy.md"),
    ]);
    expect(binding(elsewhere)).toMatchObject({ ok: true });
    expect(binding(elsewhere)?.writtenBy).toBeUndefined();
    // A Write that failed wrote nothing.
    const failed = await verify(cite("./notes/policy.md"), [
      write("toolu_w", "notes/policy.md", POLICY_TEXT, true),
      read("toolu_r", "notes/policy.md"),
    ]);
    expect(binding(failed)?.writtenBy).toBeUndefined();
    // A pure tool (a search naming the file) writes nothing either.
    const grep: CallSpec = {
      id: "toolu_g",
      name: "Grep",
      input: { path: "notes/policy.md", pattern: POLICY_TEXT },
      content: "notes/policy.md:1",
    };
    const searched = await verify(
      cite("./notes/policy.md"),
      [grep, read("toolu_r", "notes/policy.md")],
      {
        isPureTool: (name) => name === "Grep",
      },
    );
    expect(binding(searched)?.writtenBy).toBeUndefined();
  });

  test("a Write of only part of the claim: the claim's words are not the run's, so not marked", async () => {
    const bundle = await verify(cite("./notes/policy.md"), [
      write("toolu_w", "notes/policy.md", "from the date of purchase"),
      read("toolu_r", "notes/policy.md"),
    ]);
    expect(binding(bundle)).toMatchObject({ ok: true });
    expect(binding(bundle)?.writtenBy).toBeUndefined();
  });

  test("a read the run did not write beside one it did: the unmarked one grounds", async () => {
    const bundle = await verify(cite("./notes/policy.md"), [
      read("toolu_r0", "notes/policy.md"),
      write("toolu_w", "notes/policy.md"),
      read("toolu_r1", "notes/policy.md"),
    ]);
    expect(binding(bundle)?.writtenBy).toBeUndefined();
  });
});
