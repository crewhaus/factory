# Recipe 10 — Browser Agent

> **Status:** stub.

## What you'll learn

Build a computer-use agent that drives a chromium browser via
Screenshot, FindElement (vision-grounded bounding boxes), Click, Type,
Key, and Scroll. The pattern works against the bundled headless
chromium for tests and against a remote CDP-over-WebSocket browser for
production.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).
- [Recipe 19 — Permissions Deep Dive](29-permissions-deep-dive.md) — Click/Type/Key/Scroll are destructive; permission rules matter.

## Roadmap

1. The `target: browser` spec — `driver.backend`, `viewport`, `startUrl`, `groundingModel`, `permissions`.
2. The driver contract: `connect / goto / screenshot / click / type / key / scroll / getViewport / disconnect`.
3. The vision-grounding loop: Screenshot → FindElement(description) → Click(centerX, centerY) → verify.
4. Permission posture: Click/Type/Key/Scroll are `destructive: true`. In default mode, no `alwaysAllow` ⇒ deny.
5. Backends: `chromium` (Playwright bundled), `remote` (puppeteer-core CDP), `host` (xdotool/cliclick — gated).
6. Why FindElement uses a separate grounding model (configurable; defaults to the agent model).
7. Streaming `browser_event` JSON on stdout.
8. Hardening: never run the host-backend driver in production untrusted contexts.

## Run it now

```bash
bun run compile:hello-browser
bun run smoke:section-25
```

## Pointers to existing material

- **Example:** [`examples/hello-browser/crewhaus.yaml`](../../examples/hello-browser/crewhaus.yaml).
- **Codegen:** [`packages/target-browser-driver`](../../packages/target-browser-driver).
- **Modules:** [`packages/computer-use-driver`](../../packages/computer-use-driver), [`packages/tool-screen-capture`](../../packages/tool-screen-capture), [`packages/tool-mouse-keyboard`](../../packages/tool-mouse-keyboard), [`packages/tool-vision-grounding`](../../packages/tool-vision-grounding).
- **Catalog:** §25, §30 (host + remote drivers).

## Where to go next

- For voice instead of GUI → [Recipe 09 — Voice Agent](09-voice-agent.md).
- For sandboxed code execution adjacent to browser control → [Recipe 30 — Sandboxed Code Execution](30-sandboxed-code-execution.md).
