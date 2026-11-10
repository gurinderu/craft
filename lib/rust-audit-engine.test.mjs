// rust-audit end to end in the engine harness: which dimensions a scout result makes it dispatch,
// what it logs and tells the synthesizer about dimensions that did not answer, and what it files for
// the unused-crates verification. These pin what the engine dispatches and files, not how its body is
// arranged.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { finishedAnswer } from './cli-review-verdict.mjs'
import { readFileSync } from 'node:fs'

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

const KEPT = '/home/u/.craft/runs/cli/gate-1'
/** The gate's answer naming where it kept its result. @param {string} line @param {string} section */
const gateAnswerKept = (line, section) => `## Verdict\n\n${line}\n\nThe mechanical gate alone over main..abc: no lens ran and no run record was filed. Its result and seeds are kept in ${KEPT}: a review of this change takes them with gateFrom=${KEPT}.\n\n${section}`
const keptGreen = gateAnswerKept('✅ Approve — mechanical gate is green (rust).', '## Gate\n\n- **rust**: pass — clippy: pass\n')

test('each crate is a nested review with its path, fresh and the gate the audit kept; no languages, no _memory*', async () => {
  const r = await run({ scout: scout({ baseRef: 'main', crates: [A, B], changedCrates: [A, B] }), workflow: nestedAnswers(keptGreen, () => '## Verdict\n\n✅ Approve') }, { craftRoot: '/craft' })
  const calls = reviewCalls(r)
  assert.deepEqual(calls.map(c => c.argv?.[0]).sort(), ['craft:review', 'craft:review'])
  for (const c of calls) {
    const a = c.argv?.[1]
    assert.equal(a.fresh, true)
    assert.equal(a.gateFrom, KEPT, 'the review takes the gate run once, its seeds reaching the lenses')
    assert.ok(!('gate' in a), 'and asks for no gate of its own besides')
    assert.equal(a._via, 'rust-audit')
    assert.equal(a.base, 'main')
    assert.equal(a.craftRoot, '/craft')
    for (const k of ['languages', '_memory', '_memoryParts', '_externals', '_knownExternals']) assert.ok(!(k in a), `${k} is not passed`)
  }
  assert.deepEqual(calls.map(c => c.argv?.[1]?.path).sort(), ['crates/a', 'crates/b'])
})

test('the gate runs once, first: every review starts after it; a gate that kept nothing leaves them ungated', async () => {
  /** @type {string[]} */
  const order = []
  const answers = (/** @type {{ argv: any[] }} */ { argv }) => {
    order.push(argv[1].gateOnly ? 'gate' : 'review')
    return argv[1].gateOnly ? greenGate : '## Verdict\n\n✅ Approve'
  }
  const perCrate = await run({ scout: scout({ baseRef: 'main', crates: [A, B, C], changedCrates: [A, B, C] }), workflow: answers })
  const gates = gateCalls(perCrate)
  assert.equal(gates.length, 1)
  assert.deepEqual(gates[0]?.argv?.[1], { gateOnly: true, base: 'main', _via: 'rust-audit' })
  assert.deepEqual(order, ['gate', 'review', 'review', 'review'], 'no review is launched before the gate answered')
  assert.ok(reviewCalls(perCrate).every(c => c.argv?.[1]?.gate === false && !('gateFrom' in (c.argv?.[1] ?? {}))), 'no kept result: ungated')
  const whole = await run({ scout: scout({ baseRef: 'main', crates: [A] }), workflow: nestedAnswers(keptGreen, () => '## Verdict\n\n✅ Approve') })
  assert.equal(gateCalls(whole).length, 1)
  assert.equal(reviewCalls(whole)[0]?.argv?.[1]?.gateFrom, KEPT)
  assert.equal(filedRecord(whole).dimensions.find((/** @type {{ dimension: string }} */ d) => d.dimension === 'gate')?.verdict, 'Approve')
  // A gate not established still lets the reviews run, taking what it kept; it is a Warning that names no missing tool.
  const unknown = await run({ scout: scout({ baseRef: 'main', crates: [A, B], changedCrates: [A, B] }), workflow: nestedAnswers(gateAnswerKept('⚠️ Warning — the gate was not established locally (rust: unknown); no CI check informed it: x', '## Gate\n\n- **rust**: unknown\n'), () => '## Verdict\n\n✅ Approve') })
  assert.equal(reviewCalls(unknown).length, 2)
  assert.equal(filedRecord(unknown).dimensions.find((/** @type {{ dimension: string }} */ d) => d.dimension === 'gate')?.verdict, 'Warning')
  assert.equal(filedRecord(unknown).verdict, 'Warning', 'never Approve over an unknown gate')
  assert.deepEqual(filedRecord(unknown).couldNotRun, [], 'not a tool not installed')
  // A dead gate leaves them ungated, and is itself NOT RUN.
  const dead = await run({ scout: scout({ baseRef: 'main', crates: [A, B], changedCrates: [A, B] }), workflow: nestedAnswers(/** @type {any} */ (null), () => '## Verdict\n\n✅ Approve') })
  assert.equal(reviewCalls(dead).length, 2)
  assert.ok(reviewCalls(dead).every(c => c.argv?.[1]?.gate === false))
  assert.ok(filedRecord(dead).notRun.includes('gate'))
})

