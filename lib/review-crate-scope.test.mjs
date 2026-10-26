// The review engine's crateScope mode, executed (realm @nick/craft, #324): crate slices, the confined lens's
// crate rule in place of the context instructions, the coordinator in the lens window, its release, the seam
// pass and the contract lens — and, with the flag off, the dispatch exactly as it was.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { releaseCoordinator } from './review-crate-scope.mjs'

/** @param {string} dir @param {number} n */
const rs = (dir, n) => Array.from({ length: n }, (_v, i) => `${dir}/src/f${i}.rs`)
const FILES = [...rs('crates/a', 5), ...rs('crates/b', 5), ...rs('crates/c', 4), 'Cargo.lock']

/** @typedef {import('./engine-harness.mjs').Call} Call */
/** @param {string} label */
const lensOf = label => String(label).split(':')[2]?.split(' ')[0] || 'safety'

/** @param {Record<string, any>} [over] @returns {Record<string, any>} */
function script(over = {}) {
  return {
    detect: { baseRef: 'main', files: FILES, spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses: ['safety', 'errors', 'tests', 'intent'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    crates: { roots: ['crates/a', 'crates/b', 'crates/c'] },
    coord: { answered: 1, unanswered: 0, notes: '' },
    'coord-stop': { written: true },
    seam: { findings: [], dispositions: [], answered: 0 },
    lens: (/** @type {{ opts: any }} */ { opts }) => ({ lens: lensOf(opts.label), findings: [] }),
    dedup: { groups: [] },
    synthesis: null,
    '*': null,
    ...over,
  }
}

/** @param {Call[]} calls @param {RegExp} re */
const labelled = (calls, re) => calls.filter(c => re.test(String(c.label)))

test('crateScope off: no crate agent runs, every lens keeps its context instructions, the record carries nothing new', async () => {
  for (const args of [{}, { crateScope: false }]) {
    const run = await runEngine('review', { args, script: script() })
    assert.deepEqual(labelled(run.calls, /^(crates|coord|coord-stop|seam):|^lens:rust:contract/), [], 'no crate-mode agent off')
    const lenses = labelled(run.calls, /^lens:/)
    assert.ok(lenses.length > 1)
    for (const c of lenses) {
      assert.match(c.prompt, /CONTEXT EXPANSION \(required\)/)
      assert.doesNotMatch(c.prompt, /CRATE SCOPE/)
      assert.ok(!/crate:/.test(String(c.label)), 'directory slices, not crate slices')
    }
    const rec = filedRecord(run)
    assert.equal(rec.crateScope, undefined)
    assert.equal(rec.crateCoordinator, undefined)
    assert.ok(!rec.dimensions.some((/** @type {{ dimension: string }} */ d) => /contract|seam/.test(d.dimension)))
  }
  // The flag absent and the flag false dispatch the same agents with the same prompts.
  const a = await runEngine('review', { args: {}, script: script() })
  const b = await runEngine('review', { args: { crateScope: false }, script: script() })
  assert.deepEqual(a.calls.map(c => [c.label, c.prompt]), b.calls.map(c => [c.label, c.prompt]))
})

test('crateScope on: a confined lens gets the crate rule in place of the context instructions, overriding its agent', async () => {
  const run = await runEngine('review', { args: { crateScope: true }, script: script() })
  const confined = labelled(run.calls, /^lens:rust:(safety|errors|tests) r1 crate:/)
  assert.ok(confined.length >= 3, `one dispatch per crate per sliced lens, saw ${confined.length}`)
  for (const c of confined) {
    assert.match(c.prompt, /CRATE SCOPE — this OVERRIDES every other instruction about context in this prompt AND in your agent definition/)
    assert.match(c.prompt, /trace its callers, impls/, 'it names the agent instruction it overrides')
    for (const gone of [/CONTEXT EXPANSION/, /BLAST-RADIUS \(required\)/, /WHERE-CHECKED \(required field\)/, /never what you may READ/]) assert.doesNotMatch(c.prompt, gone)
    assert.match(c.prompt, /\/store\/\.partial\/run-A\/crate-rust/, 'the channel lives under the run directory')
    assert.match(c.prompt, /Bash timeout 120000/)
    assert.match(c.prompt, /seq 20\); do/, 'one wait call is 100 s, under the Bash default')
    assert.match(c.prompt, /id=[\w-]+-\$\(date \+%s%N\)/, 'every question gets a fresh id, so a retry never reads a stale answer')
    assert.equal(c.opts.schema.properties.questions.type, 'array')
  }
  const whole = labelled(run.calls, /^lens:rust:intent r1/)
  assert.equal(whole.length, 1)
  assert.match(whole[0]?.prompt ?? '', /CONTEXT EXPANSION \(required\)/, 'a whole-diff lens is not confined')
  const contracts = labelled(run.calls, /^lens:rust:contract r1 crate:/)
  assert.deepEqual(contracts.map(c => c.label).sort(), ['lens:rust:contract r1 crate:crates/a', 'lens:rust:contract r1 crate:crates/b', 'lens:rust:contract r1 crate:crates/c'])
  const coords = labelled(run.calls, /^coord:rust r\d/)
  assert.ok(coords.length >= 1)
  assert.match(coords[0]?.prompt ?? '', /timeout 100 sh -c/)
  assert.equal(labelled(run.calls, /^coord-stop:rust r1/).length, 1)
  assert.equal(labelled(run.calls, /^seam:rust/).length, 1)
})

test('crateScope on: the coordinator takes one slot of the 16-agent lens window', async () => {
  let live = 0
  let peak = 0
  /** @type {(v: unknown) => void} */
  let releaseCoord = () => {}
  const coordDone = new Promise(resolve => { releaseCoord = resolve })
  const many = [...rs('crates/a', 4), ...rs('crates/b', 4), ...rs('crates/c', 4), ...rs('crates/d', 4), ...rs('crates/e', 4), ...rs('crates/f', 4)]
  const run = await runEngine('review', { args: { crateScope: true }, script: script({
    detect: { baseRef: 'main', files: many, spec: '', branch: 'feat/x', head: 'abc1234' },
    crates: { roots: ['crates/a', 'crates/b', 'crates/c', 'crates/d', 'crates/e', 'crates/f'] },
    scout: { sizeBucket: 'small', lenses: ['safety', 'errors', 'tests', 'maintainability'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    coord: async () => { live++; peak = Math.max(peak, live); await coordDone; live--; return { answered: 0, unanswered: 0, notes: '' } },
    'coord-stop': () => { releaseCoord(undefined); return { written: true } },
    lens: async (/** @type {{ opts: any }} */ { opts }) => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 1)); live--; return { lens: lensOf(opts.label), findings: [] } },
  }) })
  assert.ok(labelled(run.calls, /^lens:rust:safety r1 crate:/).length === 6)
  assert.ok(peak <= 16, `lens window plus coordinator must stay within 16 agents, peaked at ${peak}`)
  assert.ok(peak >= 15, `the window is used, peaked at ${peak}`)
})

