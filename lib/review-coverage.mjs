// ================= Coverage honesty =================
// A verdict must never claim more coverage than the run had. The review engine only knows the
// language PROFILES declared in workflows/review.js; everything else in a diff is UNREVIEWED, and
// saying so is the whole point of this module.
//
// It lives here, outside the workflow, for one reason: workflows/review.js cannot be imported
// (top-level `export` + `await` + `return` parse only inside the sandbox wrapper), so anything
// declared there can be tested only by eval'ing a prefix of the file — that is, by testing a COPY.
// These functions are pure, so they live in a real module, are imported by real tests, and are
// linted; the workflow gets them back verbatim through a `craft-inline` fenced region
// (lib/inline-regions.mjs).
//
// PURITY IS THE CONTRACT. Nothing here may read the workflow's module state. `PROFILES` in
// particular is declared empty and then MUTATED (`PROFILES.rust = …`), so every function that needs
// the language roster takes it as its first argument instead of closing over it.

// The human-readable roster of what the engine can review, named in every coverage message so a
// caller reading "nothing was reviewed" also learns what would have been.
export function supportedLangLabel(profiles) {
  return Object.values(profiles).map(p => p.lang).join('/')
}

// A pin naming an id that does not exist used to be dropped by `filter(Boolean)` — silently — and
// the run then fell into "no language matched" and returned a green Approve over an unreviewed
// diff. Split the pin into known/unknown instead and let the caller refuse to proceed.
// `requested` arrives from workflow args and is NOT trusted to be an array: a scalar `languages:
// 'rust'` and a JSON-decoded string are both known argument-transport shapes here. Normalise first —
// the old `includes` form tolerated a string by accident, and calling `.filter` on one threw a
// TypeError that aborted the whole review. Degrade toward running the review, never toward crashing:
// an unusable shape (empty list, object, number) is treated as "no pin at all".
export function resolveProfilePin(profiles, requested) {
  if (!requested) return { pinned: null, unknown: [] }
  const list = (Array.isArray(requested) ? requested : [requested])
    .filter(id => typeof id === 'string')
    .map(id => id.trim().toLowerCase())
    .filter(Boolean)
  if (!list.length) return { pinned: null, unknown: [] }
  // DEDUPE. Lowercasing collapses `['rust','Rust']` to the same id twice; the pre-normalisation code
  // hid that by accident (`profiles['Rust']` was undefined and got dropped). A duplicated pin makes
  // the pin fallback build `active` with the same profile twice, so the whole lens pipeline runs
  // twice and the report reads "no findings across rust+rust".
  const uniq = [...new Set(list)]
  return { pinned: uniq.filter(id => !!profiles[id]), unknown: uniq.filter(id => !profiles[id]) }
}

export function unknownPinMessage(profiles, unknown) {
  const q = xs => xs.map(x => `\`${x}\``).join(', ')
  return `unknown language pin ${q(unknown)} — available: ${q(Object.keys(profiles))}`
}

export function noLanguageMessage(profiles, fileCount, materialCount = fileCount) {
  return `NOTHING WAS REVIEWED — none of the ${fileCount} changed file(s) match a supported language profile (this engine reviews ${supportedLangLabel(profiles)} only), and ${materialCount} of them carry reviewable content that therefore went unreviewed. This is not an approval: no lens ran and no finding could have been produced.`
}

// A diff that came back with NO files at all. Reachable legitimately — an already-merged branch, a
// `path` scope matching nothing — and also when detection half-failed, which is why this stays
// INCOMPLETE rather than green. But it is not a coverage hole: describing it with
// noLanguageMessage(0, 0) produced "none of the 0 changed file(s) … and 0 of them went unreviewed",
// a hole of size zero, which is self-contradictory and teaches readers to ignore the marker.
export function noChangedFilesMessage() {
  return `NOTHING WAS REVIEWED — the diff came back EMPTY: no changed file was detected against the resolved base. Either there is genuinely nothing to review here (an already-merged branch, or a \`path\` scope that matches nothing) or the base/scope is wrong and detection failed. No lens ran, so this is not an approval — check the base and re-run.`
}

