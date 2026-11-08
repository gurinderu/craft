// The prompts the Rust CLI renders (cli/crates/craft-review/src/prompts/) held to this engine's own by one shared file,
// content/parity/prompt-cases.json, which cli/crates/craft-review/src/prompts/parity.rs reads too: the inputs, and the
// scout, lens, negative-space and dedup prompts of the Rust and Nix profiles, the ALREADY-FOUND list this engine
// renders from them, a re-review round's scout and lens (the fix commits, and a full re-scan), the adjudicator of a
// prior finding and the carry-check of one its author set aside, strict mode's scout and maintainability lens, and the
// memory recall's prompt, the external sources' blocks with the reconciler lens that reads them, the memory's match and
// rule judges over their record–finding pairs, the red team on a resolved High prior, the verifiers of a gate tool's
// seed and of a lens finding told how the gate ran, and the complexity lens with its index warm-up and its metric
// verifier (adversarial-review's, the general profile's in the CLI), the completeness critic with a follow-up lens it
// admitted, and a consumer's own agent run as an extra lens. A changed
// template fails both sides until the file is regenerated: `UPDATE_PROMPT_PARITY=1 npx vitest run lib/review-prompt-parity.test.mjs`.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { makeLensPrompts } from './review-lens-prompts.mjs'
import { makeDedup } from './review-dedup.mjs'
import { priorFoundSummary } from './review-coverage.mjs'
import { PROFILES } from './review-profiles.mjs'
import { adjudicatePrompt, carryPrompt, redTeamPrompt } from './review-adjudicate-priors.mjs'
import { judgePrompt } from './prior-decision-match.mjs'
import { ruleJudgePrompt } from './project-rule-judge.mjs'
import { memoryRecallPrompt } from './memory-recall.mjs'
import { EXTERNAL_LENSES } from './review-external-sources.mjs'
import { lensSourcesBlock, verifySourcesBlock } from './external-source-text.mjs'
import { verifyPrompt } from './review-verify.mjs'
import { complexityPrompt, METRIC_VERIFY, INDEX_WARMUP } from './adversarial-lenses.mjs'
import { sharedExclusionsLine } from './review-rules-refs.mjs'
import { criticPrompt, criticPrior } from './review-critic.mjs'

const FILE = new URL('../content/parity/prompt-cases.json', import.meta.url)
const rust = /** @type {import('./review-profiles.mjs').Profile} */ (PROFILES['rust'])
const nix = /** @type {import('./review-profiles.mjs').Profile} */ (PROFILES['nix'])

