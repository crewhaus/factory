# @crewhaus/tool-data

Deterministic structured-data tools. Every one is pure: no filesystem, no
network, no clock, no randomness. The same input always produces the same
bytes.

That property is the point. A harness spends a model call when it needs
judgement; it should not spend one to pull two fields out of an API response,
join two result sets, or turn a CSV into records. These twenty-three tools
cover the mechanical half so the model is left with the part that actually
needs it.

```yaml
tools:
  - all-data          # every tool below
  - -DataConvert      # ...except this one
```

| Tool | What it does |
|---|---|
| `ColumnsToRecords` | Column arrays back to records, short columns padded and named |
| `CsvParse` | RFC 4180 CSV to records or rows, with type inference |
| `CsvWrite` | Records or rows to RFC 4180 CSV, quoting whatever needs it |
| `DataConvert` | JSON ⇄ YAML ⇄ TOML ⇄ CSV ⇄ JSONL |
| `DataDiff` | Structural diff of two documents: added, removed, changed, by path |
| `DataShape` | What is actually in this document — fields, types, fill rates, examples |
| `DedupeRecords` | Drop duplicates by key fields or by the whole value, key order ignored |
| `FlattenObject` | Nested value to dotted keys |
| `JsonFormat` | Re-indent, minify, key-sort, address a subtree, hash the result |
| `JsonMergePatch` | Apply an RFC 7386 merge patch, or derive one between two documents |
| `JsonPatch` | Apply RFC 6902 operations, all-or-nothing |
| `JsonQuery` | Select values with a JSONPath-like expression |
| `JsonSortKeys` | Key-sorted JSON, for diff-stable output |
| `JsonlParse` | Line-delimited JSON, with the line number of any bad record |
| `JsonlWrite` | Values to line-delimited JSON |
| `RecordsToColumns` | Records to column arrays |
| `SampleRecords` | Head, tail, every nth, or evenly spread — never random |
| `SortRecords` | Stable, total ordering by one or more dotted paths |
| `TableAggregate` | Group by, with count/sum/min/max/avg/first/last/distinct |
| `TableJoin` | Inner, left, right or full join of two record arrays |
| `TableQuery` | Filter, project, sort and page records with a small predicate |
| `UnflattenObject` | Dotted keys back to a nested value |
| `XmlParse` | XML or an HTML fragment to a JSON tree |

## Two input conventions

A whole **document** — JSON, YAML, TOML, CSV, XML, JSONL — arrives as text,
because that is how it comes off disk or off the wire. A **record array**
arrives as a real array of objects, because that is how it comes out of the
previous tool in the chain. Field references inside the record tools are
dotted paths (`user.team.id`), so nested records work without flattening
them first.

## The parsers are hand-written, so here is exactly what they support

There is no YAML, TOML, XML or CSV dependency behind these tools. That keeps
the package free of a supply chain, and it means the supported subset is a
contract rather than a hopeful summary. Each module's header comment carries
the authoritative version; this is the short form.

### JsonQuery's grammar

```
$.a.b            child
$["odd key"]     quoted child, for keys with dots or spaces
$.a[0]  $.a[-1]  index, negative counts from the end
$.a[1:5]  [::2]  slice, Python semantics, negative step included
$.a[*]   $.*     every element / every value
$..name  $..*    recursive descent
$.u[?(@.age >= 30)]   filter: == != < <= > >= =~ , or a bare existence test
```

Not supported, each raising a parse error naming the position rather than
returning an empty result: unions (`['a','b']`), functions, parent axes, and
`&&` / `||` inside a filter — chain two filter steps instead. Comparing a
number against a string is simply false; there is no coercion, because a
quiet `"10" < 9` is how a filter silently drops rows.

### YAML

**Read:** block mappings and sequences nested by space indentation, a compact
map on the dash line (`- name: a`), plain/single-quoted/double-quoted scalars
with the usual escapes, core-schema typing (`null` `~` `true` `false`,
integers, decimals, exponents, `0x`, `0o`), flow collections
(`[1, {a: b}]`), block scalars `|` and `>` with the `-` and `+` chomping
indicators, `#` comments, and `---` / `...` markers.

`.inf` and `.nan` read and write correctly, but JSON has no spelling for
either, so converting a document that uses them **to JSON** renders them
`null`. The same is true of TOML's `inf` and `nan`.

