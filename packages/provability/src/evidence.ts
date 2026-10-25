/**
 * The evidence index: every body the run read and every result it got,
 * keyed by where it came from (design §5.2).
 *
 * Grounding needs the bodies, and they are already persisted: the session
 * event log records every `tool_use` (full input) and `tool_result` (full
 * output, `isError`) verbatim — the fact the 0.3.0 proof ladder was built on.
 * The index is built from the log, children included, because compaction may
 * have evicted a fetch from the conversation but cannot evict it from the
 * log; `evidenceFromMessages` reads the in-memory transcript for the turn
 * still in flight (and for callers with no log), and `buildEvidenceIndex`
 * merges the two into one record per call.
 *
 * Nothing here classifies, fetches or trusts anything. A record is what the
 * tool returned, verbatim; an origin is read off the call's input and the
 * result's own header; the verifiers decide what a record proves.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { classifyDefinition, contentTokens, coverage } from "@crewhaus/claim-ledger";
import { CrewhausError } from "@crewhaus/errors";
import { DEFAULT_ROOT_DIR, openEventLog } from "@crewhaus/event-log";
import { defaultCatalog } from "@crewhaus/tool-catalog";
import { openForReadSync } from "@crewhaus/tool-safety/fs";
import {
  FETCH,
  PROVABILITY_PREFLIGHT,
  READ,
  RETRIEVE,
  WEB_FETCH,
  builtinKey,
  isMcpTool,
} from "./builtins";
import { type PathRoots, doiUrl, normalizePath, normalizeUrl } from "./origin";
import type { EvidenceIndex, EvidenceRecord } from "./types";

const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;
/** How deep the sub-agent bracket walk descends (continuity-store's bound). */
const DEFAULT_MAX_DEPTH = 8;
/** Input fields that name a URL the call fetched. */
const URL_FIELDS = ["url", "uri", "href"] as const;
/** Input fields that name a workspace file the call read. */
const PATH_FIELDS = ["file_path", "path", "file", "filePath"] as const;
/** Fields of a JSON hit that name where the hit came from, in preference order. */
const HIT_ORIGIN_FIELDS = ["url", "uri", "href", "link", "source"] as const;
/** Fields of a JSON hit that carry its text, in the order they are joined. */
const HIT_TEXT_FIELDS = [
  "title",
  "text",
  "content",
  "body",
  "snippet",
  "excerpt",
  "chunk",
  "pageContent",
  "page_content",
  "summary",
  "abstract",
  "description",
] as const;
/** A JSON result larger than this is not parsed for hits (it is still one body). */
const MAX_JSON_HIT_CHARS = 8 * 1024 * 1024;
/** Hits indexed per result at most, and how deep a JSON result is walked for them. */
const MAX_HITS = 1_000;
const MAX_HIT_DEPTH = 6;
/** A WebFetch / Fetch response header block longer than this is not a header. */
const MAX_HEADER_CHARS = 64 * 1024;
/** Retrieve's schema cap on `k`: no Retrieve result carries more hits. */
const MAX_RETRIEVE_HITS = 50;
/**
 * A result whose text is this much the call's own input is an echo of it
 * (see `echoesInput`) — the grounded coverage default, so "an echo" and "a
 * body that says the claim" are measured on one scale.
 */
const ECHO_COVERAGE = 0.8;
/**
 * Where the runtime spills a result over its threshold, relative to the
 * workspace (`@crewhaus/tool-result-store`'s `DEFAULT_ROOT_DIR`: the
 * runtime resolves it against its cwd, the workspace root here).
 */
const DEFAULT_TOOL_RESULTS_DIR = ".crewhaus/tool-results";
/** The largest spilled output read back as a body (tool-web caps a page at 5 MB). */
const MAX_SPILL_BYTES = 8 * 1024 * 1024;

export class ProvabilityError extends CrewhausError {
  override readonly name = "ProvabilityError";
}

/** One tool call, before its origins are read off it. */
export type ToolCall = {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly input: unknown;
  /** The result as logged. */
  readonly content: string;
  /**
   * The whole output, when `content` is tool-result-store's preview of it
   * (`spilledOutput`): what the tool returned, which the evidence is read
   * from. Absent when the log holds the result whole.
   */
  readonly body?: string;
  readonly isError: boolean;
  readonly sessionId?: string;
  readonly turnNumber?: number;
};

/**
 * The input schema a tool declared, by the name the log records it under
 * (`RegisteredTool.jsonSchema`: for an MCP tool, what its server
 * advertised), or `undefined` when the caller cannot say. Read for an MCP
 * tool's origins (`inputOrigins`): only a field the schema declares names
 * one.
 */
export type InputSchemaLookup = (toolName: string) => unknown;

/** Where path-shaped inputs are measured from (default `process.cwd()`, the
 *  directory the tools themselves resolve relative paths against). */
export type EvidenceOptions = Pick<PathRoots, "workspaceRoot"> & {
  /** Stamped onto records built from messages (they carry no session of their own). */
  readonly sessionId?: string;
  /**
   * The input schema each tool declared (`InputSchemaLookup`) — the gate
   * passes its catalog's. Default: the schema `defaultCatalog` holds for the
   * tool, where a compiled harness registers its MCP tools. (0.8.0
   * additive, convergence pass.)
   */
  readonly inputSchemaOf?: InputSchemaLookup;
  /**
   * Where the runtime spilled results over its threshold (its
   * `toolResultRoot`; default `.crewhaus/tool-results` under the workspace
   * root, tool-result-store's own default). A spilled output is read back
   * only from under it (`spilledOutput`).
   */
  readonly toolResultsRoot?: string;
};

