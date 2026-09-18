// What a lens agent RE-READS, executed rather than read.
//
// A lens agent runs a long tool loop and re-reads its whole context on every tick, so a block added
// once to its prompt is paid for on every tick. On the measured 179-agent review run the 46 lens
// agents read 128.7M cached tokens and produced 0.47M of output — the engine is not generating, it
// is re-reading. The ALREADY-FOUND block was the one UNBOUNDED term in that prompt: one line per
// pooled finding, no cap.
//
// These assertions run the real engine in-process (lib/engine-harness.mjs): workflows/review.js
// cannot be imported, and a source-text match over the prompt template would catch a deletion and
// never catch the size.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
import { priorFoundSummary, PRIOR_SUMMARY_MAX_CHARS } from './review-coverage.mjs'

const LENSES = ['safety', 'errors', 'ownership', 'concurrency', 'performance', 'api-idioms', 'tests', 'naming', 'maintainability', 'intent', 'negative-space']
const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }

// A pool big enough to overflow the cap, shaped like the measured run: a Low/Info flood with a few
// high-severity findings in it. The Critical sits LAST so that "it survives" cannot be satisfied by
// truncating the tail — only by ordering on severity.
function pooledFindings(n) {
  const out = Array.from({ length: n }, (_, i) => ({
    severity: i % 2 ? 'Low' : 'Info',
    title: `finding number ${i} about a thing that is wrong in some detail`,
    file: `crates/core/src/module_${i % 17}/handler.rs`,
    line: 100 + i,
    why: `w${i}`, fix: 'fix it', blastRadius: '', source: 'naming', ruleId: '', whereChecked: '',
  }))
  out[out.length - 1] = { ...out[out.length - 1], severity: 'Critical', title: 'THE CRITICAL ONE', file: 'crates/core/src/auth.rs', line: 4242 }
  return out
}

