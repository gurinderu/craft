// The preflight's "ask each source once" rule used to live ONLY in the prompt's prose. These tests
// pin the half that does not: the engine now audits a declaration the agent must return, so a repeat
// is named in the log and carried into the run record instead of passing unremarked.
//
// Read `lib/preflight-probes.mjs`'s header for what this does and does NOT close: it audits the
// DECLARATION, not the shell. The falsifier for the engine tests below is the one that matters —
// revert the audit and the "repeat" run becomes indistinguishable from the honest one.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { auditPreflightProbes, probeDeclarationBlock, PROBE_BUDGETS } from './preflight-probes.mjs'

const HONEST = [
  { source: 'repo-identity', calls: 2 },
  { source: 'ci-check-runs', calls: 1 },
  { source: 'ci-commit-status', calls: 1 },
  { source: 'workflow-file', calls: 2 },
  { source: 'tool-inventory', calls: 2 },
  { source: 'runner-verify', calls: 1 },
  { source: 'blocker-probe', calls: 3 },
]

function preflight(probes) {
  return { runner: '', blockers: [], missingTools: [], ciCovers: ['test via cargo nextest'], probes, partial: false, notes: '' }
}

test('an honest declaration is clean', () => {
  assert.deepEqual(auditPreflightProbes(preflight(HONEST)), [])
})

test('asking one source twice is a violation', () => {
  const v = auditPreflightProbes(preflight([{ source: 'ci-check-runs', calls: 2 }]))
  assert.equal(v.length, 1)
  assert.match(v[0], /ci-check-runs.*2×.*budget 1/)
})

test('a repeat SPLIT across two entries is summed, not read as two small honest ones', () => {
  // The obvious way to slip the audit: declare 2+1 instead of 3 and hope each row is judged alone.
  const v = auditPreflightProbes(preflight([{ source: 'workflow-file', calls: 2 }, { source: 'workflow-file', calls: 1 }]))
  assert.equal(v.length, 1)
  assert.match(v[0], /workflow-file.*3×.*budget 2/)
})

test('a forbidden route is a violation at the first call, not at the second', () => {
  const v = auditPreflightProbes(preflight([{ source: 'ci-pr-checks', calls: 1 }]))
  assert.match(v[0], /forbidden probe source `ci-pr-checks` used 1×/)
  assert.equal(PROBE_BUDGETS['ci-pr-checks'].max, 0)
})

test('relabelling a repeat under a fresh id does not launder it', () => {
  const v = auditPreflightProbes(preflight([{ source: 'ci-check-runs-again', calls: 1 }]))
  assert.match(v[0], /unrecognized probe source `ci-check-runs-again`/)
})

test('a missing declaration is a violation of its own, never silence', () => {
  const v = auditPreflightProbes({ runner: '', ciCovers: [], partial: false, notes: '' })
  assert.equal(v.length, 1)
  assert.match(v[0], /declared no `probes` list/)
})

test('a dead preflight raises nothing — it has no declaration to break', () => {
  assert.deepEqual(auditPreflightProbes(null), [])
})

test('every budget the audit judges is also stated to the agent', () => {
  // A budget enforced but never named would be a trap rather than a contract.
  const block = probeDeclarationBlock()
  for (const id of Object.keys(PROBE_BUDGETS)) assert.ok(block.includes(`\`${id}\``), `${id} is not named in the prompt`)
})

// ---- the engine, end to end ----

function engineRun(probes) {
  return runEngine('review', {
    script: {
      detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
      'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
      preflight: preflight(probes),
      checkpoint: { runDir: '/store/.partial/run', error: '' },
      'log-run': { ok: true, error: '' },
      '*': null,
    },
  })
}

// The declaration below is 3 calls to `ci-check-runs` PLUS the honest set, which names that same
// source once more — so the audited total is 4, and the name says 4.
test('the engine NOTICES a preflight whose declaration totals four calls to a budget-1 source', async () => {
  const run = await engineRun([{ source: 'ci-check-runs', calls: 3 }, ...HONEST.slice(1)])

  const breach = run.logs.filter(l => /PREFLIGHT PROBE BUDGET BREACHED/.test(l))
  assert.equal(breach.length, 1, `the breach must be logged exactly once; logs: ${JSON.stringify(run.logs.slice(0, 40))}`)
  assert.match(breach[0], /ci-check-runs.*4×.*budget 1/,
    'and must name the source and the count — "a rule was broken" with no subject is not a report')

  // The log is read by a human watching one run. The record is what a later measurement can see, and
  // the whole reason this exists is that the previous drift was only visible post factum.
  const cp = run.calls.find(c => c.key === 'checkpoint')
  assert.match(cp.prompt, /probeViolations/, 'the Gate checkpoint carries the breach')
  const rec = filedRecord(run)
  assert.ok(rec, 'the engine must still file its record')
  assert.ok(rec.preflightProbeViolations.some(v => /ci-check-runs/.test(v)),
    `the filed record must carry the breach; got ${JSON.stringify(rec.preflightProbeViolations)}`)
  assert.match(rec.preflightProbeViolations[0], /^\[rust\]/, 'attributed to the language whose preflight broke it')
})

