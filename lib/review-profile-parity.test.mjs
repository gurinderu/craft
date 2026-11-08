// The Rust and Nix profiles the CLI reads as data (content/profiles/<id>.json, cli/crates/craft-review/src/profile.rs) held
// to the engine's own (PROFILES in lib/review-profiles.mjs and the lens rosters beside it), and the CLI's planner
// (cli/crates/craft-review/src/plan.rs) held to this engine's by content/parity/plan-cases.json, a golden file the CLI
// owns (cli/crates/craft-review/src/golden.rs) and both sides read. A case names its profile (`rust` when it names
// none); after a planner change regenerate the expected plans: `CRAFT_UPDATE_PARITY=1 cargo test -p craft-review parity`
// in cli/, or `UPDATE_PLAN_PARITY=1 npx vitest run lib/review-profile-parity.test.mjs` — both write the same file.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import rustProfile from '../content/profiles/rust.json' with { type: 'json' }
import nixProfile from '../content/profiles/nix.json' with { type: 'json' }
import planCases from '../content/parity/plan-cases.json' with { type: 'json' }
import { PROFILES } from './review-profiles.mjs'
import { CONDITIONAL_LENSES, OPTIONAL_LENSES, SURFACE_GATED_LENSES } from './review-lens-tallies.mjs'
import { WHOLE_DIFF_LENSES } from './lens-scope.mjs'
import { makePlanner } from './review-plan.mjs'
import { contentText, render } from './content.mjs'
import { RUST_UNITS } from './rust-units.mjs'

/** @typedef {import('./review-profiles.mjs').Profile} Profile @typedef {typeof rustProfile | typeof nixProfile} DataProfile */

const PLAN_FILE = new URL('../content/parity/plan-cases.json', import.meta.url)
/** The profiles the CLI shares with this engine, each as data and as the engine holds it. */
const SHARED = /** @type {Array<[DataProfile, Profile, string[]]>} */ ([
  [rustProfile, /** @type {Profile} */ (PROFILES['rust']), ['src/a.rs', 'Cargo.toml', 'a/Cargo.toml', 'a.rsx', 'Cargo.lock', 'xCargo.toml']],
  [nixProfile, /** @type {Profile} */ (PROFILES['nix']), ['a.nix', 'nix/b.nix', 'flake.lock', 'a/flake.lock', 'a.nixx', 'flake.lockx', 'x.rs']],
])
/** @param {string} name */
const prompt = name => contentText(readFileSync(new URL(`../content/prompts/${name}.md`, import.meta.url), 'utf8'))

/**
 * The plan this engine builds for one case, in the fields the CLI's plan carries.
 * @param {{ profile?: string, changedFiles: string[], scout: unknown, light?: boolean, strict?: boolean }} c
 */
function enginePlan(c) {
  const profile = /** @type {Profile} */ (PROFILES[c.profile ?? 'rust'])
  /** @type {Set<string>} */
  const lightSkippedLenses = new Set()
  const reviewRun = /** @type {import('./review-run.mjs').ReviewRun} */ (/** @type {unknown} */ ({
    intentArg: '', strict: c.strict === true, lightPass: c.light === true, lightSkippedLenses, lightKeptLenses: new Set(), optionalRequested: [], sb: { log: () => {} },
  }))
  const scout = /** @type {import('./review-schemas.mjs').ScoutAnswer | null} */ (c.scout)
  const planner = makePlanner(reviewRun, { spec: 'feat: x', changedFiles: c.changedFiles })
  const { plan, surfaceDropped } = planner.planFromScout(profile, scout)
  planner.applyLightProfile(profile, scout, plan)
  return {
    sizeBucket: plan.sizeBucket, lenses: plan.lenses, maxRounds: plan.maxRounds, verifyVotes: plan.verifyVotes, lensModel: plan.lensModel,
    isLibrary: plan.isLibrary, securitySensitive: plan.securitySensitive, intent: plan.intent, churn: plan.churn, repoRules: plan.repoRules,
    surfaceDropped, lightSkipped: [...lightSkippedLenses],
  }
}

