/**
 * The `smt` and `lean4` checkers against the REAL images, through a real
 * `@crewhaus/sandbox` docker backend (design §6.4, §14 PR 8): the argv, the
 * stdin, the output parsing, `#print axioms` capture and the sandbox posture
 * (network none, read-only root, a /tmp tmpfs, non-root, 512 MB) exactly as a
 * harness runs them. Everything else in this package is tested against a
 * scripted sandbox; this file is where the scripts are held to what Z3 and
 * Lean actually print.
 *
 * Gated, like the sandbox-image packages' live probes:
 *
 *     bun scripts/build-sandbox-images.ts            # from the repo root, once
 *     CREWHAUS_SECTION36_LIVE_DOCKER=1 bun test src/sandbox.live.test.ts
 *
 * It never pulls: an image that is not in the local daemon fails the run with
 * the command that builds it (a pull of an unreleased tag would only 404, and
 * a pull of a released one would test the registry's copy, not this tree's
 * Dockerfile).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Sandbox, createSandbox } from "@crewhaus/sandbox";
import {
  LEAN4_HEALTHCHECK_ARGV,
  LEAN4_IMAGE_REF,
  LEAN4_TOOLCHAIN_VERSION,
} from "@crewhaus/sandbox-image-lean4";
import { Z3_HEALTHCHECK_ARGV, Z3_IMAGE_REF, Z3_SOLVER_VERSION } from "@crewhaus/sandbox-image-z3";
import { createLean4Checker } from "./lean4";
import { checkerImages, createDefaultCheckers } from "./registry";
import { SMT_NAME_PATTERN, createSmtChecker, isReservedSmtName } from "./smt";
import type { CheckResult, SandboxLike } from "./types";

const LIVE = process.env["CREWHAUS_SECTION36_LIVE_DOCKER"] === "1";
/** A cold container start plus Lean importing Init is ~0.5 s here; CI runners are slower. */
const CHECK_MS = 60_000;
const TEST_MS = 120_000;