test('an honest preflight raises no alarm and files a clean list', async () => {
  const run = await engineRun(HONEST)
  assert.deepEqual(run.logs.filter(l => /PROBE BUDGET BREACHED/.test(l)), [],
    'a disciplined run must not be told it broke the budget')
  const rec = filedRecord(run)
  assert.deepEqual(rec.preflightProbeViolations, [],
    'and the field is present-and-empty, not absent: absence would read as "not audited"')
})

// ---- the cheapest answer must not be the clean one ----
//
// Every case below PASSED before the audit learned to refuse it, and each is fully valid against
// PREFLIGHT_SCHEMA as it was: an array with no `minItems`, an integer with no `minimum`. So a
// preflight that spent 48 invocations and declared nothing filed, byte for byte, what a disciplined
// one files — and returning `probes: []` was both the cheapest path to a clean audit and the cheapest
// path for a model. That is the defect: the audit only ever bound an agent that filled the list in.

test('an EMPTY probes list is a violation — a preflight consults something by definition', () => {
  const v = auditPreflightProbes(preflight([]))
  assert.equal(v.length, 1)
  assert.match(v[0], /EMPTY `probes` list/)
})

test('an empty probes list is a violation even when the run declares itself partial', () => {
  // `probes` describes what was ALREADY done, so unfinished work cannot empty it.
  const pf = preflight([])
  pf.partial = true
  const v = auditPreflightProbes(pf)
  assert.equal(v.length, 1)
  assert.match(v[0], /EMPTY `probes` list/)
})

test('an entry with no `calls` is a violation, not a silent zero', () => {
  const v = auditPreflightProbes(preflight([{ source: 'blocker-probe' }]))
  assert.equal(v.length, 1)
  assert.match(v[0], /blocker-probe.*no `calls`/)
})

test('a non-integer call count is a violation, not a NaN quietly read as zero', () => {
  const v = auditPreflightProbes(preflight([{ source: 'ci-check-runs', calls: 'many' }]))
  assert.equal(v.length, 1)
  assert.match(v[0], /ci-check-runs.*non-integer/)
})

test('a negative count is a violation and cannot cancel a real call', () => {
  const v = auditPreflightProbes(preflight([{ source: 'blocker-probe', calls: 9 }, { source: 'blocker-probe', calls: -8 }]))
  assert.equal(v.length, 2, `the negative and the over-budget total must BOTH be named; got ${JSON.stringify(v)}`)
  assert.ok(v.some(l => /negative/.test(l)))
  assert.ok(v.some(l => /blocker-probe.*9×.*budget 4/.test(l)),
    'the 9 must stand alone: a declared -8 must not buy the run back under budget')
})

test('the prompt states that the probes list is never emptied by a partial result', () => {
  // The partial-results paragraph offers "return the field EMPTY" over the unfinished fields, and
  // `probes` was not excluded from it — an escape hatch written by the prompt itself.
  const block = probeDeclarationBlock()
  assert.match(block, /never empty|cannot be empty|never be empty/i,
    'the block must say plainly that `probes` cannot be emptied, including in a partial result')
})

test('every call the prompt ORDERS has an id to declare it under', () => {
  // The prompt's step 1 orders a lookup for `.envrc`/`flake.nix`/`shell.nix`/`.direnv/`, and the Nix
  // profile orders flake metadata and a `system` check. With no id for those, an honest run must
  // either under-declare (which the prompt itself calls a false report) or invent an id (an automatic
  // violation) — so "the honest path and the disciplined path are the same path" was false there.
  assert.ok(Object.prototype.hasOwnProperty.call(PROBE_BUDGETS, 'runner-discover'),
    'the dev-shell marker-file lookup of step 1 has no probe id')
  assert.match(PROBE_BUDGETS['blocker-probe'].what, /metadata|system/,
    'the Nix blocker questions (flake metadata, system match) must be nameable under blocker-probe')
})