test('crateScope on: the record carries the mode, the coordinator telemetry and the contract and seam rows; a disposition drops its finding', async () => {
  const run = await runEngine('review', { args: { crateScope: true }, script: script({
    lens: (/** @type {{ opts: any }} */ { opts }) => {
      const lens = lensOf(opts.label)
      if (lens !== 'safety' || !/crate:crates\/a\b/.test(opts.label)) return { lens, findings: [] }
      return {
        lens, findings: [{ severity: 'High', title: 'Leaks the handle', file: 'crates/a/src/f0.rs', line: 3, why: 'w', whereChecked: '', fix: 'f', blastRadius: '', source: 'safety', ruleId: '' }],
        questions: [{ crate: 'crates/b', symbol: 'Pool::get', path: 'crates/b/src/f0.rs', ask: 'does it close?', findingTitle: 'Leaks the handle', findingFile: 'crates/a/src/f0.rs', blocking: false, answered: false, answer: '' }],
      }
    },
    seam: { findings: [{ severity: 'Medium', title: 'Caller ignores the new error variant', file: 'crates/b/src/f1.rs', line: 9, why: 'w', whereChecked: 'crates/a/src/f2.rs:4', fix: 'f', blastRadius: '', source: 'x', ruleId: '' }],
      dispositions: [{ lens: 'safety', findingFile: 'crates/a/src/f0.rs', findingTitle: 'Leaks the handle', action: 'drop', why: 'Pool::get closes it' }], answered: 1 },
    'coord-stop': null,
  }) })
  const seam = labelled(run.calls, /^seam:rust/)[0]
  assert.match(seam?.prompt ?? '', /"lens":"safety"/, 'the open question reaches the seam pass with the lens that asked')
  const verify = run.calls.filter(c => /^verify/.test(String(c.label)) || /^batch-verify/.test(String(c.label)))
  assert.ok(!verify.some(c => c.prompt.includes('Leaks the handle')), 'the dropped finding never reaches verification')
  const rec = filedRecord(run)
  assert.equal(rec.crateScope, true)
  const tel = rec.crateCoordinator?.[0]
  assert.equal(tel.language, 'rust')
  assert.equal(tel.crates, 3)
  assert.equal(tel.window, 15)
  assert.ok(tel.releaseFailed >= 1, 'a stop write that failed is counted')
  assert.deepEqual(tel.seam.dispositions, { confirm: 0, drop: 1, convert: 0 })
  assert.deepEqual(tel.questions, { blocking: 0, deferred: 1, answered: 0, timedOut: 0 })
  const dims = rec.dimensions.map((/** @type {{ dimension: string, ran: boolean }} */ d) => [d.dimension, d.ran])
  assert.ok(dims.some((/** @type {[string, boolean]} */ [d, ran]) => d === 'rust:contract' && ran))
  assert.ok(dims.some((/** @type {[string, boolean]} */ [d, ran]) => d === 'rust:seam' && ran))
})

