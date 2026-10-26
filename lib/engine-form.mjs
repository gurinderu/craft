// Which of the two forms an engine in src/ is written in, and which lib/ modules it uses (realm @nick/craft, #210).
// The fenced form pastes lib/ code between `craft-inline` fences and runs as a sandbox body; the bundled form
// imports it — `import … from '../lib/<module>'`, then `export const meta = {…}`, then the body inside
// `export async function __run() {` — and lib/build-engines.mjs bundles it. Both forms coexist until every
// engine is moved (realm @nick/craft, #347); the rosters and checks ask this module instead of reading fences.
import fs from 'node:fs'
import path from 'node:path'
import { findRegions } from './inline-regions.mjs'

// Static imports and re-exports with a literal specifier, at the start of a line: the form lib/ and src/ use.
// The clause between the keyword and `from` holds no quote, `=`, `;` or parenthesis, so a declaration
// (`export const x = …`) never reaches a later `from '…'` in prose or a string.
const IMPORT = /^(?:import|export)\s[^'"=;()]*?\sfrom\s+(['"])([^'"]+)\1|^import\s+(['"])([^'"]+)\3/gm

/** True when `src` is in the bundled form: a top-level `export async function __run(`. @param {string} src */
export function isBundledForm(src) {
  return /^export async function __run\s*\(/m.test(src)
}

/** Every literal specifier `src` imports or re-exports from. @param {string} src @returns {string[]} */
export function importSpecifiers(src) {
  return [...src.matchAll(IMPORT)].map(m => /** @type {string} */ (m[2] ?? m[4]))
}

/**
 * Every lib/ module an engine uses, repo-relative (`lib/x.mjs`), sorted: what its fences name, and what it
 * imports — followed through lib/ itself, since an imported module's own imports run in the engine too.
 * @param {string} root @param {string} file  repo-relative engine path, `src/<engine>.js`
 * @param {(abs: string) => string} [read]
 * @returns {string[]}
 */
export function libModulesOf(root, file, read = abs => fs.readFileSync(abs, 'utf8')) {
  /** @type {Set<string>} */
  const seen = new Set()
  const src = read(path.join(root, file))
  for (const r of findRegions(src)) seen.add(r.source)
  /** @param {string} from @param {string} text */
  const follow = (from, text) => {
    for (const spec of importSpecifiers(text)) {
      if (!spec.startsWith('.')) continue
      const rel = path.relative(root, path.resolve(root, path.dirname(from), spec)).split(path.sep).join('/')
      if (!rel.startsWith('lib/') || seen.has(rel)) continue
      seen.add(rel)
      // A module that cannot be read is still listed — the checks that read it report it — but not followed.
      let text = null
      try { text = read(path.join(root, rel)) } catch { continue }
      follow(rel, text)
    }
  }
  follow(file, src)
  return [...seen].sort()
}
