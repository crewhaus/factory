/**
 * The structured editor's model: a form built from the JSON schema a harness's
 * spec is checked with, one node per setting.
 *
 * A node the form can show becomes a labelled control (text, number, integer,
 * a yes/no choice, a list of choices, a list of values, or a group of other
 * nodes). Every other node becomes `json`, with a plain sentence saying why,
 * and opens the JSON pane for its path: a record keyed by names, a list of
 * entries with several fields, a setting that takes more than one form, one
 * that refers to itself, one nested past the depth cap, and one the masker
 * redacted on its way here (its name names a credential, so its shape is
 * hidden and so is its value).
 *
 * The schema's `$ref`s are document-absolute JSON pointers that can reach deep
 * into another definition, so each is resolved segment by segment (`~1`, `~0`
 * decoded), with a guard against a reference to itself and a depth cap; one
 * that does not resolve is a `json` node, never a throw.
 *
 * Tiers come from the server's trust rows, matched by segments, and only from
 * them: a node with no row has `tier: null` and is written through a reviewed
 * preview, whose answer says what the edit needs. This module never guesses one.
 *
 * Pure: no DOM, nothing runs at import, so a test imports it under bun.
 */

/** What the masker puts where a credential's value was. */
export const REDACTED = "[redacted]";

/** How deep the walk goes before a node is shown in the JSON pane instead. */
export const MAX_DEPTH = 12;

/** The input `fieldEdit` reads as "remove this setting from the file". */
export const CLEAR = Object.freeze({ clear: true });

/** The kinds that render a control of their own. */
export const CONTROL_KINDS = Object.freeze([
  "text",
  "number",
  "integer",
  "boolean",
  "select",
  "list",
]);

/** Why a node is edited in the JSON pane, in plain words. */
export const JSON_WHY = Object.freeze({
  record: "It holds entries you name yourself, so it is edited as JSON.",
  objects: "It is a list of entries with several fields each, so it is edited as JSON.",
  union: "It can take more than one form, so it is edited as JSON.",
  combined: "It combines several shapes, so it is edited as JSON.",
  self: "It refers to itself, so it is edited as JSON.",
  deep: "It is nested too deeply to show here, so it is edited as JSON.",
  secret: "It can hold a secret, so this screen does not show it. Edit it as JSON to replace it.",
  unresolved: "Its shape could not be read here, so it is edited as JSON.",
  any: "It takes any value, so it is edited as JSON.",
  free: "It takes free-form settings, so it is edited as JSON.",
});

/** One stable key for a path: a key may hold a `.`, so segments are never joined with one. */
export function nodeKey(segments) {
  return JSON.stringify((Array.isArray(segments) ? segments : []).map((s) => String(s)));
}

/** A key as a label: `max_tokens` → "Max tokens", `botToken` → "Bot token". */
export function labelOf(key) {
  const words = String(key ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (words === "") return String(key ?? "");
  return `${words[0].toUpperCase()}${words.slice(1)}`;
}

/** True when a value is, or holds at any depth, the masker's placeholder. */
export function carriesMasked(value, depth = 0) {
  if (typeof value === "string") return value === REDACTED;
  if (depth > 64 || value === null || typeof value !== "object") return false;
  const items = Array.isArray(value) ? value : Object.values(value);
  return items.some((item) => carriesMasked(item, depth + 1));
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isLiteral = (v) =>
  v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** Whether a subschema's own description of its shape was redacted in transit. */
function maskedShape(schema) {
  if (schema === REDACTED) return true;
  if (!isObject(schema)) return false;
  for (const [key, value] of Object.entries(schema)) {
    if (value === REDACTED) return true;
    if (key === "type" && Array.isArray(value) && value.includes(REDACTED)) return true;
    if (key === "enum" && Array.isArray(value) && value.includes(REDACTED)) return true;
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      if (value.some((branch) => maskedShape(branch))) return true;
    }
  }
  return false;
}

/** Resolve one JSON pointer (`#/a/b~1c`) inside `doc`, or undefined. */
export function resolvePointer(doc, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#")) return undefined;
  if (ref === "#") return doc;
  if (!ref.startsWith("#/")) return undefined;
  let at = doc;
  for (const raw of ref.slice(2).split("/")) {
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(at)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return undefined;
      at = at[Number(segment)];
    } else if (isObject(at) && Object.hasOwn(at, segment)) {
      at = at[segment];
    } else {
      return undefined;
    }
  }
  return at;
}

