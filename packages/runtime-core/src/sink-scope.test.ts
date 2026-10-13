/**
 * permission-integration#5 — which sinks reach the egress BLOCK tier.
 *
 * `defaultSinkScope` reads a tool's own declaration: an external tool with a
 * `url` or `recipient` operative argument sends where the model points it,
 * so it is dynamic. The declaration can only ADD a sink to the block tier:
 * the names that were dynamic in 0.7.0 stay dynamic whatever a tool of that
 * name declares. apps/cli/src/egress-sinks.test.ts runs the same question
 * over every builtin.
 */
import { describe, expect, test } from "bun:test";
import type { OperativeArg } from "@crewhaus/tool-catalog";
import { defaultSinkScope } from "./index";

const external = (operativeArgs?: ReadonlyArray<OperativeArg>) => ({
  scope: "external" as const,
  ...(operativeArgs !== undefined ? { operativeArgs } : {}),
});

describe("defaultSinkScope", () => {
  test("an external tool with a model-chosen url or recipient is dynamic", () => {
    expect(defaultSinkScope("PostIt", external([{ field: "url", kind: "url" }]))).toBe(
      "external-dynamic",
    );
    expect(defaultSinkScope("Mail", external([{ field: "to", kind: "recipient" }]))).toBe(
      "external-dynamic",
    );
  });

  test("a destination the operator fixes stays configured", () => {
    // SendMessage-shaped: a routing key into the configured adapter, declared as an id.
    expect(defaultSinkScope("SendMessage", external([{ field: "channel", kind: "id" }]))).toBe(
      "external-configured",
    );
    expect(defaultSinkScope("ImageGenerate", external([]))).toBe("external-configured");
    expect(defaultSinkScope("Custom", external())).toBe("external-configured");
    expect(defaultSinkScope("Custom")).toBe("external-configured");
  });

  test("an internal tool is never a dynamic sink by declaration", () => {
    expect(
      defaultSinkScope("Local", {
        scope: "internal",
        operativeArgs: [{ field: "url", kind: "url" }],
      }),
    ).toBe("external-configured");
  });

  test("the 0.7.0 dynamic names stay dynamic, whatever the tool declares", () => {
    for (const name of ["Fetch", "WebFetch", "Navigate", "EvmSendTransaction"]) {
      expect({ name, scope: defaultSinkScope(name) }).toEqual({ name, scope: "external-dynamic" });
      expect({ name, scope: defaultSinkScope(name, external([])) }).toEqual({
        name,
        scope: "external-dynamic",
      });
    }
    expect(defaultSinkScope("mcp__srv__send", external([]))).toBe("external-dynamic");
  });
});
