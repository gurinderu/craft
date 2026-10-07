// The engine build (lib/build-engines.mjs): what the generated workflows/ keeps and drops, the refusal of a
// strip that changes the program, the freshness check the gate runs, and the release stamp that must land in
// both trees alike.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildEngine, run } from './build-engines.mjs'
import { ROOT } from './inline-regions.mjs'
import { loadTypescript } from './run-tsc.mjs'
import { versionStamp } from './workflow-version.mjs'

const ts = loadTypescript(ROOT)
// Without the compiler these skip locally; in CI they run and fail, so a missing install is never a green run.
const needsTs = ts || process.env['CI'] ? {} : { skip: true }
// Stryker rewrites lib/ in place while it runs: the strip under mutation may build another workflows/.
const UNDER_STRYKER = process.env['STRYKER_MUTATOR_WORKER'] !== undefined

const SOURCE = [
  'export const meta = { name: \'x\' }',
  '// a comment about the engine',
  '',
  '// >>> craft-inline lib/path-segments.mjs pathSegments',
  '/** @param {string} p @returns {string[]} */',
  'function pathSegments(p) { return p.split(\'/\') }',
  '// <<< craft-inline',
  '',
  '// @ts-expect-error a directive stays',
  'const CRAFT_VERSION = \'1.0.0\' // x-release-please-version',
  'return pathSegments(args) // a trailing comment stays',
  '',
].join('\n')

test('an engine ships without its whole-line comments and fences, its JSDoc, directives and stamp kept', needsTs, () => {
  const out = buildEngine(/** @type {NonNullable<typeof ts>} */ (ts), SOURCE, 'src/x.js')
  assert.equal(out, [
    'export const meta = { name: \'x\' }',
    '',
    '/** @param {string} p @returns {string[]} */',
    'function pathSegments(p) { return p.split(\'/\') }',
    '',
    '// @ts-expect-error a directive stays',
    'const CRAFT_VERSION = \'1.0.0\' // x-release-please-version',
    'return pathSegments(args) // a trailing comment stays',
    '',
  ].join('\n'))
  assert.equal(versionStamp(out), versionStamp(SOURCE))
})

test('an engine whose strip would change its program is refused, naming it', needsTs, () => {
  const inString = 'const p = `first\n// not a comment: prompt text\nlast`\nreturn p\n'
  assert.throws(() => buildEngine(/** @type {NonNullable<typeof ts>} */ (ts), inString, 'src/x.js'), /^Error: src\/x\.js: dropping its whole-line/)
})

/** @param {Record<string, string>} files @returns {string} */
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-build-'))
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), body)
  }
  return root
}

test('the build writes workflows/ from src/, and --check fails naming each stale, missing or sourceless file', needsTs, async () => {
  const root = tree({ 'src/a.js': SOURCE, 'src/b.js': 'return 1\n', 'workflows/old.js': 'return 0\n' })
  try {
    const stale = await run(['--check'], process.env, root)
    assert.equal(stale.exitCode, 1)
    assert.deepEqual(stale.stderr.map(l => l.split(' ')[2]).sort(), ['workflows/a.js', 'workflows/b.js', 'workflows/old.js'])
    assert.ok(!fs.existsSync(path.join(root, 'workflows', 'a.js')), '--check writes nothing')

    assert.equal((await run([], process.env, root)).exitCode, 0)
    assert.deepEqual(fs.readdirSync(path.join(root, 'workflows')).sort(), ['a.js', 'b.js'], 'a sourceless engine is removed')
    const fresh = await run(['--check'], process.env, root)
    assert.equal(fresh.exitCode, 0, fresh.stderr.join('\n'))

    fs.appendFileSync(path.join(root, 'workflows', 'b.js'), 'return 2\n')
    const edited = await run(['--check'], process.env, root)
    assert.equal(edited.exitCode, 1)
    assert.match(edited.stderr.join('\n'), /workflows\/b\.js differs from a fresh build of src\/b\.js — edit src\/b\.js, never workflows\//)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('no engine in src/, or one the strip refuses, fails the build and writes nothing', needsTs, async () => {
  const empty = tree({ 'src/.keep': '' })
  const refused = tree({ 'src/a.js': 'const p = `x\n// y\nz`\nreturn p\n' })
  try {
    const none = await run([], process.env, empty)
    assert.equal(none.exitCode, 1)
    assert.match(none.stderr.join('\n'), /no \.js engines found/)
    const r = await run([], process.env, refused)
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr.join('\n'), /src\/a\.js: dropping its whole-line/)
    assert.ok(!fs.existsSync(path.join(refused, 'workflows')))
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
    fs.rmSync(refused, { recursive: true, force: true })
  }
})

test.skipIf(UNDER_STRYKER)('the committed workflows/ is a fresh build of src/', needsTs, async () => {
  const r = await run(['--check'], process.env)
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
})

// release-please bumps CRAFT_VERSION by its `x-release-please-version` marker, in the files its config
// names, and commits no build. So it must name each stamped engine in both trees, and the stamp line must
// pass the strip unchanged: then its edit of src/ and of workflows/ is itself a fresh build.
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