**Refused explicitly, never guessed at:** anchors and aliases (`&a`, `*a`),
merge keys (`<<:`), tags (`!!str`), multiple documents in one stream, complex
keys (`? `), and tabs in indentation. Dates stay strings.

**Write:** block style, two-space indent, keys in their existing order, with
a string quoted whenever leaving it bare would change how it reads back.

### TOML

**Read:** bare, quoted and dotted keys; tables and arrays of tables at any
depth; basic, literal and both multi-line string forms, including the
backslash line continuation; integers with `_` separators and `0x`/`0o`/`0b`
literals; floats, `inf`, `nan`; arrays, nested and multi-line; inline tables;
`#` comments. Redefining a table or key is an error, as the spec requires.

**The one deliberate departure:** dates and times stay strings. TOML has four
first-class date-time types and JSON has none, so `2026-01-01` reads back as
`"2026-01-01"`. Converting to a `Date` would make the round trip lossy.
Integers outside the JavaScript safe range likewise stay strings rather than
being silently rounded.

Redefinition is enforced in both directions the spec names: a `[header]`
cannot reopen a table a dotted key already created, and a dotted key cannot
reach into a table a `[header]` already defined.

**Write:** scalars first, then sub-tables, then arrays of tables — the order
that reads back identically. `null` has no TOML representation, so it is
dropped and the dropped keys are named in the output.

### CSV

RFC 4180 in full: quoted fields, delimiters and newlines inside quotes,
doubled quotes, a final row with no trailing newline, and a row that is a
single quoted empty field (`""` is a record, not a blank line). Plus the two
departures real files need — a configurable delimiter, and tolerance of bare
LF as well as CRLF. A byte-order mark is stripped.

Duplicate and blank column names are made unique before records are built,
and the suffix is bumped until the name is genuinely unused, so `a,a,a_2`
becomes `a, a_2, a_2_2` rather than losing a column to a collision.

Type inference is opt-in and conservative: `007`, `+5` and anything outside
the safe integer range stay strings, because turning a zip code into a number
loses data. Ragged rows are reported, not silently padded.

### XML

A well-formedness-checking parser for the XML that shows up in feeds, SVG and
config files. It is **not** a conformant XML processor and does not claim to
be. Elements, attributes, text, CDATA, self-closing tags, the five predefined
entities and numeric character references; comments, processing instructions
and doctypes skipped; namespace prefixes kept verbatim, not resolved.

DTD-declared and external entities are refused outright — there is no
resolver, so this parser cannot be made to fetch anything. A numeric
character reference outside the Unicode range, or naming a surrogate, is a
reported error rather than a crash. Validation, `xml:space` and raw-text
elements (`<script>`, `<style>`) are not supported.
`html` mode adds void elements, unquoted and bare attributes, case-insensitive
tag names, and browser-style recovery from a mismatched close tag.

## What is deliberately not here

Anything whose core is judgement rather than mechanism: inferring what a
column *means*, reconciling two schemas by intent, deciding which of two
conflicting records is right, summarizing a dataset in prose. `DataShape`
reports types and fill rates, not semantics.

Nor is there a random sampler. `SampleRecords` offers head, tail, every-nth
and evenly-spread, because a tool that returned a different subset on each
call could not be cached, retried, or compared between runs.

Where a deterministic first pass exists, it belongs first and the model is the
escalation path.

## A caller's mistake is a result, not an exception

Malformed JSON, an unparseable path, an unterminated CSV quote, a mismatched
XML tag: each comes back as a readable string naming the format and, where
the format has lines, the line number. Tools throw only on a bug in the tool.
`JsonPatch` goes further and is transactional — if operation 4 of 6 fails, it
says so and the document is unchanged. That includes a pointer that is not a
pointer: `"a"` instead of `"/a"` names the operation it broke on, rather than
raising out of the tool.

`src/index.test.ts` drives every tool with malformed input and asserts a
readable result, and `src/integration.test.ts` does the same through
`executeTool`.

## Layout

`src/lib/` holds the pure functions and is where the behaviour is tested;
`src/index.ts` wraps them as tools. A bug in the CSV quote handling reads
better as a failing unit than as a failing tool call.

## Safety flags

All twenty-three are `readOnly`, non-destructive, `scope: "internal"`, and
declare no io capability, because none of them crosses a process or network
boundary. `packages/tool-data/src/index.test.ts` asserts that for every tool,
so a future addition that reaches outside has to change the assertion
deliberately.
