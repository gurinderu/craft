// Knip: unused files, exports and dependencies across both deliveries.
//
// workflows/*.js are loaded by the harness's Workflow tool, not imported, and are not plain JS
// (top-level return/await). They import nothing: the lib/ code they use is pasted in verbatim
// between `craft-inline` fences. The compiler below hands Knip, in place of each engine's body,
// one `import { names } from '../lib/<source>'` per fence — read with the checker's own fence
// regex — naming only the fence's names the engine actually references outside that source's own
// regions. Listing a name in a fence only copies it into the engine; an inlined export no engine
// calls is dead, and Knip's production run reports it. The list of names is never kept by hand.
//
// Run it twice. `knip` counts tests as users, and is blind to the exports of any module a test
// names with `new URL('./x.mjs', import.meta.url)` (Knip takes that as a whole-module reference).
// `knip --production` drops tests and checks what the shipped entries (marked `!`) reach.
import { FENCE_CLOSE, FENCE_OPEN } from './lib/inline-regions.mjs'

// A comment names helpers without calling them: it is not a use. Stripped: a line comment (`//` at
// the start or after whitespace, so a `://` inside a URL survives) and a block comment opened at the
// start of a line (a JSDoc) — not one opened mid-line, where `/*` is far likelier a glob inside a
// prompt string (`workflows/*`) whose stripping would swallow real calls up to the next `*/`.
// Over-stripping hides a use and reads as dead (loud); under-stripping hides dead code (silent).
/** @param {string} text */
function withoutComments(text) {
  return text.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, ' ').split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n')
}

/** @param {string} text @param {string} filename */
export function fencesAsImports(text, filename) {
  if (!/(^|[\\/])workflows[\\/][^\\/]+\.js$/.test(filename)) return text
  /** @type {{ source: string, names: string[] }[]} */
  const fences = []
  // Per line, the source of the fence it sits inside ('' outside every fence; fence lines are comments).
  /** @type {string[]} */
  const owner = []
  let inside = ''
  for (const line of text.split('\n')) {
    const m = FENCE_OPEN.exec(line)
    if (m) {
      fences.push({ source: /** @type {string} */ (m[1]), names: /** @type {string} */ (m[2]).trim().split(/ +/) })
      inside = /** @type {string} */ (m[1])
      owner.push('')
    } else if (FENCE_CLOSE.test(line)) {
      inside = ''
      owner.push('')
    } else owner.push(inside)
  }
  const lines = text.split('\n')
  /** @type {Map<string, string>} */
  const usersOf = new Map()
  const out = []
  for (const { source, names } of fences) {
    // A use is a reference from anywhere but the source's own regions: the engine body, or a region
    // pasted from another source. Calls inside the source's own regions are calls inside its lib/
    // module, where Knip already sees them (ignoreExportsUsedInFile).
    let users = usersOf.get(source)
    if (users === undefined) {
      users = withoutComments(lines.filter((_, i) => owner[i] !== source).join('\n'))
      usersOf.set(source, users)
    }
    const used = names.filter(n => new RegExp(`(^|[^\\w$.]|\\.\\.\\.)${n.replace(/\$/g, '\\$')}(?![\\w$])`).test(users))
    if (used.length) out.push(`import { ${used.join(', ')} } from '../${source}'`)
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
        // The lint gate's prerequisite check, imported by eslint.config.mjs — a file knip's ESLint plugin
        // reads only outside production mode, so its import is not followed there.
        'lib/lint-prerequisites.mjs!',
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