/** `sha256:<hex>` of a string's UTF-8 bytes. */
export function sha256Of(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The origin a value names, or `undefined`: an `http(s)` URL (taken whole —
 * it is what the tool was given, not prose to be read), a DOI, or — where
 * `paths` is allowed — a workspace path. Whether a non-URL value is a DOI or
 * a path is claim-ledger's `classifyDefinition`'s call, the one reader of
 * "what does this reference name", so a citation and a tool input agree.
 */
function originOfValue(value: string, roots: PathRoots, paths: boolean): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^https?:\/\//i.test(trimmed)) return normalizeUrl(trimmed);
  if (/^file:\/\//i.test(trimmed)) return paths ? normalizePath(trimmed, roots) : undefined;
  const ref = classifyDefinition(trimmed);
  if (ref.kind === "doi") return doiUrl(ref.doi);
  if (paths && ref.kind === "path") return normalizePath(ref.path, roots);
  return undefined;
}

/**
 * The header a WebFetch result opens with, read line by line rather than by
 * a pattern that could backtrack over a large body. Returns the URL it
 * names, the HTTP status, and where the page itself starts, or `undefined`
 * when the result does not open so.
 *
 * tool-web prints `URL: <final>\nRequested: <asked>\nStatus: <n>\nContent-Type:
 * <ct>\n\n`, the `Requested:` line only when a redirect moved the fetch, and
 * no `Requested:` line at all when the final URL is the one asked for. Design
 * §5.2 indexes both: the URL on the first line here, beside the requested one
 * the call's own `url` names, so a citation of either grounds. A header
 * without the `Requested:` line (an older tool-web, or no redirect) reads the
 * same way.
 */
function webFetchHeader(
  content: string,
): { readonly url: string; readonly status: number; readonly end: number } | undefined {
  if (!content.startsWith("URL: ")) return undefined;
  const lines: string[] = [];
  let at = 0;
  while (at < content.length && at < MAX_HEADER_CHARS) {
    const nl = content.indexOf("\n", at);
    if (nl === -1) return undefined;
    const line = content.slice(at, nl).replace(/\r$/, "");
    at = nl + 1;
    if (line === "") break;
    lines.push(line);
    if (lines.length > 4) return undefined;
  }
  const url = /^URL: (\S+)$/.exec(lines[0] ?? "")?.[1];
  if (url === undefined) return undefined;
  const rest = /^Requested: \S+$/.test(lines[1] ?? "") ? lines.slice(2) : lines.slice(1);
  const status = /^Status: (\d{3})$/.exec(rest[0] ?? "")?.[1];
  if (status === undefined || rest.length > 2) return undefined;
  if (rest.length === 2 && !/^Content-Type:/i.test(rest[1] ?? "")) return undefined;
  return { url, status: Number(status), end: at };
}

/**
 * A Fetch result's response head (`tool-fetch` `formatResponse`: `HTTP
 * <status> <reason>\n<name>: <value>…\n\n<body>`): the status, and where
 * the body starts — or `undefined`. Strict on purpose — a status line with
 * a short reason phrase and at least one header line — so a file that
 * happens to open with "HTTP 200 is…" keeps its first paragraph.
 */
function httpHead(content: string): { readonly status: number; readonly end: number } | undefined {
  if (!content.startsWith("HTTP")) return undefined;
  const blank = content.slice(0, MAX_HEADER_CHARS).indexOf("\n\n");
  if (blank === -1) return undefined;
  const [line = "", ...headers] = content.slice(0, blank).split("\n");
  const status = /^HTTP(?:\/[\d.]+)? (\d{3})(?: [A-Za-z][A-Za-z '-]{0,40})?$/.exec(line)?.[1];
  if (status === undefined || headers.length === 0) return undefined;
  return headers.every((h) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+: ?\S?/.test(h))
    ? { status: Number(status), end: blank + 2 }
    : undefined;
}

/**
 * The HTTP status a fetcher's own header reports for its result (WebFetch's
 * `Status:` line, Fetch's status line), or `undefined` for any other tool or
 * a result with no such header. Read only off the tool that prints it.
 */
function responseStatus(toolName: string, content: string): number | undefined {
  if (toolName === WEB_FETCH) return webFetchHeader(content)?.status;
  if (toolName === FETCH) return httpHead(content)?.status;
  return undefined;
}

/**
 * Is `status` a page's own answer — 2xx? A 404 or a 503 body is the
 * server's error page, not the page a citation names (design §2's
 * `grounded` row: the cited source's BODY was fetched): one that prints
 * the path it was asked for would otherwise ground any claim the model
 * spelled into that path. A 3xx a fetcher hands back (it follows
 * redirects) carries no page either.
 */
export function servesPage(status: number | undefined): boolean {
  return status === undefined || (status >= 200 && status < 300);
}

/**
 * The text a record is grounded against: the result — the whole output
 * where the log holds tool-result-store's preview of it (`body`) — with its
 * transport header taken off: WebFetch's `URL:`/`Status:` block and the `[user prompt:
 * …]` line it prepends when the call carried a `prompt` (that is the model's
 * OWN text: left in, a model could write the claim into `prompt` and find it
 * "in the source"), and Fetch's status line and response headers. Read only
 * off the tool that prints each; anything else is the result, verbatim.
 */
export function groundingBody(
  record: Pick<EvidenceRecord, "content" | "input" | "toolName" | "body">,
): string {
  const content = record.body ?? record.content;
  if (record.toolName === FETCH) {
    const head = httpHead(content);
    return head !== undefined ? content.slice(head.end) : content;
  }
  const header = record.toolName === WEB_FETCH ? webFetchHeader(content) : undefined;
  if (header !== undefined) {
    let body = content.slice(header.end);
    const prompt = isRecordObject(record.input) ? record.input["prompt"] : undefined;
    if (typeof prompt === "string" && prompt !== "") {
      const echo = `[user prompt: ${prompt}]\n\n`;
      if (body.startsWith(echo)) body = body.slice(echo.length);
    }
    return body;
  }
  return content;
}

/**
 * The builtins whose result IS the content of the origin their input names
 * (design §5.2's list: `WebFetch.url`, `Fetch.url`, `Read`'s path), and the
 * one field that names it. Every other builtin's `url`/`path` argument names
 * what the tool acted ON, not a body it returned: SeoLint's `url` is context
 * for its canonical-link check while its result echoes the markup the model
 * passed in, UrlParse's result is the model's own URL taken apart, a
 * GitBlame is an annotation of the file. Indexing those under the origin
 * would let model-written text pose as a page the run never read.
 */
const READERS: Readonly<Record<string, { readonly field: string; readonly kind: "url" | "path" }>> =
  {
    [WEB_FETCH]: { field: "url", kind: "url" },
    [FETCH]: { field: "url", kind: "url" },
    [READ]: { field: "path", kind: "path" },
  };

/**
 * Fetch reads its URL only when it sends nothing: a POST's response is the
 * server's answer to a body the model wrote (an echo endpoint returns it
 * verbatim), not the page at that URL. tool-fetch drops a body on GET and
 * HEAD, so those are reads whatever else the input carries.
 */
function fetchReads(input: Record<string, unknown>): boolean {
  const method = input["method"];
  return method === undefined || (typeof method === "string" && /^(?:GET|HEAD)$/i.test(method));
}

/** Origins a builtin reader's input names: its one declared field, and nothing else. */
function readerOrigins(
  reader: (typeof READERS)[string],
  toolName: string,
  input: Record<string, unknown>,
  roots: PathRoots,
): string[] {
  if (toolName === FETCH && !fetchReads(input)) return [];
  const value = input[reader.field];
  if (typeof value !== "string") return [];
  const origin =
    reader.kind === "url"
      ? /^https?:\/\//i.test(value.trim())
        ? normalizeUrl(value)
        : undefined
      : normalizePath(value, roots);
  return origin !== undefined ? [origin] : [];
}

/**
 * Origins a call's input names (design §5.2: the bodies the run READ), and
 * whether it was pointed at an address at all (`pointed`: such a call's
 * result is that address's body, never hits — `resultHits`). A builtin
 * names one only when it is a reader (`READERS`). An MCP server's tool
 * (`isMcpTool`) — a fetcher or a file server whose flags the gate cannot
 * see — by its URL fields, then its path fields, as far as its declared
 * schema lets them (`mcpOrigins`); whether its result is then an echo of
 * that input rather than a body is `echoesInput`'s question. Any other tool
 * names none: the runtime's own non-builtins return MODEL output — `Task` a
 * sub-agent's final message, `Consult` and `Escalate` a sibling model's
 * reply, `Skill` a skill body, the memory, plan and goal tools what a model
 * stored (design §8: child returns are inputs) — and their schemas strip a
 * key they do not declare without refusing it, so a `url` the model adds to
 * a `Recall` reaches the log whole. Read as an origin, it put a remembered
 * sentence, or a child's wrong summary, under a page nobody fetched. A
 * plugin's tool falls here too: fail closed, it grounds nothing by what its
 * input names.
 */
function inputOrigins(
  toolName: string,
  input: unknown,
  roots: PathRoots,
  schemaOf: InputSchemaLookup,
): { readonly origins: string[]; readonly pointed: boolean } {
  if (!isRecordObject(input)) return { origins: [], pointed: false };
  const reader = READERS[toolName];
  if (reader !== undefined) {
    const origins = readerOrigins(reader, toolName, input, roots);
    return { origins, pointed: origins.length > 0 };
  }
  if (builtinKey(toolName) !== undefined || !isMcpTool(toolName)) {
    return { origins: [], pointed: false };
  }
  const named = namedOrigins(input, roots);
  return {
    origins: mcpOrigins(toolName, input, named, schemaOf).map((one) => one.origin),
    pointed: named.length > 0,
  };
}

/** One origin an input field names: the field, the value as written, and the origin. */
type NamedOrigin = { readonly field: string; readonly value: string; readonly origin: string };

/** A non-builtin's URL fields, then its path fields: each value that names an origin, with it. */
function namedOrigins(input: Record<string, unknown>, roots: PathRoots): NamedOrigin[] {
  const out: NamedOrigin[] = [];
  for (const field of URL_FIELDS) {
    const value = input[field];
    if (typeof value !== "string") continue;
    const origin = originOfValue(value, roots, false);
    if (origin !== undefined) out.push({ field, value, origin });
  }
  for (const field of PATH_FIELDS) {
    const value = input[field];
    if (typeof value !== "string") continue;
    const origin = /^https?:\/\//i.test(value.trim())
      ? normalizeUrl(value)
      : normalizePath(value, roots);
    if (origin !== undefined) out.push({ field, value, origin });
  }
  return out;
}

/**
 * The properties a tool's declared input schema lists at its top level, or
 * `undefined` when no schema is known. A schema that lists none there (a
 * `$ref`, an `anyOf`, a bare `{ type: "object" }`) declares no field this
 * can read an address from: the empty set, so nothing its input carries
 * names an origin (fail closed).
 */
export function declaredFields(schema: unknown): ReadonlySet<string> | undefined {
  if (schema === undefined || schema === null) return undefined;
  if (!isRecordObject(schema)) return new Set();
  const properties = schema["properties"];
  return isRecordObject(properties) ? new Set(Object.keys(properties)) : new Set();
}

/** The schema the process's `defaultCatalog` holds for a tool (a compiled harness registers its MCP tools there). */
function catalogSchema(toolName: string): unknown {
  return defaultCatalog.get(toolName)?.jsonSchema;
}

/**
 * The origins an MCP tool's input names that it can have been POINTED at
 * (design §0 A, §5.2: a body is evidence because the run fetched it).
 * tool-mcp registers every MCP tool with a permissive local validator, so a
 * key the server does not declare reaches the log and the server whole, and
 * the server ignores it: `mcp__filesystem__read_file {path: "notes.md", url:
 * "https://acme.example/policy"}` reads `notes.md` and succeeds. Read as an
 * origin, that `url` put a file the model wrote — or the run's own session
 * log — under a page nobody fetched, served `grounded ✓`. So:
 *
 * - where the tool's declared schema is known (`InputSchemaLookup`), a field
 *   names an origin only when the schema declares it — a fetcher's `url`, a
 *   file server's `path` — and a key it does not declare names none;
 * - where it is not known (a log read offline, a tool no catalog holds), the
 *   input names an origin only when it carries nothing else a call could
 *   have been pointed at: every address field names that one origin, and no
 *   other field carries a string at all. A `path` beside a `url` that names
 *   something else, a `paths` list beside a `url`
 *   (`read_multiple_files {paths: ["notes.md"], url}`), or a `command`
 *   beside one (`run_command {command: "cat notes.md", url}`) is a call that
 *   read one of them, and nothing says which, so it names neither: fail
 *   closed.
 *
 * A lookup that throws reads as an unknown schema.
 */
function mcpOrigins(
  toolName: string,
  input: Record<string, unknown>,
  named: readonly NamedOrigin[],
  schemaOf: InputSchemaLookup,
): readonly NamedOrigin[] {
  if (named.length === 0) return named;
  let schema: unknown;
  try {
    schema = schemaOf(toolName);
  } catch {
    schema = undefined;
  }
  const declared = declaredFields(schema);
  if (declared !== undefined) return named.filter((one) => declared.has(one.field));
  if (carriesOtherStrings(input, new Set(named.map((one) => one.field)))) return [];
  return new Set(named.map((one) => one.origin)).size === 1 ? named : [];
}

/** How deep {@link carriesOtherStrings} looks into an input. */
const MAX_INPUT_DEPTH = 6;

/**
 * A fetcher's rendering options: how to return the page it was pointed at,
 * never another place (`mcp__firecrawl__scrape {url, formats: ["markdown"]}`,
 * `{url, method: "GET"}`).
 */
const RENDER_OPTIONS: ReadonlySet<string> = new Set([
  "format",
  "formats",
  "method",
  "mode",
  "outputFormat",
  "output_format",
  "encoding",
  "lang",
  "language",
  "locale",
  "country",
  "waitFor",
  "wait_for",
]);

/**
 * Does `input` carry a non-blank string anywhere but in the address fields
 * `named` read and a fetcher's rendering options ({@link RENDER_OPTIONS}) —
 * a list entry, a nested field, a command line, an id? Each is something
 * an undeclared tool may have been pointed at.
 */
function carriesOtherStrings(input: unknown, named: ReadonlySet<string>, depth = 0): boolean {
  if (depth > MAX_INPUT_DEPTH) return true;
  if (typeof input === "string") return input.trim() !== "";
  if (Array.isArray(input))
    return input.some((item) => carriesOtherStrings(item, named, depth + 1));
  if (!isRecordObject(input)) return false;
  return Object.entries(input).some(
    ([field, value]) =>
      !(depth === 0 && (named.has(field) || RENDER_OPTIONS.has(field))) &&
      carriesOtherStrings(value, named, depth + 1),
  );
}

/**
 * Every place a call's input points at, whatever its schema declares — a
 * builtin reader's one field, an MCP tool's URL and path fields and the
 * entries of its `paths` / `files` lists — for the state-root test
 * (verify.ts `provenanceOf`): a call whose input names the session log read
 * it, whichever origin the body was then indexed under
 * (`read_multiple_files {paths: [".crewhaus/sessions/…"], url}`).
 */
export function inputPlaces(toolName: string, input: unknown, roots: PathRoots = {}): string[] {
  if (!isRecordObject(input)) return [];
  const reader = READERS[toolName];
  if (reader !== undefined) return readerOrigins(reader, toolName, input, roots);
  if (builtinKey(toolName) !== undefined || !isMcpTool(toolName)) return [];
  const places = namedOrigins(input, roots).map((one) => one.origin);
  for (const field of LIST_FIELDS) {
    const list = input[field];
    if (!Array.isArray(list)) continue;
    for (const item of list.slice(0, MAX_LISTED_PLACES)) {
      if (typeof item !== "string" || item.trim() === "") continue;
      const place = /^https?:\/\//i.test(item.trim())
        ? normalizeUrl(item)
        : normalizePath(item, roots);
      if (place !== undefined) places.push(place);
    }
  }
  return [...new Set(places)];
}

/** How many entries of one list field {@link inputPlaces} reads. */
const MAX_LISTED_PLACES = 256;

/** Is `toolName` one of the builtin readers (`WebFetch`, `Fetch`, `Read`: `READERS`)? */
export function isReader(toolName: string): boolean {
  return READERS[toolName] !== undefined;
}

/**
 * Input fields a call that writes names the place it writes by: `Write`'s
 * and `Edit`'s `path`, `CopyPath`'s `destination`, a PUT's `url`, an
 * export's `out`, an archive's `output`, a split's `outputDir`.
 */
const TARGET_FIELDS = [
  ...URL_FIELDS,
  ...PATH_FIELDS,
  "destination",
  "dest",
  "target",
  "to",
  "output",
  "outputPath",
  "output_path",
  "out",
  "outFile",
  "outputFile",
  "output_file",
  "outDir",
  "outputDir",
  "output_dir",
  "golden",
  "manifest",
  "specFile",
] as const;
/** Input fields a call names the place it copies, moves or unpacks FROM by. */
const SOURCE_FIELDS = ["source", "from", "src", "archive"] as const;
/**
 * List fields that name several places: what a call that also names a
 * target reads into it (`ConcatFiles`' `paths`), else what it writes. Not
 * `sources`: FactCrossCheck's `claims[].sources` are what it read.
 */
const LIST_FIELDS = ["paths", "files"] as const;
/** Fields that carry a unified diff: the files it names are written, its `+` lines are the new text. */
const PATCH_FIELDS = ["patch", "diff"] as const;
/** Fields that carry the text a call puts where it writes (`Write`'s `content`, `Edit`'s `newString`, a PUT's `body`). */
const CONTENT_FIELDS: ReadonlySet<string> = new Set([
  "content",
  "contents",
  "text",
  "body",
  "data",
  "value",
  "newString",
  "new_string",
  "newText",
  "new_text",
  "new_str",
  "replacement",
  "replace",
  "append",
  "insert",
  "lines",
]);
/** Fields that carry the text an edit REPLACES (`Edit`'s `oldString`, an MCP file server's `oldText`). */
const OLD_TEXT_FIELDS: ReadonlySet<string> = new Set([
  "oldString",
  "old_string",
  "oldText",
  "old_text",
  "old_str",
  "search",
  "find",
]);
/** Places read off one list field at most. */
const MAX_LIST_PLACES = 64;
/** Files read off one diff at most. */
const MAX_PATCH_FILES = 64;

/** One place a call names: where it writes, or (`source`) where it copies, moves or unpacks from. */
export type WrittenPlace = { readonly place: string; readonly source: boolean };

/**
 * The files a unified diff names as written (`+++ b/<path>`), with `strip`
 * leading components dropped (git's `-p`, default 1).
 */
function patchFiles(patch: string, strip: number): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\+\+\+ ([^\t\n\r]+)/gm)) {
    const named = (m[1] as string).trim();
    if (named === "/dev/null" || named === "") continue;
    const parts = named.split("/");
    const file = parts.slice(Math.min(strip, parts.length - 1)).join("/");
    if (!out.includes(file)) out.push(file);
    if (out.length >= MAX_PATCH_FILES) break;
  }
  return out;
}

