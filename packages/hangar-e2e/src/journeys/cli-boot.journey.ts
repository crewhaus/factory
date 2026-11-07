/** The real CLI, booted against a seeded registry. */
import { listeningAddresses } from "service-fakes";
import { childEnv, spawnHangar } from "../system";
import type { Journey } from "./journey";

export const cliBoot: Journey = {
  id: "cli-boot",
  shard: "system",
  proves:
    "`crewhaus hangar` boots against a seeded registry, listens on 127.0.0.1 only as the operating system reports it, signs a browser in from the URL it prints, shows the harness in the Library, and exits 0 on SIGTERM.",
  run: async (scope) => {
    const fleet = await scope.fleet({ seed: "cli-boot", shapes: ["cli"] });
    const hangar = await spawnHangar(childEnv(fleet.dir), fleet.dir);
    let stopped = false;
    scope.defer(async () => {
      if (!stopped) await hangar.stop();
    });

    const addresses = listeningAddresses(hangar.pid, hangar.port);
    if (addresses === undefined) {
      throw new Error("could not determine what the CLI is listening on");
    }
    if (addresses.length !== 1 || addresses[0] !== "127.0.0.1") {
      throw new Error(`the CLI listens on ${addresses.join(", ")}, not 127.0.0.1 alone`);
    }

    const session = await scope.session(hangar.home);
    const specName = fleet.harnesses[0]?.specName ?? "";
    if ((await session.page.getByText(specName).count()) === 0) {
      throw new Error(`the Library does not show ${specName}`);
    }
    session.assertClean();
    // Before the server goes, or the page's next request failing would be a failure.
    await session.close();

    stopped = true;
    const exitCode = await hangar.stop();
    if (exitCode !== 0) throw new Error(`SIGTERM exited ${exitCode}, not 0`);
  },
};
