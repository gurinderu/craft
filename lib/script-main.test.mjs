import { afterEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { realOrResolved, runIfMain } from './script-main.mjs'

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

test('runIfMain: a script path that does not exist is not run, and does not throw', async () => {
  process.argv = [argv[0] ?? 'node', path.resolve('lib', 'no-such-dir', 'x.mjs')]
  assert.equal(await runIfMain(pathToFileURL(SCRIPT).href, () => Promise.reject(new Error('ran'))), false)
})

test('runIfMain: a script reached through a symlinked directory still runs and exits with its code', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-script-main-'))
  t.onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  const link = path.join(dir, 'checkout')
  fs.symlinkSync(process.cwd(), link, 'dir')
  const r = spawnSync(process.execPath, [path.join(link, 'lib', 'check-mutation-floor.mjs'), '--base', 'no-such-ref'], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.equal(r.stdout, '')
  assert.notEqual(r.stderr, '')
})

test('realOrResolved: a path that cannot be resolved to a real file is resolved as written', () => {
  assert.equal(realOrResolved('/nonexistent-craft/../nonexistent-craft/x.mjs'), path.resolve('/nonexistent-craft/x.mjs'))
  const here = path.dirname(new URL(import.meta.url).pathname)
  assert.equal(realOrResolved(here), fs.realpathSync(here))
})

// A throw the script does not catch must not take the lines it already said with it: they are written as
// they arise. A copy of the checker whose plugin manifest is unreadable throws after its parse lines.
test('runIfMain: lines a script said before an uncaught throw still reach the stream', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-script-throw-'))
  t.onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const sub of ['lib', 'workflows', '.claude-plugin']) fs.mkdirSync(path.join(dir, sub))
  for (const f of fs.readdirSync('lib').filter(f => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))) fs.copyFileSync(path.join('lib', f), path.join(dir, 'lib', f))
  fs.writeFileSync(path.join(dir, 'workflows', 'a.js'), 'export const meta = {}\n')
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{')
  const r = spawnSync(process.execPath, [path.join(dir, 'lib', 'check-workflows.mjs')], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stdout, /^ok {4}a\.js$/m)
  assert.match(r.stderr, /SyntaxError|JSON/)
})
