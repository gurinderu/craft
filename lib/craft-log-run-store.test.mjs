// The run-record store's write half, pinned at its edges: the computed fields read from git, the
// readback that makes a half-landed write loud, the name claims that step past collisions, the
// checkpoint identity a rejoin must prove, and the path predicates guarding every delete. The
// happy paths live in craft-log-run.test.mjs; these are the boundaries a mutation survived.
import { test, onTestFinished } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  DEFAULT_STORE, repoKey, gitIdentity, computedFields, recordFilename, writeRecord, stamp,
  checkpointIdentity, dirIdentity, dirSessionIds, identityAgrees, dirStamp, stampMs, findRejoinableDir,
  checkpointDir, writeCheckpoint, rawCheckpointRevisions, readCheckpoints, safePath, containsPath, insideStore,
} from './craft-log-run.mjs'

const RECORD = { schemaVersion: 1, runtime: 'claude-code', kind: 'workflow', name: 'review', verdict: 'Approve' }
const NOW = new Date('2026-10-02T12:00:00Z')

/** @param {string} [prefix] */
const tmp = (prefix = 'craft-edges-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** @param {string[]} args @param {string} cwd */
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
/** @param {string} [branch] */
const tempRepo = (branch = 'feat/x') => {
  const dir = tmp('craft-edges-repo-')
  git(['init', '-q'], dir)
  git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], dir)
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init'], dir)
  return dir
}
/** @param {string} store */
const partialRoot = store => path.join(store, '.partial')

test('the default store is ~/.craft/runs', () => {
  assert.equal(DEFAULT_STORE, path.join(os.homedir(), '.craft', 'runs'))
})

test('repoKey outside any repository is the resolved path itself, not the working directory', () => {
  const dir = tmp()
  assert.equal(repoKey(dir), path.resolve(dir))
})

test('repoKey inside a bare repository keys to the repository, not to the subdirectory asked about', () => {
  const bare = tmp('craft-edges-bare-')
  git(['init', '-q', '--bare'], bare)
  assert.equal(repoKey(path.join(bare, 'refs')), fs.realpathSync(bare))
})

// git < 2.31 echoes an unknown `--path-format=absolute` back and exits 0: the common dir then arrives as
// two lines. Only a single absolute line is trusted; anything else falls through to --show-toplevel.
test('repoKey distrusts a multi-line common dir even when it reads as an absolute path ending in .git', () => {
  const bin = tmp('craft-edges-bin-')
  const fake = path.join(bin, 'git')
  fs.writeFileSync(fake, '#!/bin/sh\ncase "$*" in\n  *--git-common-dir*) printf \'/x\\n/y/.git\\n\' ;;\n  *--show-toplevel*) echo /top ;;\nesac\n')
  fs.chmodSync(fake, 0o755)
  const saved = process.env['PATH']
  process.env['PATH'] = `${bin}${path.delimiter}${saved}`
  try {
    assert.equal(repoKey(bin), '/top')
  } finally {
    process.env['PATH'] = saved
  }
})

test('gitIdentity reads the branch and head off the repository', () => {
  const repo = tempRepo('feat/edges')
  assert.deepEqual(gitIdentity(repo), { branch: 'feat/edges', head: git(['rev-parse', 'HEAD'], repo) })
})

test('computedFields reads commit and dirty off the working copy pointed at, and no session reads as null', () => {
  const project = tempRepo()
  const workdir = tempRepo()
  fs.writeFileSync(path.join(workdir, 'untracked.txt'), 'x')
  const f = computedFields(project, NOW, '', workdir)
  assert.equal(f.commit, git(['rev-parse', '--short', 'HEAD'], workdir))
  assert.equal(f.dirty, true)
  assert.equal(f.session, null)
  const own = computedFields(project, NOW)
  assert.equal(own.commit, git(['rev-parse', '--short', 'HEAD'], project))
  assert.equal(own.dirty, false)
  assert.equal(own.ts, stamp(NOW))
  assert.equal(own.session, null)
})

