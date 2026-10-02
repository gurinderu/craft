// adversarial-review's own control flow, path by path, through the harness: the early exits (empty
// diff, the inert-only green and each way its cross-check can refuse it), a dead or list-less scout,
// the coverage critic's retry and double death, the mechanical dedup, the escalated-undecided marker
// and the verdict ladder. Pinned before the engine's top-level body was split into named functions,
// so the split is held to what the engine did, not to what it was meant to do.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

/** @param {string} title @param {string} file @param {number} line @param {string} severity */
const F = (title, file, line, severity) => ({ title, file, line, severity, description: `d:${title}`, fix: `f:${title}`, whereChecked: '' })
/** @param {Record<string, unknown>} [o] */
const scout = o => ({ baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: ['src/a.rs'], notes: 'n', ...o })
const AGREE = { refuted: false, premiseSupported: true, reasoning: 'ok' }

/**
 * A verifier agrees at the finding's own severity, unless the prompt says `refute-me` — or `split-vote`: code
 * agrees, severity refutes, and the exploit vote that would decide it never comes.
 * @param {string} label @param {string} prompt
 */
function verdict(label, prompt) {
  const refute = { ...AGREE, refuted: true, severity: 'not-an-issue' }
  if (/refute-me/.test(prompt)) return refute
  if (/split-vote/.test(prompt) && label.startsWith('verify[exploit]')) return null
  if (/split-vote/.test(prompt) && label.startsWith('verify[severity]')) return refute
  return { ...AGREE, severity: /FINDING \[(\w+)\]/.exec(prompt)?.[1] ?? 'low' }
}

/**
 * Lenses answer from `byLens`, verifiers by `verdict`, everything else unscripted is dead.
 * @param {Record<string, unknown>} byLens @param {Record<string, unknown>} [o]
 */
const script = (byLens, o = {}) => ({
  scout: scout(), 'index-warmup': { indexed: false, notes: 'x' }, 'coverage-critic': { findings: [] }, 'log-run': { ok: true },
  '*': (/** @type {{ prompt: string, opts: { label?: string } }} */ { prompt, opts }) => {
    const label = String(opts.label ?? '')
    if (label.startsWith('review:')) return byLens[label.slice(7)] ?? null
    return label.startsWith('verify') ? verdict(label, prompt) : null
  },
  ...o,
})
/** @param {Awaited<ReturnType<typeof runEngine>>} run */
const notes = run => /** @type {string[]} */ (run.reportValue.notRun).join('\n')

test('adversarial-review: an empty diff exits INCOMPLETE before any lens, and files that verdict', async () => {
  const run = await runEngine('adversarial-review', { script: script({}, { scout: scout({ changedFiles: [] }) }) })
  assert.equal(run.reportValue.verdict, 'INCOMPLETE (empty diff)')
  assert.ok(!run.calls.some(c => c.label.startsWith('review:')), 'no lens ran')
  const rec = filedRecord(run)
  assert.equal(rec?.verdict, 'INCOMPLETE (empty diff)')
  assert.deepEqual(rec?.notRun, ['empty-diff'])
})

test('adversarial-review: a dead scout and a scout without a file list both open notRun and review every lens', async () => {
  const dead = await runEngine('adversarial-review', { script: script({}, { scout: null }) })
  assert.match(notes(dead), /^scout died — the diff was never enumerated/m)
  assert.equal(dead.calls.filter(c => c.label.startsWith('review:')).length, 6, 'every lens but complexity (no index)')
  const listless = await runEngine('adversarial-review', { script: script({ correctness: { findings: [] } }, { scout: scout({ changedFiles: 'src/a.rs' }) }) })
  assert.match(notes(listless), /^the scout returned no file list/m)
  assert.equal(listless.reportValue.verdict, 'Approve (INCOMPLETE)')
})

