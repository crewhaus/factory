/**
 * The checker set and what `ProofCheckers` says about it: preference order,
 * the builtin always present, the sandbox checkers present-but-unavailable
 * without a sandbox (with the reason), a bounded probe, and the tool's
 * listing through the factory.
 */
import { describe, expect, test } from "bun:test";
import {
  BUILTIN_LANGUAGE,
  DEFAULT_LEAN4_IMAGE,
  DEFAULT_SMT_IMAGE,
  LEAN4_LANGUAGE,
  type ProofChecker,
  SMT_LANGUAGE,
  createBuiltinChecker,
} from "@crewhaus/proof-checker";
import {
  buildDefaultCheckers,
  createProofTools,
  defaultCheckerIds,
  listCheckers,
  probeChecker,
  sandboxImages,
} from "./index";
import { config, fakeRun, z3Sandbox } from "./test-helpers";

/** A plugin checker whose `available()` is scripted. */
function plugin(id: string, available: () => Promise<unknown>): ProofChecker {
  return {
    id,
    language: `${id}: a plugin language`,
    available: available as ProofChecker["available"],
    async check() {
      return { ok: false, checker: id, assumptions: [], axioms: [], output: "", durationMs: 0 };
    },
  };
}

describe("probeChecker", () => {
  test("passes an availability answer through", async () => {
    expect(await probeChecker(createBuiltinChecker())).toEqual({ ok: true });
    expect(
      await probeChecker(plugin("p", async () => ({ ok: false, reason: "no licence" }))),
    ).toEqual({ ok: false, reason: "no licence" });
  });

  test("a probe that throws is unavailable, with the error", async () => {
    const r = await probeChecker(
      plugin("p", async () => {
        throw new Error("socket closed");
      }),
    );
    expect(r).toEqual({
      ok: false,
      reason: "the p checker's availability probe failed: socket closed",
    });
  });

  test("a probe that throws synchronously is caught too", async () => {
    const checker = plugin("p", async () => ({ ok: true }));
    const sync = {
      ...checker,
      available: () => {
        throw new Error("boom");
      },
    } as unknown as ProofChecker;
    expect((await probeChecker(sync)).reason).toContain("boom");
  });

  test("a probe that never answers is unavailable after the bound", async () => {
    const r = await probeChecker(
      plugin("slow", () => new Promise(() => {})),
      20,
    );
    expect(r).toEqual({
      ok: false,
      reason: "the slow checker did not say whether it can run within 20 ms",
    });
  });

  test("a malformed answer, or a refusal with no reason, still says something", async () => {
    expect(await probeChecker(plugin("p", async () => "yes"))).toEqual({
      ok: false,
      reason: "the p checker gave no availability answer",
    });
    expect(await probeChecker(plugin("p", async () => ({ ok: false, reason: "  " })))).toEqual({
      ok: false,
      reason: "the p checker cannot run here",
    });
  });
});

describe("defaultCheckerIds / sandboxImages", () => {
  test("formal.checkers in order, the builtin appended when the config left it out", () => {
    expect(defaultCheckerIds(config("proven"))).toEqual(["builtin", "smt"]);
    expect(
      defaultCheckerIds(config("proven", { formal: { checkers: ["smt", "builtin"] } })),
    ).toEqual(["smt", "builtin"]);
    expect(defaultCheckerIds(config("proven", { formal: { checkers: ["lean4"] } }))).toEqual([
      "lean4",
      "builtin",
    ]);
  });

  test("images for exactly the listed sandbox checkers; formal.image overrides lean4's", () => {
    expect(sandboxImages(config("proven"))).toEqual([DEFAULT_SMT_IMAGE]);
    expect(sandboxImages(config("proven", { formal: { checkers: ["builtin"] } }))).toEqual([]);
    expect(
      sandboxImages(config("proven", { formal: { checkers: ["smt", "lean4", "builtin"] } })),
    ).toEqual([DEFAULT_SMT_IMAGE, DEFAULT_LEAN4_IMAGE]);
    expect(
      sandboxImages(
        config("proven", {
          formal: { checkers: ["lean4"], image: "ghcr.io/acme/lean-mathlib:1" },
        }),
      ),
    ).toEqual(["ghcr.io/acme/lean-mathlib:1"]);
  });
});

