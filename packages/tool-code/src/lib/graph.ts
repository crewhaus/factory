/**
 * The module import graph, and the two questions worth asking of it: what
 * imports what, and what nothing imports.
 *
 * Resolution here is the ESM/bundler convention — relative specifiers, the
 * usual extension ladder, `index` files in a directory, and the TypeScript
 * habit of writing `./x.js` for a file that is `./x.ts`. A specifier that is
 * not relative is external; it is reported as such rather than resolved,
 * because resolving it means reading `node_modules`, `tsconfig` paths and
 * `package.json` `exports` maps, and a half-right answer there is worse than
 * an explicit "external".
 *
 * Pure: records in, records out. No filesystem — the caller supplies the file
 * set, which is also what makes this testable without a temp directory.
 */

export type FileImports = {
  readonly file: string;
  readonly imports: ReadonlyArray<{ readonly specifier: string; readonly line: number }>;
};

export type Edge = {
  readonly from: string;
  readonly to: string;
  readonly specifier: string;
};

export type ImportGraph = {
  readonly files: readonly string[];
  readonly edges: readonly Edge[];
  /** Bare specifiers, with the files that import them. */
  readonly external: ReadonlyArray<{
    readonly specifier: string;
    readonly importedBy: readonly string[];
  }>;
  /** Relative specifiers that matched no file in the set. */
  readonly unresolved: ReadonlyArray<{
    readonly from: string;
    readonly specifier: string;
    readonly line: number;
  }>;
  /** Groups of files that mutually import each other, each group sorted. */
  readonly cycles: ReadonlyArray<readonly string[]>;
};

/** Extensions tried, in order, when a specifier has none that matches. */
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

const normalize = (p: string): string => {
  const parts: string[] = [];
  for (const segment of p.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
};

const dirOf = (file: string): string => {
  const slash = file.lastIndexOf("/");
  return slash === -1 ? "" : file.slice(0, slash);
};

/**
 * Resolve a relative specifier against the known file set, or `undefined`.
 *
 * The `./x.js` to `./x.ts` rewrite is applied before the extension ladder:
 * under `"moduleResolution": "NodeNext"` that is what a TypeScript source
 * writes for its own sibling, and without the rewrite a correctly written
 * project looks like nothing but unresolved imports.
 */
export function resolveSpecifier(
  fromFile: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = normalize(`${dirOf(fromFile)}/${specifier}`);
  const candidates: string[] = [base];
  const jsExt = /\.([cm]?)js(x?)$/.exec(base);
  if (jsExt !== null) {
    const stem = base.slice(0, base.length - jsExt[0].length);
    candidates.push(`${stem}.${jsExt[1] as string}ts${jsExt[2] as string}`);
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  }
  for (const ext of EXTENSIONS) candidates.push(`${base}${ext}`);
  for (const ext of EXTENSIONS) candidates.push(`${base}/index${ext}`);
  for (const candidate of candidates) {
    if (files.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Tarjan's strongly-connected components, iterative so a deep graph cannot
 * overflow the stack, walking neighbours in sorted order so the same graph
 * always yields the same groups in the same order.
 */
export function stronglyConnected(
  nodes: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  let counter = 0;

  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: string; next: number };
      const neighbours = adjacency.get(frame.node) ?? [];
      if (frame.next < neighbours.length) {
        const neighbour = neighbours[frame.next] as string;
        frame.next += 1;
        if (!index.has(neighbour)) {
          index.set(neighbour, counter);
          low.set(neighbour, counter);
          counter += 1;
          stack.push(neighbour);
          onStack.add(neighbour);
          work.push({ node: neighbour, next: 0 });
        } else if (onStack.has(neighbour)) {
          low.set(
            frame.node,
            Math.min(low.get(frame.node) as number, index.get(neighbour) as number),
          );
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low.set(
          parent.node,
          Math.min(low.get(parent.node) as number, low.get(frame.node) as number),
        );
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const group: string[] = [];
        while (true) {
          const popped = stack.pop() as string;
          onStack.delete(popped);
          group.push(popped);
          if (popped === frame.node) break;
        }
        // A single node is a cycle only when it imports itself.
        const selfLoop =
          group.length === 1 &&
          (adjacency.get(group[0] as string) ?? []).includes(group[0] as string);
        if (group.length > 1 || selfLoop) result.push(group.sort());
      }
    }
  }
  return result.sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1));
}

/** Build the graph from each file's scanned imports. */
export function buildImportGraph(input: readonly FileImports[]): ImportGraph {
  const files = [...new Set(input.map((f) => f.file))].sort();
  const fileSet = new Set(files);
  const edges: Edge[] = [];
  const unresolved: Array<{ from: string; specifier: string; line: number }> = [];
  const externalMap = new Map<string, Set<string>>();

  for (const entry of [...input].sort((a, b) => (a.file < b.file ? -1 : 1))) {
    const seen = new Set<string>();
    for (const imported of entry.imports) {
      if (imported.specifier.startsWith(".")) {
        const target = resolveSpecifier(entry.file, imported.specifier, fileSet);
        if (target === undefined) {
          unresolved.push({ from: entry.file, specifier: imported.specifier, line: imported.line });
          continue;
        }
        const key = `${target} <- ${imported.specifier}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: entry.file, to: target, specifier: imported.specifier });
        continue;
      }
      const importers = externalMap.get(imported.specifier) ?? new Set<string>();
      importers.add(entry.file);
      externalMap.set(imported.specifier, importers);
    }
  }

  const adjacency = new Map<string, string[]>();
  for (const file of files) adjacency.set(file, []);
  for (const edge of edges) {
    const list = adjacency.get(edge.from);
    if (list !== undefined && !list.includes(edge.to)) list.push(edge.to);
  }
  for (const [, list] of adjacency) list.sort();

  return {
    files,
    edges: edges.sort(
      (a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) || (a.to < b.to ? -1 : 1),
    ),
    external: [...externalMap.entries()]
      .map(([specifier, importers]) => ({ specifier, importedBy: [...importers].sort() }))
      .sort((a, b) => (a.specifier < b.specifier ? -1 : 1)),
    unresolved: unresolved.sort(
      (a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) || a.line - b.line,
    ),
    cycles: stronglyConnected(files, adjacency),
  };
}

/**
 * Files nothing in the set imports.
 *
 * This is IMPORT-based and nothing else, which means it cannot see: a module
 * loaded by a computed path (`import(variable)`, `require(join(dir, name))`),
 * a file referenced from HTML, a config file a tool discovers by name, a
 * plugin resolved through a registry, or anything reached from outside the
 * scanned directory. Treat the result as a list to review, never as a list to
 * delete.
 */
export function unreferencedFiles(
  graph: ImportGraph,
  entryPredicate: (file: string) => boolean,
): string[] {
  const imported = new Set(graph.edges.map((e) => e.to));
  return graph.files.filter((file) => !imported.has(file) && !entryPredicate(file)).sort();
}
