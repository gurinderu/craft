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
/** The nested CLI reviews, the gate alone's launch aside. @param {{ calls: { label: string, argv?: any[] }[] }} r */
const reviewCalls = r => r.calls.filter(c => c.label === 'workflow' && !c.argv?.[1]?.gateOnly)
/** @param {{ calls: { label: string, argv?: any[] }[] }} r */
const nestedPaths = r => reviewCalls(r).map(c => c.argv?.[1]?.path ?? null)
/** @param {{ calls: { label: string, argv?: any[] }[] }} r */
const gateCalls = r => r.calls.filter(c => c.label === 'workflow' && c.argv?.[1]?.gateOnly)

test('with a base resolved and no changed crate, one whole-workspace review runs on that base', async () => {
  const r = await run({ scout: scout({ baseRef: 'main', crates: [A, B] }) })
  assert.deepEqual(nestedPaths(r), [null])
  assert.equal(reviewCalls(r)[0]?.argv?.[1]?.base, 'main')
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

// The nested review is the CLI review (realm @nick/craft, node #150): each crate's a fresh, ungated run under the
// audit, the mechanical gate once for the whole change.
const RED = '⛔ Block — mechanical gate is red (rust). Fix the gate before a semantic review is worthwhile.'
const GATE_SECTION = '## Gate\n\n- **rust**: FAIL — clippy (crates/a/Cargo.toml): fail\n  - Failed: clippy (crates/a/Cargo.toml): mismatched types at crates/a/src/lib.rs:1\n'
/** The nested CLI review's answers: the gate's `gate`, each review's `review`. @param {string} gate @param {(path: string) => string} review */
const nestedAnswers = (gate, review) => (/** @type {{ argv: any[] }} */ { argv }) => (argv[1].gateOnly ? gate : review(argv[1].path ?? ''))
const greenGate = '## Verdict\n\n✅ Approve — mechanical gate is green (rust).\n\n## Gate\n\n- **rust**: pass — clippy: pass\n'

test('each crate is a nested cli-review with its path, fresh and gate=false; no languages, no _memory*', async () => {
  const r = await run({ scout: scout({ baseRef: 'main', crates: [A, B], changedCrates: [A, B] }), workflow: nestedAnswers(greenGate, () => '## Verdict\n\n✅ Approve') }, { craftRoot: '/craft' })
  const calls = reviewCalls(r)
  assert.deepEqual(calls.map(c => c.argv?.[0]).sort(), ['craft:cli-review', 'craft:cli-review'])
  for (const c of calls) {
    const a = c.argv?.[1]
    assert.equal(a.fresh, true)
    assert.equal(a.gate, false)
    assert.equal(a._via, 'rust-audit')
    assert.equal(a.base, 'main')
    assert.equal(a.craftRoot, '/craft')
    for (const k of ['languages', '_memory', '_memoryParts', '_externals', '_knownExternals']) assert.ok(!(k in a), `${k} is not passed`)
  }
  assert.deepEqual(calls.map(c => c.argv?.[1]?.path).sort(), ['crates/a', 'crates/b'])
})

test('the gate runs once, alone, for the whole change — beside per-crate reviews and beside a whole-workspace one', async () => {
  const perCrate = await run({ scout: scout({ baseRef: 'main', crates: [A, B, C], changedCrates: [A, B, C] }), workflow: nestedAnswers(greenGate, () => '## Verdict\n\n✅ Approve') })
  const gates = gateCalls(perCrate)
  assert.equal(gates.length, 1)
  assert.deepEqual(gates[0]?.argv?.[1], { gateOnly: true, base: 'main', _via: 'rust-audit' })
  assert.ok(reviewCalls(perCrate).every(c => c.argv?.[1]?.gate === false))
  const whole = await run({ scout: scout({ baseRef: 'main', crates: [A] }), workflow: nestedAnswers(greenGate, () => '## Verdict\n\n✅ Approve') })
  assert.equal(gateCalls(whole).length, 1)
  assert.equal(reviewCalls(whole)[0]?.argv?.[1]?.gate, false)
  assert.equal(filedRecord(whole).dimensions.find((/** @type {{ dimension: string }} */ d) => d.dimension === 'gate')?.verdict, 'Approve')
})

test('a red gate is a Block in the review\'s own words, its section in the report exactly once', async () => {
  const redGate = `## Verdict\n\n${RED}\n\nThe mechanical gate alone over main..abc: no lens ran and no run record was filed.\n\n${GATE_SECTION}`
  for (const synthesis of ['the audit body', null]) {
    const r = await run({ scout: scout({ baseRef: 'main', crates: [A, B], changedCrates: [A, B] }), synthesis, workflow: nestedAnswers(redGate, () => '## Verdict\n\n✅ Approve') })
    const synth = r.calls.find(c => c.label === 'synthesis')?.prompt ?? ''
    assert.ok(synth.includes(`"summary": ${JSON.stringify(RED)}`), 'the synthesis gets the gate\'s own line')
    assert.ok(!synth.includes('Failed: clippy'), 'its section is not handed to the synthesis')
    assert.equal(r.report.split('## Gate\n').length, 2, 'the gate section once')
    assert.ok(r.report.includes(`## Gate\n\n${RED}\n\n- **rust**: FAIL`), 'led by the red line')
    assert.match(String(filedRecord(r).verdict), /^Block/)
  }
})

test('a nested INCOMPLETE is uncovered, not clean; its findings and degraded agents reach the audit', async () => {
  const answers = nestedAnswers(greenGate, path => (path === 'crates/a'
    ? '## Verdict\n\n⚠️ INCOMPLETE — cli-review stopped at round 2: the service agent returned no command output.'
    : '## Verdict\n\n⚠️ Warning — 1 Medium\n\nThe report is /runs/b/report.md — read that file for the findings (run /runs/b).\n\n⚠️ Degraded: part of this review ran weaker than asked — the report\'s Degraded section says how.\n- round 1: 2 task(s) on `craft:rust-reviewer` ran on the default agent type instead, without its rubric (the first threw: boom) — this run is weaker than a normal one, not broken.\n\n## Findings\n\n- [Medium] crates/b/src/lib.rs:4 — unwrap may panic (confirmed)'))
  const r = await run({ scout: scout({ baseRef: 'main', crates: [A, B], changedCrates: [A, B] }), workflow: answers })
  const synth = r.calls.find(c => c.label === 'synthesis')?.prompt ?? ''
  const results = JSON.parse(synth.slice(synth.indexOf('RESULTS:\n') + 9))
  const a = results.find((/** @type {{ dimension: string }} */ x) => x.dimension === 'review:a')
  assert.equal(a.verdict, 'Warning')
  assert.match(a.summary, /did NOT run to completion — this dimension is uncovered, not clean/)
  const b = results.find((/** @type {{ dimension: string }} */ x) => x.dimension === 'review:b')
  assert.deepEqual(b.findings.slice(1), [{ severity: 'Medium', title: 'unwrap may panic (confirmed)', location: 'crates/b/src/lib.rs:4', detail: 'reported by the nested CLI review' }])
  assert.match(b.findings[0].detail, /The report is \/runs\/b\/report\.md/)
  assert.match(r.report, /`craft:rust-reviewer`/, 'the nested review\'s degraded agent is named in the audit\'s section')
  assert.match(r.report, /lens dispatch\(es\) of the nested review review:b/)
})