test('adversarial-review: an inert-only diff is approved only on an agreeing cross-check', async () => {
  const inert = scout({ changedFiles: ['README.md', 'Cargo.lock'] })
  const ok = await runEngine('adversarial-review', { script: script({}, { scout: inert, 'inert-crosscheck': { ok: true, fileCount: 2, files: ['README.md', 'Cargo.lock'] } }) })
  assert.equal(ok.reportValue.verdict, 'Approve')
  assert.equal(typeof ok.reportValue.summary, 'string')
  assert.equal(filedRecord(ok)?.verdict, 'Approve')
  /** @type {[unknown, RegExp][]} */
  const refusals = [
    [null, /the cross-check never returned a usable list/],
    [{ ok: false, fileCount: 2, files: ['README.md', 'Cargo.lock'] }, /the cross-check never returned a usable list/],
    [{ ok: true, fileCount: 3, files: ['README.md', 'Cargo.lock'] }, /the cross-check list is incomplete \(2 paths vs 3 reported by git\)/],
    [{ ok: true, fileCount: 1, files: ['README.md'] }, /git reports 1 changed file\(s\), the scout reported 2/],
    [{ ok: true, fileCount: 2, files: ['README.md', 'src/x.rs'] }, /reviewable code the scout did not report: src\/x\.rs/],
  ]
  for (const [cross, why] of refusals) {
    const run = await runEngine('adversarial-review', { script: script({}, { scout: inert, 'inert-crosscheck': cross }) })
    assert.equal(run.reportValue.verdict, 'INCOMPLETE (unconfirmed inert diff)')
    assert.match(notes(run), why)
    assert.deepEqual(filedRecord(run)?.notRun, ['inert-diff-unconfirmed'])
  }
})

test('adversarial-review: a dead coverage critic is retried once, and dying twice is not-run', async () => {
  const lens = { correctness: { findings: [] } }
  const retried = await runEngine('adversarial-review', { script: script(lens, { 'coverage-critic': null, 'coverage-critic-retry': { findings: [F('gap', 'src/g.rs', 3, 'medium')] } }) })
  assert.ok(retried.calls.some(c => c.label === 'coverage-critic-retry'))
  assert.equal(retried.reportValue.verdict, 'Warning', 'the retried critic\'s gap is verified and counts')
  const dead = await runEngine('adversarial-review', { script: script(lens, { 'coverage-critic': null }) })
  assert.equal(dead.reportValue.verdict, 'Approve (INCOMPLETE)')
  assert.match(notes(dead), /the coverage critic died twice/)
})

test('adversarial-review: nearby same-titled findings merge into the more severe one, carrying both lenses', async () => {
  const run = await runEngine('adversarial-review', {
    script: script({ correctness: { findings: [F('off by one in loop bound', 'src/a.rs', 10, 'medium')] }, security: { findings: [F('off by one loop bound check', 'src/a.rs', 14, 'high')] } },
      { scout: scout({ lenses: ['correctness', 'security'] }) }),
  })
  assert.ok(run.logs.includes('Review: 2 raw findings -> 1 after mechanical dedup'), run.logs.join('\n'))
  const [f] = run.reportValue.confirmed
  assert.equal(f.title, 'off by one loop bound check')
  assert.equal(f.severity, 'high')
  assert.deepEqual(f.sources, ['correctness', 'security'])
  assert.equal(run.reportValue.verdict, 'Block')
})

test('adversarial-review: the verdict ladder, and an escalated finding that lost its deciding vote', async () => {
  /** @param {Record<string, unknown>} lenses */
  const verdictOf = async lenses => (await runEngine('adversarial-review', { script: script(lenses) })).reportValue.verdict
  assert.equal(await verdictOf({ correctness: { findings: [F('a crit', 'src/a.rs', 1, 'critical')] } }), 'Block')
  assert.equal(await verdictOf({ correctness: { findings: [F('a medium', 'src/a.rs', 1, 'medium')] } }), 'Warning')
  assert.equal(await verdictOf({ correctness: { findings: [F('a low', 'src/a.rs', 1, 'low')] } }), 'Approve')
  assert.equal(await verdictOf({ correctness: { findings: [F('refute-me crit', 'src/a.rs', 1, 'critical')] } }), 'Approve')
  const undecided = await runEngine('adversarial-review', { script: script({ correctness: { findings: [F('split-vote high', 'src/a.rs', 1, 'high')] } }) })
  assert.match(notes(undecided), /lost the panel vote that would have decided them/)
  assert.match(undecided.reportValue.verdict, /\(INCOMPLETE\)$/)
})
