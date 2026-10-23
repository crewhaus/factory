/**
 * The image definition's contract, read from the Dockerfile itself (no
 * Docker needed): the solver version the package states is the one the image
 * downloads, every download is pinned per architecture by sha256, every base
 * is pinned by digest, and the stage that ships has no shell, no network
 * tools and no root. The image is BUILT and RUN by the live test in
 * packages/proof-checker (sandbox.live.test.ts) and by the release job.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Z3_HEALTHCHECK_ARGV, Z3_IMAGE_REPO, Z3_SOLVER_VERSION } from "./index";

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

describe("sandbox-image-z3 Dockerfile", () => {
  test("downloads the solver version the package states", () => {
    expect(arg("Z3_VERSION")).toBe(Z3_SOLVER_VERSION);
    expect(DOCKERFILE).toContain(
      "https://github.com/Z3Prover/z3/releases/download/z3-${Z3_VERSION}/${asset}.zip",
    );
  });

  test("each architecture has its own asset and its own sha256, checked before unpacking", () => {
    const amd64 = arg("Z3_SHA256_AMD64");
    const arm64 = arg("Z3_SHA256_ARM64");
    expect(amd64).toMatch(/^[0-9a-f]{64}$/);
    expect(arm64).toMatch(/^[0-9a-f]{64}$/);
    expect(amd64).not.toBe(arm64);
    expect(DOCKERFILE).toMatch(
      /amd64\) asset="z3-\$\{Z3_VERSION\}-x64-glibc-[\d.]+"; sum="\$Z3_SHA256_AMD64"/,
    );
    expect(DOCKERFILE).toMatch(
      /arm64\) asset="z3-\$\{Z3_VERSION\}-arm64-glibc-[\d.]+"; sum="\$Z3_SHA256_ARM64"/,
    );
    // Any other architecture (or the legacy builder's empty TARGETARCH) fails the build.
    expect(DOCKERFILE).toMatch(/\*\) echo "unsupported TARGETARCH[^"]*" >&2; exit 1 ;;/);
    const fetch = ALL.find((i) => i.op === "RUN" && i.args.includes("curl -fsSL"))?.args ?? "";
    expect(fetch.indexOf("sha256sum -c")).toBeGreaterThan(fetch.indexOf("curl -fsSL"));
    expect(fetch.indexOf("unzip")).toBeGreaterThan(fetch.indexOf("sha256sum -c"));
    expect(fetch).toContain('--version | grep -qF "Z3 version ${Z3_VERSION} "');
    expect(ALL.some((i) => i.op === "ARG" && i.args === "TARGETARCH")).toBe(true);
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
    // Only the fetched binary and its licence come in — never the build context.
    const copies = RUNTIME.filter((i) => i.op === "COPY" || i.op === "ADD");
    expect(copies).toEqual([{ op: "COPY", args: "--from=fetch /out/ /" }]);
    expect(DOCKERFILE).toContain(
      'install -D -m 0755 "/tmp/z3/${asset}/bin/z3" /out/usr/local/bin/z3',
    );
    expect(RUNTIME.find((i) => i.op === "LABEL")?.args).toContain(
      'org.opencontainers.image.source="https://github.com/crewhaus/factory"',
    );
  });

  test("the healthcheck and the default command are the registry's healthcheck argv", () => {
    const argv = JSON.stringify(Z3_HEALTHCHECK_ARGV).replace(/,/g, ", ");
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
    expect(DOCKERFILE).toContain(`${Z3_IMAGE_REPO}:<version>`);
  });
});
