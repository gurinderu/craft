// lib/craft-bin.mjs against a local HTTP server standing in for GitHub's release downloads: a fake `craft` packed
// the way the release workflow packs it, its .sha256 as sha256sum prints it, and a redirect in front of both as
// GitHub's download URLs have. No network.
import { afterAll, afterEach, beforeAll, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { ensure, manifestCandidates, parseArgs, run, targetOf } from './craft-bin.mjs'
import { download } from './http-download.mjs'

const TARGET = 'x86_64-unknown-linux-musl'
const ASSET = `craft-${TARGET}.tar.gz`
const LINUX = { platform: 'linux', arch: 'x64' }

/** Files the server serves under /blob/<name>; /download/<name> redirects there. @type {Map<string, Buffer>} */
const files = new Map()
/** @type {string[]} */
const hits = []
let BASE = ''
let HOME = ''
const server = http.createServer((req, res) => {
  const url = req.url ?? ''
  hits.push(url)
  if (url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return }
  if (url.startsWith('/download/')) { res.writeHead(302, { location: url.replace('/download/', '/blob/') }); res.end(); return }
  const body = files.get(url.replace('/blob/', ''))
  if (!body) { res.writeHead(404); res.end(); return }
  res.writeHead(200); res.end(body)
})

/** A tarball holding `name` with `content` at its root, packed as the workflow packs it. @param {string} name @param {string} content */
function tarball(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-pack-'))
  try {
    fs.writeFileSync(path.join(dir, name), content, { mode: 0o644 })
    execFileSync('tar', ['-czf', path.join(dir, 'out.tar.gz'), '-C', dir, name])
    return fs.readFileSync(path.join(dir, 'out.tar.gz'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
/** @param {Buffer} archive @param {string} [sum] */
function publish(archive, sum = createHash('sha256').update(archive).digest('hex')) {
  files.set(ASSET, archive)
  files.set(`${ASSET}.sha256`, Buffer.from(`${sum}  ${ASSET}\n`))
}
const SCRIPT = '#!/bin/sh\necho "craft 9.9.9"\n'

beforeAll(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  BASE = `http://127.0.0.1:${addr.port}/download`
})
afterAll(() => new Promise(resolve => server.close(() => resolve(undefined))))
beforeEach(() => { HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-home-')); files.clear(); hits.length = 0 })
afterEach(() => { fs.rmSync(HOME, { recursive: true, force: true }) })

const opts = () => ({ version: '9.9.9', repo: 'o/r', home: HOME, baseUrl: BASE, ...LINUX })

test('fetches, verifies and installs the binary executable, then reuses it without the network', async () => {
  publish(tarball('craft', SCRIPT))
  const bin = await ensure(opts())
  assert.equal(bin, path.join(HOME, '.craft', 'bin', '9.9.9', 'craft'))
  assert.equal(fs.statSync(bin).mode & 0o777, 0o755)
  assert.equal(execFileSync(bin, { encoding: 'utf8' }).trim(), 'craft 9.9.9')
  assert.deepEqual(fs.readdirSync(path.dirname(bin)), ['craft'], 'no temporary left beside it')
  assert.ok(hits.includes(`/blob/${ASSET}`), 'the redirect was followed')
  hits.length = 0
  assert.equal(await ensure(opts()), bin)
  assert.deepEqual(hits, [], 'an installed copy is not fetched again')
})

test('a checksum that does not match installs nothing', async () => {
  publish(tarball('craft', SCRIPT), 'a'.repeat(64))
  await assert.rejects(ensure(opts()), /SHA-256 [0-9a-f]{64} is not the published a{64}/)
  assert.equal(fs.existsSync(path.join(HOME, '.craft', 'bin', '9.9.9', 'craft')), false)
  files.set(`${ASSET}.sha256`, Buffer.from('nothing here'))
  await assert.rejects(ensure(opts()), /holds no SHA-256/)
})

test('a missing asset or an archive without craft at its root fails, leaving no temporary', async () => {
  await assert.rejects(ensure(opts()), /HTTP 404 for .*craft-x86_64-unknown-linux-musl\.tar\.gz/)
  publish(tarball('other', SCRIPT))
  await assert.rejects(ensure(opts()), /could not unpack craft from craft-x86_64-unknown-linux-musl\.tar\.gz/)
  assert.deepEqual(fs.readdirSync(path.join(HOME, '.craft', 'bin', '9.9.9')), [])
})

test('the platform maps to a release target; any other is refused', () => {
  assert.equal(targetOf('linux', 'x64'), TARGET)
  assert.equal(targetOf('linux', 'arm64'), 'aarch64-unknown-linux-musl')
  assert.equal(targetOf('darwin', 'x64'), 'x86_64-apple-darwin')
  assert.equal(targetOf('darwin', 'arm64'), 'aarch64-apple-darwin')
  assert.throws(() => targetOf('win32', 'x64'), /no released craft binary for win32\/x64/)
})

test('arguments: ensure only, a version and an owner/name repository', () => {
  assert.deepEqual(parseArgs(['ensure', '--version', '1.2.3']), { version: '1.2.3', repo: 'gurinderu/craft' })
  assert.deepEqual(parseArgs(['ensure', '--version', '1.2.3', '--repo', 'a/b']), { version: '1.2.3', repo: 'a/b' })
  const manifest = JSON.parse(fs.readFileSync(new URL('../integrations/claude-code/.claude-plugin/plugin.json', import.meta.url), 'utf8'))
  assert.equal(parseArgs(['ensure'], {}).version, manifest.version, 'the checkout\'s Claude Code manifest by default')
  assert.throws(() => parseArgs([]), /usage/)
  assert.throws(() => parseArgs(['ensure', '--version']), /usage/)
  assert.throws(() => parseArgs(['ensure', '--bogus', 'x']), /usage/)
  assert.throws(() => parseArgs(['ensure', '--version', '1.2']), /not a version/)
  assert.throws(() => parseArgs(['ensure', '--version', '1.2.3', '--repo', '../x']), /not an owner\/name/)
})

/** A copy of craft-bin.mjs and its imports under `root`/lib, imported. @param {string} root */
async function copyAt(root) {
  const lib = path.join(root, 'lib')
  fs.mkdirSync(lib, { recursive: true })
  for (const f of ['craft-bin.mjs', 'http-download.mjs', 'script-main.mjs']) fs.copyFileSync(new URL(f, import.meta.url), path.join(lib, f))
  return /** @type {typeof import('./craft-bin.mjs')} */ (await import(path.join(lib, 'craft-bin.mjs')))
}

/** A plugin manifest naming `version` in `root`/.claude-plugin. @param {string} root @param {string} version */
function manifestAt(root, version) {
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true })
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }))
}

test('the version comes from the copy the script sits in, installed then checkout layout, the harness\'s root last', async () => {
  const other = path.join(HOME, 'other-craft')
  manifestAt(other, '7.7.7')
  const lib = path.dirname(new URL(import.meta.url).pathname)
  assert.deepEqual(manifestCandidates({}), [path.join(lib, '..', '.claude-plugin', 'plugin.json'), path.join(lib, '..', 'integrations', 'claude-code', '.claude-plugin', 'plugin.json')].map(p => path.normalize(p)))
  assert.equal(manifestCandidates({ CLAUDE_PLUGIN_ROOT: other }).at(-1), path.join(other, '.claude-plugin', 'plugin.json'))
  assert.notEqual(parseArgs(['ensure'], { CLAUDE_PLUGIN_ROOT: other }).version, '7.7.7', 'a checkout in a session with another craft installed reads its own')

  const installed = path.join(HOME, 'installed')
  manifestAt(installed, '5.5.5')
  manifestAt(path.join(installed, 'integrations', 'claude-code'), '6.6.6')
  assert.equal((await copyAt(installed)).parseArgs(['ensure'], { CLAUDE_PLUGIN_ROOT: other }).version, '5.5.5', 'the installed layout first')

  const checkout = path.join(HOME, 'checkout')
  manifestAt(path.join(checkout, 'integrations', 'claude-code'), '6.6.6')
  assert.equal((await copyAt(checkout)).parseArgs(['ensure'], { CLAUDE_PLUGIN_ROOT: other }).version, '6.6.6', 'then the checkout layout')

  const bare = await copyAt(path.join(HOME, 'bare'))
  assert.equal(bare.parseArgs(['ensure'], { CLAUDE_PLUGIN_ROOT: other }).version, '7.7.7', 'the harness\'s root as the last resort')
  assert.throws(() => bare.parseArgs(['ensure'], { CLAUDE_PLUGIN_ROOT: path.join(HOME, 'nowhere') }), /not a version/, 'and nothing readable is no version')
})

test('the CLI prints the path, or one line on stderr and exit 1', async () => {
  publish(tarball('craft', SCRIPT))
  const ok = await run(['ensure', '--version', '9.9.9'], {}, { home: HOME, baseUrl: BASE, ...LINUX })
  assert.deepEqual(ok, { exitCode: 0, stdout: [path.join(HOME, '.craft', 'bin', '9.9.9', 'craft')], stderr: [] })
  const bad = await run(['ensure', '--version', '9.9.9'], {}, { home: path.join(HOME, 'elsewhere'), baseUrl: BASE, platform: 'freebsd', arch: 'x64' })
  assert.equal(bad.exitCode, 1)
  assert.deepEqual(bad.stdout, [])
  assert.equal(bad.stderr.length, 1)
  assert.match(bad.stderr[0] ?? '', /^craft-bin: no released craft binary for freebsd\/x64/)
})

test('a redirect loop and a non-http URL fail rather than hang', async () => {
  await assert.rejects(download(BASE.replace('/download', '/loop')), /more than 5 redirects/)
  await assert.rejects(download('file:///etc/passwd'), /not an http\(s\) URL/)
})
