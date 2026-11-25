/**
 * Graph runs paused for a decision, from the files the checkpoint store itself writes: one
 * item per waiting run until it is resumed, its question for a content reader only, and no
 * item from a folder or a file that names another run. Reads change nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCheckpointStore, newCheckpointId, newGraphRunId } from "@crewhaus/checkpoint-store";
import type { AttentionItem } from "@crewhaus/control-contract";
import { NOW, harnessDir, iso, tempRoot, testFacts, treeState } from "./__test__/fleet";
import { GRAPHS_REL, checkpointKeyOf, pauseOf } from "./adapters/checkpoints";
import { assembleInbox, emptyModel, foldHarness, refreshModel } from "./fold";
import { attRefOf } from "./ids";
import { DEFAULT_READER, LIST_MAX } from "./read";

const HRN = "hrn_0123456789abcdef";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function harness(name: string): string {
  const t = tempRoot();
  cleanups.push(t.cleanup);
  return harnessDir(t.root, name);
}

const graphs = (dir: string) => join(dir, GRAPHS_REL);

/** A run the store paused: its run id and its checkpoint. */
async function paused(dir: string, node = "ship", prompt = "Ship it to acme?") {
  const store = createCheckpointStore({ rootDir: graphs(dir), now: () => new Date(NOW - 60_000) });
  const grun = newGraphRunId();
  const cp = await store.save({ graphRunId: grun, nodeName: node, state: { secret: "s" } });
  await store.markWaiting(grun, { checkpointId: cp.id, nodeName: node, prompt });
  return { grun, ckpt: cp.id, store };
}

const read = (dir: string, content = false) => {
  const harness = foldHarness(dir, testFacts(), NOW, { harness: HRN, content });
  return {
    harness,
    items: assembleInbox([harness], NOW).items.filter((i) => i.kind === "checkpoint"),
  };
};

/** Write a run's meta by hand, as something that is not the store would. */
function plant(dir: string, grun: string, meta: unknown): void {
  mkdirSync(join(graphs(dir), grun), { recursive: true });
  writeFileSync(join(graphs(dir), grun, "_meta.json"), JSON.stringify(meta));
}

describe("a paused graph run", () => {
  test("is one item, from a file with no newline at its end, until it is resumed", async () => {
    const dir = harness("paused");
    const { grun, ckpt, store } = await paused(dir);
    expect(readFileSync(join(graphs(dir), grun, "_meta.json"), "utf8").endsWith("\n")).toBe(false);
    const [item, ...more] = read(dir).items;
    expect(more).toEqual([]);
    expect(item).toMatchObject({
      ref: attRefOf(HRN, "checkpoint", checkpointKeyOf({ grun, ckpt })),
      band: "decide",
      source: { kind: "checkpoint", id: `${grun}/${ckpt}` },
      title: { template: "checkpoint.waiting", params: { node: "ship" } },
      state: "open",
      requiredClass: "operator",
      since: iso(NOW - 60_000),
    });
    expect(item?.choices).toEqual([
      {
        id: "approve",
        needs: "operator",
        cliTwin: `crewhaus runs resume ${grun} --decision approve --harness ${HRN}`,
      },
      {
        id: "reject",
        needs: "operator",
        cliTwin: `crewhaus runs resume ${grun} --decision reject --harness ${HRN}`,
      },
    ]);
    expect(pauseOf(item?.source.id ?? "")).toEqual({ grun, ckpt });
    await store.claimResume(grun, ckpt);
    await store.markWaiting(grun, undefined);
    expect(read(dir).items).toEqual([]);
  });

  test("shows what it asks to a content reader only, and never the run's state", async () => {
    const dir = harness("asks");
    await paused(dir);
    const closed = read(dir).items[0] as AttentionItem;
    expect(closed.body).toBeUndefined();
    expect(closed.bodyWithheld).toBe(true);
    expect(JSON.stringify(closed)).not.toContain("acme");
    const open = read(dir, true).items[0] as AttentionItem;
    expect(open.body).toEqual({ question: "Ship it to acme?" });
    expect(JSON.stringify(open)).not.toContain("secret");
    // The saved model keeps no question.
    const model = refreshModel(emptyModel(), dir, testFacts());
    expect(JSON.stringify(model)).not.toContain("acme");
  });

  test("waits again at its next gate as an item of its own", async () => {
    const dir = harness("again");
    const { grun, store } = await paused(dir);
    const first = read(dir).items[0];
    const next = await store.save({ graphRunId: grun, nodeName: "after", state: 2 });
    await store.markWaiting(grun, {
      checkpointId: next.id,
      nodeName: "after",
      prompt: "and then?",
    });
    const second = read(dir).items;
    expect(second).toHaveLength(1);
    expect(second[0]?.ref).not.toBe(first?.ref as string);
  });

  test("a name that is not a node's is left out of the title", async () => {
    const dir = harness("named");
    await paused(dir, "ship it; $(id)");
    const item = read(dir).items[0];
    expect(item?.title.params).toEqual({});
    expect(JSON.stringify(item)).not.toContain("$(id)");
  });
});