test('a red gate starts no review: each NOT RUN with its reason, the audit Block in the binary\'s words, the section once', async () => {
  const redGate = gateAnswerKept(RED, GATE_SECTION)
  for (const synthesis of ['the audit body', null]) {
    const r = await run({ scout: scout({ baseRef: 'main', crates: [A, B], changedCrates: [A, B] }), synthesis, workflow: nestedAnswers(redGate, () => '## Verdict\n\n✅ Approve') })
    assert.equal(reviewCalls(r).length, 0, 'no review launched')
    const synth = r.calls.find(c => c.label === 'synthesis')?.prompt ?? ''
    assert.ok(synth.includes(`"summary": ${JSON.stringify(RED)}`), 'the synthesis gets the gate\'s own line')
    assert.ok(!synth.includes('Failed: clippy'), 'its section is not handed to the synthesis')
    assert.match(synth, /NOT RUN \(gate red[^\n]*\): review:a, review:b\n/)
    assert.match(synth, /NOT RUN \(no result — agent failed or was skipped\): none\n/, 'not a coverage gap')
    assert.ok(r.logs.includes('Not started, the mechanical gate is red: review:a, review:b — flagged NOT RUN (gate red) in the report.'))
    assert.ok(r.logs.some(l => l.startsWith('review:a: NOT RUN — the mechanical gate is red: ⛔ Block')))
    const record = filedRecord(r)
    assert.equal(record.verdict, 'Block', 'Block, not INCOMPLETE: the red gate is the verdict')
    assert.deepEqual(record.gateBlocked, ['review:a', 'review:b'], 'filed apart from notRun')
    assert.ok(!record.notRun.some((/** @type {string} */ d) => d.startsWith('review')), 'notRun is fragility a re-run fixes; a red gate is not')
    assert.ok(r.report.startsWith(`${RED}\n\n`) || r.report.includes(`\n${RED}\n\n`), 'the report is led by the gate\'s line')
    assert.equal(r.report.split(RED).length, 2, 'the line once')
    assert.equal(r.report.split('## Gate\n').length, 2, 'the gate section once')
    assert.ok(r.report.includes('## Gate\n\n- **rust**: FAIL'))
  }
})

