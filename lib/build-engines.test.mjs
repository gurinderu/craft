// The engine build (lib/build-engines.mjs): what the generated workflows/ holds, the refusal of an engine not in
// the bundled form, the freshness check the gate runs, and the release stamp that must land in both trees alike.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildAll, run } from './build-engines.mjs'
import { ROOT } from './repo-root.mjs'
import { loadTypescript } from './run-tsc.mjs'
import { versionStamp } from './workflow-version.mjs'

const ts = loadTypescript(ROOT)
// Without the compiler these skip locally; in CI they run and fail, so a missing install is never a green run.
const needsTs = ts || process.env['CI'] ? {} : { skip: true }
// Stryker rewrites lib/ in place while it runs: the build under mutation may write another workflows/.
const UNDER_STRYKER = process.env['STRYKER_MUTATOR_WORKER'] !== undefined

/** @param {Record<string, string>} files @returns {string} */
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-build-'))
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), body)
  }
  return root
}

const BUNDLED = {
  'lib/one.mjs': 'export const one = () => 1\n',
  'src/c.js': "import { one } from '../lib/one.mjs'\n\nexport const meta = { name: 'c' }\n\nexport async function __run() {\nreturn one()\n}\n",
}

/** @param {string} name @returns {string} */
const engine = name => `import { one } from '../lib/one.mjs'\n\nexport const meta = { name: '${name}' }\n\nexport async function __run() {\nreturn one()\n}\n`

