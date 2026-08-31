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

function loadHelpers(workflowArgs = {}) {
  const cut = src.indexOf("phase('Scout')")
  assert.ok(cut > 0, "expected a top-level phase('Scout') to mark the end of the declarations prefix")
  const prefix = src.slice(0, cut).replace(/^export const meta/m, 'const meta')
  const stub = () => {}
  const budget = { total: null, spent: () => 0, remaining: () => 0 }
  const factory = new Function(
    'args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow',
    `${prefix}\n;return { PROFILES, supportedLangLabel, resolveProfilePin, unknownPinMessage, noLanguageMessage, nothingToReviewMessage, materialUncovered, uncoveredNotRunNote, noChangedFilesMessage, requestedLangs, LOGGER_PATH, LOGGER_PRELUDE, repoArg };`,
  )
  return factory(workflowArgs, stub, stub, stub, stub, stub, budget, stub)
}

// The pin as the RUNNING workflow computes it: `args` in, `resolveProfilePin(requestedLangs)` out.
// Testing the helper in isolation is exactly how an upstream normalizer sat between `args` and the
// helper for a whole release, silently dropping every scalar pin.
function pinFromArgs(languages) {
  const h = loadHelpers({ languages })
  return h.resolveProfilePin(h.requestedLangs)
}

const H = loadHelpers()

// ---- 1. no profile matched must never yield Approve ----

// The four tests below assert against review.js SOURCE TEXT, not behaviour. The control flow they
// guard lives past the declarations cut (it needs `agent`, git and a live budget), so it cannot be
// executed here. What they catch: a literal revert — the old green strings coming back, the silent
// `filter(Boolean)` drop returning, the notRun push moving after its consumers. What they do NOT
// catch: a reworded verdict line, an equivalent expression, or the push being moved behind a new
// condition that never fires. Treat them as tripwires, not as coverage.
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

test('a diff with no material files is "nothing needed reviewing", not "nothing was reviewed"', () => {
  // A no-profile diff of nothing but docs/assets/lockfiles has no coverage hole to report. A marker
  // that fires on ordinary prose-only changes stops being read, which destroys its value elsewhere.
  const msg = H.nothingToReviewMessage(3)
  assert.match(msg, /NOTHING NEEDED REVIEWING/)
  assert.match(msg, /3 changed file\(s\)/)
  assert.ok(!/NOTHING WAS REVIEWED/.test(msg), 'must not reuse the coverage-hole wording')

  // A docs-only / lockfile-only change set has no material remainder at all ...
  assert.deepEqual(H.materialUncovered(['README.md', 'docs/x.md', 'Cargo.lock', 'assets/logo.svg']), [])
  // ... while a diff of unsupported SOURCE still does, and must stay INCOMPLETE.
  assert.deepEqual(H.materialUncovered(['src/app.py', 'README.md']), ['src/app.py'])
})

