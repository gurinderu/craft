// The review engine's unitScope mode, executed (realm @nick/craft, #324): unit slices, the confined lens's
// unit rule in place of the context instructions, the coordinator in the lens window, its release, the seam
// pass and the contract lens — and, with the flag off, the dispatch exactly as it was.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import fs from 'node:fs'
import { releaseCoordinator } from './review-unit-scope.mjs'

/** @param {string} dir @param {number} n */
const rs = (dir, n) => Array.from({ length: n }, (_v, i) => `${dir}/src/f${i}.rs`)
const FILES = [...rs('crates/a', 5), ...rs('crates/b', 5), ...rs('crates/c', 4), 'Cargo.lock']

// One agent per unit and lens, as before batching (unitBatches=false): what these tests pin is the mode's
// machinery, which batching does not change; lib/review-unit-batches.test.mjs pins the batched plan.
const PER_UNIT = { unitScope: true, unitBatches: false }

/** @typedef {import('./engine-harness.mjs').Call} Call */
/** @param {string} label */
const lensOf = label => String(label).split(':')[2]?.split(' ')[0] || 'safety'

/** @param {Record<string, any>} [over] @returns {Record<string, any>} */
function script(over = {}) {
  return {
    detect: { baseRef: 'main', files: FILES, spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, output: ['wrote r.json'] },
    scout: { sizeBucket: 'small', lenses: ['safety', 'errors', 'tests', 'intent'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    units: { roots: ['crates/a', 'crates/b', 'crates/c'] },
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

test('unitScope off: no unit agent runs, every lens keeps its context instructions, the record carries nothing new', async () => {
  for (const args of [{}, { unitScope: false }]) {
    const run = await runEngine('review', { args, script: script() })
    assert.deepEqual(labelled(run.calls, /^(units|coord|coord-stop|seam):|^lens:rust:contract/), [], 'no unit-mode agent off')
    const lenses = labelled(run.calls, /^lens:/)
    assert.ok(lenses.length > 1)
    for (const c of lenses) {
      assert.match(c.prompt, /CONTEXT EXPANSION \(required\)/)
      assert.doesNotMatch(c.prompt, /CRATE SCOPE/)
      assert.ok(!/unit:/.test(String(c.label)), 'directory slices, not unit slices')
    }
    const rec = filedRecord(run)
    assert.equal(rec.unitScope, undefined)
    assert.equal(rec.unitCoordinator, undefined)
    assert.ok(!rec.dimensions.some((/** @type {{ dimension: string }} */ d) => /contract|seam/.test(d.dimension)))
  }
  // The flag absent and the flag false dispatch the same agents with the same prompts.
  const a = await runEngine('review', { args: {}, script: script() })
  const b = await runEngine('review', { args: { unitScope: false }, script: script() })
  assert.deepEqual(a.calls.map(c => [c.label, c.prompt]), b.calls.map(c => [c.label, c.prompt]))
})

test('unitScope on: a confined lens gets the unit rule in place of the context instructions, overriding its agent', async () => {
  const run = await runEngine('review', { args: PER_UNIT, script: script() })
  const confined = labelled(run.calls, /^lens:rust:(safety|errors|tests) r1 unit:/)
  assert.ok(confined.length >= 3, `one dispatch per unit per sliced lens, saw ${confined.length}`)
  for (const c of confined) {
    assert.match(c.prompt, /CRATE SCOPE — this OVERRIDES every other instruction about context in this prompt AND in your agent definition/)
    assert.match(c.prompt, /trace its callers, impls/, 'it names the agent instruction it overrides')
    for (const gone of [/CONTEXT EXPANSION/, /BLAST-RADIUS \(required\)/, /WHERE-CHECKED \(required field\)/, /never what you may READ/]) assert.doesNotMatch(c.prompt, gone)
    assert.match(c.prompt, /\/store\/\.partial\/run-A\/unit-rust/, 'the channel lives under the run directory')
    assert.match(c.prompt, /Bash timeout 120000/)
    assert.match(c.prompt, /seq 20\); do/, 'one wait call is 100 s, under the Bash default')
    assert.match(c.prompt, /id=[\w-]+-\$\(date \+%s%N\)/, 'every question gets a fresh id, so a retry never reads a stale answer')
    assert.equal(c.opts.schema.properties.questions.type, 'array')
  }
  const whole = labelled(run.calls, /^lens:rust:intent r1/)
  assert.equal(whole.length, 1)
  assert.match(whole[0]?.prompt ?? '', /CONTEXT EXPANSION \(required\)/, 'a whole-diff lens is not confined')
  const contracts = labelled(run.calls, /^lens:rust:contract r1 unit:/)
  assert.deepEqual(contracts.map(c => c.label).sort(), ['lens:rust:contract r1 unit:crates/a', 'lens:rust:contract r1 unit:crates/b', 'lens:rust:contract r1 unit:crates/c'])
  const coords = labelled(run.calls, /^coord:rust r\d/)
  assert.ok(coords.length >= 1)
  assert.match(coords[0]?.prompt ?? '', /timeout 100 sh -c/)
  assert.equal(labelled(run.calls, /^coord-stop:rust r1/).length, 1)
  assert.equal(labelled(run.calls, /^seam:rust/).length, 1)
})

test('unitScope on: the contract lens is under the unit rule, never a body', async () => {
  const run = await runEngine('review', { args: PER_UNIT, script: script() })
  const contracts = labelled(run.calls, /^lens:rust:contract r1 unit:/)
  assert.equal(contracts.length, 3)
  for (const c of contracts) {
    assert.match(c.prompt, /CRATE SCOPE — this OVERRIDES every other instruction about context in this prompt AND in your agent definition/, 'the contract lens is under the unit rule too')
    assert.match(c.prompt, /trace its callers, impls/, 'it names the agent instruction it overrides')
    assert.match(c.prompt, /never a function body/i)
    assert.match(c.prompt, /no -A\/-B\/-C/)
  }
})

test('unitScope on: the coordinator lives as long as its round, capped at the Lenses deadline, and says when it left', async () => {
  const run = await runEngine('review', { args: PER_UNIT, script: script() })
  const coord = labelled(run.calls, /^coord:rust r1/)[0]?.prompt ?? ''
  assert.doesNotMatch(coord, /60 minutes/)
  assert.match(coord, /Stop ONLY on ALLDONE or STOP/)
  assert.match(coord, /after 90 minutes in all/, 'the cap is the Lenses phase deadline')
  assert.match(coord, /touch \S*gone-r1/, 'a coordinator that leaves says so in the channel')
  for (const c of labelled(run.calls, /^lens:rust:(safety|errors|tests) r1 unit:/)) assert.match(c.prompt, /NO-COORDINATOR/, 'a lens tells a coordinator gone from a slow one')
  const capped = await runEngine('review', { args: { ...PER_UNIT, deadlineMs: 1800000 }, script: script() })
  assert.match(labelled(capped.calls, /^coord:rust r1/)[0]?.prompt ?? '', /after 30 minutes in all/, 'a deadline override moves the cap with it')
})

test('unitScope on: the coordinator takes one slot of the 16-agent lens window', async () => {
  let live = 0
  let peak = 0
  /** @type {(v: unknown) => void} */
  let releaseCoord = () => {}
  const coordDone = new Promise(resolve => { releaseCoord = resolve })
  const many = [...rs('crates/a', 4), ...rs('crates/b', 4), ...rs('crates/c', 4), ...rs('crates/d', 4), ...rs('crates/e', 4), ...rs('crates/f', 4)]
  const run = await runEngine('review', { args: PER_UNIT, script: script({
    detect: { baseRef: 'main', files: many, spec: '', branch: 'feat/x', head: 'abc1234' },
    units: { roots: ['crates/a', 'crates/b', 'crates/c', 'crates/d', 'crates/e', 'crates/f'] },
    scout: { sizeBucket: 'small', lenses: ['safety', 'errors', 'tests', 'maintainability'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    coord: async () => { live++; peak = Math.max(peak, live); await coordDone; live--; return { answered: 0, unanswered: 0, notes: '' } },
    'coord-stop': () => { releaseCoord(undefined); return { written: true } },
    lens: async (/** @type {{ opts: any }} */ { opts }) => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 1)); live--; return { lens: lensOf(opts.label), findings: [] } },
  }) })
  assert.ok(labelled(run.calls, /^lens:rust:safety r1 unit:/).length === 6)
  assert.ok(peak <= 16, `lens window plus coordinator must stay within 16 agents, peaked at ${peak}`)
  assert.ok(peak >= 15, `the window is used, peaked at ${peak}`)
})

test('unitScope on: the record carries the mode, the coordinator telemetry and the contract and seam rows; a disposition drops its finding', async () => {
  const run = await runEngine('review', { args: PER_UNIT, script: script({
    lens: (/** @type {{ opts: any }} */ { opts }) => {
      const lens = lensOf(opts.label)
      if (lens !== 'safety' || !/unit:crates\/a\b/.test(opts.label)) return { lens, findings: [] }
      return {
        lens, findings: [{ severity: 'High', title: 'Leaks the handle', file: 'crates/a/src/f0.rs', line: 3, why: 'w', whereChecked: '', fix: 'f', blastRadius: '', source: 'safety', ruleId: '' }],
        questions: [{ unit: 'crates/b', symbol: 'Pool::get', path: 'crates/b/src/f0.rs', ask: 'does it close?', findingTitle: 'Leaks the handle', findingFile: 'crates/a/src/f0.rs', blocking: false, answered: false, answer: '' }],
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
  assert.equal(rec.unitScope, true)
  const tel = rec.unitCoordinator?.[0]
  assert.equal(tel.language, 'rust')
  assert.equal(tel.units, 3)
  assert.equal(tel.window, 15)
  assert.ok(tel.releaseFailed >= 1, 'a stop write that failed is counted')
  assert.deepEqual(tel.seam.dispositions, { confirm: 0, drop: 1, convert: 0 })
  // Not removed silently: the record and the report name the finding the seam pass set aside, and why.
  assert.deepEqual(tel.seam.setAside, [{ action: 'drop', lens: 'safety', title: 'Leaks the handle', file: 'crates/a/src/f0.rs', line: 3, severity: 'High', why: 'Pool::get closes it' }])
  assert.match(run.report, /## Set aside by the seam pass \(unitScope\)/)
  assert.match(run.report, /- drop · High · `crates\/a\/src\/f0\.rs:3` · safety · Leaks the handle — Pool::get closes it/)
  assert.deepEqual(tel.questions, { blocking: 0, deferred: 1, answered: 0, timedOut: 0, noCoordinator: 0 })
  const dims = rec.dimensions.map((/** @type {{ dimension: string, ran: boolean }} */ d) => [d.dimension, d.ran])
  assert.ok(dims.some((/** @type {[string, boolean]} */ [d, ran]) => d === 'rust:contract' && ran))
  assert.ok(dims.some((/** @type {[string, boolean]} */ [d, ran]) => d === 'rust:seam' && ran))
})

test('unitScope on: a seam drop of the only finding still names it in the no-findings report', async () => {
  const run = await runEngine('review', { args: PER_UNIT, script: script({
    lens: (/** @type {{ opts: any }} */ { opts }) => {
      const lens = lensOf(opts.label)
      if (lens !== 'safety' || !/unit:crates\/a\b/.test(opts.label)) return { lens, findings: [] }
      return {
        lens, findings: [{ severity: 'High', title: 'Leaks the handle', file: 'crates/a/src/f0.rs', line: 3, why: 'w', whereChecked: '', fix: 'f', blastRadius: '', source: 'safety', ruleId: '' }],
        questions: [{ unit: 'crates/b', symbol: 'Pool::get', path: 'crates/b/src/f0.rs', ask: 'does it close?', findingTitle: 'Leaks the handle', findingFile: 'crates/a/src/f0.rs', blocking: false, answered: false, answer: '' }],
      }
    },
    seam: { findings: [], dispositions: [{ lens: 'safety', findingFile: 'crates/a/src/f0.rs', findingTitle: 'Leaks the handle', action: 'drop', why: 'Pool::get closes it' }], answered: 1 },
  }) })
  assert.match(run.report, /## Set aside by the seam pass \(unitScope\)[\s\S]*Leaks the handle — Pool::get closes it/)
  assert.equal(filedRecord(run).unitCoordinator[0].seam.setAside.length, 1)
})

test('unitScope on: a dead confined slice is resurrected on its own slice, still confined, and counted', async () => {
  const run = await runEngine('review', { args: PER_UNIT, script: script({
    lens: (/** @type {{ opts: any }} */ { opts }) => (/^lens:rust:(errors r\d unit:crates\/b|intent r\d)$/.test(opts.label) ? null : { lens: lensOf(opts.label), findings: [] }),
  }) })
  assert.equal(labelled(run.calls, /^lens:rust:intent resurrect1$/).length, 1, 'a whole-diff lens is still resurrected, unsliced')
  const retries = labelled(run.calls, /^lens:rust:errors resurrect1/)
  assert.ok(retries.length >= 1)
  for (const c of retries) {
    assert.match(String(c.label), /unit:crates\/b$/, 'the retry keeps its unit slice')
    assert.match(c.prompt, /CRATE SCOPE/)
    assert.doesNotMatch(c.prompt, /BLOCKING QUESTION/, 'no coordinator listens during a resurrection')
  }
  const tel = filedRecord(run).unitCoordinator[0]
  assert.ok(tel.resurrectedConfined >= 1)
  assert.equal(tel.resurrectedUnconfined, 0, 'the whole-diff lens was never confined')
})

test('unitScope on: a dead contract dispatch is resurrected on its unit, still a contract lens, and counted', async () => {
  const run = await runEngine('review', { args: PER_UNIT, script: script({
    lens: (/** @type {{ opts: any }} */ { opts }) => (/^lens:rust:contract r1 unit:crates\/b$/.test(opts.label) ? null : { lens: lensOf(opts.label), findings: [] }),
  }) })
  const retries = labelled(run.calls, /^lens:rust:contract resurrect/)
  assert.deepEqual(retries.map(c => c.label), ['lens:rust:contract resurrect1 unit:crates/b'])
  assert.match(retries[0]?.prompt ?? '', /\*\*contract\*\* lens/, 'the retry is the contract prompt, not a generic lens brief')
  const rec = filedRecord(run)
  assert.notEqual(rec.verdict, 'INCOMPLETE')
  assert.ok(!(rec.notRun ?? []).some((/** @type {string} */ n) => /contract/.test(n)))
  const tel = rec.unitCoordinator[0]
  assert.equal(tel.resurrectedContract, 1)
  assert.equal(tel.resurrectedConfined, 0, 'a contract retry is counted as such, not as a confined lens')
})

test('unitScope on: a seam pass that died is retried once, and the retry counted', async () => {
  let seams = 0
  const run = await runEngine('review', { args: PER_UNIT, script: script({ seam: () => (++seams === 1 ? null : { findings: [], dispositions: [], answered: 0 }) }) })
  assert.deepEqual(labelled(run.calls, /^seam:rust/).map(c => c.label), ['seam:rust', 'seam:rust retry'])
  const rec = filedRecord(run)
  assert.equal(rec.unitCoordinator[0].seam.ran, true)
  assert.equal(rec.unitCoordinator[0].seam.retried, true)
  assert.ok(!(rec.notRun ?? []).some((/** @type {string} */ n) => /seam/.test(n)))
  // Dead twice: one retry only, and the hole is named.
  const dead = await runEngine('review', { args: PER_UNIT, script: script({ seam: null }) })
  assert.equal(labelled(dead.calls, /^seam:rust/).length, 2)
  assert.ok((filedRecord(dead).notRun ?? []).some((/** @type {string} */ n) => /seam pass/.test(n)))
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

test('whenToUse names the boundary reader from the plugin root and where the run transcripts are', () => {
  const src = fs.readFileSync(new URL('../workflows/review.js', import.meta.url), 'utf8')
  const whenToUse = String(src.match(/whenToUse: '((?:[^'\\]|\\.)*)'/)?.[1])
  assert.doesNotMatch(whenToUse, /`node lib\/unit-boundary\.mjs/, 'a path relative to a craft checkout is wrong for a consumer')
  assert.match(whenToUse, /node "<craft plugin root>\/lib\/unit-boundary\.mjs"/)
  assert.match(whenToUse, /~\/\.claude\/projects\/<project slug>\/<session id>\/subagents\/workflows\/wf_<run id>/)
})

test('unitScope on: a resurrected confined slice\'s questions reach the seam pass', async () => {
  const run = await runEngine('review', { args: PER_UNIT, script: script({
    lens: (/** @type {{ opts: any }} */ { opts }) => {
      if (/^lens:rust:errors r\d unit:crates\/b$/.test(opts.label)) return null
      if (/^lens:rust:errors resurrect1 unit:crates\/b$/.test(opts.label)) {
        return { lens: 'errors', findings: [], questions: [{ unit: 'crates/c', symbol: 'Codec::decode', path: 'crates/c/src/f0.rs', ask: 'can it fail on empty input?', findingTitle: '', findingFile: '', blocking: false, answered: false, answer: '' }] }
      }
      return { lens: lensOf(opts.label), findings: [] }
    },
  }) })
  assert.equal(labelled(run.calls, /^lens:rust:errors resurrect1 unit:crates\/b$/).length, 1)
  assert.match(labelled(run.calls, /^seam:rust/)[0]?.prompt ?? '', /"ask":"can it fail on empty input\?"[^}]*"lens":"errors"/, 'the retry\'s question is open for the seam pass, with its lens')
  assert.equal(filedRecord(run).unitCoordinator[0].questions.deferred, 1)
})
