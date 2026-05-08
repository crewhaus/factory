/**
 * Catalog R11 `pipeline-engine` — component DAG runtime.
 *
 *   const pipeline = createPipeline<Inputs, Outputs>()
 *     .addComponent("chunk",  async (inp) => ({ chunks: chunkDoc(inp.doc) }))
 *     .addComponent("embed",  async (inp) => ({ vectors: await embed(inp.chunks) }))
 *     .addComponent("store",  async (inp) => ({ count: inp.vectors.length }))
 *     .connect("chunk", "embed", { from: "chunks", to: "chunks" })
 *     .connect("embed", "store", { from: "vectors", to: "vectors" })
 *     .setOutput("store")
 *     .compile();
 *
 *   const result = await pipeline.run({ doc: "..." });
 *
 * Components are pure async functions. The engine schedules them in
 * topological order; sibling components with no inter-dependency run
 * concurrently via `Promise.all`. Streaming components yield events
 * the pipeline forwards through an optional event-bus callback.
 *
 * Layer R11. Pairs with `chunker`, `embedder`, `vector-store`,
 * `target-pipeline`.
 */

import { CrewhausError } from "@crewhaus/errors";

export type ComponentName = string;

export type ComponentInputs = Readonly<Record<string, unknown>>;
export type ComponentOutputs = Readonly<Record<string, unknown>>;

export type ComponentFn = (inputs: ComponentInputs) => Promise<ComponentOutputs>;

export type EdgeMapping = {
  /** Source component output key. Defaults to the destination key when omitted. */
  readonly from?: string;
  /** Destination component input key. Required. */
  readonly to: string;
};

