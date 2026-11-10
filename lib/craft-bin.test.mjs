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
import { binaryName, ensure, manifestCandidates, parseArgs, run, targetOf, tarCommand } from './craft-bin.mjs'
import { download } from './http-download.mjs'

const TARGET = 'x86_64-unknown-linux-musl'
const ASSET = `craft-${TARGET}.tar.gz`
const LINUX = { platform: 'linux', arch: 'x64' }

/** Files the server serves under /blob/<name>; /download/<name> redirects there. @type {Map<string, Buffer>} */
const files = new Map()
/** @type {string[]} */
const hits = []
/** The authorization header of each request, by the server it reached. @type {{ api: string[], download: string[] }} */
const auth = { api: [], download: [] }
/** What /download/<name> answers instead of its redirect (0: the redirect); what the API answers instead (0: the release). */
const fail = { download: 0, api: 0 }
let BASE = ''
let API = ''
let HOME = ''
const server = http.createServer((req, res) => {
  const url = req.url ?? ''
  hits.push(url)
  auth.download.push(req.headers.authorization ?? '')
  if (url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return }
  if (fail.download && url.startsWith('/download/')) { res.writeHead(fail.download); res.end(); return }
  if (url.startsWith('/download/')) { res.writeHead(302, { location: url.replace('/download/', '/blob/') }); res.end(); return }
  const body = files.get(url.replace('/blob/', ''))
  if (!body) { res.writeHead(404); res.end(); return }
  res.writeHead(200); res.end(body)
})

/** The REST API: the release by tag lists every published file; an asset redirects to the download server's storage. */
/** @type {string[]} */
const apiHits = []
const api = http.createServer((req, res) => {
  const url = req.url ?? ''
  apiHits.push(url)
  auth.api.push(req.headers.authorization ?? '')
  if (fail.api) { res.writeHead(fail.api); res.end(); return }
  const names = [...files.keys()]
  if (url === '/repos/o/r/releases/tags/v9.9.9') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ assets: names.map((name, i) => ({ name, url: `${API}/repos/o/r/releases/assets/${i}` })) }))
    return
  }
  const id = /^\/repos\/o\/r\/releases\/assets\/(\d+)$/.exec(url)?.[1]
  const name = id == null ? undefined : names[Number(id)]
  if (!name || req.headers.accept !== 'application/octet-stream') { res.writeHead(404); res.end(); return }
  res.writeHead(302, { location: BASE.replace('/download', `/blob/${name}`) }); res.end()
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
function publish(archive, sum = createHash('sha256').update(archive).digest('hex'), asset = ASSET) {
  files.set(asset, archive)
  files.set(`${asset}.sha256`, Buffer.from(`${sum}  ${asset}\n`))
}
const SCRIPT = '#!/bin/sh\necho "craft 9.9.9"\n'

beforeAll(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  BASE = `http://127.0.0.1:${addr.port}/download`
  await new Promise(resolve => api.listen(0, '127.0.0.1', () => resolve(undefined)))
  const apiAddr = api.address()
  assert.ok(apiAddr && typeof apiAddr === 'object')
  API = `http://127.0.0.1:${apiAddr.port}`
})
afterAll(async () => {
  await new Promise(resolve => server.close(() => resolve(undefined)))
  await new Promise(resolve => api.close(() => resolve(undefined)))
})
beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-home-'))
  files.clear(); hits.length = 0; apiHits.length = 0; auth.api.length = 0; auth.download.length = 0
  fail.download = 0; fail.api = 0
})
afterEach(() => { fs.rmSync(HOME, { recursive: true, force: true }) })

const opts = () => ({ version: '9.9.9', repo: 'o/r', home: HOME, baseUrl: BASE, apiBase: API, ...LINUX })

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
  assert.deepEqual(apiHits, [], 'a 404 is the asset missing: the API is not asked')
  fail.download = 403
  await assert.rejects(ensure(opts()), /HTTP 403 for .*craft-x86_64-unknown-linux-musl\.tar\.gz/)
  assert.deepEqual(apiHits, [], 'nor after any other 4xx')
  fail.download = 0
  publish(tarball('other', SCRIPT))
  await assert.rejects(ensure(opts()), /could not unpack craft from craft-x86_64-unknown-linux-musl\.tar\.gz/)
  assert.deepEqual(fs.readdirSync(path.join(HOME, '.craft', 'bin', '9.9.9')), [])
})

test('a download URL answering 5xx falls back to the REST API, once per release, and the archive is still verified', async () => {
  publish(tarball('craft', SCRIPT))
  fail.download = 504
  const bin = await ensure(opts())
  assert.equal(execFileSync(bin, { encoding: 'utf8' }).trim(), 'craft 9.9.9')
  assert.deepEqual(apiHits.filter(u => u.includes('/tags/')), ['/repos/o/r/releases/tags/v9.9.9'], 'the release is read once for both files')
  assert.equal(apiHits.length, 3)
  assert.ok(hits.includes(`/blob/${ASSET}`) && hits.includes(`/blob/${ASSET}.sha256`), 'the API redirect to storage was followed')
  fs.rmSync(bin)
  publish(tarball('craft', SCRIPT), 'a'.repeat(64))
  await assert.rejects(ensure(opts()), /SHA-256 [0-9a-f]{64} is not the published a{64}/, 'the API path is verified the same')
})

