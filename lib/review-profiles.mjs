// The language profiles of the review engine (src/review.js): each profile's detection, gate prompt and lens
// briefs, imported by the engine and read by the tests as the engine runs them.
import { shq } from './run-logging.mjs'
import { flattenField } from './prompt-fields.mjs'
import { RUST_UNITS } from './rust-units.mjs'
import { contentText } from './content.mjs'
import scoutRulesRust from '../content/prompts/scout-rules-rust.md'
import rustSafety from '../content/prompts/lens-briefs/rust-safety.md'
import rustErrors from '../content/prompts/lens-briefs/rust-errors.md'
import rustConcurrency from '../content/prompts/lens-briefs/rust-concurrency.md'
import rustPerformance from '../content/prompts/lens-briefs/rust-performance.md'
import rustApiIdioms from '../content/prompts/lens-briefs/rust-api-idioms.md'
import rustApiBoundary from '../content/prompts/lens-briefs/rust-api-boundary.md'
import rustReconciler from '../content/prompts/lens-briefs/rust-reconciler.md'
import rustFailureWindows from '../content/prompts/lens-briefs/rust-failure-windows.md'
import rustMaintainability from '../content/prompts/lens-briefs/rust-maintainability.md'
import rustTests from '../content/prompts/lens-briefs/rust-tests.md'
import rustIntent from '../content/prompts/lens-briefs/rust-intent.md'
import rustInvariants from '../content/prompts/lens-briefs/rust-invariants.md'
import rustCompat from '../content/prompts/lens-briefs/rust-compat.md'
import rustNegativeSpace from '../content/prompts/lens-briefs/rust-negative-space.md'
import scoutRulesNix from '../content/prompts/scout-rules-nix.md'
import nixPurity from '../content/prompts/lens-briefs/nix-purity.md'
import nixReproducibility from '../content/prompts/lens-briefs/nix-reproducibility.md'
import nixInjection from '../content/prompts/lens-briefs/nix-injection.md'
import nixPackaging from '../content/prompts/lens-briefs/nix-packaging.md'
import nixDevEnv from '../content/prompts/lens-briefs/nix-dev-env.md'
import nixModules from '../content/prompts/lens-briefs/nix-modules.md'
import nixMaintainability from '../content/prompts/lens-briefs/nix-maintainability.md'
import nixIntent from '../content/prompts/lens-briefs/nix-intent.md'
import nixNegativeSpace from '../content/prompts/lens-briefs/nix-negative-space.md'

/**
 * @typedef {import('./review-schemas.mjs').PreflightAnswer} PreflightAnswer
 * @typedef {PreflightAnswer} Preflight  the preflight agent's answer (model output)
 * @typedef {{ baseRef?: unknown, preflight?: Preflight | null, isLibrary?: boolean, securitySensitive?: boolean }} Ctx  what a profile's gate prompt is built from
 * @typedef {{ id: string, lang: string, detect: (files: string[]) => boolean, diffGlobs: string[], rubricSkill: string, fpRules: string, rollupRuleIds: string[], navSkill: string, reviewerAgent: string, securityHints: string, usesLibrary: boolean, alwaysLenses: string[], safetyLens: string, scoutRules: string, gate: (ctx: Ctx) => string, depContext: (ctx: Ctx) => string, lenses: string[], lensBrief: Record<string, string>, units?: import('./unit-graph.mjs').UnitDiscovery }} Profile  `units`: the profile's unit discovery for unitScope (realm @nick/craft, #362); absent, the profile has no units
 */

