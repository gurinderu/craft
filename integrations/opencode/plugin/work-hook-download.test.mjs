// The absent-binary path (realm @nick/craft, #550): count wrapper dispatches, not HTTP requests.
import { afterEach, beforeEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { workHook } from './work-hook.ts'
import { v1WorkHooks } from './host-v1.ts'
import { writeExecutable } from '../../../lib/write-executable.mjs'

vi.mock('node:child_process', async importOriginal => {
  const actual = /** @type {typeof import('node:child_process')} */ (await importOriginal())
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
const actual = /** @type {typeof import('node:child_process')} */ (await vi.importActual('node:child_process'))
const ROOT = path.resolve(import.meta.dirname, '../../..')
const WRAPPER = path.join(ROOT, 'bin/craft')
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, '.release-please-manifest.json'), 'utf8'))['.']
/** @type {string[]} */
let made = []
/** @type {{ child: import('node:child_process').ChildProcess, done: Promise<number | null>, held: boolean }[]} */
let children = []
let stubDownload = true

beforeEach(() => {
  made = []
  children = []
  stubDownload = true
  // Pin only the hook's clock, leaving process events and timers real.
  vi.spyOn(Date, 'now').mockReturnValue(0)
  vi.mocked(spawn)
    .mockReset()
    .mockImplementation((command, args, options) => {
      const held = stubDownload && args.includes('--background')
      const child = held ? actual.spawn('sh', ['-c', 'read -r release'], { stdio: ['pipe', 'ignore', 'ignore'] }) : actual.spawn(command, args, options)
      children.push({ child, held, done: new Promise(resolve => child.once('close', resolve)) })
      return child
    })
})
afterEach(async () => {
  for (const { child, held } of children) if (held) child.stdin?.end('\n')
  await Promise.all(children.map(({ done }) => done))
  vi.restoreAllMocks()
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-oc-download-')))
  made.push(dir)
  return dir
}
/** @param {Record<string, string>} files @param {Record<string, string>} [more] */
function setup(files, more = {}) {
  const root = tmp()
  const home = tmp()
  const shim = tmp()
  fs.mkdirSync(path.join(root, '.git'))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  writeExecutable(path.join(shim, 'curl'), '#!/bin/sh\necho unexpected >> "$HOME/http"\nexit 22\n')
  const env = { PATH: `${shim}:/usr/bin:/bin`, CRAFT_RELEASE_BASE: 'file:///nonexistent', ...more }
  const hooks = v1WorkHooks(workHook(root, new Set(), home, env))
  const message = /** @type {(input: any, output: any) => Promise<void>} */ (hooks['chat.message'])
  const send = async () => {
    const out = { message: {}, parts: [{ id: 'p', sessionID: 's', messageID: 'm', type: 'text', text: 'review' }] }
    await message({ sessionID: 's' }, out)
    return out.parts
  }
  return { home, shim, env, send }
}

const launches = () => vi.mocked(spawn).mock.calls.filter(([, args]) => args.includes('--background'))
const roles = { '.claude/agents/dev.md': '' }
test.each([
  { name: 'role signs', files: roles, more: {}, count: 1 },
  { name: 'no role signs', files: { 'AGENTS.md': '# Build\nnpm test\n' }, more: {}, count: 0 },
  { name: 'environment switch off', files: roles, more: { CRAFT_ROLE_HOOK: '0' }, count: 0 },
  { name: 'repo switch off', files: { ...roles, 'CLAUDE.md': 'craft-role-hook: off\n' }, more: {}, count: 0 },
])('absent binary: $name dispatches $count download, silent while it is pending', async ({ files, more, count }) => {
  const { send, home, env } = setup(files, more)
  assert.equal((await send()).length, 1)
  assert.equal((await send()).length, 1)
  assert.equal(launches().length, count)
  if (count === 0) {
    assert.ok(
      vi.mocked(spawn).mock.calls.every(([, args]) => args[0] === path.join(ROOT, 'lib/craft-hook-repo.sh')),
      'only the repo probe ran',
    )
  }
  for (const call of launches()) {
    assert.deepEqual(call, ['sh', [WRAPPER, '--ensure', '--background'], { detached: true, stdio: 'ignore', env: { ...env, HOME: home } }])
  }
  for (const { child, held } of children) if (held) assert.equal(child.exitCode, null, 'message returned before the download finished')
})

test('the hook asks again at the hour boundary, not before it', async () => {
  const { send } = setup(roles)
  await send()
  vi.mocked(Date.now).mockReturnValue(60 * 60 * 1000 - 1)
  await send()
  assert.equal(launches().length, 1)
  vi.mocked(Date.now).mockReturnValue(60 * 60 * 1000)
  await send()
  assert.equal(launches().length, 2)
})

test('a failed download is said once through the real --failure wrapper', async () => {
  const { home, send } = setup(roles)
  const state = path.join(home, '.craft/bin')
  fs.mkdirSync(state, { recursive: true })
  fs.writeFileSync(path.join(state, `${VERSION}.status`), '127\n')
  assert.equal(
    (await send())[1]?.text,
    `craft: tell the user: the craft binary ${VERSION} could not be downloaded (see ~/.craft/bin/${VERSION}.log); craft's hooks stay silent until it is there.`,
  )
  assert.equal((await send()).length, 1)
  const failures = vi.mocked(spawn).mock.calls.filter(([, args]) => args.includes('--failure'))
  assert.deepEqual(
    failures.map(([cmd, args]) => [cmd, args]),
    Array.from({ length: 2 }, () => ['sh', [WRAPPER, '--ensure', '--failure']]),
  )
  assert.equal(fs.existsSync(path.join(home, 'http')), false)
})

test('one real background wrapper installs the archive and checksum, then the next message runs the binary', async () => {
  stubDownload = false
  const release = tmp()
  const asset = 'craft-x86_64-unknown-linux-musl.tar.gz'
  writeExecutable(path.join(release, 'craft'), '#!/bin/sh\ncat >/dev/null\nprintf "installed %s\\n" "$*"\n')
  execFileSync('tar', ['-czf', path.join(release, asset), '-C', release, 'craft'])
  const digest = createHash('sha256')
    .update(fs.readFileSync(path.join(release, asset)))
    .digest('hex')
  fs.writeFileSync(path.join(release, `${asset}.sha256`), `${digest}  ${asset}\n`)
  const curl = execFileSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).trim()
  const { home, shim, send } = setup(roles, { CRAFT_TARGET: 'x86_64-unknown-linux-musl', CRAFT_RELEASE_BASE: `file://${release}`, CURL: curl })
  writeExecutable(path.join(shim, 'curl'), '#!/bin/sh\nfor arg; do url=$arg; done\necho "${url##*/}" >> "$HOME/http"\nexec "$CURL" "$@"\n')
  await send()
  assert.equal(launches().length, 1)
  assert.deepEqual(await Promise.all(children.map(({ done }) => done)), [0, 0, 0])
  assert.equal(fs.readFileSync(path.join(home, '.craft/bin', `${VERSION}.status`), 'utf8'), '0\n')
  assert.deepEqual(fs.readdirSync(path.join(home, '.craft/bin', VERSION)), ['craft'], 'no lock or partial download remains')
  assert.deepEqual(fs.readFileSync(path.join(home, 'http'), 'utf8').trim().split('\n'), [asset, `${asset}.sha256`])
  assert.equal((await send())[1]?.text, 'installed hook opencode-message')
  assert.equal(launches().length, 1, 'one dispatch, two HTTP requests')
})