test('the build writes workflows/ from src/, and --check fails naming each stale, missing or sourceless file', needsTs, async () => {
  const root = tree({ 'lib/one.mjs': BUNDLED['lib/one.mjs'], 'src/a.js': engine('a'), 'src/b.js': engine('b'), 'workflows/old.js': 'return 0\n' })
  try {
    const stale = await run(['--check'], process.env, root)
    assert.equal(stale.exitCode, 1)
    assert.deepEqual(stale.stderr.map(l => l.split(' ')[2]).sort(), ['workflows/a.js', 'workflows/a.js.map', 'workflows/b.js', 'workflows/b.js.map', 'workflows/old.js'])
    assert.ok(!fs.existsSync(path.join(root, 'workflows', 'a.js')), '--check writes nothing')

    assert.equal((await run([], process.env, root)).exitCode, 0)
    assert.deepEqual(fs.readdirSync(path.join(root, 'workflows')).sort(), ['a.js', 'a.js.map', 'b.js', 'b.js.map'], 'a sourceless engine is removed')
    const fresh = await run(['--check'], process.env, root)
    assert.equal(fresh.exitCode, 0, fresh.stderr.join('\n'))

    fs.appendFileSync(path.join(root, 'workflows', 'b.js'), 'return 2\n')
    const edited = await run(['--check'], process.env, root)
    assert.equal(edited.exitCode, 1)
    assert.match(edited.stderr.join('\n'), /workflows\/b\.js differs from a fresh build of src\/b\.js — edit src\/b\.js, never workflows\//)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('no engine in src/, or one not in the bundled form, fails the build and writes nothing', needsTs, async () => {
  const empty = tree({ 'src/.keep': '' })
  const refused = tree({ ...BUNDLED, 'src/a.js': "export const meta = { name: 'a' }\nreturn 1\n" })
  try {
    const none = await run([], process.env, empty)
    assert.equal(none.exitCode, 1)
    assert.match(none.stderr.join('\n'), /no \.js engines found/)
    const r = await run([], process.env, refused)
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr.join('\n'), /src\/a\.js: not in the bundled form/)
    assert.ok(!fs.existsSync(path.join(refused, 'workflows')))
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
    fs.rmSync(refused, { recursive: true, force: true })
  }
})

test('a bundled engine ships with its map beside it, and --check fails on a map stale, missing or without its engine', needsTs, async () => {
  const root = tree({ ...BUNDLED, 'src/a.js': engine('a') })
  try {
    assert.equal((await run([], process.env, root)).exitCode, 0)
    assert.deepEqual(fs.readdirSync(path.join(root, 'workflows')).sort(), ['a.js', 'a.js.map', 'c.js', 'c.js.map'])
    assert.match(fs.readFileSync(path.join(root, 'workflows', 'c.js'), 'utf8'), /\n\/\/# sourceMappingURL=c\.js\.map\n$/)
    const fresh = await run(['--check'], process.env, root)
    assert.equal(fresh.exitCode, 0, fresh.stderr.join('\n'))
    assert.match(fresh.stdout.join('\n'), /fresh build of src\/ \(2 engines\)/)

    fs.appendFileSync(path.join(root, 'workflows', 'c.js.map'), ' ')
    fs.writeFileSync(path.join(root, 'workflows', 'gone.js.map'), '{}')
    const stale = await run(['--check'], process.env, root)
    assert.equal(stale.exitCode, 1)
    assert.match(stale.stderr.join('\n'), /workflows\/c\.js\.map differs from a fresh build of src\/c\.js\.map/)
    assert.match(stale.stderr.join('\n'), /workflows\/gone\.js\.map has no source src\/gone\.js/)
    fs.rmSync(path.join(root, 'workflows', 'c.js.map'))
    assert.match((await run(['--check'], process.env, root)).stderr.join('\n'), /workflows\/c\.js\.map is missing/)
    assert.equal((await run([], process.env, root)).exitCode, 0)
    assert.ok(!fs.existsSync(path.join(root, 'workflows', 'gone.js.map')), 'a map without its engine is removed')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('with source maps switched off a bundled engine ships alone, linking no map', needsTs, async () => {
  const root = tree(BUNDLED)
  try {
    const { built, refusals } = await buildAll(root, /** @type {NonNullable<typeof ts>} */ (ts), false)
    assert.deepEqual(refusals, [])
    assert.deepEqual([...built.keys()], ['c.js'])
    assert.ok(!built.get('c.js')?.includes('sourceMappingURL'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a bundled engine the build refuses is reported among the refusals, the others still built', needsTs, async () => {
  const root = tree({ ...BUNDLED, 'src/d.js': "import fs from 'node:fs'\nexport const meta = { name: 'd' }\nexport async function __run() {\nreturn fs\n}\n" })
  try {
    const { built, refusals } = await buildAll(root, /** @type {NonNullable<typeof ts>} */ (ts))
    assert.deepEqual([...built.keys()].sort(), ['c.js', 'c.js.map'])
    assert.match(refusals.join('\n'), /^src\/d\.js: esbuild refused it — src\/d\.js imports 'node:fs'/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(UNDER_STRYKER)('the committed workflows/ is a fresh build of src/', needsTs, async () => {
  const r = await run(['--check'], process.env)
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
})

// release-please bumps CRAFT_VERSION by its `x-release-please-version` marker, in the files its config
// names, and commits no build. So it must name each stamped engine in both trees, and the stamp line must
// pass the build unchanged: then its edit of src/ and of workflows/ is itself a fresh build.
test('release-please bumps every stamped engine in src/ and workflows/ alike, and the stamp survives the build', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-please-config.json'), 'utf8'))
  /** @type {{ type: string, path: string }[]} */
  const extra = config.packages['.']['extra-files']
  const generic = new Set(extra.filter(e => e.type === 'generic').map(e => e.path))
  const stamped = fs.readdirSync(path.join(ROOT, 'src')).filter(f => f.endsWith('.js')).sort()
    .filter(f => versionStamp(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8')) !== null)
  assert.ok(stamped.length >= 4, `expected at least 4 stamped engines, got ${stamped.length}`)
  assert.deepEqual([...generic].sort(), stamped.flatMap(f => [`src/${f}`, `workflows/${f}`]).sort())
  for (const f of stamped) {
    /** @param {string} dir */
    const line = dir => fs.readFileSync(path.join(ROOT, dir, f), 'utf8').split('\n').filter(l => l.includes('x-release-please-version'))
    assert.equal(line('src').length, 1, `src/${f}: exactly one line carries the marker`)
    assert.deepEqual(line('workflows'), line('src'), `workflows/${f}: the stamp line is the source's`)
  }
})