/**
 * The places a call may have WRITTEN, and the ones it copied, moved or
 * unpacked them from, as its input names them, normalized like a
 * citation's (verify.ts `provenanceOf` reads them: a source the run wrote
 * itself and then read back, or a copy of the harness's own state). Any
 * tool's input, builtin or not: the place it writes by
 * {@link TARGET_FIELDS}; the place it copies from by {@link SOURCE_FIELDS};
 * a list ({@link LIST_FIELDS}) as sources beside a target (`ConcatFiles`)
 * and as written places otherwise; and each file a diff
 * ({@link PATCH_FIELDS}) names, under the call's `cwd` (`GitApplyPatch`).
 * None for a call that only reads — a builtin reader (`WebFetch`, `Read`, a
 * GET or HEAD `Fetch`) and `ProvabilityPreflight`, which writes nowhere.
 * Whether the tool can write at all (a pure tool cannot) is the caller's
 * question.
 */
export function writtenPlaces(
  toolName: string,
  input: unknown,
  roots: PathRoots = {},
): WrittenPlace[] {
  if (!isRecordObject(input) || toolName === PROVABILITY_PREFLIGHT) return [];
  if (toolName === FETCH ? fetchReads(input) : isReader(toolName)) return [];
  const out: WrittenPlace[] = [];
  const add = (value: string, source: boolean): void => {
    const trimmed = value.trim();
    if (trimmed === "") return;
    const place = /^https?:\/\//i.test(trimmed)
      ? normalizeUrl(trimmed)
      : normalizePath(trimmed, roots);
    if (place === undefined) return;
    if (!out.some((one) => one.place === place && one.source === source)) {
      out.push({ place, source });
    }
  };
  let target = false;
  for (const field of TARGET_FIELDS) {
    const value = input[field];
    if (typeof value !== "string") continue;
    add(value, false);
    target = true;
  }
  for (const field of SOURCE_FIELDS) {
    const value = input[field];
    if (typeof value === "string") add(value, true);
  }
  for (const field of LIST_FIELDS) {
    const list = input[field];
    if (!Array.isArray(list)) continue;
    for (const item of list.slice(0, MAX_LIST_PLACES)) {
      if (typeof item === "string") add(item, target);
    }
  }
  const cwd = typeof input["cwd"] === "string" ? input["cwd"] : ".";
  const strip = input["strip"];
  for (const field of PATCH_FIELDS) {
    const patch = input[field];
    if (typeof patch !== "string") continue;
    const drop = typeof strip === "number" && Number.isInteger(strip) && strip >= 0 ? strip : 1;
    for (const file of patchFiles(patch, drop)) add(path.posix.join(cwd, file), false);
  }
  return out;
}

