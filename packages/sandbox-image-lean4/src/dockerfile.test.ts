/**
 * The image definition's contract, read from the Dockerfile itself (no
 * Docker needed): the toolchain version the package states is the one the
 * image downloads, every download is pinned per architecture by sha256,
 * every base is pinned by digest, the image carries Init and Std and nothing
 * the lean4 checker's import allowlist refuses, and the stage that ships has
 * no shell, no network tools and no root. The image is BUILT and RUN by the
 * live test in packages/proof-checker (sandbox.live.test.ts) and by the
 * release job.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEAN4_HEALTHCHECK_ARGV, LEAN4_IMAGE_REPO, LEAN4_TOOLCHAIN_VERSION } from "./index";

const PKG = join(import.meta.dir, "..");
const DOCKERFILE = readFileSync(join(PKG, "Dockerfile"), "utf8");

type Instruction = { readonly op: string; readonly args: string };

/** Dockerfile instructions: comments dropped, `\` continuations joined. */
function instructions(text: string): Instruction[] {
  const out: Instruction[] = [];
  let pending = "";
  for (const raw of text.split("\n")) {
    if (pending === "" && /^\s*#/.test(raw)) continue;
    if (pending === "" && raw.trim() === "") continue;
    const continued = /\\\s*$/.test(raw);
    pending += `${raw.replace(/\\\s*$/, "")} `;
    if (continued) continue;
    const m = /^\s*([A-Za-z]+)\s+([\s\S]*)$/.exec(pending.trim());
    if (m !== null) out.push({ op: (m[1] as string).toUpperCase(), args: (m[2] as string).trim() });
    pending = "";
  }
  return out;
}

const ALL = instructions(DOCKERFILE);
const lastFrom = ALL.map((i) => i.op).lastIndexOf("FROM");
const RUNTIME = ALL.slice(lastFrom);
const arg = (name: string): string | undefined =>
  ALL.find((i) => i.op === "ARG" && i.args.startsWith(`${name}=`))?.args.slice(name.length + 1);
const FETCH = ALL.find((i) => i.op === "RUN" && i.args.includes("curl -fsSL"))?.args ?? "";

describe("sandbox-image-lean4 Dockerfile", () => {
  test("downloads the toolchain version the package states", () => {
    expect(arg("LEAN_VERSION")).toBe(LEAN4_TOOLCHAIN_VERSION);
    expect(FETCH).toContain(
      '"https://github.com/leanprover/lean4/releases/download/v${LEAN_VERSION}/${asset}.tar.zst"',
    );
    expect(FETCH).toContain('--version | grep -qF "version ${LEAN_VERSION},"');
  });

  test("each architecture has its own asset and its own sha256, checked before unpacking", () => {
    const amd64 = arg("LEAN_SHA256_AMD64");
    const arm64 = arg("LEAN_SHA256_ARM64");
    expect(amd64).toMatch(/^[0-9a-f]{64}$/);
    expect(arm64).toMatch(/^[0-9a-f]{64}$/);
    expect(amd64).not.toBe(arm64);
    expect(FETCH).toContain(
      'amd64) asset="lean-${LEAN_VERSION}-linux"; sum="$LEAN_SHA256_AMD64" ;;',
    );
    expect(FETCH).toContain(
      'arm64) asset="lean-${LEAN_VERSION}-linux_aarch64"; sum="$LEAN_SHA256_ARM64" ;;',
    );
    expect(FETCH).toMatch(/\*\) echo "unsupported TARGETARCH[^"]*" >&2; exit 1 ;;/);
    expect(FETCH.indexOf("sha256sum -c")).toBeGreaterThan(FETCH.indexOf("curl -fsSL"));
    expect(FETCH.indexOf("tar --zstd")).toBeGreaterThan(FETCH.indexOf("sha256sum -c"));
    expect(ALL.some((i) => i.op === "ARG" && i.args === "TARGETARCH")).toBe(true);
  });

  test("only lean, cadical, their shared libraries and the Init and Std modules are unpacked", () => {
    const tar =
      /tar --zstd -xf \S+ -C \S+ --strip-components=1 (.*?);\s+rm /.exec(FETCH)?.[1] ?? "";
    const members = [...tar.matchAll(/"\$\{asset\}\/([^"]+)"/g)].map((m) => m[1]);
    expect(members).toEqual([
      "bin/lean",
      // Std's bv_decide runs the bundled SAT solver from beside `lean`, and it
      // links the toolchain's own C++ runtime from lib/ (RUNPATH $ORIGIN/../lib).
      // Without them every bv_decide goal that needs SAT fails (W3-B review).
      "bin/cadical",
      "lib/libc++.so.1*",
      "lib/libc++abi.so.1*",
      "lib/libunwind.so.1*",
      "lib/libatomic.so.1*",
      "lib/lean/libInit_shared.so",
      "lib/lean/libleanshared*.so",
      "lib/lean/Init.*",
      "lib/lean/Init/*",
      "lib/lean/Std.*",
      "lib/lean/Std/*",
      "LICENSE",
      "LICENSES",
    ]);
    // Editor indexes are not needed to elaborate.
    expect(tar).toContain("--exclude='*.ilean'");
    // Mathlib-free, and no Lean/Lake modules: the pre-scan refuses those imports.
    expect(DOCKERFILE).not.toMatch(/lib\/lean\/(Lean|Lake|Mathlib)\b/);
    // No compiler: the bundled clang/lld and LLVM stay out.
    expect(members.filter((m) => /clang|lld|LLVM|leanc|lake/i.test(m ?? ""))).toEqual([]);
  });

  test("the pruned tree is elaborated once at build time, importing Std", () => {
    expect(FETCH).toContain("'import Std'");
    // bv_decide on a goal its preprocessing cannot close: cadical must run.
    expect(FETCH).toContain(
      "'theorem smoke_sat : ∀ x y : BitVec 8, x * y = y * x := by intro x y; bv_decide'",
    );
    expect(FETCH).toContain(`grep -qF "'smoke_sat' depends on axioms" /tmp/smoke.json`);
    expect(FETCH).toContain("| /out/usr/local/bin/lean --stdin --json > /tmp/smoke.json");
    expect(FETCH).toContain(`grep -qF "'smoke' depends on axioms" /tmp/smoke.json`);
    expect(FETCH).toContain(`if grep -qF '"severity":"error"' /tmp/smoke.json; then`);
  });

  test("every base image is pinned by digest", () => {
    const froms = ALL.filter((i) => i.op === "FROM");
    expect(froms).toHaveLength(2);
    for (const from of froms) expect(from.args).toMatch(/^\S+:\S+@sha256:[0-9a-f]{64}( AS \w+)?$/);
  });

  test("the shipped stage is distroless, non-root, and runs nothing at build time", () => {
    expect(RUNTIME[0]?.args).toMatch(/^gcr\.io\/distroless\/cc-debian\d+:nonroot@/);
    expect(RUNTIME.filter((i) => i.op === "RUN")).toEqual([]);
    expect(RUNTIME.find((i) => i.op === "USER")?.args).toBe("65532:65532");
    const copies = RUNTIME.filter((i) => i.op === "COPY" || i.op === "ADD");
    expect(copies).toEqual([{ op: "COPY", args: "--from=fetch /out/ /" }]);
    // lean finds its modules at bin/../lib/lean, so the toolchain keeps that layout.
    expect(FETCH).toContain("-C /out/usr/local --strip-components=1");
    expect(RUNTIME.find((i) => i.op === "LABEL")?.args).toContain(
      'org.opencontainers.image.source="https://github.com/crewhaus/factory"',
    );
  });

  test("the healthcheck and the default command are the registry's healthcheck argv", () => {
    const argv = JSON.stringify(LEAN4_HEALTHCHECK_ARGV).replace(/,/g, ", ");
    expect(RUNTIME.find((i) => i.op === "HEALTHCHECK")?.args).toMatch(
      new RegExp(`CMD ${argv.replace(/[[\]]/g, "\\$&")}$`),
    );
    expect(RUNTIME.find((i) => i.op === "CMD")?.args).toBe(argv);
  });

  test("the build context is empty", () => {
    const ignore = readFileSync(join(PKG, ".dockerignore"), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.startsWith("#"));
    expect(ignore).toEqual(["*"]);
  });

  test("the header names where the release pushes it", () => {
    expect(DOCKERFILE).toContain(`${LEAN4_IMAGE_REPO}:<version>`);
  });
});
