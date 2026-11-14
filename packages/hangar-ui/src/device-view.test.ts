/**
 * The device sign-in page: a labelled code field that takes a code in any case, plain
 * words for every refusal, status that is never colour alone, and no markup assignment.
 * Rendered, it keeps the person's place: a lookup that fails gives the button back, and
 * after Allow or Deny focus is on the heading that says how it ended.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { resetDiscovery } from "../assets/js/v1.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { DEVICE_MESSAGES, codeFromHash, renderDevice } from "../assets/js/views/device.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { DEVICE_APPROVE_VERB, DEVICE_LOGIN_VERB } from "../assets/js/views/settings.js";
import { homeAssets as CONSOLE_ASSETS } from "./embed/home";

const SOURCE = readFileSync(
  join(import.meta.dir, "..", "assets", "js", "views", "device.js"),
  "utf8",
);

describe("#/device", () => {
  test("the account page links here, and names the commands on both computers", () => {
    const settings = readFileSync(
      join(import.meta.dir, "..", "assets", "js", "views", "settings.js"),
      "utf8",
    );
    expect(settings).toContain('el("a", { href: hrefFleet("device"), text: "Allow a sign-in" })');
    expect(settings).toContain("root.appendChild(otherComputerCard());");
    expect(DEVICE_LOGIN_VERB).toBe("crewhaus login --server <this Home's address>");
    expect(DEVICE_APPROVE_VERB).toBe("crewhaus access approve <code>");
  });

  test("the code field is labelled, takes a one-time code, and says what it takes", () => {
    expect(SOURCE).toContain('el("label", { for: "device-code"');
    expect(SOURCE).toContain('autocomplete: "one-time-code"');
    expect(SOURCE).toContain('"aria-describedby": "device-code-help"');
    for (const words of ["Look up", "Allow this sign-in", "Deny"])
      expect(SOURCE).toContain(`text: "${words}"`);
    // The result heading takes focus, so a screen reader hears what happened.
    expect(SOURCE).toContain('tabindex: "-1"');
    expect(SOURCE).toContain("heading.focus()");
  });

  test("every refusal is said in words, with the reason", () => {
    expect(Object.keys(DEVICE_MESSAGES).sort()).toEqual(
      [
        "access_not_set_up",
        "code_expired",
        "code_unknown",
        "code_used",
        "no_credential",
        "session_required",
        "too_many_tries",
      ].sort(),
    );
    expect(DEVICE_MESSAGES.code_expired).toContain("expired");
    expect(DEVICE_MESSAGES.code_used).toContain("already been used");
    expect(DEVICE_MESSAGES.too_many_tries).toContain("Wait ten minutes");
    // A tab-only page hears why it cannot allow one here.
    expect(DEVICE_MESSAGES.session_required).toContain("over HTTPS");
  });

  test("a code in the address fills the field; anything else does not", () => {
    expect(codeFromHash("#/device?code=bcdf-ghjk")).toBe("bcdf-ghjk");
    expect(codeFromHash("#/device")).toBe("");
    expect(codeFromHash("#/device?code=<script>")).toBe("");
  });

  test("status is a word and an icon; no markup is ever assigned", () => {
    expect(SOURCE).toContain('"aria-hidden": "true"');
    expect(SOURCE).toContain("Not done: ");
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
      expect(SOURCE).not.toContain(banned);
    }
  });

  test("the page and the client ship in the console", () => {
    expect(Object.keys(CONSOLE_ASSETS)).toContain("/assets/js/views/device.js");
    expect(Object.keys(CONSOLE_ASSETS)).toContain("/assets/js/v1.js");
  });
});

// ---------------------------------------------------------------------------
// The page itself, rendered against just enough DOM to follow focus
// ---------------------------------------------------------------------------

/** A node that knows where focus is, and drops it as a browser does when hidden or disabled. */
class FakeNode {
  readonly children: FakeNode[] = [];
  readonly attrs: Record<string, string> = {};
  readonly listeners: Record<string, Array<(event: unknown) => unknown>> = {};
  readonly dataset: Record<string, string> = {};
  readonly style = { setProperty: (): void => undefined } as Record<string, unknown>;
  className = "";
  ownText = "";
  value = "";
  parentNode: FakeNode | null = null;
  #hidden = false;
  #disabled = false;
  constructor(readonly tag: string) {}
  get hidden(): boolean {
    return this.#hidden;
  }
  set hidden(on: boolean) {
    this.#hidden = on;
    if (on && fakeDocument.activeElement?.within(this)) fakeDocument.activeElement = fakeBody;
  }
  get disabled(): boolean {
    return this.#disabled;
  }
  set disabled(on: boolean) {
    this.#disabled = on;
    if (on && fakeDocument.activeElement === this) fakeDocument.activeElement = fakeBody;
  }
  within(node: FakeNode): boolean {
    for (let at: FakeNode | null = this; at !== null; at = at.parentNode)
      if (at === node) return true;
    return false;
  }
  get isConnected(): boolean {
    return this.within(fakeBody);
  }
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    for (const child of this.children) child.parentNode = null;
    this.children.length = 0;
    this.ownText = value;
  }
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  removeAttribute(name: string): void {
    delete this.attrs[name];
  }
  addEventListener(name: string, fn: (event: unknown) => unknown): void {
    this.listeners[name] = [...(this.listeners[name] ?? []), fn];
  }
  appendChild<T extends FakeNode>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeNode): void {
    this.children.splice(this.children.indexOf(child), 1);
    child.parentNode = null;
    if (fakeDocument.activeElement?.within(child)) fakeDocument.activeElement = fakeBody;
  }
  focus(): void {
    for (let at: FakeNode | null = this; at !== null; at = at.parentNode) if (at.hidden) return;
    if (!this.#disabled && this.isConnected) fakeDocument.activeElement = this;
  }
  find(test: (node: FakeNode) => boolean): FakeNode | undefined {
    for (const child of this.children) {
      if (test(child)) return child;
      const deeper = child.find(test);
      if (deeper !== undefined) return deeper;
    }
    return undefined;
  }
  /** Fire an event and wait for every listener it started. */
  async fire(name: string): Promise<void> {
    const event = { preventDefault: (): void => undefined };
    await Promise.all((this.listeners[name] ?? []).map((fn) => fn(event)));
  }
}