/** What a call put where it wrote: the text it added, and the text it replaced. */
export type WrittenText = {
  readonly added: readonly string[];
  readonly removed: readonly string[];
};

/**
 * The text a call put where it wrote ({@link writtenPlaces}), read off its
 * input by field (verify.ts `selfWriter`): what a content field
 * ({@link CONTENT_FIELDS}) carries, at any depth (`MultiEdit`'s `edits`, an
 * MCP file server's `edits[].newText`), and a diff's `+` lines, as added;
 * what an edit replaces ({@link OLD_TEXT_FIELDS}) and a diff's `-` lines, as
 * removed — so an `Edit` of `14` to `30` added `30`, not `14`. A search's
 * `pattern`, a commit `message`, an address: none of those is text put
 * anywhere.
 */
export function writtenText(input: unknown): WrittenText {
  const added: string[] = [];
  const removed: string[] = [];
  const diff = (patch: string): void => {
    const plus: string[] = [];
    const minus: string[] = [];
    for (const line of patch.split(/\r?\n/)) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) plus.push(line.slice(1));
      else if (line.startsWith("-")) minus.push(line.slice(1));
    }
    if (plus.length > 0) added.push(plus.join("\n"));
    if (minus.length > 0) removed.push(minus.join("\n"));
  };
  const walk = (value: unknown, key: string | undefined, depth: number): void => {
    if (depth > MAX_HIT_DEPTH + 2) return;
    if (typeof value === "string") {
      if (key === undefined || value.trim() === "") return;
      if (OLD_TEXT_FIELDS.has(key)) removed.push(value);
      else if ((PATCH_FIELDS as readonly string[]).includes(key)) diff(value);
      else if (CONTENT_FIELDS.has(key)) added.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, depth + 1);
      return;
    }
    if (isRecordObject(value)) {
      for (const [field, item] of Object.entries(value)) walk(item, field, depth + 1);
    }
  };
  walk(input, undefined, 0);
  return { added, removed };
}

/**
 * The input strings a call names its origins by, as written: the URL or
 * path it was pointed at, not text it was handed — a builtin reader's one
 * declared field, a non-builtin's URL and path fields whose origin the
 * record carries (what `inputOrigins` read off an MCP tool, and the address
 * a record built outside the log was fetched under — the research
 * crawler's carry their own origins). A key the tool does not declare names
 * no origin (`mcpOrigins`), so its value is text the call was handed like
 * any other. `grounded`'s echo test (verify.ts `echoCheck`) reads these
 * apart from the call's other strings, because a URL's slug can spell a
 * claim the page itself states — a reader returns the page, not its
 * address — and only a body that PRINTS the address (a 404 page repeating
 * the path it was asked for, a page headed with its own URL) can be
 * reflecting it.
 */
export function originFieldValues(
  record: Pick<EvidenceRecord, "toolName" | "input" | "origins">,
  roots: PathRoots = {},
): string[] {
  const { toolName, input } = record;
  if (!isRecordObject(input)) return [];
  const reader = READERS[toolName];
  if (reader !== undefined) {
    const value = input[reader.field];
    return typeof value === "string" && readerOrigins(reader, toolName, input, roots).length > 0
      ? [value]
      : [];
  }
  if (builtinKey(toolName) !== undefined) return [];
  return namedOrigins(input, roots)
    .filter((one) => record.origins.includes(one.origin))
    .map((one) => one.value);
}

/** A JSON hit's text: its text-bearing fields, or every string field when it has none. */
function hitText(hit: Record<string, unknown>, originField: string): string {
  const texts = HIT_TEXT_FIELDS.map((field) => hit[field]).filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  if (texts.length > 0) return texts.join("\n");
  return Object.entries(hit)
    .filter(([key, value]) => key !== originField && typeof value === "string")
    .map(([, value]) => value as string)
    .join("\n");
}

function collectJsonHits(
  value: unknown,
  roots: PathRoots,
  out: Array<{ origin: string; content: string }>,
  depth: number,
): void {
  if (out.length >= MAX_HITS || depth > MAX_HIT_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonHits(item, roots, out, depth + 1);
    return;
  }
  if (!isRecordObject(value)) return;
  for (const field of HIT_ORIGIN_FIELDS) {
    const named = value[field];
    if (typeof named !== "string") continue;
    const origin = originOfValue(named, roots, field === "source");
    if (origin === undefined) continue;
    const content = hitText(value, field);
    if (content.trim() !== "") out.push({ origin, content });
    return;
  }
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) collectJsonHits(child, roots, out, depth + 1);
  }
}

