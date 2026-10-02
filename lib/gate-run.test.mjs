// The duplication gate, the engines' type check and the quality delta as commands, run in-process
// (realm @nick/craft, #172), with the child processes they launch replaced where the case allows.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run as checkDup } from './check-dup.mjs'
import { run as checkWorkflowTypes } from './check-workflow-types.mjs'
import { run as qualityDelta } from './quality-delta.mjs'

/** @param {Record<string, string>} files @returns {string} */
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-gate-'))
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), body)
  }
  return root
}

/** @param {unknown[]} dups @param {number} ceiling */
async function dupGate(dups, ceiling) {
  const root = tree({
    '.jscpd.json': JSON.stringify({ path: ['lib'], ignore: [] }),
    '.jscpd-baseline.json': JSON.stringify({ fingerprints: { a: 1 } }),
    'lib/dup-ceiling.json': JSON.stringify({ clones: ceiling }),
    'lib/x.mjs': 'export const x = 1\n',
  })
  try {
    return await checkDup([], process.env, root, (_root, out) => {
      fs.writeFileSync(path.join(out, 'jscpd-report.json'), JSON.stringify({ duplicates: dups }))
      return { status: 0 }
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test('check-dup: the baselined copy at its ceiling passes', async () => {
  const r = await dupGate([{ isNew: false }], 1)
  assert.equal(r.exitCode, 0)
  assert.deepEqual(r.stderr, [])
  assert.equal(r.stdout.length, 1)
})

test('check-dup: a new copy, or a ceiling the baseline does not meet, fails', async () => {
  for (const r of [await dupGate([{ isNew: false }, { isNew: true }], 1), await dupGate([{ isNew: false }], 2)]) {
    assert.equal(r.exitCode, 1)
    assert.equal(r.stderr.length, 1)
    assert.deepEqual(r.stdout, [], 'no all-clear line on a failure')
  }
})

// Stryker rewrites lib/ in place while it runs, and the engines' check reads it: the real tree fails then.
test.skipIf(process.env['STRYKER_MUTATOR_WORKER'] !== undefined)('check-workflow-types: the real engines pass', async () => {
  const real = await checkWorkflowTypes([], process.env)
  assert.equal(real.exitCode, 0, real.stderr.join('\n'))
  assert.equal(real.stdout.length, 1)
})

test('check-workflow-types: no engines at all fails', async () => {
  const root = tree({ 'workflows/.keep': '' })
  try {
    const r = await checkWorkflowTypes([], process.env, root)
    assert.equal(r.exitCode, 1)
    assert.equal(r.stderr.length, 1)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

const MEASURE = /** @type {import('./quality-measure.mjs').Measure} */ ({
  complexity: { status: 'ok', value: { total: 10, functions: [], bar: 10 } },
  engines: { status: 'ok', value: { total: 4, functions: [] } },
  cognitive: { status: 'not-measured', reason: 'x' },
  lint: { status: 'ok', value: 0 },
  types: { status: 'ok', value: 0 },
  engineChecks: { status: 'ok', value: 0 },
  tests: { status: 'ok', value: { passed: 5, failed: 0, skipped: 0 } },
  knip: { status: 'ok', value: { files: [], exports: [], dependencies: [], other: [] } },
  cycles: { status: 'not-measured', reason: 'x' },
})

test('quality-delta: measures --base then --head and prints the summary, timed by the clock', async () => {
  /** @type {string[]} */
  const measured = []
  const clock = [1000, 61000]
  const r = await qualityDelta(['--head', 'h', '--base', 'b'], process.env, async dir => { measured.push(dir); return MEASURE }, () => clock.shift() ?? 0)
  assert.equal(r.exitCode, 0)
  assert.deepEqual(measured, [path.resolve('b'), path.resolve('h')])
  assert.deepEqual(r.stderr, [])
  assert.match(r.stdout.join('\n'), /\b60s\b/, 'the two measurements took 60 s on the injected clock')
  assert.ok(!r.stdout.join('\n').endsWith('\n'), 'one trailing newline, added when printed')
})

test('quality-delta: bad usage is refused with exit 2 and nothing measured', async () => {
  for (const argv of [[], ['--base', 'a'], ['--base', 'a', '--nope', 'b'], ['--base', 'a', '--head'], ['--base', '', '--head', 'h']]) {
    let measured = 0
    const r = await qualityDelta(argv, process.env, async () => { measured++; return MEASURE })
    assert.equal(r.exitCode, 2, argv.join(' '))
    assert.equal(measured, 0)
    assert.equal(r.stderr.length, 1)
    assert.deepEqual(r.stdout, [])
  }
})