/** One pointer segment, escaped. */
const escapeSegment = (segment) => String(segment).replace(/~/g, "~0").replace(/\//g, "~1");

/**
 * Follow `$ref`s to the schema they name, keeping the siblings a `$ref` node
 * carries (a description). `open` holds the pointers of every schema already
 * open on this path, so a reference back to one of them is `{self: true}`.
 * Answers `{schema, pointer}` (the pointer of where it landed), `{self: true}`,
 * `{masked: true}` or `{unresolved: true}`.
 */
function follow(doc, schema, open, pointer = null) {
  let at = schema;
  let where = pointer;
  const extra = {};
  for (let hops = 0; hops < 32; hops += 1) {
    if (!isObject(at) || typeof at.$ref !== "string") {
      return { schema: isObject(at) ? { ...at, ...extra } : at, pointer: where };
    }
    const ref = at.$ref;
    if (ref === REDACTED) return { masked: true };
    if (open.has(ref) || ref === where) return { self: true };
    for (const [key, value] of Object.entries(at)) {
      if (key !== "$ref" && !(key in extra)) extra[key] = value;
    }
    const target = resolvePointer(doc, ref);
    if (target === undefined) return { unresolved: true };
    at = target;
    where = ref;
  }
  return { unresolved: true };
}

/** The literal choices a schema allows, or null when it allows more than literals. */
function literalsOf(doc, schema, open) {
  const followed = follow(doc, schema, open);
  if (followed.schema === undefined || !isObject(followed.schema)) return null;
  const s = followed.schema;
  if (Object.hasOwn(s, "const") && isLiteral(s.const)) return [s.const];
  if (Array.isArray(s.enum) && s.enum.length > 0 && s.enum.every(isLiteral)) return [...s.enum];
  if (s.type === "null") return [null];
  return null;
}

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);
const KIND_OF_TYPE = { string: "text", number: "number", integer: "integer", boolean: "boolean" };

/** Hints a control may show beside itself. Never the gate: the server's schema decides. */
function hintsOf(schema) {
  const out = {};
  for (const key of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "default",
  ]) {
    if (Object.hasOwn(schema, key)) out[key] = schema[key];
  }
  return out;
}

/** Strip `null` from a type list or a union: answers the rest and whether null was allowed. */
function withoutNull(doc, schema, open) {
  if (Array.isArray(schema.type)) {
    const rest = schema.type.filter((t) => t !== "null");
    if (rest.length !== schema.type.length) {
      return { schema: { ...schema, type: rest.length === 1 ? rest[0] : rest }, nullable: true };
    }
    return { schema, nullable: false };
  }
  const branches = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;
  if (branches === null) return { schema, nullable: false };
  const rest = branches.filter((b) => {
    const lits = literalsOf(doc, b, open);
    return !(lits !== null && lits.length === 1 && lits[0] === null);
  });
  if (rest.length === branches.length) return { schema, nullable: false };
  const { anyOf: _a, oneOf: _o, ...siblings } = schema;
  if (rest.length === 1) {
    const only = follow(doc, rest[0], open);
    if (isObject(only.schema)) return { schema: { ...siblings, ...only.schema }, nullable: true };
    return { schema: rest[0], nullable: true };
  }
  return { schema: { ...siblings, anyOf: rest }, nullable: true };
}

/**
 * The form for a narrowed schema document.
 *
 *   schema    — the document the server answers (`{$ref, definitions}`)
 *   effective — the effective rows (`{segments, value, source}`)
 *   trust     — the trust rows (`{segments, tier, securitySurface}`), declared paths only
 *
 * Answers `{groups, counts, why}`: the root's settings in schema order, the
 * walk's tallies (`visited` equals `classified` by construction: every node
 * the walk enters is classified exactly once), and, when the root itself is
 * not a block of settings, why.
 */
