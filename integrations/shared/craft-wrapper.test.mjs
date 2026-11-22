// bin/craft, the sh wrapper the shell hosts run, against a directory standing in for the GitHub release
// (CRAFT_RELEASE_BASE, a file:// URL curl reads): a fake `craft` packed the way the release workflow packs it, its
// .sha256 as sha256sum prints it. A curl shim on the PATH logs each URL asked for. No server, so no port another
// test's server could share, and no network. It shares integrations/shared/craft-bin.mjs's cache layout and targets.
import { beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { targetOf } from './craft-bin.mjs'
import { writeExecutable } from './write-executable.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')
const WRAPPER = path.join(ROOT, 'bin', 'craft')
const SHARED = path.join(ROOT, 'integrations/shared/craft-cli.sh')
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, '.release-please-manifest.json'), 'utf8'))['.']
const ASSET = `craft-${targetOf(process.platform, process.arch)}.tar.gz`
const FAKE = '#!/bin/sh\nprintf "%s|" "$CRAFT_ROOT" "$@"\n'
const CURL = execFileSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).trim()
const run = promisify(execFile)

let HOME = ''
let RELEASE = ''
let SHIM = ''

/** The archive the release workflow would publish, holding `craft` with `body`. @param {string} body */
function pack(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-pack-'))
  fs.writeFileSync(path.join(dir, 'craft'), body, { mode: 0o755 })
  execFileSync('tar', ['-czf', path.join(dir, ASSET), '-C', dir, 'craft'])
  const archive = fs.readFileSync(path.join(dir, ASSET))
  fs.rmSync(dir, { recursive: true, force: true })
  return archive
}

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-home-'))
  RELEASE = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-release-'))
  SHIM = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-shim-'))
  writeExecutable(path.join(SHIM, 'curl'), `#!/bin/sh\nfor a; do url=$a; done\necho "\${url##*/}" >> '${SHIM}/hits'\nexec '${CURL}' "$@"\n`)
  const archive = pack(FAKE)
  fs.writeFileSync(path.join(RELEASE, ASSET), archive)
  fs.writeFileSync(path.join(RELEASE, `${ASSET}.sha256`), `${createHash('sha256').update(archive).digest('hex')}  ${ASSET}\n`)
})

/** The release files asked for so far. */
const hits = () => (fs.existsSync(path.join(SHIM, 'hits')) ? fs.readFileSync(path.join(SHIM, 'hits'), 'utf8').trim().split('\n') : [])

/** The wrapper run with `args`, its environment `extra` over a clean one. @param {string[]} args @param {Record<string, string>} [extra] */
async function wrapper(args, extra = {}) {
  const env = { PATH: `${SHIM}:${process.env['PATH'] ?? ''}`, HOME, CRAFT_RELEASE_BASE: `file://${RELEASE}`, ...extra }
  try {
    const { stdout, stderr } = await run('/bin/sh', [WRAPPER, ...args], { env })
    return { code: 0, stdout, stderr }
  } catch (e) {
    const err = /** @type {{ code: number, stdout: string, stderr: string }} */ (e)
    return { code: err.code, stdout: err.stdout, stderr: err.stderr }
  }
}

const cached = () => path.join(HOME, '.craft', 'bin', VERSION, 'craft')

test('the first run downloads, checks and installs the binary, then runs it with every argument and the plugin root', async () => {
  const got = await wrapper(['review', 'run', 'a b'])
  assert.equal(got.stderr, '')
  assert.equal(got.stdout, `${ROOT}|review|run|a b|`)
  assert.ok(fs.statSync(cached()).mode & 0o100)
  assert.deepEqual(hits(), [ASSET, `${ASSET}.sha256`])
  assert.deepEqual(fs.readdirSync(path.dirname(cached())), ['craft'])
})

test('a binary already in the cache runs without a download', async () => {
  await wrapper([])
  fs.rmSync(path.join(SHIM, 'hits'))
  const got = await wrapper(['x'], { CRAFT_ROOT: '/elsewhere' })
  assert.equal(got.stdout, '/elsewhere|x|')
  assert.deepEqual(hits(), [])
})