// craftCommit answers about the checkout holding the module, so the module and its imports are copied
// into a scratch root, and the expected head is the scratch root's own `git rev-parse HEAD` (whatever
// its ref storage).
const LIB = path.dirname(fileURLToPath(import.meta.url))
const LOG_RUN_MODULES = ['craft-log-run.mjs', 'run-record.mjs', 'journal-link.mjs', 'loop-state.mjs', 'ledger-shards.mjs', 'json-object.mjs']
/** @param {string} root */
const craftCommitAt = async root => {
  fs.mkdirSync(path.join(root, 'lib'))
  for (const f of LOG_RUN_MODULES) fs.copyFileSync(path.join(LIB, f), path.join(root, 'lib', f))
  /** @type {typeof import('./craft-log-run.mjs')} */
  const mod = await import(pathToFileURL(path.join(root, 'lib', 'craft-log-run.mjs')).href)
  return mod.computedFields(tmp(), NOW).craftCommit
}

test('craftCommit is the short head of the checkout holding the module, not of the project', async () => {
  const root = tempRepo('feat/craft')
  const head = git(['rev-parse', 'HEAD'], root)
  const commit = await craftCommitAt(root)
  assert.ok(typeof commit === 'string' && commit.length >= 4 && head.startsWith(commit), `${commit} is not a prefix of ${head}`)
})

test('craftCommit is null where the module sits outside any repository', async () => {
  assert.equal(await craftCommitAt(tmp()), null)
})

test('recordFilename replaces each unsafe character with a dash', () => {
  assert.equal(recordFilename({ ts: 't', kind: 'k', name: 'a b/c' }), 't-k-a-b-c.json')
})

test('writeRecord is loud when the readback lost a key the record carried', () => {
  const store = tmp()
  assert.throws(() => writeRecord({ ...RECORD, extra: undefined, other: undefined }, { store, project: store, now: NOW }), /^Error: readback lost key\(s\): extra, other$/)
})

test('writeRecord is loud when an array does not survive the readback with its length', () => {
  const store = tmp()
  const shrinks = Object.assign([1, 2], { toJSON: () => [1] })
  assert.throws(() => writeRecord({ ...RECORD, list: shrinks }, { store, project: store, now: NOW }), /readback changed array 'list': 2 → 1/)
  const vanishes = Object.assign([1, 2], { toJSON: () => 'x' })
  assert.throws(() => writeRecord({ ...RECORD, list: vanishes }, { store, project: store, now: new Date(NOW.getTime() + 5000) }), /readback changed array 'list': 2 → not an array/)
})

test('writeRecord stamps no session when none is given and reads commit off the project', () => {
  const store = tmp()
  const project = tempRepo()
  const { record } = writeRecord(RECORD, { store, project, now: NOW })
  assert.equal(record['session'], null)
  assert.equal(record['commit'], git(['rev-parse', '--short', 'HEAD'], project))
})

test('a taken record name steps the stamp forward one second, and sixty taken names refuse', () => {
  const store = tmp()
  const name = /** @param {Date} d */ d => path.join(store, recordFilename({ ...RECORD, ts: stamp(d) }))
  fs.writeFileSync(name(NOW), '{}')
  const { record } = writeRecord(RECORD, { store, project: store, now: NOW })
  assert.equal(record['ts'], stamp(new Date(NOW.getTime() + 1000)))
  const full = tmp()
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(full, recordFilename({ ...RECORD, ts: stamp(new Date(NOW.getTime() + i * 1000)) })), '{}')
  assert.throws(() => writeRecord(RECORD, { store: full, project: full, now: NOW }), /cannot claim a record name under .* — 60 consecutive stamps taken/)
})

test('a write the store refuses for any reason but a taken name is thrown as it is', { skip: process.getuid?.() === 0 }, () => {
  const store = tmp()
  fs.chmodSync(store, 0o500)
  try {
    assert.throws(() => writeRecord(RECORD, { store, project: store, now: NOW }), /EACCES/)
  } finally {
    fs.chmodSync(store, 0o700)
  }
})

test('checkpointIdentity keeps only string fields and tolerates no object at all', () => {
  assert.deepEqual(checkpointIdentity({ project: 5, branch: 'b' }), { project: '', branch: 'b', head: '', session: '' })
  assert.deepEqual(checkpointIdentity(null), { project: '', branch: '', head: '', session: '' })
})

