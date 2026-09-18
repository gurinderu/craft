// What a DEAD verification dispatch costs the window, executed rather than reasoned about.
//
// The measured cost (one large Rust review: 179 agents, 79905 agent-seconds, 6.4h wall clock): 46
// dispatched verifiers returned no verdict at all and held 37050 agent-seconds — 46.4% of the whole
// run. Half of those seconds are `ragent`'s one quiet re-dispatch: a second full harness retry
// ladder, paid inside the same verification window slot, after the first ladder already reported the
// API unreachable. The rationale, the window and why the deadline cannot reach this cost live in
// lib/agent-retry.mjs.
//
// These assertions are deliberately CLOCK-FREE. The harness's fake agent answers instantly, so no
// assertion here could measure a duration honestly. The observable is the one that actually converts
// to wall clock: HOW MANY harness dispatches a phase of dead verifiers spends. Every suppressed
// re-dispatch is one whole ladder the window does not hold.
//
// SCOPE IS THE OTHER THING UNDER TEST, and it is not readable from `opts.phase`. Three dispatches
// wear `phase: 'Verify'` (a deadline bucket) without running through the bounded verification
// window: the haiku dedup agent before the pool, the `<profile>-verify` checkpoint after it, and the
// pool of a *different* profile's pass. The tests below drive each of those dead and require the
// windowed pool to be unaffected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { DEATHS_IN_WINDOW_TO_OPEN } from './agent-retry.mjs'

// One file per batch group, because the batch verifier's LABEL is its file: a per-file script entry
// is then stable across a unit's re-dispatch (a retry carries the same label), which is what makes
// "every second group dies" expressible without counting calls.
const GROUPS = 8
const BATCH = 6
const rsFile = i => `src/f${i}.rs`
const nixFile = i => `m${i}.nix`

const finding = (file, line) => ({
  severity: 'Medium',
  title: `t${file}:${line}`,
  file,
  line,
  why: `w${line}`,
  fix: 'fix it',
  blastRadius: '',
  source: 'naming',
  ruleId: '',
  whereChecked: '',
})

const findingsOver = (files, source = 'naming') => files.flatMap(f => Array.from({ length: BATCH }, (_u, i) => ({ ...finding(f, 10 + i), source })))
const RS_FILES = Array.from({ length: GROUPS }, (_u, i) => rsFile(i))
const NIX_FILES = Array.from({ length: GROUPS }, (_u, i) => nixFile(i))
const MANY = findingsOver(RS_FILES)

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const liveBatch = ({ prompt }) => ({
  verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })),
})