// A cold full-workspace build is the one step in this workflow that can run for an hour and take the
// whole review down with it: a gate agent that sits in `cargo clippy` stops emitting, the harness
// calls it stalled, re-dispatches it, and the replacement starts the same build from scratch. One
// real run burned 99 minutes across six gate agents that way and returned nothing. craft already
// treats an ABSENT tool as an intentional skip; a tool that cannot finish in budget is the same
// thing — an unestablished signal, which is a fine review outcome, unlike a dead run.
export const GATE_TIME_BUDGET = `
TIME BUDGET (hard): wrap EVERY build/lint/test command in \`timeout\` so the shell kills it instead of
you waiting — e.g. \`timeout 600 cargo clippy … ; echo "EXIT=\${PIPESTATUS[0]}"\`. Allow roughly 10
minutes for the primary gate command and 5 for each optional one. A command that hits the timeout is
NOT a failure and NOT a retry: record that signal as unknown, say in notes which command timed out and
after how long, and move on to the next one. Never re-run a timed-out build hoping it is faster the
second time — the cache is no warmer and you will spend the whole review on it. status=fail is
reserved for a check that actually RAN and came back red. If the primary gate times out, the review
continues on the remaining signals with status=unknown — an incomplete gate beats a dead run.`

// Rendered into every downstream prompt that might run a tool, so the answer travels with the work.
/** @param {Preflight | null | undefined} pf */
export function preflightBrief(pf) {
  // A dead preflight must NOT render as a clean one. Returning '' left the downstream prompt with no
  // preflight block at all — indistinguishable from a run where preflight said "nothing to report",
  // which is the permissive reading of "we could not establish it". Say it out loud instead.
  if (!pf) return `PREFLIGHT UNAVAILABLE — the preflight step failed or passed its deadline and returned nothing. Nothing below is resolved for you: no command prefix, no compile blockers, no tool inventory, no CI coverage. Establish what you need yourself, CHEAPLY (read the tree; never run a build to read its error), and say "preflight unavailable" in your provenance so the record shows this run was short one step.\n`
  const runner = pf.runner ? `\`${flattenField(pf.runner)}\`` : '(none needed — commands run bare)'
  const lines = [`PREFLIGHT (already resolved — do NOT rediscover any of this):`,
    `- Command prefix for every build/lint/test command: ${runner}. Commands run without it die in missing system libraries, not in your diff.`]
  if (pf.blockers?.length) lines.push(`- CANNOT BUILD HERE: ${pf.blockers.map(flattenField).join(' · ')}. Any step that needs a compile is UNRUNNABLE — skip it and say so; do NOT run it to watch it fail.`)
  if (pf.missingTools?.length) lines.push(`- Not installed (probed both bare and inside the dev shell): ${pf.missingTools.map(flattenField).join(', ')} — an absent tool is an intentional skip, never a failure. If you can nonetheless invoke one (a full path, \`nix run nixpkgs#<tool> --\`), do, and say so in provenance.`)
  lines.push(pf.ciCovers?.length
    ? `- Already GREEN in CI for this exact commit: ${pf.ciCovers.map(flattenField).join(' · ')}. Do NOT re-run these locally — CI ran the project's real command on a clean machine. Cite the check in provenance instead.`
    : `- CI covers nothing for this commit (or could not be consulted) — every signal must be established locally or reported unknown.`)
  if (pf.notes) lines.push(`- Preflight notes: ${flattenField(pf.notes)}`)
  return lines.join('\n') + '\n'
}

// ================= language profiles =================
/** @param {Ctx} _ctx */
export function rustDepContext(_ctx) {
  return `8. **Dependency context** — review against the crate versions the project ACTUALLY pins, not against crates-in-the-abstract. Resolve them: \`cargo metadata --locked --format-version 1\` (or read \`Cargo.lock\`) and match the external crates the changed files \`use\` to their locked versions. For any nontrivial dependency the diff touches, check whether the usage is correct *for that pinned version* — a since-deprecated/removed/renamed API, a changed default, a known footgun of that exact version. Consult context7 for the crate's version-specific docs instead of trusting memory. Turn a genuine version-specific misuse into a seed finding (source "dep-context", severity Medium, ruleId "DEP-001"). Known-vulnerable versions are already covered by \`cargo audit\` (ruleId "DEP-002") — do not duplicate. Best-effort: skip silently if \`cargo metadata\` fails or the diff touches no external crate.`
}

