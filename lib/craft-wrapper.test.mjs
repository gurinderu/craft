// bin/craft, the sh wrapper the shell hosts run, against a directory standing in for the GitHub release
// (CRAFT_RELEASE_BASE, a file:// URL curl reads): a fake `craft` packed the way the release workflow packs it, its
// .sha256 as sha256sum prints it. A curl shim on the PATH logs each URL asked for. No server, so no port another
// test's server could share, and no network. It shares lib/craft-bin.mjs's cache layout and targets.
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

const ROOT = path.resolve(import.meta.dirname, '..')
const WRAPPER = path.join(ROOT, 'bin', 'craft')
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

test('the wrapper carries the plugin version on the line release-please moves', () => {
  const lines = fs.readFileSync(WRAPPER, 'utf8').split('\n').filter(l => l.includes('x-release-please-version'))
  assert.deepEqual(lines, [`version=${VERSION} # x-release-please-version`])
  const extra = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-please-config.json'), 'utf8')).packages['.']['extra-files']
  assert.ok(extra.some((/** @type {{ type: string, path: string }} */ f) => f.type === 'generic' && f.path === 'bin/craft'))
})