function scriptFor({ findings, verifyBatch, extra = {}, files = RS_FILES }) {
  return {
    detect: { baseRef: 'main', files, spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses: ['naming'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: ({ callIndex }) => ({ lens: 'naming', findings: callIndex === 0 ? findings : [] }),
    dedup: { groups: [] },
    verify: () => UPHELD,
    'verify-batch': verifyBatch,
    // Synthesis dies on purpose: the mechanical fallback report is the engine's OWN rendering.
    synthesis: null,
    '*': null,
    ...extra,
  }
}

const batchLabels = calls => calls.filter(c => /verify-batch/.test(String(c.label))).map(c => String(c.label))
const split = calls => {
  const labels = batchLabels(calls)
  return { firsts: labels.filter(l => !/^retry:/.test(l)), retries: labels.filter(l => /^retry:/.test(l)) }
}
const suppressions = logs => logs.filter(l => /NOT re-dispatched/.test(l))

test('review: an outage of dead verifiers stops paying for a second ladder each', async () => {
  const { calls, logs } = await runEngine('review', {
    args: {},
    script: scriptFor({ findings: MANY, verifyBatch: () => null }),
  })
  const { firsts, retries } = split(calls)
  assert.equal(firsts.length, GROUPS, 'every group must still be dispatched once — the saving is never a check that is skipped')
  assert.equal(
    retries.length,
    DEATHS_IN_WINDOW_TO_OPEN - 1,
    'only the deaths that could still be one-off buy a re-dispatch; once the window fills the second ladder is not held',
  )
  assert.ok(
    retries.length < firsts.length,
    `an all-dead phase must cost fewer than 2×${GROUPS} dispatches — that ratio is what 46.4% of a measured run was spent on`,
  )
  assert.ok(
    suppressions(logs).some(l => /of the last \d+ windowed verification dispatches returned nothing/.test(l)),
    'and the engine must SAY it stopped re-dispatching, in the terms it actually counted — a saving made silently is indistinguishable from a bug',
  )
  assert.ok(
    !logs.some(l => /\d+th verification death in a row/.test(l)),
    'and it must not claim a consecutive run, nor a dispatch count, that nothing here tracks',
  )
})

test('review: a suppressed re-dispatch does not make death one decibel quieter', async () => {
  // The three consequences the engine already defends, asserted on findings whose verifier's
  // re-dispatch was suppressed: the unverified tier, the empty denominator, and the not-run list
  // that makes the verdict read INCOMPLETE.
  const run = await runEngine('review', {
    args: {},
    script: scriptFor({ findings: MANY, verifyBatch: () => null }),
  })
  const { report } = run
  assert.ok(suppressions(run.logs).length > 0, 'the run must actually have suppressed something, or this proves nothing')

  const section = s => {
    const i = report.indexOf(`## ${s}`)
    if (i < 0) return ''
    const rest = report.slice(i + 1)
    const j = rest.indexOf('\n## ')
    return j < 0 ? rest : rest.slice(0, j)
  }
  // (1) the tier
  assert.match(section('Unverified'), /src\/f0\.rs:10/, 'a finding nothing checked must still be reported')
  assert.ok(!/src\/f0\.rs:1[0-9]\b/.test(section('Confirmed')), 'and never as Confirmed')
  assert.ok(!/src\/f0\.rs:1[0-9]\b/.test(section('Suspected')), 'nor as Suspected — that tier claims a verifier looked')

  // (2) the denominator
  const record = filedRecord(run)
  assert.ok(record, 'the outgoing record must be recoverable')
  assert.equal(record.verification.candidates, 0, 'nothing was judged, so the refutation denominator is empty')
  assert.equal(record.verification.unverified, MANY.length, 'and every unchecked finding is counted beside it')

  // (3) the not-run list, and the verdict that reads off it
  assert.ok(record.notRun.some(n => /verification of src\/f0\.rs/.test(n)), 'the run must name the verification that never happened')
  assert.match(report, /INCOMPLETE/, 'a verdict standing on unrun verification must not read as a clean approval')
})

test('review: a half-dead phase is economised too — interleaving must not hide an outage', async () => {
  // Every second group dies. This is the shape of the MEASURED run (46 deaths among 179 agents,
  // mixed with live answers) and it is not a healthy phase: a dead dispatch resolves in 500-660s
  // while a live verifier answers in tens of seconds, so in a partial outage the live answers land
  // BETWEEN the deaths by construction. A consecutive-streak signal is reset by exactly that
  // interleaving and saves nothing here — which is why the signal is a fraction over a window.
  const { calls, logs } = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: MANY,
      verifyBatch: ctx => (/f[02468]\.rs/.test(String(ctx.opts.label)) ? null : liveBatch(ctx)),
    }),
  })
  const { firsts, retries } = split(calls)
  assert.equal(firsts.length, GROUPS, 'all eight groups are still dispatched')
  assert.equal(
    retries.length,
    DEATHS_IN_WINDOW_TO_OPEN - 1,
    'the first deaths still buy their re-dispatch, and then the window fills although every second answer is live',
  )
  assert.equal(
    suppressions(logs).length,
    GROUPS / 2 - (DEATHS_IN_WINDOW_TO_OPEN - 1),
    'every later death in the half-dead phase is spared its second ladder',
  )
})

