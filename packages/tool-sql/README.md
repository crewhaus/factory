# @crewhaus/tool-sql

SQL tools over SQLite. `bun:sqlite` ships with the runtime, so a harness gets
querying, schema introspection, import, export, migrations and integrity
checking against a `.db` file with no driver, no server and no connection
string.

**SQLite only.** Not Postgres, not MySQL, not "SQL" in general. A harness that
needs a database server needs a different package. Everything below is written
against SQLite's own behaviour, and where SQLite's behaviour is surprising the
tools say so rather than hiding it.

```yaml
tools:
  - all-sql        # every tool below
  - -SqlExec       # ...except this one
```

| Tool | What it does |
|---|---|
| `SqlQuery` | Run a read on a read-only connection, with bound parameters, capped rows |
| `SqlExec` | Run one INSERT, UPDATE, DELETE or DDL statement with bound parameters |
| `SqlTransaction` | Apply several statements atomically, rolling all of them back on any failure |
| `SqlExplain` | The query plan, with the tables scanned end to end and the indexes used |
| `SchemaList` | Tables, views, indexes and triggers |
| `SchemaDescribe` | One table's columns, types, nullability, defaults, primary and foreign keys |
| `DbSchemaDiff` | What differs between two databases' schemas |
| `TableStats` | Exact row counts and, where `dbstat` exists, size on disk |
| `ImportCsv` | Load a CSV into a table in one transaction, reporting every rejected row |
| `ImportJson` | Load JSON or NDJSON records the same way, from a file or inline |
| `ExportCsv` | Stream a query's rows to a CSV file inside the workspace |
| `ExportJson` | Stream them to a JSON array or NDJSON file |
| `MigrationApply` | Apply pending `.sql` migrations in order, recording each one |
| `MigrationStatus` | Which migrations ran, which are pending, which files changed after running |
| `DatabaseBackup` | A consistent copy via SQLite's `VACUUM INTO`, not a byte copy |
| `IntegrityCheck` | `integrity_check` and `foreign_key_check`, reported structurally |

## The four properties that hold everywhere

**Containment.** Every path — the database, a CSV, an export destination, a
migration directory — goes through `resolveSafe`, which refuses anything
resolving outside `process.cwd()`, including through a symlink that lives
inside the workspace. The SQL is contained too: `ATTACH`, `DETACH`, `VACUUM`
and `load_extension` are refused, because each reaches a file by a route the
path check never sees.

**Bound parameters, always.** No caller value is written into a statement,
and what a statement declares is checked twice: once by a scan that follows
SQLite's own parameter grammar (`$1`, `:1` and `@1` are named parameters, not
positional ones), and again against the parameter count SQLite reports for the
compiled statement, so a disagreement becomes a refusal instead of values
bound to NULL in silence.
`sql` and `params` are separate fields and always will be. Schema
introspection uses SQLite's pragma table-valued functions
(`pragma_table_info(?)`), which take bound parameters where `PRAGMA
table_info(name)` would have needed a table name spliced in. The only
identifiers written into SQL are the table and column names the import tools
create — validated, then double-quoted — and a row count over a name that
came out of `sqlite_schema` a line earlier. Two numbers are also written
rather than bound — `PRAGMA busy_timeout = N` and `PRAGMA integrity_check(N)`,
neither of which takes a parameter in SQLite's grammar — and both are clamped
and floored by this package before they become digits.

**Reads are read-only at the engine.** `SqlQuery` and the schema tools open
the file with `SQLITE_OPEN_READONLY`. Checking the leading keyword would not
work: a CTE starts with `WITH`, and `WITH x AS (…) DELETE FROM t` is a write.
`bun:sqlite`'s `Statement` does not expose the `readonly` flag that
better-sqlite3 surfaces from `sqlite3_stmt_readonly`, so the connection flag
is the mechanism — and it also refuses `PRAGMA journal_mode = WAL` and every
other write wearing a different hat. Those connections also set `PRAGMA
query_only`, because `SQLITE_OPEN_READONLY` leaves the TEMP database
writable: without it `CREATE TEMP TABLE big AS SELECT …` runs, and spills
outside the workspace, from a connection the caller was told is read-only.
`DatabaseBackup` is the one read connection with `query_only` off, because
`VACUUM INTO` is a write by SQLite's reckoning even though the only thing it
writes is the copy.

**Determinism.** The same call against the same database returns the same
bytes. Listings are sorted by plain codepoint comparison, never
`localeCompare`; nothing samples a random source; no clock value appears in a
result unless the caller selected the column holding it.

## What these tools do not handle

- **A single long step cannot be interrupted.** Deadlines are checked between
  rows, and `busy_timeout` bounds waiting on another writer's lock. A scan
  that reads a million pages before yielding its first row runs to
  completion: `bun:sqlite` exposes neither `sqlite3_interrupt` nor a progress
  handler, and SQLite is synchronous, so there is no thread on which to
  cancel it. A caller who needs a hard ceiling needs one around the harness
  process.
- **One statement per call**, except in `SqlTransaction` and migration files.
  This is not fussiness: `bun:sqlite`'s `prepare` compiles the first statement
  and discards the rest without an error, so `SELECT 1; INSERT …` would report
  success for work that never happened.
- **The statement splitter is a heuristic**, used only for counting and for
  refusals. It understands strings, comments, a trigger body's `BEGIN … END`
  and `CASE … END`, but it is not a parser — it is a lexical scanner, and it
  is described as one everywhere it is used. What executes is parsed by
  SQLite.
- **Names resolve case-insensitively**, the way SQLite resolves them, so
  `USERS` finds the table declared `users`; results report the spelling the
  database stores.
- **A blank line in a CSV is skipped**, not read as a row with one empty
  field. A file that ends in two newlines would otherwise produce a phantom
  malformed row. An empty single-column value has to be written `""`.
- **`DbSchemaDiff` compares indexes, triggers and view bodies as text.** SQLite
  stores only the DDL the author wrote, so a purely cosmetic rewrite shows as
  a change. Tables and views are compared column by column.
- **`TableStats` row counts are exact**, which means a full scan of every
  table. On a large database that is the expensive call; it stops at the
  timeout and says how far it got.
- **CSV cannot distinguish NULL from an empty string.** `ExportCsv` writes
  both as an empty field and says so; `ImportCsv` reads an empty cell as NULL
  by default and as `""` when asked.
- **An edited migration stops `MigrationApply`.** There is no override. An
  applied migration is history; add a new one.
- **`DatabaseBackup` is a compacted copy, not a byte image.** `VACUUM INTO`
  takes a consistent snapshot under a live writer, which is the point, but the
  result will usually be smaller than the original and its page layout will
  differ.

## Values

Integers are read with `safeIntegers`, so one past 2^53 is returned as a
decimal string rather than as a JavaScript number that would silently be a
different number. BLOBs come back as `{ blob: { bytes, base64 } }`, with the
data omitted past 4 KiB. Booleans bind as 1 and 0, because SQLite has no
boolean type; nested JSON values become JSON text on import, because it has no
nested types either.

## Tests

`bun test packages/tool-sql/src`. Every test builds a throwaway workspace
under the OS temp directory and chdir's into it, so nothing is ever written
inside the repository. The refusals — a path that escapes, a deadline that
fires, an injection attempt through a value, a header and a table name — are
tested against a real database, not mocked.