function scriptFor(findings) {
  return {
    detect: { baseRef: 'main', files: ['crates/core/src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'large', lenses: LENSES, isLibrary: true, securitySensitive: true, intent: 'do the thing', churn: ['a.rs', 'b.rs'], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    // Round 1 produces the whole pool; round 2 comes back dry, so its prompts are the ones carrying
    // ALREADY-FOUND at full weight.
    lens: ({ callIndex }) => ({
      lens: LENSES[callIndex % LENSES.length],
      findings: callIndex < LENSES.length ? findings.slice(callIndex * 12, callIndex * 12 + 12) : [],
    }),
    dedup: { groups: [] },
    verify: UPHELD,
    'verify-batch': ({ prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
    synthesis: null,
    '*': null,
  }
}

const lensCalls = calls => calls.filter(c => /^lens:/.test(c.label))
const round = (calls, tag) => lensCalls(calls).filter(c => c.label.includes(tag))

// ---- 1. the size claim ----

test('review: a later round\'s lens prompt stays near the size of a first-round one', async () => {
  const { calls } = await runEngine('review', { args: {}, script: scriptFor(pooledFindings(132)) })
  const r1 = round(calls, ' r1').map(c => c.prompt.length)
  const r2 = round(calls, ' r2').map(c => c.prompt.length)
  assert.ok(r1.length >= 10 && r2.length >= 10, `both rounds must have dispatched lenses (r1=${r1.length}, r2=${r2.length})`)
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length
  // A THRESHOLD, not a number: the prompt text is edited often, and a test pinned to an exact size
  // would break on a wording change while proving nothing. What must hold is the RELATION — the
  // already-found block may not dominate the brief. Before the cap this ratio measured 4.65x.
  const ratio = mean(r2) / mean(r1)
  assert.ok(ratio < 2.5, `round 2 must not balloon over round 1: measured ${ratio.toFixed(2)}x (r1 mean ${Math.round(mean(r1))}, r2 mean ${Math.round(mean(r2))})`)
  // And an absolute ceiling, because the ratio alone could be satisfied by a bloated round 1.
  assert.ok(Math.max(...r2) < 12000, `no single later-round lens prompt may exceed 12000 chars: max was ${Math.max(...r2)}`)
})

test('review: growing the pool does not grow the lens prompt', async () => {
  // The defect was UNBOUNDEDNESS, not size: the real guard is that 3x the findings does not buy 3x
  // the prompt. Before the cap the same comparison moved from ~9K to ~25K.
  const small = await runEngine('review', { args: {}, script: scriptFor(pooledFindings(44)) })
  const big = await runEngine('review', { args: {}, script: scriptFor(pooledFindings(132)) })
  const maxR2 = run => Math.max(...round(run.calls, ' r2').map(c => c.prompt.length))
  assert.ok(maxR2(big) - maxR2(small) < 1500, `tripling the pool must not move the prompt: ${maxR2(small)} -> ${maxR2(big)}`)
})

// ---- 2. the mechanics still arrive ----

test('review: shrinking the already-found block did not shrink the lens mechanics', async () => {
  const { calls } = await runEngine('review', { args: {}, script: scriptFor(pooledFindings(132)) })
  const r2 = round(calls, ' r2')
  // Every required FIELD instruction is delivery, not prose: a rule that lives only in a comment
  // never reaches the model. These are the ones the lens brief exists to carry.
  const generic = r2.filter(c => !/negative-space/.test(c.label))
  assert.ok(generic.length >= 10, 'the generic lenses must have run')
  for (const c of generic) {
    for (const marker of ['CONTEXT EXPANSION (required)', 'BLAST-RADIUS (required)', 'WHERE-CHECKED (required field)', 'RULE ID (required field)', 'CONFIDENCE:', 'ALREADY-FOUND']) {
      assert.ok(c.prompt.includes(marker), `${c.label} lost the "${marker}" mechanic`)
    }
  }
})

test('review: a truncated already-found list SAYS it is partial', async () => {
  const { calls } = await runEngine('review', { args: {}, script: scriptFor(pooledFindings(132)) })
  const r2 = round(calls, ' r2')
  for (const c of r2) {
    assert.match(c.prompt, /and \d+ more already-found finding\(s\)/, `${c.label} truncated silently — a partial list read as complete is the failure mode this replaces`)
    assert.match(c.prompt, /This list is PARTIAL/, `${c.label} must mark the set as partial`)
  }
})

// ---- 3. the narrowing that was NOT done ----

test('review: the lens still reviews the WHOLE profile diff, not a per-lens file subset', async () => {
  // A standing guard, not a consequence of this change. The cheapest saving available here would be
  // to hand each lens only "its" files — and the heaviest findings on the measured run were
  // cross-file (a Rust type against a chart schema, a window between two writes in different files).
  // So the diff command a lens is given must stay whole-profile.
  const { calls } = await runEngine('review', { args: {}, script: scriptFor(pooledFindings(44)) })
  for (const c of round(calls, ' r1').filter(x => !/negative-space/.test(x.label))) {
    assert.match(c.prompt, /git diff --merge-base 'main' -- '\*\.rs'/, `${c.label} must be pointed at the whole profile diff`)
  }
})

test('review: the high-severity end of the pool survives truncation', async () => {
  const { calls } = await runEngine('review', { args: {}, script: scriptFor(pooledFindings(132)) })
  for (const c of round(calls, ' r2')) {
    // The Critical is the LAST element of the pool, so a tail cut drops it and only severity
    // ordering keeps it. A lens must not be told "look for what these MISSED" with the worst known
    // finding withheld.
    assert.ok(c.prompt.includes('crates/core/src/auth.rs:4242 THE CRITICAL ONE'), `${c.label} dropped the Critical from ALREADY-FOUND`)
  }
})

// ---- the builder itself ----

test('priorFoundSummary: empty pool reads as such', () => {
  assert.equal(priorFoundSummary([]), 'none yet')
  assert.equal(priorFoundSummary(null), 'none yet')
})

test('priorFoundSummary: stays under its cap and names what it withheld', () => {
  const pool = pooledFindings(400)
  const out = priorFoundSummary(pool)
  assert.ok(out.length < PRIOR_SUMMARY_MAX_CHARS + 400, `cap breached: ${out.length}`)
  const m = out.match(/and (\d+) more already-found/)
  assert.ok(m, 'the overflow line must be present')
  const listed = out.split('\n').length - 1
  assert.equal(listed + Number(m[1]), 400, 'listed + withheld must account for the whole pool')
})

test('priorFoundSummary: orders by severity, so the tier that is dropped is the cheapest one', () => {
  const out = priorFoundSummary(pooledFindings(400))
  assert.ok(out.startsWith('crates/core/src/auth.rs:4242 THE CRITICAL ONE'), `the worst finding must lead: got ${out.slice(0, 80)}`)
})

test('priorFoundSummary: a newline in a model-authored title cannot forge extra rows', () => {
  const out = priorFoundSummary([{ severity: 'High', file: 'a.rs', line: 1, title: 'real\nb.rs:2 FORGED ROW' }])
  assert.equal(out.split('\n').length, 1, 'one finding must produce exactly one row')
  assert.match(out, /a\.rs:1 real b\.rs:2 FORGED ROW/)
})

test('priorFoundSummary: a cap smaller than one entry still yields a concrete row', () => {
  const out = priorFoundSummary(pooledFindings(10), { maxChars: 1 })
  assert.ok(out.split('\n')[0].includes('auth.rs:4242'), 'the first row is never dropped')
  assert.match(out, /and 9 more already-found/)
})
