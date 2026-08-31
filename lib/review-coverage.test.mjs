// Coverage-honesty guards for the generic review engine (workflows/review.js).
//
// The invariant under test: a review must never return a verdict that claims more coverage than the
// run actually had. Three ways it used to overclaim:
//   1. no language profile matched the diff → `Approve (NO LANGUAGE)` with zero lenses run,
//   2. an unknown `args.languages` pin was dropped by `filter(Boolean)` → same silent green,
//   3. files no active profile covered were listed in a report section but never touched the verdict.
//
// review.js can't be imported (top-level export + await + return in a sandbox script), so we reuse
// the same trick as review-registry.test.mjs: eval the declarations prefix that ends at the first
// executable `phase('Scout')` and recover the real helper functions. The control-flow that consumes
// them lives past that cut, so it is asserted against the source text instead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'workflows', 'review.js'), 'utf8')

function loadHelpers() {
  const cut = src.indexOf("phase('Scout')")
  assert.ok(cut > 0, "expected a top-level phase('Scout') to mark the end of the declarations prefix")
  const prefix = src.slice(0, cut).replace(/^export const meta/m, 'const meta')
  const stub = () => {}
  const budget = { total: null, spent: () => 0, remaining: () => 0 }
  const factory = new Function(
    'args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow',
    `${prefix}\n;return { PROFILES, supportedLangLabel, resolveProfilePin, unknownPinMessage, noLanguageMessage, materialUncovered, uncoveredNotRunNote };`,
  )
  return factory({}, stub, stub, stub, stub, stub, budget, stub)
}

const H = loadHelpers()

// ---- 1. no profile matched must never yield Approve ----

test('the no-language path is an INCOMPLETE outcome, not an Approve', () => {
  assert.ok(!/Approve \(NO LANGUAGE\)/.test(src), 'the Approve (NO LANGUAGE) verdict must be gone')
  assert.ok(!/✅ Approve — no supported language/.test(src), 'the green no-language report line must be gone')
  assert.ok(
    src.includes(`verdict: 'INCOMPLETE (no language profile)'`),
    'the persisted record for a no-profile run must say INCOMPLETE',
  )
  assert.ok(
    /⚠️ INCOMPLETE — \$\{msg\}/.test(src),
    'the returned report must lead with an INCOMPLETE verdict line built from noLanguageMessage()',
  )
})

test('noLanguageMessage says nothing was reviewed and names the supported languages', () => {
  const msg = H.noLanguageMessage(7)
  assert.match(msg, /NOTHING WAS REVIEWED/)
  assert.match(msg, /7 changed file\(s\)/)
  assert.match(msg, /not an approval/i)
  for (const p of Object.values(H.PROFILES)) assert.ok(msg.includes(p.lang), `should name ${p.lang}`)
})

test('supportedLangLabel is derived from the declared profiles, not hardcoded', () => {
  assert.equal(H.supportedLangLabel(), Object.values(H.PROFILES).map(p => p.lang).join('/'))
})

// ---- 2. an unknown pinned language is an error, not a silent drop ----

test('resolveProfilePin separates known ids from unknown ones instead of dropping them', () => {
  assert.deepEqual(H.resolveProfilePin(null), { pinned: null, unknown: [] })
  assert.deepEqual(H.resolveProfilePin(['rust']), { pinned: ['rust'], unknown: [] })
  assert.deepEqual(H.resolveProfilePin(['rust', 'python', 'go']), { pinned: ['rust'], unknown: ['python', 'go'] })
  assert.deepEqual(H.resolveProfilePin(['python']), { pinned: [], unknown: ['python'] })
})

test('unknownPinMessage names the unknown id and the available ones', () => {
  const msg = H.unknownPinMessage(['python'])
  assert.match(msg, /unknown language pin/)
  assert.match(msg, /`python`/)
  for (const id of Object.keys(H.PROFILES)) assert.ok(msg.includes(`\`${id}\``), `should offer ${id}`)
})

test('an unknown pin stops the run with an INCOMPLETE verdict before any profile work', () => {
  assert.ok(
    !/map\(id => PROFILES\[id\]\)\.filter\(Boolean\)/.test(src),
    'the silent filter(Boolean) drop of unknown pin ids must be gone',
  )
  assert.ok(src.includes(`verdict: 'INCOMPLETE (unknown language pin)'`), 'the record must say INCOMPLETE')
  const pinIdx = src.indexOf('unknownPinMessage(unknownLangs)')
  const activeIdx = src.indexOf('let active = Object.values(PROFILES)')
  assert.ok(pinIdx > 0 && activeIdx > pinIdx, 'the unknown-pin guard must run before profiles are activated')
})

// ---- 3. uncovered files lower the claim ----

test('materialUncovered keeps behaviour-carrying paths and drops docs, assets and lockfiles', () => {
  const material = [
    'migrations/2026-07-01_add_ledger.sql',
    'deploy/helm/templates/rbac.yaml',
    'scripts/release.sh',
    'src/app.ts',
    'lib/review.js',
    'main.go',
    '.github/workflows/ci.yml',
    'Dockerfile',
  ]
  const inert = [
    'README.md',
    'docs/design/notes.markdown',
    'CHANGELOG.txt',
    'LICENSE',
    'NOTICE',
    'CODEOWNERS',
    '.gitignore',
    'assets/logo.svg',
    'assets/shot.png',
    'fonts/inter.woff2',
    'package-lock.json',
    'yarn.lock',
    'Cargo.lock',
    'pnpm-lock.yaml',
    'uv.lock',
  ]
  assert.deepEqual(H.materialUncovered([...material, ...inert]), material)
  // a path that merely ENDS in the letters "lock" is not a lockfile
  assert.deepEqual(H.materialUncovered(['src/unlock.go']), ['src/unlock.go'])
  assert.deepEqual(H.materialUncovered([]), [])
})

test('uncoveredNotRunNote states the count and caps the listing', () => {
  const note = H.uncoveredNotRunNote(['a.sql', 'b.yaml'])
  assert.match(note, /2 changed file\(s\)/)
  assert.match(note, /NOT reviewed/)
  assert.match(note, /a\.sql, b\.yaml/)
  const many = H.uncoveredNotRunNote(['1.sql', '2.sql', '3.sql', '4.sql', '5.sql', '6.sql', '7.sql'])
  assert.match(many, /\+2 more/)
  assert.ok(!many.includes('6.sql'), 'should not list past the cap')
})

test('material uncovered files join notRun, which is what marks a verdict INCOMPLETE', () => {
  assert.ok(
    src.includes('if (uncoveredMaterial.length) notRun.push(uncoveredNotRunNote(uncoveredMaterial))'),
    'uncovered material files must be folded into notRun',
  )
  const pushIdx = src.indexOf('notRun.push(uncoveredNotRunNote(uncoveredMaterial))')
  // Both consumers of notRun that can otherwise print a bare Approve must sit AFTER the push.
  const earlyApprove = src.indexOf('verdict: `Approve${notRun.length ? \' (INCOMPLETE)\' : \'\'}`')
  const recordVerdictIdx = src.indexOf("verdict: recordVerdict + (notRun.length ? ' (INCOMPLETE)' : '')")
  assert.ok(pushIdx > 0, 'expected the notRun push')
  assert.ok(earlyApprove > pushIdx, 'the no-findings Approve must be computed after the push')
  assert.ok(recordVerdictIdx > pushIdx, 'the synthesized record verdict must be computed after the push')
})