/** @param {Ctx} ctx */
export function rustGate(ctx) {
  return `You are establishing the mechanical gate for a Rust review, CI-aware, and collecting tool-grounded seed findings. Diff base: ${ctx.baseRef ? `\`${flattenField(ctx.baseRef)}\`` : 'uncommitted changes / most recent commit'}.

${preflightBrief(ctx.preflight)}
GATE (CI-aware, per the rust-review skill — load it):
0. USE THE PREFLIGHT ABOVE. Its command prefix goes on every cargo invocation; its blockers make the matching steps unrunnable (skip them and record WHY in provenance — "pedantic seeds unavailable: sqlx macros need Postgres"); its ciCovers list is the set of signals you must NOT re-establish locally. It was resolved by a separate step precisely so this one does not pay to rediscover it. If it is absent or empty, fall back to establishing these yourself — but cheaply, by reading the tree, never by running a build to read its error.
1. Detect a PR + CI — if preflight returned a non-empty ciCovers, that list is the VERIFIED SUBSET of the detection, not the whole of it: preflight reads at most two workflow files, so a green check past that cap is named in its \`notes\` BY NAME ONLY and is absent from ciCovers. So: never re-run the gh detection for a signal already in ciCovers (~90s for an answer you were handed), and for a check named in \`notes\` but NOT in ciCovers, either open that one workflow yourself to learn what it actually runs — and only then treat it as coverage — or establish the signal locally. A bare check name is never coverage; \`test-and-lint\` may run neither. If ciCovers is non-empty and \`notes\` names no further green checks, the detection is complete and you skip the gh calls entirely. \`gh pr checks --json name,state,bucket,link\` resolves the PR from the CURRENT BRANCH NAME, which fails whenever you are not sitting on the PR's own head branch — a review worktree (\`pr-1203-review\`), a detached HEAD, or a local rename all look like "no PR" even though CI ran and is green. That is a false negative that costs the whole CI shortcut, so when the branch lookup comes up empty, LOOK UP THE PR BY COMMIT before giving up:
   \`\`\`
   SHA=$(git rev-parse HEAD)
   gh api "repos/{owner}/{repo}/commits/$SHA/pulls" --jq '.[].number'   # PRs whose head is this commit
   gh pr checks <number> --json name,state,bucket,link
   \`\`\`
   Derive owner/repo from \`git remote get-url origin\`. Also accept a PR found this way when its head SHA equals your HEAD — say so in provenance (\`via CI · PR #N · matched by SHA\`). Only if BOTH the branch and the commit lookup find nothing, or gh is missing/unauthenticated/offline, fall through to the local gate. Match generously: a check named \`cargo nextest\`, \`unit-tests\`, \`ci / test (stable)\` etc. all cover the TEST signal; \`just clippy\`, \`lint\`, \`clippy (stable)\` cover CLIPPY. A green check is the BEST evidence available — it ran on a clean machine with a warm cache and the project's real configuration. Prefer it over anything you could run here.

1b. NEVER stand up infrastructure to satisfy this gate. If a check needs a database, a container, a broker, a network service or a fixture server, that check is CI's — do not start Postgres, run \`docker\`/\`docker compose\`, apply migrations, or seed anything. Record that signal as unknown with the reason ("integration tests need Postgres; not run locally — CI owns this"). You are establishing whether a DIFF is reviewable, not reproducing the build farm. A review that never starts is worth far less than one with an unestablished test signal.
2. For build/test/clippy/fmt: if a conclusive GREEN check covers it, treat it as PASSED and record provenance "via CI #<n>". Do NOT require the check to be marked \`required\` — most repos have no branch protection at all (\`isRequired\` is then null for every check, and \`gh api …/branches/<b>/protection\` 404s), so demanding it would make this whole shortcut dead code and send you into a local build you did not need. Required-ness decides whether RED blocks a merge upstream; it says nothing about whether GREEN is trustworthy evidence — a passing job ran the project's real command on a clean machine. If a check covering fmt/clippy/test/build FAILED, set status=fail and list it in failedChecks (note whether it was required). A red check unrelated to those four is worth a line in notes, not a gate failure. Only when the signal is genuinely pending or absent, run it locally under the TIME BUDGET below.
   TAKE THE PROJECT'S LINT SEMANTICS, USE YOUR OWN SCOPE AND FORMAT. First READ the project's lint recipe — a \`clippy\`/\`lint\` target in \`justfile\`/\`Makefile\`/\`Taskfile\`, an \`[alias]\` in \`.cargo/config.toml\`, or the step its CI workflow runs (\`.github/workflows/*.yml\`) — and lift its SEMANTIC flags: the feature selection (\`--all-features\`, \`--features …\`, \`--no-default-features\`) and every \`-A\`/\`-W\`/\`-D\` lint level it sets. Those decide verdicts: a project that allows \`clippy::too_many_arguments\` will otherwise get gate failures on lints it deliberately permits, and linting the wrong feature set lints code that never ships.
   Then run it SCOPED and SHORT, which change only how much is built and how it prints, never what a lint says about a given crate:
   \`cargo clippy -p <each changed package> --all-targets --message-format=short <their feature flags> -- <their -A/-W flags> -D warnings\`
   Resolve the changed packages from the diff paths via \`cargo metadata --no-deps --format-version 1\`. Fall back to the whole workspace only when the diff genuinely spans it.
   Note the trade-off in notes: a scoped run cannot see a break this change causes in a DEPENDENT crate elsewhere in the workspace. That is CI's job — and if CI covered clippy you should not be running this at all (step 2 above). When you scope, say so, and name the packages.
   If the project defines no recipe, use \`cargo fmt --check\` and \`cargo clippy -p <changed> --all-targets --message-format=short -- -D warnings\`.
   TESTS: run them locally ONLY if CI did not cover them AND they need no infrastructure (per 1b) — and then scoped, \`cargo test -p <changed package>\`, never the whole workspace. If the changed package's tests need a service, or a bare \`cargo test\` starts pulling one up, stop and record the test signal as unknown. Do not chase a green suite; that is not what this gate is for.
3. Security tools (\`cargo audit\`, \`cargo deny\`) — usually absent from CI, so usually yours to run, but they get the SAME two rules as everything else:
   - CI COVERAGE. If preflight lists one as already green for this commit, do not re-run it. Note the sub-command: a CI job running \`cargo deny check bans\` covers bans ONLY — advisories and licenses remain yours.
   - THE PROJECT'S SCOPE, NOT THE TOOL'S DEFAULTS. Run the sub-checks the project actually configures. \`cargo deny check\` with no arguments runs advisories/bans/licenses/sources, and the unconfigured ones fall back to cargo-deny's defaults — so a \`deny.toml\` containing only \`[bans]\` will "fail" licenses and advisories on a policy the project never wrote. That is a property of the tool, not a defect in the diff. Read \`deny.toml\` (and the CI invocation) and run exactly the configured sub-checks; if a sub-check has no configuration, skip it and say so in notes rather than reporting a default-policy failure.
   - ATTRIBUTION decides which list it lands in, and only failedChecks stops the review. Check \`git diff --name-only\` against the base for \`Cargo.toml\`/\`Cargo.lock\`:
     · the diff DOES touch a dependency manifest → a vulnerability with a published fix is this change's problem: failedChecks, status=fail.
     · the diff does NOT touch one → the advisory predates this change and no edit to these files can clear it. Put it in **carriedChecks**, prefixed "PRE-EXISTING: ", and do NOT let it set status=fail. It is still reported in full — carriedChecks is printed on every verdict, not just red ones — but a gate exists to answer "is THIS DIFF reviewable", and blocking every diff in a repository on a dependency backlog it did not create means no review in that repository ever runs.
   The same attribution applies to a red \`cargo deny\` sub-check: caused by this diff → failedChecks; pre-existing → carriedChecks.
4. status = fail if any of fmt/clippy/test/build is red (CI or local), or a security check red is attributable to this diff per 3; pass if all green; unknown if you could not establish it. Anything in carriedChecks NEVER moves status — that is the whole distinction.

SEED FINDINGS (tool grounding — beyond the gate, scoped to the changed crates):
5. Pedantic seeds (a SEPARATE, optional pass — never a substitute for the gate in step 2; SKIP OUTRIGHT if preflight 0b found a compile blocker), on the SAME changed packages and the SAME feature flags you resolved there, so the two passes see the same code. Run it in JSON so each line names its lint (\`--message-format=short\` does not): \`cargo clippy -p <pkg> --all-targets --message-format=json <their feature flags> -- -W clippy::pedantic -W clippy::nursery 2>/dev/null | jq -r 'select(.reason=="compiler-message") | .message | select(.code != null) | (first(.spans[] | select(.is_primary)) // {}) as $s | "\\($s.file_name // "?"):\\($s.line_start // 0): \\(.level) [\\(.code.code)] \\(.message)"' | sort -u\` — one line per diagnostic, \`file:line: level [clippy::lint] message\`. Without jq, drop \`--message-format\` and read the lint from each diagnostic's help link, \`…/index.html#<lint>\` → \`clippy::<lint>\`. Only fall back to the whole workspace when the diff genuinely spans it. Keep the last ~200 diagnostic lines; if you truncate, SAY how many you dropped in notes — a silent cut reads as "there were only N". Turn each NEW pedantic/nursery diagnostic on changed lines into a seed finding (source "clippy-pedantic", severity Low — Medium only when you name the harm it causes in \`harm\` and its \`harmLevel\`, review-rules severity.md; a seed naming no harm is capped at Low). Do not fail the gate on these. This step is optional: if it exceeds the budget, skip it and note that the pedantic seeds are absent.
${ctx.isLibrary ? '6. This is a library: run `cargo semver-checks check-release` if installed; each reported break is a seed finding (severity High, source "semver-checks"). If not installed, log and skip.' : '6. Not a library — skip semver-checks.'}

7. SAST seed (semgrep) — decide what configs apply, then run only if any do:
   - If a \`./semgrep/\` rules dir exists in the repo, ALWAYS include \`--config=./semgrep/\` (repo-specific banned-API/taint rules — the whole point of keeping them in-repo).
${ctx.securitySensitive
    ? '   - This diff IS security-sensitive: also include `--config=p/rust --config=p/secrets`.'
    : '   - This diff is NOT security-sensitive: do not pull the generic rulesets; rely on `./semgrep/` only (skip step 7 entirely if that dir is absent).'}
   If at least one config applies and \`semgrep\` is installed, scope it to the changed Rust files (\`git diff --name-only ${ctx.baseRef ? `--merge-base ${shq(ctx.baseRef)}` : 'HEAD'} -- '*.rs'\`) and run \`semgrep --error <configs> <files>\`. Turn each result into a seed finding (source "semgrep"; map semgrep ERROR→High, WARNING→Medium, INFO→Low). These are SEEDS, never gate failures — semgrep taint/secrets over-reports, and downstream verification refutes the false positives. If semgrep is absent or no config applies, log and skip.

${rustDepContext(ctx)}

${GATE_TIME_BUDGET}
EVIDENCE RULE: report a check as pass/fail ONLY if you ran it yourself (quote the command and its exit status / decisive output line in notes) or saw it conclusively green/red in CI (cite the check name). Never infer a pass. If the changed files are not part of a cargo project, do NOT fabricate a temporary crate/harness around them to lint or build — record build/clippy/test as not establishable (status=unknown) and say why in notes.

Set provenance to a one-line summary like "clippy/test via CI #123; fmt/audit/deny local". Put gate failures in failedChecks (NOT seedFindings). Seed findings come from clippy-pedantic / semver / semgrep / dep-context only. On every seed finding set \`ruleId\` to the matching rust-review rules.md catalog ID (e.g. "DEP-001") or "" if none fits, and \`toolRule\` to the tool's own rule name copied from that finding's line of tool output — the clippy lint in its brackets ("clippy::needless_pass_by_value"), the semgrep \`check_id\`, the cargo-semver-checks check name. \`toolRule\` ONLY when the tool output you read names the rule, NEVER from memory or guessed from the message text — a wrong name hides a different lint behind an old decision; when the output names none (a dep-context finding, a line you cannot tie to a rule), leave \`toolRule\` out. A clippy, semver or semgrep seed's \`title\` is the tool's own message for that finding, copied verbatim — clippy's warning text, semgrep's message, the cargo-semver-checks line — never reworded, shortened or paraphrased: without \`toolRule\` the title is all that matches a past decision.`
}