test('dirIdentity: a phase that is silent about a field does not poison it', () => {
  assert.equal(dirIdentity([{ project: 'p' }, {}]).project, 'p')
})

test('dirSessionIds: each distinct non-empty session once, in first-seen order', () => {
  assert.deepEqual(dirSessionIds([]), [])
  assert.deepEqual(dirSessionIds([{ session: 'a' }, {}, { session: 'a' }, { session: 'b' }]), ['a', 'b'])
})

test('identityAgrees: no project on either side is no proof; a field only one side carries does not disagree', () => {
  const none = { project: '', branch: '', head: '', session: '' }
  assert.equal(identityAgrees(none, none), false)
  assert.equal(identityAgrees({ ...none, project: 'p' }, { ...none, project: 'p', branch: 'b' }), true)
})

test('dirStamp and stampMs accept only a whole stamp, anchored at both ends', () => {
  assert.ok(Number.isNaN(dirStamp('x2026-10-02T00-00-00Z-workflow-review')))
  assert.equal(dirStamp('2026-10-02T00-00-00Z-workflow-review'), Date.parse('2026-10-02T00:00:00Z'))
  assert.ok(Number.isNaN(stampMs('2026-10-02T00-00-00Zjunk')))
  assert.ok(Number.isNaN(stampMs('x2026-10-02T00-00-00Z')))
})

/** @param {string} store @param {Date} at @param {Record<string, unknown>} [record] @param {string} [project] */
const mintWithPhase = (store, at, record = RECORD, project = '/p') => {
  const dir = checkpointDir(record, { store, now: at, project })
  writeCheckpoint(dir, 'scout', {}, { project })
  return dir
}

test('findRejoinableDir: the record\'s own project serves when the caller passes none, and no record is no crash', () => {
  const store = tmp()
  const dir = mintWithPhase(store, NOW)
  assert.equal(findRejoinableDir({ ...RECORD, project: '/p' }, { store, now: NOW }), dir)
  assert.equal(findRejoinableDir(/** @type {any} */ (undefined), { store, now: NOW, project: '/p' }), null)
})

test('findRejoinableDir adopts only a directory of this kind and name that was never finalized', () => {
  const store = tmp()
  mintWithPhase(store, NOW, { ...RECORD, name: 'other' })
  assert.equal(findRejoinableDir(RECORD, { store, now: NOW, project: '/p' }), null)
  const mine = mintWithPhase(store, NOW)
  fs.writeFileSync(path.join(mine, '.finalized'), '')
  assert.equal(findRejoinableDir(RECORD, { store, now: NOW, project: '/p' }), null)
})

test('findRejoinableDir: the rejoin window is closed at both ends', () => {
  const store = tmp()
  const dir = mintWithPhase(store, NOW)
  assert.equal(findRejoinableDir(RECORD, { store, now: NOW, project: '/p' }), dir)
  assert.equal(findRejoinableDir(RECORD, { store, now: new Date(NOW.getTime() + 6 * 60 * 60 * 1000), project: '/p' }), dir)
  assert.equal(findRejoinableDir(RECORD, { store, now: new Date(NOW.getTime() + 6 * 60 * 60 * 1000 + 1000), project: '/p' }), null)
})

test('a workflow named like a file keeps its name: only a trailing .json is a filename suffix', () => {
  const store = tmp()
  const record = { ...RECORD, name: 'a.jsonx' }
  const dir = mintWithPhase(store, NOW, record)
  assert.match(path.basename(dir), /-workflow-a\.jsonx$/)
  assert.equal(findRejoinableDir(record, { store, now: NOW, project: '/p' }), dir)
})

test('minting a partial directory creates a missing store, steps past taken stamps, and refuses after sixty', () => {
  const store = path.join(tmp(), 'nested', 'store')
  const first = checkpointDir(RECORD, { store, now: NOW, project: '/p' })
  assert.equal(path.dirname(first), partialRoot(store))
  const second = checkpointDir(RECORD, { store, now: NOW, project: '/p' })
  assert.equal(path.basename(second), `${stamp(new Date(NOW.getTime() + 1000))}-workflow-review`)
  const full = tmp()
  for (let i = 0; i < 60; i++) fs.mkdirSync(path.join(partialRoot(full), `${stamp(new Date(NOW.getTime() + i * 1000))}-workflow-review`), { recursive: true })
  assert.throws(() => checkpointDir(RECORD, { store: full, now: NOW, project: '/p' }), /cannot mint a partial directory under .* — 60 consecutive stamps taken/)
})

