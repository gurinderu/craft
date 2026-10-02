import { afterEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runIfMain } from './script-main.mjs'

const SCRIPT = path.resolve('lib', 'some-script.mjs')
const argv = process.argv
const exitCode = process.exitCode

afterEach(() => {
  process.argv = argv
  process.exitCode = exitCode
  vi.restoreAllMocks()
})

test('runIfMain: an imported module is not run', async () => {
  let called = false
  const ran = await runIfMain(pathToFileURL(SCRIPT).href, () => { called = true; return Promise.resolve({ exitCode: 1, stdout: [], stderr: [] }) })
  assert.equal(ran, false)
  assert.equal(called, false)
})

test('runIfMain: no script path (node -e, a REPL) is not run', async () => {
  process.argv = [argv[0] ?? 'node']
  assert.equal(await runIfMain(pathToFileURL(SCRIPT).href, () => Promise.reject(new Error('ran'))), false)
})

test('runIfMain: the script Node was given runs on the arguments after it, prints its lines, sets the exit code', async () => {
  process.argv = [argv[0] ?? 'node', path.relative(process.cwd(), SCRIPT), '--base', 'x']
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  /** @type {unknown[]} */
  const seen = []
  const ran = await runIfMain(pathToFileURL(SCRIPT).href, (a, env) => {
    seen.push(a, env)
    return Promise.resolve({ exitCode: 3, stdout: ['o1', 'o2'], stderr: ['e1'] })
  })
  const code = process.exitCode
  process.exitCode = exitCode
  assert.equal(ran, true)
  assert.deepEqual(seen, [['--base', 'x'], process.env])
  assert.deepEqual(out.mock.calls, [['o1'], ['o2']])
  assert.deepEqual(err.mock.calls, [['e1']])
  assert.equal(code, 3)
})

test('runIfMain: from the command line, a script exits with its run\'s code', () => {
  const r = spawnSync(process.execPath, [path.resolve('lib', 'check-mutation-floor.mjs'), '--base', 'no-such-ref'], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /^FAIL the base no-such-ref is not a commit/m)
  assert.equal(r.stdout, '')
})
