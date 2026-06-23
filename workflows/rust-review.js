export const meta = {
  name: 'rust-review',
  description: 'Elastic deep review of a Rust diff — scout-scaled lens fan-out, loop-until-dry, tool-grounded seed findings, adversarial + self-verification, synthesized into one Confirmed/Suspected report with a verdict.',
  whenToUse: 'The single review path for any Rust diff/PR before commit or merge. Scales depth to the diff automatically — small diffs run cheap, large diffs run the full fan-out.',
  phases: [
    { title: 'Scout', detail: 'resolve the diff base, classify size/categories, pick lenses + rigor', model: 'haiku' },
    { title: 'Gate', detail: 'CI-aware mechanical gate + tool-grounded seed findings' },
    { title: 'Lenses', detail: 'parallel per-lens review with context expansion; loop-until-dry' },
    { title: 'Verify', detail: 'adversarial refutation + self-verification of each finding' },
    { title: 'Synthesize', detail: 'calibrate severities, completeness critic, one report' },
  ],
}

// ---- args ----
const baseArg = (args && typeof args === 'object' && args.base) ? String(args.base) : ''
const intentArg = (args && typeof args === 'object' && args.intent) ? String(args.intent) : ''
const postComments = !!(args && typeof args === 'object' && args.comment)

// ---- catalog ----
const ALL_LENSES = ['safety', 'errors', 'ownership', 'concurrency', 'performance', 'api-idioms', 'tests', 'intent']

// ---- shared schemas ----
const FINDING_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['severity', 'title', 'file', 'line', 'why', 'fix', 'blastRadius', 'source'],
  properties: {
    severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low', 'Info'] },
    title: { type: 'string', description: 'one-line what is wrong' },
    file: { type: 'string', description: 'path; empty string if not applicable' },
    line: { type: 'integer', description: '1-based line; 0 if not applicable' },
    why: { type: 'string', description: 'why it matters' },
    fix: { type: 'string', description: 'direction of the fix' },
    blastRadius: { type: 'string', description: 'callers affected / breaking-change note; empty if n/a' },
    source: { type: 'string', description: 'lens name or tool name that produced this' },
  },
}

const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['baseRef', 'sizeBucket', 'lenses', 'maxRounds', 'verifyVotes', 'lensModel', 'isLibrary', 'securitySensitive', 'intent', 'churn', 'notes'],
  properties: {
    baseRef: { type: 'string', description: 'git ref the diff was computed against; empty if none resolved' },
    sizeBucket: { type: 'string', enum: ['small', 'medium', 'large'] },
    lenses: { type: 'array', items: { type: 'string' }, description: 'subset of the lens catalog to run' },
    maxRounds: { type: 'integer', description: 'loop-until-dry cap: 1 for small, 2 for medium, 3 for large' },
    verifyVotes: { type: 'integer', description: 'skeptic votes for CRITICAL/HIGH findings (1 or 3); default-tier findings always get 1' },
    lensModel: { type: 'string', enum: ['sonnet', 'opus'], description: 'model for lens + verify agents' },
    isLibrary: { type: 'boolean', description: 'true if a published library crate (→ semver-checks)' },
    securitySensitive: { type: 'boolean' },
    intent: { type: 'string', description: 'what the change should do, from the brief/args; empty if unknown' },
    churn: { type: 'array', items: { type: 'string' }, description: 'hot/often-changed files to scrutinize; may be empty' },
    notes: { type: 'string', description: 'one line on what was detected' },
  },
}

const GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'provenance', 'failedChecks', 'seedFindings', 'notes'],
  properties: {
    status: { type: 'string', enum: ['pass', 'fail', 'unknown'] },
    provenance: { type: 'string', description: 'e.g. "build/test/clippy/fmt via CI #123; audit/deny local"' },
    failedChecks: { type: 'array', items: { type: 'string' } },
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
  required: ['refuted', 'citedLineMatches', 'reachable', 'reason'],
  properties: {
    refuted: { type: 'boolean', description: 'true if the finding does not hold up' },
    citedLineMatches: { type: 'boolean', description: 'true if the cited file:line actually contains what the finding claims' },
    reachable: { type: 'boolean', description: 'true if the path is reachable in production (not test/example-only)' },
    reason: { type: 'string' },
  },
}

// ================= Scout =================
phase('Scout')
const scout = await agent(
  `You are scouting a Rust diff to plan an elastic review. Use shell + read only — do NOT review yet.

1. Resolve the diff base. ${baseArg
    ? `Use \`${baseArg}\`.`
    : 'Try in order until one resolves: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`. If the tree has uncommitted changes, target those.'}
