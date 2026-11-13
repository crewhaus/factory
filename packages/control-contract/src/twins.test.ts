import { describe, expect, test } from "bun:test";
import {
  COMMAND_KINDS,
  type CliTwin,
  DEPLOYMENT_ID_RE,
  OPERATIONS,
  OPERATOR_SUPERSEDE_REASONS,
  TWIN_PLACEHOLDERS,
  isId,
  mintId,
  parseTwin,
  renderTwin,
} from "./index.js";

const HRN = "hrn_0123456789abcdef";
const APPR = "appr_0123456789abcdef";
const SHOW: CliTwin = { argv: ["approvals", "show", "{appr}", "--dir", "{dir}"] };
const CHOICE: CliTwin = { argv: ["approvals", "{choice}", "{appr}", "--dir", "{dir}"] };
const HARNESS: CliTwin = { argv: ["harness", "show", "{hrn}"] };

const DEP = "dep_01m76e6f05hp514w9j4v3qymka";
const PEOPLE = { psn: mintId("psn"), pcl: mintId("pcl"), kind: "personal", area: "communication" };

const RULE_ID = mintId("rule");

const SAMPLES = [
  {
    hrn: HRN,
    appr: APPR,
    dir: "/srv/poly",
    choice: "grant",
    dep: DEP,
    ...PEOPLE,
    verdict: "keep",
    supersedeReason: "decided-in-error",
    rule: RULE_ID,
  },
  {
    hrn: HRN,
    appr: APPR,
    dir: "/srv/poly",
    choice: "deny",
    dep: DEP,
    ...PEOPLE,
    verdict: "reject",
    supersedeReason: "other",
    rule: RULE_ID,
  },
];

const TWINS: readonly CliTwin[] = [
  ...OPERATIONS.flatMap((op) => (op.cliTwin === null ? [] : [op.cliTwin])),
  ...Object.values(COMMAND_KINDS).flatMap((kind) => (kind.cliTwin === null ? [] : [kind.cliTwin])),
];

