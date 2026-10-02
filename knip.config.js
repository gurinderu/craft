// Knip: unused files, exports and dependencies across both deliveries.
//
// workflows/*.js are loaded by the harness's Workflow tool, not imported, and are not plain JS
// (top-level return/await). They import nothing: the lib/ code they use is pasted in verbatim
// between `craft-inline` fences. The compiler below hands Knip, in place of each engine's body,
// one `import { names } from '../lib/<source>'` per fence — read with the checker's own fence
// regex — so an inlined export counts as used, and the list of inlined names is never kept by hand.
//
// Run it twice. `knip` counts tests as users, and is blind to the exports of any module a test
// names with `new URL('./x.mjs', import.meta.url)` (Knip takes that as a whole-module reference).
// `knip --production` drops tests and checks what the shipped entries (marked `!`) reach.
import { FENCE_OPEN } from './lib/inline-regions.mjs'

/** @param {string} text @param {string} filename */
function fencesAsImports(text, filename) {
  if (!/(^|[\\/])workflows[\\/][^\\/]+\.js$/.test(filename)) return text
  const out = []
  for (const line of text.split('\n')) {
    const m = FENCE_OPEN.exec(line)
    if (m) out.push(`import { ${m[2].trim().split(/ +/).join(', ')} } from '../${m[1]}'`)
  }
  return out.join('\n')
}

export default {
  compilers: { js: fencesAsImports },
  // An export also used in its own module is surplus `export`, not dead code: not worth a red gate.
  ignoreExportsUsedInFile: true,
  workspaces: {
    '.': {
      entry: [
        'workflows/*.js!',
        // Run by the engines through a shell line they build at runtime, not imported.
        'lib/craft-log-run.mjs!',
        // Run by hand (AGENTS.md, "Commands": not a gate).
        'lib/analyze-runs.mjs!',
        // The gate's own checkers (CI workflow, package.json scripts).
        'lib/check-*.mjs!',
      ],
      project: [
        'lib/**/*.mjs!',
        'workflows/*.js!',
        // Test infrastructure without a .test name: only tests reach it, by design.
        '!lib/engine-harness.mjs!',
        '!lib/sandbox-globals.mjs!',
      ],
    },
    'opencode/plugin': {
      // Loaded by opencode from plugins/craft-rust (opencode/install.sh links it there), not imported.
      entry: ['index.ts!'],
      project: ['**/*.{ts,mjs,js}!'],
      // Pinned exactly beside @opencode-ai/plugin on purpose, though nothing imports it directly
      // (realm @nick/craft, node #124).
      ignoreDependencies: ['@opencode-ai/sdk'],
    },
  },
}
