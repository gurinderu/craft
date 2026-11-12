// The OpenCode 2.x package: what `opencode plugin add git+https://github.com/gurinderu/craft#opencode-v<X.Y.Z>`
// installs (realm @nick/craft, node #515; the install surface observed on 2.2.7, #514). 2.x installs a git package
// with npm's Arborist and scripts off, and refuses one whose package.json has a `prepare` script — the repository
// root has one — so each release lays out a tree of its own with a package.json and no scripts
// (lib/materialize-opencode.mjs commits it). The tree keeps the checkout's relative layout
// (integrations/opencode/plugin/…, lib/…, skills/…), so the plugin's `../../../lib/` imports and the craft binary's
// plugin_path lookups resolve in it as they do in a checkout. 1.x keeps install.sh (#497, #498).
import fs from 'node:fs'
import path from 'node:path'
import { parseJsonObject } from './json-object.mjs'
import { copyDereferenced } from './materialize-claude-code.mjs'
import { shrinkwrapOf } from './opencode-shrinkwrap.mjs'

// The plugin reads this name in the package root to know it runs from the package (plugin/package-content.ts).
export const PACKAGE_NAME = 'craft-opencode'
const PLUGIN = 'integrations/opencode/plugin'
export const EXPORTS = { './server': `./${PLUGIN}/index.ts`, './tui': `./${PLUGIN}/tui/tui.mjs` }
// The lib/ scripts the craft binary runs from the plugin root: the run-record adapter and `craft init`'s discovery.
const BINARY_SCRIPTS = ['lib/cli-review-file.mjs', 'lib/craft-externals.mjs']
// The skills install.sh leaves out too: they drive the review through Claude Code's Workflow tool and `codex exec`.
export const SKIPPED_SKILLS = ['develop', 'codex-review']
// Read whole at run time: the review's content, OpenCode's agents and commands, and the Claude Code agents whose
// prompts the binary puts before a task (its rubric_of reads `<root>/integrations/claude-code/agents`).
const TREES = ['content', 'integrations/opencode/agents', 'integrations/opencode/commands', 'integrations/claude-code/agents']
// The binary takes CRAFT_ROOT (bin/craft sets it to the package root) as a plugin root only when a Claude Code
// manifest is there or under integrations/claude-code (cli prompts.rs plugin_root_at), and reads the plugin version
// from it: without it `review run` stops at "no craft plugin root is known".
const FILES = ['bin/craft', 'integrations/claude-code/.claude-plugin/plugin.json']
// A `lib/<name>.mjs` a shipped skill, agent or command tells the model to run.
const LIB_SCRIPT = /\blib\/[\w.-]+\.mjs\b/g

/**
 * The relative module specifiers `text` names: static imports and re-exports (not type-only ones, which compile
 * away) and literal dynamic `import()`s, JSDoc ones included.
 * @param {string} text @returns {string[]}
 */
export function importsOf(text) {
  const out = []
  // The clause between the keyword and `from` is an import clause only — names, braces, commas, `*`, `as` — so the
  // match stays inside one statement: a type-only `export type X = …` cannot reach a later import's specifier.
  for (const m of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[\w$*\s{},]*?\sfrom\s*)?['"]([^'"]+)['"]/gm)) if (!m[1]) out.push(m[2] ?? '')
  for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1] ?? '')
  return out.filter(s => s.startsWith('.'))
}

/**
 * `spec` from the file `from` (both relative to `root`): the file itself, or the declaration file a `.js` type
 * import names. Throws when neither is there, so a module the package needs is never silently left out.
 * @param {string} root @param {string} from @param {string} spec @returns {string}
 */
function resolveIn(root, from, spec) {
  const rel = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))
  for (const candidate of [rel, rel.replace(/\.js$/, '.d.ts')])
    if (fs.statSync(path.join(root, candidate), { throwIfNoEntry: false })?.isFile()) return candidate
  throw new Error(`${from} imports ${spec}, which is not in the checkout`)
}

/**
 * Every file the `entries` reach through relative imports, the entries included, relative to `root`.
 * @param {string} root @param {string[]} entries @returns {string[]}
 */
export function moduleClosure(root, entries) {
  const seen = new Set(entries)
  const queue = [...entries]
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const spec of importsOf(fs.readFileSync(path.join(root, file), 'utf8'))) {
      const next = resolveIn(root, file, spec)
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return [...seen].sort()
}

