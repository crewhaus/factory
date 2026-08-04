import { describe, expect, test } from "bun:test";
import { type Server, createServer } from "node:net";
import { checkPortFree, portItems } from "./ports";

function listenOnEphemeral(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no address"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("checkPortFree", () => {
  test("reports a held port as taken, and free after release", async () => {
    const { server, port } = await listenOnEphemeral();
    try {
      const taken = await checkPortFree(port);
      expect(taken.free).toBe(false);
      expect(taken.detail).toBe("EADDRINUSE");
    } finally {
      await close(server);
    }
    const freed = await checkPortFree(port);
    expect(freed.free).toBe(true);
  });
});

describe("portItems", () => {
  test("taken → blocking naming port and source; free → info; duplicates collapse", async () => {
    const { server, port } = await listenOnEphemeral();
    try {
      const items = await portItems([
        { port, source: "spec gateway.port" },
        { port, source: "env PORT" },
      ]);
      expect(items).toHaveLength(1);
      expect(items[0]?.level).toBe("blocking");
      expect(items[0]?.message).toContain(`port ${port}`);
      expect(items[0]?.message).toContain("spec gateway.port");
      expect(items[0]?.message).toContain("already in use");
    } finally {
      await close(server);
    }
  });

  test("injectable checker (no sockets) drives classification", async () => {
    const items = await portItems(
      [
        { port: 8080, source: "spec gateway.port" },
        { port: 9090, source: "allocator" },
      ],
      (port) => Promise.resolve({ port, free: port !== 8080 }),
    );
    expect(items.map((i) => i.level)).toEqual(["blocking", "info"]);
  });
});