export class PipelineBuildError extends CrewhausError {
  override readonly name = "PipelineBuildError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export class PipelineRunError extends CrewhausError {
  override readonly name = "PipelineRunError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

type EdgeSpec = {
  readonly from: ComponentName;
  readonly to: ComponentName;
  readonly mapping?: ReadonlyArray<EdgeMapping>;
};

export type ComponentEvent =
  | { readonly kind: "component_start"; readonly name: ComponentName }
  | {
      readonly kind: "component_end";
      readonly name: ComponentName;
      readonly durationMs: number;
      readonly outputKeys: ReadonlyArray<string>;
    };

export type RunOptions = {
  readonly onEvent?: (e: ComponentEvent) => void;
};

export interface RunnablePipeline<Inputs extends ComponentInputs, Outputs> {
  readonly components: ReadonlyArray<ComponentName>;
  readonly output: ComponentName;
  run(inputs: Inputs, opts?: RunOptions): Promise<Outputs>;
}

export interface PipelineBuilder<Inputs extends ComponentInputs, Outputs> {
  addComponent(name: ComponentName, fn: ComponentFn): PipelineBuilder<Inputs, Outputs>;
  /**
   * Wire `from`'s outputs into `to`'s inputs. Pass `mapping` to remap
   * keys; when omitted, every key from `from`'s outputs flows verbatim
   * into `to`'s inputs.
   */
  connect(
    from: ComponentName,
    to: ComponentName,
    mapping?: ReadonlyArray<EdgeMapping>,
  ): PipelineBuilder<Inputs, Outputs>;
  /**
   * Pin an entry component's input stream to the run() argument. Each
   * call seeds a single input field on the named component.
   */
  setInput(component: ComponentName, key: string): PipelineBuilder<Inputs, Outputs>;
  /** Set the terminal component whose outputs become the pipeline result. */
  setOutput(component: ComponentName): PipelineBuilder<Inputs, Outputs>;
  compile(): RunnablePipeline<Inputs, Outputs>;
}

export function createPipeline<
  Inputs extends ComponentInputs = ComponentInputs,
  Outputs extends ComponentOutputs = ComponentOutputs,
>(): PipelineBuilder<Inputs, Outputs> {
  const components = new Map<ComponentName, ComponentFn>();
  const edges: EdgeSpec[] = [];
  const inputBindings: Array<{ component: ComponentName; key: string }> = [];
  let output: ComponentName | undefined;

  const builder: PipelineBuilder<Inputs, Outputs> = {
    addComponent(name, fn) {
      if (components.has(name)) {
        throw new PipelineBuildError(`duplicate component "${name}"`);
      }
      if (name.length === 0) throw new PipelineBuildError("component name must be non-empty");
      components.set(name, fn);
      return builder;
    },
    connect(from, to, mapping) {
      edges.push({ from, to, ...(mapping !== undefined ? { mapping } : {}) });
      return builder;
    },
    setInput(component, key) {
      inputBindings.push({ component, key });
      return builder;
    },
    setOutput(component) {
      output = component;
      return builder;
    },
    compile() {
      if (output === undefined) {
        throw new PipelineBuildError("setOutput must be called before compile");
      }
      if (!components.has(output)) {
        throw new PipelineBuildError(`output component "${output}" is not registered`);
      }
      for (const edge of edges) {
        if (!components.has(edge.from)) {
          throw new PipelineBuildError(`edge references unknown component "${edge.from}" (from)`);
        }
        if (!components.has(edge.to)) {
          throw new PipelineBuildError(`edge references unknown component "${edge.to}" (to)`);
        }
      }
      for (const b of inputBindings) {
        if (!components.has(b.component)) {
          throw new PipelineBuildError(`setInput references unknown component "${b.component}"`);
        }
      }
      return new CompiledPipeline<Inputs, Outputs>({
        components,
        edges,
        inputBindings,
        output,
      });
    },
  };
  return builder;
}

type CompiledOptions = {
  readonly components: Map<ComponentName, ComponentFn>;
  readonly edges: ReadonlyArray<EdgeSpec>;
  readonly inputBindings: ReadonlyArray<{ component: ComponentName; key: string }>;
  readonly output: ComponentName;
};

class CompiledPipeline<Inputs extends ComponentInputs, Outputs>
  implements RunnablePipeline<Inputs, Outputs>
{
  readonly components: ReadonlyArray<ComponentName>;
  readonly output: ComponentName;
  private readonly o: CompiledOptions;
  private readonly schedule: ReadonlyArray<ReadonlyArray<ComponentName>>;

  constructor(opts: CompiledOptions) {
    this.o = opts;
    this.components = [...opts.components.keys()];
    this.output = opts.output;
    this.schedule = topoSchedule(opts.components, opts.edges);
  }

  async run(inputs: Inputs, opts: RunOptions = {}): Promise<Outputs> {
    const componentInputs = new Map<ComponentName, Record<string, unknown>>();
    const componentOutputs = new Map<ComponentName, ComponentOutputs>();

    // Seed input bindings: every binding pulls a key from `inputs`
    // into the named component's input pile.
    for (const b of this.o.inputBindings) {
      const slot = componentInputs.get(b.component) ?? {};
      slot[b.key] = (inputs as ComponentInputs)[b.key];
      componentInputs.set(b.component, slot);
    }
    // If no input bindings exist at all, copy `inputs` into every
    // component that has zero incoming edges (they're all "entry"
    // components by default).
    if (this.o.inputBindings.length === 0) {
      const incomingCount = new Map<ComponentName, number>();
      for (const e of this.o.edges) {
        incomingCount.set(e.to, (incomingCount.get(e.to) ?? 0) + 1);
      }
      for (const name of this.components) {
        if ((incomingCount.get(name) ?? 0) === 0) {
          componentInputs.set(name, { ...(inputs as Record<string, unknown>) });
        }
      }
    }

    for (const layer of this.schedule) {
      // Run every component in this layer concurrently. Each component
      // sees only its accumulated inputs.
      const results = await Promise.all(
        layer.map(async (name) => {
          const fn = this.o.components.get(name);
          if (fn === undefined) {
            throw new PipelineRunError(`component "${name}" disappeared from the registry`);
          }
          opts.onEvent?.({ kind: "component_start", name });
          const t0 = performance.now();
          const out = await fn(componentInputs.get(name) ?? {});
          opts.onEvent?.({
            kind: "component_end",
            name,
            durationMs: performance.now() - t0,
            outputKeys: Object.keys(out),
          });
          return { name, out };
        }),
      );
      for (const { name, out } of results) {
        componentOutputs.set(name, out);
        // Forward this component's outputs into downstream component inputs.
        for (const edge of this.o.edges) {
          if (edge.from !== name) continue;
          const slot = componentInputs.get(edge.to) ?? {};
          if (edge.mapping !== undefined) {
            for (const m of edge.mapping) {
              const fromKey = m.from ?? m.to;
              slot[m.to] = out[fromKey];
            }
          } else {
            for (const k of Object.keys(out)) slot[k] = out[k];
          }
          componentInputs.set(edge.to, slot);
        }
      }
    }

    const finalOut = componentOutputs.get(this.output);
    if (finalOut === undefined) {
      throw new PipelineRunError(
        `output component "${this.output}" did not produce results — schedule is incomplete`,
      );
    }
    return finalOut as Outputs;
  }
}

/**
 * Compute a Kahn-style topological schedule, grouping components into
 * layers where every component in a layer has all its incoming edges
 * satisfied by an earlier layer. Throws on cycles.
 */
function topoSchedule(
  components: ReadonlyMap<ComponentName, ComponentFn>,
  edges: ReadonlyArray<EdgeSpec>,
): ReadonlyArray<ReadonlyArray<ComponentName>> {
  const incoming = new Map<ComponentName, Set<ComponentName>>();
  for (const name of components.keys()) incoming.set(name, new Set());
  for (const e of edges) {
    incoming.get(e.to)?.add(e.from);
  }
  const remaining = new Set<ComponentName>(components.keys());
  const layers: ComponentName[][] = [];
  while (remaining.size > 0) {
    const layer: ComponentName[] = [];
    for (const name of remaining) {
      const inEdges = incoming.get(name);
      if (inEdges === undefined || inEdges.size === 0) layer.push(name);
    }
    if (layer.length === 0) {
      throw new PipelineBuildError("pipeline has a cycle (no schedulable layer)");
    }
    layers.push(layer);
    for (const name of layer) {
      remaining.delete(name);
      for (const inSet of incoming.values()) inSet.delete(name);
    }
  }
  return layers;
}
