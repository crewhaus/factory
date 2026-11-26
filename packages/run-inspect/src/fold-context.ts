import type { SessionLine } from "./lines";
/**
 * The context each model call got, from its `context_manifest`: the system regions by
 * kind and size, the project files, the recalled items with what became of each, the
 * tools offered beside those in the spec, the model and its settings, and how many
 * messages it carried. A recalled item the model never saw stays visible as "Hidden for
 * safety" with its rules and its ref, never its text: the manifest holds no text.
 *
 * A manifest names recalled items and tool names only when they changed; the rest
 * point back (`sameAs`, or no `names`), and resolve to the manifest that listed them.
 */
import type { LoadedRun } from "./load";
import {
  type ContextList,
  type ContextUsed,
  HIDDEN_FOR_SAFETY,
  type InspectRefusal,
  type RecalledItemView,
  flatText,
  notRecorded,
  refusal,
} from "./model";
import { type RunIndex, attributed, code, indexRun, num, payloadOf, rec, str } from "./records";

function recalledView(p: Readonly<Record<string, unknown>>) {
  const items = Array.isArray(p["items"]) ? (p["items"] as unknown[]) : [];
  return {
    at: code(p["at"]),
    requested: num(p["requested"]) ?? 0,
    returned: num(p["returned"]) ?? 0,
    items: items.map((raw): RecalledItemView => {
      const item = rec(raw) ?? {};
      const ref = rec(item["ref"]);
      const status = code(item["status"]);
      const rules = Array.isArray(item["rules"])
        ? (item["rules"] as unknown[]).filter((r): r is string => typeof r === "string").map(code)
        : undefined;
      const version = num(ref?.["version"]);
      return {
        ref:
          ref !== undefined
            ? {
                store: code(ref["store"]),
                backend: code(ref["backend"]),
                localId: code(ref["localId"]),
                ...(version !== undefined ? { version } : {}),
              }
            : null,
        status,
        ...(num(item["score"]) !== undefined ? { score: num(item["score"]) as number } : {}),
        ...(rules !== undefined && rules.length > 0 ? { rules } : {}),
        ...(status === "redacted" || status === "split-redacted"
          ? { label: HIDDEN_FOR_SAFETY }
          : {}),
      };
    }),
  };
}

