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
