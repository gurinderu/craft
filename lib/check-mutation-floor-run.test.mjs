// The command line of lib/check-mutation-floor.mjs, through its `run` (realm @nick/craft, #172): what CI's
// `test` job reads is the exit code and the lines, so they are pinned here, not only the problems list.
import { onTestFinished, test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './check-mutation-floor.mjs'

const FLOOR = { break: 70, mutate: ['lib/**/*.mjs', '!lib/**/*.test.mjs'] }
const CONFIG = `import fs from 'node:fs'
const f = JSON.parse(fs.readFileSync(new URL('./lib/mutation-floor.json', import.meta.url), 'utf8'))
export default { mutate: f.mutate, thresholds: { break: f.break } }
`

/** @param {string} cwd @param {string[]} args @returns {string} */
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/**
 * A repo whose one commit holds `baseFloorText` as the floor file and whose working tree holds a good floor.
 * @param {string} baseFloorText @returns {{ root: string, base: string }}
 */
function repo(baseFloorText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-floor-run-'))
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'lib'))
  git(root, ['init', '-q'])
  fs.writeFileSync(path.join(root, 'stryker.config.mjs'), CONFIG)
  fs.writeFileSync(path.join(root, 'lib', 'mutation-floor.json'), baseFloorText)
  git(root, ['add', '.'])
  git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'])
  fs.writeFileSync(path.join(root, 'lib', 'mutation-floor.json'), JSON.stringify(FLOOR))
  return { root, base: git(root, ['rev-parse', 'HEAD']) }
}

test('run: a floor that holds against --base exits 0 and names the base', async () => {
  const { root, base } = repo(JSON.stringify(FLOOR))
  assert.deepEqual(await run(['--base', base], {}, root), {
    exitCode: 0,
    stdout: [`check-mutation-floor: neither the floor nor what it is measured over falls against ${base}`],
    stderr: [],
  })
})

test('run: without --base it checks the file and the config only, and says nothing was compared', async () => {
  const { root } = repo(JSON.stringify(FLOOR))
  assert.deepEqual(await run([], {}, root), {
    exitCode: 0,
    stdout: ['check-mutation-floor: stryker.config.mjs applies the well-formed floor file (no --base given, nothing compared)'],
    stderr: [],
  })
})

test('run: a --base that is no commit, or a --base with no ref after it, exits 1 naming the base', async () => {
  const { root } = repo(JSON.stringify(FLOOR))
  const bad = await run(['--base', 'no-such-ref'], {}, root)
  assert.deepEqual(bad, { exitCode: 1, stdout: [], stderr: ['FAIL the base no-such-ref is not a commit in this repository — fetch it first'] })
  const empty = await run(['--base'], {}, root)
  assert.equal(empty.exitCode, 1)
  assert.deepEqual(empty.stderr, ['FAIL the base  is not a commit in this repository — fetch it first'])
})

test('run: a missing floor file exits 1 naming the file', async () => {
  const { root } = repo(JSON.stringify(FLOOR))
  fs.rmSync(path.join(root, 'lib', 'mutation-floor.json'))
  const r = await run([], {}, root)
  assert.equal(r.exitCode, 1)
  assert.deepEqual(r.stdout, [])
  assert.equal(r.stderr.length, 1)
  assert.match(r.stderr[0] ?? '', /^FAIL ENOENT: .*lib\/mutation-floor\.json'$/)
})

test('run: a malformed floor file exits 1 with the form it must have', async () => {
  const { root } = repo(JSON.stringify(FLOOR))
  fs.writeFileSync(path.join(root, 'lib', 'mutation-floor.json'), '{ "break": 70, "mutate": [""] }')
  const r = await run([], {}, root)
  assert.equal(r.exitCode, 1)
  assert.deepEqual(r.stdout, [])
  assert.equal(r.stderr.length, 1)
  assert.match(r.stderr[0] ?? '', /^FAIL lib\/mutation-floor\.json must be /)
})

test('run: a malformed floor file on the base fails, saying it is the base\'s', async () => {
  const { root, base } = repo('{ "break": 70 }')
  const r = await run(['--base', base], {}, root)
  assert.equal(r.exitCode, 1)
  assert.equal(r.stderr.length, 1)
  assert.match(r.stderr[0] ?? '', new RegExp(`^FAIL on the base ${base}: lib/mutation-floor\\.json must be `))
})

test('run: a lowered floor exits 1 with the problem on stderr, nothing on stdout', async () => {
  const { root, base } = repo(JSON.stringify({ ...FLOOR, break: 75 }))
  const r = await run(['--base', base], {}, root)
  assert.equal(r.exitCode, 1)
  assert.deepEqual(r.stdout, [])
  assert.match(r.stderr[0] ?? '', /^FAIL .*from 75 to 70/)
})