test('an archive whose SHA-256 is not the published one is refused in one line, nothing installed', async () => {
  fs.writeFileSync(path.join(RELEASE, `${ASSET}.sha256`), `${'0'.repeat(64)}  ${ASSET}\n`)
  const got = await wrapper(['x'])
  assert.equal(got.code, 127)
  assert.match(got.stderr, /^craft: craft-.*\.tar\.gz: SHA-256 [0-9a-f]{64} is not the published 0{64}\n$/)
  assert.deepEqual(fs.readdirSync(path.dirname(cached())), [])
})

test('a missing release asset is named', async () => {
  fs.rmSync(path.join(RELEASE, ASSET))
  const got = await wrapper(['x'])
  assert.equal(got.code, 127)
  assert.equal(got.stderr, `craft: could not download file://${RELEASE}/${ASSET}\n`)
})

test('CRAFT_BIN runs a local build and nothing is fetched; one that is not executable is named', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-local-'))
  const local = path.join(dir, 'craft')
  fs.writeFileSync(local, FAKE, { mode: 0o755 })
  assert.equal((await wrapper(['y'], { CRAFT_BIN: local })).stdout, `${ROOT}|y|`)
  assert.deepEqual(hits(), [])
  const missing = await wrapper(['y'], { CRAFT_BIN: path.join(dir, 'none') })
  assert.equal(missing.code, 127)
  assert.equal(missing.stderr, `craft: CRAFT_BIN=${path.join(dir, 'none')} is not an executable file\n`)
})

test('with neither curl nor wget on the PATH it says so', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-path-'))
  for (const tool of ['dirname', 'uname']) {
    const found = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim()
    fs.symlinkSync(found, path.join(bin, tool))
  }
  const got = await wrapper(['x'], { PATH: bin })
  assert.equal(got.code, 127)
  assert.equal(got.stderr, `craft: neither curl nor wget is on the PATH to download the craft binary ${VERSION}\n`)
})

test('the shared entry carries the plugin version on the line release-please moves', () => {
  const lines = fs
    .readFileSync(SHARED, 'utf8')
    .split('\n')
    .filter(l => l.includes('x-release-please-version'))
  assert.deepEqual(lines, [`version=${VERSION} # x-release-please-version`])
  const extra = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-please-config.json'), 'utf8')).packages['.']['extra-files']
  assert.ok(extra.some((/** @type {{ type: string, path: string }} */ f) => f.type === 'generic' && f.path === 'integrations/shared/craft-cli.sh'))
})

test('--ensure --print-path downloads once and prints only the binary path without executing it', async () => {
  const expected = { code: 0, stdout: `${cached()}\n`, stderr: '' }
  assert.deepEqual(await wrapper(['--ensure', '--print-path']), expected)
  assert.deepEqual(await wrapper(['--ensure', '--print-path']), expected)
  assert.deepEqual(hits(), [ASSET, `${ASSET}.sha256`])
})

/** A `uname` on the PATH that answers `sys` for -s and `machine` for -m. @param {string} sys @param {string} machine */
function fakeUname(sys, machine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-uname-'))
  writeExecutable(path.join(dir, 'uname'), `#!/bin/sh\ncase $1 in -s) echo '${sys}' ;; -m) echo '${machine}' ;; esac\n`)
  return dir
}

test('under Git Bash, MSYS or Cygwin on x86_64 it fetches the Windows release and caches craft.exe, as craft-bin.mjs does', async () => {
  const asset = 'craft-x86_64-pc-windows-msvc.tar.gz'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-pack-'))
  fs.writeFileSync(path.join(dir, 'craft.exe'), FAKE, { mode: 0o755 })
  execFileSync('tar', ['-czf', path.join(RELEASE, asset), '-C', dir, 'craft.exe'])
  const archive = fs.readFileSync(path.join(RELEASE, asset))
  fs.writeFileSync(path.join(RELEASE, `${asset}.sha256`), `${createHash('sha256').update(archive).digest('hex')}  ${asset}\n`)
  for (const sys of ['MINGW64_NT-10.0-19045', 'MSYS_NT-10.0-19045', 'CYGWIN_NT-10.0-19045']) {
    fs.rmSync(path.join(HOME, '.craft'), { recursive: true, force: true })
    fs.rmSync(path.join(SHIM, 'hits'), { force: true })
    const PATH = `${fakeUname(sys, 'x86_64')}:${SHIM}:${process.env['PATH'] ?? ''}`
    const exe = path.join(HOME, '.craft', 'bin', VERSION, 'craft.exe')
    assert.deepEqual(await wrapper(['--ensure', '--print-path'], { PATH }), { code: 0, stdout: `${exe}\n`, stderr: '' }, sys)
    assert.deepEqual(hits(), [asset, `${asset}.sha256`], sys)
    assert.deepEqual(fs.readdirSync(path.dirname(exe)), ['craft.exe'], sys)
    assert.equal((await wrapper(['x'], { PATH })).stdout, `${ROOT}|x|`, sys)
    assert.deepEqual(hits(), [asset, `${asset}.sha256`], sys)
  }
})

