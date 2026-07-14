// Structural lint of the generic review engine (workflows/review.js).
//
// review.js is a sandbox workflow script — it combines a top-level `export`, top-level `await`, and
// top-level `return`, so it can't be `import`ed. But its static registry (`meta`, `PROFILES`) is
// fully defined in the prefix BEFORE the first executable `phase('Scout')`. We slice that prefix,
// strip the lone `export`, stub the sandbox globals, and eval it to recover the REAL objects — no
// brittle regex over the data itself. Then we assert the invariants that keep the lens catalog
// coherent and the engine project-agnostic. This is the guard that would have caught, mechanically:
//   - a new lens id added to `lenses[]` but not `lensBrief` (or vice-versa),
//   - an `alwaysLenses` / `safetyLens` pointing at a non-existent lens,
//   - a declared `meta.phase` that is never entered,
//   - a project-specific noun leaking into a generic lens brief (the vodopad-term leak).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reviewPath = path.join(root, 'workflows', 'review.js')
const src = fs.readFileSync(reviewPath, 'utf8')

function loadRegistry() {
  const cut = src.indexOf("phase('Scout')")
  assert.ok(cut > 0, "expected a top-level phase('Scout') to mark the end of the declarations prefix")
  const prefix = src.slice(0, cut).replace(/^export const meta/m, 'const meta')
  const stub = () => {}
  const budget = { total: null, spent: () => 0, remaining: () => 0 }
  // Only `args` is referenced at top level in the prefix; the other sandbox globals appear solely
  // inside function bodies (never called during this eval). We pass them all so no free identifier
  // is left unresolved. `ragent` and the run-record helpers are DECLARED in the prefix — do not
  // pass them as params or the declaration would clash.
  const factory = new Function(
    'args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow',
    `${prefix}\n;return { meta, PROFILES };`,
  )
  return factory({}, stub, stub, stub, stub, stub, budget, stub)
}

const { meta, PROFILES } = loadRegistry()

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
  // A phase is "used" either by a `phase('X')` call or by an agent opt `phase: 'X'` (the gate/verify
  // stages assign their group that way rather than calling phase()).
  const used = new Set([
    ...[...src.matchAll(/\bphase\(\s*'([^']+)'\s*\)/g)].map(m => m[1]),
    ...[...src.matchAll(/\bphase:\s*'([^']+)'/g)].map(m => m[1]),
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

test('rust-review rules.md catalog IDs are unique', () => {
  const md = fs.readFileSync(path.join(root, 'skills', 'rust-review', 'rules.md'), 'utf8')
  const ids = [...md.matchAll(/\*\*([A-Z]{2,4}-\d{3})\*\*/g)].map(m => m[1])
  assert.ok(ids.length > 0, 'expected catalog rule IDs like **INV-001** in rules.md')
  const seen = new Set()
  const dupes = new Set()
  for (const x of ids) (seen.has(x) ? dupes : seen).add(x)
  assert.equal(dupes.size, 0, `duplicate rule IDs in rules.md: ${[...dupes].join(', ')}`)
})
