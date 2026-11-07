// rust-audit end to end in the engine harness: which dimensions a scout result makes it dispatch,
// what it logs and tells the synthesizer about dimensions that did not answer, and what it files for
// the unused-crates verification. These pin what the engine dispatches and files, not how its body is
// arranged.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }
const A = { name: 'a', path: 'crates/a' }
const B = { name: 'b', path: 'crates/b' }
const C = { name: 'c', path: 'crates/c' }
/** @param {Record<string, unknown>} over */
const scout = over => ({ baseRef: '', hasUnsafe: false, crates: [], changedCrates: [], edges: [], repoRoot: '/r', notes: 'n', ...over })

/** @param {Record<string, any>} script @param {Record<string, unknown>} [args] */
const run = (script, args = {}) => runEngine('rust-audit', { args, script: { workflow: () => '## Verdict\n✅ Approve', '*': green, ...script } })
/** @param {{ calls: { label: string }[] }} r */
const labels = r => r.calls.map(c => c.label)
/** @param {{ calls: { label: string, argv?: any[] }[] }} r */
const nestedPaths = r => r.calls.filter(c => c.label === 'workflow').map(c => c.argv?.[1]?.path ?? null)

test('with a base resolved and no changed crate, one whole-workspace review runs on that base', async () => {
  const r = await run({ scout: scout({ baseRef: 'main', crates: [A, B] }) })
  assert.deepEqual(nestedPaths(r), [null])
  assert.equal(r.calls.find(c => c.label === 'workflow')?.argv?.[1]?.base, 'main')
  assert.equal(filedRecord(r).scout.baseRef, 'main')
})

test('with no base, every crate gets its own scoped review', async () => {
  const r = await run({ scout: scout({ crates: [A, B] }) })
  assert.deepEqual(nestedPaths(r), ['crates/a', 'crates/b'])
})

test('a base scopes the contracts to edges touching a changed crate; no base reviews every edge', async () => {
  const edges = [{ from: 'a', to: 'b' }, { from: 'c', to: 'b' }]
  const scoped = await run({ scout: scout({ baseRef: 'main', crates: [A, B, C], changedCrates: [A], edges }) })
  assert.deepEqual(labels(scoped).filter(l => l.startsWith('contract:')), ['contract:a->b'])
  const all = await run({ scout: scout({ crates: [A, B, C], edges }) })
  assert.deepEqual(labels(all).filter(l => l.startsWith('contract:')), ['contract:a->b', 'contract:c->b'])
})

test('no edge to review skips the contracts dimension, and says so', async () => {
  const r = await run({ scout: scout({}) })
  assert.ok(!labels(r).some(l => l.startsWith('contract:')))
  assert.ok(r.logs.includes('No intra-workspace dependency edges to review — skipping the contracts dimension.'))
})

test('Miri runs on unsafe code, or when the scout died; it is skipped, said, without unsafe', async () => {
  const safe = await run({ scout: scout({}) })
  assert.ok(!labels(safe).includes('miri'))
  assert.ok(safe.logs.includes('No unsafe code detected — skipping Miri.'))
  assert.equal(filedRecord(safe).scout.hasUnsafe, false)
  const unsafe = await run({ scout: scout({ hasUnsafe: true }) })
  assert.ok(labels(unsafe).includes('miri'))
  const dead = await run({ scout: null })
  assert.ok(labels(dead).includes('miri'))
  assert.ok(dead.logs.includes('scout produced no result — assuming unsafe present, no base ref'))
  assert.deepEqual(filedRecord(dead).scout, { baseRef: '', crateCount: 0, changedCrateCount: 0, edgeCount: 0, hasUnsafe: true })
})

test('cargo mutants runs only when asked', async () => {
  const prompt = async (/** @type {Record<string, unknown>} */ args) => (await run({ scout: scout({}) }, args)).calls.find(c => c.label === 'tests-cov')?.prompt ?? ''
  assert.match(await prompt({}), / Do NOT run cargo mutants \(not requested via \{mutants:true\}\)\./)
  assert.match(await prompt({ mutants: true }), / Run `cargo mutants --timeout 60`, time-boxed, to surface weak spots \(it is slow\)\./)
})

test('each kind of silent dimension is logged and named to the synthesizer; none says none', async () => {
  const r = await run({
    scout: scout({}),
    semver: null,
    deps: { verdict: 'INCOMPLETE (not run)', summary: 'absent', findings: [], evidence: '' },
    'build-matrix': { verdict: 'Approve', summary: 'ok', findings: [], evidence: '' },
  })
  assert.ok(r.logs.includes('No result from: semver — flagged NOT RUN in the report.'))
  assert.ok(r.logs.includes('Tooling absent, nothing checked: deps — flagged COULD NOT RUN in the report.'))
  assert.ok(r.logs.includes('Reported a green but showed no Evidence: build-matrix — flagged NO EVIDENCE (verdict not trusted) in the report.'))
  const synth = r.calls.find(c => c.label === 'synthesis')?.prompt ?? ''
  assert.match(synth, /NOT RUN \(no result — agent failed or was skipped\): semver\n/)
  assert.match(synth, /treat as uncovered, never as a pass\): deps\n/)
  assert.match(synth, /do NOT assert its tooling was absent\): build-matrix\n/)

  const clean = await run({ scout: scout({}) })
  assert.ok(!clean.logs.some(l => /flagged (NOT RUN|COULD NOT RUN|NO EVIDENCE)/.test(l)))
  const s2 = clean.calls.find(c => c.label === 'synthesis')?.prompt ?? ''
  assert.match(s2, /NOT RUN \(no result — agent failed or was skipped\): none\n/)
  assert.match(s2, /treat as uncovered, never as a pass\): none\n/)
  assert.match(s2, /do NOT assert its tooling was absent\): none\n/)
})

test('the unused-crates verification is filed with its tallies, and as null when that dimension died', async () => {
  const cand = { severity: 'Info', title: 'orphan-member: c', location: 'crates/c/Cargo.toml', detail: 'd' }
  const r = await run({
    scout: scout({}),
    'unused-crates:find': { verdict: 'Warning', summary: 's', findings: [cand], evidence: '' },
    'unused-crates:verify#1': { confirmedUnused: true, evidence: 'grep', removal: 'drop it' },
  })
  assert.deepEqual(filedRecord(r).verification, { candidates: 1, confirmed: 1, refuted: 0, died: 0, judged: 1, refuteRate: 0 })
  const dead = await run({ scout: scout({}), 'unused-crates:find': null })
  assert.equal(filedRecord(dead).verification, null)
})