for (const [data, engine, files] of SHARED) {
  const all = [...data.lenses, ...data.floorLenses]
  /** The ids of the profile's lenses `f` holds for, sorted. @param {(l: typeof all[number]) => unknown} f */
  const flagged = f => all.filter(f).map(l => l.id).sort()
  /** The global lens list `list` as it applies to this profile's lenses, sorted. @param {readonly string[]} list */
  const own = list => list.filter(l => all.some(x => x.id === l)).sort()

  test(`${data.id}: the profile's roster is the engine's, lens by lens and brief by brief`, () => {
    assert.deepEqual(data.lenses.map(l => l.id), engine.lenses)
    assert.deepEqual(all.map(l => l.id).sort(), Object.keys(engine.lensBrief).sort(), 'every brief the engine carries, the floors included')
    for (const l of all) assert.equal(prompt(l.brief), engine.lensBrief[l.id], `the brief of ${l.id}`)
    assert.equal(prompt(data.scoutRules), engine.scoutRules)
    assert.equal(`craft:${data.lensAgent}`, engine.reviewerAgent, 'the lens agent, the host prefix aside')
  })

  test(`${data.id}: the profile's fields and flags are the engine's`, () => {
    const same = /** @type {const} */ (['id', 'lang', 'diffGlobs', 'rubricSkill', 'fpRules', 'navSkill', 'securityHints', 'usesLibrary', 'alwaysLenses', 'safetyLens', 'rollupRuleIds'])
    for (const k of same) assert.deepEqual(data[k], engine[k], k)
    assert.deepEqual(flagged(l => 'optional' in l && l.optional), own(OPTIONAL_LENSES))
    assert.deepEqual(flagged(l => 'conditional' in l && l.conditional), own(CONDITIONAL_LENSES))
    assert.deepEqual(flagged(l => 'wholeDiff' in l && l.wholeDiff), own(WHOLE_DIFF_LENSES))
    const gated = Object.fromEntries(Object.entries(SURFACE_GATED_LENSES).filter(([l]) => all.some(x => x.id === l)))
    assert.deepEqual(Object.fromEntries(all.filter(l => 'surface' in l).map(l => [l.id, 'surface' in l ? l.surface : ''])), gated)
    for (const f of files) {
      const cli = data.detect.suffixes.some(s => f.endsWith(s)) || data.detect.names.includes(f.split('/').pop() ?? '')
      assert.equal(cli, engine.detect([f]), f)
    }
  })
}

test('rust: the words of its units are the engine\'s, and the Nix profile has none', () => {
  const words = rustProfile.units
  assert.deepEqual(
    { ...words, surface: render(words.surface, { root: "'crates/a'" }) },
    { noun: RUST_UNITS.noun, signatures: RUST_UNITS.signatures, surface: RUST_UNITS.surface("'crates/a'"), publicItems: RUST_UNITS.publicItems, changedItems: RUST_UNITS.changedItems },
  )
  assert.ok(!('units' in nixProfile))
})

// The cases as the file holds them, regenerated first when asked; each is checked as a test of its own.
if (process.env['UPDATE_PLAN_PARITY']) {
  const cases = planCases.cases.map(c => ({ ...c, expected: enginePlan(c) }))
  writeFileSync(PLAN_FILE, `${JSON.stringify({ cases }, null, 2)}\n`)
}
const fileCases = /** @type {typeof planCases.cases} */ (JSON.parse(readFileSync(PLAN_FILE, 'utf8')).cases)
for (const c of fileCases) {
  test(`plan parity: ${c.name}`, () => {
    const got = enginePlan(c)
    assert.deepEqual(got, c.expected, 'regenerate with UPDATE_PLAN_PARITY=1 after a planner change')
    const data = SHARED.find(([d]) => d.id === ('profile' in c ? c.profile : 'rust'))?.[0]
    const all = data ? [...data.lenses, ...data.floorLenses] : []
    for (const l of got.lenses) assert.equal(all.find(x => x.id === l)?.model, got.lensModel, `the model of ${l}`)
  })
}