export function formModel(schema, effective = [], trust = []) {
  const counts = { visited: 0, classified: 0, controls: 0, json: 0, groups: 0 };
  const rows = new Map();
  const prefixRows = [];
  for (const row of Array.isArray(effective) ? effective : []) {
    const segments = Array.isArray(row?.segments)
      ? row.segments.map(String)
      : typeof row?.path === "string"
        ? row.path.split(".")
        : null;
    if (segments === null || segments.length === 0) continue;
    const entry = { segments, value: row.value, source: row.source };
    rows.set(nodeKey(segments), entry);
    prefixRows.push(entry);
  }
  const tiers = new Map();
  for (const row of Array.isArray(trust) ? trust : []) {
    const segments = Array.isArray(row?.segments) ? row.segments.map(String) : null;
    if (segments === null) continue;
    tiers.set(nodeKey(segments), row);
  }
  const startsWith = (segments, prefix) =>
    prefix.length <= segments.length && prefix.every((p, i) => segments[i] === p);
  const declaredUnder = (segments) =>
    prefixRows.some((r) => r.source === "declared" && startsWith(r.segments, segments)) ||
    [...tiers.values()].some((t) => startsWith(t.segments.map(String), segments));
  const valueUnder = (segments, declaredOnly = false) => {
    const exact = rows.get(nodeKey(segments));
    if (exact !== undefined)
      return declaredOnly && exact.source !== "declared" ? undefined : exact.value;
    const below = prefixRows.filter(
      (r) =>
        r.segments.length > segments.length &&
        startsWith(r.segments, segments) &&
        (!declaredOnly || r.source === "declared"),
    );
    if (below.length === 0) return undefined;
    const out = {};
    for (const r of below) {
      let at = out;
      const rest = r.segments.slice(segments.length);
      for (const [i, seg] of rest.entries()) {
        if (i === rest.length - 1) at[seg] = r.value;
        else {
          if (!isObject(at[seg])) at[seg] = {};
          at = at[seg];
        }
      }
    }
    return out;
  };

  const doc = isObject(schema) ? schema : {};

  const base = (segments, help) => {
    const key = segments[segments.length - 1];
    const tierRow = tiers.get(nodeKey(segments));
    const seed = valueUnder(segments);
    const declaredSeed = valueUnder(segments, true);
    const exact = rows.get(nodeKey(segments));
    return {
      segments,
      key: nodeKey(segments),
      label: labelOf(key),
      help: typeof help === "string" && help !== "" ? help : null,
      seed,
      // What the JSON pane starts from: what the file says, or the defaults when it says nothing.
      paneSeed: declaredSeed !== undefined ? declaredSeed : seed,
      source:
        exact !== undefined
          ? exact.source
          : declaredUnder(segments)
            ? "declared"
            : seed !== undefined
              ? "default"
              : null,
      tier: tierRow?.tier ?? null,
      security: tierRow?.securitySurface === true,
      badges: [],
      writeOnly: carriesMasked(seed),
      nullable: false,
    };
  };

  const asJson = (node, why) => {
    counts.classified += 1;
    counts.json += 1;
    return { ...node, kind: "json", why };
  };
  const asControl = (node, kind, extra) => {
    counts.classified += 1;
    counts.controls += 1;
    return { ...node, ...extra, kind };
  };

  const walk = (raw, segments, depth, ancestors, pointer) => {
    counts.visited += 1;
    const description = isObject(raw) ? raw.description : undefined;
    if (depth > MAX_DEPTH) return asJson(base(segments, description), JSON_WHY.deep);
    if (maskedShape(raw)) return asJson(base(segments, null), JSON_WHY.secret);
    // Every schema open on this path, by its pointer: a reference back to one is a loop.
    const open = new Set(ancestors);
    if (pointer !== null) open.add(pointer);
    let followed = follow(doc, raw, open, pointer);
    let nullable = false;
    let s;
    for (let pass = 0; pass < 4; pass += 1) {
      if (followed.masked) return asJson(base(segments, null), JSON_WHY.secret);
      if (followed.self) return asJson(base(segments, description), JSON_WHY.self);
      if (followed.unresolved || !isObject(followed.schema)) {
        return asJson(base(segments, description), JSON_WHY.unresolved);
      }
      if (maskedShape(followed.schema)) return asJson(base(segments, null), JSON_WHY.secret);
      if (followed.pointer !== null) open.add(followed.pointer);
      const stripped = withoutNull(doc, followed.schema, open);
      nullable = nullable || stripped.nullable;
      s = stripped.schema;
      if (!isObject(s) || typeof s.$ref !== "string") break;
      // A union with null around a reference: follow what the reference names.
      followed = follow(doc, s, open, followed.pointer);
    }
    if (!isObject(s)) return asJson(base(segments, description), JSON_WHY.unresolved);
    const here = followed.pointer;
    const refs = open;
    const node = { ...base(segments, s.description ?? description), nullable };

    const whole = literalsOf(doc, s, refs);
    if (whole !== null) return asControl(node, "select", { options: whole, hints: hintsOf(s) });
    const branches = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null;
    if (branches !== null) {
      const lits = branches.map((b) => literalsOf(doc, b, refs));
      if (lits.every((l) => l !== null)) {
        const options = [];
        for (const l of lits) for (const v of l) if (!options.includes(v)) options.push(v);
        return asControl(node, "select", { options, hints: hintsOf(s) });
      }
      return asJson(node, JSON_WHY.union);
    }
    if (Array.isArray(s.allOf)) return asJson(node, JSON_WHY.combined);
    const type = s.type;
    if (Array.isArray(type)) return asJson(node, JSON_WHY.union);
    if (typeof type === "string" && SCALAR_TYPES.has(type)) {
      return asControl(node, KIND_OF_TYPE[type], { hints: hintsOf(s) });
    }
    if (type === "object" || (type === undefined && isObject(s.properties))) {
      if (isObject(s.properties) && Object.keys(s.properties).length > 0) {
        const children = Object.entries(s.properties).map(([key, child]) =>
          walk(
            child,
            [...segments, key],
            depth + 1,
            refs,
            here === null ? null : `${here}/properties/${escapeSegment(key)}`,
          ),
        );
        counts.classified += 1;
        counts.groups += 1;
        return { ...node, kind: "group", children };
      }
      if (isObject(s.additionalProperties)) return asJson(node, JSON_WHY.record);
      return asJson(node, JSON_WHY.free);
    }
    if (type === "array") {
      const items = s.items;
      if (Array.isArray(items) || !isObject(items)) return asJson(node, JSON_WHY.objects);
      if (maskedShape(items)) return asJson(node, JSON_WHY.secret);
      const choices = literalsOf(doc, items, refs);
      if (choices !== null) {
        return asControl(node, "list", {
          itemKind: "select",
          itemOptions: choices,
          hints: hintsOf(s),
        });
      }
      const item = follow(doc, items, refs);
      const itemType = isObject(item.schema) ? item.schema.type : undefined;
      if (typeof itemType === "string" && SCALAR_TYPES.has(itemType)) {
        return asControl(node, "list", { itemKind: KIND_OF_TYPE[itemType], hints: hintsOf(s) });
      }
      return asJson(node, JSON_WHY.objects);
    }
    return asJson(node, JSON_WHY.any);
  };

  const root = follow(
    doc,
    isObject(doc) && typeof doc.$ref === "string" ? { $ref: doc.$ref } : doc,
    new Set(),
    "#",
  );
  const top = isObject(root.schema) ? root.schema : null;
  if (top === null || !isObject(top.properties)) {
    return {
      groups: [],
      counts,
      why: "This spec's settings cannot be shown as a form here. Edit them by path in the JSON pane, or in crewhaus.yaml.",
    };
  }
  const opened = new Set(["#", root.pointer ?? "#"]);
  const groups = Object.entries(top.properties).map(([key, child]) =>
    walk(
      child,
      [key],
      1,
      opened,
      root.pointer === null ? null : `${root.pointer}/properties/${escapeSegment(key)}`,
    ),
  );
  return { groups, counts, why: null };
}

