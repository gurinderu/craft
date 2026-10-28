// The command over lib/match-external-findings.mjs, with `gh` replaced by fixtures: no network.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run, USAGE } from './match-external-findings-cli.mjs'

const sha = (/** @type {number} */ i) => String(i).repeat(40).slice(0, 40)
const PR_VIEW = { author: { login: 'pr-author' }, headRefName: 'feat/x', commits: [{ oid: sha(1) }, { oid: sha(2) }],
  reviews: [{ author: { login: 'ext-reviewer' }, body: 'round', submittedAt: '2026-10-02T12:01:00Z', commit: { oid: sha(2) } }] }
const COMMENTS = [[
  { id: 1, user: { login: 'ext-reviewer' }, body: 'FR-RACE-abc123 must-fix: lock guard dropped before write', path: 'src/a.rs', line: 41, original_commit_id: sha(2), created_at: '2026-10-02T12:00:00Z' },
  { id: 2, user: { login: 'pr-author' }, body: 'not a finding', path: 'src/a.rs', line: 1, original_commit_id: sha(2), created_at: '2026-10-02T12:00:00Z' },
]]
const LEDGER = [{ fp: 'fp000001', file: 'src/a.rs', line: 40, severity: 'High', tier: 'confirmed', disposition: 'open', title: 'lock guard dropped before write', why: '' },
  { fp: 'fp000002', file: 'src/z.rs', line: 9, severity: 'Medium', tier: 'confirmed', disposition: 'open', title: 'unrelated', why: '' }]

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'match-ext-'))
  const runs = path.join(dir, 'runs')
  fs.mkdirSync(runs)
  // Another repository's run on a branch of the same name: never this PR's.
  fs.writeFileSync(path.join(runs, '2026-10-01T00-00-01Z-review.json'), JSON.stringify({ name: 'review', ts: '2026-10-01T00-00-01Z', project: '/work/other', branch: 'feat/x', head: sha(2),
    ledger: [{ fp: 'foreign1', file: 'src/a.rs', line: 40, severity: 'High', tier: 'confirmed', title: 'lock guard dropped', why: '' }] }))
  fs.writeFileSync(path.join(runs, '2026-10-01T00-00-00Z-review.json'), JSON.stringify({ name: 'review', ts: '2026-10-01T00-00-00Z', project: '/work/repo', branch: 'feat/x', head: sha(2), ledger: LEDGER }))
  /** @type {string[][]} */
  const calls = []
  /** @param {string[]} args */
  const gh = args => { calls.push(args); return args[0] === 'api' ? COMMENTS : PR_VIEW }
  /** @param {string} d */
  const remotesOf = d => (d === '/work/repo' ? 'origin\tgit@github.com:example/repo.git (fetch)\n' : 'origin\thttps://github.com/example/other (fetch)\n')
  return { dir, runs, calls, gh, remotesOf, deps: { gh, remotesOf }, base: ['--repo', 'example/repo', '--pr', '7', '--runs-dir', runs] }
}

test('a bad command line is a usage error, exit 2', async () => {
  for (const argv of [[], ['--pr', '7'], ['--repo', 'example/repo'], ['--repo', 'example/repo', '--pr', 'x'], ['--repo', 'not a repo', '--pr', '7'], ['--repo', 'example/repo', '--pr', '7', '--bogus']]) {
    const r = await run(argv, {}, { gh: () => assert.fail('no gh on a usage error') })
    assert.equal(r.exitCode, 2, argv.join(' '))
    assert.equal(r.stderr.at(-1), USAGE)
  }
})