// Which unreviewed files actually lower the claim. Derived from the path alone and deliberately
// conservative: when in doubt a file is MATERIAL. A false "material" costs one honest INCOMPLETE
// marker; a false "inert" costs a silent overclaim, which is the bug this whole section exists to
// prevent. Three narrow exemptions only — prose/asset extensions, lockfiles matched by their real
// names, and artifacts whose path makes it unambiguous that a generator wrote them.
export const INERT_EXT = /\.(md|markdown|rst|adoc|svg|png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|otf)$/i
export const INERT_NAMES = new Set([
  'license', 'licence', 'notice', 'codeowners', '.gitignore', '.gitattributes',
  // Inert `.txt` files by NAME, not by extension. A blanket `.txt` rule was the lockfile bug again
  // in another costume: `CMakeLists.txt`, `requirements.txt`, `conanfile.txt` and `Dependencies.txt`
  // are build-system and dependency SOURCE, and a diff of nothing but those took the green
  // "nothing needed reviewing" return. When in doubt, material.
  'license.txt', 'licence.txt', 'notice.txt', 'copying.txt', 'authors.txt', 'contributors.txt',
  'changelog.txt', 'changes.txt', 'readme.txt', 'robots.txt', 'humans.txt', 'todo.txt', 'notes.txt',
  // Lockfiles, by the names they actually have. Matching a *shape* like `*lock.*` swallowed source
  // code — `db/lock.sql`, `src/lock.rs`, `internal/spin-lock.go` — and silently exempted it.
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
  'cargo.lock', 'flake.lock', 'poetry.lock', 'pdm.lock', 'uv.lock', 'pipfile.lock', 'gemfile.lock',
  'composer.lock', 'go.sum', 'deno.lock', 'mix.lock', 'pubspec.lock', 'podfile.lock', 'packages.lock.json',
  'gradle.lockfile', 'cabal.project.freeze', 'conan.lock', 'herd.lock',
])
// Generated artifacts. Only where the PATH itself is unambiguous — a generator-stamped suffix or a
// directory whose whole purpose is generated output. A hand-written file never lives here.
export const GENERATED_PATH = /(^|\/)(__generated__|generated|node_modules|vendor)\//i
export const GENERATED_FILE = /(\.snap|\.min\.(js|css|mjs|cjs)|\.pb\.(go|cc|h|rs|ts)|_pb2(_grpc)?\.py|\.gen\.(go|rs|ts)|\.generated\.[a-z0-9]+|\.g\.dart)$/i

export function isInertUncovered(f) {
  const base = String(f).split('/').pop().toLowerCase()
  return INERT_EXT.test(f) || INERT_NAMES.has(base) || GENERATED_PATH.test(f) || GENERATED_FILE.test(f)
}

export function materialUncovered(files) {
  return files.filter(f => !isInertUncovered(f))
}

// A THIRD class, between "inert" and "a coverage hole in the reviewed code".
//
// The INCOMPLETE marker on an otherwise-green verdict exists to say: reviewable CODE went
// unreviewed. Once "material" was made to mean "anything that is not docs/assets/lockfiles", the
// marker started firing on ordinary PRs — `src/lib.rs` plus `.github/workflows/ci.yml` produced
// `⚠️ Approve (INCOMPLETE)`, and rust-audit downgraded the whole audit to Warning off the leading
// ⚠️. That is the failure this code's own comments warn about, relocated from docs to config: a
// marker that fires on nearly every PR stops being read, and then the overclaim it guards against
// comes back as a habit.
//
// So: project CONFIGURATION and BUILD RECIPES that no language lens ever claimed to read — CI
// workflow files, linter/tool config, container and task-runner recipes, editor/dotfile config —
// are reported in the "Not reviewed" section (nothing is hidden) but do NOT put the verdict into
// INCOMPLETE. They are not the reviewed program's source, and the review never claimed them.
// Everything else stays a real gap: `.py`, `.go`, `.sh`, `.sql`, `.proto`, `.ts` and friends are
// executable or schema SOURCE that can carry a defect, so they keep firing the marker. The list is
// a narrow, explicit allowlist by name/extension — an unrecognised path is still a coverage gap,
// preserving the "when in doubt, material" rule.
export const ANCILLARY_NAMES = new Set([
  'dockerfile', 'containerfile', 'justfile', 'makefile', 'gnumakefile', 'procfile', 'vagrantfile',
  'deny.toml', 'rustfmt.toml', 'clippy.toml', 'rust-toolchain.toml', 'rust-toolchain',
  '.editorconfig', '.dockerignore', '.npmrc', '.nvmrc', '.prettierrc', '.eslintrc',
  'codecov.yml', 'renovate.json', 'dependabot.yml', '.pre-commit-config.yaml',
])
export const ANCILLARY_PATH = /(^|\/)(\.github|\.gitlab|\.circleci|\.woodpecker|\.buildkite)\//i
export function isAncillaryConfig(f) {
  const p = String(f)
  const base = p.split('/').pop().toLowerCase()
  return ANCILLARY_NAMES.has(base) || ANCILLARY_PATH.test(p) || /\.dockerfile$/i.test(base)
}

// The files whose absence from the review actually voids a green verdict: material, and not mere
// project configuration. This — not `materialUncovered` — drives the INCOMPLETE marker on a run
// that DID review code.
export function coverageGapFiles(files) {
  return materialUncovered(files).filter(f => !isAncillaryConfig(f))
}