test('a network error at the download URL falls back to the API too', async () => {
  publish(tarball('craft', SCRIPT))
  const closed = http.createServer()
  await new Promise(resolve => closed.listen(0, '127.0.0.1', () => resolve(undefined)))
  const addr = closed.address()
  assert.ok(addr && typeof addr === 'object')
  await new Promise(resolve => closed.close(() => resolve(undefined)))
  const bin = await ensure({ ...opts(), baseUrl: `http://127.0.0.1:${addr.port}/download` })
  assert.equal(fs.readFileSync(bin, 'utf8'), SCRIPT)
  assert.equal(apiHits.length, 3)
})

test('when both paths fail the error names both URLs and their statuses', async () => {
  publish(tarball('craft', SCRIPT))
  fail.download = 504
  fail.api = 503
  await assert.rejects(ensure(opts()), (/** @type {Error} */ e) => {
    assert.match(e.message, /HTTP 504 for http:\/\/127\.0\.0\.1:\d+\/download\/craft-x86_64-unknown-linux-musl\.tar\.gz/)
    assert.match(e.message, /through the API: HTTP 503 for http:\/\/127\.0\.0\.1:\d+\/repos\/o\/r\/releases\/tags\/v9\.9\.9/)
    return true
  })
  fail.api = 0
  files.clear()
  await assert.rejects(ensure(opts()), /HTTP 504 for .*\.tar\.gz; then through the API: release v9\.9\.9 of o\/r has no asset craft-x86_64-unknown-linux-musl\.tar\.gz /)
})

test('a GH_TOKEN or GITHUB_TOKEN goes to the API only, never to the download or storage host', async () => {
  publish(tarball('craft', SCRIPT))
  fail.download = 504
  for (const env of [{ GH_TOKEN: 'gh-tok' }, { GITHUB_TOKEN: 'gh-tok' }]) {
    const home = fs.mkdtempSync(path.join(HOME, 'h-'))
    auth.api.length = 0; auth.download.length = 0
    const r = await run(['ensure', '--version', '9.9.9', '--repo', 'o/r'], env, { home, baseUrl: BASE, apiBase: API, ...LINUX })
    assert.equal(r.exitCode, 0, r.stderr.join('\n'))
    assert.deepEqual(auth.api, ['Bearer gh-tok', 'Bearer gh-tok', 'Bearer gh-tok'])
    assert.ok(auth.download.length > 0 && auth.download.every(a => a === ''), 'neither the download URL nor the redirect target saw it')
  }
  auth.api.length = 0
  await run(['ensure', '--version', '9.9.9', '--repo', 'o/r'], {}, { home: fs.mkdtempSync(path.join(HOME, 'h-')), baseUrl: BASE, apiBase: API, ...LINUX })
  assert.deepEqual(auth.api, ['', '', ''], 'no token, no header')
})

test('the platform maps to a release target; any other is refused', () => {
  assert.equal(targetOf('linux', 'x64'), TARGET)
  assert.equal(targetOf('linux', 'arm64'), 'aarch64-unknown-linux-musl')
  assert.equal(targetOf('darwin', 'x64'), 'x86_64-apple-darwin')
  assert.equal(targetOf('darwin', 'arm64'), 'aarch64-apple-darwin')
  assert.equal(targetOf('win32', 'x64'), 'x86_64-pc-windows-msvc')
  assert.throws(() => targetOf('win32', 'arm64'), /no released craft binary for win32\/arm64/)
  assert.throws(() => targetOf('freebsd', 'x64'), /no released craft binary for freebsd\/x64/)
  assert.equal(binaryName('win32'), 'craft.exe')
  assert.equal(binaryName('linux'), 'craft')
})

test('Windows unpacks with the system tar by its full path; elsewhere tar from PATH', () => {
  assert.equal(tarCommand('win32', { SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\tar.exe')
  assert.equal(tarCommand('win32', {}), 'C:\\Windows\\System32\\tar.exe')
  assert.equal(tarCommand('linux', { SystemRoot: 'D:\\Win' }), 'tar')
})

test('for Windows the windows-msvc asset is fetched and craft.exe installed beside no other file', async () => {
  const asset = 'craft-x86_64-pc-windows-msvc.tar.gz'
  publish(tarball('craft.exe', SCRIPT), undefined, asset)
  const bin = await ensure({ ...opts(), platform: 'win32', arch: 'x64' })
  assert.equal(bin, path.join(HOME, '.craft', 'bin', '9.9.9', 'craft.exe'))
  assert.equal(fs.readFileSync(bin, 'utf8'), SCRIPT)
  assert.deepEqual(fs.readdirSync(path.dirname(bin)), ['craft.exe'])
  assert.ok(hits.includes(`/blob/${asset}`))
  publish(tarball('craft', SCRIPT), undefined, asset)
  fs.rmSync(bin)
  await assert.rejects(ensure({ ...opts(), platform: 'win32', arch: 'x64' }), /could not unpack craft\.exe from craft-x86_64-pc-windows-msvc\.tar\.gz/)
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
  for (const f of ['craft-bin.mjs', 'http-download.mjs', 'release-asset.mjs', 'script-main.mjs']) fs.copyFileSync(new URL(f, import.meta.url), path.join(lib, f))
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
