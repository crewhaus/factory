import type { SessionLine } from "./lines";
/**
 * Why a step happened: for a tool call, an answer, a model call or a turn, what
 * started the run, what the model was given before it, the rules in force, what it did
 * and the words it wrote before doing it, the other options it had, every check, and
 * the result with any later correction. Each section says how it is known.
 *
 * It shows the record, never the model's private reasoning: thinking is not read.
 */
import type { LoadedRun } from "./load";
import {
  type CheckView,
  type InspectRefusal,
  type Provenance,
  type RouteView,
  WHY_NOTE,
  type WhyAction,
  type WhyRecord,
  notRecorded,
  refusal,
} from "./model";
import {
  type RunIndex,
  type VerdictInfo,
  attributed,
  code,
  correctionsFor,
  indexRun,
  isTurnStart,
  laterOutcomes,
  num,
  payloadOf,
  rec,
  revisionsOf,
  str,
  textOf,
  toolUsesOf,
  triggerOf,
  wakeOf,
} from "./records";

/** `tool:<span>`, `answer:<span>`, `model:<span>` or `turn:<span>`. */
export const WHY_ACTION_RE = /^(tool|answer|model|turn):([0-9a-f]{16})$/;

const INPUT_MAX = 4000;

function capped(text: string, max = INPUT_MAX): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A tool input as it is shown: whole, or its JSON cut short when it is long. */
function inputView(input: unknown): unknown {
  const json = JSON.stringify(input) ?? "";
  return json.length > INPUT_MAX ? capped(json) : input;
}

function checkOf(index: RunIndex, verdict: VerdictInfo): CheckView {
  const p = verdict.payload;
  const refs = rec(p["refs"]);
  const score = rec(p["score"]);
  const value = num(score?.["value"]);
  const threshold = num(score?.["threshold"]);
  const rules = Array.isArray(p["rules"])
    ? (p["rules"] as unknown[]).filter((r): r is string => typeof r === "string").map(code)
    : undefined;
  return {
    id: verdict.line.id,
    gate: verdict.gate,
    outcome: verdict.outcome,
    ...(str(p["reason"]) !== undefined ? { reason: str(p["reason"]) as string } : {}),
    ...(rules !== undefined && rules.length > 0 ? { rules } : {}),
    ...(str(p["mode"]) !== undefined ? { mode: code(p["mode"]) } : {}),
    ...(value !== undefined
      ? { score: { value, ...(threshold !== undefined ? { threshold } : {}) } }
      : {}),
    ...(str(rec(p["judge"])?.["model"]) !== undefined
      ? { judgeModel: code(rec(p["judge"])?.["model"]) }
      : {}),
    ...(str(refs?.["approval"]) !== undefined ? { approval: code(refs?.["approval"]) } : {}),
    later: laterOutcomes(index.loaded.decisions, index.loaded.session, verdict),
    ...(str(rec(refs?.["bundle"])?.["hash"]) !== undefined
      ? { bundleHash: code(rec(refs?.["bundle"])?.["hash"]) }
      : {}),
    ...(str(rec(refs?.["audit"])?.["kind"]) !== undefined
      ? { auditKind: code(rec(refs?.["audit"])?.["kind"]) }
      : {}),
  };
}

/** The last line before `off` that `match` accepts. */
function lastBefore(
  lines: readonly SessionLine[],
  off: number,
  match: (line: SessionLine) => boolean,
): SessionLine | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as SessionLine;
    if (line.off < off && match(line)) return line;
  }
  return undefined;
}

function routesBefore(index: RunIndex, off: number, spans: ReadonlySet<string>): RouteView[] {
  const route = lastBefore(
    index.lines,
    off,
    (line) =>
      (line.kind === "model_route" || line.kind === "model_tier_route") &&
      (line.span === undefined || spans.has(line.span)),
  );
  if (route === undefined) return [];
  const p = payloadOf(route);
  return [
    {
      ...(str(p["model"]) !== undefined ? { model: code(p["model"]) } : {}),
      ...(str(p["policy"]) !== undefined ? { policy: code(p["policy"]) } : {}),
      ...(str(p["reason"]) !== undefined ? { reason: str(p["reason"]) as string } : {}),
      // A pool's route band; never under its own name, which a key-name masker hides.
      ...(str(p["routeKey"]) !== undefined ? { band: code(p["routeKey"]) } : {}),
      ...(str(p["tier"]) !== undefined ? { tier: code(p["tier"]) } : {}),
    },
  ];
}

