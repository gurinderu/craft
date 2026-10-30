// Never Approve over what did not run, stop at a usage limit, attempt the record (realm @nick/craft,
// nodes #298, #299), executed end to end through the harness for review, adversarial-review and rust-audit.
// The shape in which the Workflow sandbox hands an engine a usage-limit failure (a throw, a text answer,
// or a bare null) is NOT observed: the limit fixtures below throw it or answer it as text, the two
// shapes the engines can read. A bare null is invisible to them, and for it the guarantee is the
// dead-lens path: every lens that did not return makes the verdict INCOMPLETE (the first tests).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const LIMIT = "You've hit your weekly limit - resets Oct 24, 5pm (Europe/Berlin)"
const LOW = { title: 'a nit', file: 'src/lib.rs', line: 3, severity: 'Low', why: 'w', fix: 'f', ruleId: '' }

/**
 * Two lenses: `safety` answers with one Low finding, `correctness` answers with `other` (dead by default).
 * @param {Record<string, unknown>} [o]
 * @param {(c: { opts: { label?: string } }) => unknown} [other]
 */
const script = (o = {}, other = () => null) => ({
  detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, output: ['wrote r.json'] },
  scout: { sizeBucket: 'small', lenses: ['safety', 'correctness'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: (/** @type {{ opts: { label?: string } }} */ c) => (/:safety/.test(String(c.opts.label)) ? { lens: 'safety', findings: [LOW] } : other(c)),
  dedup: { groups: [] },
  synthesis: null,
  '*': null,
  ...o,
})

/** @param {string} report @returns {string} */
const verdictLine = report => {
  const lines = report.split('\n')
  const head = lines.findIndex(l => /^#+\s*Verdict\b/i.test(l.trim()))
  return String(lines.find((l, i) => i > head && l.trim()))
}

test('review: a synthesized Approve over a dead lens is INCOMPLETE, in the report and the record', async () => {
  const run = await runEngine('review', { script: script({ synthesis: '## Verdict\n\u2705 Approve \u2014 no Medium or higher.\n\n## Gate\nCI' }) })
  const line = verdictLine(run.report)
  assert.match(line, /INCOMPLETE/, line)
  assert.doesNotMatch(line, /Approve \(|\u2705/, line)
  assert.match(line, /did not run: [^\n]*lenses that never returned/, 'the line names what did not run')
  const rec = filedRecord(run)
  assert.equal(rec?.verdict, 'INCOMPLETE')
  assert.ok(rec?.notRun.some((/** @type {string} */ n) => /lenses that never returned/.test(n)), rec?.notRun.join('\n'))
})

test('review: the fallback report over a dead lens is INCOMPLETE, never Approve', async () => {
  const run = await runEngine('review', { script: script() })
  const line = verdictLine(run.report)
  assert.match(line, /^\u26a0\ufe0f INCOMPLETE \u2014 synthesis agent died twice; mechanical fallback report/, line)
  assert.doesNotMatch(line, /Approve/, line)
  assert.equal(filedRecord(run)?.verdict, 'INCOMPLETE')
})

test('review: every lens dead and nothing found is INCOMPLETE on the early exit too', async () => {
  const run = await runEngine('review', { script: script({ lens: null }) })
  assert.match(verdictLine(run.report), /^\u26a0\ufe0f INCOMPLETE/, run.report)
  assert.equal(filedRecord(run)?.verdict, 'INCOMPLETE')
})

test('review: a complete run with nothing above Low still approves', async () => {
  const run = await runEngine('review', { script: script({ synthesis: '## Verdict\n\u2705 Approve \u2014 clean.\n' }, () => ({ lens: 'correctness', findings: [] })) })
  assert.match(verdictLine(run.report), /^\u2705 Approve \u2014 clean\.$/)
  assert.equal(filedRecord(run)?.verdict, 'Approve')
})

test('review: a usage limit stops the run, says so, dispatches no more review work and still attempts the record', async () => {
  const run = await runEngine('review', { script: script({}, () => { throw new Error(LIMIT) }) })
  const at = run.calls.findIndex(c => c.threw === LIMIT)
  assert.ok(at > 0, 'the limit must be hit by a lens dispatch')
  const after = run.calls.slice(at + 1).map(c => c.label)
  // The first round's lenses go out together, so its siblings were already in flight; nothing later is.
  const later = after.filter(l => !/^(retry:)?(checkpoint|log-run)/.test(l) && !/^lens:[^ ]+ r1$/.test(l))
  assert.deepEqual(later, [], `review work dispatched after the limit: ${after.join(', ')}`)
  assert.ok(after.some(l => /^log-run/.test(l)), 'the record write is still dispatched')
  assert.match(verdictLine(run.report), /INCOMPLETE/)
  assert.doesNotMatch(verdictLine(run.report), /Approve/)
  assert.match(run.report, /stopped: usage limit reached \(You've hit your weekly limit - resets Oct 24, 5pm/)
  const rec = filedRecord(run)
  assert.equal(rec?.verdict, 'INCOMPLETE')
  assert.match(String(rec?.notRun[0]), /^stopped: usage limit reached \(You've hit your weekly limit/)
  assert.ok(run.logs.some(l => /usage limit reached/.test(l)), 'and the log says it once it happens')
  assert.match(run.report, /## \S+ Usage limit reached\n[^\n]*once the limit resets[^\n]*`node "\$\{CLAUDE_PLUGIN_ROOT:-\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}\/plugins\/cache\/craft\/craft\/[^/]+\}"\/lib\/craft-log-run\.mjs recover`/,
    'and the report tells the human how to recover a record lost to the same limit')
})

test('review: a transient 429 is an ordinary death, not a stop', async () => {
  const run = await runEngine('review', { script: script({}, () => { throw new Error('API Error: 429 rate limit exceeded, try again later') }) })
  assert.ok(!/usage limit reached/.test(run.report), 'no stop for a transient rate limit')
  assert.ok(run.calls.some(c => / resurrect\d/.test(c.label)), 'the dead lens still gets its resurrection dispatch')
  assert.match(verdictLine(run.report), /INCOMPLETE/, 'and the lens that never returned still makes the verdict INCOMPLETE')
})

test('review: a usage limit answered as the synthesis text is a stop, not a report', async () => {
  const run = await runEngine('review', { script: script({ synthesis: LIMIT }) })
  assert.ok(!run.report.includes(`## Verdict\n${LIMIT}`), 'the limit message must not stand as the report')
  assert.match(verdictLine(run.report), /^\u26a0\ufe0f INCOMPLETE \u2014 stopped: usage limit reached/)
  assert.match(String(filedRecord(run)?.notRun[0]), /^stopped: usage limit reached/)
})

test('review: a dead logger agent is re-dispatched once, marked --retry, and that write lands', async () => {
  const run = await runEngine('review', {
    script: script({ 'log-run': (/** @type {{ callIndex: number }} */ { callIndex }) => { if (callIndex === 0) throw new Error('agent died'); return { ok: true } } }),
  })
  const writes = run.calls.filter(c => /^log-run/.test(c.label))
  assert.equal(writes.length, 2)
  assert.match(String(writes[1]?.prompt), /--retry /)
  assert.ok(!/Telemetry lost/.test(run.report), run.report)
})

const ADV = {
  scout: { baseRef: 'main', sizeBucket: 'small', lenses: ['correctness', 'security'], changedFiles: ['src/lib.rs'], notes: 'x' },
  'index-warmup': { indexed: false, notes: 'x' },
  'coverage-critic': { findings: [] },
  'log-run': { ok: true },
  '*': null,
}

test('adversarial-review: a usage limit stops the lens and verifier fan-out and the verdict is INCOMPLETE', async () => {
  const run = await runEngine('adversarial-review', { script: { ...ADV, review: () => { throw new Error(LIMIT) } } })
  const lensCalls = run.calls.filter(c => /^(retry\d+:)?review:/.test(c.label))
  assert.ok(lensCalls.length >= 1 && lensCalls.length <= 2, `only the dispatches already in flight: ${lensCalls.map(c => c.label).join(', ')}`)
  assert.ok(!run.calls.some(c => /^coverage-critic|^verify/.test(c.label)), 'no critic and no verifier after the stop')
  assert.equal(run.reportValue.verdict, 'INCOMPLETE')
  assert.ok(run.reportValue.notRun.some((/** @type {string} */ n) => /^stopped: usage limit reached/.test(n)), run.reportValue.notRun.join('\n'))
  assert.ok(filedRecord(run)?.notRun.includes('usage-limit'))
})

const GREEN_DIM = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }
/** @param {Record<string, unknown>} o */
const audit = o => runEngine('rust-audit', {
  script: {
    scout: { baseRef: 'main', hasUnsafe: false, crates: [{ name: 'a', path: 'crates/a' }], changedCrates: [], edges: [], repoRoot: '/r', notes: 'n' },
    workflow: '## Verdict\nApprove', '*': GREEN_DIM, ...o,
  },
})

test('rust-audit: a synthesized Approve over a dimension that did not run is INCOMPLETE', async () => {
  const run = await audit({ deps: null, synthesis: '**Overall verdict:** Approve\n\n| dim | verdict |' })
  assert.match(run.report, /\*\*Overall verdict:\*\* \S+ INCOMPLETE/, run.report)
  assert.equal(filedRecord(run)?.verdict, 'INCOMPLETE')
})

test('rust-audit: a usage limit skips the synthesis, says so, and still attempts the record', async () => {
  const run = await audit({ deps: () => { throw new Error(LIMIT) }, synthesis: '**Overall verdict:** Approve' })
  assert.ok(!run.calls.some(c => c.label === 'synthesis'), 'no synthesis after the stop')
  assert.match(run.report, /INCOMPLETE \S+ the synthesis did not run[^\n]*stopped: usage limit reached \(You've hit your weekly limit[^\n]*record could not be written \(rust-audit writes no checkpoints\): rerun the audit after the limit resets/)
  const rec = filedRecord(run)
  assert.equal(rec?.verdict, 'INCOMPLETE')
  assert.match(String(rec?.notRun[0]), /^stopped: usage limit reached/)
})

test('rust-audit: a usage limit answered as a dimension\'s text is the same stop', async () => {
  const run = await audit({ deps: LIMIT, synthesis: '**Overall verdict:** Approve' })
  assert.ok(!run.calls.some(c => c.label === 'synthesis'), 'no synthesis after the stop')
  assert.equal(filedRecord(run)?.verdict, 'INCOMPLETE')
})

test('adversarial-review: a transient 429 from a lens is not a stop', async () => {
  const run = await runEngine('adversarial-review', { script: { ...ADV, review: () => { throw new Error('429 Too Many Requests: rate limit exceeded, try again') } } })
  assert.ok(!run.reportValue.notRun.some((/** @type {string} */ n) => /usage limit reached/.test(n)), run.reportValue.notRun.join('\n'))
  assert.ok(run.calls.some(c => /^coverage-critic/.test(c.label)), 'the run goes on to its critic')
})

test('rust-audit: a usage limit thrown at the synthesis is a stop report, INCOMPLETE, and the record is attempted', async () => {
  const run = await audit({ synthesis: () => { throw new Error(LIMIT) } })
  assert.match(run.report, /INCOMPLETE \S+ the synthesis did not run[^\n]*stopped: usage limit reached/)
  assert.ok(run.calls.some(c => /^log-run/.test(c.label)), 'the record write is dispatched')
  const rec = filedRecord(run)
  assert.equal(rec?.verdict, 'INCOMPLETE')
  assert.match(String(rec?.notRun[0]), /^stopped: usage limit reached/)
})

test('adversarial-review: the stop says the record could not be written and to rerun, since it writes no checkpoints', async () => {
  const run = await runEngine('adversarial-review', { script: { ...ADV, review: () => { throw new Error(LIMIT) } } })
  const note = run.reportValue.notRun.find((/** @type {string} */ n) => /^stopped: usage limit reached/.test(n))
  assert.match(String(note), /record could not be written \(adversarial-review writes no checkpoints\): rerun the review after the limit resets$/)
  assert.doesNotMatch(String(note), / recover`/)
})

test('rust-audit: a nested review that reports its own usage-limit stop stops the audit', async () => {
  const nested = `## \u26d4 Usage limit reached\nstopped: usage limit reached (${LIMIT}). The run record was attempted\n\n## Verdict\n\u26a0\ufe0f INCOMPLETE \u2014 x`
  const run = await audit({ workflow: nested, synthesis: '**Overall verdict:** Approve' })
  assert.ok(!run.calls.some(c => c.label === 'synthesis'), 'no synthesis after the nested stop')
  const rec = filedRecord(run)
  assert.match(String(rec?.verdict), /INCOMPLETE/, 'never green: the stopped nested review rolls up non-green and the audit is marked')
  assert.equal(String(rec?.notRun[0]), `stopped: usage limit reached (${LIMIT})`)
})

test('rust-audit: no nested review launches once the stop is seen', async () => {
  const run = await audit({ scout: () => { throw new Error(LIMIT) } })
  assert.ok(!run.calls.some(c => c.label === 'workflow'), 'no nested review after a limit at the scout')
  assert.ok(run.calls.some(c => /^log-run/.test(c.label)), 'the record write is still dispatched')
})