/** Every node of a form, depth first, groups included. */
export function flatten(groups) {
  const out = [];
  const visit = (node) => {
    out.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of Array.isArray(groups) ? groups : []) visit(node);
  return out;
}

const same = (a, b) => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

/** A typed text as the kind's value: a number stays text when it is not one, so the schema says why. */
function coerceAs(kind, input) {
  if (kind === "number" || kind === "integer") {
    const text = String(input ?? "").trim();
    const n = Number(text);
    return text !== "" && Number.isFinite(n) ? n : text;
  }
  if (kind === "boolean") return input === true || input === "true";
  return input;
}

/**
 * The one edit a control's value makes: `{path, value}`, `{path}` to remove the
 * setting (`CLEAR`), or null when nothing would change: the value equals the
 * seed, nothing was typed, a hidden value's control was left empty, or the value
 * still carries the masker's placeholder (a masked read is never written back).
 * Coercion is by the node's kind, never by the seed's type.
 */
export function fieldEdit(node, input) {
  if (!isObject(node) || !Array.isArray(node.segments) || node.segments.length === 0) return null;
  const path = node.segments.map(String);
  if (input === CLEAR) return node.source === "declared" ? { path } : null;
  // A hidden value's control starts empty, and an empty one sends nothing, whatever its kind.
  if (node.writeOnly === true && (input === "" || input === undefined || input === null)) {
    return null;
  }
  let value;
  switch (node.kind) {
    case "text": {
      value = String(input ?? "");
      if (value === "" && (node.writeOnly === true || node.seed === undefined)) return null;
      break;
    }
    case "number":
    case "integer": {
      if (String(input ?? "").trim() === "") return null;
      value = coerceAs(node.kind, input);
      break;
    }
    case "boolean": {
      if (input === "" || input === undefined || input === null) return null;
      value = coerceAs("boolean", input);
      break;
    }
    case "select": {
      if (input === undefined) return null;
      value = input;
      break;
    }
    case "list": {
      if (!Array.isArray(input)) return null;
      value = input.map((item) =>
        node.itemKind === "select" ? item : coerceAs(node.itemKind, item),
      );
      break;
    }
    default:
      return null;
  }
  if (carriesMasked(value)) return null;
  if (same(value, node.seed)) return null;
  return { path, value };
}

