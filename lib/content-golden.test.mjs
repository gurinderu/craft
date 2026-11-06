// The review's knowledge moved into content/ (realm @nick/craft, #445) renders byte-identical to the prompts and
// schemas the engine built before the move: every snapshot here was captured from the builders as they stood
// then, and a change to a prompt or schema's text is a change to its snapshot, made on purpose.
import { expect, test } from 'vitest'
import { openReviewRun } from './review-run.mjs'
import { makeLensPrompts } from './review-lens-prompts.mjs'
import { PROFILES } from './review-profiles.mjs'
import { RUST_UNITS } from './rust-units.mjs'
import { batchVerifyPrompt, verifyPrompt } from './review-verify.mjs'
import * as schemas from './review-schemas.mjs'
import * as unitSchemas from './review-unit-schemas.mjs'
import { MATCH_JUDGE_SCHEMA } from './prior-decision-match.mjs'
import { RULE_JUDGE_SCHEMA } from './project-rule-judge.mjs'
import batchVerdictSchema from '../content/schemas/batch-verdict.schema.json' with { type: 'json' }
import dedupSchema from '../content/schemas/dedup.schema.json' with { type: 'json' }

const stub = () => {}
/** @param {Record<string, unknown>} args */
function run(args) {
  const r = openReviewRun({ args, agent: async () => null, parallel: async () => [], phase: stub, log: stub, budget: { total: null, spent: () => 0, remaining: () => 0 } }, '9.9.9', [])
  return { ...r, sources: { ...r.sources, lensBlock: (/** @type {string} */ lens) => (lens === 'compat' ? 'EXTERNAL SOURCES: read /cache/sys@v1' : '') } }
}

const RUNS = {
  plain: run({}),
  full: run({ intent: 'make the reconcile idempotent', path: 'crates/core', strict: true, craftRoot: '/plugin/craft' }),
}
const PRIOR = /** @type {any} */ ({ found: true, round: 2, head: 'abc1234', ledger: [], ledgerCount: 0, reason: '', priorFindings: 3, journalSourced: false })
const SCOPES = {
  first: { lensBase: '', priorRound: null, fullRescan: false },
  based: { lensBase: 'origin/main', priorRound: null, fullRescan: false },
  rereview: { lensBase: 'abc1234', priorRound: PRIOR, fullRescan: false },
  rescan: { lensBase: 'origin/main', priorRound: PRIOR, fullRescan: true },
}
const PLANS = {
  bare: { sizeBucket: 'small', lenses: [], maxRounds: 1, verifyVotes: 1, lensModel: 'sonnet', isLibrary: false, securitySensitive: false, intent: '', spec: '', churn: [], repoRules: [] },
  rich: { sizeBucket: 'medium', lenses: [], maxRounds: 2, verifyVotes: 2, lensModel: 'opus', isLibrary: true, securitySensitive: true, intent: 'add a retry', spec: 'Retries are idempotent.\nNever fails on a missing child.', churn: ['src/a.rs', 'src/b.rs'], repoRules: ['AGENTS.md'] },
}
const PRIOR_SUMMARY = '- [High] races on shared map (src/a.rs:10)'
const SLICE = { key: 'crates/core', files: ['crates/core/src/lib.rs', "crates/core/src/it's.rs"] }
const UNIT = { root: 'crates/core', channel: '/tmp/ch', tag: 'u1-r2', kind: RUST_UNITS }

test('scout prompts render as before', () => {
  for (const [rn, r] of Object.entries(RUNS)) for (const [sn, s] of Object.entries(SCOPES)) for (const p of Object.values(PROFILES)) {
    expect(makeLensPrompts(/** @type {any} */ (r), s).scoutPrompt(p)).toMatchSnapshot(`scout ${p.id} ${rn} ${sn}`)
  }
})

/** Every run, round and plan, named. @returns {Array<[string, ReturnType<typeof makeLensPrompts>, string, any]>} */
function combinations() {
  /** @type {Array<[string, ReturnType<typeof makeLensPrompts>, string, any]>} */
  const out = []
  for (const [rn, r] of Object.entries(RUNS)) for (const [sn, s] of Object.entries(SCOPES)) for (const [pn, plan] of Object.entries(PLANS)) {
    out.push([`${rn} ${sn} ${pn}`, makeLensPrompts(/** @type {any} */ (r), s), pn, plan])
  }
  return out
}