const INPUT = {
  base: 'origin/main',
  craftRoot: '/craft',
  craftVersion: '9.9.9',
  plan: { sizeBucket: 'medium', intent: 'add f, which never fails', spec: 'feat: add f\n\nIt never fails.', churn: ['src/lib.rs'], repoRules: ['AGENTS.md'] },
  pool: [
    { severity: 'Low', title: 'naming\nis off', file: 'src/lib.rs', line: 3, why: 'w', source: 'errors' },
    { severity: 'High', title: 'f returns 1', file: 'src/lib.rs', line: 1, why: 'x'.repeat(200), source: 'intent' },
    { severity: 'Medium', title: 'no doc', file: '', line: 0, why: 'y', source: 'tests' },
  ],
  lenses: ['reconciler', 'tests', 'intent', 'negative-space'],
  nixLenses: ['purity', 'intent', 'negative-space'],
  // The paths the memory recall is asked for.
  recallPaths: ['src/lib.rs', 'flake.nix'],
  // A re-review round: the prior round's head the delta is measured from, and a prior finding it adjudicates.
  priorHead: '0123456789abcdef0123456789abcdef01234567',
  prior: {
    fp: 'f00d', file: 'src/lib.rs', line: 7, symbol: '', severity: 'High', tier: 'confirmed', disposition: 'open', source: 'errors',
    ruleId: 'RS-ERR-1', title: 'f panics\non empty input', why: 'unwrap on `None` — also reported at src/lib.rs:9: a second panic — (+2 more report(s) at this site) — fix incomplete: the guard checks <0> only',
  },
  // The integration points' sources a run prepared: the lenses of EXTERNAL_LENSES and every verifier read them.
  sources: [
    { system: 'kube-ovn', ref: 'v1.13.2', dir: '/cache/github.com/kubeovn/kube-ovn@v1.13.2' },
    { system: 'linstor', ref: '0123456789abcdef0123456789abcdef01234567', dir: '/cache/github.com/LINBIT/linstor-server@0123456789abcdef0123456789abcdef01234567' },
  ],
  // The match judge's record–finding pairs: a decision and a deferred question, model text with newlines, runs of
  // spaces, quotes and a body past the judge's bound; a gate tool's finding naming its rule.
  judgePairs: [
    {
      record: { kind: 'decision', id: 'decision-0123456789', title: 'unwrap on a\nchecked   value', scope: 'src/lib.rs', line: 10, lens: 'errors', toolRule: '' },
      finding: { severity: 'Medium', title: ' unwrap of "x" ', file: 'src/lib.rs', line: 12, source: 'errors', sources: ['errors', 'tests'], why: `${'w '.repeat(450)}end` },
    },
    {
      record: { kind: 'question', id: 'question-0123456789', title: 'retry budget', scope: 'src', line: 0, lens: '', toolRule: 'clippy::needless_pass_by_value' },
      finding: { severity: 'Low', title: 'retry budget is unbounded', file: 'src/net.rs', line: 0, source: 'clippy', toolRule: 'clippy::needless_pass_by_value', why: 'é — ü <tag>' },
    },
  ],
  // The rule judge's pairs: a project rule narrowed to a lens, and one over the whole repository.
  rulePairs: [
    {
      rule: { kind: 'rule', id: 'rule-0123456789', title: 'we do not support\nrollback', scope: '.', lens: 'compat, errors' },
      finding: { severity: 'High', title: 'no rollback path', file: 'src/lib.rs', line: 3, source: 'compat', why: 'a failed upgrade cannot go back' },
    },
    {
      rule: { kind: 'rule', id: 'rule-9876543210', title: 'tests may unwrap', scope: 'tests', lens: '' },
      finding: { severity: 'Low', title: 'unwrap in a test', file: 'tests/a.rs', line: 9, source: 'errors', why: '' },
    },
  ],
  // The adjudicator's answer the red team attacks INPUT.prior under: its invariant, flattened.
  redTeam: { status: 'resolved', invariant: 'the guard\nholds for <every> input', attack: '' },
  // A gate tool's seed and the gate's provenance: its verifier refutes it only by running the tool again, and every
  // verifier of the profile is told how the gate ran its tools.
  gateSeed: { severity: 'High', title: 'a query built from `input`', file: 'src/lib.rs', line: 4, why: 'semgrep reports it', source: 'semgrep', toolRule: 'semgrep.sql', ruleId: '', whereChecked: '' },
  gateProvenance: '`cargo clippy --manifest-path Cargo.toml --all-targets`: pass · `semgrep scan --json --metrics=off --quiet --config .semgrep`: 1 result(s)',
}

/** The adjudicator's `resolved` answer naming `invariant`. @param {string} invariant @returns {import('./review-schemas.mjs').AdjudicateAnswer} */
const adjudicated = invariant => ({ status: 'resolved', currentLine: 0, note: '', invariant, attack: '' })

