// Structural lint of the generic review engine (src/review.js, shipped as workflows/review.js).
//
// The engine's static registry is real code the tests import: `meta` from the engine source itself (a module in
// the bundled form: its imports, `export const meta`, then the body inside `__run`, which importing never runs),
// `PROFILES` and the schemas from the lib/ modules the engine imports them from. Then we assert the invariants
// that keep the lens catalog coherent and the engine project-agnostic. This is the guard that would have caught,
// mechanically:
//   - a new lens id added to `lenses[]` but not `lensBrief` (or vice-versa),
//   - an `alwaysLenses` / `safetyLens` pointing at a non-existent lens,
//   - a declared `meta.phase` that is never entered,
//   - a project-specific noun leaking into a generic lens brief (the vodopad-term leak).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as profiles from './review-profiles.mjs'
import * as schemas from './review-schemas.mjs'
import { engineCode } from './engine-harness.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reviewPath = path.join(root, 'src', 'review.js')
// The engine's code: src/review.js with the lib/ modules it uses, its phases among them.
const src = engineCode('review')
// Imported by its path at run time, not by a literal specifier: the engine is checked as a sandbox body by
// check:types:workflows, and a static import would pull it into lib's own program, where those globals are absent.
/** @type {{ meta: { phases: { title: string }[] } }} */
const { meta } = await import(pathToFileURL(reviewPath).href)
// Read as plain data, field by field, not at the engine's own types.
/** @type {any} */
const { PROFILES } = profiles
/** @type {any} */
const { ADJUDICATE_SCHEMA, ATTACK_SCHEMA } = schemas

// Tokens that must never appear literally in a generic lens brief or scoutRules. All are
// unambiguous project-specific field names or scoped nouns a project-AGNOSTIC engine has no
// business naming (it should describe the category instead). Extend this list as new leaks surface.
const FORBIDDEN = [
  /vodopad/i,
  /security_group/i,
  /assigned_ips/i,
  /static_ips/i,
  /effective_vcpu/i,
  /cpu_?allocation_?ratio/i,
  /\bvpc\b/i,
  /\bcidr\b/i,
]

