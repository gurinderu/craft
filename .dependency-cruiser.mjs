// dependency-cruiser: what the shipped Node entry points may reach through their imports.
//
// craft ships no runtime dependencies (realm @nick/craft, #124): a consumer's checkout has no
// node_modules beside lib/, and the OpenCode plugin installs only @opencode-ai/plugin and
// @opencode-ai/sdk. So a shipped entry that reaches a test file (they import vitest) or any other
// package fails only in the consumer's repo, at run time; in CI every devDependency is installed and
// the rest of the gate stays green. Knip (even --production --strict), tsc and the unit tests let both
// through (realm @nick/craft, #145). The engines (workflows/*.js) are not here: they import nothing,
// and what is inlined into them is held by lib/inlined-sandbox-names.mjs.
//
// Type-only imports are erased before anything runs, so they are not followed (tsPreCompilationDeps).

/** The entry points that run in a consumer's repo: the run-record CLI the engines shell out to, the
 * run-store reader, and the OpenCode plugin. */
const SHIPPED = '^(lib/(craft-log-run|analyze-runs)[.]mjs|opencode/plugin/index[.]ts)$'

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
      // Fail closed: an import the cruiser cannot resolve has no node_modules path, so the rule above
      // would not see it. (Knip reports an unlisted package too; this keeps the rule above honest alone.)
      name: 'resolvable',
      severity: 'error',
      comment: 'An import dependency-cruiser cannot resolve is invisible to shipped-reaches-no-package.',
      from: { path: '^(lib|opencode/plugin)/' },
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: '(^|/)node_modules/' },
    tsPreCompilationDeps: false,
    // @opencode-ai/plugin exports only an `import` condition.
    enhancedResolveOptions: { conditionNames: ['import', 'node', 'default'], exportsFields: ['exports'] },
  },
}
