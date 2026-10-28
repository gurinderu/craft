// Which run-store records are a PR's runs, and which runs reviewed a file (lib/match-external-runs.mjs).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { branchRuns, projectsOf, remoteRepos, reviewed, runTime } from './match-external-runs.mjs'

const sha = (/** @type {number} */ i) => String(i).repeat(40).slice(0, 40)
const PR = { author: { login: 'pr-author' }, headRefName: 'feat/x', commits: [1, 2, 3, 4].map(i => ({ oid: sha(i) })), reviews: [] }
/** @param {string} ts @param {number} head  index into PR.commits @param {Record<string, unknown>} [over] */
const rec = (ts, head, over = {}) => ({ name: 'review', ts, project: '/work/repo', branch: 'feat/x', head: sha(head + 1), ledger: [], ...over })

test('run-store timestamps parse to their instant', () => {
  assert.equal(runTime('2026-10-21T19-12-00Z'), Date.parse('2026-10-21T19:12:00Z'))
})

test('a git remote listing names its GitHub repositories, whatever the URL form', () => {
  const v = 'origin\thttps://github.com/Example/Repo.git (fetch)\nup\tgit@github.com:example/other (push)\nx\tssh://git@github.com/example/third.git (fetch)\ny\thttps://gitlab.com/example/repo (fetch)\n'
  assert.deepEqual([...remoteRepos(v)].sort(), ['example/other', 'example/repo', 'example/third'])
})

test('the projects of a repository are the recorded checkouts whose remotes name it', () => {
  const records = [rec('t', 0), rec('t', 0, { project: '/work/fork' }), rec('t', 0, { project: '/gone' })]
  /** @type {Record<string, string>} */
  const remotes = { '/work/repo': 'origin\thttps://github.com/example/repo (fetch)\n', '/work/fork': 'origin\thttps://github.com/someone/repo (fetch)\n' }
  assert.deepEqual([...projectsOf(records, 'Example/Repo', d => remotes[d] ?? '')], ['/work/repo'])
})

test('the PR\'s runs: review runs of its projects, on its branch or at its commits, oldest first', () => {
  const runs = branchRuns([rec('2026-10-03T00-00-00Z', 3), rec('2026-10-01T00-00-00Z', 0, { branch: 'other' }), rec('2026-10-02T00-00-00Z', 9, { head: 'f'.repeat(40) }),
    rec('2026-10-02T00-00-00Z', 1, { name: 'adversarial-review' }), rec('2026-10-02T00-00-00Z', 1, { branch: 'other', head: 'e'.repeat(40) }),
    rec('2026-10-02T00-00-00Z', 1, { project: '/work/other-repo' })], PR, new Set(['/work/repo']))
  assert.deepEqual(runs.map(r => [r.ts, r.hIdx]), [['2026-10-01T00-00-00Z', 0], ['2026-10-02T00-00-00Z', -1], ['2026-10-03T00-00-00Z', 3]])
})

test('a run is dead when partial, INCOMPLETE or with anything not run; its scope is its path', () => {
  const runs = branchRuns([rec('2026-10-01T00-00-00Z', 0, { partial: true }), rec('2026-10-02T00-00-00Z', 0, { verdict: 'INCOMPLETE' }),
    rec('2026-10-03T00-00-00Z', 0, { notRun: ['x'] }), rec('2026-10-04T00-00-00Z', 0, { verdict: 'Warning (PARTIAL COVERAGE)', notRun: [], path: 'src/a/' })], PR, new Set(['/work/repo']))
  assert.deepEqual(runs.map(r => [r.dead, r.scope]), [[true, ''], [true, ''], [true, ''], [false, 'src/a']])
})

test('a run reviewed a file inside its scope and not among its uncovered files; a file-less finding only a whole-repo run', () => {
  /** @param {string} scope @param {string[]} [uncovered] @returns {any} */
  const run = (scope, uncovered = []) => ({ scope, uncovered })
  assert.ok(reviewed(run(''), 'src/a/x.rs'))
  assert.ok(reviewed(run('src/a'), 'src/a/x.rs'))
  assert.ok(!reviewed(run('src/a'), 'src/ab/x.rs'))
  assert.ok(!reviewed(run('', ['src/a/x.rs']), 'src/a/x.rs'))
  assert.ok(reviewed(run(''), null))
  assert.ok(!reviewed(run('src/a'), null))
})
