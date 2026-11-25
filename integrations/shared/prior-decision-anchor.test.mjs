// A record anchored by its date when it names no commit (realm @nick/craft, node #676): the date read,
// the scope-check line run against a repository with dated commits, and the split it drives.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePriorDecisions } from './prior-decisions.mjs'
import { anchorMissingReason, anchorSince, decisionDate, hasAnchor } from './prior-decision-anchor.mjs'
import { applyPriorDecisions, recordsDeferral, reraiseReason } from './prior-decision-apply.mjs'
import { candidatesToCheck, decisionsToCheck, scopeCheckScript } from './prior-decision-scope.mjs'

const record = (/** @type {Record<string, unknown>} */ over = {}) => ({
  id: 'decision-d1d1d1d1d1',
  title: 'clone in the hot loop',
  scope: 'src/a.rs',
  reason: 'measured cold',
  who: 'nick',
  when: '2026-05-02',
  ...over,
})
const parsed = (/** @type {Array<Record<string, unknown>>} */ ...over) => /** @type {any[]} */ (parsePriorDecisions(over.map(o => record(o))).decisions)
const finding = (over = {}) => ({ file: 'src/a.rs', title: 'clone in the hot loop', severity: 'Medium', why: 'w', ...over })

test('date: read from the start of `when`, a real calendar day not run on by another digit', () => {
  /** @type {Array<[string, string]>} */
  const cases = [
    ['2026-05-01', '2026-05-01'],
    ['2026-05-01T10:00:00Z', '2026-05-01'],
    ['2026-05-01 by nick', '2026-05-01'],
    ['2024-02-29', '2024-02-29'],
    ['2000-02-29', '2000-02-29'],
    ['1900-02-29', ''],
    ['2026-02-29', ''],
    ['2026-00-10', ''],
    ['2026-13-01', ''],
    ['2026-05-00', ''],
    ['2026-05-011', ''],
    ['2026/05/01', ''],
    ['+026-05-01', ''],
    ['June 2026', ''],
    ['', ''],
  ]
  for (const [when, day] of cases) assert.equal(decisionDate(/** @type {any} */ ({ when })), day, when)
  const last = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  last.forEach((days, i) => {
    const m = String(i + 1).padStart(2, '0')
    assert.equal(decisionDate(/** @type {any} */ ({ when: `2026-${m}-${days}` })), `2026-${m}-${days}`)
    assert.equal(decisionDate(/** @type {any} */ ({ when: `2026-${m}-${days + 1}` })), '', `2026-${m}-${days + 1}`)
  })
})

test('anchor: the commit before the date, the date when there is no commit, and neither is no anchor', () => {
  const [both, dated, vague, undated] = parsed({ commit: 'abc1234' }, { id: 'd2' }, { id: 'd3', when: 'early May' }, { id: 'd4', commit: 'abc1234', when: '' })
  assert.deepEqual([hasAnchor(both), hasAnchor(dated), hasAnchor(vague), hasAnchor(undated)], [true, true, false, true])
  assert.equal(anchorSince(both), 'abc1234')
  assert.equal(anchorSince(dated), 'the decision date 2026-05-02')
  assert.equal(anchorMissingReason(both), 'commit abc1234 not found in this repo — raised normally')
  assert.equal(anchorMissingReason(dated), 'no commit in this repo before the decision date 2026-05-02 — raised normally')
  const f = finding()
  assert.equal(reraiseReason(f, dated, new Set([dated.id])), '')
  assert.equal(reraiseReason(f, dated, new Set()), 'the code in src/a.rs changed since the decision date 2026-05-02 (or that could not be checked)')
  assert.equal(reraiseReason(f, dated, new Set(), new Set([dated.id])), anchorMissingReason(dated))
  assert.equal(reraiseReason(f, vague, new Set([vague.id])), 'the decision records no commit and no date, so an unchanged scope cannot be established')
  assert.equal(reraiseReason(finding({ severity: 'Critical' }), dated, new Set([dated.id])), 'a Critical finding is never set aside by a prior decision')
})

