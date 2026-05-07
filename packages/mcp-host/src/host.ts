import { McpError } from "@crewhaus/errors";
import { type Logger, createLogger } from "@crewhaus/logging";
import { McpClient, type McpClientOptions } from "./client.js";
import type { McpServerConfig } from "./types.js";

export type McpHostOptions = {
  readonly logger?: Logger;
  /** Per-client option overrides (e.g. for tests). Applied to every server. */
  readonly clientOptions?: Omit<McpClientOptions, "logger">;
};

/**
 * Registry of named MCP servers. `addServer()` is synchronous (config +
 * uniqueness check only); `connect()` is invoked by callers (typically
 * `@crewhaus/tool-mcp.registerMcpServer`). All I/O is therefore explicit
 * and concentrates in one boot-time `Promise.all` rather than buried in
 * configuration.
 */
export class McpHost {
  private readonly clients = new Map<string, McpClient>();
  private readonly logger: Logger;
  private readonly clientOptions: Omit<McpClientOptions, "logger"> | undefined;

  constructor(opts: McpHostOptions = {}) {
    this.logger = opts.logger ?? createLogger({ bindings: { component: "mcp-host" } });
    this.clientOptions = opts.clientOptions;
  }

  /**
   * Register a server config. Returns the constructed McpClient so callers
   * can keep a handle without a second lookup. Throws McpError if `name`
   * is already registered.
   */
  addServer(name: string, config: McpServerConfig): McpClient {
    if (this.clients.has(name)) {
      throw new McpError(`mcp server "${name}" is already registered`);
    }
    const client = new McpClient(name, config, {
      ...(this.clientOptions ?? {}),
      logger: this.logger.child({ mcpServer: name }),
    });
    this.clients.set(name, client);
    return client;
  }

  getClient(name: string): McpClient {
    const c = this.clients.get(name);
    if (!c) throw new McpError(`mcp server "${name}" is not registered`);
    return c;
  }

  has(name: string): boolean {
    return this.clients.has(name);
  }

  list(): ReadonlyArray<{ readonly name: string; readonly client: McpClient }> {
    return [...this.clients.entries()].map(([name, client]) => ({ name, client }));
  }

  /**
   * Disconnect every registered client. Used by the generated agent's
   * try/finally cleanup so spawned subprocesses are reaped on exit. Errors
   * from individual disconnects are logged and ignored — the goal is best-
   * effort cleanup.
   */
  async disconnectAll(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((c) => c.disconnect()));
  }
}
