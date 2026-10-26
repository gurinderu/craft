// The review engine's preflight brief (src/review.js, Gate phase): its answer schema, its prompt, and how a
// partial answer is read.
import { flattenField } from './prompt-fields.mjs'
import { probeDeclarationBlock } from './preflight-probes.mjs'

/**
 * @template T
 * @typedef {import('./review-schemas.mjs').Schema<T>} Schema
 */
/**
 * @typedef {import('./review-schemas.mjs').PreflightAnswer} PreflightAnswer
 * @typedef {import('./review-profiles.mjs').Preflight} Preflight
 * @typedef {import('./review-profiles.mjs').Ctx} Ctx
 * @typedef {import('./review-profiles.mjs').Profile} Profile
 */

// ---- preflight: resolve the environment ONCE, before anything expensive ----
// This used to be improvised inside the gate agent, which learned it the expensive way — a measured
// run spent 50s discovering it was outside the repo's dev shell and 113s discovering the crate cannot
// compile without a database, and reported neither signal. Worse, every agent that later runs a tool
// (the gate, a lens re-running clippy, a verifier doing its MECHANICAL CHECK) rediscovered the same
// facts independently. Resolve them once, cheaply, and hand the answer to everyone downstream.
// The probe budget and its audit live in lib/preflight-probes.mjs, a linted module with real unit tests.
// The module's header carries why the audit is a DECLARATION audit and what that does and does not close.
/** @type {Schema<PreflightAnswer>} */
export const PREFLIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runner', 'blockers', 'missingTools', 'ciCovers', 'probes', 'partial', 'notes'],
  properties: {
    runner: { type: 'string', description: 'prefix every build/lint command needs, e.g. "direnv exec . " or "nix develop -c " — empty string if commands run bare' },
    blockers: { type: 'array', items: { type: 'string' }, description: 'reasons this tree CANNOT compile here, one per line, e.g. "sqlx query macros need a live Postgres; no offline .sqlx cache and no DATABASE_URL"' },
    missingTools: { type: 'array', items: { type: 'string' }, description: 'gate tools not on PATH (cargo-audit, cargo-deny, semgrep, …)' },
    ciCovers: { type: 'array', items: { type: 'string' }, description: 'signals a GREEN CI check already establishes for this exact HEAD, as "<signal> via <check name>" — e.g. "test via cargo nextest", "deny-bans via cargo-deny"' },
    // `minItems`/`minimum` are load-bearing, not decoration: without them `probes: []` and a negative
    // count were both VALID answers that the audit then read as clean — the cheapest possible path to
    // a green audit. The schema now refuses the shape and `auditPreflightProbes` refuses it again.
    probes: { type: 'array', minItems: 1, description: 'one entry per source consulted, with how many shell/API invocations it cost — audited against PROBE_BUDGETS; never empty, not even in a partial result, since it reports what was already done', items: { type: 'object', additionalProperties: false, required: ['source', 'calls'], properties: { source: { type: 'string', description: 'the probe-source id from the prompt\'s list, exactly' }, calls: { type: 'integer', minimum: 0, description: 'invocations spent on that source, including ones that returned nothing' } } } },
    partial: { type: 'boolean', description: 'true if ANY of the four fields was left unfinished (ran out of time, a command failed, gh unavailable) — the matching field is then empty and notes says which and why' },
    notes: { type: 'string' },
  },
}
/** @param {Profile} profile @param {Ctx} ctx */
export function preflightPrompt(profile, ctx) {
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

3. MISSING TOOLS. Which of ${profile.id === 'rust' ? '`cargo-audit`, `cargo-deny`, `cargo-semver-checks`, `semgrep`' : '`statix`, `deadnix`, `nixpkgs-fmt`/`alejandra`, `nix-instantiate`'} are genuinely unavailable? ONE command answers it for every tool at once — run it exactly, do not probe tool-by-tool:
   \`\`\`
   for t in ${profile.id === 'rust' ? 'cargo-audit cargo-deny cargo-semver-checks semgrep' : 'statix deadnix nixpkgs-fmt alejandra nix-instantiate'}; do
     p=$(command -v "$t" 2>/dev/null); [ -z "$p" ] && [ -x "$HOME/.cargo/bin/$t" ] && p="$HOME/.cargo/bin/$t"
     echo "$t: \${p:-MISSING}"
   done
   \`\`\`
   A dev shell usually has a NARROWER PATH than the login shell, so if the runner prefix from step 1 is non-empty, run the same loop once more under it and treat a tool as PRESENT if EITHER pass found it — that mistake silently dropped the entire \`cargo audit\` signal from a real run. Name the invocation that works (e.g. "cargo-audit: ~/.cargo/bin/cargo-audit, outside the dev shell"). Only a tool MISSING in both passes goes in \`missingTools\` — an absent tool is an intentional skip downstream, never a failure.

4. CI COVERAGE. Which signals does a GREEN check already establish for THIS EXACT commit? TWO calls answer it, both SHA-scoped — the check-runs endpoint and the commit-status endpoint. Run those two, once each, and NOTHING else — in particular do NOT run \`gh pr checks\` and do NOT look the PR up by commit: those resolve by branch (empty on a review worktree or detached HEAD) or hand you a PR whose head may have moved past your commit, and both then need the SHA test this call satisfies by construction.
   \`\`\`
   SHA=$(git rev-parse HEAD)
   gh api "repos/{owner}/{repo}/commits/$SHA/check-runs" --jq '.check_runs[] | "\\(.name) \\(.status) \\(.conclusion)"'
   gh api "repos/{owner}/{repo}/commits/$SHA/status" --jq '.statuses[] | "\\(.context) completed \\(.state)"'
   \`\`\`
   Owner/repo from \`git remote get-url origin\`. Both calls, once each: check-runs alone misses CI that reports through the older commit-status API, and that omission looks exactly like "no CI". Keep only \`completed\` rows whose conclusion/state is \`success\`.
   Then read the workflow behind a green check to learn what it ACTUALLY runs, not what its name suggests: a job called \`cargo-deny\` running \`check bans\` covers bans and NOT advisories or licenses, and that distinction is the whole value of this step. HARD CAP — this is where the pass runs away with the clock: read AT MOST 2 workflow files, only for green checks that map to a gate signal (build/test/clippy/fmt or a security tool). Never enumerate \`.github/workflows/*\` wholesale. Past the cap, the remaining green checks go in \`notes\` BY NAME ONLY and NEVER in \`ciCovers\` — \`ciCovers\` means "do not re-run this locally", and a check whose workflow you did not open cannot support that: its name is a guess at what it ran, which is exactly what the \`cargo-deny\`/\`check bans\` example above shows going wrong. Only a signal you read the workflow for goes in \`ciCovers\`.
   List one entry per covered signal, e.g. "test via cargo nextest", "deny-bans via cargo-deny (command: check bans)". If gh is missing, unauthenticated or offline, return an empty list and say so in notes.

${probeDeclarationBlock()}

BUDGET (hard): reconnaissance, target ~90 seconds, three minutes is the ceiling. Past the dispatch deadline nothing cuts you off — the caller simply STOPS WAITING for you and dispatches a second preflight, so everything you do after that point is discarded and paid for twice, and if the second pass is as slow the gate loses even the runner prefix. So at three minutes STOP and RETURN. A thorough preflight costing more than the steps it saves is a net loss (measured: the first version took 207s and made the gate+preflight pair SLOWER than the gate had been alone). Never run a build, a test, or a full lint here.

PARTIAL RESULTS ARE THE EXPECTED SHAPE, NOT A FAILURE — but they must be legible as partial. Any of the four FINDINGS fields above (runner, blockers, missingTools, ciCovers) you did not finish: set \`partial: true\`, return the field EMPTY, and open \`notes\` with \`PARTIAL: <field> not established (<why>)\`, one clause per unfinished field. \`partial\` is the flag downstream reads — the note explains it, it does not replace it. An empty \`ciCovers\` with no such note means "CI covers nothing", and a downstream step will re-establish every signal locally on that reading — so never let "I ran out of time" arrive looking like "I checked and there was nothing".
\`probes\` (step 5) IS EXPLICITLY EXCLUDED FROM THAT INSTRUCTION: it is not a finding but a report of what you ALREADY DID, so it can never be returned empty — a run cut short declares the calls it had already spent, and an empty \`probes\` is read as a violation, never as a disciplined pass.

Return runner, blockers, missingTools, ciCovers, probes, partial, notes.`
}
// An unfinished preflight must not be recorded as a clean one. The schema carries an explicit
// `partial` boolean precisely so this does not hang on the shape of prose: the earlier test was
// anchored at the start of the note, so one clause of preamble before the marker
// ("Ran out of time. PARTIAL: ciCovers …") produced status 'ok' over unfinished fields. The note is
// still consulted, unanchored, as a fallback for a model that writes the prose but omits the flag.
// The fallback matches only the MARKER the prompt mandates — uppercase `PARTIAL:` — never the bare
// word: `notes` now also carries CI CHECK NAMES (the past-the-cap list), and a green check called
// `partial-build` matched `/\bPARTIAL\b/i` and flipped a complete preflight to 'partial'.
/** @param {Preflight | null | undefined} pf */
export function preflightIsPartial(pf) {
  if (!pf) return false
  if (pf.partial === true) return true
  return /\bPARTIAL:/.test(flattenField(pf.notes || ''))
}