/** @param {Ctx} _ctx */
export function nixDepContext(_ctx) {
  return `6. **Dependency context** — review against the flake inputs the project ACTUALLY pins. Resolve them from \`flake.lock\` (the locked \`rev\`/\`narHash\` per input). Flag inputs that are unpinned, channel-based (\`<nixpkgs>\`), or floating where they should be locked, and \`inputs.*.follows\` that should dedupe nixpkgs but don't (source "dep-context", severity Medium, ruleId "DEP-001"). Best-effort: skip silently if there is no flake.`
}

/** @param {Ctx} ctx */
export function nixGate(ctx) {
  return `You are establishing the mechanical gate for a Nix review and collecting tool-grounded seed findings. Diff base: ${ctx.baseRef ? `\`${flattenField(ctx.baseRef)}\`` : 'uncommitted changes / most recent commit'}.

${preflightBrief(ctx.preflight)}
GATE (per the nix-review skill — load it):
0. USE THE PREFLIGHT ABOVE rather than rediscovering it: its command prefix, its blockers (a step that cannot evaluate here is skipped and reported, never run to watch it fail), its missing tools, and its ciCovers — signals already green in CI for this exact commit are cited, not re-run.
1. If a \`flake.nix\` exists: \`nix flake check\` — a failure is a gate failure (list it in failedChecks), not a seed.
2. Formatter: run \`alejandra --check .\` or \`nixpkgs-fmt --check\` (whichever the repo uses — check for a formatter in the flake / a treefmt config). Mismatches are seeds (source "fmt", Low, one per file at line 0 — the whole file), never a gate failure unless CI enforces fmt.
3. \`nix eval\`/\`nix build\` the attrs the diff touches — an eval or build error on changed code is a gate failure.
4. status = fail if \`nix flake check\` or an eval/build of touched attrs is red; pass if green; unknown if you could not establish it (e.g. nix not installed).

SEED FINDINGS (tool grounding — scoped to the changed files):
5. Linters — \`statix check\` (anti-idioms) and \`deadnix\` (dead bindings) on the changed \`.nix\` files. Turn each diagnostic on changed lines into a seed finding (source "statix"/"deadnix", ruleId "MNT-001", severity Low — Medium only when you name the harm it causes in \`harm\` and its \`harmLevel\`, review-rules severity.md; a seed naming no harm is capped at Low). Do not fail the gate on these. If a linter is absent, log and skip.

${nixDepContext(ctx)}

${GATE_TIME_BUDGET}
EVIDENCE RULE: report a check as pass/fail ONLY if you ran it yourself (quote the command and its exit status / decisive output line in notes) or saw it conclusively green/red in CI. Never infer a pass; a tool you could not run is "skipped" in notes, never a pass.

Set provenance to a one-line summary like "nix flake check pass; statix/deadnix local". Put gate failures in failedChecks (NOT seedFindings). Seed findings come from statix / deadnix / fmt / dep-context only. On every seed finding set \`ruleId\` to the matching nix-review rules.md catalog ID (e.g. "MNT-001") or "" if none fits, and \`toolRule\` to the tool's own rule name copied from that finding's line of tool output — the statix code it prints in brackets ("W04"). \`toolRule\` ONLY when the tool output you read names the rule, NEVER from memory or guessed from the message text — a wrong name hides a different lint behind an old decision; when the output names none (a deadnix diagnostic, a formatter mismatch, a dep-context finding), leave \`toolRule\` out. A deadnix seed's \`title\` is deadnix's own diagnostic message for that binding, copied verbatim — it names the binding ("Unused lambda pattern: self"); never reword, shorten or paraphrase it. A statix seed's \`title\` is statix's own message for that finding, copied verbatim, the same way. The formatter prints no per-line message, so a formatter seed's \`title\` is the fixed form "File not formatted: <path>" and its \`line\` is 0. With no rule name, the title is what tells two such findings apart and matches a past decision round after round.`
}

