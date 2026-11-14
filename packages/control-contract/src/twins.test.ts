import { describe, expect, test } from "bun:test";
import {
  CLI_VERBS,
  COMMAND_KINDS,
  type CliTwin,
  DELEGATION_ACTIONS,
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
const QUALITY = {
  chg: mintId("chg"),
  rev: `sha256:${"ab".repeat(32)}`,
  dataset: "support-cases",
  evalRun: "run_0123456789abcdef",
};

const ACCESS = {
  grt: mintId("grt"),
  inv: mintId("inv"),
  crd: mintId("crd"),
  lnk: mintId("lnk"),
  cmd: mintId("cmd"),
};

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
    ...QUALITY,
    changeReason: "not-worth-it",
    fraction: "0.2",
    ...ACCESS,
    until: "2026-12-01T09:00:00Z",
    deferReason: "scheduled",
    delegationAction: "merge",
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
    ...QUALITY,
    changeReason: "other",
    fraction: ".5",
    ...ACCESS,
    until: "2026-12-01T09:00:00.000+01:00",
    deferReason: "awaiting-someone",
    delegationAction: "rollout",
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
    "{chg}",
    "{rev}",
    "{changeReason}",
    "{dataset}",
    "{fraction}",
    "{evalRun}",
    "{grt}",
    "{inv}",
    "{crd}",
    "{lnk}",
    "{cmd}",
    "{until}",
    "{deferReason}",
    "{delegationAction}",
  ]);
  for (const grammar of Object.values(TWIN_PLACEHOLDERS)) expect(grammar.flags).toBe("");
});

test("the quality placeholders take their ids and closed values, nothing else", () => {
  const grammar = TWIN_PLACEHOLDERS as Readonly<Record<string, RegExp>>;
  const holds = (token: string, value: string) => (grammar[token] as RegExp).test(value);
  expect(holds("{chg}", QUALITY.chg)).toBe(true);
  expect(isId("chg", QUALITY.chg)).toBe(true);
  expect(holds("{chg}", "chg_x")).toBe(false);
  expect(holds("{rev}", QUALITY.rev)).toBe(true);
  expect(holds("{rev}", "sha256:AB")).toBe(false);
  for (const ok of ["0.2", ".5", "0.5", "0.05", "0.4999"])
    expect(holds("{fraction}", ok)).toBe(true);
  for (const bad of ["0", "0.0", "0.6", "1", "-0.2", "0.51", ""]) {
    expect(holds("{fraction}", bad)).toBe(false);
  }
  expect(holds("{dataset}", "-rm")).toBe(false);
  expect(holds("{dataset}", "support-cases")).toBe(true);
  // A reason the system records on its own is never one a command may claim.
  for (const reason of ["base-moved", "instrument-changed", "regressed", "slo-rollback"]) {
    expect(holds("{changeReason}", reason)).toBe(false);
  }
  expect(holds("{evalRun}", QUALITY.evalRun)).toBe(true);
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

test("{delegationAction} is an action a rule may cover, and nothing else", () => {
  const grammar = TWIN_PLACEHOLDERS["{delegationAction}"];
  for (const action of DELEGATION_ACTIONS) expect(grammar.test(action)).toBe(true);
  for (const value of ["deploy", "Merge", "merge ", "", "--merge", "rollout|adopt"]) {
    expect(grammar.test(value)).toBe(false);
  }
  const preview: CliTwin = {
    argv: ["delegations", "preview", "{delegationAction}", "--harness", "{hrn}"],
  };
  expect(renderTwin(preview, { delegationAction: "adopt", hrn: HRN })).toEqual({
    argv: ["delegations", "preview", "adopt", "--harness", HRN],
  });
  expect(renderTwin(preview, { delegationAction: "deploy", hrn: HRN })).toEqual({
    invalid: ["delegationAction"],
  });
  expect(CLI_VERBS.delegations).toEqual([
    "list",
    "show",
    "preview",
    "propose",
    "pause",
    "revoke",
    "apply",
  ]);
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

describe("a deferral's twin", () => {
  const DEFER: CliTwin = {
    argv: [
      "approvals",
      "defer",
      "{appr}",
      "--until",
      "{until}",
      "--reason",
      "{deferReason}",
      "--dir",
      "{dir}",
    ],
  };

  test("round-trips, flags in any order", () => {
    const argv = [
      "approvals",
      "defer",
      APPR,
      "--until",
      "2026-12-01T09:00:00Z",
      "--reason",
      "scheduled",
      "--dir",
      "d",
    ];
    expect(parseTwin(DEFER, argv)).toEqual({
      params: { appr: APPR, until: "2026-12-01T09:00:00Z", deferReason: "scheduled", dir: "d" },
    });
    expect(
      renderTwin(DEFER, {
        appr: APPR,
        until: "2026-12-01T09:00:00Z",
        deferReason: "scheduled",
        dir: "d",
      }),
    ).toEqual({ argv });
  });

  test("a time without a zone, or a reason not on the closed list, is refused", () => {
    for (const until of ["2026-12-01T09:00:00", "2026-12-01", "tomorrow", "2026-12-01T09:00Zx"]) {
      expect(renderTwin(DEFER, { appr: APPR, until, deferReason: "scheduled", dir: "d" })).toEqual({
        invalid: ["until"],
      });
    }
    for (const reason of ["because", "", "Scheduled", "scheduled later"]) {
      expect(
        renderTwin(DEFER, {
          appr: APPR,
          until: "2026-12-01T09:00:00Z",
          deferReason: reason,
          dir: "d",
        }),
      ).toEqual({ invalid: ["deferReason"] });
    }
  });

  test("the access and command placeholders take their own ids only", () => {
    const grammar = TWIN_PLACEHOLDERS as Readonly<Record<string, RegExp>>;
    for (const [name, id] of Object.entries(ACCESS)) {
      expect((grammar[`{${name}}`] as RegExp).test(id)).toBe(true);
      expect((grammar[`{${name}}`] as RegExp).test(`${id}x`)).toBe(false);
      for (const [other, otherId] of Object.entries(ACCESS)) {
        if (other !== name) expect((grammar[`{${name}}`] as RegExp).test(otherId)).toBe(false);
      }
    }
  });
});
