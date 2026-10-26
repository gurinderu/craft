// Knip: unused files, exports and dependencies across both deliveries.
//
// The engines (src/*.js, shipped as the generated workflows/*.js) are loaded by the harness's Workflow
// tool, not imported. Each imports its lib/ code and is read as written (realm @nick/craft, #210).
//
// Run it twice. `knip` counts tests as users, and is blind to the exports of any module a test
// names with `new URL('./x.mjs', import.meta.url)` (Knip takes that as a whole-module reference).
// `knip --production` drops tests and checks what the shipped entries (marked `!`) reach.
import { SHIPPED_NODE_ENTRIES } from './lib/shipped-entries.mjs'

const PLUGIN = 'opencode/plugin/'

export default {
  // An export also used in its own module is surplus `export`, not dead code: not worth a red gate.
  ignoreExportsUsedInFile: true,
  workspaces: {
    '.': {
      entry: [
        'src/*.js!',
        // lib/craft-log-run.mjs (run by the engines through a shell line they build at runtime) and
        // lib/analyze-runs.mjs (run by hand): not imported. The list is shared with .dependency-cruiser.mjs.
        ...SHIPPED_NODE_ENTRIES.filter(p => !p.startsWith(PLUGIN)).map(p => `${p}!`),
        // Run by CI's quality-delta job and by hand (AGENTS.md, "Commands"): a signal, not a gate. CI-only
        // with every devDependency installed, so not a consumer-side entry (lib/shipped-entries.mjs).
        'lib/quality-delta.mjs!',
        // Run by the weekly mutation workflow's failure step (.github/workflows/mutation.yml), CI-only like
        // the one above: not imported, and production mode does not read the workflows.
        'lib/mutation-issue.mjs!',
        // The gate's own checkers (CI workflow, package.json scripts).
        'lib/check-*.mjs!',
        // The gate as one call (`npm run gate`, CI's test job): run, not imported.
        'lib/gate.mjs!',
        // The engine build (`npm run build:engines`, the gate's check:engines): run, not imported.
        'lib/build-engines.mjs!',
        // The lint gate's prerequisite check, imported by eslint.config.mjs — a file knip's ESLint plugin
        // reads only outside production mode, so its import is not followed there.
        'lib/lint-prerequisites.mjs!',
      ],
      project: [
        'lib/**/*.mjs!',
        'src/*.js!',
        // Test infrastructure without a .test name: only tests reach it, by design.
        '!lib/engine-harness.mjs!',
        '!lib/sandbox-globals.mjs!',
      ],
    },
    'opencode/plugin': {
      // Loaded by opencode from plugins/craft-rust (opencode/install.sh links it there), not imported.
      entry: SHIPPED_NODE_ENTRIES.filter(p => p.startsWith(PLUGIN)).map(p => `${p.slice(PLUGIN.length)}!`),
      project: ['**/*.{ts,mjs,js}!'],
      // Pinned exactly beside @opencode-ai/plugin on purpose, though nothing imports it directly
      // (realm @nick/craft, node #124).
      ignoreDependencies: ['@opencode-ai/sdk'],
    },
  },
}
