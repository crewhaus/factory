/**
 * Discovery, the caller, and refs: `meta.discover` answers the protocol, how to sign in,
 * and, for a signed-in caller, the operation table (each row's columns, never a handler),
 * the capability names, the list limits and Home's public address. `me.get` answers who
 * the caller is and what it may do. `refs.resolve` answers where a ref points, its
 * revision and a one-line summary, through the core's resolvers and any an area adds.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listGrants, listMembers } from "@crewhaus/access-control";
import {
  CAPABILITY_NAMES,
  CURSOR_MAX_LENGTH,
  OPERATIONS,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  PERMISSIONS,
  PERMISSION_DECLS,
  PROTOCOL_ID,
  parseId,
  parseRef,
} from "@crewhaus/control-contract";
import {
  foldStates,
  readDeployments,
  readStandingRules,
  runsLedger,
} from "@crewhaus/control-records";
import { readRunLedger } from "@crewhaus/harness-supervisor";
import { specRevision } from "@crewhaus/ir/policy";
import { foldApprovals } from "../approvals";
import type { RefResolver, V1Context, V1Handler } from "./context";
import { V1Error } from "./errors";
import { commandLedgerOf, entryOf, liveDirOf, visibleHarnesses } from "./resolve";

/** The operation table as discovery publishes it: data, never a handler. */
function discoveryOperations() {
  return OPERATIONS.map((op) => ({
    id: op.id,
    method: op.method,
    path: op.path,
    permission: op.permission,
    receipt: op.receipt,
    request: op.request,
    response: op.response,
    cliTwin: op.cliTwin,
    qualifiers: op.qualifiers,
    idempotency: op.idempotency,
    ...(op.noReceiptReason !== undefined ? { noReceiptReason: op.noReceiptReason } : {}),
    ...(op.noTwinReason !== undefined ? { noTwinReason: op.noTwinReason } : {}),
    ...(op.stream !== undefined ? { stream: op.stream } : {}),
    ...(op.secretFields !== undefined ? { secretFields: op.secretFields } : {}),
    ...(op.modelBound !== undefined ? { modelBound: op.modelBound } : {}),
  }));
}

const discover: V1Handler = async (ctx) => ({
  status: 200,
  body: {
    protocol: PROTOCOL_ID,
    signIn: { methods: ["browser", "device"] },
    operations: discoveryOperations(),
    capabilities: [...CAPABILITY_NAMES],
    limits: {
      pageLimitDefault: PAGE_LIMIT_DEFAULT,
      pageLimitMax: PAGE_LIMIT_MAX,
      cursorMaxLength: CURSOR_MAX_LENGTH,
    },
    ...(ctx.deps.baseUrl !== undefined ? { links: { baseUrl: ctx.deps.baseUrl } } : {}),
  },
});

const me: V1Handler = async (ctx) => {
  const read = ctx.deps.home.signIn.snapshot();
  const snapshot = read.state === "present" ? read.snapshot : undefined;
  const caller = ctx.access.caller;
  const principal = caller.actor === null ? snapshot?.owner : caller.principal;
  const row =
    snapshot === undefined || principal === undefined
      ? undefined
      : listMembers(snapshot, ctx.deps.now()).find((member) => member.id === principal);
  if (snapshot === undefined || row === undefined) {
    throw new V1Error({
      status: 503,
      code: "unavailable",
      reason: "no_members",
      message: "Home has no members yet. Open Home in a browser on its own computer first.",
    });
  }
  const harnesses = visibleHarnesses(ctx.deps);
  const can: Record<string, boolean> = {};
  for (const permission of PERMISSIONS) {
    can[permission] =
      PERMISSION_DECLS[permission].scope === "home"
        ? ctx.access.authorize(permission).allow
        : harnesses.some((entry) => ctx.access.authorize(permission, { harness: entry.id }).allow);
  }
  return {
    status: 200,
    body: {
      principal: {
        id: row.id,
        kind: row.kind,
        ...(row.displayName !== undefined ? { displayName: row.displayName } : {}),
        createdAt: row.createdAt,
      },
      grants: listGrants(snapshot, ctx.deps.now())
        .filter((grant) => grant.principal === row.id && grant.state === "active")
        .map((grant) => ({
          id: grant.id,
          principal: grant.principal,
          role: grant.role,
          scope: grant.scope,
          grantedBy: grant.grantedBy,
          ...(grant.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}),
        })),
      can,
    },
  };
};

/** The page an object opens on in Home, and its absolute address when one is set. */
function hrefOf(ctx: V1Context, ref: string): { href: string; url?: string } {
  const href = `/#/i/${ref}`;
  const base = ctx.deps.baseUrl;
  return base === undefined ? { href } : { href, url: `${base.replace(/\/+$/, "")}${href}` };
}

function notFound(what: string): V1Error {
  return new V1Error({
    status: 404,
    code: "not_found",
    reason: "ref_unknown",
    message: `This Home has no ${what} by that ref.`,
  });
}

