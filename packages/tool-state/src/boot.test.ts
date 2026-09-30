import { afterEach, describe, expect, test } from "bun:test";
import {
  VectorTargetError,
  _resetVectorTarget,
  getVectorTarget,
  registerVectorDeleteConfig,
  vectorDelete,
} from "./index";

afterEach(() => _resetVectorTarget());

describe("registerVectorDeleteConfig — tool_config.vectorDelete at boot", () => {
  test("names a store, and the tool deletes from it under the block's protection list", () => {
    registerVectorDeleteConfig({
      backend: "qdrant",
      url: "https://qdrant.example:6333",
      collection: "chunks",
      api_key: "resolved-at-boot",
      protected_collections: ["audit"],
    });
    const target = getVectorTarget();
    expect(target?.store.backend).toBe("qdrant");
    expect(target?.collection).toBe("chunks");
    expect(target?.protectedCollections).toEqual(["audit"]);
  });

  test("a block without a backend registers nothing, and the tool says what to write", async () => {
    registerVectorDeleteConfig({ protected_collections: ["audit"] });
    expect(getVectorTarget()).toBeUndefined();
    const out = await vectorDelete.execute({
      ids: ["a"],
      justification: "erasure request",
    } as never);
    expect(out).toContain("no vector store registered");
    expect(out).toContain("tool_config.vectorDelete: { backend: qdrant");
  });

  test("an in-memory store is refused: it starts empty in every process", () => {
    expect(() => registerVectorDeleteConfig({ backend: "in-memory" })).toThrow(VectorTargetError);
    expect(() => registerVectorDeleteConfig({ backend: "in-memory" })).toThrow(
      "starts empty in every process",
    );
  });

  test("two spellings of one key are refused rather than one silently winning", () => {
    expect(() =>
      registerVectorDeleteConfig({
        backend: "qdrant",
        url: "https://q.example",
        collection: "c",
        protected_collections: ["a"],
        protectedCollections: ["b"],
      }),
    ).toThrow("sets both protected_collections and protectedCollections");
  });
});
