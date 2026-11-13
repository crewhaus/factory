/**
 * `@crewhaus/hangar-ui` — the Hangar console's static UI, embedded as text.
 *
 * Zero-build by design: the `assets/` tree is hand-written browser code
 * (plain ES modules + one CSS file + one HTML shell, no framework, no npm
 * deps, no bundler). The embed modules under `./embed/` import every asset
 * `with { type: "text" }`, one module per area, and this module merges them
 * into the exact map, keyed by serve path, that the CLI hands to the hangar
 * server's static-asset option.
 *
 * STATIC imports only, deliberately: `bun build --compile` embeds only what
 * the import graph references statically — a runtime `readFileSync` of a
 * package-relative path resolves under `/$bunfs` in the compiled binary,
 * where the files were never placed, and bricks every command at boot. The
 * checked-in asset files stay the single source of truth; the embed modules
 * only re-export their text.
 *
 * An area adds its screens to its OWN embed module, never here and never to
 * another area's. The unit tests enforce the map's completeness (every file
 * under `assets/` appears under its serve path, with the right content type,
 * and every relative import inside the JS modules resolves within the map)
 * and that no two embed modules claim the same path, so adding an asset file
 * without registering it fails CI.
 */
import type { HangarAsset } from "./embed/asset";
import { attentionAssets } from "./embed/attention";
import { creationAssets } from "./embed/creation";
import { delegationAssets } from "./embed/delegation";
import { homeAssets } from "./embed/home";
import { inspectionAssets } from "./embed/inspection";
import { integrationsAssets } from "./embed/integrations";
import { knowledgeAssets } from "./embed/knowledge";
import { peopleAssets } from "./embed/people";
import { qualityAssets } from "./embed/quality";
import { runtimeAssets } from "./embed/runtime";

export { CONTENT_TYPES, type HangarAsset, contentTypeFor } from "./embed/asset";

/** Every embed module, by area. Their key sets never overlap (tested). */
export const EMBED_MODULES: Readonly<Record<string, Readonly<Record<string, HangarAsset>>>> = {
  home: homeAssets,
  attention: attentionAssets,
  creation: creationAssets,
  delegation: delegationAssets,
  inspection: inspectionAssets,
  integrations: integrationsAssets,
  knowledge: knowledgeAssets,
  people: peopleAssets,
  quality: qualityAssets,
  runtime: runtimeAssets,
};

/**
 * The embed map, keyed by serve path. `"/"` is the SPA shell (the app is a
 * hash router, so `/` is the only HTML route); everything else lives under
 * `/assets/…` exactly as laid out on disk.
 */
export const hangarAssets: Readonly<Record<string, HangarAsset>> = {
  ...homeAssets,
  ...attentionAssets,
  ...creationAssets,
  ...delegationAssets,
  ...inspectionAssets,
  ...integrationsAssets,
  ...knowledgeAssets,
  ...peopleAssets,
  ...qualityAssets,
  ...runtimeAssets,
};
