/**
 * Section 30 — host backend for `computer-use-driver`. Drives the
 * dev's actual desktop via the OS-level computer-use surface (macOS
 * Quartz / Linux X11+xdotool / Windows SendInput). Production
 * deployments use this for cross-app workflows that no browser can
 * reach (Maps, Notes, Photos, Finder, native System Settings).
 *
 * **Safety gate:** the constructor refuses to return a working driver
 * unless `CREWHAUS_BROW_HOST_ENABLED=1` is set in the environment. The
 * goal is fail-loud ergonomics: deployment errors that try to use the
 * host backend without explicit opt-in should immediately surface
 * rather than silently driving the dev's machine.
 *
 * The OS-level command dispatch is delegated to a caller-supplied
 * `HostExecutor` so tests + the smoke harness can stub the surface.
 * In production, codegen wires a thin wrapper that shells out to
 * `xdotool` (Linux), `cliclick` (macOS), or PowerShell (Windows).
 */
import { ComputerUseDriverError, type Driver, type Viewport } from "../index";

export type HostExecutor = {
  /** Click at absolute screen coordinates. Button: "left" | "right" | "middle". */
  click(x: number, y: number, button: string): Promise<void>;
  /** Type a string at the current focus. */
  type(text: string): Promise<void>;
  /** Press a single key (or modifier+key, e.g. "cmd+space"). */
  key(combo: string): Promise<void>;
  /** Scroll at absolute screen coordinates. */
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  /** Capture a PNG screenshot of the entire screen, returning base64. */
  screenshot(): Promise<{ pngBase64: string; viewport: Viewport }>;
  /** Disconnect / clean up any handles. */
  close?(): Promise<void>;
};

export type HostBackendOptions = {
  /** Required to pass; otherwise the constructor throws. */
  readonly enabled: boolean;
  /** Test injection (or production OS shim). */
  readonly executor: HostExecutor;
};

export function createHostDriver(opts: HostBackendOptions): Driver {
  if (!opts.enabled) {
    throw new ComputerUseDriverError(
      "host backend disabled. Set CREWHAUS_BROW_HOST_ENABLED=1 to opt in (this drives the actual desktop — never enable in smoke tests).",
    );
  }
  let connected = false;
  return {
    backend: "host",
    async connect(): Promise<void> {
      connected = true;
    },
    async goto(_url: string): Promise<void> {
      // The host backend doesn't navigate URLs — callers should open
      // a browser app first via the OS shell. We surface this as a
      // soft-fail since some workflows want goto to be a no-op.
      throw new ComputerUseDriverError(
        "host backend cannot navigate URLs directly — open a browser via OS shell first",
      );
    },
    async screenshot(): Promise<{ pngBase64: string; viewport: Viewport }> {
      if (!connected) throw new ComputerUseDriverError("host driver not connected");
      return await opts.executor.screenshot();
    },
    async click(x: number, y: number, button = "left"): Promise<void> {
      if (!connected) throw new ComputerUseDriverError("host driver not connected");
      await opts.executor.click(x, y, button);
    },
    async type(text: string): Promise<void> {
      if (!connected) throw new ComputerUseDriverError("host driver not connected");
      await opts.executor.type(text);
    },
    async key(combo: string): Promise<void> {
      if (!connected) throw new ComputerUseDriverError("host driver not connected");
      await opts.executor.key(combo);
    },
    async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
      if (!connected) throw new ComputerUseDriverError("host driver not connected");
      await opts.executor.scroll(x, y, deltaX, deltaY);
    },
    async getViewport(): Promise<Viewport> {
      if (!connected) throw new ComputerUseDriverError("host driver not connected");
      const shot = await opts.executor.screenshot();
      return shot.viewport;
    },
    async disconnect(): Promise<void> {
      connected = false;
      await opts.executor.close?.();
    },
  };
}
