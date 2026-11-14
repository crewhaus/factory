/** Recovery reads the sign-in request a device decision recorded, by its receipt's id. */
import { afterAll, describe, expect, test } from "bun:test";
import { ensureAccessSetUp, openDeviceRequests } from "@crewhaus/access-control";
import { mintId } from "@crewhaus/control-contract";
import { reconcileDeviceDecide } from "./device-runtime";
import { fakeProbe, removeTempDirs, tempDir } from "./test-helpers";

afterAll(removeTempDirs);

describe("auth.device.decide recovery", () => {
  test("done when the request names this receipt and its actor; unknown otherwise", async () => {
    const root = tempDir("control-service-device-");
    const setUp = await ensureAccessSetUp(root, { localActor: "local:sam@laptop" });
    if (!setUp.ok) throw new Error(setUp.reason);
    const owner = setUp.result.owner;
    const devices = openDeviceRequests(root);
    const start = await devices.start({});
    if (!start.ok) throw new Error(start.reason);
    const cmd = mintId("cmd");
    const decided = await devices.decide({
      caller: owner,
      code: start.userCode,
      choice: "allow",
      cmd,
    });
    expect(decided.ok).toBe(true);
    const ctx = { harnessDir: root, hangarRoot: root, probe: fakeProbe({}), now: () => Date.now() };
    const receipt = (id: string, actor: string) => ({ id, actor }) as never;
    expect(await reconcileDeviceDecide(receipt(cmd, owner), ctx)).toBe("done");
    expect(await reconcileDeviceDecide(receipt(cmd, mintId("prn")), ctx)).toBe("not-done");
    expect(await reconcileDeviceDecide(receipt(mintId("cmd"), owner), ctx)).toBe("unknown");
    const { hangarRoot: _drop, ...noRoot } = ctx;
    expect(await reconcileDeviceDecide(receipt(cmd, owner), noRoot)).toBe("unknown");
  });
});
