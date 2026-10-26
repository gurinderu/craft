// The bundled build of one engine (lib/engine-bundle.mjs): the banner lifted verbatim, the footer, the map, and
// each refusal — a meta that is not a literal, an import outside lib/, a name esbuild made up.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as esbuild from 'esbuild'
import { bundleEngine, FOOTER } from './engine-bundle.mjs'
import { sandboxFunction } from './engine-harness.mjs'
import { ROOT } from './inline-regions.mjs'
import { loadTypescript } from './run-tsc.mjs'
import { versionStamp } from './workflow-version.mjs'

const ts = loadTypescript(ROOT)
const needsTs = ts || process.env['CI'] ? {} : { skip: true }

const META = "export const meta = {\n  name: 'x',\n  phases: [{ title: 'Run', n: -1, on: true, none: null }],\n}"
const STAMP = "const CRAFT_VERSION = '1.2.3' // x-release-please-version"
const LIB = "/** @param {string} s */\nexport function shout(s) { return `${s}!` }\nexport function unused() { return 0 }\n"

/** @param {string} body @param {Record<string, string>} [lib] */
function engine(body, lib = { 'lib/a.mjs': LIB }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-bundle-'))
  for (const [rel, text] of Object.entries({ ...lib, 'src/x.js': body })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  return root
}

const SOURCE = `import { shout } from '../lib/a.mjs'\n\n${META}\n\n${STAMP}\n\n// what the body does\nexport async function __run() {\nlog(CRAFT_VERSION)\nreturn shout(String(args))\n}\n`

/** @param {string} source @param {boolean} [maps] */
async function build(source, maps = true) {
  const root = engine(source)
  try { return await bundleEngine({ esbuild, ts: /** @type {NonNullable<typeof ts>} */ (ts), root, file: 'src/x.js', source, maps }) }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test('a bundled engine opens with meta and the stamp verbatim, ends calling __run, and links its map', needsTs, async () => {
  const { js, map } = await build(SOURCE)
  assert.ok(js.startsWith(`${META}\n${STAMP}\n`), js.slice(0, 200))
  assert.equal(versionStamp(js), '1.2.3')
  assert.ok(js.endsWith(`${FOOTER}//# sourceMappingURL=x.js.map\n`))
  assert.ok(!/\bunused\b/.test(js), 'what nothing calls is shaken out')
  assert.ok(!js.includes('what the body does'), 'comments are gone')
  assert.deepEqual(JSON.parse(/** @type {string} */ (map)).sources, ['../lib/a.mjs', '../src/x.js'])
  const logged = /** @type {string[]} */ ([])
  const run = sandboxFunction(js.replace(/^export const meta/m, 'const meta'))
  assert.equal(await run('hi', null, null, null, null, (/** @type {string} */ m) => logged.push(m)), 'hi!')
  assert.deepEqual(logged, ['1.2.3'])
})

test('without maps the bundle carries no map and no sourceMappingURL line', needsTs, async () => {
  const { js, map } = await build(SOURCE, false)
  assert.equal(map, null)
  assert.ok(js.endsWith(FOOTER) && !js.includes('sourceMappingURL'))
})

test('a meta that is not a pure literal is refused, naming the engine, the line and the expression', needsTs, async () => {
  await assert.rejects(build(SOURCE.replace("name: 'x'", 'name: `x${1}`')), /^Error: src\/x\.js:4: meta is not a pure literal \(``x\$\{1\}``\)/)
  await assert.rejects(build(SOURCE.replace("name: 'x'", "name: 'x', ...{}")), /src\/x\.js:\d+: meta is not a pure literal \(`\.\.\.\{\}`\)/)
  await assert.rejects(build(SOURCE.replace('export const meta', 'const meta')), /src\/x\.js: meta must be declared alone as `export const meta/)
  await assert.rejects(build(SOURCE.replace('export const meta', 'export const other')), /src\/x\.js: no top-level `export const meta/)
})

test('a stamp that is not one line of its own is refused', needsTs, async () => {
  await assert.rejects(build(SOURCE.replace(STAMP, STAMP.replace("'1.2.3'", "'1.2.3'; const y = 1"))), /src\/x\.js:\d+: the CRAFT_VERSION stamp must be one line/)
})

test('an import of a package, a built-in or a file outside lib/ is refused, naming it', needsTs, async () => {
  for (const spec of ['node:fs', 'esbuild', './y.js']) {
    await assert.rejects(build(`import '${spec}'\n${SOURCE}`), new RegExp(`src/x\\.js: esbuild refused it — src/x\\.js imports '${spec.replace(/[.]/g, '\\.')}': an engine imports only lib/ modules`))
  }
})

test('a binding esbuild renames is refused, naming the name it made up', needsTs, async () => {
  // Two top-level `helper`s, one in lib/a.mjs and one in the engine, meet in one bundle scope: esbuild renames one.
  const lib = { 'lib/a.mjs': "function helper() { return '?' }\n/** @param {string} s */\nexport function shout(s) { return s + helper() }\n" }
  const source = SOURCE.replace('export async function __run() {', "function helper() { return '!' }\nexport async function __run() {\nlog(helper())")
  const root = engine(source, lib)
  try {
    await assert.rejects(bundleEngine({ esbuild, ts: /** @type {NonNullable<typeof ts>} */ (ts), root, file: 'src/x.js', source, maps: true }),
      /src\/x\.js: the bundle spells `helper2`, a name none of its sources spells/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('an engine exporting more than meta and __run is refused', needsTs, async () => {
  await assert.rejects(build(`${SOURCE}export const extra = 1\n`), /does not end in `export\{__run\};`/)
})

test('only the entry is read blanked: a lib/ module whose name the load filter matches keeps its text', needsTs, async () => {
  const lib = { 'lib/a.mjs': LIB, 'lib/b.js': "export function tag() { return 'from lib/b.js' }\n" }
  const source = SOURCE.replace("import { shout } from '../lib/a.mjs'", "import { shout } from '../lib/a.mjs'\nimport { tag } from '../lib/b.js'").replace('log(CRAFT_VERSION)', 'log(tag())')
  const root = engine(source, lib)
  try {
    const { js } = await bundleEngine({ esbuild, ts: /** @type {NonNullable<typeof ts>} */ (ts), root, file: 'src/x.js', source, maps: false })
    const logged = /** @type {string[]} */ ([])
    const run = sandboxFunction(js.replace(/^export const meta/m, 'const meta'))
    assert.equal(await run('hi', null, null, null, null, (/** @type {string} */ m) => logged.push(m)), 'hi!')
    assert.deepEqual(logged, ['from lib/b.js'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