/** @type {Record<string, Profile>} */
export const PROFILES = {}

PROFILES['rust'] = {
  id: 'rust',
  lang: 'Rust',
  detect: (/** @type {string[]} */ files) => files.some(f => /\.rs$/.test(f) || /(^|\/)Cargo\.toml$/.test(f)),
  // unitScope's units are its Cargo crates (lib/rust-units.mjs, realm @nick/craft #362).
  units: RUST_UNITS,
  diffGlobs: ["'*.rs'"],
  rubricSkill: 'rust-review',
  fpRules: 'fp-rules.md', // exclusion catalog (FP-*/KEEP-*); '' for a profile that ships none
  // Rules whose per-occurrence reporting buries the review — capped mechanically by rollupPool.
  // Only completeness nits belong here: never a rule whose individual instances carry distinct risk.
  rollupRuleIds: ['API-001', 'API-003', 'API-004', 'API-005'],
  navSkill: 'rust-navigation',
  reviewerAgent: 'craft:rust-reviewer',
  securityHints: 'auth, crypto, input parsing, unsafe, FFI, or dependencies',
  usesLibrary: true,
  alwaysLenses: ['intent'],
  safetyLens: 'safety',
  scoutRules: contentText(scoutRulesRust),
  gate: rustGate,
  depContext: rustDepContext,
  lenses: ['safety', 'errors', 'concurrency', 'performance', 'api-idioms', 'api-boundary', 'reconciler', 'failure-windows', 'compat', 'maintainability', 'tests', 'intent', 'invariants'],
  lensBrief: {
    safety: contentText(rustSafety),
    errors: contentText(rustErrors),
    concurrency: contentText(rustConcurrency),
    performance: contentText(rustPerformance),
    'api-idioms': contentText(rustApiIdioms),
    'api-boundary': contentText(rustApiBoundary),
    reconciler: contentText(rustReconciler),
    'failure-windows': contentText(rustFailureWindows),
    maintainability: contentText(rustMaintainability),
    tests: contentText(rustTests),
    intent: contentText(rustIntent),
    invariants: contentText(rustInvariants),
    compat: contentText(rustCompat),
    'negative-space': contentText(rustNegativeSpace),
  },
}

