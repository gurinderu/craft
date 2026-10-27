// The review engine's unitScope mode over unit batches, executed (realm @nick/craft, #355, #354, #353): the
// batches the probe's packages and numstat give, one agent per strong lens per batch, one sectioned agent for
// the weak lenses whose findings count per lens, the unit rule at the batch boundary, and the record's
// batches and cost estimate.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

/** @param {string} dir @param {number} n */
const rs = (dir, n) => Array.from({ length: n }, (_v, i) => `${dir}/f${i}.rs`)
const BIG = [...rs('crates/big/src/net', 3), ...rs('crates/big/src/db', 3)]
const FILES = [...rs('crates/a/src', 4), ...rs('crates/b/src', 4), ...rs('crates/x/src', 2), ...rs('crates/y/src', 2), ...BIG, 'Cargo.lock']
const PACKAGES = ['@@ crates/a 900 12 a', '@@ crates/b 700 9 b a serde', '@@ crates/big 50000 300 big', '@@ crates/x 80 2 x', '@@ crates/y 60 1 y-core']
const NUMSTAT = FILES.map(f => `${BIG.includes(f) ? 300 : 5}\t${BIG.includes(f) ? 100 : 5}\t${f}`)
const SECTIONED = 'safety+errors+concurrency'
// The batch shape these tests read, pinned to one volume budget so a refit of the cost model cannot move it.
const PINNED = { unitScope: true, unitBatchBudget: 1500 }

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
    scout: { sizeBucket: 'small', lenses: ['safety', 'errors', 'concurrency', 'tests', 'intent'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    units: { roots: [], packages: PACKAGES, numstat: NUMSTAT },
    coord: { answered: 0, unanswered: 0, notes: '' },
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
/** @param {Call[]} calls @param {string} lens */
const unitsOf = (calls, lens) => calls.map(c => String(c.label)).filter(l => l.startsWith(`lens:rust:${lens} r1 `)).map(l => l.slice(`lens:rust:${lens} r1 `.length))
const BATCHES = ['unit:crates/a unit:crates/b', 'unit:crates/big//src/db', 'unit:crates/big//src/net', 'unit:crates/x unit:crates/y']

test('unit batches: a connected pair together, small unconnected units packed, a big unit split by module', async () => {
  const run = await runEngine('review', { args: PINNED, script: script() })
  assert.deepEqual(unitsOf(run.calls, 'tests').sort(), BATCHES, 'a strong lens: one agent per batch')
  assert.deepEqual(unitsOf(run.calls, SECTIONED).sort(), BATCHES, 'the weak lenses: one sectioned agent per batch')
  for (const l of ['safety', 'errors', 'concurrency']) assert.deepEqual(unitsOf(run.calls, l), [], `no ${l} agent of its own`)
  assert.equal(labelled(run.calls, /^lens:rust:intent r1/).length, 1, 'a whole-diff lens is not batched')
  assert.equal(labelled(run.calls, /^lens:rust:contract /).length, 5, 'the contract lens stays per unit')
  const pair = labelled(run.calls, /^lens:rust:tests r1 unit:crates\/a unit:crates\/b$/)[0]
  assert.match(pair?.prompt ?? '', /you judge and READ the 2 crates rooted at `crates\/a\/`, `crates\/b\/` \(one batch\)/, 'the unit rule holds at the batch boundary')
  assert.match(pair?.prompt ?? '', /ONLY under `crates\/a\/`, `crates\/b\/`/)
})

test('unit batches: the sectioned agent carries each lens brief, its schema names the lenses, its findings count per lens', async () => {
  const finding = (/** @type {string} */ source, /** @type {string} */ title) => ({ severity: 'Medium', title, file: 'crates/a/src/f0.rs', line: 2, why: 'w', whereChecked: '', fix: 'f', blastRadius: '', source, ruleId: '' })
  const run = await runEngine('review', { args: PINNED, script: script({
    lens: (/** @type {{ opts: any }} */ { opts }) => (lensOf(opts.label) === SECTIONED && /unit:crates\/a unit:crates\/b$/.test(opts.label)
      ? { lens: SECTIONED, findings: [finding('safety', 'Panics on empty input'), finding('errors', 'Drops the io error'), finding('errors', 'Swallows the parse error'), finding('bogus', 'Untagged')] }
      : { lens: lensOf(opts.label), findings: [] }),
  }) })
  const agent = labelled(run.calls, /^lens:rust:safety\+errors\+concurrency r1 unit:crates\/a unit:crates\/b$/)[0]
  const prompt = agent?.prompt ?? ''
  assert.match(prompt, /SECTION 1 — the \*\*safety\*\* lens: safety \/ injection \/ secrets/)
  assert.match(prompt, /SECTION 2 — the \*\*errors\*\* lens: error handling:/)
  assert.match(prompt, /SECTION 3 — the \*\*concurrency\*\* lens: concurrency \/ async:/)
  assert.match(prompt, /Set every finding's `source` to its lens's name exactly — one of "safety", "errors", "concurrency"/)
  assert.match(prompt, /CRATE SCOPE — this OVERRIDES/)
  assert.deepEqual(agent?.opts.schema.properties.findings.items.properties.source.enum, ['safety', 'errors', 'concurrency'])
  const rec = filedRecord(run)
  /** @param {string} l */
  const total = l => {
    const d = rec.dimensions.find((/** @type {{ dimension: string }} */ x) => x.dimension === `rust:${l}`)
    return d ? d.confirmedCount + d.suspectedCount + d.unverifiedCount + d.refutedCount : -1
  }
  assert.deepEqual([total('safety'), total('errors'), total('concurrency')], [1, 2, 0])
  for (const l of ['safety', 'errors', 'concurrency', 'tests']) assert.ok(rec.dimensions.find((/** @type {{ dimension: string }} */ d) => d.dimension === `rust:${l}`)?.ran, `${l} ran on every batch`)
  assert.equal(rec.unitCoordinator?.[0]?.untaggedFindings, 1, 'a finding naming no section is counted, not credited to one')
})

// No lens has a fixed part of its own: an agent costs 1000 plus its lenses' rates times its batch's changed
// lines — tests, intent and the contract lens at rate 1, each weak lens at 0.25.
const FLAT = { agentFixed: 1000, unit: { perChangedLine: 1, perFile: 0, perCodeLine: 0, perSigLine: 0 }, pooled: { fixed: 0, rate: 1 },
  lenses: { tests: { fixed: 0, rate: 1 }, intent: { fixed: 0, rate: 1 }, ...Object.fromEntries(['safety', 'errors', 'concurrency'].map(l => [l, { fixed: 0, rate: 0.25 }])) } }
const CANDIDATES = ['per-unit', 'budget:500', 'budget:1500', 'budget:4500']

test('unit batches: the record carries every candidate with its estimate, the ceiling, and the reason for the choice', async () => {
  const run = await runEngine('review', { args: { unitScope: true, costModel: FLAT }, script: script() })
  const tel = filedRecord(run).unitCoordinator?.[0]
  const e = tel.costEstimate
  assert.deepEqual(e.candidates.map((/** @type {{ name: string }} */ c) => c.name), CANDIDATES)
  // The whole diff: 2520 changed lines; the heaviest single-lens agent over it: 1000 + 2520.
  assert.deepEqual(e.ceiling, { tokens: 3520, source: 'one whole-diff lens agent' })
  for (const c of e.candidates) assert.equal(c.fits, c.heaviest <= e.ceiling.tokens, c.name)
  const fits = e.candidates.filter((/** @type {{ fits: boolean }} */ c) => c.fits)
  const best = fits.reduce((/** @type {any} */ m, /** @type {any} */ c) => (c.total < m.total ? c : m))
  assert.equal(e.chosen, best.name)
  assert.match(e.reason, /^lowest estimated total/)
  const chosen = e.candidates.find((/** @type {{ name: string }} */ c) => c.name === e.chosen)
  assert.deepEqual(tel.unitBatches.map((/** @type {{ key: string }} */ b) => b.key), chosen.batches, 'the batches dispatched are the chosen candidate\'s')
  assert.deepEqual(unitsOf(run.calls, 'tests').sort(), [...chosen.batches].sort())
  assert.equal(e.batched.total, chosen.total)
  assert.deepEqual(e.model.lenses.tests, { fixed: 0, rate: 1 })
  // The fewest agents cost least, and the widest budget gives the fewest: a with b (one component), big packed
  // by volume with x and y; tests over the second (1000 + 2400 + 40) is the heaviest. No candidate is one batch
  // of every unit, which the linear model would always prefer (#355).
  assert.equal(e.chosen, 'budget:4500')
  assert.deepEqual(chosen.batches, ['unit:crates/a unit:crates/b', 'unit:crates/big unit:crates/x unit:crates/y'])
  assert.equal(chosen.heaviest, 3440)
  assert.ok(e.candidates.every((/** @type {{ batches: string[] }} */ c) => c.batches.length > 1), 'no candidate puts every unit in one batch')
  // A batch is a part of the whole diff and the sectioned rates sum to 0.75: under FLAT every candidate fits.
  assert.ok(e.candidates.every((/** @type {{ fits: boolean }} */ c) => c.fits))
})

test('unit batches: no candidate under unitAgentCeiling takes the lightest heaviest agent; a high one the lowest total', async () => {
  const low = (await runEngine('review', { args: { unitScope: true, costModel: FLAT, unitAgentCeiling: 1 }, script: script() }))
  const e = filedRecord(low).unitCoordinator?.[0]?.costEstimate
  assert.deepEqual(e.ceiling, { tokens: 1, source: 'unitAgentCeiling' })
  assert.ok(e.candidates.every((/** @type {{ fits: boolean }} */ c) => !c.fits))
  assert.equal(e.chosen, e.candidates.reduce((/** @type {any} */ m, /** @type {any} */ c) => (c.heaviest < m.heaviest ? c : m)).name)
  assert.match(e.reason, /^no candidate's heaviest agent is at or under the ceiling \(1\)/)
  const high = await runEngine('review', { args: { unitScope: true, costModel: FLAT, unitAgentCeiling: 1e12 }, script: script() })
  assert.equal(filedRecord(high).unitCoordinator?.[0]?.costEstimate.chosen, 'budget:4500', 'agentFixed counted once per agent: the fewest agents cost least')
  assert.deepEqual(unitsOf(high.calls, 'tests').sort(), ['unit:crates/a unit:crates/b', 'unit:crates/big unit:crates/x unit:crates/y'])
})

test('unit batches: unitBatchBudget pins the partition to its one budget, the other candidates still estimated', async () => {
  const run = await runEngine('review', { args: PINNED, script: script() })
  const e = filedRecord(run).unitCoordinator?.[0]?.costEstimate
  assert.deepEqual(e.candidates.map((/** @type {{ name: string }} */ c) => c.name), ['per-unit', 'budget:1500'])
  assert.equal(e.chosen, 'budget:1500')
  assert.equal(e.batchBudget, 1500)
  assert.equal(e.reason, 'unitBatchBudget=1500 pins the partition')
  // 4 batches × (tests + one sectioned agent) + 5 contracts; per unit: 6 unit slices (big split by file count) × 4 lenses + 5.
  assert.equal(e.batched.agents, 13)
  assert.equal(e.perUnit.agents, 29)
})

test('unit batches: unitBatches=false keeps one agent per unit and lens; unitScope off runs no batch at all', async () => {
  const per = await runEngine('review', { args: { unitScope: true, unitBatches: false }, script: script() })
  assert.ok(unitsOf(per.calls, 'safety').length >= 5, 'per unit')
  assert.deepEqual(unitsOf(per.calls, SECTIONED), [])
  assert.equal(filedRecord(per).unitCoordinator?.[0]?.unitBatches, null)
  const off = await runEngine('review', { args: {}, script: script() })
  assert.deepEqual(labelled(off.calls, /^(units|coord|seam):|\+/), [])
  assert.equal(filedRecord(off).unitCoordinator, undefined)
})

test('unit batches: a dead sectioned agent is retried as one sectioned agent on its batch, and closes every section', async () => {
  const run = await runEngine('review', { args: PINNED, script: script({
    lens: (/** @type {{ opts: any }} */ { opts }) => {
      if (/ r1 unit:crates\/x unit:crates\/y$/.test(opts.label) && lensOf(opts.label) === SECTIONED) return null
      // One finding, so the record has dimension rows to read.
      const findings = lensOf(opts.label) === 'intent' ? [{ severity: 'Low', title: 'Intent unclear', file: 'crates/a/src/f0.rs', line: 1, why: 'w', whereChecked: '', fix: 'f', blastRadius: '', source: 'intent', ruleId: '' }] : []
      return { lens: lensOf(opts.label), findings }
    },
  }) })
  const retries = labelled(run.calls, /^lens:rust:\S+ resurrect1 /).map(c => c.label)
  assert.deepEqual(retries, [`lens:rust:${SECTIONED} resurrect1 unit:crates/x unit:crates/y`])
  const rec = filedRecord(run)
  for (const l of ['safety', 'errors', 'concurrency']) assert.ok(rec.dimensions.find((/** @type {{ dimension: string }} */ d) => d.dimension === `rust:${l}`)?.ran, `${l} closed by the retry`)
  assert.doesNotMatch(rec.verdict, /INCOMPLETE/)
  assert.equal(rec.unitCoordinator?.[0]?.resurrectedConfined, 1)
})

test('unit batches: a sectioned finding the seam pass drops leaves the pool and is listed, its question carrying its lens', async () => {
  const finding = { severity: 'High', title: 'Drops the io error', file: 'crates/a/src/f0.rs', line: 4, why: 'w', whereChecked: '', fix: 'f', blastRadius: '', source: 'errors', ruleId: '' }
  const question = { unit: 'crates/x', symbol: 'X::open', path: 'crates/x/src/f0.rs', ask: 'does it retry?', findingTitle: 'Drops the io error', findingFile: 'crates/a/src/f0.rs', source: 'errors', blocking: false, answered: false, answer: '' }
  const run = await runEngine('review', { args: PINNED, script: script({
    lens: (/** @type {{ opts: any }} */ { opts }) => (lensOf(opts.label) === SECTIONED && /r1 unit:crates\/a unit:crates\/b$/.test(opts.label)
      ? { lens: SECTIONED, findings: [finding], questions: [question] }
      : { lens: lensOf(opts.label), findings: [] }),
    seam: { findings: [], dispositions: [{ lens: 'errors', findingFile: 'crates/a/src/f0.rs', findingTitle: 'Drops the io error', action: 'drop', why: 'X::open retries' }], answered: 1 },
  }) })
  const agent = labelled(run.calls, /^lens:rust:safety\+errors\+concurrency r1 unit:crates\/a unit:crates\/b$/)[0]
  assert.deepEqual(agent?.opts.schema.properties.questions.items.properties.source.enum, ['safety', 'errors', 'concurrency'])
  assert.ok(agent?.opts.schema.properties.questions.items.required.includes('source'))
  assert.match(agent?.prompt ?? '', /questions\[\] \(each with the lens of the finding that depends on it in source\)/)
  assert.match(labelled(run.calls, /^seam:rust/)[0]?.prompt ?? '', /"lens":"errors"/, 'the seam pass sees the member lens, not the bundle')
  const verify = run.calls.filter(c => /^(batch-)?verify/.test(String(c.label)))
  assert.ok(!verify.some(c => c.prompt.includes('Drops the io error')), 'the dropped finding never reaches verification')
  const tel = filedRecord(run).unitCoordinator?.[0]
  assert.deepEqual(tel.seam.dispositions, { confirm: 0, drop: 1, convert: 0 })
  assert.deepEqual(tel.seam.setAside, [{ action: 'drop', lens: 'errors', title: 'Drops the io error', file: 'crates/a/src/f0.rs', line: 4, severity: 'High', why: 'X::open retries' }])
})

test('unit batches: the per-unit estimate counts one agent per unit slice and lens even on a one-unit diff', async () => {
  // Twelve files in one directory of one unit: one unit slice, which the dispatch without batches reads as
  // "do not slice" — the estimate still counts the plan it stands for.
  const files = [...rs('crates/a/src', 12), 'Cargo.lock']
  const run = await runEngine('review', { args: PINNED, script: script({
    detect: { baseRef: 'main', files, spec: '', branch: 'feat/x', head: 'abc1234' },
    units: { roots: [], packages: ['@@ crates/a 900 12 a'], numstat: files.map(f => `5\t5\t${f}`) },
  }) })
  const e = filedRecord(run).unitCoordinator?.[0]?.costEstimate
  // One slice, crates/a, × 4 sliced lenses (safety, errors, concurrency, tests) + 1 contract.
  assert.equal(e.perUnit.agents, 5)
  // Batched: tests + one sectioned agent on the one batch + 1 contract.
  assert.equal(e.batched.agents, 3)
})

test('unit batches: a sectioned agent that dies leaves each member lens a hole with the agent\'s own failure', async () => {
  const run = await runEngine('review', { args: PINNED, script: script({
    lens: (/** @type {{ opts: any }} */ { opts }) => {
      if (lensOf(opts.label) === SECTIONED && /unit:crates\/a unit:crates\/b$/.test(opts.label)) throw new Error('upstream overloaded')
      return { lens: lensOf(opts.label), findings: [] }
    },
  }) })
  const notRun = filedRecord(run).notRun.join('\n')
  for (const l of ['safety', 'errors', 'concurrency']) assert.match(notRun, new RegExp(`${l} :: unit:crates/a unit:crates/b: upstream overloaded`), `${l}'s hole reads the sectioned agent's failure`)
  assert.doesNotMatch(notRun, /died without an error/)
  assert.match(filedRecord(run).verdict, /INCOMPLETE/)
})