test('meta.phases is present and every declared phase is actually used', () => {
  assert.ok(Array.isArray(meta.phases) && meta.phases.length > 0, 'meta.phases should be a non-empty array')
  // A phase is "used" either by a `phase('X')` call (in lib/, the phase modules call it as `enterPhase`, the
  // sandbox's phase() handed in) or by an agent opt `phase: 'X'` (the gate/verify stages assign their group that
  // way rather than calling phase()). Read over the engine's code: src/review.js and the lib/ modules it uses.
  const code = engineCode('review')
  const used = new Set([
    ...[...code.matchAll(/\b(?:phase|enterPhase)\(\s*'([^']+)'\s*\)/g)].map(m => m[1]),
    ...[...code.matchAll(/\bphase:\s*'([^']+)'/g)].map(m => m[1]),
  ])
  for (const p of meta.phases) {
    assert.ok(used.has(p.title), `meta.phase "${p.title}" is declared but never used (no phase('${p.title}') call and no \`phase: '${p.title}'\` opt)`)
  }
})

test('at least the rust and nix profiles exist', () => {
  assert.ok(PROFILES.rust, 'rust profile missing')
  assert.ok(PROFILES.nix, 'nix profile missing')
})

for (const [id, profile] of Object.entries(PROFILES)) {
  test(`[${id}] every lens has a brief, and every brief (except negative-space) is a real lens`, () => {
    const lenses = new Set(profile.lenses)
    const briefs = new Set(Object.keys(profile.lensBrief))
    assert.ok(profile.lenses.length > 0, `[${id}] lenses[] is empty`)
    for (const l of profile.lenses) {
      assert.ok(briefs.has(l), `[${id}] lens "${l}" is in lenses[] but has no lensBrief entry`)
    }
    for (const b of briefs) {
      // negative-space is invoked via negativeSpacePrompt, intentionally NOT in lenses[].
      if (b === 'negative-space') continue
      assert.ok(lenses.has(b), `[${id}] lensBrief has "${b}" but it is not in lenses[]`)
    }
  })

  test(`[${id}] alwaysLenses and safetyLens point at real lenses`, () => {
    for (const l of (profile.alwaysLenses || [])) {
      assert.ok(profile.lenses.includes(l), `[${id}] alwaysLens "${l}" is not in lenses[]`)
    }
    assert.ok(
      profile.lenses.includes(profile.safetyLens),
      `[${id}] safetyLens "${profile.safetyLens}" is not in lenses[]`,
    )
  })

  test(`[${id}] no project-specific nouns leak into lens briefs / scoutRules (engine stays generic)`, () => {
    const texts = [
      ...Object.entries(profile.lensBrief).map(([k, v]) => [`lensBrief.${k}`, v]),
      ['scoutRules', profile.scoutRules],
    ]
    for (const [where, text] of texts) {
      for (const re of FORBIDDEN) {
        assert.ok(
          !re.test(String(text ?? '')),
          `[${id}] ${where} contains the project-specific token /${re.source}/ — the review engine is generic; describe the category, not the concrete project noun`,
        )
      }
    }
  })

}

test('no project-specific nouns anywhere in review.js source (adjudicator/red-team prompts included)', () => {
  // An absence pin: the engine's source with every lib/ module it uses, where its prompts live too.
  const code = engineCode('review')
  for (const re of FORBIDDEN) {
    assert.ok(
      !re.test(code),
      `workflows/review.js contains the project-specific token /${re.source}/ — the review engine is generic; describe the category, not the concrete project noun`,
    )
  }
})

test('adjudicate track: schema forces the invariant→attack method; red-team is wired', () => {
  for (const field of ['invariant', 'attack']) {
    assert.ok(
      ADJUDICATE_SCHEMA.required.includes(field),
      `ADJUDICATE_SCHEMA must require "${field}" — optional fields let the model skip the fix-completeness steps`,
    )
  }
  assert.deepEqual(
    ATTACK_SCHEMA.required, ['defeated', 'attack'],
    'ATTACK_SCHEMA must require exactly defeated+attack',
  )
  assert.ok(
    /label: `redteam:/.test(src),
    'expected a red-team agent dispatch (label `redteam:<file>:<line>`) in the adjudicate track',
  )
  // Both schemas set additionalProperties:false, so a required field missing from `properties`
  // makes the schema UNSATISFIABLE: every adjudicator/red-team call returns null, and review.js
  // maps null to permanent still-open for every prior — while this lint would stay green.
  for (const [name, schema] of [['ADJUDICATE_SCHEMA', ADJUDICATE_SCHEMA], ['ATTACK_SCHEMA', ATTACK_SCHEMA]]) {
    for (const field of schema.required) {
      assert.ok(
        field in schema.properties,
        `${name} requires "${field}" but does not define it in properties — with additionalProperties:false the schema is unsatisfiable and every agent call returns null (review.js maps that to permanent still-open)`,
      )
    }
  }
  assert.deepEqual(
    ADJUDICATE_SCHEMA.properties.status.enum, ['resolved', 'still-open', 'cannot-tell', 'regressed'],
    'ADJUDICATE_SCHEMA.status enum drifted — adjudicateOne in review.js branches on these values by name',
  )
})

test('rust-review rules.md catalog IDs are unique', () => {
  const md = fs.readFileSync(path.join(root, 'skills', 'rust-review', 'rules.md'), 'utf8')
  const ids = [...md.matchAll(/\*\*([A-Z]{2,4}-\d{3})\*\*/g)].map(m => m[1])
  assert.ok(ids.length > 0, 'expected catalog rule IDs like **INV-001** in rules.md')
  const seen = new Set()
  const dupes = new Set()
  for (const x of ids) (seen.has(x) ? dupes : seen).add(x)
  assert.equal(dupes.size, 0, `duplicate rule IDs in rules.md: ${[...dupes].join(', ')}`)
})
