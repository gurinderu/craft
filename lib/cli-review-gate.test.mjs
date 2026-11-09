// cli-review's gate alone (gateOnly, lib/cli-review-gate.mjs): the command it has the service agent run, the answer it
// builds from the binary's JSON — a red gate in the review's own words — and what may stand beside it.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
import { gateAnswer } from './cli-review-gate.mjs'
import { finishedAnswer } from './cli-review-verdict.mjs'
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
  assert.match(line({ outcome: 'unknown', line: '' }), /^⚠️ INCOMPLETE — mechanical gate could not be established \(rust\)/)
  const none = gateAnswer(printed({ outcome: 'none', line: '', section: '', gate: {} }))
  assert.ok('answer' in none)
  assert.match(none.answer, /^## Verdict\n\n✅ Approve — no Rust or Nix file in the change/)
  assert.match(none.answer, /## Gate\n\nNothing to gate/)
  assert.deepEqual(gateAnswer({ exitCode: 0, stdout: 'nope', stderr: '' }), { error: 'the gate printed no JSON: nope' })
  assert.deepEqual(gateAnswer(printed({ outcome: 'maybe' })), { error: 'the gate printed no outcome' })
  assert.match(String(/** @type {{ error: string }} */ (gateAnswer({ exitCode: 2, stdout: '', stderr: 'unrecognized subcommand' })).error), /exited 2: unrecognized subcommand/)
})

test('the engine runs the gate alone: one service step, `craft review gate`, no run, no record', async () => {
  const run = await runEngine('cli-review', {
    args: { gateOnly: true, base: 'main', craftBin: '/opt/craft', _via: 'rust-audit' },
    script: { 'step:gate': printed({}) },
  })
  assert.deepEqual(run.calls.map(c => c.label), ['step:gate'], 'no start, no record agent')
  assert.match(run.calls[0]?.prompt ?? '', /^Run exactly this one command, in one Bash call with a timeout of 420000 ms \(it builds and lints the branch for the mechanical gate\):\n\n'\/opt\/craft' review gate --cwd \. --base 'main'$/m)
  assert.match(run.report, new RegExp(`^## Verdict\\n\\n${RED.replace(/[().]/g, '\\$&')}`))
  const dead = await runEngine('cli-review', { args: { gateOnly: true, craftBin: '/opt/craft' }, script: { 'step:gate': null } })
  assert.match(dead.report, /^## Verdict\n\n⚠️ INCOMPLETE — cli-review's gate did not run: the service agent returned no command output/)
})

test('beside gateOnly only repo, base, craftBin, craftRoot and _via stand: any review option is refused, nothing run', async () => {
  for (const extra of [{ path: 'crates/a' }, { gate: false }, { fresh: true }, { run: '/runs/x' }]) {
    const run = await runEngine('cli-review', { args: { gateOnly: true, craftBin: '/opt/craft', ...extra }, script: { 'log-run': { ok: true } } })
    assert.ok(!run.calls.some(c => c.label === 'step:gate'), JSON.stringify(extra))
    assert.match(run.report, /beside gateOnly=true: the gate alone reads only the change against its base and runs no review\. Nothing ran\./)
  }
  const bad = await runEngine('cli-review', { args: { gateOnly: 'yes', craftBin: '/opt/craft' }, script: { 'log-run': { ok: true } } })
  assert.match(bad.report, /gateOnly="yes" is not true or false/)
})

test('the audit reads the gate\'s answer as its gate dimension, the section kept apart', () => {
  const answer = gateAnswer(printed({}))
  assert.ok('answer' in answer)
  const r = gateResult(answer.answer)
  assert.equal(r.verdict, 'Block')
  assert.equal(r.summary, RED)
  assert.equal(r._gateSection, `## Gate\n\n${RED}\n\n- **rust**: FAIL — clippy (Cargo.toml): fail\n  - Failed: clippy (Cargo.toml): mismatched types at src/lib.rs:1\n`)
  assert.equal(gateResult('## Verdict\n\n⚠️ INCOMPLETE — cli-review\'s gate did not run: x').verdict, 'INCOMPLETE (not run)')
  assert.equal(gateResult('no verdict').verdict, 'Warning')
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