2. Inspect \`git diff --stat <base>...HEAD\` (and \`git status --porcelain\`). Set sizeBucket:
   small = a few files / < ~80 changed lines; large = many files / > ~400 lines or a public-API or unsafe-heavy change; medium otherwise.
3. lenses: choose from ${JSON.stringify(ALL_LENSES)}.
   - small: only the touched categories (minimum 2; always include 'safety' and the dominant category).
   - medium: the categories plausibly in play.
   - large: all of them.
   Decide what is "in play" from the diff: unsafe → ownership+safety; async/threads → concurrency; SQL/untrusted input → safety; loops/collections → performance; changed \`pub\` surface → api-idioms; new/changed tests → tests; always consider 'intent'.
4. maxRounds: small=1, medium=2, large=3. verifyVotes: small/medium=1, large=3. lensModel: small=sonnet, medium=sonnet, large=opus.
5. isLibrary: true if this crate is a published library (has \`[lib]\`/is named in a workspace as a lib and looks publishable) — best effort.
6. securitySensitive: true if the diff touches auth, crypto, input parsing, unsafe, FFI, or dependencies.
7. intent: ${intentArg ? `the caller provided: "${intentArg}". Refine it from the diff if needed.` : 'infer the change\'s purpose from the diff and any PR/commit messages; empty string if unclear.'}
8. churn: list up to 5 files in the diff that git shows as frequently changed (\`git log --oneline -n 50 -- <file> | wc -l\` is a rough proxy) — these get extra scrutiny. May be empty.`,
  { label: 'scout', schema: SCOUT_SCHEMA, model: 'haiku', effort: 'low' },
)

// Fail-safe defaults if scout was skipped or died.
const plan = {
  baseRef: scout?.baseRef ?? '',
  sizeBucket: scout?.sizeBucket ?? 'medium',
  lenses: (scout?.lenses?.length ? scout.lenses : ALL_LENSES),
  maxRounds: scout?.maxRounds ?? 2,
  verifyVotes: scout?.verifyVotes ?? 1,
  lensModel: scout?.lensModel ?? 'sonnet',
  isLibrary: scout?.isLibrary ?? false,
  securitySensitive: scout?.securitySensitive ?? true,
  intent: scout?.intent ?? intentArg,
  churn: scout?.churn ?? [],
}
log(scout?.notes ?? 'scout produced no result — assuming medium bucket, all lenses')

// ================= Gate + tool grounding =================
phase('Gate')
const gate = await agent(
  `You are establishing the mechanical gate for a Rust review, CI-aware, and collecting tool-grounded seed findings. Diff base: ${plan.baseRef ? `\`${plan.baseRef}\`` : 'uncommitted changes / most recent commit'}.

GATE (CI-aware, per the rust-review skill — load it):
1. Detect a PR + CI: \`gh pr checks --json name,state,bucket,link\` for the current branch. If gh is missing/unauthenticated/offline or no PR is found, fall through to the local gate.
2. For build/test/clippy/fmt: if a conclusive green required CI check covers it, treat it as PASSED and record provenance "via CI #<n>"; if any such check FAILED, set status=fail and list it in failedChecks. If pending/absent, run it locally (\`cargo fmt --check\`, \`cargo clippy --all-targets -- -D warnings\`, \`cargo test\`).
3. Security tools (\`cargo audit\`, \`cargo deny check\`) always run locally if installed (cheap, usually absent from CI). A vulnerability with a fix is a fail.
4. status = fail if any of fmt/clippy/test/build is red (CI or local); pass if all green; unknown if you could not establish it.

SEED FINDINGS (tool grounding — beyond the gate, scoped to the changed crates):
5. \`cargo clippy --all-targets -- -W clippy::pedantic -W clippy::nursery\` — turn each NEW pedantic/nursery diagnostic on changed lines into a seed finding (severity Low/Medium, source "clippy-pedantic"). Do not fail the gate on these.
${plan.isLibrary ? '6. This is a library: run `cargo semver-checks check-release` if installed; each reported break is a seed finding (severity High, source "semver-checks"). If not installed, log and skip.' : '6. Not a library — skip semver-checks.'}

Set provenance to a one-line summary like "clippy/test via CI #123; fmt/audit/deny local". Put gate failures in failedChecks (NOT seedFindings). Seed findings are clippy-pedantic / semver only.`,
  { label: 'gate', schema: GATE_SCHEMA, phase: 'Gate', effort: 'medium' },
)

const gateStatus = gate?.status ?? 'unknown'
const gateProvenance = gate?.provenance ?? 'gate not established'
const seedFindings = (gate?.seedFindings ?? []).map(f => ({ ...f, source: f.source || 'tool' }))
log(`Gate: ${gateStatus} — ${gateProvenance}${gate?.failedChecks?.length ? ` · failed: ${gate.failedChecks.join(', ')}` : ''}`)