describe("round trips", () => {
  test("every non-null twin renders and parses back", () => {
    let checked = 0;
    for (const twin of TWINS) {
      for (const sample of SAMPLES) {
        const rendered = renderTwin(twin, sample);
        if (!("argv" in rendered)) throw new Error(JSON.stringify(rendered));
        const parsed = parseTwin(twin, rendered.argv);
        expect(parsed).not.toBeNull();
        for (const [name, value] of Object.entries(parsed?.params ?? {})) {
          expect(value).toBe((sample as Record<string, string>)[name] as string);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2 * 13);
  });

  test("flag pairs parse in any order", () => {
    expect(parseTwin(SHOW, ["approvals", "show", "--dir", "/srv/poly", APPR])).toEqual({
      params: { appr: APPR, dir: "/srv/poly" },
    });
    expect(parseTwin(SHOW, ["--dir", "/srv/poly", "approvals", "show", APPR])).toEqual({
      params: { appr: APPR, dir: "/srv/poly" },
    });
  });

  test("{choice} in the verb slot takes grant and deny, nothing else", () => {
    expect(parseTwin(CHOICE, ["approvals", "grant", APPR, "--dir", "d"])?.params["choice"]).toBe(
      "grant",
    );
    expect(parseTwin(CHOICE, ["approvals", "deny", APPR, "--dir", "d"])?.params["choice"]).toBe(
      "deny",
    );
    expect(parseTwin(CHOICE, ["approvals", "show", APPR, "--dir", "d"])).toBeNull();
  });
});

describe("renderTwin", () => {
  test("names what is missing", () => {
    expect(renderTwin(SHOW, { appr: APPR })).toEqual({ missing: ["dir"] });
    expect(renderTwin(HARNESS, {})).toEqual({ missing: ["hrn"] });
  });
  test("missing wins over invalid", () => {
    expect(renderTwin(SHOW, { appr: "nope" })).toEqual({ missing: ["dir"] });
  });
  test("names what is invalid", () => {
    expect(renderTwin(SHOW, { appr: "nope", dir: "/x" })).toEqual({ invalid: ["appr"] });
    // A slug is never a twin's harness.
    expect(renderTwin(HARNESS, { hrn: "support" })).toEqual({ invalid: ["hrn"] });
  });
  test("{dir} refuses what a shell or a parser would misread", () => {
    for (const dir of ["", "--force", "-x", "a\nb", "a\u0000b", "a\tb"]) {
      expect(renderTwin(SHOW, { appr: APPR, dir })).toEqual({ invalid: ["dir"] });
    }
    expect(renderTwin(SHOW, { appr: APPR, dir: "/srv/my harnesses/a-b" })).toEqual({
      argv: ["approvals", "show", APPR, "--dir", "/srv/my harnesses/a-b"],
    });
  });
  test("it never throws on bad input", () => {
    expect(renderTwin(null as never, {})).toEqual({ invalid: ["twin"] });
    expect(renderTwin(HARNESS, null as never)).toEqual({ missing: ["hrn"] });
    expect(renderTwin(HARNESS, { hrn: 7 as never })).toEqual({ invalid: ["hrn"] });
    expect(renderTwin(HARNESS, { constructor: "x" } as never)).toEqual({ missing: ["hrn"] });
  });
});

describe("parseTwin refuses", () => {
  const cases: readonly (readonly [string, CliTwin, readonly string[]])[] = [
    ["a missing positional", HARNESS, ["harness", "show"]],
    ["a missing flag", SHOW, ["approvals", "show", APPR]],
    ["a flag with no value", SHOW, ["approvals", "show", APPR, "--dir"]],
    ["an invalid value", HARNESS, ["harness", "show", "support"]],
    ["an unknown flag", SHOW, ["approvals", "show", APPR, "--dir", "/d", "--by", "sam"]],
    ["a repeated flag", SHOW, ["approvals", "show", APPR, "--dir", "/d", "--dir", "/e"]],
    ["an extra positional", HARNESS, ["harness", "show", HRN, "more"]],
    ["a wrong literal", HARNESS, ["harness", "list", HRN]],
    ["a {dir} of --force", SHOW, ["approvals", "show", APPR, "--dir", "--force"]],
    ["a {dir} of -x", SHOW, ["approvals", "show", APPR, "--dir", "-x"]],
    ["a joined flag", SHOW, ["approvals", "show", APPR, "--dir=/d"]],
    ["an empty line", HARNESS, []],
  ];
  for (const [name, twin, argv] of cases) {
    test(name, () => expect(parseTwin(twin, argv)).toBeNull());
  }
  test("a non-string token, and a null twin", () => {
    expect(parseTwin(HARNESS, ["harness", 7 as never, HRN])).toBeNull();
    expect(parseTwin(null as never, ["harness"])).toBeNull();
    expect(parseTwin(null as never, [])).toBeNull();
  });
});

test("the placeholders, pinned, with empty flags", () => {
  expect(Object.keys(TWIN_PLACEHOLDERS)).toEqual([
    "{hrn}",
    "{appr}",
    "{choice}",
    "{dir}",
    "{dep}",
    "{psn}",
    "{pcl}",
    "{kind}",
    "{area}",
    "{verdict}",
    "{supersedeReason}",
    "{rule}",
  ]);
  for (const grammar of Object.values(TWIN_PLACEHOLDERS)) expect(grammar.flags).toBe("");
});

test("{supersedeReason} is the reasons a person may give, and {rule} a rule id", () => {
  for (const reason of OPERATOR_SUPERSEDE_REASONS) {
    expect(TWIN_PLACEHOLDERS["{supersedeReason}"].test(reason)).toBe(true);
  }
  // A reason the system records on its own is never one a command may claim.
  for (const reason of ["revision-changed", "run-cancelled", "re-asked", "other-thing", ""]) {
    expect(TWIN_PLACEHOLDERS["{supersedeReason}"].test(reason)).toBe(false);
  }
  expect(TWIN_PLACEHOLDERS["{rule}"].test(RULE_ID)).toBe(true);
  expect(isId("rule", RULE_ID)).toBe(true);
  for (const value of [`${RULE_ID}x`, RULE_ID.toUpperCase(), "rule_short", APPR]) {
    expect(TWIN_PLACEHOLDERS["{rule}"].test(value)).toBe(isId("rule", value));
  }
});

test("the {dep} placeholder is the deployment id grammar", () => {
  expect(DEPLOYMENT_ID_RE.test(DEP)).toBe(isId("dep", DEP));
  expect(DEPLOYMENT_ID_RE.test(DEP)).toBe(true);
  for (const value of [
    "dep_short",
    `run_${DEP.slice(4)}`,
    `${DEP}x`,
    "dep_01M76E6F05HP514W9J4V3QYMKA",
  ]) {
    expect(DEPLOYMENT_ID_RE.test(value)).toBe(isId("dep", value));
  }
  expect(TWIN_PLACEHOLDERS["{dep}"]).toBe(DEPLOYMENT_ID_RE);
});