/** What this engine renders for INPUT. */
async function rendered() {
  const reviewRun = /** @type {import('./review-run.mjs').ReviewRun} */ (/** @type {unknown} */ ({
    craftVersion: INPUT.craftVersion, intentArg: '', pathArg: '', craftRootArg: INPUT.craftRoot, strict: false, sources: { lensBlock: () => '' },
  }))
  const prompts = makeLensPrompts(reviewRun, { lensBase: INPUT.base, priorRound: null, fullRescan: false })
  const plan = /** @type {import('./review-plan.mjs').Plan} */ (/** @type {unknown} */ (INPUT.plan))
  const prior = priorFoundSummary(INPUT.pool)
  const shared = sharedExclusionsLine(INPUT.craftRoot, INPUT.craftVersion)
  /** @type {string[]} */
  const asked = []
  const dedupRun = /** @type {import('./review-run.mjs').ReviewRun} */ (/** @type {unknown} */ ({
    SEV_RANK: { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 }, dedupComponents: null, sb: { log: () => {} },
    ragent: async (/** @type {string} */ p) => { asked.push(p); return { groups: [] } },
  }))
  await makeDedup(dedupRun).dedupPool(/** @type {import('./review-schemas.mjs').Finding[]} */ (/** @type {unknown} */ (INPUT.pool)), rust)
  const rereview = (/** @type {string} */ lensBase, /** @type {boolean} */ fullRescan) => {
    const p = makeLensPrompts(reviewRun, { lensBase, priorRound: /** @type {never} */ ({ round: 1, head: INPUT.priorHead }), fullRescan })
    return { scout: p.scoutPrompt(rust), errors: p.lensPrompt('errors', prior, rust, plan) }
  }
  // The prepared sources: the reconciler lens reads them, the tests lens does not.
  const lensBlock = lensSourcesBlock(INPUT.sources)
  const sourced = makeLensPrompts(/** @type {typeof reviewRun} */ ({ ...reviewRun, sources: { lensBlock: (/** @type {string} */ l) => (EXTERNAL_LENSES.includes(l) ? lensBlock : '') } }), { lensBase: INPUT.base, priorRound: null, fullRescan: false })
  // Strict mode: the scout always picks maintainability, and the maintainability lens reads its strict brief.
  const strictPrompts = makeLensPrompts(/** @type {typeof reviewRun} */ ({ ...reviewRun, strict: true }), { lensBase: INPUT.base, priorRound: null, fullRescan: false })
  return {
    prior,
    sources: { lens: lensBlock, verify: verifySourcesBlock(INPUT.sources), reconciler: sourced.lensPrompt('reconciler', prior, rust, plan), tests: sourced.lensPrompt('tests', prior, rust, plan) },
    strict: { scout: strictPrompts.scoutPrompt(rust), maintainability: strictPrompts.lensPrompt('maintainability', prior, rust, plan) },
    memoryRecall: { paths: memoryRecallPrompt(INPUT.recallPaths, INPUT.base), none: memoryRecallPrompt([], INPUT.base) },
    rereview: { fixes: rereview(INPUT.priorHead, false), rescan: rereview(INPUT.base, true) },
    adjudicate: adjudicatePrompt(INPUT.prior, rust.rubricSkill),
    carry: carryPrompt({ ...INPUT.prior, disposition: 'rejected', file: "src/it's.rs" }, INPUT.priorHead),
    redTeam: { invariant: redTeamPrompt(INPUT.prior, adjudicated(INPUT.redTeam.invariant)), fallback: redTeamPrompt(INPUT.prior, adjudicated('')) },
    matchJudge: judgePrompt(/** @type {never} */ (INPUT.judgePairs.map(p => ({ d: p.record, f: p.finding })))),
    ruleJudge: ruleJudgePrompt(/** @type {never} */ (INPUT.rulePairs.map(p => ({ r: p.rule, f: p.finding })))),
    scout: prompts.scoutPrompt(rust),
    lenses: Object.fromEntries(INPUT.lenses.map(l => [l, prompts.lensPrompt(l, prior, rust, plan)])),
    dedup: asked[0] ?? '',
    complexity: { lens: complexityPrompt(`\`${INPUT.base}\``), verify: METRIC_VERIFY, warmup: INDEX_WARMUP },
    verify: {
      tool: verifyPrompt(INPUT.gateSeed, 0, true, INPUT.gateProvenance, rust, shared, ''),
      lens: verifyPrompt(/** @type {import('./review-schemas.mjs').Finding} */ (INPUT.pool[1]), 1, false, INPUT.gateProvenance, rust, shared, ''),
    },
    // The completeness critic over the Rust plan of INPUT.lenses, a follow-up lens it admitted, and a consumer's own
    // agent run as an extra lens.
    critic: {
      prompt: criticPrompt({ lang: rust.lang, baseRef: INPUT.base, lenses: INPUT.lenses, confirmed: 1, suspected: 2, candidates: rust.lenses.filter(l => !INPUT.lenses.includes(l)) }),
      followup: prompts.lensPrompt('errors', criticPrior(INPUT.pool.length), rust, plan),
    },
    extraLens: prompts.extraLensPrompt('reviewer', prior, INPUT.plan.repoRules),
    nix: {
      scout: prompts.scoutPrompt(nix),
      lenses: Object.fromEntries(INPUT.nixLenses.map(l => [l, prompts.lensPrompt(l, prior, nix, plan)])),
    },
  }
}

test('the prompts the CLI is held to are the ones this engine renders', async () => {
  const expected = await rendered()
  if (process.env['UPDATE_PROMPT_PARITY']) writeFileSync(FILE, `${JSON.stringify({ input: INPUT, expected }, null, 2)}\n`)
  const file = JSON.parse(readFileSync(FILE, 'utf8'))
  assert.deepEqual(file.input, INPUT, 'the inputs both sides render')
  assert.deepEqual(file.expected, expected, 'regenerate with UPDATE_PROMPT_PARITY=1 after a template change')
})
