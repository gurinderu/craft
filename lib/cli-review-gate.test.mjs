// review's gate alone (gateOnly, lib/cli-review-gate.mjs): the command it has the service agent run, the answer it
// builds from the binary's JSON — a red gate in the review's own words — and what may stand beside it.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
import { gateAnswer } from './cli-review-gate.mjs'
import { finishedAnswer } from './cli-review-verdict.mjs'
import { finishedStep } from './cli-review-step.mjs'
import { cliDegraded, cliFindings, gateResult } from './rust-audit-nested.mjs'

const RED = '⛔ Block — mechanical gate is red (rust). Fix the gate before a semantic review is worthwhile.'
const SECTION = '## Gate\n\n- **rust**: FAIL — clippy (Cargo.toml): fail\n  - Failed: clippy (Cargo.toml): mismatched types at src/lib.rs:1\n\n'
/** The binary's printed gate. @param {Record<string, unknown>} over */
const printed = over => ({ exitCode: 0, stderr: '', stdout: JSON.stringify({ base: 'main', head: 'abcdef1234567890', outcome: 'fail', line: RED, section: SECTION, gate: { tracks: [{ profile: 'rust', status: 'fail' }] }, ...over }) })

test('a red gate answers with the review\'s own line, then the gate\'s section', () => {
  const got = gateAnswer(printed({}))
  assert.ok('answer' in got)
  assert.equal(got.answer, `## Verdict\n\n${RED}\n\nThe mechanical gate alone over main..abcdef123456: no lens ran and no run record was filed.\n\n${SECTION.trim()}`)
})

