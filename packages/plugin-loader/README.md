# @crewhaus/plugin-loader

Loads the plugins a spec names under `plugins:`, after checking where each one
lives and who signed it. A compiled cli or channel bundle and `crewhaus run`
all load plugins through `createBootPluginRuntime`.

## Trusting a publisher

A plugin loads only when its manifest's Ed25519 signature verifies against a
key you trust. Put the publisher's public key, as a `.pem` file, in:

```
~/.crewhaus/plugin-trust/
```

or list `.pem` files (or directories of them) in `CREWHAUS_PLUGIN_TRUST_ANCHORS`,
separated the way `PATH` is. A listed path that cannot be read, or a file that
is not an Ed25519 public key, stops the boot and names the file.

## What a signature covers

A signed manifest must carry an `entrypointDigest`: the sha256 of the plugin's
`index.js`. Without one the signature says nothing about the code, and the
plugin is refused (it loads unverified only in development mode, below).

A signed plugin runs as exactly the bytes that digest names. crewhaus reads
`index.js` once, checks the digest, and imports a private copy of those bytes,
so a file changed after the check never runs. That makes a signed plugin one
ES module file: an `index.js` that loads anything other than a runtime
builtin is refused, because the signature covers none of it. That includes
`import`, `require` and `import()` of a sibling or a package (`./lib.js`,
`zod`), the `module` builtin (`createRequire`), and loading by a name worked
out at run time — `import.meta.require(name)`, `import(name)`,
`require.resolve`, `Bun.resolveSync`. Bundle the plugin before you sign it:

```sh
bun build src/index.ts --target=bun --format=esm --outfile index.js
```

The private copy is made in `~/.crewhaus/verified-code`, which must be yours
and writable by nobody else, and is removed once the plugin is loaded. It is
never made in the shared temp directory, where another user could plant a
package for the plugin's code to find.

A signed manifest may also carry `notAfter`, an RFC 3339 date-time with `Z` or
an offset (`"2027-01-01T00:00:00Z"`). It is signed with the rest of the
manifest, and the plugin is refused after it. `signature.issuedAt` is not
signed, so nothing reads it as a date.

To stop trusting a publisher, remove their key from `~/.crewhaus/plugin-trust/`.

## Unsigned plugins, for development

```sh
CREWHAUS_PLUGIN_ALLOW_UNSIGNED=1 bun agent.ts
```

loads unsigned plugins. Every boot prints a warning, and so does every plugin
loaded without a verified signature. A signed plugin whose signature does not
verify against a trusted key is still refused. An unsigned plugin may be
several files, and is imported where it is.

With no trusted key and no opt-in, a spec that names plugins does not start,
and the message says where to put the key.

## The plugin that loads is the one you installed

A plugin is loaded from the path its install record gives, and the manifest
there must be that plugin: a record that points at another plugin's files is
refused. A plugin the registry pins (`pinnedVersion`) loads only at that
version, so an older release left on disk cannot run in its place, and the
marketplace's update leaves a pinned plugin where it is. A plugin changed in
place since it was installed still loads, and the boot says its install record
is out of date.

## Which crewhaus a plugin runs on

A manifest may say which crewhaus versions it supports:

```json
{ "name": "my-plugin", "version": "1.0.0", "engines": { "crewhaus": "^0.7.0" } }
```

A plugin whose range leaves out the running version is refused before it is
verified or imported, and so is a range crewhaus cannot read. A manifest with
no range loads on any version. A canary (`0.7.1-canary.2`) is checked as its
release (`0.7.1`).

## Tool names a plugin cannot use

A plugin adds tools; it cannot take the name of one crewhaus defines. A plugin
tool named like a builtin (`Grep`, `HttpRequest`, …), like a tool the runtime
registers itself (`ListTools`, `Skill`, `Consult`, …), either of those in
another letter case (`grep`, `READ`), starting `mcp__`, or shaped
`<server>__<tool>` is left out with a warning, and the plugin's other tools
load. Permission rules and crewhaus's own grants key on tool names, so a
plugin `Grep` would otherwise run under the grant crewhaus gives the builtin
one; a model profile's `tools` list matches names in any case, so a plugin
`grep` would be offered wherever a profile lists `Grep`; and rules written
before 0.7.1 name an MCP tool `broker__paper_buy`, so a plugin tool of that
name would run under a rule meant for the MCP one. Use your plugin's prefix
and single underscores (`acme_grep`, `acme_paper_buy`).

