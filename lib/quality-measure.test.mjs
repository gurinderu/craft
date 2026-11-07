import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import sonarjs from 'eslint-plugin-sonarjs'
import { defaultDeps, measureCheckout } from './quality-measure.mjs'
import { wrapWorkflow } from './check-workflow-types.mjs'

/** @typedef {import('./quality-result.mjs').Deps} Deps */
/** @typedef {import('./quality-result.mjs').EslintCtor} EslintCtor */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A fresh empty directory with the files given. @param {Record<string, string>} [files] */
function scratch(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-'))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}

test('defaultDeps.run: stdout and stderr as text, the status, the cwd, the env without the step summary', () => {
  const dir = scratch()
  const saved = process.env['GITHUB_STEP_SUMMARY']
  process.env['GITHUB_STEP_SUMMARY'] = '/summary'
  process.env['QM_PROBE'] = 'seen'
  try {
    const script = 'process.stdout.write(JSON.stringify([process.cwd(), process.env.QM_PROBE, process.env.GITHUB_STEP_SUMMARY ?? null]) + "x".repeat(4096));'
      + 'process.stderr.write("err");process.exitCode = 3'
    const r = defaultDeps.run(process.execPath, ['-e', script], dir)
    assert.equal(r.status, 3)
    assert.equal(r.stderr, 'err')
    assert.equal(r.stdout, JSON.stringify([fs.realpathSync(dir), 'seen', null]) + 'x'.repeat(4096))
    assert.equal('error' in r, false)
  } finally {
    if (saved === undefined) delete process.env['GITHUB_STEP_SUMMARY']
    else process.env['GITHUB_STEP_SUMMARY'] = saved
    delete process.env['QM_PROBE']
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('defaultDeps.run: a command that cannot start is an error with empty output, not a throw', () => {
  const r = defaultDeps.run('qm-no-such-command', [], os.tmpdir())
  assert.deepEqual({ ...r, error: typeof r.error === 'string' && r.error.includes('ENOENT') },
    { status: null, stdout: '', stderr: '', error: true })
})

test('defaultDeps loads the checkout\'s own ESLint, sonarjs and wrapper; null where it has none', async () => {
  const empty = scratch()
  try {
    assert.equal(await defaultDeps.loadEslint(ROOT), ESLint)
    assert.equal(await defaultDeps.loadSonar(ROOT), sonarjs)
    assert.equal(await defaultDeps.loadWrapper(ROOT), wrapWorkflow)
    assert.equal(await defaultDeps.loadEslint(empty), null)
    assert.equal(await defaultDeps.loadSonar(empty), null)
    assert.equal(await defaultDeps.loadWrapper(empty), null)
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
  }
})

test('defaultDeps.loadWrapper: a wrapper file without a wrapWorkflow function is no wrapper', async () => {
  const dir = scratch({ 'lib/check-workflow-types.mjs': 'export const wrapWorkflow = 1\n' })
  try {
    assert.equal(await defaultDeps.loadWrapper(dir), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** @param {Partial<Deps>} over @returns {Deps} */
const deps = over => ({
  run: () => { throw new Error('no command expected') },
  loadEslint: async () => null,
  loadSonar: async () => null,
  loadWrapper: async () => null,
  ...over,
})

test('measureCheckout: a measure that throws fails alone, with the error as its reason', async () => {
  const dir = scratch({
    'package.json': JSON.stringify({ scripts: { lint: 'eslint src', 'check:types': 'tsc', test: 'vitest run' } }),
    'src/a.mjs': 'export const a = 1\n',
  })
  // lintFiles answering null makes the ESLint measure throw past its own guards.
  const Broken = /** @type {EslintCtor} */ (/** @type {unknown} */ (class {
    async lintFiles() { return null }
    async lintText() { return [] }
    async calculateConfigForFile() { return {} }
  }))
  try {
    const m = await measureCheckout(dir, deps({ loadEslint: async () => Broken }))
    const thrown = /** @type {const} */ ({ status: 'failed', reason: 'no command expected' })
    assert.deepEqual(m.types, thrown)
    assert.deepEqual(m.engineChecks, thrown)
    assert.deepEqual(m.tests, thrown)
    assert.deepEqual(m.knip, { status: 'not-measured', reason: 'knip not installed in the checkout' })
    assert.deepEqual(m.cycles, { status: 'not-measured', reason: 'dependency-cruiser not in the repo' })
    assert.match(m.complexity.status === 'failed' ? m.complexity.reason : '', /not iterable/)
    for (const k of /** @type {const} */ (['cognitive', 'lint', 'engines'])) assert.equal(m[k], m.complexity, k)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