type Located = {
  readonly kind: WhyAction;
  readonly span: string;
  /** The line the action is: the call, the answer, the model call's manifest or answer. */
  readonly anchor: SessionLine;
  /** The model call span the action belongs to, when known. */
  readonly modelSpan?: string;
  readonly turnSpan?: string;
};

function locate(index: RunIndex, kind: WhyAction, span: string): Located | undefined {
  const info = index.spans.get(span);
  const turnOf = (s: string | undefined): string | undefined => {
    let at = s;
    for (let hops = 0; at !== undefined && hops < 64; hops++) {
      const node = index.spans.get(at);
      if (node?.kind === "turn") return at;
      at = node?.parent;
    }
    return undefined;
  };
  switch (kind) {
    case "tool": {
      const tool = index.tools.find((t) => t.span === span);
      if (tool === undefined) return undefined;
      const turnSpan = turnOf(span);
      return { kind, span, anchor: tool.use, ...(turnSpan !== undefined ? { turnSpan } : {}) };
    }
    case "answer":
    case "model": {
      const answer = index.lines.filter(
        (line) => line.kind === "assistant_message" && line.span === span,
      );
      const manifest = index.manifests.find((line) => line.span === span);
      const withText = answer.find((line) => textOf(payloadOf(line)["content"]) !== undefined);
      const anchor = kind === "answer" ? withText : (manifest ?? answer[0]);
      if (anchor === undefined) return undefined;
      if (kind === "model" && info !== undefined && info.kind !== "model") return undefined;
      const turnSpan = turnOf(span);
      return {
        kind,
        span,
        anchor,
        modelSpan: span,
        ...(turnSpan !== undefined ? { turnSpan } : {}),
      };
    }
    case "turn": {
      if (info?.kind !== "turn") return undefined;
      const first = index.lines.find((line) => line.span === span) ?? undefined;
      const anchor = first ?? index.lines.find((line) => line.id === info.lineId);
      if (anchor === undefined) return undefined;
      return { kind, span, anchor, turnSpan: span };
    }
  }
}

/** The span ids under `root`, `root` included. */
function spansUnder(index: RunIndex, root: string): Set<string> {
  const out = new Set<string>([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, info] of index.spans) {
      if (!out.has(id) && info.parent !== undefined && out.has(info.parent)) {
        out.add(id);
        grew = true;
      }
    }
  }
  return out;
}

