/**
 * What leaves with a pull request, checked before it leaves: the lines a change adds, its
 * file names and commit messages, and the pull request's own text.
 *
 * - **Secrets.** A value of a credential-named variable in the harness's own environment
 *   (compared in memory, never written), a credential-shaped token, a password in a URL or
 *   handed to a client, and a file that holds credentials by name. A line that only names a
 *   credential (`apiKey: process.env.API_KEY`) is source code, not a secret.
 * - **Lineage.** Text the run read from a chat, a peer, an MCP server, a chain or the
 *   harness's memory does not ride out in a commit. The item's own words are its subject,
 *   so a change may repeat them.
 *
 * A hit names the file and the line, and never the text.
 */
import { basename } from "node:path";
import { type EgressPolicyOverride, classifyEgress } from "@crewhaus/egress-classifier";
import { credentialFormIn } from "@crewhaus/ir/redact";
import type { RunContext } from "@crewhaus/run-context";
import { isCredentialShapedName } from "@crewhaus/tool-safety/env";
import { isCredentialFileName } from "@crewhaus/tool-safety/fs";
import type { AddedLine } from "./git";

/** A hit: where it is, and why in words. Never the text. */
export type EgressHit = {
  readonly file: string;
  readonly line: number;
  readonly why: string;
};

/** The forms that hold a secret, rather than only naming one. */
const SECRET_FORMS: ReadonlySet<string> = new Set([
  "token",
  "url-password",
  "url-token-user",
  "signed-url",
  "webhook-url",
  "user-password",
  "attached-password",
]);

/** The shortest value of a credential-named variable worth comparing: shorter ones are words. */
const MIN_VALUE_CHARS = 8;

/**
 * The values no change may carry: each credential-named variable's, and each long line of a
 * value that spans lines (a private key).
 */
export function credentialValues(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const out = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !isCredentialShapedName(name)) continue;
    const whole = value.trim();
    if (whole.length >= MIN_VALUE_CHARS) out.add(whole);
    if (!whole.includes("\n")) continue;
    for (const part of whole.split("\n")) {
      const line = part.trim();
      if (line.length >= 16) out.add(line);
    }
  }
  return [...out];
}

/** The secret one text holds, in words, or `undefined`. */
export function secretIn(text: string, values: readonly string[]): string | undefined {
  for (const value of values) {
    if (text.includes(value)) return "a credential of this harness";
  }
  const whole = credentialFormIn(text);
  if (whole !== undefined && SECRET_FORMS.has(whole)) return "a credential";
  // A name-only form can be read first; a word of the line may still hold a secret.
  for (const word of text.split(/[\s"'`,;()<>[\]{}]+/)) {
    if (word.length < MIN_VALUE_CHARS) continue;
    const form = credentialFormIn(word);
    if (form !== undefined && SECRET_FORMS.has(form)) return "a credential";
  }
  return undefined;
}

/** The first secret in a change, its file names or its commit messages, or `undefined`. */
export function scanSecrets(input: {
  readonly added: readonly AddedLine[];
  readonly files: readonly string[];
  readonly messages: string;
  readonly values: readonly string[];
}): EgressHit | undefined {
  for (const file of input.files) {
    if (isCredentialFileName(basename(file))) {
      return { file, line: 0, why: "the file holds credentials by its name" };
    }
    if (secretIn(file, input.values) !== undefined) {
      return { file: "(a file name)", line: 0, why: "a file name holds a credential" };
    }
  }
  for (const line of input.added) {
    const why = secretIn(line.text, input.values);
    if (why !== undefined) return { file: line.file, line: line.line, why };
  }
  for (const [i, text] of input.messages.split("\n").entries()) {
    const why = secretIn(text, input.values);
    if (why !== undefined) return { file: "(a commit message)", line: i + 1, why };
  }
  return undefined;
}

/** Origins whose text never leaves in a commit. Others keep the default policy for a set-up sink. */
export const CODEHOST_EGRESS_POLICY: EgressPolicyOverride = Object.freeze({
  mcp: "block",
  channel: "block",
  federation: "block",
  chain: "block",
  memory: "block",
});

/** The run's lineage without the item's own words, which its change may repeat. */
function lineageBeyond(rc: RunContext, own: readonly string[]): RunContext {
  const lineage = rc.dataLineage;
  if (lineage === undefined || lineage.size === 0) return rc;
  const text = own.join("\n");
  const kept = new Map([...lineage].filter(([content]) => !text.includes(content)));
  return { ...rc, dataLineage: kept };
}

/** Whether a text may leave, by the run's lineage. */
export async function lineageAllows(
  text: string,
  rc: RunContext,
  opts: { readonly sinkId: string; readonly own: readonly string[] },
): Promise<boolean> {
  const answer = await classifyEgress(text, lineageBeyond(rc, opts.own), {
    sinkId: opts.sinkId,
    sinkScope: "external-configured",
    override: CODEHOST_EGRESS_POLICY,
  });
  return answer.verdict !== "block";
}

/**
 * The first added line the run's lineage refuses, or `undefined`. The whole change is
 * checked at once; only when that is refused is the line found, file by file.
 */
export async function scanLineage(input: {
  readonly added: readonly AddedLine[];
  readonly rc: RunContext;
  readonly sinkId: string;
  readonly own: readonly string[];
}): Promise<EgressHit | undefined> {
  const { rc, sinkId, own } = input;
  const whole = input.added.map((l) => l.text).join("\n");
  if (await lineageAllows(whole, rc, { sinkId, own })) return undefined;
  for (const line of input.added) {
    if (!(await lineageAllows(line.text, rc, { sinkId, own }))) {
      return {
        file: line.file,
        line: line.line,
        why: "the text came from a source whose words do not leave in a commit",
      };
    }
  }
  // Refused only across lines: name the first.
  const first = input.added[0];
  return {
    file: first?.file ?? "(the change)",
    line: first?.line ?? 0,
    why: "the text came from a source whose words do not leave in a commit",
  };
}