// THE coverage decision, taken from the change set alone and BEFORE any language pin can populate
// `active`. Pure, so it is testable through the pinned path — testing the guards in isolation from
// the pin is exactly how they stayed dead code for a release while every internal caller pinned.
//   'empty'             — the diff resolved to no files at all: INCOMPLETE, never a green Approve.
//   'nothing-to-review' — files, but all inert (docs/assets/lockfiles/generated): honest green.
//   'no-profile'        — reviewable material, and neither detection nor a pin yields a profile.
//   'review'            — go ahead, with `active`.
// A pin only takes effect in the last step: it says WHICH profile reviews the material, never that
// material exists.
export function resolveCoverage({ profiles, changedFiles, detectedActive, pinnedLangs }) {
  const files = Array.isArray(changedFiles) ? changedFiles : []
  const detected = Array.isArray(detectedActive) ? detectedActive : []
  if (!files.length) return { outcome: 'empty', active: [], material: [] }
  const material = materialUncovered(files)
  if (!material.length && !detected.length) return { outcome: 'nothing-to-review', active: [], material }
  let active = detected
  if (!active.length && Array.isArray(pinnedLangs) && pinnedLangs.length) active = pinnedLangs.map(id => profiles[id])
  if (!active.length) return { outcome: 'no-profile', active: [], material }
  return { outcome: 'review', active, material }
}

// The other half of the no-profile case: a diff whose changed files are ALL inert (prose, assets,
// lockfiles, generated output). Nothing was reviewed AND nothing needed reviewing — a different
// statement from "files went unreviewed", and it must not be dressed up as a coverage hole. A
// marker that fires on every README-only change stops being read, which destroys the value of the
// marker on the diffs that do hide unreviewed code.
export function nothingToReviewMessage(fileCount) {
  return `NOTHING NEEDED REVIEWING — all ${fileCount} changed file(s) are documentation, assets, lockfiles or generated output; none carries reviewable code. No lens ran because none had anything to look at.`
}

export function uncoveredNotRunNote(material) {
  const shown = material.slice(0, 5).join(', ')
  return `${material.length} changed file(s) matched no language profile and were NOT reviewed (${shown}${material.length > 5 ? `, +${material.length - 5} more` : ''})`
}

// ---- telemetry honesty ----
// A run record is written by an agent shelling out to lib/craft-log-run.mjs, so the write can fail
// while the review itself is perfectly healthy: a craftRoot that has moved, a dead logger agent, a
// damaged store. Losing it used to be pure silence, and silence in the store is read as "this review
// was never run" — the permissive default wearing the face of a fact.
// The recorded decision is that this NEVER fails the run (a three-hour review killed by a bookkeeping
// write teaches everyone to ignore the marker); it is reported instead. Returns '' for a healthy run,
// so the marker cannot appear where nothing was lost — a marker that fires on healthy runs is one
// people stop reading, which is the same defect wearing the opposite sign.
// The body speaks about the WRITE, never about the run: out() appends it to every exit, including
// those whose verdict says nothing was reviewed (dead base resolution, unknown language pin, empty
// diff). Reassurance that "the review ran" would contradict the verdict two lines above it there.
export function telemetryLostSection(lost) {
  const lines = (Array.isArray(lost) ? lost : []).filter(l => String(l ?? '').trim())
  if (!lines.length) return ''
  return [
    ``,
    `## ⚠️ Telemetry lost`,
    `${lines.length} record write(s) for this run did not land, so the run store is missing or incomplete for it. Read the verdict above — not the store — for what this run actually did: the store's silence about it is a bookkeeping failure and says nothing either way about the review.`,
    ...lines.map(l => `- ${l}`),
  ].join('\n')
}

// ---- severity vocabulary ----
// Not a coverage decision, but the same kind of claim-honesty rule, and pure for the same reason: a
// verdict must be counted from severities the counting functions can actually see.

// Canonicalize a ledger severity ONCE at the prior-round load boundary. LEDGER_ITEM.severity has no
// enum, so a drifted `critical`/`CRITICAL` reaches the load: the case-insensitive gates (isHighSeverity)
// still fire on it, but every VERDICT/COUNT function (countBySeverity, reviewVerdict/finalVerdict/
// rereviewVerdict, and the strict re-review escalation) matches severity by EXACT case and would
// silently bucket it as 0 Critical/0 High — a fail-open that clears a still-broken Critical fix.
// Mapping known values to canonical case here (and passing an unknown value through, trimmed — never
// dropping it) means EVERY downstream comparison sees canonical severity for priors.
export const CANON_SEVERITY = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' }
export function canonicalSeverity(sev) { return CANON_SEVERITY[String(sev ?? '').trim().toLowerCase()] || String(sev ?? '').trim() }