function docker(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  return { exitCode: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function requireLocalImage(ref: string): void {
  if (docker(["image", "inspect", ref]).exitCode !== 0) {
    throw new Error(
      `${ref} is not in the local docker daemon; build it with \`bun scripts/build-sandbox-images.ts\` from the repo root (this test never pulls)`,
    );
  }
}

/** A sandbox that counts its execs, so a test can tell a pre-scan refusal from a checker run. */
function counting(inner: Sandbox): SandboxLike & { execs: number } {
  const wrapped = {
    backend: inner.backend,
    execs: 0,
    exec(opts: Parameters<SandboxLike["exec"]>[0]) {
      wrapped.execs += 1;
      return inner.exec(opts);
    },
  };
  return wrapped;
}

describe.skipIf(!LIVE)("the sandbox checkers against the real images (live docker)", () => {
  // The allowlist a harness gives its proof sandbox: exactly the images its
  // checkers run (tool-proof's `sandboxImages`, i.e. `checkerImages`).
  let sandbox: Sandbox;
  const overrideRef = `crewhaus-live/sandbox-lean4-override:${randomBytes(4).toString("hex")}`;

  beforeAll(() => {
    requireLocalImage(Z3_IMAGE_REF);
    requireLocalImage(LEAN4_IMAGE_REF);
    sandbox = createSandbox({
      backend: "docker",
      allowedImages: [Z3_IMAGE_REF, LEAN4_IMAGE_REF],
    });
  });
  afterAll(async () => {
    await sandbox?.close();
    docker(["image", "rm", overrideRef]);
  });

  describe("the images themselves", () => {
    test(
      "the registered healthchecks pass and report the pinned versions",
      async () => {
        const z3 = await sandbox.exec({ image: Z3_IMAGE_REF, argv: [...Z3_HEALTHCHECK_ARGV] });
        expect(z3.exitCode).toBe(0);
        expect(z3.stdout).toContain(`Z3 version ${Z3_SOLVER_VERSION} `);
        const lean = await sandbox.exec({
          image: LEAN4_IMAGE_REF,
          argv: [...LEAN4_HEALTHCHECK_ARGV],
        });
        expect(lean.exitCode).toBe(0);
        expect(lean.stdout).toContain(`version ${LEAN4_TOOLCHAIN_VERSION},`);
      },
      TEST_MS,
    );

    test(
      "both run as uid 65532 and carry no shell",
      async () => {
        for (const ref of [Z3_IMAGE_REF, LEAN4_IMAGE_REF]) {
          const user = docker(["image", "inspect", "--format", "{{.Config.User}}", ref]);
          expect(user.stdout.trim()).toBe("65532:65532");
          const shell = await sandbox.exec({ image: ref, argv: ["sh", "-c", "true"] });
          expect(shell.exitCode).not.toBe(0);
        }
      },
      TEST_MS,
    );
  });

  describe("smt — Z3 in the sandbox", () => {
    const checker = () => createSmtChecker({ sandbox, timeoutMs: CHECK_MS });
    const run = (statement: string, proof: string): Promise<CheckResult> =>
      checker().check({ claim: "c", statement, proof });

    test(
      "available() passes the image's healthcheck",
      async () => {
        expect(await checker().available()).toEqual({ ok: true });
      },
      TEST_MS,
    );

    test(
      "proves a goal whose negation is unsat, listing the hypotheses",
      async () => {
        const r = await run(
          "(<= (+ x y) 10)",
          "(declare-const x Int) (declare-const y Int) (assert (<= x 4)) (assert (<= y 6))",
        );
        expect(r.reason).toBeUndefined();
        expect(r).toMatchObject({ ok: true, checker: "smt", axioms: [] });
        expect(r.assumptions).toEqual(["(<= x 4)", "(<= y 6)"]);
      },
      TEST_MS,
    );

    test(
      "rejects a false goal with a counterexample that really refutes it",
      async () => {
        const r = await run(
          "(<= (+ x y) 9)",
          "(declare-const x Int) (declare-const y Int) (assert (<= x 4)) (assert (<= y 6))",
        );
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/^the goal does not follow: z3 found a counterexample/);
        const m = /^x = (-?\d+), y = (-?\d+)$/.exec(r.counterexample ?? "");
        expect(m).not.toBeNull();
        const [x, y] = [Number(m?.[1]), Number(m?.[2])];
        expect(x <= 4 && y <= 6 && x + y > 9).toBe(true);
      },
      TEST_MS,
    );

    test(
      "rejects inconsistent hypotheses (they would prove anything)",
      async () => {
        const r = await run("(> x 100)", "(declare-const x Int) (assert (< x 0)) (assert (> x 5))");
        expect(r.ok).toBe(false);
        expect(r.reason).toBe("the hypotheses are inconsistent; anything follows from them");
      },
      TEST_MS,
    );

    test(
      "reports Z3's own errors",
      async () => {
        const r = await run("(> x 1)", "(declare-const x Int) (assert (< y 0))");
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/^z3 reported an error: .*unknown constant y/);
      },
      TEST_MS,
    );

    test(
      "non-linear reals, bit-vectors, datatypes and quantifiers",
      async () => {
        for (const [goal, pre] of [
          ["(> (* x x) 0.0)", "(declare-const x Real) (assert (> x 0.5))"],
          [
            "(= (bvadd a b) (bvadd b a))",
            "(declare-const a (_ BitVec 8)) (declare-const b (_ BitVec 8))",
          ],
          [
            "(or (= c red) (= c green))",
            "(declare-datatypes ((Color 0)) (((red) (green)))) (declare-const c Color)",
          ],
          ["(forall ((n Int)) (=> (> n 0) (>= (* 2 n) 2)))", "(set-logic ALL)"],
        ] as const) {
          const r = await run(goal, pre);
          expect({ goal, ok: r.ok, reason: r.reason }).toEqual({
            goal,
            ok: true,
            reason: undefined,
          });
        }
      },
      TEST_MS,
    );

    test(
      "a goal Z3 cannot decide within its budget is rejected, never passed",
      async () => {
        // x³ + y³ = z³ has no positive solution (Fermat, n = 3), and Z3 cannot
        // show it: it answers unknown when the solver timeout runs out.
        const r = await createSmtChecker({ sandbox, timeoutMs: 6_000 }).check({
          claim: "c",
          statement: "(not (= (+ (* x x x) (* y y y)) (* z z z)))",
          proof:
            "(declare-const x Int) (declare-const y Int) (declare-const z Int) (assert (> x 0)) (assert (> y 0)) (assert (> z 0))",
        });
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/could not decide the goal|did not finish/);
      },
      TEST_MS,
    );

    test(
      "the reserved names the adapter adds for this Z3 are real built-ins it would let a preamble redefine",
      async () => {
        // What the refusal prevents, shown on the image's own solver: each
        // redefinition below turns a false goal into an unsat negation.
        for (const [name, pre, goal] of [
          [
            "ubv_to_int",
            "(define-fun ubv_to_int ((v (_ BitVec 2))) Int 7)",
            "(= (ubv_to_int #b11) 7)",
          ],
          ["equals", "(define-fun equals ((a Int) (b Int)) Bool true)", "(equals 1 2)"],
          // The built-in (List T)'s constructor, at a signature of its own.
          ["insert", "(define-fun insert ((a Int) (b Int)) Int b)", "(= (insert 1 2) 2)"],
          ["nil", "(define-fun nil () Int 5)", "(= nil 5)"],
        ] as const) {
          const raw = await sandbox.exec({
            image: Z3_IMAGE_REF,
            argv: ["z3", "-in"],
            stdin: `${pre}\n(assert (not ${goal}))\n(check-sat)\n`,
            timeoutMs: CHECK_MS,
          });
          expect({ name, out: raw.stdout.trim() }).toEqual({ name, out: "unsat" });
          const r = await run(goal, pre);
          expect(r.ok).toBe(false);
          expect(r.reason).toContain(`may not declare \`${name}\``);
        }
      },
      TEST_MS,
    );

    // The reserved list must cover every alphanumeric name THIS solver
    // resolves without a declaration — a redefined built-in can make a false
    // goal look proven. So: every identifier-shaped string in the image's z3
    // binary, applied to a few argument shapes (`(simplify name)` alone misses
    // functions like `equals`), and any that Z3 does not call unknown must be
    // reserved. A Z3 bump that adds a built-in fails here, naming it. Z3's
    // built-in `(List T)` brings `insert` / `nil` / `head` / `tail` into scope
    // only once a list sort is mentioned, and they take list arguments, so the
    // script declares a `(List Int)` and applies every name to it too (the
    // Int/Bool/BitVec shapes alone missed `insert` and `nil` — W3-B review).
    // An error that names the name's other signature (`declared: …`, a second
    // line) counts as resolved. Known built-ins ride along as controls: if the
    // probe stops seeing them, it has gone blind, and that fails too.
    test("every alphanumeric built-in of the image's Z3 is on the reserved list", async () => {
      const dir = mkdtempSync(join(tmpdir(), "crewhaus-z3-probe-"));
      const name = `crewhaus-z3-probe-${randomBytes(6).toString("hex")}`;
      try {
        expect(docker(["create", "--name", name, Z3_IMAGE_REF]).exitCode).toBe(0);
        const cp = docker(["cp", `${name}:/usr/local/bin/z3`, join(dir, "z3")]);
        expect(cp.exitCode).toBe(0);
        const binary = readFileSync(join(dir, "z3")).toString("latin1");
        const candidates = [...new Set(binary.match(/[A-Za-z][A-Za-z0-9_]{0,30}/g) ?? [])].filter(
          (n) => SMT_NAME_PATTERN.test(n) && !isReservedSmtName(n),
        );
        expect(candidates.length).toBeGreaterThan(10_000);
        // One per shape that alone finds it (bare, Int, Bool, BitVec, indexed, List).
        const controls = ["nil", "abs", "and", "bvadd", "extract", "insert", "head", "equals"];
        for (const c of controls) expect(isReservedSmtName(c)).toBe(true);
        // A quoted name with a space: no binary string can collide with it.
        const list = "|crewhaus probe list|";
        const forms = (n: string): string[] => [
          n,
          `(${n} 1)`,
          `(${n} 1 1)`,
          `(${n} true true)`,
          `(${n} true 1 1)`,
          `(${n} #b1)`,
          `(${n} #b1 #b1)`,
          `((_ ${n} 1) 1)`,
          `(${n} ${list})`,
          `(${n} 1 ${list})`,
          `(as ${n} (List Int))`,
        ];
        const script = [
          "(set-option :print-success false)",
          `(declare-const ${list} (List Int))`,
          ...[...controls, ...candidates].flatMap((n) => [
            `(echo "@@${n}")`,
            ...forms(n).map((f) => `(simplify ${f})`),
          ]),
          "(exit)",
        ].join("\n");
        const r = await sandbox.exec({
          image: Z3_IMAGE_REF,
          argv: ["z3", "-in"],
          stdin: script,
          timeoutMs: 600_000,
          maxOutputBytes: 256 * 1024 * 1024,
        });
        expect(r.timedOut).toBe(false);
        expect(r.stdoutDroppedBytes ?? 0).toBe(0);
        const unknown =
          /unknown constant|unknown function|unknown indexed|invalid indexed identifier|unexpected character/;
        const resolved = new Set<string>();
        let current: string | undefined;
        let seen = 0;
        for (const line of r.stdout.split("\n")) {
          if (line.startsWith("@@")) {
            current = line.slice(2);
            seen += 1;
          } else if (current !== undefined && line.trim() !== "" && !unknown.test(line)) {
            resolved.add(current);
          }
        }
        expect(seen).toBe(controls.length + candidates.length);
        expect(controls.filter((c) => !resolved.has(c))).toEqual([]);
        expect(candidates.filter((c) => resolved.has(c)).sort()).toEqual([]);
      } finally {
        docker(["rm", "-f", name]);
        rmSync(dir, { recursive: true, force: true });
      }
    }, 900_000);
  });

  describe("lean4 — Lean 4 in the sandbox", () => {
    const checker = (extra: Partial<Parameters<typeof createLean4Checker>[0]> = {}) =>
      createLean4Checker({ sandbox, timeoutMs: CHECK_MS, ...extra });
    const run = (
      statement: string,
      proof: string,
      extra: Partial<Parameters<typeof createLean4Checker>[0]> = {},
    ): Promise<CheckResult> => checker(extra).check({ claim: "c", statement, proof });

    test(
      "available() passes the image's healthcheck",
      async () => {
        expect(await checker().available()).toEqual({ ok: true });
      },
      TEST_MS,
    );

    test(
      "proves 2 + 2 = 4 by decide and by rfl, depending on no axioms",
      async () => {
        for (const proof of ["by decide", "rfl"]) {
          const r = await run("2 + 2 = 4", proof);
          expect({ proof, ok: r.ok, reason: r.reason }).toEqual({
            proof,
            ok: true,
            reason: undefined,
          });
          expect(r.axioms).toEqual([]);
          expect(r.output).toContain("'crewhaus_claim' does not depend on any axioms");
        }
      },
      TEST_MS,
    );

    test(
      "proves ∀ n : Nat, n + 0 = n by simp (propext is standard, not recorded)",
      async () => {
        const r = await run("∀ n : Nat, n + 0 = n", "by\n  intro n\n  simp");
        expect(r.reason).toBeUndefined();
        expect(r).toMatchObject({ ok: true, checker: "lean4", assumptions: [], axioms: [] });
        expect(r.output).toContain("depends on axioms: [propext]");
      },
      TEST_MS,
    );

    test(
      "a proof importing Std elaborates inside the 512 MB default",
      async () => {
        const r = await run("∀ x y : Nat, x < y → x + 1 ≤ y", "import Std\nby intro x y h; omega");
        expect(r.reason).toBeUndefined();
        expect(r.ok).toBe(true);
      },
      TEST_MS,
    );

    test(
      "a false theorem is rejected with Lean's own message",
      async () => {
        const r = await run("2 + 2 = 5", "by decide");
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(
          /^lean rejected the proof: Tactic `decide` proved that the proposition/,
        );
      },
      TEST_MS,
    );

    test(
      "sorry is refused before Lean runs; with the forbid list emptied, sorryAx still rejects it",
      async () => {
        const spy = counting(sandbox);
        const pre = await createLean4Checker({ sandbox: spy, timeoutMs: CHECK_MS }).check({
          claim: "c",
          statement: "2 + 2 = 5",
          proof: "by sorry",
        });
        expect(pre.ok).toBe(false);
        expect(pre.reason).toBe("the proof uses `sorry`, which this harness forbids");
        expect(spy.execs).toBe(0);
        const backstop = await run("2 + 2 = 5", "by sorry", { forbid: [] });
        expect(backstop.ok).toBe(false);
        expect(backstop.reason).toBe(
          "the proof depends on `sorryAx` (a sorry), so it proves nothing",
        );
      },
      TEST_MS,
    );

    test(
      "Classical.choice is captured from #print axioms (one of the standard three, design §6.4)",
      async () => {
        const r = await run("∀ p : Prop, p ∨ ¬p", "fun p => Classical.em p");
        expect(r.reason).toBeUndefined();
        expect(r.ok).toBe(true);
        expect(r.output).toContain("depends on axioms: [propext, Classical.choice, Quot.sound]");
        expect(r.axioms).toEqual([]);
      },
      TEST_MS,
    );

    test(
      "compiler trust: `decide +native` is refused while native_decide is forbidden, and its axiom is recorded when it is not",
      async () => {
        // Lean 4.34 leaves `<decl>._native.<tactic>.ax_i_j`, not
        // `Lean.ofReduceBool`, and `decide +native` never spells
        // `native_decide` — the axioms check is what catches it.
        const refused = await run("(10 : Nat) < 100", "by decide +native");
        expect(refused.ok).toBe(false);
        expect(refused.reason).toMatch(
          /^the proof trusts the compiler \(crewhaus_claim\._native\.decide\.ax_\d+_\d+/,
        );
        const recorded = await run("(10 : Nat) < 100", "by native_decide", {
          forbid: ["sorry", "axiom"],
        });
        expect(recorded.reason).toBeUndefined();
        expect(recorded.ok).toBe(true);
        expect(recorded.axioms).toHaveLength(1);
        expect(recorded.axioms[0]).toMatch(/^crewhaus_claim\._native\.native_decide\.ax_\d+_\d+$/);
      },
      TEST_MS,
    );

    test(
      "bv_decide runs the image's cadical in the sandbox, and its proof is compiler trust like native_decide",
      async () => {
        // A goal bv_decide's preprocessing cannot close, so the SAT solver
        // runs: on the read-only root, writing its CNF and LRAT files to the
        // /tmp tmpfs. The image once shipped without cadical, and this failed
        // with "could not execute external process 'cadical'" (W3-B review).
        const statement = "∀ x y : BitVec 8, x * y = y * x";
        const proof = "import Std.Tactic.BVDecide\nby intro x y; bv_decide";
        const refused = await run(statement, proof);
        expect(refused.ok).toBe(false);
        expect(refused.reason).toMatch(
          /^the proof trusts the compiler \(crewhaus_claim\._native\.bv_decide\.ax_\d+_\d+/,
        );
        const recorded = await run(statement, proof, { forbid: ["sorry", "axiom"] });
        expect(recorded.reason).toBeUndefined();
        expect(recorded.ok).toBe(true);
        expect(recorded.axioms).toHaveLength(1);
        expect(recorded.axioms[0]).toMatch(/^crewhaus_claim\._native\.bv_decide\.ax_\d+_\d+$/);
      },
      TEST_MS,
    );

    test(
      "an import outside Init/Std is refused before Lean runs",
      async () => {
        const spy = counting(sandbox);
        const r = await createLean4Checker({ sandbox: spy, timeoutMs: CHECK_MS }).check({
          claim: "c",
          statement: "True",
          proof: "import Lean\ntrivial",
        });
        expect(r.reason).toMatch(/`import Lean` is not allowed/);
        expect(spy.execs).toBe(0);
      },
      TEST_MS,
    );

    test(
      "formal.image: an overriding image on the allowlist runs; one off it is refused",
      async () => {
        expect(docker(["tag", LEAN4_IMAGE_REF, overrideRef]).exitCode).toBe(0);
        const checkers = createDefaultCheckers({
          ids: ["builtin", "smt", "lean4"],
          images: { lean4: overrideRef },
          timeoutMs: CHECK_MS,
          sandbox: createSandbox({ backend: "docker", allowedImages: [Z3_IMAGE_REF, overrideRef] }),
        });
        expect(checkerImages(checkers)).toEqual([Z3_IMAGE_REF, overrideRef]);
        const lean4 = checkers.find((c) => c.id === "lean4");
        expect(await lean4?.available()).toEqual({ ok: true });
        const ok = await lean4?.check({ claim: "c", statement: "2 + 2 = 4", proof: "by decide" });
        expect(ok?.ok).toBe(true);
        // The override admits Mathlib imports (only a Mathlib image can load
        // them); this one has none, and Lean says so.
        const mathlib = await lean4?.check({
          claim: "c",
          statement: "True",
          proof: "import Mathlib.Logic.Basic\ntrivial",
        });
        expect(mathlib?.ok).toBe(false);
        expect(mathlib?.reason).toMatch(
          /^lean rejected the proof: unknown module prefix 'Mathlib'/,
        );

        const offList = createLean4Checker({
          sandbox: createSandbox({ backend: "docker", allowedImages: [LEAN4_IMAGE_REF] }),
          image: overrideRef,
          timeoutMs: CHECK_MS,
        });
        const avail = await offList.available();
        expect(avail.ok).toBe(false);
        expect(avail.reason).toMatch(/not on the allowlist/);
        const refused = await offList.check({
          claim: "c",
          statement: "2 + 2 = 4",
          proof: "by decide",
        });
        expect(refused.ok).toBe(false);
        expect(refused.reason).toMatch(/^the sandbox could not run lean: .*not on the allowlist/);
      },
      TEST_MS,
    );
  });
});
