// The Rust profile the CLI reads as data (content/profiles/rust.json, cli/crates/craft-review/src/profile.rs) held to the
// engine's own (PROFILES.rust in lib/review-profiles.mjs and the lens rosters beside it), and the CLI's planner
// (cli/crates/craft-review/src/plan.rs) held to this engine's by content/parity/plan-cases.json, which both sides read.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import profile from '../content/profiles/rust.json' with { type: 'json' }
import planCases from '../content/parity/plan-cases.json' with { type: 'json' }
import { PROFILES } from './review-profiles.mjs'
import { CONDITIONAL_LENSES, OPTIONAL_LENSES, SURFACE_GATED_LENSES } from './review-lens-tallies.mjs'
import { WHOLE_DIFF_LENSES } from './lens-scope.mjs'
import { makePlanner } from './review-plan.mjs'
import { contentText } from './content.mjs'

const rust = /** @type {import('./review-profiles.mjs').Profile} */ (PROFILES['rust'])
const all = [...profile.lenses, ...profile.floorLenses]
/** @param {string} name */
const prompt = name => contentText(readFileSync(new URL(`../content/prompts/${name}.md`, import.meta.url), 'utf8'))

/**
 * The plan this engine builds for one case, in the fields the CLI's plan carries.
 * @param {{ changedFiles: string[], scout: unknown, light?: boolean }} c
 */
function enginePlan(c) {
  /** @type {Set<string>} */
  const lightSkippedLenses = new Set()
  const reviewRun = /** @type {import('./review-run.mjs').ReviewRun} */ (/** @type {unknown} */ ({
    intentArg: '', strict: false, lightPass: c.light === true, lightSkippedLenses, lightKeptLenses: new Set(), optionalRequested: [], sb: { log: () => {} },
  }))
  const scout = /** @type {import('./review-schemas.mjs').ScoutAnswer | null} */ (c.scout)
  const planner = makePlanner(reviewRun, { spec: 'feat: x', changedFiles: c.changedFiles })
  const { plan, surfaceDropped } = planner.planFromScout(rust, scout)
  planner.applyLightProfile(rust, scout, plan)
  return {
    sizeBucket: plan.sizeBucket, lenses: plan.lenses, maxRounds: plan.maxRounds, verifyVotes: plan.verifyVotes, lensModel: plan.lensModel,
    isLibrary: plan.isLibrary, securitySensitive: plan.securitySensitive, intent: plan.intent, churn: plan.churn, repoRules: plan.repoRules,
    surfaceDropped, lightSkipped: [...lightSkippedLenses],
  }
}

test('the profile\'s roster is the engine\'s, lens by lens and brief by brief', () => {
  assert.deepEqual(profile.lenses.map(l => l.id), rust.lenses)
  assert.deepEqual(all.map(l => l.id).sort(), Object.keys(rust.lensBrief).sort(), 'every brief the engine carries, the floors included')
  for (const l of all) assert.equal(prompt(l.brief), rust.lensBrief[l.id], `the brief of ${l.id}`)
  assert.equal(prompt(profile.scoutRules), rust.scoutRules)
})

test('the profile\'s fields and flags are the engine\'s', () => {
  const same = /** @type {const} */ (['id', 'lang', 'diffGlobs', 'rubricSkill', 'fpRules', 'navSkill', 'securityHints', 'usesLibrary', 'alwaysLenses', 'safetyLens', 'rollupRuleIds'])
  for (const k of same) assert.deepEqual(profile[k], rust[k], k)
  const flagged = (/** @type {(l: typeof all[number]) => unknown} */ f) => all.filter(f).map(l => l.id).sort()
  assert.deepEqual(flagged(l => 'optional' in l && l.optional), [...OPTIONAL_LENSES].sort())
  assert.deepEqual(flagged(l => 'conditional' in l && l.conditional), [...CONDITIONAL_LENSES].sort())
  assert.deepEqual(flagged(l => 'wholeDiff' in l && l.wholeDiff), [...WHOLE_DIFF_LENSES].sort())
  assert.deepEqual(Object.fromEntries(all.filter(l => 'surface' in l).map(l => [l.id, 'surface' in l ? l.surface : ''])), SURFACE_GATED_LENSES)
  const detect = profile.detect
  for (const f of ['src/a.rs', 'Cargo.toml', 'a/Cargo.toml', 'a.rsx', 'Cargo.lock', 'xCargo.toml']) {
    const cli = detect.suffixes.some(s => f.endsWith(s)) || detect.names.includes(f.split('/').pop() ?? '')
    assert.equal(cli, rust.detect([f]), f)
  }
})

for (const c of planCases.cases) {
  test(`plan parity: ${c.name}`, () => {
    const got = enginePlan(c)
    assert.deepEqual(got, c.expected)
    for (const l of got.lenses) assert.equal(all.find(x => x.id === l)?.model, got.lensModel, `the model of ${l}`)
  })
}