test('review: a phase that keeps answering keeps its re-dispatch — the breaker reads deaths, not slowness', async () => {
  // One isolated death per six dispatches: the window never fills, so every death is treated as the
  // one-off it might be. This is the guard against the opposite failure — a cheaper run bought by
  // giving up on work that would have succeeded on the second try.
  const { calls, logs } = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: MANY,
      verifyBatch: ctx => (/f0\.rs/.test(String(ctx.opts.label)) ? null : liveBatch(ctx)),
    }),
  })
  const { firsts, retries } = split(calls)
  assert.equal(firsts.length, GROUPS, 'all eight groups dispatched')
  assert.equal(retries.length, 1, 'the isolated death still bought its one re-dispatch')
  assert.deepEqual(suppressions(logs), [], 'nothing may be suppressed while the phase is mostly answering')
})

test('review: a live verifier is never re-dispatched at all', async () => {
  const { calls } = await runEngine('review', {
    args: {},
    script: scriptFor({ findings: MANY, verifyBatch: liveBatch }),
  })
  assert.deepEqual(
    split(calls).retries,
    [],
    'the breaker must not become a reason to dispatch anything twice',
  )
})

test('review: a dead dedup agent may not eat a verification slot it never held', async () => {
  // The dedup pass is ONE haiku agent dispatched BEFORE the pool, and it carries `phase: 'Verify'`
  // only because that is its deadline bucket. Keying the breaker on that label made its death count
  // toward the window, so the pool entered an outage already one death down and the third real
  // verifier death was suppressed after only two.
  const { calls } = await runEngine('review', {
    args: {},
    script: scriptFor({ findings: MANY, verifyBatch: () => null, extra: { dedup: null } }),
  })
  assert.ok(calls.some(c => /^dedup:/.test(String(c.label))), 'the dedup agent must actually have been dispatched and died')
  const { firsts, retries } = split(calls)
  assert.equal(firsts.length, GROUPS, 'every group is still dispatched once')
  assert.equal(
    retries.length,
    DEATHS_IN_WINDOW_TO_OPEN - 1,
    'the pool owes its full allowance of one-off retries: a death outside the window it does not own is not evidence about that window',
  )
})

test('review: one profile\'s outage neither arms nor disarms the next profile\'s window', async () => {
  // Two profiles run one after the other, each with its own verification pass, and the
  // `<profile>-verify` CHECKPOINT between them also wears `phase: 'Verify'` while being a logger
  // write outside every window — here it is dead, which under a label-keyed module-global breaker
  // both counted as a death and carried the first pass's open breaker into the second, so the
  // second profile's verifiers were suppressed from their very first death.
  let rsLens = 0
  let nixLens = 0
  const { calls } = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: [],
      verifyBatch: () => null,
      files: RS_FILES.concat(NIX_FILES),
      extra: {
        // Each profile's own scout, lens and findings, keyed by the LABEL rather than by call order,
        // so neither pass depends on which one the engine happens to run first.
        scout: ctx => ({
          sizeBucket: 'small',
          lenses: [/^scout:nix$/.test(String(ctx.opts.label)) ? 'purity' : 'naming'],
          isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x',
        }),
        lens: ctx => {
          if (/^lens:nix:/.test(String(ctx.opts.label))) {
            nixLens += 1
            return { lens: 'purity', findings: nixLens === 1 ? findingsOver(NIX_FILES, 'purity') : [] }
          }
          rsLens += 1
          return { lens: 'naming', findings: rsLens === 1 ? findingsOver(RS_FILES) : [] }
        },
        // The checkpoint dies: it is the `<profile>-verify` write between the two passes, and a
        // label-keyed breaker both counted it and let the first pass's open state through it.
        checkpoint: null,
      },
    }),
  })
  const rustBatches = split(calls.filter(c => /\.rs\(/.test(String(c.label))))
  const nixBatches = split(calls.filter(c => /\.nix\(/.test(String(c.label))))
  assert.equal(rustBatches.firsts.length, GROUPS, 'the Rust pass dispatched its groups')
  assert.equal(nixBatches.firsts.length, GROUPS, 'and so did the Nix pass — both profiles really ran')
  assert.equal(
    rustBatches.retries.length,
    DEATHS_IN_WINDOW_TO_OPEN - 1,
    'the first pass spends its allowance of one-off retries',
  )
  assert.equal(
    nixBatches.retries.length,
    DEATHS_IN_WINDOW_TO_OPEN - 1,
    'and so does the second: a window filled by a pass that observed a different API window decides nothing here',
  )
})
