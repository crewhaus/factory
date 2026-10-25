/**
 * `lineageEgressScreen` — the research report gate's HEAD screen (design
 * §6.1, §10; Pillar 3): a URL carrying content a boundary tagged from a
 * non-user origin is refused, against every listed run context's lineage;
 * a URL the run already requested is let through; nothing is exempt for
 * merely appearing in a tool result.
 */
import { describe, expect, test } from "bun:test";
import { createRunContext, tagContent } from "@crewhaus/run-context";
import { lineageEgressScreen } from "./lineage-screen";

// Assembled from parts: a credential-shaped token a tool read.
const SECRET = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_");
const EXFIL = `https://collector.attacker.example/c?k=${SECRET}`;

describe("lineageEgressScreen", () => {
  test("a tagged secret in any branch's lineage refuses the URL; a clean URL passes", async () => {
    const quiet = createRunContext();
    const leaky = createRunContext();
    tagContent(leaky, `region=us-east-1\nAPI_TOKEN=${SECRET}`, "tool");
    const screen = lineageEgressScreen({ contexts: () => [quiet, leaky] });
    expect(await screen(EXFIL)).toMatchObject({
      verdict: "block",
      sinkScope: "external-dynamic",
      originsFound: ["tool"],
    });
    expect(await screen("https://acme.example/policy")).toMatchObject({
      verdict: "pass",
      originsFound: [],
      matchCount: 0,
    });
  });

  test("an echo of the URL in a tool result is no exemption: the secret in it still refuses it", async () => {
    const ctx = createRunContext();
    tagContent(ctx, `API_TOKEN=${SECRET}`, "tool");
    // The model handed the URL to a tool that returned it.
    tagContent(ctx, JSON.stringify({ url: EXFIL }), "tool");
    const screen = lineageEgressScreen({ contexts: () => [ctx] });
    expect((await screen(EXFIL)).verdict).toBe("block");
  });

  test("a URL the run already requested is let through; the contexts are read at each screen", async () => {
    const ctx = createRunContext();
    tagContent(ctx, `API_TOKEN=${SECRET}`, "tool");
    const contexts: Array<ReturnType<typeof createRunContext>> = [];
    const OTHER = `https://other.attacker.example/?k=${SECRET}`;
    const screen = lineageEgressScreen({
      contexts: () => contexts,
      // The run's own fetch already sent this one: a HEAD adds nothing.
      sent: (url) => url === EXFIL,
    });
    expect((await screen(OTHER)).verdict).toBe("pass");
    contexts.push(ctx);
    expect((await screen(OTHER)).verdict).toBe("block");
    expect((await screen(EXFIL)).verdict).toBe("pass");
  });
});
