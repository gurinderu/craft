// A deferral (realm @nick/craft, node #204) across the REAL between-round transport: round 1 runs through
// the review engine (lib/engine-harness.mjs), its filed ledger is written to a temporary run store and
// read back by findPriorRound — the loader that normalises every row and caps each `why` at
// WHY_TRANSPORT_MAX — and that answer is round 2's prior round. runEngine alone hands a ledger across
// untouched, so the cap that cuts a long `why` (and any mark at its tail) is only exercised here.
import { test, onTestFinished } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { findPriorRound, recordFilename, WHY_TRANSPORT_MAX } from './craft-log-run.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const TITLE = 'unwrap in parser may panic'
// Lens rationales run 619–1171 chars (realm @nick/craft, node #105): longer than the transport cap.
const LONG_WHY = `panics on bad input: ${'the parser unwraps a value the caller controls; '.repeat(16)}`

const finding = () => ({
  severity: 'Medium', title: TITLE, file: 'src/parse.rs', line: 12, why: LONG_WHY, fix: 'return an error',
  blastRadius: '', source: 'safety', ruleId: 'ERR-001', symbol: 'parse', whereChecked: '',
})
const QUESTION = {
  id: 'question-1a2b3c4d5e', kind: 'question', title: TITLE, scope: 'src/parse.rs', status: 'active',
  body: 'decide once the parser is replaced in the v2 rewrite', date: '2026-10-02', author: 'alice', commit: 'abc1234', deferred: true,
  links: ['https://x/pr/3#c9'],
}
const ANSWER = (/** @type {string} */ link) => ({
  id: 'decision-9a8b7c6d5e', kind: 'decision', title: 'parser panics are accepted until v2', scope: 'src/cache.rs', status: 'active',
  body: 'answered', date: '2026-10-05', author: 'bob', commit: 'abc1234', links: [link],
})

/** @param {{ findings: any[], prior?: any }} o */
const scriptFor = ({ findings, prior }) => ({
  detect: { baseRef: 'main', files: ['src/parse.rs'], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': prior || { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: (/** @type {{ callIndex: number }} */ { callIndex }) => ({ lens: 'safety', findings: callIndex === 0 ? findings : [] }),
  dedup: { groups: [] },
  verify: () => UPHELD,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
  adjudicate: { status: 'still-open', note: '', attack: '', currentLine: 12 },
  redteam: { defeated: false, attack: '' },
  carry: { changed: false, reason: 'unchanged' },
  'decision-scope': { unchanged: [QUESTION.id], missing: [], reason: '' },
  'memory-recall': null,
  synthesis: null,
  '*': null,
})

const TS = '2026-10-06T00-00-00Z'
/** @param {string[]} args @param {string} cwd */
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()

/**
 * The round a run files, as the next round's loader reads it: the record goes into a fresh store, its
 * index row points at a real commit, and findPriorRound's answer is returned as the prior round.
 * @param {any} run @param {number} round
 */
function transported(run, round) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-deferral-transport-'))
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-deferral-repo-'))
  onTestFinished(() => { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }) })
  git(['init', '-q'], repo)
  git(['symbolic-ref', 'HEAD', 'refs/heads/feat/x'], repo)
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'i'], repo)
  const head = git(['rev-parse', 'HEAD'], repo)
  const ledger = /** @type {any[]} */ ((filedRecord(run) || {}).ledger || [])
  const rec = { ts: TS, kind: 'workflow', name: 'review', round, ledger }
  fs.writeFileSync(path.join(store, recordFilename(rec)), JSON.stringify(rec))
  fs.writeFileSync(path.join(store, 'index.jsonl'), JSON.stringify({ ts: TS, kind: 'workflow', name: 'review', project: repo, branch: 'feat/x', head, round, findingsTotal: ledger.length }) + '\n')
  const prior = findPriorRound({ store, project: repo, branch: 'feat/x' })
  assert.equal(prior.found, true, 'the filed round is found again')
  return JSON.parse(JSON.stringify(prior))
}

/** @param {any} prior */
const deferredRowOf = prior => /** @type {any[]} */ (prior.ledger).find(e => e.disposition === 'deferred')
/** @param {any} run */
const adjudications = run => run.calls.filter((/** @type {{ label: unknown }} */ c) => /^adjudicate/.test(String(c.label))).length
const KNOWN_LINE = /## Known and deferred \(open question — not in the verdict\)\n- Medium[^\n]*KNOWN AND DEFERRED: decide once the parser is replaced in the v2 rewrite — alice, 2026-10-02, https:\/\/x\/pr\/3#c9 \(question question-1a2b3c4d5e\)/

async function roundOne() {
  const run = await runEngine('review', { args: { priorDecisions: [QUESTION] }, script: scriptFor({ findings: [finding()] }) })
  assert.match(run.report, /## Known and deferred/)
  const prior = transported(run, 1)
  const row = deferredRowOf(prior)
  assert.equal(row?.why.length, WHY_TRANSPORT_MAX, 'the transport cut the long why')
  assert.doesNotMatch(row.why, /\(question question-1a2b3c4d5e\)/, 'the mark at the tail of the why did not survive the cut')
  return prior
}

test('transport: a deferral survives the why cap as a structured field on the ledger row', async () => {
  const row = deferredRowOf(await roundOne())
  assert.deepEqual(row.deferral, { id: QUESTION.id, reason: QUESTION.body, who: 'alice', when: '2026-10-02', link: 'https://x/pr/3#c9', commit: 'abc1234' })
})

test('transport: round 2 with nothing passed keeps the deferral carried, the Known and deferred line names who, when and link', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [] }, script: scriptFor({ findings: [], prior: await roundOne() }) })
  assert.equal(adjudications(run), 0, 'still settled as deferred')
  assert.match(run.report, KNOWN_LINE)
  assert.match(run.report, /✅ Approve/)
  // ... and round 3 still reads it after a second pass through the transport.
  const run3 = await runEngine('review', { args: { priorDecisions: [ANSWER(`answers: ${QUESTION.id}`)] }, script: scriptFor({ findings: [], prior: transported(run, 2) }) })
  assert.equal(adjudications(run3), 1, 'released in round 3 by an explicit answer')
})

for (const link of [`answers: ${QUESTION.id}`, `supersedes: ${QUESTION.id}`]) {
  test(`transport: round 2 releases the carried deferral by \`${link.split(':')[0]}:\` although its why was cut`, async () => {
    const run = await runEngine('review', { args: { priorDecisions: [ANSWER(link)] }, script: scriptFor({ findings: [], prior: await roundOne() }) })
    assert.equal(adjudications(run), 1, 'released — adjudicated like an ordinary prior')
    assert.doesNotMatch(run.report, /## Known and deferred/)
    assert.match(run.report, /⚠️ Warning/)
  })
}

test('a deferred prior with no structured deferral (no question record behind it) is not settled: it is adjudicated like any prior', async () => {
  const prior = await roundOne()
  const bare = { ...deferredRowOf(prior) }
  delete bare.deferral
  const run = await runEngine('review', { args: { priorDecisions: [] }, script: scriptFor({ findings: [], prior: { ...prior, ledger: [bare], ledgerCount: 1 } }) })
  assert.equal(adjudications(run), 1)
  assert.doesNotMatch(run.report, /## Known and deferred/)
  assert.match(run.report, /⚠️ Warning/)
})