test('Windows on a machine the release does not build for is named, not fetched', async () => {
  const PATH = `${fakeUname('MINGW64_NT-10.0-22631', 'aarch64')}:${SHIM}:${process.env['PATH'] ?? ''}`
  const got = await wrapper(['--ensure', '--print-path'], { PATH })
  assert.equal(got.code, 127)
  assert.equal(got.stderr, 'craft: no released craft binary for MINGW64_NT-10.0-22631/aarch64: build it from cli/ and set CRAFT_BIN\n')
  assert.deepEqual(hits(), [])
})

test('--ensure --print-path validates an override and preserves spaces in its path', async () => {
  const local = path.join(HOME, 'local craft')
  fs.writeFileSync(local, FAKE, { mode: 0o755 })
  assert.deepEqual(await wrapper(['--ensure', '--print-path'], { CRAFT_BIN: local }), { code: 0, stdout: `${local}\n`, stderr: '' })
  fs.rmSync(local)
  assert.equal((await wrapper(['--ensure', '--print-path'], { CRAFT_BIN: local })).code, 127)
  assert.deepEqual(hits(), [])
})

test('--ensure fetches the binary and runs nothing; with it cached, it fetches nothing', async () => {
  assert.deepEqual(await wrapper(['--ensure']), { code: 0, stdout: '', stderr: '' })
  assert.ok(fs.statSync(cached()).isFile())
  assert.deepEqual(hits(), [ASSET, `${ASSET}.sha256`])
  assert.deepEqual(await wrapper(['--ensure']), { code: 0, stdout: '', stderr: '' })
  assert.equal(hits().length, 2)
  assert.deepEqual(fs.readdirSync(path.dirname(cached())), ['craft'], 'no lock or partial fetch left behind')
})

test('a download another session holds the lock for: --background leaves at once, a stale lock is taken over (realm #550)', async () => {
  const lock = path.join(path.dirname(cached()), '.lock')
  fs.mkdirSync(lock, { recursive: true })
  assert.deepEqual(await wrapper(['--ensure', '--background']), { code: 0, stdout: '', stderr: '' })
  assert.deepEqual(hits(), [], 'the holder downloads, not this one')
  const old = new Date(Date.now() - 11 * 60 * 1000)
  fs.utimesSync(lock, old, old)
  assert.deepEqual(await wrapper(['--ensure', '--background']), { code: 0, stdout: '', stderr: '' })
  assert.ok(fs.statSync(cached()).isFile())
  assert.equal(fs.existsSync(lock), false)
})

test("a holder taken over as stale does not remove its successor's lock; its own it does (realm #550)", () => {
  const dir = path.join(HOME, '.craft', 'bin', VERSION)
  const lock = path.join(dir, '.lock')
  fs.mkdirSync(lock, { recursive: true })
  fs.writeFileSync(path.join(lock, 'owner'), 'successor\n')
  /** @param {string} token */
  const unlock = token =>
    execFileSync('sh', ['-c', '. ./craft-fetch.sh; _cf_dir=$1; _cf_token=$2; _cf_unlock', 'sh', dir, token], { cwd: path.join(ROOT, 'integrations/shared') })
  unlock('old-holder')
  assert.ok(fs.existsSync(lock), "the old holder's unlock leaves the successor's lock")
  unlock('successor')
  assert.equal(fs.existsSync(lock), false)
})

