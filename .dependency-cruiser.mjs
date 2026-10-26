// dependency-cruiser: what the shipped Node entry points may reach through their imports.
//
// craft ships no runtime dependencies (realm @nick/craft, #124): a consumer's checkout has no
// node_modules beside lib/, and the OpenCode plugin installs only @opencode-ai/plugin and
// @opencode-ai/sdk. So a shipped entry that reaches a test file (they import vitest) or any other
// package fails only in the consumer's repo, at run time; in CI every devDependency is installed and
// the rest of the gate stays green. Knip (even --production --strict), tsc and the unit tests let both
// through (realm @nick/craft, #145). The engines (authored in src/*.js, shipped as workflows/*.js) run in the
// Workflow sandbox, which has neither packages nor Node: each imports lib/ modules that esbuild bundles in
// (realm @nick/craft, #210), so what it reaches may hold no npm package, no node: built-in and no test.
//
// Only imports that survive compilation are followed (tsPreCompilationDeps: false), and the TypeScript is
// compiled under the plugin's own tsconfig. That matters: under its verbatimModuleSyntax `import type`
// is erased, but `import { type X } from 'p'` is not — it runs as `import {} from 'p'` and is followed
// here (lint also refuses that shape: @typescript-eslint/no-import-type-side-effects). The tsconfig path
// is absolute: given a relative one, dependency-cruiser 18.5.0 reads its `include` as matching nothing.
//
// Blind spots (REALITY.md): `createRequire(…)(…)`, `import()` with a non-literal argument, and code a
// shipped entry starts as another process or reads from disk at run time.
import { builtinModules } from 'node:module'
import { SHIPPED_NODE_ENTRIES } from './lib/shipped-entries.mjs'

const BUILTIN = `^(node:)?(${builtinModules.map(m => m.replace(/[.]/g, '[.]')).join('|')})$`
const SHIPPED = `^(${SHIPPED_NODE_ENTRIES.map(p => p.replace(/[.]/g, '[.]')).join('|')})$`

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'shipped-reaches-no-test',
      severity: 'error',
      comment: 'A shipped entry reaches a test file, which imports vitest: absent in a consumer\'s install.',
      from: { path: SHIPPED },
      to: { path: '[.]test[.]mjs$', reachable: true },
    },
    {
      name: 'shipped-reaches-no-package',
      severity: 'error',
      comment: 'A shipped entry reaches an npm package. craft ships none (#124); the OpenCode plugin ships '
        + 'only @opencode-ai/plugin and @opencode-ai/sdk.',
      from: { path: SHIPPED },
      to: {
        path: '(^|/)node_modules/',
        pathNot: '^opencode/plugin/node_modules/@opencode-ai/(plugin|sdk)/',
        reachable: true,
      },
    },
    {
      name: 'engine-reaches-no-package',
      severity: 'error',
      comment: 'An engine reaches an npm package: the Workflow sandbox has none, and the build bundles only lib/.',
      from: { path: '^src/[^/]+[.]js$' },
      to: { path: '(^|/)node_modules/', reachable: true },
    },
    {
      name: 'engine-reaches-no-node-builtin',
      severity: 'error',
      comment: 'An engine reaches a Node built-in: the Workflow sandbox has no Node API.',
      from: { path: '^src/[^/]+[.]js$' },
      // Reachability is matched by path, and a built-in resolves to its bare name (`node:fs` as `fs`).
      to: { path: BUILTIN, reachable: true },
    },
    {
      name: 'engine-reaches-no-test',
      severity: 'error',
      comment: 'An engine reaches a test file, which imports vitest and node:assert.',
      from: { path: '^src/[^/]+[.]js$' },
      to: { path: '[.]test[.]mjs$', reachable: true },
    },
    {
      // Fail closed: an import the cruiser cannot resolve has no node_modules path, so the rule above
      // would not see it. (Knip reports an unlisted package too; this keeps the rule above honest alone.)
      name: 'resolvable',
      severity: 'error',
      comment: 'An import dependency-cruiser cannot resolve is invisible to shipped-reaches-no-package.',
      from: { path: '^(lib|opencode/plugin|src)/' },
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: '(^|/)node_modules/' },
    tsPreCompilationDeps: false,
    tsConfig: { fileName: `${import.meta.dirname}/opencode/plugin/tsconfig.json` },
    // @opencode-ai/plugin exports only an `import` condition.
    enhancedResolveOptions: { conditionNames: ['import', 'node', 'default'], exportsFields: ['exports'] },
  },
}