test('green, not established and nothing to gate each say so; an unusable output is an error', () => {
  /** @param {Record<string, unknown>} over */
  const line = over => { const g = gateAnswer(printed(over)); return 'answer' in g ? g.answer.split('\n')[2] ?? '' : g.error }
  assert.equal(line({ outcome: 'pass', line: '' }), '✅ Approve — mechanical gate is green (rust).')
  assert.match(line({ outcome: 'unknown', line: '' }), /^⚠️ Warning — the gate was not established locally \(rust\): its signal is unknown/)
  const why = 'the gate was not established locally (rust: unknown); CI for abc1234: clippy green (checks clippy) — informs only, not a pass'
  assert.equal(line({ outcome: 'unknown', line: why }), `⚠️ Warning — ${why}: its signal is unknown, neither a failure nor a pass; the Gate section says why.`)
  assert.equal(gateResult(`## Verdict\n\n⚠️ Warning — ${why}: x`).verdict, 'Warning', 'not established: at most Warning, never Approve')
  const none = gateAnswer(printed({ outcome: 'none', line: '', section: '', gate: {} }))
  assert.ok('answer' in none)
  assert.match(none.answer, /^## Verdict\n\n✅ Approve — no Rust or Nix file in the change/)
  assert.match(none.answer, /## Gate\n\nNothing to gate/)
  const nothing = { outcome: 'none', line: '', gate: { tracks: [{ profile: 'nix', status: 'nothing', provenance: 'nix flake check: no flake.nix · `deadnix -o json`: local' }, { profile: 'rust', status: 'nothing' }] } }
  assert.equal(line(nothing), '✅ Approve — the mechanical gate had nothing to establish (nix: no flake.nix, and statix and deadnix ran; rust: no Cargo package holds the changed .rs files).')
  const unlinted = { outcome: 'none', line: '', gate: { tracks: [{ profile: 'nix', status: 'nothing', provenance: 'nix flake check: no flake.nix' }] } }
  assert.equal(line(unlinted), '✅ Approve — the mechanical gate had nothing to establish (nix: no flake.nix, and no .nix file left to lint).')
  assert.deepEqual(gateAnswer({ exitCode: 0, stdout: 'nope', stderr: '' }), { error: 'the gate printed no JSON: nope' })
  assert.deepEqual(gateAnswer(printed({ outcome: 'maybe' })), { error: 'the gate printed no outcome' })
  assert.match(String(/** @type {{ error: string }} */ (gateAnswer({ exitCode: 2, stdout: '', stderr: 'unrecognized subcommand' })).error), /exited 2: unrecognized subcommand/)
})

test('the engine runs the gate alone: one service step, `craft review gate`, no run, no record', async () => {
  const run = await runEngine('review', {
    args: { gateOnly: true, base: 'main', craftBin: '/opt/craft', _via: 'rust-audit' },
    script: { 'step:gate': printed({}) },
  })
  assert.deepEqual(run.calls.map(c => c.label), ['step:gate'], 'no start, no record agent')
  assert.match(run.calls[0]?.prompt ?? '', /^Run exactly this one command, in one Bash call with a timeout of 420000 ms \(it builds and lints the branch for the mechanical gate\):\n\n\/opt\/craft review gate --cwd \. --base 'main'$/m)
  assert.match(run.report, new RegExp(`^## Verdict\\n\\n${RED.replace(/[().]/g, '\\$&')}`))
  const dead = await runEngine('review', { args: { gateOnly: true, craftBin: '/opt/craft' }, script: { 'step:gate': null } })
  assert.match(dead.report, /^## Verdict\n\n⚠️ INCOMPLETE — review's gate did not run: the service agent returned no command output/)
})

test('beside gateOnly only repo, base, craftBin, craftRoot and _via stand: any review option is refused, nothing run', async () => {
  for (const extra of [{ path: 'crates/a' }, { gate: false }, { fresh: true }, { run: '/runs/x' }]) {
    const run = await runEngine('review', { args: { gateOnly: true, craftBin: '/opt/craft', ...extra }, script: { 'log-run': { ok: true } } })
    assert.ok(!run.calls.some(c => c.label === 'step:gate'), JSON.stringify(extra))
    assert.match(run.report, /beside gateOnly=true: the gate alone reads only the change against its base and runs no review\. Nothing ran\./)
  }
  const bad = await runEngine('review', { args: { gateOnly: 'yes', craftBin: '/opt/craft' }, script: { 'log-run': { ok: true } } })
  assert.match(bad.report, /gateOnly="yes" is not true or false/)
})

test('the audit reads the gate\'s answer as its gate dimension, the section kept apart', () => {
  const answer = gateAnswer(printed({}))
  assert.ok('answer' in answer)
  const r = gateResult(answer.answer)
  assert.equal(r.verdict, 'Block')
  assert.equal(r.summary, RED)
  assert.equal(r._gateDir, undefined, 'it named no directory')
  assert.equal(r._gateSection, `## Gate\n\n- **rust**: FAIL — clippy (Cargo.toml): fail\n  - Failed: clippy (Cargo.toml): mismatched types at src/lib.rs:1\n`)
  assert.equal(gateResult('## Verdict\n\n⚠️ INCOMPLETE — review\'s gate did not run: x').verdict, 'INCOMPLETE (gate not established)', 'a gate that did not run is not a missing tool')
  assert.equal(gateResult('no verdict').verdict, 'Warning')
  const kept = gateAnswer(printed({ outcome: 'pass', line: '', dir: '/home/u/.craft/runs/cli/g' }))
  assert.ok('answer' in kept)
  const green = gateResult(kept.answer)
  assert.equal(green._gateDir, '/home/u/.craft/runs/cli/g', 'the directory a review takes it from')
  assert.match(String(green._gateSection), /^## Gate\n\n✅ Approve — mechanical gate is green \(rust\)\.\n\n/, 'a gate that is not red keeps its line in its section')
})

test('a finished answer lists its degraded notes, which the audit reads back with its findings', () => {
  const note = 'round 1: 2 task(s) on `craft:rust-reviewer` ran on the default agent type instead, without its rubric (the first threw: boom) — this run is weaker than a normal one, not broken.'
  const odd = 'round 2: something else'
  const answer = finishedAnswer({ run: '/r', report: '/r/report.md', verdict: 'Warning', line: 'Warning — 1 Medium', degraded: true, degradedNotes: [note, odd], findings: [{ severity: 'Medium', file: 'src/a.rs', line: 4, title: 't', ruleId: '', tier: 'confirmed' }] })
  assert.ok(answer.includes(`Degraded section says how.\n- ${note}\n- ${odd}\n\n`))
  assert.deepEqual(cliDegraded(answer), [{ agent: 'craft:rust-reviewer', count: 2, error: 'the first threw: boom' }, { agent: 'a task agent', count: 1, error: odd }])
  assert.deepEqual(cliFindings(answer), [{ severity: 'Medium', title: 't (confirmed)', location: 'src/a.rs:4', detail: 'reported by the nested CLI review' }])
  assert.deepEqual(cliDegraded('## Verdict\n\n✅ Approve'), [])
})

test('gateFrom takes a kept gate: the start passes --gate-from and no --no-gate; beside gate=false or not absolute it is refused', async () => {
  const run = await runEngine('review', {
    args: { base: 'main', craftBin: '/opt/craft', path: 'crates/a', gateFrom: '/home/u/.craft/runs/cli/g', _via: 'rust-audit' },
    script: { 'step:start': { exitCode: 0, stderr: '', stdout: JSON.stringify({ run: '/runs/x', done: true, report: '/runs/x/report.md', verdict: 'Approve', filing: { runDir: '', rejoin: false, lost: [], record: 'filed' } }) } },
  })
  const start = run.calls.find(c => c.label === 'step:start')?.prompt ?? ''
  assert.match(start, / --gate-from '\/home\/u\/\.craft\/runs\/cli\/g' --path 'crates\/a'/)
  assert.doesNotMatch(start, /--no-gate/)
  const both = await runEngine('review', { args: { craftBin: '/opt/craft', gate: false, gateFrom: '/g' }, script: { 'log-run': { ok: true } } })
  assert.match(both.report, /cannot honour `gateFrom` beside gate=false/)
  assert.ok(!both.calls.some(c => c.label === 'step:start'))
  const relative = await runEngine('review', { args: { craftBin: '/opt/craft', gateFrom: 'g' }, script: { 'log-run': { ok: true } } })
  assert.match(relative.report, /gateFrom="g" is not an absolute path/)
})

test('a finished step\'s memory part rides in the answer verbatim, before the findings list', () => {
  const sections = '\n\n## Rejected before (set aside — not in the verdict)\n- Medium · `src/a.rs:3` · t · w · REJECTED BEFORE: r — a\n\n## Memory\n- memory: none — x\n'
  const read = finishedStep({ run: '/r', done: true, report: '/r/report.md', verdict: 'Approve', memorySections: sections })
  assert.ok('step' in read)
  assert.equal(read.step.memorySections, sections)
  const answer = finishedAnswer(read.step)
  assert.ok(answer.includes(`(run /r).\n\n${sections.trim()}\n\n## Findings\n`), answer)
  assert.ok(!finishedAnswer({ ...read.step, memorySections: '' }).includes('## Memory'))
})
