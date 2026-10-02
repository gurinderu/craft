// What `npm run lint` needs installed before its type-aware rules can see types: every package the root
// and opencode/plugin declare, at the exact node_modules path of each. typescript-eslint builds each
// tsconfig's program however it can; with a dependency absent the imports from it read as `any`, the
// rules have nothing to report, and lint exits 0 — so eslint.config.mjs refuses instead (realm @nick/craft, #137).
import fs from 'node:fs'
import path from 'node:path'

/** Each install the lint programs read: where its package.json is, and the command that fills it. */
const INSTALLS = [
  { dir: '.', command: 'npm ci' },
  { dir: path.join('opencode', 'plugin'), command: 'npm ci --prefix opencode/plugin' },
]

/**
 * One line per install with declared packages missing from its own node_modules; empty when all are there.
 * @param {string} root @returns {string[]}
 */
export function lintPrerequisiteProblems(root) {
  /** @type {string[]} */
  const problems = []
  for (const { dir, command } of INSTALLS) {
    /** @type {unknown} */
    const pkg = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'))
    /** @type {string[]} */
    const names = []
    for (const field of ['dependencies', 'devDependencies']) {
      const deps = pkg && typeof pkg === 'object' ? /** @type {Record<string, unknown>} */ (pkg)[field] : undefined
      if (deps && typeof deps === 'object') names.push(...Object.keys(deps))
    }
    const missing = names.sort()
      .map(n => path.join(dir, 'node_modules', n))
      .filter(rel => !fs.existsSync(path.join(root, rel, 'package.json')))
    if (missing.length) problems.push(`not installed: ${missing.map(m => m.split(path.sep).join('/')).join(', ')} — run ${command}`)
  }
  return problems
}

/** Throws, naming the install command, when lint's typed programs cannot be built whole. @param {string} root */
export function assertLintPrerequisites(root) {
  const problems = lintPrerequisiteProblems(root)
  if (problems.length) throw new Error(`lint's type-aware rules would run on incomplete types and pass silently:\n  ${problems.join('\n  ')}`)
}