/** The keys an unknown-key issue names: `Unrecognized key(s) in object: 'a', 'b'`. */
function unknownKeysOf(issue) {
  return [...String(issue?.message ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Place each issue on the deepest node whose segments prefix its path. An
 * unknown-key issue names its parent, with the keys in its message, so each key
 * is placed as the parent plus that key (the parent's group, since the key has
 * no node). An issue no node prefixes (the root) stays in `unplaced`.
 */
export function issuesByField(groups, issues) {
  const nodes = flatten(groups);
  const byPath = new Map();
  const unplaced = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    const path = (Array.isArray(issue?.path) ? issue.path : []).map(String);
    const keys = issue?.code === "unrecognized_keys" ? unknownKeysOf(issue) : [];
    const targets = keys.length > 0 ? keys.map((k) => [...path, k]) : [path];
    const placedOn = new Set();
    for (const target of targets) {
      let best = null;
      for (const node of nodes) {
        const s = node.segments;
        if (s.length === 0 || s.length > target.length) continue;
        if (!s.every((seg, i) => String(seg) === target[i])) continue;
        if (best === null || s.length > best.segments.length) best = node;
      }
      if (best === null || placedOn.has(best.key)) continue;
      placedOn.add(best.key);
      const list = byPath.get(best.key) ?? [];
      list.push(issue);
      byPath.set(best.key, list);
    }
    if (placedOn.size === 0) unplaced.push(issue);
  }
  return { byPath, unplaced };
}
