// One engine in the bundled form built with esbuild (realm @nick/craft, #210 step 2; the surface — #343).
// The source imports lib/ modules, then declares `export const meta = {…}`, then runs its body inside
// `export async function __run() {`. The build lifts meta and the CRAFT_VERSION stamp line out verbatim as the
// banner (the Workflow tool reads meta from the file's head; release-please edits the stamp line in place),
// bundles the rest compressed by whitespace and syntax with every identifier kept, drops the bundle's
// `export{__run}` and ends with `return await __run()`. The shipped file then spells only names its sources spell
// (#345), so a stack's name and a grep both lead back to src/ or lib/; a source map beside it leads the position.
import fs from 'node:fs'
import path from 'node:path'
import { bundleProblems } from './engine-bundle-checks.mjs'
import { liftBanner } from './engine-banner.mjs'

/** @typedef {typeof import('esbuild')} Esbuild */
/** @typedef {import('./run-tsc.mjs').TypeScript} TypeScript */
/** @typedef {{ js: string, map: string | null }} Bundled */

const TAIL = 'export{__run};\n'
export const FOOTER = '\nreturn await __run();\n'

/**
 * An esbuild plugin: the entry is read with its banner blanked, and an import may reach only lib/.
 * @param {string} root @param {string} entry  absolute @param {string} blanked @param {string} label
 * @returns {import('esbuild').Plugin}
 */
function enginePlugin(root, entry, blanked, label) {
  const lib = path.join(root, 'lib') + path.sep
  return {
    name: 'craft-engine',
    setup(b) {
      // A literal filter, the entry matched by its path: any other file esbuild loads as it would.
      b.onLoad({ filter: /\.m?js$/ }, a => a.path === entry ? { contents: blanked, loader: 'js' } : undefined)
      b.onResolve({ filter: /.*/ }, a => {
        if (a.kind === 'entry-point') return undefined
        const target = path.resolve(a.resolveDir, a.path)
        if (a.path.startsWith('.') && target.startsWith(lib)) return undefined
        return { errors: [{ text: `${label} imports '${a.path}': an engine imports only lib/ modules — no package, no node: built-in, nothing outside lib/` }] }
      })
    },
  }
}

/**
 * The shipped text and source map of one bundled-form engine; throws naming the engine when it cannot be built.
 * @param {{ esbuild: Esbuild, ts: TypeScript, root: string, file: string, source: string, maps: boolean, checked?: boolean }} o
 *   `file` repo-relative (`src/<engine>.js`); `maps` writes the map and its `sourceMappingURL` line; `checked`
 *   false skips the shipped text's checks (bundleProblems) — for a bundle that is run, never shipped
 * @returns {Promise<Bundled>}
 */
export async function bundleEngine({ esbuild, ts, root, file, source, maps, checked = true }) {
  const { banner, blanked } = liftBanner(ts, source, file)
  const name = path.basename(file)
  const result = await runEsbuild(esbuild, {
    absWorkingDir: root, entryPoints: [file], outfile: path.join('workflows', name), write: false,
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', charset: 'utf8', legalComments: 'none',
    minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false, treeShaking: true,
    banner: { js: banner }, sourcemap: maps ? 'external' : false, sourcesContent: false, metafile: true, logLevel: 'silent',
    plugins: [enginePlugin(root, path.join(root, file), blanked, file)],
  }, file)
  const js = result.outputFiles.find(f => f.path.endsWith('.js'))?.text ?? ''
  const map = result.outputFiles.find(f => f.path.endsWith('.map'))?.text ?? null
  if (!js.endsWith(TAIL)) throw new Error(`${file}: the bundle does not end in \`${TAIL.trim()}\` — an engine exports only meta and __run`)
  const body = js.slice(0, -TAIL.length)
  if (checked) {
    const inputs = Object.keys(result.metafile.inputs).map(i => ({ file: i, text: i === file ? source : readInput(root, i) }))
    const problems = bundleProblems(ts, body, banner, inputs)
    if (problems.length) throw new Error(problems.map(p => `${file}: ${p}`).join('\n'))
  }
  return { js: `${body}${FOOTER}${maps ? `//# sourceMappingURL=${name}.map\n` : ''}`, map: map && `${map.trimEnd()}\n` }
}

/**
 * esbuild's build, its refusal rethrown naming the engine.
 * @param {Esbuild} esbuild @param {import('esbuild').BuildOptions & { write: false, metafile: true }} options @param {string} file
 */
async function runEsbuild(esbuild, options, file) {
  try { return await esbuild.build(options) }
  catch (e) {
    const errors = /** @type {{ errors?: { text: string }[] }} */ (e).errors
    throw new Error(`${file}: esbuild refused it — ${errors?.map(x => x.text).join('; ') ?? /** @type {Error} */ (e).message}`)
  }
}

/** @param {string} root @param {string} rel */
const readInput = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8')