/** Retrieve's hit header (`tool-retrieve` `formatHits`): `[1] id=… doc=<source> score=0.9123`. */
const RETRIEVE_HIT = /^\[(\d+)\] id=\S+ doc=(\S+) score=[\d.eE+-]+$/gm;

/**
 * Retrieve's hits, each under its own document. A chunk preview is corpus
 * text — a crawled third-party page among it — and is printed raw, so a
 * line in it shaped like a hit header would otherwise start a "hit" under
 * any origin it names. So the structure `formatHits` prints is required,
 * and anything else reads as no hits at all (fail closed: a claim cited to
 * a Retrieve hit is then `not_fetched`, never grounded in the wrong text):
 *
 * - a header counts only at the start of the result or after a blank line,
 *   the separator `formatHits` puts between hits;
 * - the headers are numbered 1, 2, 3, … with no repeat and no gap;
 * - there are no more of them than the call asked for (`k`), or than
 *   Retrieve ever returns.
 *
 * A forged header with a blank line before it inside the LAST hit's
 * preview still reads as one more hit; closing that needs tool-retrieve to
 * print a delimiter a preview cannot contain (reported, not done here).
 */
function retrieveHits(
  content: string,
  input: unknown,
  roots: PathRoots,
): Array<{ origin: string; content: string }> {
  const heads = [...content.matchAll(RETRIEVE_HIT)].filter(
    (head) =>
      head.index !== undefined && (head.index === 0 || content.endsWith("\n\n", head.index)),
  );
  if (heads.length === 0 || heads[0]?.index !== 0) return [];
  const k = isRecordObject(input) ? input["k"] : undefined;
  const most =
    typeof k === "number" && Number.isInteger(k) && k > 0
      ? Math.min(k, MAX_RETRIEVE_HITS)
      : MAX_RETRIEVE_HITS;
  if (heads.length > most) return [];
  if (heads.some((head, i) => head[1] !== String(i + 1))) return [];
  const out: Array<{ origin: string; content: string }> = [];
  heads.forEach((head, i) => {
    if (head.index === undefined) return;
    const next = heads[i + 1]?.index ?? content.length;
    const text = content.slice(head.index + head[0].length, next).trim();
    const origin = originOfValue(head[2] as string, roots, true);
    if (origin !== undefined && text !== "") out.push({ origin, content: text });
  });
  return out;
}

/** Every string a call's input carries, at any depth (the grounded echo test reads them too). */
export function inputStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > MAX_HIT_DEPTH + 2) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) inputStrings(item, out, depth + 1);
  else if (isRecordObject(value)) {
    for (const item of Object.values(value)) inputStrings(item, out, depth + 1);
  }
  return out;
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Is `text` the call's own input handed back? A tool the gate cannot see
 * into (an MCP server's, a plugin's) may reflect what the model sent it — a
 * SQL tool returns the literal a SELECT names, an "annotate" tool repeats
 * its note — and its result would then put the model's own words under any
 * origin it names. Such text is not a body anyone else wrote, so it is not
 * indexed: it is a substring of one of the input's strings, or its content
 * words are covered by the input's at the grounded bar.
 *
 * A search hit is far longer than its query and keeps its origin. A
 * reflection padded with text from somewhere else (a SELECT that appends a
 * real row to its literal) is not wholly an echo and is indexed; `grounded`
 * then refuses a claim whose words, at their tightest, are the input's own
 * (verify.ts `echoedSpan`).
 */
function echoesInput(text: string, input: unknown): boolean {
  const strings = inputStrings(input);
  if (strings.length === 0) return false;
  const body = collapse(text);
  if (body === "") return false;
  if (strings.some((value) => collapse(value).includes(body))) return true;
  return coverage(contentTokens(text), contentTokens(strings.join("\n"))) >= ECHO_COVERAGE;
}

/**
 * Hits a result carries — and only where the hits cannot be the model's own
 * writing dressed as someone else's page. A hit names its own origin, so a
 * result the model can author (a `Read` of a file it wrote, `Bash` echoing
 * JSON, a fetch of an echo endpoint) could otherwise put any text under any
 * URL and ground a citation of a page the run never read. So:
 *
 * - Retrieve's `[n] id=… doc=… score=…` blocks are read only from Retrieve,
 *   whose corpus the operator ingested, and only in the exact structure it
 *   prints (`retrieveHits`).
 * - JSON hits (`url`/`uri`/`href`/`link`/`source` fields) are read only from
 *   an MCP server's tool (`mcp__…`, `isMcpTool`) whose input names no URL or
 *   path: a search returns hits, a fetch of one URL returns that URL's
 *   body, whatever the body looks like. Never from the runtime's own tools
 *   whose result is MODEL output — `Task` (a sub-agent's final message),
 *   `Consult`/`Escalate`, an A2A peer, `Skill`, the memory, plan and goal
 *   tools: a sub-agent that answers `[{"url": …, "text": …}]` would
 *   otherwise ground a citation of a page nobody fetched, and a child that
 *   did fetch it would have its summary indexed beside the page, where a
 *   wrong summary grounds what the page contradicts (design §8: child
 *   returns are inputs; the child's evidence is its own logged fetches,
 *   which the child-log walk indexes). A hit whose text is the call's own
 *   input handed back is dropped (`echoesInput`).
 */
