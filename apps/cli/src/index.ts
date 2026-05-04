#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { compile, SpecParseError } from "@crewhaus/compiler";

/**
 * crewhaus — slice-scope CLI.
 * Subcommands:
 *   compile <spec.yaml> -o <out-dir>    parse → IR → emit bundle to disk
 *
 * Future (per catalog F4 spec-cli): init, deploy, eval, run, watch, doctor.
 */

type ParsedArgs = {
  subcommand: string;
  positional: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const [subcommand = "", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) break;
    if (arg === "-o" || arg === "--out") {
      const next = rest[i + 1];
      if (next === undefined) {
        die(`flag "${arg}" requires a value`);
      }
      flags["out"] = next;
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      flags["help"] = true;
    } else if (arg.startsWith("-")) {
      die(`unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return { subcommand, positional, flags };
}

function usage(): never {
  process.stderr.write(
    [
      "usage: crewhaus <subcommand> [args]",
      "",
      "subcommands:",
      "  compile <spec.yaml> -o <out-dir>    compile a spec to a runnable bundle",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function die(message: string): never {
  process.stderr.write(`crewhaus: ${message}\n`);
  process.exit(1);
}

function runCompile(args: ParsedArgs): void {
  if (args.flags["help"]) {
    process.stdout.write("usage: crewhaus compile <spec.yaml> -o <out-dir>\n");
    return;
  }
  const specPath = args.positional[0];
  const outDir = args.flags["out"];
  if (typeof specPath !== "string") die("missing <spec.yaml>");
  if (typeof outDir !== "string") die("missing -o <out-dir>");

  const absSpec = resolve(specPath);
  const absOut = resolve(outDir);

  let yamlText: string;
  try {
    yamlText = readFileSync(absSpec, "utf-8");
  } catch (err) {
    die(`could not read ${absSpec}: ${(err as Error).message}`);
  }

  let bundle: ReturnType<typeof compile>;
  try {
    bundle = compile(yamlText);
  } catch (err) {
    if (err instanceof SpecParseError) {
      die(err.message);
    }
    throw err;
  }

  mkdirSync(absOut, { recursive: true });
  for (const file of bundle.files) {
    const fullPath = join(absOut, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content);
    process.stdout.write(`wrote ${fullPath}\n`);
  }
  process.stdout.write(`compiled bundle (${bundle.files.length} file(s)) → ${absOut}\n`);
}

const args = parseArgs(process.argv.slice(2));
switch (args.subcommand) {
  case "compile":
    runCompile(args);
    break;
  case "":
  case "-h":
  case "--help":
    usage();
  default:
    die(`unknown subcommand: ${args.subcommand}`);
}
