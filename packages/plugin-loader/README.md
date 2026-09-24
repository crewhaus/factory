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

When the manifest carries an `entrypointDigest`, the plugin's `index.js` must
match it too, so a swapped entrypoint next to a signed manifest is refused.

## Unsigned plugins, for development

```sh
CREWHAUS_PLUGIN_ALLOW_UNSIGNED=1 bun agent.ts
```

loads unsigned plugins. Every boot prints a warning, and so does every plugin
loaded without a verified signature. A signed plugin whose signature does not
verify against a trusted key is still refused.

With no trusted key and no opt-in, a spec that names plugins does not start,
and the message says where to put the key.

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
registers itself (`ListTools`, `Skill`, `Consult`, …), or starting `mcp__` is
left out with a warning, and the plugin's other tools load. Permission rules
and crewhaus's own grants key on tool names, so a plugin `Grep` would otherwise
run under the grant crewhaus gives the builtin one.

## Input schemas

Give each tool a zod 3 schema, or a `jsonSchema` the model reads beside a
schema of your own. A zod 4 schema without a `jsonSchema` is converted with
zod's own converter; if zod cannot describe it, the tool is shown to the model
with no parameters and the boot says so.

## Code

`crewhaus plugins install` writes the manifest only. Put the plugin's
`index.js` next to its `plugin.json` in `~/.crewhaus/plugins/<name>/`; when the
manifest has an `entrypointDigest`, the file's sha256 must match it. A plugin
with no `index.js` is refused at boot with the path it expected.
