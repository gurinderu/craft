// Reading a dead run back out of its transcript, pinned at the edges: which result shapes count,
// how a verifier's prompt is found and parsed back into the finding it judged, how verdicts are
// tallied and linked, how journal candidates merge, and what the reconstructed record says.
import { test, onTestFinished } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  classifyResult, readJsonlCounted, runtimeStats, parseIndividualVerifyTarget, parseBatchVerifyTargets,
  verifyVerdictsFromJournal, dedupJournalFindings, findingsFromJournal, recordFromJournal, normalizeStampBoundary,
} from './craft-log-run.mjs'

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-journal-edges-'))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** @param {string} dir @param {unknown[]} entries */
const journal = (dir, entries) => fs.writeFileSync(path.join(dir, 'journal.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n')
/** @param {string} dir @param {string} id @param {unknown[]} entries */
const transcript = (dir, id, entries) => fs.writeFileSync(path.join(dir, `agent-${id}.jsonl`), entries.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n') + '\n')
/** @param {string} text */
const userSays = text => ({ type: 'user', message: { content: text } })
const F = { severity: 'High', title: 'unwrap panics', file: 'a.rs', line: 1, why: 'w', source: 'safety' }
const PROMPT = 'FINDING: [High] unwrap panics\n  at a.rs:1'
/** @param {string} id @param {boolean} refuted */
const verify = (id, refuted) => ({ type: 'result', agentId: id, result: { refuted, citedLineMatches: true } })
/** @param {string} id @param {unknown[]} findings */
const lens = (id, findings) => ({ type: 'result', agentId: id, result: { lens: 'safety', findings } })

test('classifyResult: a shape is matched only by all of its marks; nothing known is unknown', () => {
  for (const half of [{}, { refuted: true }, { citedLineMatches: true }, { lenses: [] }, { sizeBucket: 's' }, { files: [] }, { baseRef: 'x' }, { status: 'pass' }, { seedFindings: [] }]) {
    assert.equal(classifyResult(half), 'unknown', JSON.stringify(half))
  }
})

test('readJsonlCounted: a whitespace-only line is no line, not a malformed one', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'x.jsonl'), '  \n{"a":1}\n\t\n')
  assert.deepEqual(readJsonlCounted(path.join(dir, 'x.jsonl')), { entries: [{ a: 1 }], malformed: 0 })
})

test('runtimeStats: only agent-*.jsonl transcripts, untimed lines and untimed agents ignored, models from meta', () => {
  const dir = tmp()
  const at = /** @param {number} min */ min => ({ timestamp: new Date(Date.UTC(2026, 9, 2, 12, min)).toISOString() })
  // Read in name order (a, b, c, quiet): the earliest start and the latest end both sit on agents read
  // before the last one, so neither bound can be taken from whichever agent happened to come last.
  transcript(dir, 'a', [at(5), {}, at(20)])
  transcript(dir, 'b', [at(0), at(10)])
  transcript(dir, 'c', [at(3), at(8)])
  transcript(dir, 'quiet', [{}, {}])
  fs.writeFileSync(path.join(dir, 'agent-a.meta.json'), JSON.stringify({ model: 'opus' }))
  fs.writeFileSync(path.join(dir, 'agent-b.meta.json'), JSON.stringify({}))
  fs.writeFileSync(path.join(dir, 'xagent-c.jsonl'), JSON.stringify(at(0)))
  fs.writeFileSync(path.join(dir, 'agent-d.jsonl.bak'), JSON.stringify(at(0)))
  const s = runtimeStats(dir)
  assert.deepEqual(s, { agents: 4, wallClockMinutes: 20, agentMinutes: 30, longestStallSeconds: 900, byModel: { opus: 1, unknown: 2 } })
})

test('parseIndividualVerifyTarget tolerates any spacing around the severity and before the path', () => {
  assert.deepEqual(parseIndividualVerifyTarget('FINDING:[High]t\n  at  a.rs:1'), { title: 't', file: 'a.rs', line: 1 })
})

test('parseBatchVerifyTargets tolerates any spacing in the block header and reads multi-digit indices', () => {
  assert.deepEqual([...parseBatchVerifyTargets('---FINDING  12--- \n[High]t\n  at  b.rs:3')], [[12, { title: 't', file: 'b.rs', line: 3 }]])
})

test('the verify prompt is the first user message with text: other roles, empty messages and non-text blocks are passed over', () => {
  const dir = tmp()
  journal(dir, [verify('v1', true)])
  transcript(dir, 'v1', [
    'null',
    { type: 'assistant', message: { content: 'FINDING: [High] decoy\n  at d.rs:9' } },
    { type: 'user' },
    { type: 'user', message: { content: [{ type: 'image' }, null] } },
    { type: 'user', message: { content: 5 } },
    { type: 'user', message: { content: [{ type: 'image' }, null, { type: 'text', text: PROMPT }] } },
  ])
  const { tally, linked } = verifyVerdictsFromJournal(dir)
  assert.equal(linked, 1)
  assert.deepEqual([...tally], [['a.rs:1:unwrap panics', { refuted: 1, upheld: 0 }]])
})

