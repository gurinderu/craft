// The prompts the Rust CLI renders (cli/crates/craft-review/src/prompts/) held to this engine's own by one shared file,
// content/parity/prompt-cases.json, which cli/crates/craft-review/src/prompts/parity.rs reads too: the inputs, and the
// scout, lens, negative-space and dedup prompts of the Rust and Nix profiles, the ALREADY-FOUND list this engine
// renders from them, a re-review round's scout and lens (the fix commits, and a full re-scan) and the adjudicator of a
// prior finding. A changed
// template fails both sides until the file is regenerated: `UPDATE_PROMPT_PARITY=1 npx vitest run lib/review-prompt-parity.test.mjs`.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { makeLensPrompts } from './review-lens-prompts.mjs'
import { makeDedup } from './review-dedup.mjs'
import { priorFoundSummary } from './review-coverage.mjs'
import { PROFILES } from './review-profiles.mjs'
import { adjudicatePrompt } from './review-adjudicate-priors.mjs'

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
  // A re-review round: the prior round's head the delta is measured from, and a prior finding it adjudicates.
  priorHead: '0123456789abcdef0123456789abcdef01234567',
  prior: {
    fp: 'f00d', file: 'src/lib.rs', line: 7, symbol: '', severity: 'High', tier: 'confirmed', disposition: 'open', source: 'errors',
    ruleId: 'RS-ERR-1', title: 'f panics\non empty input', why: 'unwrap on `None` — also reported at src/lib.rs:9: a second panic — (+2 more report(s) at this site) — fix incomplete: the guard checks <0> only',
  },
}

/** What this engine renders for INPUT. */
async function rendered() {
  const reviewRun = /** @type {import('./review-run.mjs').ReviewRun} */ (/** @type {unknown} */ ({
    craftVersion: INPUT.craftVersion, intentArg: '', pathArg: '', craftRootArg: INPUT.craftRoot, strict: false, sources: { lensBlock: () => '' },
  }))
  const prompts = makeLensPrompts(reviewRun, { lensBase: INPUT.base, priorRound: null, fullRescan: false })
  const plan = /** @type {import('./review-plan.mjs').Plan} */ (/** @type {unknown} */ (INPUT.plan))
  const prior = priorFoundSummary(INPUT.pool)
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
  return {
    prior,
    rereview: { fixes: rereview(INPUT.priorHead, false), rescan: rereview(INPUT.base, true) },
    adjudicate: adjudicatePrompt(INPUT.prior, rust.rubricSkill),
    scout: prompts.scoutPrompt(rust),
    lenses: Object.fromEntries(INPUT.lenses.map(l => [l, prompts.lensPrompt(l, prior, rust, plan)])),
    dedup: asked[0] ?? '',
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