describe("buildDefaultCheckers", () => {
  test("no sandbox: the sandbox checkers are listed, unavailable, saying how to get one", async () => {
    let built = 0;
    const checkers = buildDefaultCheckers(
      config("proven", { formal: { checkers: ["builtin", "smt", "lean4"] } }),
      {
        sandboxAvailable: false,
        createSandbox: () => {
          built += 1;
          throw new Error("must not be called");
        },
      },
    );
    expect(built).toBe(0);
    const listing = await listCheckers(checkers);
    expect(listing.map((c) => [c.id, c.available])).toEqual([
      ["builtin", true],
      ["smt", false],
      ["lean4", false],
    ]);
    expect(listing[1]?.reason).toContain("needs a container sandbox");
    expect(listing[1]?.reason).toContain("CREWHAUS_SANDBOX");
  });

  test("a builtin-only config never builds a sandbox", () => {
    let built = 0;
    buildDefaultCheckers(config("proven", { formal: { checkers: ["builtin"] } }), {
      sandboxAvailable: true,
      createSandbox: () => {
        built += 1;
        return z3Sandbox("");
      },
    });
    expect(built).toBe(0);
  });

  test("with a sandbox: it is built once, allowing exactly the checkers' images", async () => {
    const seen: Array<ReadonlyArray<string>> = [];
    const sandbox = z3Sandbox("");
    const checkers = buildDefaultCheckers(config("proven"), {
      sandboxAvailable: true,
      createSandbox: (opts) => {
        seen.push(opts.allowedImages);
        return sandbox;
      },
    });
    expect(seen).toEqual([[DEFAULT_SMT_IMAGE]]);
    const listing = await listCheckers(checkers);
    expect(listing.map((c) => [c.id, c.available])).toEqual([
      ["builtin", true],
      ["smt", true],
    ]);
    // The availability probe is the image's health check, run in the sandbox.
    expect(sandbox.calls.map((c) => c.argv)).toEqual([["z3", "--version"]]);
  });

  test("a sandbox that cannot be built: the checker says why, from the error", async () => {
    const checkers = buildDefaultCheckers(config("proven"), {
      sandboxAvailable: true,
      createSandbox: () => {
        throw new Error('CREWHAUS_SANDBOX="dokcer" is not a sandbox backend');
      },
    });
    const listing = await listCheckers(checkers);
    expect(listing[1]?.id).toBe("smt");
    expect(listing[1]?.available).toBe(false);
    expect(listing[1]?.reason).toContain("is not a sandbox backend");
  });

  test("the noop backend: smt refuses itself (no isolation)", async () => {
    const checkers = buildDefaultCheckers(config("proven"), {
      sandboxAvailable: true,
      createSandbox: () => z3Sandbox(""),
    });
    expect((await listCheckers(checkers))[1]?.available).toBe(true);
    const noop = buildDefaultCheckers(config("proven"), {
      sandboxAvailable: true,
      createSandbox: () => ({ ...z3Sandbox(""), backend: "noop" }),
    });
    const listing = await listCheckers(noop);
    expect(listing[1]?.available).toBe(false);
    expect(listing[1]?.reason).toContain("noop");
  });
});

describe("ProofCheckers", () => {
  // biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
  async function list(tools: ReturnType<typeof createProofTools>): Promise<any> {
    return JSON.parse((await tools.proofCheckers.execute({}, fakeRun().ctx)) as string);
  }

  test("lists every checker in preference order with its language and availability", async () => {
    const out = await list(
      createProofTools({
        config: config("proven", { formal: { checkers: ["smt", "builtin"] } }),
        checkers: buildDefaultCheckers(
          config("proven", { formal: { checkers: ["smt", "builtin"] } }),
          { sandboxAvailable: false, createSandbox: () => z3Sandbox("") },
        ),
      }),
    );
    expect(out.floor).toBe("proven");
    expect(out.checkers.map((c: { id: string }) => c.id)).toEqual(["smt", "builtin"]);
    expect(out.checkers[0]).toMatchObject({ id: "smt", available: false, language: SMT_LANGUAGE });
    expect(out.checkers[0].reason).toContain("needs a container sandbox");
    expect(out.checkers[1]).toEqual({ id: "builtin", available: true, language: BUILTIN_LANGUAGE });
    expect(out.usage).toContain("ProofCheck");
    expect(out.usage).toContain("[n]: proof:<id>");
  });

  test("the builtin instance: grounded floor, builtin then smt, smt unavailable without a sandbox", async () => {
    const prior = process.env["CREWHAUS_SANDBOX"];
    process.env["CREWHAUS_SANDBOX"] = "noop";
    try {
      const out = await list(createProofTools());
      expect(out.floor).toBe("grounded");
      expect(
        out.checkers.map((c: { id: string; available: boolean }) => [c.id, c.available]),
      ).toEqual([
        ["builtin", true],
        ["smt", false],
      ]);
    } finally {
      if (prior === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_SANDBOX");
      else process.env["CREWHAUS_SANDBOX"] = prior;
    }
  });

  test("a lean4 config lists lean4 with its language", async () => {
    const c = config("proven", { formal: { checkers: ["lean4", "builtin"] } });
    const out = await list(
      createProofTools({
        config: c,
        checkers: buildDefaultCheckers(c, {
          sandboxAvailable: false,
          createSandbox: () => z3Sandbox(""),
        }),
      }),
    );
    expect(out.checkers[0]).toMatchObject({ id: "lean4", language: LEAN4_LANGUAGE });
  });

  test("a plugin whose probe hangs or throws does not break the listing", async () => {
    const out = await list(
      createProofTools({
        checkers: [
          createBuiltinChecker(),
          plugin("flaky", async () => {
            throw new Error("down");
          }),
        ],
      }),
    );
    expect(out.checkers[1]).toMatchObject({ id: "flaky", available: false });
    expect(out.checkers[1].reason).toContain("down");
  });
});
