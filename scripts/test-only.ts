import * as path from "node:path";

/**
 * A module only tests may use, by its path inside its package: test files,
 * fixtures, and the helper modules tests import (`test-helpers.ts`,
 * `testkit.ts`, anything under `__test__/` or `__tests__/`). tsconfig.base.json
 * excludes exactly these from every build, so none is compiled into dist or
 * published (C176); scripts/test-only-modules.test.ts holds the two in step,
 * and scripts/planted-temp-writers.test.ts skips them.
 *
 * Not included: adapter-anthropic's `test-utils.ts`, which that package
 * exports (`./test-utils`) for the other adapters' tests on purpose.
 */
export function isTestOnly(rel: string): boolean {
  const posix = rel.split(path.sep).join("/");
  return (
    /\.test\.tsx?$/.test(posix) ||
    /(^|\/)fixtures\.ts$/.test(posix) ||
    /-fixtures\.ts$/.test(posix) ||
    /(^|\/)(fixtures|__fixtures__|__test__|__tests__)\//.test(posix) ||
    /(^|\/)(test-helpers|testkit)\.ts$/.test(posix)
  );
}