test('a text block with no text ends the search for the prompt', () => {
  const dir = tmp()
  journal(dir, [verify('v1', true)])
  transcript(dir, 'v1', [{ type: 'user', message: { content: [{ type: 'text' }] } }, userSays(PROMPT)])
  assert.equal(verifyVerdictsFromJournal(dir).linked, 0)
})

test('verdicts: only result entries count; a batch counts its non-null verdicts; unmatched ones and missing transcripts link nothing', () => {
  const dir = tmp()
  journal(dir, [
    { type: 'progress', agentId: 'v0', result: { refuted: true, citedLineMatches: true } },
    verify('v1', false),
    { type: 'result', agentId: 'vb', result: { verdicts: [{ index: 1, refuted: true }, null, { index: 2, refuted: false }, { index: 7, refuted: true }] } },
    verify('v2', true),
    verify('v3', true),
    { type: 'result', result: { refuted: true, citedLineMatches: true } },
  ])
  transcript(dir, 'v0', [userSays(PROMPT)])
  transcript(dir, 'v1', [userSays(PROMPT)])
  transcript(dir, 'vb', [userSays('--- FINDING 1 ---\n[High] unwrap panics\n  at a.rs:1\n--- FINDING 2 ---\n[Low] nit\n  at b.rs:2')])
  transcript(dir, 'v2', [userSays('no finding named here')])
  fs.mkdirSync(path.join(dir, 'agent-v3.jsonl'))
  transcript(dir, 'undefined', [userSays(PROMPT)])
  const { tally, seen, linked } = verifyVerdictsFromJournal(dir)
  assert.deepEqual([seen, linked], [7, 3])
  assert.deepEqual(Object.fromEntries(tally), { 'a.rs:1:unwrap panics': { refuted: 1, upheld: 1 }, 'b.rs:2:nit': { refuted: 0, upheld: 1 } })
})

test('dedupJournalFindings: the higher severity wins, an unknown one ranks below Info, ties keep the first, sources union without blanks', () => {
  const low = { ...F, severity: 'Low', why: 'w-low', source: undefined }
  const high = { ...F, severity: 'High', why: '', source: 'safety' }
  assert.deepEqual(dedupJournalFindings([null, low, high]), [{ ...high, why: 'w-low', sources: ['safety'] }])
  assert.deepEqual(dedupJournalFindings([low]), [{ ...low, sources: [] }])
  assert.deepEqual(defined(dedupJournalFindings([high, low])[0]).sources, ['safety'])
  const weird = { ...F, severity: 'Weird', why: 'w0' }
  const info = { ...F, severity: 'Info', why: 'w1' }
  assert.equal(defined(dedupJournalFindings([weird, info])[0]).severity, 'Info')
  assert.equal(defined(dedupJournalFindings([info, weird])[0]).severity, 'Info')
  const second = { ...F, why: 'second' }
  assert.equal(defined(dedupJournalFindings([F, second])[0]).why, 'w')
  assert.equal(defined(dedupJournalFindings([{ ...F, severity: 'Low' }, { ...F, why: 'w-high' }])[0]).why, 'w-high')
})

/** @template T @param {T | undefined} x @returns {T} */
function defined(x) {
  assert.ok(x !== undefined)
  return x
}

test('journal candidates: only result entries, no null findings or seeds, a seed without a source is the gate\'s', () => {
  const dir = tmp()
  const other = { ...F, title: 'other', file: 'z.rs' }
  journal(dir, [
    { type: 'progress', result: { lens: 'x', findings: [other] } },
    lens('l1', [null, F]),
    { type: 'result', agentId: 'g', result: { status: 'pass', seedFindings: [null, { ...F, title: 'seed', file: 's.rs', source: undefined }] } },
    verify('v1', false),
  ])
  transcript(dir, 'v1', [userSays(PROMPT)])
  const out = findingsFromJournal(dir)
  assert.deepEqual(out.map(f => [f.title, f.source]), [['unwrap panics', 'safety'], ['seed', 'gate']])
})

/** @param {string} dir @param {boolean[]} votes @param {boolean} [orphan] */
const judged = (dir, votes, orphan = false) => {
  const entries = [lens('l1', [F]), ...votes.map((r, i) => verify(`v${i}`, r))]
  if (orphan) entries.push(verify('lost', true))
  journal(dir, entries)
  votes.forEach((_, i) => transcript(dir, `v${i}`, [userSays(PROMPT)]))
  return findingsFromJournal(dir)
}