const fakeBody = new FakeNode("body");
const fakeDocument: {
  activeElement: FakeNode | null;
  body: FakeNode;
  createElement(tag: string): FakeNode;
  createTextNode(value: string): FakeNode;
  querySelectorAll(): FakeNode[];
} = {
  activeElement: fakeBody,
  body: fakeBody,
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (value) => {
    const node = new FakeNode("#text");
    node.ownText = value;
    return node;
  },
  querySelectorAll: () => [],
};

describe("#/device, rendered", () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g["document"], Node: g["Node"], fetch: g["fetch"] };
  let answers: (url: string, init: RequestInit) => Promise<Response>;
  beforeAll(() => {
    g["document"] = fakeDocument;
    g["Node"] = FakeNode;
    g["fetch"] = (url: string, init: RequestInit) => answers(url, init);
  });
  afterAll(() => {
    g["document"] = saved.document;
    g["Node"] = saved.Node;
    g["fetch"] = saved.fetch;
  });
  beforeEach(() => {
    resetDiscovery();
    fakeBody.textContent = "";
    fakeDocument.activeElement = fakeBody;
  });

  const TABLE = {
    protocol: "crewhaus.hangar.v1",
    operations: [
      { id: "auth.device.lookup", method: "POST", path: "/api/v1/access/device-requests/lookup" },
      { id: "auth.device.decide", method: "POST", path: "/api/v1/access/device-requests/decide" },
    ],
  };
  const LOOKED_UP = { clientName: "laptop", readOnly: false, tokenDays: 90 };

  function mount() {
    const root = new FakeNode("main");
    fakeBody.appendChild(root);
    renderDevice(root, {});
    const byText = (words: string) =>
      root.find((n) => n.tag === "button" && n.textContent === words) as FakeNode;
    const input = root.find((n) => n.tag === "input") as FakeNode;
    const form = root.find((n) => n.tag === "form") as FakeNode;
    const status = () => root.find((n) => n.className === "device-status")?.textContent ?? "";
    return { root, byText, input, form, status };
  }
  const liveWords = async () => {
    await Bun.sleep(80); // the live region clears, then speaks on the next task
    return fakeBody.children
      .filter((n) => n.getAttribute("data-live") !== null)
      .map((n) => n.textContent)
      .join(" ");
  };

  test("Home offline: the button comes back, and the error is shown and said", async () => {
    answers = async () => {
      throw new Error("offline");
    };
    const page = mount();
    page.input.value = "BCDF-GHJK";
    await page.form.fire("submit");
    expect(page.byText("Look up").disabled).toBe(false);
    expect(page.status()).toContain("Not done: ");
    expect(page.status()).toContain("could not be reached");
    expect(await liveWords()).toContain("Not done: ");
  });

  test("an ended session is said in words, never the server's own", async () => {
    answers = async () =>
      Response.json(
        {
          error: {
            code: "unauthenticated",
            message: "missing or invalid bearer token",
            reason: "no_credential",
          },
        },
        { status: 401 },
      );
    const page = mount();
    page.input.value = "BCDF-GHJK";
    await page.form.fire("submit");
    expect(page.status()).toContain(DEVICE_MESSAGES.no_credential);
    expect(page.status()).not.toContain("bearer");
    expect(page.byText("Look up").disabled).toBe(false);
  });

  async function lookedUp(decide: (url: string) => Response) {
    answers = async (url) =>
      url === "/api/v1"
        ? Response.json(TABLE)
        : url.endsWith("/lookup")
          ? Response.json(LOOKED_UP)
          : decide(url);
    const page = mount();
    page.input.value = "BCDF-GHJK";
    await page.form.fire("submit");
    const heading = page.root.find((n) => n.tag === "h2") as FakeNode;
    expect(fakeDocument.activeElement).toBe(heading);
    return { ...page, heading };
  }

  test("pressing Allow moves focus to the heading, which says it was allowed", async () => {
    const page = await lookedUp(() =>
      Response.json({ receipt: { id: "cmd_1", state: "succeeded" } }),
    );
    const allow = page.byText("Allow this sign-in");
    allow.focus();
    await allow.fire("click");
    expect(fakeDocument.activeElement).toBe(page.heading);
    expect(page.heading.textContent).toBe("Sign-in allowed");
    expect(allow.hidden).toBe(true);
  });

  test("pressing Deny says it was denied", async () => {
    const page = await lookedUp(() =>
      Response.json({ receipt: { id: "cmd_2", state: "succeeded" } }),
    );
    const deny = page.byText("Deny");
    deny.focus();
    await deny.fire("click");
    expect(fakeDocument.activeElement).toBe(page.heading);
    expect(page.heading.textContent).toBe("Sign-in denied");
  });

  test("a refused choice gives focus back to the button pressed, ready again", async () => {
    const page = await lookedUp(() =>
      Response.json(
        { error: { code: "conflict", message: "x", reason: "code_used" } },
        { status: 409 },
      ),
    );
    const allow = page.byText("Allow this sign-in");
    allow.focus();
    await allow.fire("click");
    expect(fakeDocument.activeElement).toBe(allow);
    expect(allow.getAttribute("aria-disabled")).toBeNull();
    expect(allow.hidden).toBe(false);
    expect(page.status()).toContain(DEVICE_MESSAGES.code_used);
    expect(page.heading.textContent).toBe("A sign-in is waiting");
  });
});