test('the no-profile early return uses materialUncovered, and only the inert case is green', () => {
  // Source-text tripwire: the branch lives past the declarations cut and cannot be executed here.
  const idx = src.indexOf('const noProfileMaterial = materialUncovered(changedFiles)')
  assert.ok(idx > 0, 'the no-profile early return must classify with materialUncovered')
  const activeIdx = src.indexOf("if (!active.length) {\n")
  assert.ok(activeIdx > 0 && idx > activeIdx, 'it must sit inside the no-profile branch')
  assert.ok(
    src.includes('if (!noProfileMaterial.length) {'),
    'only a change set with NO material files may take the green path',
  )
  // …and the empty-diff case is handled before it, so an empty list never reads as "inert only".
  const emptyIdx = src.indexOf('if (!changedFiles.length) {')
  const greenIdx = src.indexOf('if (!noProfileMaterial.length) {')
  assert.ok(emptyIdx > activeIdx, 'the empty-diff guard must sit inside the no-profile branch')
  assert.ok(emptyIdx < greenIdx, 'and ahead of the inert-only green path, so an empty list is never "inert only"')
  assert.ok(
    src.includes(`verdict: 'Approve (nothing to review)'`),
    'the inert-only run must persist an Approve (nothing to review) record',
  )
  assert.ok(
    src.includes('noLanguageMessage(changedFiles.length, noProfileMaterial.length)'),
    'the real no-profile case must still report INCOMPLETE, with the material count',
  )
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

test('resolveProfilePin never throws on a non-array pin and degrades toward running', () => {
  // `languages` reaches the workflow through an argument transport that is known to hand over a bare
  // string (or a JSON-decoded one). The previous `includes` form tolerated that by accident; a
  // `.filter` call on it threw a TypeError and aborted the entire review.
  assert.deepEqual(H.resolveProfilePin('rust'), { pinned: ['rust'], unknown: [] })
  assert.deepEqual(H.resolveProfilePin('python'), { pinned: [], unknown: ['python'] })
  assert.deepEqual(H.resolveProfilePin(' Rust '), { pinned: ['rust'], unknown: [] })
  assert.deepEqual(H.resolveProfilePin(['RUST']), { pinned: ['rust'], unknown: [] })
  // Unusable shapes must read as "no pin at all", never as a crash and never as an unknown-pin stop.
  for (const bad of [[], {}, 42, ['', '  '], [null], true]) {
    assert.deepEqual(H.resolveProfilePin(bad), { pinned: null, unknown: [] }, `bad pin ${JSON.stringify(bad)}`)
  }
})

test('the pin reaches resolveProfilePin unnormalized, through the path that actually runs', () => {
  // Every case below goes args → requestedLangs → resolveProfilePin, the real chain. An upstream
  // `Array.isArray(A.languages) ? … : null` guard made the first three drop the pin silently, and an
  // upstream `.map(String)` made the last two hard-abort with "unknown language pin".
  assert.deepEqual(pinFromArgs('rust'), { pinned: ['rust'], unknown: [] })
  assert.deepEqual(pinFromArgs(' Rust '), { pinned: ['rust'], unknown: [] })
  assert.deepEqual(pinFromArgs('python'), { pinned: [], unknown: ['python'] })
  assert.deepEqual(pinFromArgs(['rust']), { pinned: ['rust'], unknown: [] })
  // Junk must degrade toward running the review, never toward an unknown-pin abort.
  for (const bad of [undefined, null, [], {}, 42, [null], [7], ['', '  '], true]) {
    assert.deepEqual(pinFromArgs(bad), { pinned: null, unknown: [] }, `junk pin ${JSON.stringify(bad)}`)
  }
  // …and there must be exactly ONE normalizer: the raw arg is handed straight through.
  assert.ok(
    !/const requestedLangs = \(Array\.isArray/.test(src),
    'requestedLangs must not re-normalize the pin upstream of resolveProfilePin',
  )
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
    // Lock-SHAPED source paths. A `*lock.*` pattern classified every one of these as a lockfile and
    // dropped it from the material remainder — the exact silent overclaim these guards exist to stop.
    'migrations/002-lock.sql',
    'db/lock.sql',
    'src/lock.rs',
    'internal/lock.go',
    'internal/spin-lock.go',
    'src/file-lock.py',
    'charts/x/templates/lock.yaml',
    'src/locking.ts',
    // Seed/fixture data a change can break — `.csv` used to be blanket-inert.
    'fixtures/seed_accounts.csv',
    // Generated-LOOKING but hand-written: only an unambiguous path earns the exemption.
    'src/generator.ts',
    'src/snapshot.rs',
    'src/pb.go',
    // `.txt` is NOT inert by extension — build-system and dependency manifests wear it. Blanket
    // `.txt` was the lockfile shape-match bug in another costume: a diff of nothing but these plus a
    // README took the green "nothing needed reviewing" return over a real build change.
    'CMakeLists.txt',
    'requirements.txt',
    'requirements-dev.txt',
    'conanfile.txt',
    'Dependencies.txt',
  ]
  const inert = [
    'README.md',
    'docs/design/notes.markdown',
    'CHANGELOG.txt',
    'LICENSE.txt',
    'robots.txt',
    'docs/notes.txt',
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
    'flake.lock',
    'poetry.lock',
    'Gemfile.lock',
    'composer.lock',
    'go.sum',
    'deno.lock',
    'go/vendor/example.com/x/x.go',
    // Generated artifacts: routine regeneration must not devalue the INCOMPLETE marker.
    'crates/api/tests/snapshots/render.snap',
    'api/service.pb.go',
    'api/service_pb2.py',
    'api/service_pb2_grpc.py',
    'web/static/app.min.js',
    'web/static/app.min.css',
    'src/__generated__/schema.graphql',
    'src/generated/types.ts',
    'lib/model.g.dart',
    'src/api.generated.ts',
    'node_modules/left-pad/index.js',
  ]
  assert.deepEqual(H.materialUncovered([...material, ...inert]), material)
  // a path that merely ENDS in the letters "lock" is not a lockfile
  assert.deepEqual(H.materialUncovered(['src/unlock.go']), ['src/unlock.go'])
  // lockfile names are matched case-insensitively on the basename, wherever they sit
  assert.deepEqual(H.materialUncovered(['sub/crate/Cargo.lock', 'sub/crate/cargo.lock']), [])
  assert.deepEqual(H.materialUncovered([]), [])
  // The regression this replaced: a build-system-only diff must never read as "nothing to review".
  assert.deepEqual(H.materialUncovered(['CMakeLists.txt', 'README.md']), ['CMakeLists.txt'])
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

// The test below asserts against review.js SOURCE TEXT, not behaviour. The control flow it
// guards lives past the declarations cut (it needs `agent`, git and a live budget), so it cannot be
// executed here. What they catch: a literal revert — the old green strings coming back, the silent
// `filter(Boolean)` drop returning, the notRun push moving after its consumers. What they do NOT
// catch: a reworded verdict line, an equivalent expression, or the push being moved behind a new
// condition that never fires. Treat them as tripwires, not as coverage.
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


// ---- 4. the logger path is resolved BEFORE the cd into the reviewed repo ----

test('every logger command resolves its script path before changing directory', () => {
  // `cd <reviewed repo> && node "${CLAUDE_PLUGIN_ROOT:-.}/lib/craft-log-run.mjs"` expanded the `.`
  // fallback AFTER the cd — against the REVIEWED repo, where craft's script is not. Every
  // checkpoint, the finalize record and the prior-round chain died on "Cannot find module", and the
  // first two died silently. The fix: capture an absolute path in a variable, then cd.
  assert.ok(
    !/cd \$\{shq\(repoArg \|\| '\.'\)\} && node "\$\{CLAUDE_PLUGIN_ROOT/.test(src),
    'the logger must not be invoked through a relative fallback after a cd',
  )
  const sites = src.match(/^.*cd \$\{shq\(repoArg \|\| '\.'\)\} && node .*$/gm) || []
  assert.equal(sites.length, 3, 'expected the checkpoint, finalize and prior-round logger commands')
  for (const line of sites) {
    assert.ok(line.startsWith('${LOGGER_PRELUDE}cd '), `logger prelude must precede the cd: ${line}`)
    assert.ok(line.includes('node ${LOGGER_PATH}'), `logger must run via the captured path: ${line}`)
  }

  // And the two emitted shapes themselves: no `.` left to resolve against the reviewed repo.
  const plugin = loadHelpers({ repo: '/other/checkout' })
  assert.equal(plugin.LOGGER_PATH, '"$CRAFT_LOGGER"')
  assert.match(plugin.LOGGER_PRELUDE, /^CRAFT_LOGGER="\$\(cd "\$\{CLAUDE_PLUGIN_ROOT:-\.\}" 2>\/dev\/null && pwd\)\/lib\/craft-log-run\.mjs"\n$/)
  const pinned = loadHelpers({ repo: '/other/checkout', craftRoot: '/opt/craft' })
  assert.equal(pinned.LOGGER_PRELUDE, `CRAFT_LOGGER='/opt/craft'/lib/craft-log-run.mjs\n`)
})


// ---- 5. an empty diff is not a coverage hole of size zero ----

test('a zero-file diff gets its own message, not a hole of size zero', () => {
  // The old path fell through to noLanguageMessage(0, 0): "none of the 0 changed file(s) match a
  // supported language profile … and 0 of them carry reviewable content that therefore went
  // unreviewed" — an assertion about a coverage hole with nothing in it.
  const msg = H.noChangedFilesMessage()
  assert.match(msg, /NOTHING WAS REVIEWED/)
  assert.match(msg, /EMPTY/)
  assert.ok(!/0 changed file\(s\)/.test(msg), 'must not describe a hole of size zero')
  assert.ok(!/0 of them/.test(msg), 'must not claim zero files went unreviewed')
  assert.match(msg, /not an approval/i)

  assert.ok(src.includes(`verdict: 'INCOMPLETE (empty diff)'`), 'an empty diff must persist its own INCOMPLETE verdict')
  assert.ok(src.includes('const emptyMsg = noChangedFilesMessage()'), 'the empty-diff branch must use it')
})