PROFILES['nix'] = {
  id: 'nix',
  lang: 'Nix',
  detect: (/** @type {string[]} */ files) => files.some(f => /\.nix$/.test(f) || /(^|\/)flake\.lock$/.test(f)),
  diffGlobs: ["'*.nix'", "'flake.lock'"],
  rubricSkill: 'nix-review',
  fpRules: '',
  rollupRuleIds: [],
  navSkill: '',
  reviewerAgent: 'craft:nix-reviewer',
  securityHints: 'secrets handling (agenix/sops-nix), fetchers/hashes, module security options, or build-script interpolation',
  usesLibrary: false,
  alwaysLenses: ['intent'],
  safetyLens: 'injection',
  scoutRules: contentText(scoutRulesNix),
  gate: nixGate,
  depContext: nixDepContext,
  lenses: ['purity', 'reproducibility', 'injection', 'packaging', 'dev-env', 'modules', 'maintainability', 'intent'],
  lensBrief: {
    purity: contentText(nixPurity),
    reproducibility: contentText(nixReproducibility),
    injection: contentText(nixInjection),
    packaging: contentText(nixPackaging),
    'dev-env': contentText(nixDevEnv),
    modules: contentText(nixModules),
    maintainability: contentText(nixMaintainability),
    intent: contentText(nixIntent),
    'negative-space': contentText(nixNegativeSpace),
  },
}