if (gateStatus === 'fail') {
  return [
    `## Verdict`,
    `⛔ Block — mechanical gate is red.`,
    ``,
    `## Gate`,
    gateProvenance,
    gate.failedChecks?.length ? `\nFailed checks:\n${gate.failedChecks.map(c => `- ${c}`).join('\n')}` : '',
    ``,
    `Fix the gate before a semantic review is worthwhile.`,
  ].join('\n')
}

// ================= Lenses =================
const LENS_BRIEF = {
  safety: 'safety / injection / secrets: unwrap/expect/panic on reachable paths, unsafe without SAFETY, SQL/command injection, path traversal, hardcoded secrets, unbounded deserialization.',
  errors: 'error handling: recoverable failures handled with panic/unwrap, dropped #[must_use]/error values, Result-vs-panic, typed-error-vs-anyhow at API boundaries.',
  ownership: 'ownership & lifetimes: needless clone to satisfy the borrow checker, String where &str/impl AsRef suffices, Vec<T> where &[T] works, explicit lifetimes where elision applies.',
  concurrency: 'concurrency / async: blocking calls inside async, lock held across .await, unbounded channels, inconsistent lock order (deadlock), missing Send/Sync.',
  performance: 'performance: allocation in hot loops, to_string/to_owned where a borrow works, Vec::new+push where size is known, N+1 / repeated work in loops.',
  'api-idioms': 'API & idioms & docs: library returning Box<dyn Error>/anyhow, giant functions / deep nesting, wildcard match on a business enum, pub item without ///, #[allow] without justification, #![deny(warnings)] in source.',
  tests: 'tests & coverage QUALITY (not just presence): do new tests assert real behavior and error paths, or are they vacuous (assert!(true), no assertions)? New error path/branch with no test; bug fix with no regression test.',
  intent: 'intent / spec conformance: does the change actually do what it is supposed to do? Compare the diff against the stated intent; flag correct-looking code with wrong behavior, missed requirements, off-by-one against the spec.',
}

function lensPrompt(lens, priorSummary) {
  return `You are the **${lens}** review lens for a Rust diff. Review ONLY this slice; ignore everything else (other lenses cover it). Load the rust-review skill for the rubric and the rust-navigation skill for context expansion.

SLICE: ${LENS_BRIEF[lens] || lens}

Diff base: ${plan.baseRef ? `\`${plan.baseRef}\`` : 'uncommitted changes / most recent commit'}. Review with \`git diff ${plan.baseRef ? `--merge-base ${plan.baseRef}` : 'HEAD'} -- '*.rs'\`.
${plan.intent ? `INTENT (what the change should do): ${plan.intent}` : ''}
${plan.churn?.length ? `HOT FILES (scrutinize harder): ${plan.churn.join(', ')}` : ''}

CONTEXT EXPANSION (required): for each finding, trace callers / impls / error paths of the changed symbols (Grep/Glob + LSP) before judging — do not read the diff in isolation. If a finding depends on code outside the diff, say so in \`why\`.
BLAST-RADIUS (required): for each changed PUBLIC symbol you touch, note how many callers are affected and set a breaking-change flag in \`blastRadius\`.
CONFIDENCE: report everything you suspect, located. Do NOT self-censor borderline findings — verification happens downstream. Each finding needs file:line (use file:"" line:0 only when truly not locatable).
${plan.tests === undefined ? '' : ''}${lens === 'tests' && plan.sizeBucket === 'large' ? 'If `cargo mutants` is installed, you MAY run it time-boxed on the changed files to find weak tests; skip silently if absent.' : ''}

ALREADY-FOUND (do not repeat; look for what these MISSED):
${priorSummary}

Return {lens, findings[]}.`
}

phase('Lenses')
const round1 = (await parallel(plan.lenses.map(lens => () =>
  agent(lensPrompt(lens, 'none yet'), { label: `lens:${lens}`, agentType: 'craft:rust-reviewer', phase: 'Lenses', schema: FINDINGS_SCHEMA, model: plan.lensModel }),
))).filter(Boolean)

const allFindings = round1.flatMap(r => (r.findings || []).map(f => ({ ...f, source: f.source || r.lens })))
log(`Lenses round 1: ${allFindings.length} raw findings from ${round1.length} lenses`)

// Temporary terminal return — replaced in Task 4.
return JSON.stringify({ gateProvenance, seed: seedFindings.length, lensFindings: allFindings.length }, null, 2)