describe("what is not a paused run is no item", () => {
  test("a folder, a run or a checkpoint that is not one, and a run that names another", async () => {
    const dir = harness("planted");
    const grun = newGraphRunId();
    const ckpt = newCheckpointId();
    const pendingHitl = { checkpointId: ckpt, nodeName: "n", prompt: "p", at: iso(NOW) };
    const meta = { version: 1, graphRunId: grun, createdAt: iso(NOW), pendingHitl };
    plant(dir, newGraphRunId(), meta);
    plant(dir, grun, { ...meta, pendingHitl: { ...pendingHitl, checkpointId: "ckpt_x;id" } });
    plant(dir, "grun_not-hex", { ...meta, graphRunId: "grun_not-hex" });
    plant(dir, "notes", meta);
    const bad = newGraphRunId();
    mkdirSync(join(graphs(dir), bad), { recursive: true });
    writeFileSync(join(graphs(dir), bad, "_meta.json"), "{not json");
    const big = newGraphRunId();
    plant(dir, big, {
      ...meta,
      graphRunId: big,
      pendingHitl: { ...pendingHitl, prompt: "x".repeat(20_000) },
    });
    expect(read(dir).items).toEqual([]);
    // The same file under its own name is one.
    const real = newGraphRunId();
    plant(dir, real, { ...meta, graphRunId: real });
    expect(read(dir).items).toHaveLength(1);
  });

  test("a run's folder that leaves the harness is not read", async () => {
    const dir = harness("linked");
    const outside = harness("outside");
    const { grun } = await paused(outside);
    mkdirSync(graphs(dir), { recursive: true });
    symlinkSync(join(graphs(outside), grun), join(graphs(dir), grun));
    expect(read(dir).items).toEqual([]);
    expect(read(outside).items).toHaveLength(1);
  });

  test("a time that is not one is the file's own", async () => {
    const dir = harness("timed");
    const grun = newGraphRunId();
    plant(dir, grun, {
      version: 1,
      graphRunId: grun,
      createdAt: iso(NOW),
      pendingHitl: {
        checkpointId: newCheckpointId(),
        nodeName: "n",
        prompt: "p",
        at: `${iso(NOW)} (call jane)`,
      },
    });
    utimesSync(join(graphs(dir), grun), NOW / 1000, (NOW - 120_000) / 1000);
    const item = read(dir).items[0];
    expect(item?.since).toBe(iso(NOW - 120_000));
    expect(JSON.stringify(item)).not.toContain("jane");
  });
});

describe("bounds", () => {
  test("past the cap the newest runs are listed and the harness says it was cut short", () => {
    const dir = harness("many");
    const made: string[] = [];
    for (let i = 0; i <= LIST_MAX; i++) {
      const grun = `grun_${i.toString(16).padStart(16, "0")}`;
      made.push(grun);
      plant(dir, grun, {
        version: 1,
        graphRunId: grun,
        createdAt: iso(NOW),
        pendingHitl: {
          checkpointId: newCheckpointId(),
          nodeName: "n",
          prompt: "p",
          at: iso(NOW - i * 1000),
        },
      });
      utimesSync(join(graphs(dir), grun), NOW / 1000, (NOW - i * 1000) / 1000);
    }
    const { harness: one, items } = read(dir);
    expect(items).toHaveLength(LIST_MAX);
    expect(one.truncated).toBe(true);
    const oldest = made[LIST_MAX] as string;
    expect(items.some((i) => i.source.id.startsWith(oldest))).toBe(false);
  }, 20_000); // 201 folders are written, and read twice.

  test("a run's file is read again only when its folder changed", async () => {
    const dir = harness("cached");
    const { grun, store } = await paused(dir);
    let objects = 0;
    const reader = {
      ...DEFAULT_READER,
      object: (root: string, rel: string, max: number) => {
        objects++;
        return DEFAULT_READER.object?.(root, rel, max);
      },
    };
    const model = refreshModel(emptyModel(), dir, testFacts(), reader);
    expect(objects).toBe(1);
    const again = refreshModel(model, dir, testFacts(), reader);
    expect(again).toBe(model);
    expect(objects).toBe(1);
    await store.markWaiting(grun, undefined);
    utimesSync(join(graphs(dir), grun), NOW / 1000, NOW / 1000);
    expect(refreshModel(again, dir, testFacts(), reader).checkpoints.facts).toEqual([]);
    expect(objects).toBe(2);
  });

  test("reading changes nothing", async () => {
    const dir = harness("still");
    await paused(dir);
    const before = treeState(dir);
    read(dir);
    read(dir, true);
    expect(treeState(dir)).toEqual(before);
  });
});