/** Why the step named by `action` happened. */
export function whyOf(index: RunIndex, action: string): WhyRecord | InspectRefusal {
  const parsed = WHY_ACTION_RE.exec(action);
  if (parsed === null) {
    return refusal(
      "invalid",
      "--why names a step: tool:, answer:, model: or turn: and its 16-hex span id",
      "crewhaus runs inspect <run> --timeline full",
    );
  }
  const kind = parsed[1] as WhyAction;
  const span = parsed[2] as string;
  if (index.spans.size === 0 && index.unfinished.size === 0) {
    return refusal(
      "unsupported",
      "this run recorded no steps to explain: it was recorded before CrewHaus 0.9.0, or with run records off",
      index.loaded.mode === "records-off" ? "CREWHAUS_RUN_STAMPS" : "crewhaus compile",
    );
  }
  const located = locate(index, kind, span);
  if (located === undefined) {
    return refusal(
      "not_found",
      `this run has no ${kind} step ${span}`,
      "crewhaus runs inspect <run> --timeline full",
    );
  }
  const { attribution } = index;
  const anchor = located.anchor;

  // What started it.
  const trigger = triggerOf(index);
  const wake = wakeOf(index);
  const askedLine = lastBefore(index.lines, anchor.off + 1, isTurnStart);
  const asked = askedLine !== undefined ? textOf(payloadOf(askedLine)["content"]) : undefined;
  const started: WhyRecord["started"] = {
    state: trigger.state,
    ...(trigger.rule !== undefined ? { rule: trigger.rule } : {}),
    ...(trigger.gap !== undefined ? { gap: trigger.gap } : {}),
    refs: [
      ...new Set([
        ...trigger.refs,
        ...(wake?.refs ?? []),
        ...(askedLine !== undefined ? [askedLine.id] : []),
      ]),
    ],
    value: {
      trigger: trigger.value ?? { kind: "unknown", words: "not recorded", synthetic: false },
      ...(wake?.value !== undefined ? { wake: wake.value } : {}),
      ...(asked !== undefined ? { asked } : {}),
    },
  };

  // What it used: the manifest of the model call that led to it.
  const manifest =
    located.modelSpan !== undefined
      ? index.manifests.find((line) => line.span === located.modelSpan)
      : located.kind === "turn"
        ? index.manifests.find((line) => {
            const parent = line.span !== undefined ? index.spans.get(line.span)?.parent : undefined;
            return parent === located.span;
          })
        : lastBefore(index.manifests, anchor.off, () => true);
  let used: WhyRecord["used"];
  if (manifest !== undefined) {
    const p = payloadOf(manifest);
    const blocks = Array.isArray(p["blocks"])
      ? (p["blocks"] as unknown[]).map((b) => code(rec(b)?.["kind"]))
      : [];
    const items = Array.isArray(rec(p["recalled"])?.["items"])
      ? (rec(p["recalled"])?.["items"] as unknown[])
      : [];
    const hidden = items.filter((item) => {
      const status = rec(item)?.["status"];
      return status === "redacted" || status === "split-redacted";
    }).length;
    const call = num(p["call"]) ?? 0;
    used = attributed(
      attribution,
      {
        call,
        blocks,
        recalled: items.length - hidden,
        hidden,
        files: Array.isArray(p["files"]) ? (p["files"] as unknown[]).length : 0,
        link: `--context ${call}`,
      },
      [manifest.id],
    );
  } else {
    used = notRecorded({
      reason: index.loaded.mode === "legacy" ? "before-0.9" : "not-recorded",
      ...(index.loaded.mode === "legacy" ? { remedy: "crewhaus compile" } : {}),
    });
  }

  // The rules in force.
  const revisions = revisionsOf(index);
  const ownVerdicts = index.verdicts.filter((verdict) => {
    const vSpan = str(verdict.payload["span"]) ?? verdict.line.span;
    if (located.kind === "tool") return verdict.tool?.span === span || vSpan === span;
    if (vSpan === span) return true;
    const on = rec(verdict.payload["on"]);
    if (on?.["kind"] !== "answer" || located.turnSpan === undefined) return false;
    const turn = index.spans.get(located.turnSpan)?.turn;
    const modelTurn =
      located.modelSpan !== undefined ? index.spans.get(located.modelSpan)?.turn : turn;
    return num(rec(on["turn"])?.["session"]) === (modelTurn ?? turn)?.session;
  });
  const mode = ownVerdicts.map((v) => str(v.payload["mode"])).find((m) => m !== undefined);
  const rules: WhyRecord["rules"] = {
    ...revisions,
    ...(revisions.value !== undefined
      ? { value: { ...revisions.value, ...(mode !== undefined ? { mode: code(mode) } : {}) } }
      : {}),
  };

  // What it did, and the words it wrote before.
  let did: WhyRecord["did"];
  if (located.kind === "tool") {
    const tool = index.tools.find((t) => t.span === span);
    const ran = tool?.ran ?? tool?.use;
    const input = ran !== undefined ? payloadOf(ran)["input"] : undefined;
    const said = lastBefore(
      index.lines,
      anchor.off,
      (line) =>
        line.kind === "assistant_message" &&
        toolUsesOf(payloadOf(line)["content"]).some((use) => use.id === tool?.toolUseId),
    );
    const reasonGiven = said !== undefined ? textOf(payloadOf(said)["content"]) : undefined;
    did = attributed(
      attribution,
      {
        what: `Called ${tool?.name ?? "a tool"}${tool?.ran !== undefined ? " with the approved input" : ""}`,
        ...(tool !== undefined ? { tool: tool.name } : {}),
        ...(input !== undefined ? { input: inputView(input) } : {}),
        ...(reasonGiven !== undefined ? { reasonGiven } : {}),
        note: WHY_NOTE,
      },
      [
        anchor.id,
        ...(tool?.ran !== undefined ? [tool.ran.id] : []),
        ...(said !== undefined ? [said.id] : []),
      ],
    );
  } else {
    const answers = index.lines.filter(
      (line) =>
        line.kind === "assistant_message" &&
        (line.span === located.modelSpan ||
          (located.kind === "turn" &&
            line.span !== undefined &&
            spansUnder(index, span).has(line.span))),
    );
    const said = answers
      .map((line) => textOf(payloadOf(line)["content"]))
      .find((t) => t !== undefined);
    const calls = answers.flatMap((line) =>
      toolUsesOf(payloadOf(line)["content"]).map((u) => u.name),
    );
    const what =
      located.kind === "answer"
        ? "Answered"
        : located.kind === "model"
          ? calls.length > 0
            ? `Asked the model, which called ${calls.join(", ")}`
            : "Asked the model"
          : "Ran a turn";
    did = attributed(
      attribution,
      { what, ...(said !== undefined ? { reasonGiven: said } : {}), note: WHY_NOTE },
      answers.map((line) => line.id),
    );
  }

  // Other options.
  const turnSpans = new Set<string>([
    ...(located.turnSpan !== undefined ? [located.turnSpan] : []),
    ...(located.modelSpan !== undefined ? [located.modelSpan] : []),
    span,
  ]);
  const models = routesBefore(index, anchor.off, turnSpans);
  const toolChoice = notRecorded<never>({ reason: "not-recorded" });
  const options: WhyRecord["options"] =
    models.length > 0
      ? attributed(attribution, { models, toolChoice }, [])
      : { ...notRecorded({ reason: "not-recorded" }), value: { models, toolChoice } };

  // Checks.
  const checkViews = ownVerdicts.map((verdict) => checkOf(index, verdict));
  const checks: Provenance<readonly CheckView[]> =
    index.loaded.mode === "legacy"
      ? { ...notRecorded({ reason: "before-0.9", remedy: "crewhaus compile" }), value: [] }
      : attributed(
          attribution,
          checkViews,
          checkViews.map((c) => c.id),
        );

  // Result and later corrections.
  let result: WhyRecord["result"];
  if (located.kind === "tool") {
    const tool = index.tools.find((t) => t.span === span);
    const p = tool?.result !== undefined ? payloadOf(tool.result) : undefined;
    result =
      p !== undefined && tool?.result !== undefined
        ? attributed(
            attribution,
            {
              ...(textOf(p["content"]) !== undefined
                ? { text: textOf(p["content"]) as string }
                : {}),
              isError: p["isError"] === true,
              corrections: [],
            },
            [tool.result.id],
          )
        : { ...notRecorded({ reason: "not-recorded" }), value: { corrections: [] } };
  } else {
    const answerSpan = located.modelSpan ?? span;
    const text =
      located.kind === "turn"
        ? [...index.lines]
            .reverse()
            .filter(
              (line) =>
                line.kind === "assistant_message" &&
                line.span !== undefined &&
                spansUnder(index, span).has(line.span),
            )
            .map((line) => textOf(payloadOf(line)["content"]))
            .find((t) => t !== undefined)
        : textOf(
            payloadOf(
              anchor.kind === "assistant_message"
                ? anchor
                : (index.lines.find(
                    (l) => l.kind === "assistant_message" && l.span === answerSpan,
                  ) ?? anchor),
            )["content"],
          );
    const corrections = correctionsFor(index.loaded, answerSpan);
    result = attributed(attribution, { ...(text !== undefined ? { text } : {}), corrections }, [
      ...did.refs,
      ...corrections.map((c) => c.id),
    ]);
  }

  return {
    action,
    kind: located.kind,
    span,
    started,
    used,
    rules,
    did,
    options,
    checks,
    result,
    gaps: index.gaps,
  };
}

/** Why a step of a loaded run happened. */
export function foldWhy(loaded: LoadedRun, action: string): WhyRecord | InspectRefusal {
  return whyOf(indexRun(loaded), action);
}