test('writeCheckpoint numbers only phase files, names the phase safely, and stamps no session it was not given', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'notes.txt'), '')
  fs.writeFileSync(path.join(dir, 'a01-x.json'), '{}')
  const first = writeCheckpoint(dir, 'a b', {}, { project: '/p' })
  assert.equal(path.basename(first), '00-a-b.json')
  assert.equal(path.basename(writeCheckpoint(dir, 'gate', {})), '01-gate.json')
  assert.equal(path.basename(writeCheckpoint(dir, undefined, {})), '02-phase.json')
  assert.equal('session' in JSON.parse(fs.readFileSync(first, 'utf8')), false)
  assert.equal('project' in JSON.parse(fs.readFileSync(path.join(dir, '01-gate.json'), 'utf8')), false, 'nor a project')
})

test('rawCheckpointRevisions: nothing established is [], and established revisions come back distinct and ascending', () => {
  assert.deepEqual(rawCheckpointRevisions([]), [])
  assert.deepEqual(rawCheckpointRevisions([{ phase: 'x', unreadable: 'torn' }]), [])
  assert.deepEqual(rawCheckpointRevisions([{ engineRevision: 3 }, { engineRevision: 'x' }]), [])
  assert.deepEqual(rawCheckpointRevisions([{ engineRevision: 10 }, { engineRevision: 9 }, { workflowEngineRevision: 9, engineRevision: 1 }]), [9, 10])
})

test('readCheckpoints: a missing directory has none; only NN-*.json files, in name order; a torn one carries its parse error', () => {
  assert.deepEqual(readCheckpoints(path.join(tmp(), 'missing')), [])
  const dir = tmp()
  for (const n of [9, 3, 7, 1, 5, 0, 8, 2, 6, 4]) fs.writeFileSync(path.join(dir, `0${n}-p${n}.json`), JSON.stringify({ n }))
  for (const junk of ['x00-a.json', '00-a.json.bak', 'notes.txt']) fs.writeFileSync(path.join(dir, junk), '{}')
  assert.deepEqual(readCheckpoints(dir).map(p => p['n']), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  fs.writeFileSync(path.join(dir, '10-torn.json'), '{ torn')
  let message = ''
  try { JSON.parse('{ torn') } catch (e) { message = /** @type {Error} */ (e).message }
  assert.deepEqual(readCheckpoints(dir).at(-1), { phase: '10-torn.json', unreadable: message })
})

test('safePath flattens line breaks to one space and bounds the length', () => {
  assert.equal(safePath('a\r\n\nb'), 'a b')
  assert.equal(safePath(null), '')
  assert.equal(safePath('x'.repeat(300)).length, 200)
})

test('containsPath: an empty side, an unresolvable path, the root itself, and a not-yet-existing nested path', () => {
  const base = tmp()
  assert.equal(containsPath('', 'lib'), false)
  assert.equal(containsPath(base, ''), false)
  fs.symlinkSync('loop', path.join(base, 'loop'))
  assert.equal(containsPath('/', path.join(base, 'loop', 'x')), false, 'unresolvable is no verdict, even under the root')
  assert.equal(containsPath('/', '/'), false)
  assert.equal(containsPath(path.join(base, 'a', 'b'), path.join(base, 'a', 'b', 'c')), true)
  assert.equal(containsPath(path.join(base, 'a', 'b'), path.join(base, 'b', 'a', 'c')), false)
})

test('containsPath resolves a symlinked ancestor of a path that does not exist yet', () => {
  const real = tmp()
  const link = path.join(tmp(), 'link')
  fs.symlinkSync(real, link)
  assert.equal(containsPath(real, path.join(link, 'new', 'deeper')), true)
})

test('insideStore: no directory is never inside', () => {
  assert.equal(insideStore('', tmp()), false)
})