test('a nested INCOMPLETE is uncovered, not clean; its findings and degraded agents reach the audit', async () => {
  const answers = nestedAnswers(greenGate, path => (path === 'crates/a'
    ? '## Verdict\n\n⚠️ INCOMPLETE — review stopped at round 2: the service agent returned no command output.'
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

test('a gate that answered but kept nothing: the reviews run ungated, and the log and the report say so', async () => {
  const r = await run({ scout: scout({ baseRef: 'main', crates: [A, B], changedCrates: [A, B] }), workflow: nestedAnswers(greenGate, () => '## Verdict\n\n✅ Approve') })
  assert.ok(reviewCalls(r).every(c => c.argv?.[1]?.gate === false))
  const said = r.logs.filter(l => l.startsWith('⚠️ The gate named no directory'))
  assert.equal(said.length, 1, 'logged once')
  assert.ok(r.report.includes('## Gate\n') && r.report.includes('⚠️ The gate named no directory its result was kept in, so every review ran with no gate of its own (gate=false)'))
})

test('the dimensions that run cargo builds wait for the gate; the others do not', async () => {
  /** @type {string[]} */
  const order = []
  const workflow = async (/** @type {{ argv: any[] }} */ { argv }) => {
    order.push(argv[1].gateOnly ? 'gate:start' : 'review')
    await new Promise(res => setTimeout(res, 5))
    if (argv[1].gateOnly) order.push('gate:end')
    return argv[1].gateOnly ? keptGreen : '## Verdict\n\n✅ Approve'
  }
  const at = (/** @type {string} */ label) => () => { order.push(label); return green }
  await run({ scout: scout({ baseRef: 'main', hasUnsafe: true, crates: [A] }), workflow, semver: at('semver'), 'build-matrix': at('build-matrix'), 'tests-cov': at('tests-cov'), security: at('security'), miri: at('miri'), deps: at('deps'), 'unused-crates:find': at('unused-crates:find') })
  const end = order.indexOf('gate:end')
  assert.ok(end > 0)
  for (const d of ['semver', 'build-matrix', 'tests-cov', 'security', 'miri', 'unused-crates:find']) assert.ok(order.indexOf(d) > end, `${d} after the gate: ${order.join(' ')}`)
  assert.ok(order.indexOf('deps') < end, `deps does not wait: ${order.join(' ')}`)
})

test('a nested review\'s memory part — what memory set aside, its memory line and how many it applied — is lifted verbatim', async () => {
  // The binary's own output, held to the Rust side by cli/crates/craft-review/tests/memory.rs (memory_sections_parity).
  const sections = JSON.parse(readFileSync(new URL('../content/parity/memory-sections.json', import.meta.url), 'utf8')).memorySections
  const applying = finishedAnswer({ run: '/r', report: '/r/report.md', verdict: 'Warning', line: 'Warning — 1 Medium', degraded: false, memorySections: sections, findings: [] })
  const none = finishedAnswer({ run: '/r', report: '/r/report.md', verdict: 'Approve', line: 'Approve', degraded: false, memorySections: '\n\n## Memory\n- memory: none — not recalled — the launcher asked for none (--no-recall): only its own records apply\n', findings: [] })
  const recall = { backend: 'repo', why: 'w', decisions: [{ id: 'decision-7a42e6ae4e', kind: 'decision', title: 'unwrap may panic', body: 'validated upstream', scope: 'crates', status: 'active', date: '2026-10-01', author: 'alice', commit: 'abc1234', links: [] }] }
  const r = await run({ scout: scout({ baseRef: 'main', crates: [A, B], changedCrates: [A, B] }), 'memory-recall': recall, workflow: nestedAnswers(keptGreen, path => (path === 'crates/a' ? applying : none)) })
  const at = r.report.indexOf('## Prior decisions in the nested reviews (verbatim)\n### review:a\n## Rejected before (set aside — not in the verdict)\n- Medium · `src/lib.rs:1` · f returns 1, not 0')
  assert.ok(at >= 0, r.report)
  const lifted = r.report.slice(at)
  assert.ok(lifted.includes('## Memory\n- memory: none — no memory configured (backend none); plus 1 passed by the launcher'))
  assert.ok(lifted.includes('\n- prior decisions: 1 decision(s) given, 1 finding(s) set aside as rejected before, 0 raised again'), 'the applied count, as the binary wrote it')
  assert.ok(!lifted.includes('### review:b'), 'a review that applied nothing adds nothing')
  assert.match(r.report, /each nested review reports how many it applied/)
  const quiet = await run({ scout: scout({ baseRef: 'main', crates: [A, B], changedCrates: [A, B] }), 'memory-recall': recall, workflow: nestedAnswers(keptGreen, () => none) })
  assert.doesNotMatch(quiet.report, /Prior decisions in the nested reviews/, 'no section when no nested review applied any')
})

test('a gate that answered with neither a section nor a directory: the sentence stands under its own Gate heading', async () => {
  const r = await run({ scout: scout({ baseRef: 'main', crates: [A, B], changedCrates: [A, B] }), workflow: nestedAnswers('## Verdict\n\n✅ Approve — mechanical gate is green (rust).', () => '## Verdict\n\n✅ Approve') })
  assert.ok(r.report.includes('## Gate\n\n⚠️ The gate named no directory its result was kept in'), r.report)
  assert.equal(r.report.split('## Gate\n').length, 2)
})
