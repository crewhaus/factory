/**
 * Qualified refs, actors, and the small grammars a run row is built from. A
 * parser here never throws on bad input; only the `format*` functions do, because
 * printing a value that cannot parse is a programmer error.
 */
import { MODULES, type ModuleField } from "./areas/index.js";
import type { RefKindDecl } from "./areas/types.js";
import { CANONICAL_RUN_ID_RE, HARNESS_ID_RE, SESSION_ID_RE, isId, parseId } from "./ids.js";
import { classifyRunId } from "./run-ids.js";
import { assertNever, deepFreeze } from "./util.js";

// ---------------------------------------------------------------------------
// Refs: <scope>/<kind>/<id>
// ---------------------------------------------------------------------------

type RefKindRow = ModuleField<"refKinds"> extends readonly (infer Row)[] ? Row : never;

export type RefKind = RefKindRow extends { readonly kind: infer K } ? K : never;

const REF_KIND_DECLS: ReadonlyMap<string, RefKindDecl> = new Map(
  MODULES.flatMap((module) => module.refKinds).map((decl) => [decl.kind, decl] as const),
);

/** Every ref kind, the union of the composed modules. */
export const REF_KINDS: readonly RefKind[] = deepFreeze([...REF_KIND_DECLS.keys()] as RefKind[]);

export const REF_MAX_LENGTH = 200;

export type Ref = {
  readonly scope: string;
  readonly kind: string;
  readonly id: string;
};

export type RefError =
  | "not-a-string"
  | "too-long"
  | "whitespace"
  | "percent"
  | "segments"
  | "scope"
  | "kind"
  | "scope-not-allowed"
  | "id";

/** Whether this id fits what the kind may name. */
function refIdFits(decl: RefKindDecl, id: string): boolean {
  const parsed = parseId(id);
  for (const form of decl.ids) {
    if ("prefix" in form) {
      if (parsed?.prefix === form.prefix && parsed.grammar === form.grammar) return true;
    } else if ("family" in form) {
      if (classifyRunId(id).family === form.family) return true;
    } else if (new RegExp(`^${form.pattern}$`).test(id)) {
      return true;
    }
  }
  return false;
}

function scopeAllowed(decl: RefKindDecl, scope: string): boolean {
  switch (decl.scope) {
    case "home":
      return scope === "home";
    case "harness":
      return scope !== "home";
    case "either":
      return true;
    default:
      return assertNever(decl.scope);
  }
}

/** Parse `<scope>/<kind>/<id>`, or say what is wrong with it. */
export function parseRef(ref: unknown): Ref | { readonly error: RefError } {
  if (typeof ref !== "string") return { error: "not-a-string" };
  if (ref.length > REF_MAX_LENGTH) return { error: "too-long" };
  if (/\s/.test(ref)) return { error: "whitespace" };
  if (ref.includes("%")) return { error: "percent" };
  const segments = ref.split("/");
  const [scope, kind, id] = segments;
  if (segments.length !== 3 || !scope || !kind || !id) return { error: "segments" };
  if (scope !== "home" && !HARNESS_ID_RE.test(scope)) return { error: "scope" };
  const decl = REF_KIND_DECLS.get(kind);
  if (decl === undefined) return { error: "kind" };
  if (!scopeAllowed(decl, scope)) return { error: "scope-not-allowed" };
  if (!refIdFits(decl, id)) return { error: "id" };
  return { scope, kind, id };
}

/** Whether `ref` parses. */
export function isRef(ref: unknown): boolean {
  return !("error" in parseRef(ref));
}