function resultHits(
  call: Pick<ToolCall, "toolName" | "content" | "input">,
  fetchedSomething: boolean,
  roots: PathRoots,
): Array<{ origin: string; content: string }> {
  const { content } = call;
  if (call.toolName === RETRIEVE) return retrieveHits(content, call.input, roots);
  if (fetchedSomething || !isMcpTool(call.toolName)) return [];
  const trimmed = content.trim();
  if (trimmed.length > MAX_JSON_HIT_CHARS || !/^[[{]/.test(trimmed)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const out: Array<{ origin: string; content: string }> = [];
  collectJsonHits(parsed, roots, out, 0);
  return out.filter((hit) => !echoesInput(hit.content, call.input));
}

/**
 * The URL a record's body was served from, where the fetcher says so: the
 * final URL a WebFetch header names on its first line, after any redirect
 * (design §5.2), normalized. `undefined` for any other record — its body is
 * what its origins name. A citation of the requested URL grounds in a body
 * this URL served, so the host checks that hold a redirect hop (`sources.deny`,
 * the private-address rule) and `grounded.independent` read the body by
 * this (verify.ts `grounded`).
 */
export function servedFrom(
  record: Pick<EvidenceRecord, "toolName" | "content" | "body">,
): string | undefined {
  if (record.toolName !== WEB_FETCH) return undefined;
  const header = webFetchHeader(record.body ?? record.content);
  return header !== undefined ? normalizeUrl(header.url) : undefined;
}

/**
 * One call as an evidence record: its origins read off the input — a
 * builtin reader's one field (WebFetch's and Fetch's `url`, Read's `path`),
 * or an MCP tool's `url`, `uri`, `href`, `file_path`, `path`, `file`,
 * `filePath` as far as its declared schema lets them (`mcpOrigins`), unless
 * its result is an echo of its input (`inputOrigins`, `echoesInput`) — and
 * the URL a WebFetch result's header names on its
 * first line (indexed BESIDE the requested URL, so that once tool-web
 * prints the final URL there a citation of either grounds — see
 * `webFetchHeader`), and the hits a multi-source result carries (Retrieve;
 * JSON results with `url`/`uri`/`href`/`link`/`source` from an MCP tool —
 * see `resultHits` for which tools). A fetcher's HTTP status is carried
 * (`status`): a non-2xx body is not the page (`servesPage`). Error results
 * are recorded too: the verifiers reject them, by reason.
 *
 * Everything is read off the whole output (`body`) where the log holds a
 * spill preview of it; `content` stays what the log holds, which a replay
 * is compared against.
 */
export function recordFromCall(call: ToolCall, opts: EvidenceOptions = {}): EvidenceRecord {
  const roots: PathRoots = {
    ...(opts.workspaceRoot !== undefined ? { workspaceRoot: opts.workspaceRoot } : {}),
  };
  const text = call.body ?? call.content;
  const { origins: named, pointed } = inputOrigins(
    call.toolName,
    call.input,
    roots,
    opts.inputSchemaOf ?? catalogSchema,
  );
  // An MCP tool that names an origin returns whatever it returns; when that
  // is its own input, it read nothing.
  const origins =
    named.length > 0 && READERS[call.toolName] === undefined && echoesInput(text, call.input)
      ? []
      : [...named];
  // A call pointed at an address returns that address's body, whatever the
  // body looks like — never hits, whether or not the address was declared.
  const fetchedSomething = pointed;
  // The URL line is tool-web's own header; read off any other tool it would
  // let a file or a page that merely opens with "URL: …" claim a URL.
  const header = call.toolName === WEB_FETCH ? webFetchHeader(text) : undefined;
  if (header !== undefined) {
    const final = normalizeUrl(header.url);
    if (final !== undefined) origins.push(final);
  }
  const status = responseStatus(call.toolName, text);
  const hits = resultHits({ ...call, content: text }, fetchedSomething, roots);
  const sessionId = call.sessionId ?? opts.sessionId;
  return {
    toolUseId: call.toolUseId,
    toolName: call.toolName,
    input: call.input,
    content: call.content,
    ...(call.body !== undefined ? { body: call.body } : {}),
    isError: call.isError,
    ...(sessionId !== undefined ? { sessionId } : {}),
    origins: [...new Set(origins)],
    ...(status !== undefined ? { status } : {}),
    ...(call.turnNumber !== undefined ? { turnNumber: call.turnNumber } : {}),
    ...(hits.length > 0 ? { hits } : {}),
  };
}

/**
 * The spill tail tool-result-store puts after a result's head when it saved
 * the output to a file (`storeAndPreview`: an optional part line, then
 * `[truncated, full output at <path>]`), read from the END of `content` line
 * by line — each pattern anchored to one short line, never run over the
 * body. Returns the head and the path, or `undefined`. A tail saying the
 * output could not be saved has no file to read.
 */
function spillTail(content: string): { readonly head: string; readonly saved: string } | undefined {
  const last = content.lastIndexOf("\n");
  if (last === -1) return undefined;
  const saved = /^\[truncated, full output at ([^\n]+)\]$/.exec(content.slice(last + 1))?.[1];
  if (saved === undefined) return undefined;
  const prior = content.lastIndexOf("\n", last - 1);
  const part = prior === -1 ? "" : content.slice(prior + 1, last);
  const partLine =
    /^\[part 1 of \d+; Read .+ for part 2\]$/.test(part) ||
    /^\[the rest could not also be saved in parts to Read one at a time: .*\]$/.test(part);
  return { head: content.slice(0, partLine ? prior : last), saved };
}

/**
 * The whole output of a call whose logged result is tool-result-store's
 * preview of it, or `undefined` (design §5.2: grounding needs the bodies
 * the run read). runtime-core logs, and shows the model, only the first 100
 * lines or 10 KB of a result over the threshold, then the path the whole
 * was saved at; the claim the model reads further down a long page (the
 * preview tells it to `Read` the parts) is in that file, not in the log.
 *
 * Read back only where it can be nothing but this call's own output:
 *
 * - the path is `<toolResultsRoot>/<runId>/<toolUseId>.txt` (or the
 *   `<toolUseId>.<n>.txt` tool-result-store moves on to when the name is
 *   taken) — THIS call's id, one run directory down, under the root the
 *   runtime spills to; a logged result is the tool's output verbatim, so a
 *   page that ends with a forged tail naming some other file reads nothing;
 * - the file is a regular file opened inside that root, no link followed
 *   (`@crewhaus/tool-safety/fs`), at most {@link MAX_SPILL_BYTES};
 * - it begins with the head the log holds.
 *
 * Anything else — a file gone, a tenant root not passed here — leaves the
 * preview as the record's text: fewer words, a claim further down unmet,
 * never more than the run read.
 */
export function spilledOutput(
  content: string,
  toolUseId: string,
  opts: Pick<EvidenceOptions, "workspaceRoot" | "toolResultsRoot"> = {},
): string | undefined {
  const tail = spillTail(content);
  if (tail === undefined || tail.head === "") return undefined;
  const workspace = path.resolve(opts.workspaceRoot ?? process.cwd());
  const root = path.resolve(workspace, opts.toolResultsRoot ?? DEFAULT_TOOL_RESULTS_DIR);
  const rel = path.relative(root, path.resolve(workspace, tail.saved));
  const parts = rel.split(path.sep);
  if (parts.length !== 2 || parts.some((part) => part === "" || part === "..")) return undefined;
  const name = parts[1] as string;
  const own = `${toolUseId}.`;
  if (!name.startsWith(own) || !/^(?:\d{1,4}\.)?txt$/.test(name.slice(own.length))) {
    return undefined;
  }
  const read = openForReadSync(root, rel, { maxBytes: MAX_SPILL_BYTES, followLeafSymlink: false });
  if (!read.ok || read.truncated) return undefined;
  const whole = read.text;
  return whole.startsWith(tail.head) && whole.length > tail.head.length ? whole : undefined;
}

/** A tool result's text: a string as is, the text blocks of an array joined. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (isRecordObject(block) && block["type"] === "text" && typeof block["text"] === "string") {
      texts.push(block["text"]);
    }
  }
  return texts.join("\n");
}

function turnOf(payload: Record<string, unknown>): number | undefined {
  const turn = payload["turnNumber"];
  return typeof turn === "number" && Number.isInteger(turn) && turn >= 0 ? turn : undefined;
}

/**
 * The structural slice of a transcript message this reads: Anthropic-shaped
 * `MessageParam`s (assistant `tool_use` blocks `{ id, name, input }`, user
 * `tool_result` blocks `{ tool_use_id, content, is_error }`). Declared here
 * so the package imports no model SDK.
 */
export type EvidenceMessage = {
  readonly role: string;
  readonly content: string | ReadonlyArray<unknown>;
};

/**
 * Records for every completed tool call in a transcript, in call order. A
 * `tool_use` with no `tool_result` yet is not a record (the call never
 * finished); a result whose call is not in the transcript is skipped. An id
 * that appears twice (a provider that reuses ids) pairs its LAST call with
 * its LAST result, as the log walk does (`evidenceFromSessionLog`). A
 * result the runtime spilled is read whole (`spilledOutput`).
 */
export function evidenceFromMessages(
  messages: ReadonlyArray<EvidenceMessage>,
  opts: EvidenceOptions = {},
): EvidenceRecord[] {
  const order: string[] = [];
  const uses = new Map<string, { name: string; input: unknown }>();
  const results = new Map<string, { content: string; isError: boolean }>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as ReadonlyArray<unknown>) {
      if (!isRecordObject(block)) continue;
      if (block["type"] === "tool_use" && typeof block["id"] === "string") {
        if (!uses.has(block["id"])) order.push(block["id"]);
        uses.set(block["id"], {
          name: typeof block["name"] === "string" ? block["name"] : "unknown",
          input: block["input"],
        });
      } else if (block["type"] === "tool_result" && typeof block["tool_use_id"] === "string") {
        results.set(block["tool_use_id"], {
          content: resultText(block["content"]),
          isError: block["is_error"] === true,
        });
      }
    }
  }
  const out: EvidenceRecord[] = [];
  for (const id of order) {
    const use = uses.get(id) as { name: string; input: unknown };
    const result = results.get(id);
    if (result === undefined) continue;
    const body = spilledOutput(result.content, id, opts);
    out.push(
      recordFromCall(
        {
          toolUseId: id,
          toolName: use.name,
          input: use.input,
          ...result,
          ...(body !== undefined ? { body } : {}),
        },
        opts,
      ),
    );
  }
  return out;
}

export type SessionLogEvidenceOptions = {
  /** The session whose log to read: `sess_<16 hex>`. */
  readonly sessionId: string;
  /** Where session `.jsonl` logs live (default `.crewhaus/sessions`). */
  readonly rootDir?: string;
  /** Walk sub-agent child sessions (`sub_agent_start` brackets). Default true. */
  readonly includeChildren?: boolean;
  /** How deep the child walk descends. Default 8. */
  readonly maxDepth?: number;
  /** Workspace root for path-shaped inputs (default `process.cwd()`). */
  readonly workspaceRoot?: string;
  /** Where the runtime spilled large results (see `EvidenceOptions.toolResultsRoot`). */
  readonly toolResultsRoot?: string;
  /** The input schema each tool declared (see `EvidenceOptions.inputSchemaOf`). */
  readonly inputSchemaOf?: InputSchemaLookup;
  /**
   * Told when a session's log could not be read to its end — a torn last
   * line from a crash mid-append, a malformed line, a link where the log
   * should be. The records read before it are kept; the gate logs this.
   */
  readonly onUnreadable?: (info: { readonly sessionId: string; readonly message: string }) => void;
};

type LogSlot =
  | { readonly kind: "call"; readonly id: string }
  | { readonly kind: "child"; readonly sessionId: string };

/**
 * Records for every completed tool call in a session's event log, child
 * sessions included, in call order: a child's calls are placed where its
 * `sub_agent_start` bracket sits in the parent, because that is when they
 * ran. The child walk follows the brackets `continuity-store`'s
 * `resolveEvidence` follows — `sub_agent_start` payloads name a
 * `childSessionId`, a session is read once, the depth is bounded — so a
 * researcher child's fetches ground the parent's answer. (It is not that
 * function: this reads every call of the tree once, in call order, where
 * `resolveEvidence` looks one id up breadth-first.)
 *
 * One id logged more than once in a session pairs its LAST `tool_use` with
 * its LAST `tool_result`, at the position it first appeared — the rule
 * continuity-store's `scanSession` applies, so `PlanComplete` and the
 * `checked` rung read one log the same way (design §6.3). An approval
 * replay logs the `tool_use` twice (the second line records the input that
 * RAN) and the result once; a provider that reuses ids (an
 * OpenAI-compatible server's `functions.<name>:<n>`) logs both twice, and
 * the last call is paired with its own result rather than with the first
 * call's. A result the runtime spilled is read whole (`spilledOutput`).
 * `turnNumber` is carried when a payload records one. A missing log
 * — the session's or a child's — yields no records, never a throw. A log
 * that cannot be read to its end (`@crewhaus/event-log` throws at a
 * malformed line — a crash mid-append leaves one — or refuses a link at
 * the log's name) keeps the records read before that point and reports it
 * through `onUnreadable`: fewer records fails closed — a claim whose
 * evidence was lost is unmet — where a throw would fail OPEN, every later
 * turn of the session served `unverified` because one child's log is torn.
 * Reading never creates the log directory.
 */
export async function evidenceFromSessionLog(
  opts: SessionLogEvidenceOptions,
): Promise<EvidenceRecord[]> {
  if (!SESSION_ID_REGEX.test(opts.sessionId)) {
    throw new ProvabilityError(
      "config",
      `provability: invalid sessionId "${opts.sessionId}" — expected sess_<16 hex>`,
    );
  }
  const rootDir = opts.rootDir ?? DEFAULT_ROOT_DIR;
  const includeChildren = opts.includeChildren ?? true;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const roots: EvidenceOptions = {
    ...(opts.workspaceRoot !== undefined ? { workspaceRoot: opts.workspaceRoot } : {}),
    ...(opts.toolResultsRoot !== undefined ? { toolResultsRoot: opts.toolResultsRoot } : {}),
    ...(opts.inputSchemaOf !== undefined ? { inputSchemaOf: opts.inputSchemaOf } : {}),
  };
  const visited = new Set<string>();
  const out: EvidenceRecord[] = [];

  const walk = async (sessionId: string, depth: number): Promise<void> => {
    if (visited.has(sessionId)) return;
    visited.add(sessionId);
    // openEventLog creates its root directory; a read must not.
    if (!existsSync(path.join(rootDir, `${sessionId}.jsonl`))) return;
    const log = await openEventLog(sessionId, { rootDir });
    const slots: LogSlot[] = [];
    const uses = new Map<string, { name: string; input: unknown; turnNumber?: number }>();
    const results = new Map<string, { content: string; isError: boolean; turnNumber?: number }>();
    try {
      for await (const event of log.read()) {
        if (!isRecordObject(event.payload)) continue;
        const p = event.payload;
        if (event.kind === "tool_use" && typeof p["id"] === "string") {
          const turnNumber = turnOf(p);
          const prior = uses.get(p["id"]);
          if (prior === undefined) slots.push({ kind: "call", id: p["id"] });
          uses.set(p["id"], {
            name: typeof p["name"] === "string" ? p["name"] : (prior?.name ?? "unknown"),
            input: p["input"],
            ...(turnNumber !== undefined
              ? { turnNumber }
              : prior?.turnNumber !== undefined
                ? { turnNumber: prior.turnNumber }
                : {}),
          });
        } else if (event.kind === "tool_result" && typeof p["toolUseId"] === "string") {
          const turnNumber = turnOf(p);
          results.set(p["toolUseId"], {
            content: resultText(p["content"]),
            isError: p["isError"] === true,
            ...(turnNumber !== undefined ? { turnNumber } : {}),
          });
        } else if (event.kind === "sub_agent_start") {
          const child = p["childSessionId"];
          if (typeof child === "string" && SESSION_ID_REGEX.test(child)) {
            slots.push({ kind: "child", sessionId: child });
          }
        }
      }
    } catch (err) {
      opts.onUnreadable?.({
        sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await log.close();
    }
    for (const slot of slots) {
      if (slot.kind === "child") {
        if (includeChildren && depth < maxDepth) await walk(slot.sessionId, depth + 1);
        continue;
      }
      const use = uses.get(slot.id);
      const result = results.get(slot.id);
      if (use === undefined || result === undefined) continue;
      const turnNumber = use.turnNumber ?? result.turnNumber;
      const body = spilledOutput(result.content, slot.id, roots);
      out.push(
        recordFromCall(
          {
            toolUseId: slot.id,
            toolName: use.name,
            input: use.input,
            content: result.content,
            ...(body !== undefined ? { body } : {}),
            isError: result.isError,
            sessionId,
            ...(turnNumber !== undefined ? { turnNumber } : {}),
          },
          roots,
        ),
      );
    }
  };

  await walk(opts.sessionId, 0);
  return out;
}

/**
 * runtime-core logs a non-string `tool_result` (image or multi-block
 * content) as a summary — `[2 text blocks, 1834 chars]` — not the text. When
 * the same call also arrives from the transcript, the transcript's text wins
 * over that placeholder.
 */
const LOGGED_BLOCK_SUMMARY =
  /^\[(?:\d+ (?:image|text|other) blocks?)(?:, \d+ (?:image|text|other) blocks?)*, \d+ chars\]$/;

function mergeRecords(first: EvidenceRecord, later: EvidenceRecord): EvidenceRecord {
  const takeLater =
    (first.content === "" && later.content !== "") ||
    (LOGGED_BLOCK_SUMMARY.test(first.content) && !LOGGED_BLOCK_SUMMARY.test(later.content));
  const body = takeLater ? later : first;
  const hits = first.hits ?? later.hits;
  const sessionId = first.sessionId ?? later.sessionId;
  const turnNumber = first.turnNumber ?? later.turnNumber;
  const whole = body.body ?? (takeLater ? first.body : later.body);
  return {
    toolUseId: first.toolUseId,
    toolName: first.toolName === "unknown" ? later.toolName : first.toolName,
    input: first.input,
    content: body.content,
    ...(whole !== undefined ? { body: whole } : {}),
    isError: body.isError,
    ...(sessionId !== undefined ? { sessionId } : {}),
    origins: [...new Set([...first.origins, ...later.origins])],
    ...(body.status !== undefined ? { status: body.status } : {}),
    ...(turnNumber !== undefined ? { turnNumber } : {}),
    ...(takeLater && later.hits !== undefined
      ? { hits: later.hits }
      : hits !== undefined
        ? { hits }
        : {}),
  };
}

/** A view of `record` as one hit's own evidence: the hit's text, under the hit's origin. */
function hitView(record: EvidenceRecord, hit: { origin: string; content: string }): EvidenceRecord {
  // The hit's text alone: never the whole output it was read from.
  const { hits: _hits, body: _body, status: _status, ...call } = record;
  return { ...call, content: hit.content, origins: [hit.origin] };
}

export type EvidenceIndexOptions = {
  /**
   * The session being graded — the parent, whose sub-agents' logs the walk
   * reads too (`evidenceFromSessionLog`). A record that names no session
   * (the in-memory transcript's: `evidenceFromMessages` without
   * `EvidenceOptions.sessionId`) is one of its calls, and a `tool:<id>` its
   * calls and a child's share resolves to its own. Default: the session of
   * the first record that names one — the log walk reads the parent first,
   * and a parent's call (the `Task` that spawned a child) is logged before
   * the child's bracket.
   */
  readonly sessionId?: string;
};

/** One call's key: its session and its id, the pair that names it (design §5.2). */
const callKey = (sessionId: string | undefined, toolUseId: string): string =>
  `${sessionId ?? ""}\u0000${toolUseId}`;

/** Did two records come from the same call: one tool, one input? */
function sameCall(a: EvidenceRecord, b: EvidenceRecord): boolean {
  if (a.toolName !== b.toolName) return false;
  try {
    return JSON.stringify(a.input) === JSON.stringify(b.input);
  } catch {
    return false;
  }
}

/**
 * The index over `records`, one record per call: a call is its session and
 * its `toolUseId` together (design §5.2: the index is keyed per call), so
 * the log's record and the transcript's of ONE call merge into one, in the
 * order each call first appears, and two sessions' calls never do. The
 * log's record wins where the two disagree, except where the log holds
 * only runtime-core's summary of block content and the transcript holds
 * the text.
 *
 * An id is unique only within a conversation: an OpenAI-compatible server
 * numbers its calls per conversation (`functions.<name>:<n>`, see
 * `evidenceFromSessionLog`), and every sub-agent child is a fresh one, so a
 * parent's first fetch and its child's share an id. Merged by id alone, the
 * two became one record — one call's body, indexed under both calls' URLs:
 * a claim the other page contradicts grounded, and the honest one failed.
 * A record that names no session is the parent's (see
 * {@link EvidenceIndexOptions.sessionId}); where the parent has no call by
 * its id, it is the twin of the one call that has its tool and its input,
 * and otherwise a call of its own.
 *
 * `byToolUseId` answers a `tool:<id>` the way continuity-store's
 * `resolveEvidence` does — the parent's call first, then a child's — and
 * an id only several children share (and the parent does not) is
 * ambiguous: `undefined`, with every candidate on `callsById`, so the
 * gate says so rather than grade one sub-agent's result for another's.
 *
 * `bySource` takes a normalized origin; a raw URL is normalized for the
 * caller. Error records are indexed like any other — the verifiers reject
 * them by reason, so "fetched, but it failed" reads differently from "never
 * fetched".
 */
export function buildEvidenceIndex(
  records: Iterable<EvidenceRecord>,
  opts: EvidenceIndexOptions = {},
): EvidenceIndex {
  const list = [...records];
  const root = opts.sessionId ?? list.find((record) => record.sessionId !== undefined)?.sessionId;
  const byKey = new Map<string, EvidenceRecord>();
  /** Each id's calls, by key, in the order they first appear. */
  const keysById = new Map<string, string[]>();
  const order: string[] = [];
  const keyFor = (record: EvidenceRecord): string => {
    if (record.sessionId !== undefined) return callKey(record.sessionId, record.toolUseId);
    const own = callKey(root, record.toolUseId);
    const keys = keysById.get(record.toolUseId) ?? [];
    if (keys.length === 0 || (keys.length === 1 && keys[0] === own)) return own;
    const twin = keys.find((key) => sameCall(byKey.get(key) as EvidenceRecord, record));
    // The parent's call by this id — unless the parent was guessed wrong:
    // another session holds this very call, and the guessed one's differs.
    if (keys.includes(own) && (twin === undefined || twin === own)) return own;
    return twin ?? own;
  };
  for (const record of list) {
    const key = keyFor(record);
    const prior = byKey.get(key);
    if (prior === undefined) {
      byKey.set(key, record);
      order.push(key);
      const keys = keysById.get(record.toolUseId);
      if (keys === undefined) keysById.set(record.toolUseId, [key]);
      else keys.push(key);
    } else {
      byKey.set(key, mergeRecords(prior, record));
    }
  }
  const all = order.map((key) => byKey.get(key) as EvidenceRecord);
  const callsOf = (toolUseId: string): EvidenceRecord[] => {
    const keys = keysById.get(toolUseId) ?? [];
    const own = callKey(root, toolUseId);
    // The parent's first, then the children's in the order they ran.
    return [...keys.filter((key) => key === own), ...keys.filter((key) => key !== own)].map(
      (key) => byKey.get(key) as EvidenceRecord,
    );
  };
  const sources = new Map<string, EvidenceRecord[]>();
  const add = (origin: string, record: EvidenceRecord): void => {
    const list = sources.get(origin);
    if (list === undefined) sources.set(origin, [record]);
    else list.push(record);
  };
  for (const record of all) {
    for (const origin of new Set(record.origins)) add(origin, record);
    for (const hit of record.hits ?? []) add(hit.origin, hitView(record, hit));
  }
  return {
    bySource(origin: string): ReadonlyArray<EvidenceRecord> {
      const direct = sources.get(origin);
      if (direct !== undefined) return direct;
      const normalized = normalizeUrl(origin);
      return (normalized !== undefined ? sources.get(normalized) : undefined) ?? [];
    },
    byToolUseId(toolUseId: string): EvidenceRecord | undefined {
      const own = byKey.get(callKey(root, toolUseId));
      if (own !== undefined) return own;
      const calls = callsOf(toolUseId);
      return calls.length === 1 ? calls[0] : undefined;
    },
    callsById(toolUseId: string): ReadonlyArray<EvidenceRecord> {
      return callsOf(toolUseId);
    },
    all(): ReadonlyArray<EvidenceRecord> {
      return all;
    },
  };
}

/**
 * The index restricted to calls made in `turnNumbers` (`scope: turn`). A
 * record with no `turnNumber` is dropped: under a turn scope, evidence whose
 * turn is unknown cannot be shown to be this turn's.
 */
export function restrictToTurns(
  index: EvidenceIndex,
  turnNumbers: ReadonlySet<number>,
): EvidenceIndex {
  const keep = (record: EvidenceRecord): boolean =>
    record.turnNumber !== undefined && turnNumbers.has(record.turnNumber);
  return {
    bySource: (origin) => index.bySource(origin).filter(keep),
    byToolUseId: (toolUseId) => {
      const record = index.byToolUseId(toolUseId);
      if (record !== undefined && keep(record)) return record;
      if (index.callsById === undefined) return undefined;
      // The id's other calls, in scope: the one left answers for it, and
      // several stay ambiguous (`buildEvidenceIndex`).
      const kept = index.callsById(toolUseId).filter((call) => call !== record && keep(call));
      return kept.length === 1 ? kept[0] : undefined;
    },
    callsById: (toolUseId) => (index.callsById?.(toolUseId) ?? []).filter(keep),
    all: () => index.all().filter(keep),
  };
}