## What a plugin can reach

A plugin is code that runs inside the crewhaus process, with its full
authority — environment and secrets, files, network, child processes — from
the moment it is imported. The signature decides whether it runs; nothing
after that contains it.

Of the manifest's `permissions`, only `tools` is applied: a plugin tool's
`ctx.bridge` shows `runContext` and the host tools `permissions.tools` names,
and nothing else — not the permission rules, the approvals store, the
sub-agent spawner or the other tools. A tool's `concurrencyClassifier` is
shown the same host tools, and calling one from there runs nothing: a
classifier runs before the permission engine decides the call.

A host tool a plugin calls through the bridge runs with the runtime's context
for that call, so `Task` still starts its sub-agent. It runs directly, without
the permission engine, the justification gate or the egress check, so name
only tools the plugin may drive unchecked. `fs`, `net` and `secrets` are not
enforced on plugin code.

A manifest that declares `permissions.fs`, `net` or `secrets` gets a boot note
saying they are not enforced, so nobody reads them as a sandbox.

## The manifest is the contract

The code must be the plugin its manifest describes: a module whose default
export says it is another plugin (`definePlugin({ name: "other" })`) is
refused. A differing version or `permissions` in the code is noted; the
manifest is what crewhaus goes by.

A manifest may list the tools its code contributes:

```json
{ "name": "my-plugin", "version": "1.0.0", "provides": { "tools": ["lookup"] } }
```

The list is signed with the manifest, so you can read it before anything
runs. When it is there, the plugin loads only if its code contributes exactly
those tools. It is not a sandbox — the code has run by the time the list is
compared — but it makes a plugin that grew a tool its manifest never mentioned
fail at boot. Without the list, a plugin loads as before.

## Tool definitions are checked at boot

A plugin is JavaScript, so nothing typed its tools. Each one is checked before
the plugin loads, and one that is malformed refuses the whole plugin at boot,
naming the tool and the field:

- `name`: 1-64 letters, digits, `_` or `-`.
- `description` (optional) a string; `execute` a function.
- `readOnly`, `destructive`, `requiresSandbox`, `requireJustification`,
  `concurrencySafe`, `classifyOutput`: `true`, `false` or absent. A string
  such as `"false"` is refused: plan mode reads it as set, and the sandbox and
  justification checks read it as unset. `null` counts as absent, here and in
  every other optional field.
- `scope`: `"internal"` or `"external"`; `ioCapability`: `"network"` or
  `"process"`.
- `inputSchema`: a zod schema (it validates every call). `jsonSchema`, when
  given, an object schema.

A tool that declares `ioCapability` but not `scope: "external"` runs as
external, so what it sends is checked on the way out, and the boot says so.
Two tools with one name — in one plugin or two — keep the first; the boot names
the one left out.

## What a plugin can contribute

Tools, and skills in a `skills/` directory beside `plugin.json`. The
directory, each skill in it and each `SKILL.md` must really be inside the
plugin's own directory: a link within it works, a link that leads out is left
out with a boot note. A `SKILL.md` is read only as a regular file of at most
1 MiB, so a FIFO cannot hang the boot. The SDK also
declares channels, models, graders and target emitters, but nothing in crewhaus
binds them yet: a plugin that contributes one still loads, and the boot says
that part has no effect. A grader belongs in
`.crewhaus/graders/<name>/index.ts` instead, where the eval runner loads it.

## Input schemas

Give each tool a zod 3 schema, or a `jsonSchema` the model reads beside a
schema of your own. A zod 4 schema without a `jsonSchema` is converted with
zod's own converter; if zod cannot describe it, the tool is shown to the model
with no parameters and the boot says so. A validator that is not zod needs a
`jsonSchema`.

## Code

`crewhaus plugins install` writes the manifest only. Put the plugin's
`index.js` next to its `plugin.json` in `~/.crewhaus/plugins/<name>/`; when the
manifest has an `entrypointDigest`, the file's sha256 must match it. A plugin
with no `index.js` is refused at boot with the path it expected.

`index.js` must be a regular file inside the plugin's own directory. It may be
a link to another file in that directory (`index.js -> dist/index.js`), but a
link that leads anywhere else — outside `~/.crewhaus/plugins`, or into another
plugin's directory — is refused, and so is a FIFO or a device. `plugin.json`
is read up to 1 MiB and `index.js` up to 64 MiB.