test('crateScope on: a dead confined slice is resurrected on its own slice, still confined, and counted', async () => {
  const run = await runEngine('review', { args: { crateScope: true }, script: script({
    lens: (/** @type {{ opts: any }} */ { opts }) => (/^lens:rust:(errors r\d crate:crates\/b|intent r\d)$/.test(opts.label) ? null : { lens: lensOf(opts.label), findings: [] }),
  }) })
  assert.equal(labelled(run.calls, /^lens:rust:intent resurrect1$/).length, 1, 'a whole-diff lens is still resurrected, unsliced')
  const retries = labelled(run.calls, /^lens:rust:errors resurrect1/)
  assert.ok(retries.length >= 1)
  for (const c of retries) {
    assert.match(String(c.label), /crate:crates\/b$/, 'the retry keeps its crate slice')
    assert.match(c.prompt, /CRATE SCOPE/)
    assert.doesNotMatch(c.prompt, /BLOCKING QUESTION/, 'no coordinator listens during a resurrection')
  }
  const tel = filedRecord(run).crateCoordinator[0]
  assert.ok(tel.resurrectedConfined >= 1)
  assert.equal(tel.resurrectedUnconfined, 0, 'the whole-diff lens was never confined')
})

test('releaseCoordinator never waits past its grace, even when the stop write failed', async () => {
  // The grace fires at once for a coordinator that never answers; never, for one that already has.
  const fires = (/** @type {() => void} */ fn) => { fn(); return () => {} }
  const never = () => () => {}
  const stuck = new Promise(() => {})
  assert.deepEqual(await releaseCoordinator({ writeStop: async () => false, coord: stuck, graceMs: 1, arm: fires }), { stopped: false, answer: null, timedOut: true })
  const ok = await releaseCoordinator({ writeStop: async () => { throw new Error('dead') }, coord: Promise.resolve({ answered: 2 }), graceMs: 1000, arm: never })
  assert.deepEqual(ok, { stopped: false, answer: { answered: 2 }, timedOut: false })
})