test('without decisions: ranked candidates per finding, gh called with argument arrays, the author left out', async () => {
  const s = setup()
  const r = await run([...s.base, '--id-regex', 'FR-[A-Z]+-[0-9a-f]{6}'], {}, s.deps)
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  assert.deepEqual(s.calls, [['api', 'repos/example/repo/pulls/7/comments', '--paginate', '--slurp'], ['pr', 'view', '7', '--repo', 'example/repo', '--json', 'reviews,headRefName,commits,author']])
  const out = r.stdout.join('\n')
  assert.match(out, /^projects: \/work\/repo$/m)
  assert.doesNotMatch(out, /foreign1/, 'another repository\'s run')
  assert.match(out, /## PR 7 feat\/x reviewers=ext-reviewer findings=1 /)
  assert.match(out, /FR-RACE-abc123 \[must-fix\] src\/a\.rs:41 — 1 candidate\(s\)/)
  assert.match(out, /fp000001 src\/a\.rs:40 High\/confirmed lock guard/)
  assert.doesNotMatch(out, /COUNTS|never raised/)
})

test('with decisions: buckets, counts and the precision side; --json keeps the whole result; the cache spares gh', async () => {
  const s = setup()
  const decisions = path.join(s.dir, 'decisions.json')
  fs.writeFileSync(decisions, JSON.stringify({ '7:FR-RACE-abc123': { matches: [{ rec: '2026-10-01', fp: 'fp000001', reason: 'same guard' }], note: 'n1' }, '7:FR-GONE-000000': {} }))
  const json = path.join(s.dir, 'out.json')
  const argv = [...s.base, '--reviewer', 'ext-reviewer', '--id-regex', 'FR-[A-Z]+-[0-9a-f]{6}', '--decisions', decisions, '--json', json, '--cache-dir', path.join(s.dir, 'cache')]
  const r = await run(argv, {}, s.deps)
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  const out = r.stdout.join('\n')
  assert.match(out, /^WARNING: decision 7:FR-GONE-000000 matches no finding$/m)
  assert.match(out, /FR-RACE-abc123 \[must-fix\] src\/a\.rs:41 -> SEEN_CONFIRMED \(n1\)/)
  assert.match(out, /never raised: 1\n {2}fp000002 \[Medium\] src\/z\.rs:9 unrelated/)
  assert.match(out, /COUNTS \(pr\|severity\|bucket\):\n7\|must-fix\|SEEN_CONFIRMED 1\nALL\|must-fix\|SEEN_CONFIRMED 1/)
  const saved = JSON.parse(fs.readFileSync(json, 'utf8'))
  assert.equal(saved.prs['7'].results[0].matches[0].reason, 'same guard')
  assert.deepEqual([saved.projects, saved.unmatchedDecisions], [['/work/repo'], ['7:FR-GONE-000000']])
  assert.equal(s.calls.length, 2)
  const again = await run(argv, {}, { remotesOf: s.remotesOf, gh: () => assert.fail('cached') })
  assert.deepEqual(again.stdout, r.stdout)
})

test('a missing decisions file, a bucket that is not one, or no run store fail with exit 1', async () => {
  const s = setup()
  const bad = path.join(s.dir, 'bad.json')
  fs.writeFileSync(bad, JSON.stringify({ '7:x': { bucket: 'SEEN' } }))
  for (const [extra, msg] of /** @type {Array<[string[], RegExp]>} */ ([[['--decisions', path.join(s.dir, 'none.json')], /ENOENT/], [['--decisions', bad], /bucket SEEN is not one of/]])) {
    const r = await run([...s.base, ...extra], {}, s.deps)
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr.join('\n'), msg)
  }
  const none = await run(['--repo', 'example/repo', '--pr', '7'], {}, { gh: s.gh, home: s.dir })
  assert.equal(none.exitCode, 1)
  assert.match(none.stderr.join('\n'), /no run store at .*\.craft\/runs/)
})

test('--project names the checkout whose runs count, by the key the records use', async () => {
  const s = setup()
  const r = await run([...s.base, '--project', s.dir], {}, s.deps)
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  assert.match(r.stdout.join('\n'), /runs=0/, 'the store holds no run of that checkout')
})
