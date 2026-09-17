# @crewhaus/tool-schema

Deterministic validation tools. Every one is pure: no filesystem, no network,
no clock, no randomness. The same input always produces the same bytes.

These are the tools for the moments a harness needs a *verdict* rather than an
opinion. Does this payload match the contract; did this batch arrive clean; is
this response still what it was last week; is the new schema safe to ship. A
model asked those questions gives a plausible answer. These give the same
answer twice — and say exactly which field, at which path, was wrong.

```yaml
tools:
  - all-schema        # every tool below
  - -JsonSchemaInfer  # ...except this one
```

| Tool | What it does |
|---|---|
| `Assert` | Evaluate declarative checks against a value and report which failed, with actual vs expected |
| `CheckRequiredFields` | Verify dotted paths are present and non-empty, in one value or every row |
| `CompareGolden` | Snapshot comparison with ignored paths, ignored array order and a numeric epsilon |
| `DeepEqual` | Strict structural equality, with the first difference as a JSON Pointer |
| `JsonSchemaInfer` | Infer a schema from example values |
| `JsonSchemaValidate` | Validate a value against a JSON Schema, every error with a pointer path |
| `MatchSubset` | Assert the parts of a value you care about, allowing extra properties |
| `SchemaDiff` | What changed between two schemas, and whether a reader survives it |
| `SchemaSummarize` | Flatten a schema into a field table — path, type, required, constraints |
| `ValidateEnum` | Check values against an allowed set, with a "did you mean" for near misses |
| `ValidateFormat` | Check strings against email, uri, ipv4, ipv6, uuid, date, date-time, hostname and more |
| `ValidateRecords` | Validate a batch against one schema: per-row errors plus a pass/fail summary |
| `ValidateReferences` | Check every reference points at something that exists |
| `ValidateUniqueKeys` | Find rows sharing a key, including a composite key |

## The JSON Schema subset

`JsonSchemaValidate` and `ValidateRecords` share one Draft-07 validator,
written out in `src/lib/jsonschema.ts` so its behaviour is auditable in a
single file. (`JsonSchemaInfer` writes schemas rather than checking against
them, and does not go through it.) The validator enforces:

| Group | Keywords |
|---|---|
| any | `type`, `enum`, `const` |
| number | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` |
| string | `minLength`, `maxLength`, `pattern`, `format` (opt-in) |
| array | `items` (schema or tuple), `additionalItems`, `contains`, `minItems`, `maxItems`, `uniqueItems` |
| object | `properties`, `patternProperties`, `additionalProperties`, `propertyNames`, `required`, `minProperties`, `maxProperties` |
| logic | `allOf`, `anyOf`, `oneOf`, `not`, `if`/`then`/`else` |
| reference | `$ref` to a local JSON Pointer, including `#/$defs/…` and `#/definitions/…` |

Boolean schemas work wherever a schema is expected. `pattern` is an unanchored
ECMA-262 match, and string lengths are counted in code points, both per spec.

**What it does not enforce**, and says so: `dependencies`,
`dependentRequired`, `dependentSchemas`, `unevaluatedProperties`,
`unevaluatedItems`, the draft-04 boolean form of the exclusive bounds, and
anything else outside the table. Every unenforced constraint keyword
*encountered while validating* comes back in `unsupportedKeywords` — so a
pass can be read honestly rather than mistaken for coverage it does not have.
The list is built while walking, not by scanning the document, so a keyword
sitting in a branch this particular value never reached is not in it. A
`$ref` that points outside the document is an error, never a silent `true`.

`format` follows Draft-07 and is an annotation until you pass `assertFormat`.

## The formats

Each format is a stated subset, not a full grammar, and each rejects the grey
areas deliberately:

- **email** — unquoted ASCII local part, hostname domain, at least one dot.
  Quoted local parts, comments, IP-literal domains and non-ASCII are rejected.
- **uri** — scheme, colon, non-empty remainder, no whitespace or control
  characters. Use **uri-reference** for relative references.
- **hostname** — labels of 1–63 alphanumerics and hyphens, 253 total. A
  trailing dot and underscores are rejected; Unicode must arrive punycoded.
- **ipv4** — four octets 0–255, **no leading zeros** (the ambiguity behind a
  long line of SSRF bugs).
- **ipv6** — full form, `::` compression, and an IPv4 tail. Zone identifiers
  are rejected.
- **uuid** — 8-4-4-4-12 hex, any version or variant, braces rejected.
- **date** / **time** / **date-time** — RFC 3339, calendar-checked, so
  `2023-02-30` fails and `2024-02-29` passes. A time needs an offset; a
  date-time needs the `T`. A leap second (`:60`) is allowed.
- **json-pointer**, **regex** — RFC 6901, and "does it compile".

These grammars overlap, and not symmetrically: a hostname label is letters,
digits and hyphens, so every dotted quad, every UUID and every `YYYY-MM-DD`
date is also a valid hostname. `suggestFormats` therefore lists what a value
matches narrowest first — `uuid` before `hostname` — rather than in the order
the formats are declared.

## What is deliberately not here

`SchemaDiff` classifies a change as `compatible`, `breaking`, or `unknown` —
and never rounds `unknown` to safe. Whether one regex accepts everything
another does, and how two `anyOf` unions relate, are questions this package
does not answer; it says so instead of guessing. A change to a keyword it does
not model at all — `patternProperties`, `contains`, `propertyNames`,
`dependencies` — is `unknown` too, rather than absent from the report. "Backward compatible" here
means every value valid under the old schema is still valid under the new one,
which is compatibility for a *reader* of the data.

`JsonSchemaInfer` describes the samples it was given. It infers no numeric
ranges, no string lengths and no patterns, because three samples never justify
a range, and enum detection is opt-in for the same reason. Format detection is
narrower than `ValidateFormat`: `json-pointer` is never inferred and
`hostname` needs a dot in every sample, because both accept so much that
`"active"` and `/tmp/x` would otherwise be labelled. A field whose distinct
values overflow the tracking limit gets no format at all, since a format
agreed on by the values it kept says nothing about the ones it dropped.

JSON and YAML *parsing* and linting belong to `@crewhaus/tool-data`, not here.

## Layout

`src/lib/` holds the pure functions and is where the behaviour is tested;
`src/index.ts` wraps them as tools. A bug in `isIpv6` reads better as a failing
unit than as a failing tool call.

## Safety flags

All fourteen are `readOnly`, non-destructive, `scope: "internal"`, and declare
no io capability, because none of them crosses a process or network boundary.
`packages/tool-schema/src/index.test.ts` asserts that for every tool, so a
future addition that reaches outside has to change the assertion deliberately.