// Every lens once, sliced and confined too; the run, round and plan variations over the lenses whose text they change.
const VARIED = new Set(['safety', 'maintainability', 'injection', 'negative-space'])
const EVERY = 'full based rich'
test('lens prompts render as before', () => {
  for (const [combo, { lensPrompt }, , plan] of combinations()) for (const p of Object.values(PROFILES)) {
    for (const lens of [...p.lenses, 'negative-space'].filter(l => combo === EVERY || VARIED.has(l))) {
      const tag = `${p.id} ${lens} ${combo}`
      expect(lensPrompt(lens, PRIOR_SUMMARY, p, plan)).toMatchSnapshot(`lens ${tag}`)
      if (combo !== EVERY) continue
      expect(lensPrompt(lens, '', p, plan, SLICE)).toMatchSnapshot(`lens slice ${tag}`)
      expect(lensPrompt(lens, PRIOR_SUMMARY, p, plan, SLICE, UNIT)).toMatchSnapshot(`lens unit ${tag}`)
    }
  }
})

test('extra lens prompts render as before', () => {
  for (const [rn, r] of Object.entries(RUNS)) for (const [sn, s] of Object.entries(SCOPES)) {
    const { extraLensPrompt } = makeLensPrompts(/** @type {any} */ (r), s)
    expect(extraLensPrompt('reviewer', PRIOR_SUMMARY, ['AGENTS.md', 'CLAUDE.md'])).toMatchSnapshot(`extra ${rn} ${sn}`)
    expect(extraLensPrompt('reviewer', '')).toMatchSnapshot(`extra bare ${rn} ${sn}`)
  }
})

test('the judgement schemas are as before', () => {
  const all = {
    FINDING_ITEM: schemas.FINDING_ITEM, SCOUT_SCHEMA: schemas.SCOUT_SCHEMA,
    GATE_SCHEMA: schemas.GATE_SCHEMA, FINDINGS_SCHEMA: schemas.FINDINGS_SCHEMA, VERDICT_SCHEMA: schemas.VERDICT_SCHEMA,
    CRITIC_SCHEMA: schemas.CRITIC_SCHEMA, ADJUDICATE_SCHEMA: schemas.ADJUDICATE_SCHEMA, ATTACK_SCHEMA: schemas.ATTACK_SCHEMA,
    UNIT_FINDINGS_SCHEMA: unitSchemas.UNIT_FINDINGS_SCHEMA, SEAM_SCHEMA: unitSchemas.SEAM_SCHEMA,
    MATCH_JUDGE_SCHEMA, RULE_JUDGE_SCHEMA,
  }
  for (const [name, s] of Object.entries(all)) expect(JSON.stringify(s, null, 1)).toMatchSnapshot(name)
})
test('the schemas the engine builds inside its phases are as before', () => {
  for (const [name, s] of Object.entries({ BATCH_VERDICT_SCHEMA: batchVerdictSchema, DEDUP_SCHEMA: dedupSchema })) expect(JSON.stringify(s, null, 1)).toMatchSnapshot(name)
})

const FINDINGS = [
  { severity: 'High', title: 'lock held across await', file: 'src/a.rs', line: 12, why: 'deadlock **under** load', source: 'concurrency', ruleId: 'CON-002', whereChecked: 'src/b.rs:40 the caller', harmLevel: 'outage', harm: 'the service hangs; every client; operator restart' },
  { severity: 'Medium', title: 'repo rule broken', file: '', line: 0, why: 'violates the rule', source: 'clippy', ruleId: '', whereChecked: '', harmLevel: 'repo-rule', harm: 'rule broken', repoRule: { file: 'AGENTS.md', text: 'never unwrap' } },
  { severity: 'Low', title: 'two harms', file: 'src/c.rs', line: 3, why: 'w', source: 'errors', harmClaims: [{ harmLevel: 'data-loss', harm: 'rows lost' }, { harmLevel: 'text', harm: '' }] },
]
test('verifier prompts render as before', () => {
  for (const p of Object.values(PROFILES)) for (const [i, f] of FINDINGS.entries()) {
    expect(verifyPrompt(f, i, false, '', p)).toMatchSnapshot(`verify ${p.id} ${i}`)
    expect(verifyPrompt(f, i, true, 'clippy via CI #12\nlocal', p, 'SHARED EXCLUSIONS: read x.\n', 'EXTERNAL SOURCES: y\n')).toMatchSnapshot(`verify tool ${p.id} ${i}`)
  }
  for (const p of Object.values(PROFILES)) {
    expect(batchVerifyPrompt(FINDINGS, p)).toMatchSnapshot(`batch ${p.id}`)
    expect(batchVerifyPrompt(FINDINGS.slice(0, 1), p, 'EXTERNAL SOURCES: y\n')).toMatchSnapshot(`batch sources ${p.id}`)
  }
})
