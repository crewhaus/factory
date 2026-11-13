/**
 * What a change touches decides who may adopt it: a change to a protected bar, the
 * intent or a security surface (or one that can raise spending) needs the owner; any
 * other needs a maintainer.
 */
import { describe, expect, test } from "bun:test";
import { requiredClassFor, touchesOf, touchesOfGraders } from "./touches";

const BASE = `name: shop
target: cli
agent:
  model: claude-sonnet-4-5
  instructions: Help.
tools: [read]
budget:
  usd: 5
evaluation:
  protected: true
  threshold: 0.8
`;

describe("touchesOf", () => {
  test("a prompt-only change touches prompts and needs a maintainer", () => {
    const touches = touchesOf(BASE, BASE.replace("Help.", "Help kindly."));
    expect(touches).toEqual({
      surfaces: ["prompts"],
      protected: false,
      intent: false,
      security: false,
    });
    expect(requiredClassFor(touches)).toBe("maintainer");
  });

  test("tools and budgets travel as their own surfaces", () => {
    expect(touchesOf(BASE, BASE.replace("tools: [read]", "tools: [read, write]")).surfaces).toEqual(
      ["tools"],
    );
    expect(touchesOf(BASE, BASE.replace("usd: 5", "usd: 2")).surfaces).toEqual(["budgets"]);
  });

  test("a lowered protected bar is protected, and needs the owner", () => {
    const touches = touchesOf(BASE, BASE.replace("threshold: 0.8", "threshold: 0.5"));
    expect(touches.protected).toBe(true);
    expect(requiredClassFor(touches)).toBe("owner");
  });

  test("an intent edit is intent, and needs the owner", () => {
    const touches = touchesOf(BASE, `${BASE}intent:\n  goal: sell shoes\n`);
    expect(touches.intent).toBe(true);
    expect(requiredClassFor(touches)).toBe("owner");
  });

  test("a permissions edit and a raised budget are security, and need the owner", () => {
    const permissions = touchesOf(BASE, `${BASE}permissions:\n  allow: ["Write(**)"]\n`);
    expect(permissions.security).toBe(true);
    expect(requiredClassFor(permissions)).toBe("owner");
    const raised = touchesOf(BASE, BASE.replace("usd: 5", "usd: 50"));
    expect(raised.security).toBe(true);
    expect(requiredClassFor(raised)).toBe("owner");
    // A lowered budget is not a raise.
    expect(touchesOf(BASE, BASE.replace("usd: 5", "usd: 1")).security).toBe(false);
  });
});

describe("touchesOfGraders", () => {
  const GRADERS = `graders:
  - name: exact
    type: exact_match
criteria:
  - id: dates
    description: dates are right
    measured_by: [exact]
    protected: true
`;

  test("a protected criterion that moves is protected", () => {
    const loosened = touchesOfGraders(GRADERS, GRADERS.replace("    protected: true\n", ""));
    expect(loosened).toMatchObject({ surfaces: ["criteria"], protected: true });
    expect(requiredClassFor(loosened)).toBe("owner");
  });

  test("an unprotected edit is not", () => {
    const plain = GRADERS.replace("    protected: true\n", "");
    const edited = touchesOfGraders(
      plain,
      plain.replace("dates are right", "dates are right, always"),
    );
    expect(edited.protected).toBe(false);
    expect(requiredClassFor(edited)).toBe("maintainer");
  });
});