/** @param {string} root @param {string} dir @returns {string[]} every file under `dir`, relative to `root` */
function filesUnder(root, dir) {
  return fs
    .readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })
    .filter(e => !e.isDirectory())
    .map(e => path.posix.join(path.relative(root, e.parentPath).split(path.sep).join('/'), e.name))
}

/** @param {string} root @returns {string[]} the skill files OpenCode gets, every file of each skill directory */
function skillFiles(root) {
  return fs
    .readdirSync(path.join(root, 'skills'), { withFileTypes: true })
    .filter(e => e.isDirectory() && !SKIPPED_SKILLS.includes(e.name) && fs.existsSync(path.join(root, 'skills', e.name, 'SKILL.md')))
    .flatMap(e => filesUnder(root, `skills/${e.name}`))
}

/**
 * Every file the package carries, relative to `root`, sorted.
 * @param {string} root @returns {string[]}
 */
export function packageFiles(root) {
  const content = [...TREES.flatMap(d => filesUnder(root, d)), ...skillFiles(root)]
  const modules = moduleClosure(root, [...Object.values(EXPORTS).map(e => e.slice(2)), ...BINARY_SCRIPTS, ...scriptsNamed(root, content)])
  return [...new Set([...modules, ...content, ...FILES])].sort()
}

/**
 * The `lib/*.mjs` scripts the Markdown among `files` names (relative to `root`), sorted.
 * @param {string} root @param {string[]} files @returns {string[]}
 */
export function scriptsNamed(root, files) {
  const named = files.filter(f => f.endsWith('.md')).flatMap(f => [...fs.readFileSync(path.join(root, f), 'utf8').matchAll(LIB_SCRIPT)].map(m => m[0]))
  return [...new Set(named)].sort()
}

/**
 * The package's own package.json: the plugin's production dependencies at their pinned versions, its two entries,
 * and no scripts — 2.x refuses a git package that has a `prepare`, and installs with scripts off anyway.
 * @param {string} root @param {string} version @returns {Record<string, unknown>}
 */
export function packageJson(root, version) {
  /** @type {{ dependencies?: Record<string, string> }} */
  const plugin = parseJsonObject(fs.readFileSync(path.join(root, PLUGIN, 'package.json'), 'utf8'))
  const top = [...new Set(packageFiles(root).map(f => f.split('/')[0] ?? f))].sort()
  return {
    name: PACKAGE_NAME,
    version,
    description: "craft's skills, review agents and review for OpenCode 2.x.",
    license: 'MIT',
    type: 'module',
    exports: EXPORTS,
    files: [...top, 'npm-shrinkwrap.json'],
    dependencies: plugin.dependencies,
  }
}

/**
 * The package's npm-shrinkwrap.json: the plugin lockfile's production closure (lib/opencode-shrinkwrap.mjs).
 * @param {string} root @param {Record<string, unknown>} pkg  the package.json @returns {Record<string, unknown>}
 */
function shrinkwrap(root, pkg) {
  const lock = fs.readFileSync(path.join(root, PLUGIN, 'package-lock.json'), 'utf8')
  return shrinkwrapOf(lock, PACKAGE_NAME, String(pkg['version']), /** @type {Record<string, string>} */ (pkg['dependencies'] ?? {}))
}

/** @param {string} root @returns {string} the release version, release-please's manifest's */
export function releaseVersion(root) {
  /** @type {Record<string, string | undefined>} */
  const manifest = parseJsonObject(fs.readFileSync(path.join(root, '.release-please-manifest.json'), 'utf8'))
  const version = manifest['.']
  if (!version) throw new Error('.release-please-manifest.json names no version for "."')
  return version
}

/**
 * The package laid out under `into`. @param {string} root @param {string} into  an empty directory
 * @returns {string} the package's root
 */
export function layPackage(root, into) {
  const out = path.join(into, 'opencode')
  for (const file of packageFiles(root)) {
    fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true })
    copyDereferenced(path.join(root, file), path.join(out, file))
  }
  const pkg = packageJson(root, releaseVersion(root))
  fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  fs.writeFileSync(path.join(out, 'npm-shrinkwrap.json'), `${JSON.stringify(shrinkwrap(root, pkg), null, 2)}\n`)
  return out
}
