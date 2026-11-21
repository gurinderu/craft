// Whether an engine in integrations/claude-code/src/ is written in the bundled form, and which integrations/shared/ modules it uses (realm @nick/craft, #210).
// The bundled form imports its integrations/shared/ code — `import … from '../integrations/shared/<module>'`, then `export const meta = {…}`, then
// the body inside `export async function __run() {` — and integrations/shared/build-engines.mjs bundles it; the build refuses any
// other form. The rosters and checks ask this module which integrations/shared/ code an engine carries.
import fs from 'node:fs'
import path from 'node:path'

// Static imports and re-exports with a literal specifier, at the start of a line: the form integrations/shared/ and integrations/claude-code/src/ use.
// The clause between the keyword and `from` holds no quote, `=`, `;` or parenthesis, so a declaration
// (`export const x = …`) never reaches a later `from '…'` in prose or a string.
const IMPORT = /^(?:import|export)\s[^'"=;()]*?\sfrom\s+(['"])([^'"]+)\1|^import\s+(['"])([^'"]+)\3/gm

// Why an engine in another form is refused, by the build and the type check alike.
export const NOT_BUNDLED =
  'not in the bundled form — import from integrations/shared/, then `export const meta = {…}`, then the body in `export async function __run() {`; nothing else is built'

/** True when `src` is in the bundled form: a top-level `export async function __run(`. @param {string} src */
export function isBundledForm(src) {
  return /^export async function __run\s*\(/m.test(src)
}

/** Every literal specifier `src` imports or re-exports from. @param {string} src @returns {string[]} */
export function importSpecifiers(src) {
  return [...src.matchAll(IMPORT)].map(m => /** @type {string} */ (m[2] ?? m[4]))
}

/**
 * Every integrations/shared/ module an engine uses, repo-relative (`integrations/shared/x.mjs`), sorted: what it imports — followed through integrations/shared/
 * itself, since an imported module's own imports run in the engine too.
 * @param {string} root @param {string} file  repo-relative engine path, `integrations/claude-code/src/<engine>.js`
 * @param {(abs: string) => string} [read]
 * @returns {string[]}
 */
export function libModulesOf(root, file, read = abs => fs.readFileSync(abs, 'utf8')) {
  /** @type {Set<string>} */
  const seen = new Set()
  const src = read(path.join(root, file))
  /** @param {string} from @param {string} text */
  const follow = (from, text) => {
    for (const spec of importSpecifiers(text)) {
      if (!spec.startsWith('.')) continue
      const rel = path
        .relative(root, path.resolve(root, path.dirname(from), spec))
        .split(path.sep)
        .join('/')
      if (!rel.startsWith('integrations/shared/') || seen.has(rel)) continue
      seen.add(rel)
      // A module that cannot be read is still listed — the checks that read it report it — but not followed.
      let text = null
      try {
        text = read(path.join(root, rel))
      } catch {
        continue
      }
      follow(rel, text)
    }
  }
  follow(file, src)
  return [...seen].sort()
}
