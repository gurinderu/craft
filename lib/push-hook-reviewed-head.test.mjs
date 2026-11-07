// The push hook's verdict read through the real record-writing path: craft-log-run's checkpoint and finalize file the
// index line, hasVerdict reads it. A review that ran in the background while the session committed is a verdict on the
// commit it started on, never on the one committed under it; an untracked file is not a dirty tree.
import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './craft-log-run.mjs'
import { hasVerdict } from './push-hook.mjs'
import { repoKey } from './repo-key.mjs'
import { runEngine } from './engine-harness.mjs'

const RECORD = { schemaVersion: 1, kind: 'workflow', name: 'review', nested: false, verdict: 'Approve', findings: { total: 0 } }
/** @type {string[]} */
const made = []
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })

/** @param {string} prefix @returns {string} */
function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  made.push(dir)
  return dir
}

/** @param {string[]} args @param {string} cwd @returns {string} */
function git(args, cwd) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

/** A repository with one tracked file, committed; and an empty store. @returns {{ repo: string, store: string, first: string }} */
function setup() {
  const repo = tmp('craft-reviewed-repo-')
  git(['init', '-q', '-b', 'feat/x'], repo)
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  git(['add', 'a.txt'], repo)
  git(['commit', '-q', '-m', 'a'], repo)
  return { repo, store: tmp('craft-reviewed-store-'), first: git(['rev-parse', 'HEAD'], repo) }
}

/** @param {string} repo @param {string} store @param {string[]} argv @param {Record<string, unknown>} payload */
async function logger(repo, store, argv, payload) {
  const r = await run([...argv, '--store', store, '--project', repo], {}, repo, () => JSON.stringify(payload))
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  return r
}

/**
 * A run as the engine drives the logger: its start head claimed on every slice (the head detect saw, abbreviated as
 * `git rev-parse --short` prints it), `beforePlan` between that and the first checkpoint, `between` after it.
 * @param {string} repo @param {string} store @param {() => void} between
 * @param {{ beforePlan?: () => void, startHead?: string }} [o]
 */
async function review(repo, store, between, { beforePlan = () => {}, startHead = git(['rev-parse', '--short', 'HEAD'], repo) } = {}) {
  beforePlan()
  const cp = await logger(repo, store, ['checkpoint', '--phase', 'rust-plan'], { ...RECORD, phase: 'rust-plan', startHead })
  const { runDir } = JSON.parse(/** @type {string} */ (cp.stdout[0]))
  between()
  await logger(repo, store, ['checkpoint', '--phase', 'rust-lenses', '--dir', runDir], { ...RECORD, phase: 'rust-lenses', startHead })
  await logger(repo, store, ['finalize', '--dir', runDir], RECORD)
}

/** @param {string} store @returns {Array<Record<string, unknown>>} */
const index = store => fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))

test('a review that ran while the session committed a fix is a verdict on the commit it read, not the fix', async () => {
  const { repo, store, first } = setup()
  await review(repo, store, () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n')
    git(['commit', '-q', '-am', 'fix'], repo)
  })
  const fix = git(['rev-parse', 'HEAD'], repo)
  const lines = index(store)
  assert.equal(lines[0]?.['reviewedHead'], first)
  assert.ok(!hasVerdict(lines, repoKey(repo), fix), 'the commit made during the review was never reviewed')
  assert.ok(hasVerdict(lines, repoKey(repo), first))
})

test('an untracked file does not make a review dirty; a tracked edit when it started does', async () => {
  const { repo, store, first } = setup()
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'scratch\n')
  await review(repo, store, () => fs.writeFileSync(path.join(repo, 'a.txt'), 'edited after the review started\n'))
  assert.ok(hasVerdict(index(store), repoKey(repo), first), 'untracked at the start, tracked edits after it: a clean verdict')
  const dirty = setup()
  fs.writeFileSync(path.join(dirty.repo, 'a.txt'), 'uncommitted\n')
  await review(dirty.repo, dirty.store, () => {})
  assert.equal(index(dirty.store)[0]?.['reviewedDirty'], true)
  assert.ok(!hasVerdict(index(dirty.store), repoKey(dirty.repo), dirty.first), 'the review read more than the commit')
})

test('a record with no start-of-run observation is no verdict, and a payload cannot claim one', async () => {
  const { repo, store, first } = setup()
  await logger(repo, store, ['write'], { ...RECORD, reviewedHead: first, reviewedDirty: false })
  const [line] = index(store)
  assert.equal(line?.['head'], first, 'the write-time head is kept for its other readers')
  assert.deepEqual([line?.['reviewedHead'], line?.['reviewedDirty']], [null, null])
  assert.ok(!hasVerdict(index(store), repoKey(repo), first))
})

test('a fix committed before the first checkpoint is not the reviewed head: the start claim must name the observed commit', async () => {
  const { repo, store, first } = setup()
  const commitFix = () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed while scout and gate ran\n')
    git(['commit', '-q', '-am', 'fix'], repo)
  }
  await review(repo, store, () => {}, { startHead: first.slice(0, 7), beforePlan: commitFix })
  const fix = git(['rev-parse', 'HEAD'], repo)
  const [line] = index(store)
  assert.deepEqual([line?.['reviewedHead'], line?.['reviewedDirty']], [null, null])
  assert.ok(!hasVerdict(index(store), repoKey(repo), fix) && !hasVerdict(index(store), repoKey(repo), first))
  const same = setup()
  await review(same.repo, same.store, () => {}, { startHead: same.first.slice(0, 7) })
  assert.ok(hasVerdict(index(same.store), repoKey(same.repo), same.first), 'a claim naming the observed commit keeps the verdict')
  const none = setup()
  await review(none.repo, none.store, () => {}, { startHead: '' })
  assert.ok(!hasVerdict(index(none.store), repoKey(none.repo), none.first), 'no start claim, no verdict')
})

test('the review engine claims the head its detect step saw on every checkpoint', async () => {
  const { calls } = await runEngine('review', {
    script: {
      detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
      checkpoint: { runDir: '/store/.partial/run-A', error: '' },
      '*': null,
    },
  })
  const slices = calls.filter(c => c.label.startsWith('checkpoint:'))
  assert.ok(slices.some(c => c.label === 'checkpoint:rust-plan'), 'the run reached its first checkpoint')
  for (const c of slices) assert.equal(JSON.parse(c.prompt.split(/\nPAYLOAD:\s*\n/)[1] ?? 'null')?.startHead, 'abc1234', c.label)
})
