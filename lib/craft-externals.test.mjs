// The discovery CLI (lib/craft-externals.mjs, realm @nick/craft, node #435): the whole repository walked, or the
// files asked for read, known records left out, and a malformed invocation refused — in a temporary repository.
import { test, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discover, knownRecords, originUrl, run, walkManifests } from './craft-externals.mjs'


/** @type {string} */ let repo
/** @param {string} rel @param {string} text */
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text) }
beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-externals-')))
  put('deploy/docker-compose.yml', 'services:\n  db:\n    image: postgres:16.2\n')
  put('charts/a/values.yaml', 'image:\n  repository: ghcr.io/acme/app\n  tag: v1.0.0\n')
  put('charts/a/templates/d.yaml', 'apiVersion: v1\nkind: Pod\nimage: x/y:v1\n')
  put('.github/workflows/ci.yml', 'jobs: {}\n')
  put('node_modules/p/docker-compose.yml', 'services:\n  x:\n    image: redis:7\n')
  put('src/main.rs', 'fn main() {}\n')
  put('flake.lock', JSON.stringify({ nodes: { 'flake-utils': { locked: { owner: 'numtide', repo: 'flake-utils', rev: 'a'.repeat(40), type: 'github' } } }, version: 7 }, null, 2))
})
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

/** @param {string[]} extra @param {string} [stdin] */
const go = (extra, stdin) => discover(['discover', '--repo-root', repo, ...extra], { stdin: () => stdin ?? '' })
/** @param {ReturnType<typeof go>} r */
const systems = r => (r.answer.candidates ?? []).map(c => `${c.system}@${c.versionFrom}`)

test('the whole repository is walked, dot directories, node_modules, chart templates and flake.lock skipped', () => {
  assert.deepEqual(walkManifests(repo), { files: ['charts/a/values.yaml', 'deploy/docker-compose.yml'], cut: false })
  const r = go([])
  assert.equal(r.exitCode, 0)
  assert.deepEqual(systems(r), ['app@charts/a/values.yaml', 'postgres@deploy/docker-compose.yml'])
  assert.equal(r.answer.walkCut, undefined, 'a whole walk says nothing of a cut')
})

test('a walk cut off at its bound says so in the output; a manifest it found but could not read is named in unread', () => {
  const r = discover(['discover', '--repo-root', repo], { stdin: () => '', walkMax: 3 })
  assert.equal(r.exitCode, 0)
  assert.match(String(r.answer.walkCut), /^the walk stopped at its bound of 3 directory entries: files past it were not read/)
  assert.ok(walkManifests(repo, 3).cut)
  put('big/values.yaml', `image:\n  repository: x/y\n  tag: v1\n${'#'.repeat(1024 * 1024)}\n`)
  assert.deepEqual(go([]).answer.unread?.map(u => u.file), ['big/values.yaml'])
})

test('a directory that cannot be listed is passed over; the rest of the walk goes on', () => {
  put('locked/docker-compose.yml', 'services:\n  x:\n    image: redis:7.2\n')
  fs.chmodSync(path.join(repo, 'locked'), 0)
  try {
    if (process.getuid?.() === 0) return
    assert.deepEqual(walkManifests(repo).files, ['charts/a/values.yaml', 'deploy/docker-compose.yml'])
  } finally {
    fs.chmodSync(path.join(repo, 'locked'), 0o755)
  }
})

test('--known - leaves out what an active external record on stdin covers', () => {
  const known = JSON.stringify({ externals: [{ kind: 'external', system: 'app', repo: 'https://github.com/acme/app', versionFrom: 'x' }, { kind: 'external', status: 'withdrawn', system: 'postgres', repo: '', versionFrom: 'deploy/docker-compose.yml' }] })
  assert.deepEqual(systems(go(['--known', '-'], known)), ['postgres@deploy/docker-compose.yml'])
  assert.deepEqual(go(['--known', '-'], 'not json'), { exitCode: 1, answer: { error: '--known -: stdin is not JSON of a list of records' } })
  assert.equal(knownRecords('[{"kind":"decision","system":"a"}]')?.length, 0)
})

test('a malformed invocation is refused with exit 1', async () => {
  assert.equal(discover(['discover', '--repo-root', path.join(repo, 'nope')]).exitCode, 1)
  const r = await run(['discover', '--repo-root', repo])
  assert.equal(r.exitCode, 0)
  assert.ok(JSON.parse(String(r.stdout[0])).candidates.length === 2)
})

test('the repository\'s own application is no candidate: its origin repo, stated or guessed, in any URL form', () => {
  put('charts/a/Chart.yaml', 'name: app\nappVersion: 1.0.0\nsources:\n  - https://github.com/acme/app\n')
  put('charts/b/values.yaml', 'image:\n  repository: ghcr.io/acme/other\n  tag: v2.0.0\n')
  /** @param {string} url */
  const withOrigin = url => systems(discover(['discover', '--repo-root', repo], { stdin: () => '', origin: () => url }))
  const all = ['app@charts/a/Chart.yaml', 'app@charts/a/values.yaml', 'other@charts/b/values.yaml', 'postgres@deploy/docker-compose.yml']
  assert.deepEqual(withOrigin(''), all, 'no origin remote, no self filter')
  for (const url of ['https://github.com/acme/app', 'https://github.com/Acme/app.git', 'git@github.com:acme/app.git', 'ssh://git@github.com/acme/app']) {
    assert.deepEqual(withOrigin(url), ['other@charts/b/values.yaml', 'postgres@deploy/docker-compose.yml'], url)
  }
})

test('the origin remote is read from git, credentials dropped; a directory without one has none', () => {
  assert.equal(originUrl(repo), '')
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://x-access-token:secret@github.com/acme/app.git'])
  assert.equal(originUrl(repo), 'https://github.com/acme/app.git')
})

test('--paths reads only those files; one that cannot be read is named in unread', () => {
  const r = go(['--paths', Buffer.from(JSON.stringify(['deploy/docker-compose.yml', 'gone/values.yaml'])).toString('base64url')])
  assert.deepEqual(systems(r), ['postgres@deploy/docker-compose.yml'])
  assert.deepEqual(r.answer.unread, [{ file: 'gone/values.yaml', error: 'manifest gone/values.yaml not found' }])
  assert.equal(r.answer.more, 0)
})
