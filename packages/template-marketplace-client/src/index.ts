import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import type {
  RegistrySource,
  TemplateManifest,
  TemplateMetadata,
} from "@crewhaus/template-registry";

/**
 * Catalog F4 `template-marketplace-client` — Section 40 Studio
 * Marketplace integration.
 *
 * Two surfaces:
 *
 *   1. **Discover/install**: `MarketplaceClient.search`,
 *      `MarketplaceClient.install` — wraps a `RegistrySource` from
 *      §40 `template-registry`, layers on search/filter, and writes
 *      installed manifests into the user's spec workspace
 *      (`<workspace>/<name>/crewhaus.yaml`).
 *
 *   2. **Publish**: `MarketplacePublisher.draftPublish` — produces a
 *      `PublishDraft` describing a PR that the caller's git client
 *      submits to the canonical registry repo (or pushes as a Gist).
 *      We don't ship a git client here — Studio's existing GitHub
 *      integration owns the actual transport.
 *
 * Layer F4. Pairs with `template-registry` (§40 — backend), Studio
 * Marketplace tab (§35 surface, integration deferred to Studio UI).
 */

export class MarketplaceClientError extends CrewhausError {
  override readonly name = "MarketplaceClientError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type SearchFilter = {
  /** Substring match on name + description (case-insensitive). */
  readonly query?: string;
  /** Exact match on `target`. */
  readonly target?: string;
  /** Exact match on `author`. */
  readonly author?: string;
  /** Cap results. Default 50. */
  readonly limit?: number;
};

export type InstallOptions = {
  /** Override the directory under workspaceDir. Default = manifest.name. */
  readonly subdir?: string;
  /** Filename. Default = "crewhaus.yaml". */
  readonly filename?: string;
};

export type InstallResult = {
  readonly path: string;
  readonly manifest: TemplateManifest;
};

export type PublishDraft = {
  readonly registryName: string;
  readonly templateName: string;
  readonly target: string;
  readonly author: string;
  readonly description: string;
  readonly version: string;
  readonly manifestJson: string;
  readonly title: string;
  readonly body: string;
};

export type MarketplaceClientOptions = {
  readonly registry: RegistrySource;
  readonly workspaceDir: string;
};

export type MarketplaceSearchResult = {
  readonly metadata: TemplateMetadata;
  readonly score: number;
};

export class MarketplaceClient {
  constructor(private readonly opts: MarketplaceClientOptions) {
    if (opts.registry === undefined) {
      throw new MarketplaceClientError("registry is required");
    }
    if (typeof opts.workspaceDir !== "string" || opts.workspaceDir === "") {
      throw new MarketplaceClientError("workspaceDir is required");
    }
  }

  async list(): Promise<ReadonlyArray<TemplateMetadata>> {
    return this.opts.registry.list();
  }

  async search(filter: SearchFilter = {}): Promise<ReadonlyArray<MarketplaceSearchResult>> {
    const all = await this.opts.registry.list();
    const limit = filter.limit ?? 50;
    const queryLower = filter.query?.toLowerCase() ?? "";
    const filtered = all
      .map((m) => {
        let score = 0;
        if (filter.target !== undefined && m.target !== filter.target) return null;
        if (filter.author !== undefined && m.author !== filter.author) return null;
        if (queryLower !== "") {
          const haystack = `${m.name} ${m.description}`.toLowerCase();
          if (!haystack.includes(queryLower)) return null;
          // Higher score for name matches than description-only matches.
          if (m.name.toLowerCase().includes(queryLower)) score += 10;
          score += haystack.split(queryLower).length - 1;
        } else {
          score = 1;
        }
        return { metadata: m, score };
      })
      .filter((r): r is MarketplaceSearchResult => r !== null);
    return filtered.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async install(name: string, opts: InstallOptions = {}): Promise<InstallResult> {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
      throw new MarketplaceClientError(`invalid template name "${name}"`);
    }
    const manifest = await this.opts.registry.fetch(name);
    const subdir = opts.subdir ?? manifest.name;
    const filename = opts.filename ?? "crewhaus.yaml";
    if (subdir.includes("..") || subdir.includes("/") || subdir.includes("\\")) {
      throw new MarketplaceClientError(`invalid subdir "${subdir}"`);
    }
    if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      throw new MarketplaceClientError(`invalid filename "${filename}"`);
    }
    const targetDir = join(this.opts.workspaceDir, subdir);
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    }
    const path = join(targetDir, filename);
    writeFileSync(path, manifest.yaml, { mode: 0o600 });
    return { path, manifest };
  }
}

export type DraftPublishOptions = {
  readonly registryName: string;
  readonly manifest: TemplateManifest;
};

export class MarketplacePublisher {
  // Stateless: the publisher carries no config. An explicit (empty)
  // constructor is declared so the type reads as instantiable-with-no-args
  // at a glance and the class has a single, covered construction path.
  // biome-ignore lint/complexity/noUselessConstructor: explicit constructor so Bun --coverage counts it as a covered function (field-initializer-only classes can't hit 100% function coverage otherwise)
  constructor() {}

  /**
   * Produce a publish-ready `PublishDraft`. The caller's git client
   * (Studio's GitHub integration, or `gh` from the CLI) opens the PR
   * against the canonical registry repo with `manifestJson` written
   * to `templates/<name>.json`.
   */
  draftPublish(opts: DraftPublishOptions): PublishDraft {
    const m = opts.manifest;
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(m.name)) {
      throw new MarketplaceClientError(`invalid template name "${m.name}"`);
    }
    if (typeof opts.registryName !== "string" || opts.registryName === "") {
      throw new MarketplaceClientError("registryName is required");
    }
    const manifestJson = `${JSON.stringify(m, null, 2)}\n`;
    const title = `Add template ${m.name} v${m.version} (${m.target})`;
    const body = `# ${m.name} v${m.version}\n\n**Target:** ${m.target}  \n**Author:** ${m.author}\n\n${m.description}\n\n---\n\nFiles added:\n- templates/${m.name}.json\n`;
    return {
      registryName: opts.registryName,
      templateName: m.name,
      target: m.target,
      author: m.author,
      description: m.description,
      version: m.version,
      manifestJson,
      title,
      body,
    };
  }

  /**
   * Convenience: writes the publish draft to disk so the caller's git
   * client (or a CI bot) can pick it up. Returns the manifest path.
   */
  writeDraft(workspaceDir: string, draft: PublishDraft): string {
    if (typeof workspaceDir !== "string" || workspaceDir === "") {
      throw new MarketplaceClientError("workspaceDir is required");
    }
    const path = join(workspaceDir, "templates", `${draft.templateName}.json`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, draft.manifestJson, { mode: 0o600 });
    return path;
  }
}

export {
  MarketplaceClient as _MarketplaceClientForTest,
  MarketplacePublisher as _MarketplacePublisherForTest,
};