test('check list: a dated record is checked, one with neither a commit nor a date is not', () => {
  const ds = parsed({}, { id: 'd2', when: 'early May' })
  assert.deepEqual(
    decisionsToCheck([finding()], ds).map(d => d.id),
    ['decision-d1d1d1d1d1'],
  )
  assert.deepEqual(decisionsToCheck([finding()], ds.slice(1)), [])
  assert.deepEqual(candidatesToCheck([finding()], ds.slice(1)), [])
  assert.deepEqual(
    candidatesToCheck([finding()], ds).map(d => d.id),
    ['decision-d1d1d1d1d1'],
  )
})

test('deferral: a question records one with a date in place of a commit, not with neither', () => {
  const q = (/** @type {Record<string, unknown>} */ over) => ({ kind: 'question', deferred: true, ...over })
  const [dated, vague] = parsed(q({ id: 'question-1' }), q({ id: 'question-2', when: '' }))
  assert.equal(recordsDeferral(dated), true)
  assert.equal(recordsDeferral(vague), false)
})

test('apply: a dated record sets aside when unchanged, raises and names its date when no commit precedes it', async () => {
  const [d, vague] = parsed({}, { id: 'd2', scope: 'src/b.rs', title: 'sleep in the retry', when: 'soon' })
  const f = finding()
  const g = finding({ file: 'src/b.rs', title: 'sleep in the retry' })
  const aside = await applyPriorDecisions({ confirmed: [f, g] }, [d, vague], async () => ({ unchanged: [d.id, 'd2'], missing: [], reason: '' }))
  assert.equal(aside.setAside.length, 1)
  assert.equal(aside.setAside[0]?.priorDecision, d.id)
  assert.match(String(aside.tiers['confirmed']?.[0]?.why), /records no commit and no date/)
  const missing = await applyPriorDecisions({ confirmed: [f] }, [d], async () => ({ unchanged: [], missing: [d.id], reason: '' }))
  assert.equal(missing.setAside.length, 0)
  assert.deepEqual(missing.refused, [`decision ${d.id}: no commit in this repo before the decision date 2026-05-02 — raised normally`])
  const qs = parsed({ id: 'question-9', kind: 'question', deferred: true, when: '' })
  const noted = await applyPriorDecisions({ confirmed: [f] }, qs, async () => ({ unchanged: ['question-9'], missing: [], reason: '' }))
  assert.match(noted.refused.join('\n'), /question question-9: records a deferral but no commit and no date/)
})

/** Runs git in `dir`, its commit dated `date`. @param {string} dir @param {string[]} args @param {string} [date] */
const git = (dir, args, date = '2026-01-01T00:00:00+0000') =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@x',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@x',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  }).trim()

test('scope script: a dated record is diffed against the last commit before 00:00 UTC of its day, missing when there is none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'craft-anchor-'))
  try {
    git(dir, ['init', '-q', '-b', 'main'])
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src/a.rs'), 'a\n')
    writeFileSync(join(dir, 'src/b.rs'), 'b\n')
    git(dir, ['add', '.'])
    git(dir, ['commit', '-qm', 'one'], '2026-05-01T12:00:00+0000')
    writeFileSync(join(dir, 'src/b.rs'), 'b2\n')
    // 2026-05-02 01:30 UTC: after the start of the 2nd in UTC, though the 1st where it was made.
    git(dir, ['commit', '-qam', 'two'], '2026-05-01T23:30:00-0200')
    const ds = parsed(
      { id: "a-2nd's" },
      { id: 'b-2nd', scope: 'src/b.rs' },
      { id: 'a-1st', when: '2026-05-01' },
      { id: 'b-3rd', scope: 'src/b.rs', when: '2026-05-03' },
    )
    const script = scopeCheckScript(ds)
    assert.equal(
      script.split('\n')[0],
      `b=$(git rev-list -1 '--before=2026-05-02 00:00:00 +0000' HEAD 2>/dev/null); if [ -n "$b" ]; then git diff --quiet "$b" -- 'src/a.rs'; echo 'a-2nd'\\''s' $?; else echo 'a-2nd'\\''s' missing; fi`,
    )
    const run = () => execFileSync('sh', ['-c', script], { cwd: dir, encoding: 'utf8' }).trim().split('\n')
    assert.deepEqual(run(), ["a-2nd's 0", 'b-2nd 1', 'a-1st missing', 'b-3rd 0'])
    writeFileSync(join(dir, 'src/b.rs'), 'b3\n')
    assert.deepEqual(run(), ["a-2nd's 0", 'b-2nd 1', 'a-1st missing', 'b-3rd 1'], 'the working tree counts as a change')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