/** Print a ref. One that would not parse back throws. */
export function formatRef(ref: Ref): string {
  const text = `${ref.scope}/${ref.kind}/${ref.id}`;
  const parsed = parseRef(text);
  if ("error" in parsed) {
    throw new TypeError(`control-contract: "${text}" is not a ref (${parsed.error})`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

export const SYSTEM_ACTORS = deepFreeze([
  "sys:scheduler",
  "sys:reconcile",
  "sys:runtime",
  "sys:executor",
  // The spec's own SLO rollback, recorded on a change it rolled back.
  "sys:slo",
] as const);

/** The OS user who owns a Hangar root. A person identifier: never stored raw. */
export const LOCAL_ACTOR_RE = /^local:[A-Za-z0-9._-]{1,64}@[A-Za-z0-9.-]{1,253}$/;
/** What an append-only record holds for an unlinked local actor: a keyed digest. */
export const STORED_LOCAL_ACTOR_RE = /^local:#[0-9a-f]{64}$/;

export type ActorForm = "principal" | "local" | "stored-local" | "system";

/** Which form an actor takes, or `null` when it is not one. */
export function parseActor(
  actor: unknown,
): { readonly form: ActorForm; readonly id: string } | null {
  if (typeof actor !== "string") return null;
  if (isId("prn", actor)) return { form: "principal", id: actor };
  if ((SYSTEM_ACTORS as readonly string[]).includes(actor)) return { form: "system", id: actor };
  if (STORED_LOCAL_ACTOR_RE.test(actor)) return { form: "stored-local", id: actor };
  if (LOCAL_ACTOR_RE.test(actor)) return { form: "local", id: actor };
  return null;
}

/** Whether an append-only record may hold this actor: anything but a raw `local:`. */
export function isStoredActor(actor: unknown): boolean {
  const form = parseActor(actor)?.form;
  return form !== undefined && form !== "local";
}

// ---------------------------------------------------------------------------
// Lanes and resume scopes
// ---------------------------------------------------------------------------

const NAMED_LANE_RE = /^schedule:[a-z][a-z0-9-]{0,31}$/;

/** `heartbeat`, `schedule` or `schedule:<name>`. */
export function isLaneId(lane: unknown): boolean {
  if (typeof lane !== "string") return false;
  return lane === "heartbeat" || lane === "schedule" || NAMED_LANE_RE.test(lane);
}

export type ResumeScope =
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "job"; readonly id: string }
  | { readonly kind: "lane"; readonly id: string }
  | { readonly kind: "run"; readonly id: string }
  | { readonly kind: "work"; readonly id: string };

const JOB_ID_RE = /^[\x21-\x7e]{1,256}$/;

function resumeScopeIdFits(scope: ResumeScope): boolean {
  switch (scope.kind) {
    case "session":
      return SESSION_ID_RE.test(scope.id);
    case "job":
      return JOB_ID_RE.test(scope.id);
    case "lane":
      return isLaneId(scope.id);
    case "run":
      return CANONICAL_RUN_ID_RE.test(scope.id);
    case "work":
      return isId("wi", scope.id);
    default:
      return assertNever(scope);
  }
}

const RESUME_SCOPE_KINDS: readonly string[] = deepFreeze(["session", "job", "lane", "run", "work"]);

/** Split a resume scope, or `null` when it is not one. */
export function parseResumeScope(text: unknown): ResumeScope | null {
  if (typeof text !== "string") return null;
  const separator = text.indexOf(":");
  if (separator < 1) return null;
  const kind = text.slice(0, separator);
  if (!RESUME_SCOPE_KINDS.includes(kind)) return null;
  const scope = { kind, id: text.slice(separator + 1) } as ResumeScope;
  return resumeScopeIdFits(scope) ? scope : null;
}

/** Print a resume scope. One that would not parse back throws. */
export function formatResumeScope(scope: ResumeScope): string {
  if (!resumeScopeIdFits(scope)) {
    throw new TypeError(`control-contract: "${scope.id}" does not fit a ${scope.kind} scope`);
  }
  return `${scope.kind}:${scope.id}`;
}

// ---------------------------------------------------------------------------
// Triggers and run-row fields
// ---------------------------------------------------------------------------

export const TRIGGER_KINDS = deepFreeze([
  "queue",
  "heartbeat",
  "schedule",
  "approval-resume",
  "eval",
  "rehearsal",
  "api",
  "cli",
  "channel",
  "managed",
  "resume",
  "retry",
] as const);

export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** Which door a command or a run came through. */
export const RECEIPT_VIA = deepFreeze([
  "home",
  "cli",
  "slack",
  "sdk",
  "github",
  "resident",
  "system",
] as const);

export type ReceiptVia = (typeof RECEIPT_VIA)[number];

/**
 * Where a channel message came from, as a run row may hold it: the platform's name and
 * keyed digests of the conversation and the message, and the sender as a linked member's
 * `prn_` or a keyed digest. Never text, never a raw platform id.
 */
export type TriggerSource = {
  readonly platform: string;
  readonly conversationRef: string;
  readonly messageRef: string;
  readonly senderRef?: string;
};

export type Trigger = {
  readonly kind: TriggerKind;
  readonly lane?: string;
  readonly via?: ReceiptVia;
  readonly workItem?: string;
  readonly synthetic?: true;
  /** A channel message's origin, on the rows of the run that answers it. */
  readonly source?: TriggerSource;
};

export const RUN_CAUSE_KINDS = deepFreeze([
  "provider",
  "tool",
  "mcp",
  "connection",
  "budget",
  "spec",
  "config",
] as const);

/** Why a run failed: names and ids only. */
export type RunCause = {
  readonly kind: (typeof RUN_CAUSE_KINDS)[number];
  readonly ref: string;
};

// ---------------------------------------------------------------------------
// Grant scopes and link subjects
// ---------------------------------------------------------------------------

const GROUP_SCOPE_RE = /^group:[^/]{1,128}$/;

/** `home`, `group:<name>` or `harness:<hrn>`. */
export function isGrantScope(scope: unknown): boolean {
  if (typeof scope !== "string") return false;
  if (scope === "home" || GROUP_SCOPE_RE.test(scope)) return true;
  return scope.startsWith("harness:") && HARNESS_ID_RE.test(scope.slice("harness:".length));
}

export const LINK_PROVIDERS = deepFreeze(["slack", "github", "proxy", "local"] as const);

export type LinkProvider = (typeof LINK_PROVIDERS)[number];

const SLACK_SUBJECT_RE = /^slack:[A-Z0-9]{1,32}:[A-Z0-9]{1,32}$/;
const GITHUB_SUBJECT_RE = /^github:[0-9]{1,20}$/;
const PROXY_SUBJECT_RE = /^proxy:[A-Za-z0-9-]{1,64}:\S{1,256}$/;

/**
 * Which provider a readable link subject belongs to, or `null`. Readable subjects
 * live only in rewritable files; append-only records hold a keyed `subjectRef`.
 */
export function parseLinkSubject(subject: unknown): LinkProvider | null {
  if (typeof subject !== "string") return null;
  if (SLACK_SUBJECT_RE.test(subject)) return "slack";
  if (GITHUB_SUBJECT_RE.test(subject)) return "github";
  if (PROXY_SUBJECT_RE.test(subject)) return "proxy";
  if (LOCAL_ACTOR_RE.test(subject)) return "local";
  return null;
}