test('a split panel is no majority against a finding: carried as suspected, with the votes in its why', () => {
  const [f] = judged(tmp(), [true, false])
  assert.equal(defined(f)['tier'], 'suspected')
  // The finding's own why first, then the votes it was carried on and the tier that follows from them.
  assert.match(String(defined(f).why), /^w \(.*\b1 upheld \/ 1 refuted\b.*not a majority.*suspected/)
  const dir = tmp()
  journal(dir, [lens('l1', [{ ...F, why: undefined }]), verify('v0', false)])
  transcript(dir, 'v0', [userSays(PROMPT)])
  assert.match(String(defined(findingsFromJournal(dir)[0]).why), /^\(the dead run's own verification recovered 1 upheld/)
})

test('a verdict links to its finding through case and whitespace differences in the title', () => {
  const dir = tmp()
  journal(dir, [lens('l1', [{ ...F, title: 'Unwrap  panics' }]), verify('v0', true)])
  transcript(dir, 'v0', [userSays('FINDING: [High] unwrap panics \n  at a.rs:1')])
  assert.deepEqual(findingsFromJournal(dir), [], 'the refuted finding is dropped: its verdict linked')
})

test('a refuted majority on an incomplete panel is demoted, not dropped, and says so after its own why', () => {
  const [f] = judged(tmp(), [true], true)
  assert.equal(defined(f)['tier'], 'suspected')
  assert.match(String(defined(f).why), /^w \(demoted, not dropped: .* 1\/2 verify verdict\(s\) in this journal linked .* a 1 refuted \/ 0 upheld count/)
  const dir = tmp()
  journal(dir, [lens('l1', [{ ...F, why: undefined }]), verify('v0', true), verify('lost', true)])
  transcript(dir, 'v0', [userSays(PROMPT)])
  assert.match(String(defined(findingsFromJournal(dir)[0]).why), /^\(demoted, not dropped/)
})

test('an unvoted finding beside a voted one is carried untouched', () => {
  const dir = tmp()
  const other = { ...F, title: 'other', file: 'z.rs' }
  journal(dir, [lens('l1', [F, other]), verify('v0', false)])
  transcript(dir, 'v0', [userSays(PROMPT)])
  assert.deepEqual(findingsFromJournal(dir).find(f => f.title === 'other'), { ...other, sources: ['safety'] })
})

test('recordFromJournal: kinds and votes tallied, sources counted, defaults, branch, and no loss when every agent returned', () => {
  const dir = tmp()
  journal(dir, [
    { type: 'started', agentId: 'l1' }, { type: 'started', agentId: 'l2' },
    lens('l1', [{ ...F, source: undefined }, { ...F, title: 'other', file: 'z.rs', source: undefined }]), lens('l2', []),
    { type: 'result', agentId: 'vb', result: { verdicts: [{ index: 1, refuted: false }, { index: 2, refuted: false }, { index: 3, refuted: true }] } },
    verify('v1', false),
    { type: 'result', agentId: 'b', result: { baseRef: 'origin/main', files: [], head: 'h', branch: 'feat' } },
  ])
  const rec = recordFromJournal(dir)
  assert.deepEqual([rec.name, rec.kind, rec.runtime, rec.nested], ['review', 'workflow', 'claude-code', false])
  assert.deepEqual(rec.resultKinds, { lens: 2, 'verify-batch': 1, verify: 1, base: 1 })
  assert.deepEqual(rec.verificationVotes, { refuted: 1, upheld: 3 })
  assert.deepEqual(rec.candidatesBySource, { unknown: 2 })
  assert.equal(rec.branch, 'feat')
  assert.deepEqual(rec.scout, [])
  assert.deepEqual(rec.notRun, [])
})

test('recordFromJournal names how many agents never returned', () => {
  const dir = tmp()
  journal(dir, [{ type: 'started' }, { type: 'started' }, { type: 'started' }, lens('l1', [])])
  assert.deepEqual(recordFromJournal(dir).notRun, ['2 agent(s) never returned a result'])
  const even = tmp()
  journal(even, [{ type: 'started' }, lens('l1', [])])
  assert.deepEqual(recordFromJournal(even).notRun, [])
})

test('normalizeStampBoundary trims, and accepts only a whole timestamp', () => {
  assert.equal(normalizeStampBoundary(' 2026-09-01T20:08:31Z '), '2026-09-01T20-08-31Z')
  assert.equal(normalizeStampBoundary('x2026-09-01T20:08:31Z'), null)
  assert.equal(normalizeStampBoundary('2026-09-01T20:08:31Zx'), null)
})