function harnessDirOf(ctx: V1Context, scope: string): { id: string; dir: string } {
  const entry = entryOf(ctx.deps, scope);
  const dir = entry === undefined ? undefined : liveDirOf(entry);
  if (entry === undefined || dir === undefined) throw notFound("harness");
  return { id: entry.id, dir };
}

function specRevisionOf(dir: string): string | undefined {
  for (const name of ["crewhaus.yaml", "crewhaus.yml"]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    try {
      return specRevision(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const resolveHarness: RefResolver = async (ctx, ref) => {
  const { id, dir } = harnessDirOf(ctx, ref.id);
  const entry = entryOf(ctx.deps, id);
  const deployments = readDeployments(dir);
  const active = deployments.state === "present" ? deployments.active : undefined;
  const artifact = active?.["artifact"] as { specHash?: unknown } | undefined;
  const spec = specRevisionOf(dir);
  const revisions = {
    ...(spec !== undefined ? { spec } : {}),
    ...(typeof artifact?.specHash === "string" ? { deployedSpec: artifact.specHash } : {}),
    ...(active !== undefined ? { deployment: String(active["id"]) } : {}),
  };
  return {
    status: 200,
    body: {
      kind: "harness",
      ...hrefOf(ctx, `home/harness/${id}`),
      rev: spec ?? String(active?.["id"] ?? "0"),
      revisions,
      summary: entry?.specName ?? id,
    },
  };
};

const resolveDeployment: RefResolver = async (ctx, ref) => {
  const { dir } = harnessDirOf(ctx, ref.scope);
  const read = readDeployments(dir);
  const record =
    read.state === "present" ? read.records.find((r) => r["id"] === ref.id) : undefined;
  if (record === undefined) throw notFound("deployment");
  return {
    status: 200,
    body: {
      kind: "deployment",
      ...hrefOf(ctx, `${ref.scope}/deployment/${ref.id}`),
      rev: `${ref.id}:${String(record["state"])}`,
      summary: `A ${String(record["state"])} build`,
    },
    scrubDir: dir,
  };
};

const resolveRun: RefResolver = async (ctx, ref) => {
  const { dir } = harnessDirOf(ctx, ref.scope);
  const fold = foldStates(runsLedger(dir));
  const object = fold.ok ? fold.objects.get(ref.id) : undefined;
  if (object === undefined) throw notFound("run");
  const rows = fold.ok ? (fold.generations.get(ref.id) ?? 1) : 1;
  return {
    status: 200,
    body: {
      kind: "run",
      ...hrefOf(ctx, `${ref.scope}/run/${ref.id}`),
      rev: String(rows),
      summary: `A ${object.state} run`,
    },
    scrubDir: dir,
  };
};

const resolveExec: RefResolver = async (ctx, ref) => {
  const { dir } = harnessDirOf(ctx, ref.scope);
  let rows = 0;
  try {
    rows = readRunLedger(dir).filter((entry) => entry.runId === ref.id).length;
  } catch {
    rows = 0;
  }
  if (rows === 0) throw notFound("run");
  return {
    status: 200,
    body: {
      kind: "exec",
      ...hrefOf(ctx, `${ref.scope}/exec/${ref.id}`),
      rev: String(rows),
      summary: "A supervised run",
    },
    scrubDir: dir,
  };
};

const resolveDecision: RefResolver = async (ctx, ref) => {
  const { dir } = harnessDirOf(ctx, ref.scope);
  const record = foldApprovals(dir).approvals.find((a) => a.id === ref.id);
  if (record === undefined) throw notFound("decision");
  const digest =
    typeof record.bindingDigest === "string" ? `:${record.bindingDigest.slice(0, 12)}` : "";
  const state =
    record.supersededBy !== undefined
      ? "superseded"
      : record.consumedAt !== undefined
        ? "consumed"
        : record.decision === "grant"
          ? "granted"
          : record.decision === "deny"
            ? "denied"
            : "pending";
  return {
    status: 200,
    body: {
      kind: "decision",
      ...hrefOf(ctx, `${ref.scope}/decision/${ref.id}`),
      rev: `${state}${digest}`,
      summary: `A ${state} decision about ${record.toolName}`,
    },
    scrubDir: dir,
  };
};

const resolveRule: RefResolver = async (ctx, ref) => {
  const { dir } = harnessDirOf(ctx, ref.scope);
  const read = readStandingRules(dir);
  const row = read.state === "present" ? read.rows.find((r) => r.id === ref.id) : undefined;
  if (row === undefined) throw notFound("standing rule");
  return {
    status: 200,
    body: {
      kind: "rule",
      ...hrefOf(ctx, `${ref.scope}/rule/${ref.id}`),
      rev: row.state,
      summary: `A ${row.state} standing rule for ${row.tool}`,
    },
    scrubDir: dir,
  };
};

const resolveCommand: RefResolver = async (ctx, ref) => {
  const found = commandLedgerOf(ctx.deps, ref.id, ref.scope === "home" ? undefined : ref.scope);
  if (found === undefined) throw notFound("command");
  return {
    status: 200,
    body: {
      kind: "cmd",
      ...hrefOf(ctx, `${ref.scope}/cmd/${ref.id}`),
      rev: `${found.receipt.state}:${found.receipt.endedAt ?? found.receipt.acceptedAt}`,
      summary: `A ${found.receipt.state} ${found.receipt.kind} command`,
    },
  };
};

const resolvePrincipal: RefResolver = async (ctx, ref) => {
  if (!ctx.access.authorize("home.access.manage").allow) {
    throw new V1Error({
      status: 403,
      code: "forbidden",
      reason: "permission",
      needs: "home.access.manage",
      message: "Only an owner of this Home can look up who someone is.",
    });
  }
  const read = ctx.deps.home.signIn.snapshot();
  const row =
    read.state === "present"
      ? listMembers(read.snapshot, ctx.deps.now()).find((m) => m.id === ref.id)
      : undefined;
  if (row === undefined) throw notFound("member");
  return {
    status: 200,
    body: {
      kind: "principal",
      ...hrefOf(ctx, `home/principal/${ref.id}`),
      rev: String(row.grants.length),
      summary: row.displayName ?? (row.kind === "service" ? "A service" : "A member"),
    },
  };
};

/** The core's ref resolvers, by kind. */
export const CORE_REF_RESOLVERS: Readonly<Record<string, RefResolver>> = {
  harness: resolveHarness,
  deployment: resolveDeployment,
  run: resolveRun,
  exec: resolveExec,
  decision: resolveDecision,
  rule: resolveRule,
  cmd: resolveCommand,
  principal: resolvePrincipal,
};

/** Where a bare `run_<16 hex>` may live in one harness: a supervisor run, an eval, a research run. */
function bareRunCandidates(dir: string, harness: string, id: string) {
  const out: { kind: string; ref: string; href: string }[] = [];
  const at = (kind: string) => {
    const ref = `${harness}/${kind}/${id}`;
    out.push({ kind, ref, href: `/#/i/${ref}` });
  };
  if (existsSync(join(dir, ".crewhaus", "run", "logs", `${id}.log`))) at("exec");
  else if (readRunLedgerSafe(dir).some((entry) => entry.runId === id)) at("exec");
  const evals = join(dir, ".crewhaus", "evals");
  if (existsSync(evals) && readdirSafe(evals).some((name) => name.startsWith(id))) at("evalrun");
  if (existsSync(join(dir, ".crewhaus", "research", id))) {
    out.push({
      kind: "research",
      ref: `${harness}/exec/${id}`,
      href: `/#/i/${harness}/exec/${id}`,
    });
  }
  return out;
}

function readRunLedgerSafe(dir: string) {
  try {
    return readRunLedger(dir);
  } catch {
    return [];
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const resolveRef: V1Handler = async (ctx) => {
  const raw = ctx.params["ref"] ?? "";
  const parsed = parseRef(raw);
  const resolvers = ctx.refResolvers;
  if (!("error" in parsed)) {
    const resolver = resolvers.get(parsed.kind);
    if (resolver === undefined) {
      throw new V1Error({
        status: 501,
        code: "unsupported",
        reason: "ref_kind_not_served",
        message: `This Home does not resolve ${parsed.kind} refs yet.`,
      });
    }
    // A harness ref is about that harness; any other ref is about its scope.
    const harness = parsed.kind === "harness" ? parsed.id : parsed.scope;
    if (harness !== "home" && !ctx.access.canRead(harness)) throw notFound(parsed.kind);
    return resolver(ctx, parsed);
  }
  // A bare id: where it may live, in the harnesses this caller may read.
  const id = parseId(raw) === null ? undefined : raw;
  if (id === undefined) {
    throw new V1Error({
      status: 400,
      code: "invalid",
      reason: "ref",
      message: "That is not a ref.",
    });
  }
  const hint = ctx.query["harness"];
  const harnesses =
    hint !== undefined
      ? [entryOf(ctx.deps, hint)].filter((e) => e !== undefined && ctx.access.canRead(e.id))
      : visibleHarnesses(ctx.deps);
  const candidates = harnesses.flatMap((entry) => {
    const dir = entry === undefined ? undefined : liveDirOf(entry);
    return entry === undefined || dir === undefined ? [] : bareRunCandidates(dir, entry.id, id);
  });
  if (hint !== undefined && candidates.length === 1) {
    const one = candidates[0] as { kind: string; ref: string };
    const target = parseRef(one.ref);
    const resolver = "error" in target ? undefined : resolvers.get(target.kind);
    if (resolver !== undefined && !("error" in target)) return resolver(ctx, target);
  }
  if (hint !== undefined && candidates.length > 1) {
    return {
      status: 200,
      body: {
        kind: "candidates",
        href: `/#/i/${raw}`,
        rev: String(candidates.length),
        candidates,
        summary: `This id names ${candidates.length} things in this harness.`,
      },
    };
  }
  throw new V1Error({
    status: 422,
    code: "invalid",
    reason: hint === undefined ? "harness_needed" : "ref_unknown",
    message:
      hint === undefined
        ? "A bare id needs ?harness= to say which harness it is in."
        : "That id names nothing in this harness.",
    details: { candidates },
  });
};

export const META_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "meta.discover": discover,
  "me.get": me,
  "refs.resolve": resolveRef,
};