/** The context of one manifest line. */
export function contextOfManifestLine(index: RunIndex, manifest: SessionLine): ContextUsed {
  const p = payloadOf(manifest);
  const attribution = index.attribution;
  const span = str(p["span"]) ?? manifest.span ?? "";
  const earlier = index.manifests.filter((line) => line.off < manifest.off);

  // Recalled items: listed here, or on the manifest `sameAs` names.
  const recalledRaw = rec(p["recalled"]);
  let recalled: ContextUsed["recalled"];
  if (recalledRaw === undefined) {
    recalled = attributed(attribution, null, [manifest.id]);
  } else if (typeof recalledRaw["sameAs"] === "string") {
    const same = earlier.find(
      (line) =>
        (str(payloadOf(line)["span"]) ?? line.span) === recalledRaw["sameAs"] &&
        Array.isArray(rec(payloadOf(line)["recalled"])?.["items"]),
    );
    const listed = same !== undefined ? rec(payloadOf(same)["recalled"]) : undefined;
    recalled =
      same !== undefined && listed !== undefined
        ? attributed(attribution, recalledView(listed), [manifest.id, same.id])
        : notRecorded({ reason: "not-recorded" }, [manifest.id]);
  } else {
    recalled = attributed(attribution, recalledView(recalledRaw), [manifest.id]);
  }

  // Tool names: listed here, or on the latest manifest before that listed them.
  const tools = rec(p["tools"]) ?? {};
  const counts = { advertised: num(tools["advertised"]) ?? 0, inSpec: num(tools["inSpec"]) ?? 0 };
  const namesOf = (t: Readonly<Record<string, unknown>> | undefined) =>
    Array.isArray(t?.["names"])
      ? (t?.["names"] as unknown[]).filter((n): n is string => typeof n === "string").map(code)
      : undefined;
  let toolsView: ContextUsed["tools"];
  const own = namesOf(tools);
  if (own !== undefined) {
    toolsView = attributed(attribution, { ...counts, names: own }, [manifest.id]);
  } else {
    const lister = [...earlier]
      .reverse()
      .find((line) => namesOf(rec(payloadOf(line)["tools"])) !== undefined);
    const names = lister !== undefined ? namesOf(rec(payloadOf(lister)["tools"])) : undefined;
    toolsView =
      lister !== undefined && names !== undefined
        ? attributed(attribution, { ...counts, names }, [manifest.id, lister.id])
        : { ...notRecorded({ reason: "not-recorded" }, [manifest.id]), value: counts };
  }

  const blocks = (Array.isArray(p["blocks"]) ? (p["blocks"] as unknown[]) : []).map((raw) => {
    const block = rec(raw) ?? {};
    return {
      kind: code(block["kind"]),
      bytes: num(block["bytes"]) ?? 0,
      cached: block["cached"] === true,
    };
  });
  const files = (Array.isArray(p["files"]) ? (p["files"] as unknown[]) : []).map((raw) => {
    const file = rec(raw) ?? {};
    return {
      path:
        file["outside"] === true
          ? "(outside the working directory)"
          : flatText(str(file["path"]) ?? ""),
      bytes: num(file["bytes"]) ?? 0,
    };
  });
  const model = rec(p["model"]) ?? {};
  const params: Record<string, number | string> = {};
  for (const [name, value] of Object.entries(rec(model["params"]) ?? {})) {
    if (typeof value === "number") params[name] = value;
    else if (typeof value === "string") params[name] = code(value);
  }
  const turn = rec(p["turn"]);
  const turnRun = num(turn?.["run"]);
  const turnSession = num(turn?.["session"]);
  const attempt = rec(p["attempt"]);
  const attemptIndex = num(attempt?.["index"]);
  const messages = rec(p["messages"]) ?? {};
  const recalledItems = recalled.value?.items ?? [];
  return {
    call: num(p["call"]) ?? 0,
    span,
    id: manifest.id,
    ...(turnRun !== undefined && turnSession !== undefined
      ? { turn: { run: turnRun, session: turnSession } }
      : {}),
    ...(attemptIndex !== undefined
      ? {
          attempt: {
            index: attemptIndex,
            ...(str(attempt?.["cause"]) !== undefined ? { cause: code(attempt?.["cause"]) } : {}),
          },
        }
      : {}),
    model: {
      wire: code(model["wire"]),
      ...(str(model["spec"]) !== undefined ? { spec: code(model["spec"]) } : {}),
      provider: code(model["provider"]),
      ...(str(model["profile"]) !== undefined ? { profile: code(model["profile"]) } : {}),
      params,
    },
    blocks,
    files,
    recalled,
    tools: toolsView,
    messages: {
      count: num(messages["count"]) ?? 0,
      afterCompaction: messages["afterCompaction"] === true,
    },
    onlyInstructions:
      blocks.every((block) => block.kind === "instructions") &&
      files.length === 0 &&
      recalledItems.length === 0,
    changedSince: notRecorded({ reason: "unsupported" }),
  };
}

/**
 * The context of one model call (`call`, its 1-based ordinal in the run), or of every
 * call (`"all"`).
 */
export function contextOf(
  index: RunIndex,
  call: number | "all",
): ContextUsed | ContextList | InspectRefusal {
  if (call === "all") {
    return {
      calls: index.manifests.map((line) => contextOfManifestLine(index, line)),
      gaps: index.gaps,
    };
  }
  const manifest = index.manifests.find((line) => payloadOf(line)["call"] === call);
  if (manifest === undefined) {
    if (index.manifests.length === 0) {
      if (index.loaded.mode === "unread") {
        return refusal(
          "not_found",
          "none of this run's transcript was read: it was removed, or holds nothing from where the run starts",
          `crewhaus runs show ${index.loaded.run ?? "<run>"}`,
        );
      }
      return refusal(
        "unsupported",
        "this run recorded no context for its model calls",
        index.loaded.mode === "legacy" ? "crewhaus compile" : "CREWHAUS_RUN_STAMPS",
      );
    }
    return refusal(
      "not_found",
      `this run has no model call ${call}; it made ${index.manifests.length}`,
      "crewhaus runs inspect <run> --context all",
    );
  }
  return contextOfManifestLine(index, manifest);
}

/** The context of a loaded run's model call, or of all of them. */
export function foldContext(
  loaded: LoadedRun,
  call: number | "all",
): ContextUsed | ContextList | InspectRefusal {
  return contextOf(indexRun(loaded), call);
}