test('a download stopped by a signal leaves no partial fetch and no lock', async () => {
  writeExecutable(path.join(SHIM, 'curl'), `#!/bin/sh\necho started > '${SHIM}/started'\nexec sleep 30\n`)
  const { spawn } = await import('node:child_process')
  const child = spawn('/bin/sh', [WRAPPER, '--ensure'], {
    env: { PATH: `${SHIM}:${process.env['PATH'] ?? ''}`, HOME, CRAFT_RELEASE_BASE: `file://${RELEASE}` },
    detached: true,
  })
  const until = Date.now() + 5000
  while (!fs.existsSync(path.join(SHIM, 'started')) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50))
  const done = new Promise(resolve => child.on('close', resolve))
  process.kill(-(child.pid ?? 0), 'SIGTERM')
  await done
  assert.deepEqual(fs.readdirSync(path.dirname(cached())), [])
})

test('curl is bounded: a connect timeout and a total time limit on every request', () => {
  const http = fs.readFileSync(path.join(ROOT, 'integrations/shared', 'craft-fetch-http.sh'), 'utf8')
  const calls = http.split('\n').filter(l => /\bcurl -s/.test(l))
  assert.ok(calls.length >= 2)
  for (const l of calls) assert.match(l, /--connect-timeout 15 --max-time 300/, l)
})

/** The download state beside the cache, `~/.craft/bin/<version>.<what>`. @param {string} what */
const state = what => path.join(HOME, '.craft', 'bin', `${VERSION}.${what}`)

test('--ensure --background is the one hourly try for every caller: it logs, keeps how it ended and says a failure once per streak (realm #550)', async () => {
  fs.rmSync(path.join(RELEASE, ASSET))
  assert.deepEqual(await wrapper(['--ensure', '--background']), { code: 0, stdout: '', stderr: '' })
  assert.equal(hits().length, 1, 'tried')
  assert.notEqual(fs.readFileSync(state('status'), 'utf8').trim(), '0')
  assert.match(fs.readFileSync(state('log'), 'utf8'), /craft: /)
  const line = `the craft binary ${VERSION} could not be downloaded (see ~/.craft/bin/${VERSION}.log); craft's hooks stay silent until it is there`
  assert.deepEqual(await wrapper(['--ensure', '--failure']), { code: 0, stdout: line, stderr: '' })
  assert.deepEqual(await wrapper(['--ensure', '--failure']), { code: 0, stdout: '', stderr: '' }, 'said once')
  assert.deepEqual(await wrapper(['--ensure', '--background']), { code: 0, stdout: '', stderr: '' })
  assert.equal(hits().length, 1, 'not again within the hour')
  // An hour on, the try fails again: the streak is still said once.
  const old = new Date(Date.now() - 61 * 60 * 1000)
  fs.utimesSync(state('attempt'), old, old)
  await wrapper(['--ensure', '--background'])
  assert.equal(hits().length, 2, 'tried again after the hour')
  assert.deepEqual(await wrapper(['--ensure', '--failure']), { code: 0, stdout: '', stderr: '' }, 'the same streak')
  // A success ends the streak: the next failure is said again.
  fs.writeFileSync(path.join(RELEASE, ASSET), pack(FAKE))
  fs.writeFileSync(
    path.join(RELEASE, `${ASSET}.sha256`),
    `${createHash('sha256')
      .update(fs.readFileSync(path.join(RELEASE, ASSET)))
      .digest('hex')}  ${ASSET}\n`,
  )
  fs.utimesSync(state('attempt'), old, old)
  await wrapper(['--ensure', '--background'])
  assert.ok(fs.statSync(cached()).isFile())
  assert.equal(fs.readFileSync(state('status'), 'utf8').trim(), '0')
  assert.equal(fs.existsSync(state('told')), false, 'the streak is over')
})

test('the log is cut back past 64 KiB before a background try writes to it', async () => {
  fs.mkdirSync(path.dirname(state('log')), { recursive: true })
  fs.writeFileSync(state('log'), 'x'.repeat(70 * 1024))
  await wrapper(['--ensure', '--background'])
  assert.ok(fs.statSync(state('log')).size < 4096)
})
