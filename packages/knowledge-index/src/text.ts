/**
 * What the index keeps of a text: a title of at most 80 characters and a preview of at most
 * 280, both with anything credential-shaped masked before they are cut. Home masks again on
 * the way out, with the harness's own secrets.
 */
import { maskKnowledgeSecrets } from "@crewhaus/harness-lifecycle/knowledge-sync";
import { maskCredentialTokens } from "@crewhaus/spec-patch";

export const TITLE_MAX = 80;
export const PREVIEW_MAX = 280;

/** The text with credential-shaped runs masked, its lines kept. */
export function maskedBody(text: string): string {
  return maskKnowledgeSecrets(maskCredentialTokens(text));
}

/** The text on one line with credential-shaped runs masked. */
export function masked(text: string): string {
  return maskedBody(text).replace(/\s+/g, " ").trim();
}

function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`
    : text;
}

export function titleOf(text: string): string {
  return cut(masked(text), TITLE_MAX);
}

export function previewOf(text: string): string {
  return cut(masked(text), PREVIEW_MAX);
}

/** Tags, masked, without blanks, each short enough to show. */
export function tagsOf(tags: readonly string[]): string[] {
  return tags.map((tag) => cut(masked(tag), TITLE_MAX)).filter((tag) => tag !== "");
}
