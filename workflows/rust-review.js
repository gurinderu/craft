export const meta = {
  name: 'rust-review',
  description: 'Elastic deep review of a Rust diff — scout-scaled lens fan-out, loop-until-dry, tool-grounded seed findings, adversarial + self-verification, synthesized into one Confirmed/Suspected report with a verdict.',
  whenToUse: 'The single review path for any Rust diff/PR before commit or merge. Scales depth to the diff automatically — small diffs run cheap, large diffs run the full fan-out.',
  phases: [
    { title: 'Scout', detail: 'resolve the diff base, classify size/categories, pick lenses + rigor', model: 'haiku' },
    { title: 'Gate', detail: 'CI-aware mechanical gate + tool-grounded seed findings (clippy-pedantic / semver / semgrep)' },
    { title: 'Lenses', detail: 'parallel per-lens review with context expansion; loop-until-dry' },
    { title: 'Verify', detail: 'adversarial refutation + self-verification of each finding' },
    { title: 'Synthesize', detail: 'calibrate severities, completeness critic, one report' },
  ],
}

// ---- args ----
const baseArg = (args && typeof args === 'object' && args.base) ? String(args.base) : ''
const intentArg = (args && typeof args === 'object' && args.intent) ? String(args.intent) : ''
const postComments = !!(args && typeof args === 'object' && args.comment)
const pathArg = (args && typeof args === 'object' && args.path) ? String(args.path) : ''   // optional crate-scope (audit per-crate fan-out)
const viaArg = (args && typeof args === 'object' && args._via) ? String(args._via) : ''   // set by a parent workflow (e.g. rust-audit)
const strict = !!(args && typeof args === 'object' && args.strict)   // harsh maintainability mode: confirmed maintainability findings become presumptive blockers

// ---- catalog ----
const ALL_LENSES = ['safety', 'errors', 'ownership', 'concurrency', 'performance', 'api-idioms', 'maintainability', 'tests', 'intent']

// ---- shared schemas ----
const FINDING_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['severity', 'title', 'file', 'line', 'why', 'fix', 'blastRadius', 'source', 'ruleId'],
  properties: {
    severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low', 'Info'] },
    title: { type: 'string', description: 'one-line what is wrong' },
    file: { type: 'string', description: 'path; empty string if not applicable' },
    line: { type: 'integer', description: '1-based line; 0 if not applicable' },
    why: { type: 'string', description: 'why it matters' },
    fix: { type: 'string', description: 'direction of the fix' },
    blastRadius: { type: 'string', description: 'callers affected / breaking-change note; empty if n/a' },
    source: { type: 'string', description: 'lens name or tool name that produced this' },
    ruleId: { type: 'string', description: 'catalog rule ID from the rust-review skill rules.md (e.g. "CON-003") if the finding maps to one; empty string otherwise' },
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

// ---- run-record helpers (VERBATIM mirror of lib/run-record.mjs — the sandbox can't import; keep in sync) ----
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
// finalVerdict is workflow-local — NOT part of the lib/run-record.mjs mirror above.
// In strict mode the maintainability bar is a presumption of block: any Confirmed
// maintainability finding at Medium or above escalates the verdict to Block. Outside strict mode
// the base verdict stands (maintainability findings are at most a Warning).
function finalVerdict(confirmed) {
  if (strict && confirmed.some(f => (f.source || '') === 'maintainability'
    && (f.severity === 'Critical' || f.severity === 'High' || f.severity === 'Medium'))) return 'Block'
  return reviewVerdict(confirmed)
}
function indexProjection(r) {
  return {
    schemaVersion: r.schemaVersion, runtime: r.runtime ?? null, ts: r.ts, kind: r.kind, name: r.name,
    project: r.project, commit: r.commit, dirty: r.dirty,
    verdict: r.verdict, findingsTotal: r.findings ? r.findings.total : 0,
    nested: r.nested, via: r.via, outputTokens: r.outputTokens ?? null,
  }
}
async function logRun(record) {
  const index = indexProjection(record)
  await agent(
    `You are the craft observability logger. Persist ONE run record to the global store \`~/.craft/runs/\`. This is mechanical IO — do not analyze.
Steps:
1. \`mkdir -p ~/.craft/runs\`.
2. Compute: TS=\`date -u +%Y-%m-%dT%H-%M-%SZ\`; PROJECT=\`pwd\`; COMMIT=\`git rev-parse --short HEAD 2>/dev/null\` (empty string if not a git repo); DIRTY=true if \`git status --porcelain\` prints anything, else false.
3. Take RECORD below, add fields {"ts":TS,"project":PROJECT,"commit":COMMIT,"dirty":DIRTY}, and write the result as pretty JSON to \`~/.craft/runs/<TS>-<kind>-<name>.json\` (kind and name are fields in RECORD).
4. Take INDEX below, add the same four fields, and append it as ONE compact line (single atomic \`>>\`) to \`~/.craft/runs/index.jsonl\`.
5. If \`~/.craft/runs/README.md\` does not exist, create it describing the store: "craft run records. index.jsonl = one compact JSON line per run (load with jq); <ts>-<kind>-<name>.json = full per-run detail. Common fields: schemaVersion, ts, kind (workflow|agent), name, project, commit, dirty, verdict, findings{total,bySeverity}, nested, via. Workflows add scout/dimensions/verification/notRun/outputTokens; agents add toolsRun." Include two jq examples: \`jq -s 'group_by(.name)[]|{name:.[0].name,runs:length}' index.jsonl\` and \`jq 'select(.verdict|test("Block"))' index.jsonl\`.
Best-effort: if anything fails, report it but do NOT error the run.

RECORD:
${JSON.stringify(record, null, 2)}

INDEX:
${JSON.stringify(index)}`,
    { label: 'log-run', phase: 'Synthesize', model: 'haiku', effort: 'low' },
  )
}

// ================= Scout =================
phase('Scout')
const scout = await agent(
  `You are scouting a Rust diff to plan an elastic review. Use shell + read only — do NOT review yet.${pathArg ? `\n\nSCOPE: review ONLY the crate at \`${pathArg}\`. Pass \`-- ${pathArg}\` to every \`git diff\` command below, consider only files under that path, and name the crate in your notes.` : ''}

1. Resolve the diff base. ${baseArg
    ? `Use \`${baseArg}\`.`
    : 'Try in order until one resolves: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`. If the tree has uncommitted changes, target those.'}
2. Inspect \`git diff --stat <base>...HEAD\` (and \`git status --porcelain\`). Set sizeBucket:
   small = a few files / < ~80 changed lines; large = many files / > ~400 lines or a public-API or unsafe-heavy change; medium otherwise.
3. lenses: choose from ${JSON.stringify(ALL_LENSES)}.
   - small: only the touched categories (minimum 2; always include 'safety' and the dominant category).
   - medium: the categories plausibly in play.
   - large: all of them.
   Decide what is "in play" from the diff: unsafe → ownership+safety; async/threads → concurrency; SQL/untrusted input → safety; loops/collections → performance; changed \`pub\` surface → api-idioms; new/changed tests → tests; new branching / growing files / large refactor → maintainability; always consider 'intent'.${strict ? '\n   STRICT MODE is on: ALWAYS include \'maintainability\' in lenses regardless of size.' : ''}
4. maxRounds: small=1, medium=2, large=3. verifyVotes: small/medium=1, large=3. lensModel: opus for all sizes (review reasoning runs on Opus; depth still scales via maxRounds/verifyVotes/lens count).
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
  lensModel: scout?.lensModel ?? 'opus',
  isLibrary: scout?.isLibrary ?? false,
  securitySensitive: scout?.securitySensitive ?? true,
  intent: scout?.intent ?? intentArg,
  churn: scout?.churn ?? [],
}
// Strict mode always runs the maintainability lens, whatever the scout picked.
if (strict && !plan.lenses.includes('maintainability')) plan.lenses.push('maintainability')

// Security-sensitive rigor floor. The most consequential failure mode is the Scout (haiku, on
// `git diff --stat`) under-bucketing a security-touching change: a thin lens set with
// verifyVotes=1 means a real High has to survive a single skeptic that defaults to "refuted".
// When the change touches auth/crypto/input-parsing/unsafe/FFI/deps we do NOT let the size
// heuristic gate rigor — run every lens, require a 3-skeptic majority for High/Critical, and
// give loop-until-dry at least two rounds. (The completeness critic is also forced below.)
if (plan.securitySensitive) {
  for (const l of ALL_LENSES) if (!plan.lenses.includes(l)) plan.lenses.push(l)
  plan.verifyVotes = Math.max(plan.verifyVotes, 3)
  plan.maxRounds = Math.max(plan.maxRounds, 2)
}

// Negative-space lens: the bug the diff ENABLES in code it did NOT touch (a new status/type
// pre-existing endpoints mutate blindly; a latent bug the diff makes reachable). Diff-anchored
// lenses structurally cannot see these. Run it where new reachable surface tends to appear —
// security-sensitive or large changes.
if ((plan.securitySensitive || plan.sizeBucket === 'large') && !plan.lenses.includes('negative-space')) {
  plan.lenses.push('negative-space')
}

log(`${scout?.notes ?? 'scout produced no result — assuming medium bucket, all lenses'}${strict ? ' · STRICT maintainability mode' : ''}${plan.securitySensitive ? ' · SECURITY rigor floor (all lenses, 3-vote verify)' : ''}${plan.lenses.includes('negative-space') ? ' · +negative-space' : ''}`)

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

7. SAST seed (semgrep) — decide what configs apply, then run only if any do:
   - If a \`./semgrep/\` rules dir exists in the repo, ALWAYS include \`--config=./semgrep/\` (repo-specific banned-API/taint rules — the whole point of keeping them in-repo).
${plan.securitySensitive
    ? '   - This diff IS security-sensitive: also include `--config=p/rust --config=p/secrets`.'
    : '   - This diff is NOT security-sensitive: do not pull the generic rulesets; rely on `./semgrep/` only (skip step 7 entirely if that dir is absent).'}
   If at least one config applies and \`semgrep\` is installed, scope it to the changed Rust files (\`git diff --name-only ${plan.baseRef ? `--merge-base ${plan.baseRef}` : 'HEAD'} -- '*.rs'\`) and run \`semgrep --error <configs> <files>\`. Turn each result into a seed finding (source "semgrep"; map semgrep ERROR→High, WARNING→Medium, INFO→Low). These are SEEDS, never gate failures — semgrep taint/secrets over-reports, and downstream verification refutes the false positives. If semgrep is absent or no config applies, log and skip.

8. **Dependency context** — review against the crate versions the project ACTUALLY pins, not against crates-in-the-abstract. Resolve them: \`cargo metadata --format-version 1\` (or read \`Cargo.lock\`) and match the external crates the changed files \`use\` to their locked versions. For any nontrivial dependency the diff touches, check whether the usage is correct *for that pinned version* — a since-deprecated/removed/renamed API, a changed default, a known footgun of that exact version. Consult context7 for the crate's version-specific docs instead of trusting memory. Turn a genuine version-specific misuse into a seed finding (source "dep-context", severity Medium, ruleId "DEP-001"). Known-vulnerable versions are already covered by \`cargo audit\` (ruleId "DEP-002") — do not duplicate. Best-effort: skip silently if \`cargo metadata\` fails or the diff touches no external crate.

Set provenance to a one-line summary like "clippy/test via CI #123; fmt/audit/deny local". Put gate failures in failedChecks (NOT seedFindings). Seed findings come from clippy-pedantic / semver / semgrep / dep-context only. On every seed finding set \`ruleId\` to the matching rust-review rules.md catalog ID (e.g. "DEP-001") or "" if none fits.`,
  { label: 'gate', schema: GATE_SCHEMA, phase: 'Gate', effort: 'medium' },
)

const gateStatus = gate?.status ?? 'unknown'
const gateProvenance = gate?.provenance ?? 'gate not established'
const seedFindings = (gate?.seedFindings ?? []).map(f => ({ ...f, source: f.source || 'tool' }))
log(`Gate: ${gateStatus} — ${gateProvenance}${gate?.failedChecks?.length ? ` · failed: ${gate.failedChecks.join(', ')}` : ''}`)

// Common fields for every rust-review record; callers pass the path-specific extras.
function reviewRecord(extra) {
  return {
    schemaVersion: 1,
    runtime: 'claude-code',
    kind: 'workflow',
    name: 'rust-review',
    nested: !!viaArg,
    via: viaArg || null,
    scout: { size: plan.sizeBucket, lenses: plan.lenses, model: plan.lensModel, maxRounds: plan.maxRounds, verifyVotes: plan.verifyVotes },
    gate: { status: gateStatus, provenance: gateProvenance },
    outputTokens: budget.spent(),
    ...extra,
  }
}

if (gateStatus === 'fail') {
  await logRun(reviewRecord({ verdict: 'Block', findings: summarizeFindings([]), dimensions: [], verification: null, notRun: [], failedChecks: gate.failedChecks || [] }))
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
  maintainability: 'maintainability & structural simplification (load the refactoring skill): missed code judo — a behavior-preserving reframing using the existing architecture that would make this change dramatically simpler or delete a whole category of complexity; file pushed across ~700 lines (decomposition smell); ad-hoc conditional / one-off branch / scattered special-case spliced into an unrelated or shared flow instead of a dedicated abstraction; needless optionality (Option that always holds), as-casts where From/TryFrom belongs, Box<dyn Any>/downcasting where a typed model fits. Flag only concrete, behavior-preserving restructurings the author could have taken — not hypothetical rewrites.',
  tests: 'tests & coverage QUALITY (not just presence): do new tests assert real behavior and error paths, or are they vacuous (assert!(true), no assertions)? New error path/branch with no test; bug fix with no regression test.',
  intent: 'intent / spec conformance: does the change actually do what it is supposed to do? Compare the diff against the stated intent; flag correct-looking code with wrong behavior, missed requirements, off-by-one against the spec.',
  'negative-space': 'negative space / cross-surface interaction: the bug the diff ENABLES in UNCHANGED code. A new status/type/enum-variant/column that pre-existing endpoints mutate blindly; a latent bug in an unchanged helper the diff makes reachable for the first time. Diff-anchored lenses cannot see these — this lens works outward from the new surface into the untouched tree.',
}

// The negative-space lens does the OPPOSITE of every other lens: it does not review the changed
// lines, it works outward from the new surface into the UNCHANGED tree. Its findings anchor to the
// offending pre-existing file:line (real and verifiable), not to a diff line.
function negativeSpacePrompt(priorSummary) {
  return `You are the **negative-space** review lens for a Rust change. Unlike the other lenses, your job is NOT to review the changed lines — it is to find the bug the diff ENABLES in code it did NOT touch. Load the rust-navigation skill for whole-repo search; use Grep/Glob across the ENTIRE tree, not just the diff.

Diff base: ${plan.baseRef ? `\`${plan.baseRef}\`` : 'uncommitted changes / most recent commit'}.
${plan.intent ? `INTENT (what the change should do): ${plan.intent}` : ''}

METHOD — follow in order:
1. Inventory the NEW surface the diff introduces. Read the FULL diff including non-Rust files: \`git diff ${plan.baseRef ? `--merge-base ${plan.baseRef}` : 'HEAD'}\`. List every new: enum variant / status value / DB column / table / migration / public fn / route / struct field. ALSO list any UNCHANGED function the diff now calls for the first time (a newly-reachable helper).
2. For EACH item, Grep the UNCHANGED tree for existing code that reads, lists, updates, deletes, cascades, serializes, orders, or authorizes that shape. Ask: does this pre-existing path violate an invariant the new feature assumes?
   - A new "Draft"/"Pending"/"Reserved" status: do pre-existing list / update / delete / cascade paths exclude or guard it, or mutate it blindly and wedge the new flow?
   - A newly-reachable helper: is there a latent bug (SQL correlated-subquery column scoping / a missing owner or tenant filter / ignored rows_affected) that was dormant only because nothing called it?
   - A new column / migration: do existing \`SELECT *\` / \`ORDER BY\` / index / backfill paths interact badly, or assume data the old code could have violated?
   - New serde/utoipa surface: does an UNCHANGED shared DTO serialize the same field with different casing, freezing an asymmetric wire contract?
3. Report each concrete violation ANCHORED TO THE UNCHANGED file:line that is actually wrong (the offending old handler / query / cascade / DTO), not the diff line. That anchor is real — cite it precisely so it can be verified.

Only report a violation you can name a concrete reachable path for. Put the triggering surface in \`blastRadius\`; in \`why\`, state the invariant and the exact old path that breaks it. Do NOT restate findings already in the ALREADY-FOUND set below — look for what they MISSED.

ALREADY-FOUND (from other lenses / earlier rounds — do not repeat):
${priorSummary}

Return {lens: "negative-space", findings: [...]} using the shared finding schema (file/line/severity/title/why/blastRadius/ruleId). Set \`ruleId\` to the matching rules.md catalog ID (often SAF-*/CON-*/ERR-* for cross-surface bugs) or "" if none fits. Observability: the workflow records this run — do NOT write your own record.`
}

function lensPrompt(lens, priorSummary) {
  if (lens === 'negative-space') return negativeSpacePrompt(priorSummary)
  return `You are the **${lens}** review lens for a Rust diff. Review ONLY this slice; ignore everything else (other lenses cover it). Load the rust-review skill for the rubric and the rust-navigation skill for context expansion.

SLICE: ${LENS_BRIEF[lens] || lens}
${strict && lens === 'maintainability' ? '\nSTRICT MODE: apply the maintainability bar as a *presumption of block* — each maintainability issue is a blocker unless the author clearly justified it in the diff or brief. Hold the change to: no structural regression, no obvious simplification missed, no unjustified file-size explosion, no spaghetti-growth, no hacky/magical abstraction. Be harsh, but stay grounded — every finding still needs a concrete cited file:line and survives refutation; do not invent issues.\n' : ''}
Diff base: ${plan.baseRef ? `\`${plan.baseRef}\`` : 'uncommitted changes / most recent commit'}. Review with \`git diff ${plan.baseRef ? `--merge-base ${plan.baseRef}` : 'HEAD'} -- '*.rs'\`.
${plan.intent ? `INTENT (what the change should do): ${plan.intent}` : ''}
${plan.churn?.length ? `HOT FILES (scrutinize harder): ${plan.churn.join(', ')}` : ''}

CONTEXT EXPANSION (required): for each finding, trace callers / impls / error paths of the changed symbols (Grep/Glob + LSP) before judging — do not read the diff in isolation. If a finding depends on code outside the diff, say so in \`why\`.
BLAST-RADIUS (required): for each changed PUBLIC symbol you touch, note how many callers are affected and set a breaking-change flag in \`blastRadius\`.
CONFIDENCE: report everything you suspect, located. Do NOT self-censor borderline findings — verification happens downstream. Each finding needs file:line (use file:"" line:0 only when truly not locatable).
RULE ID (required field): set \`ruleId\` to the matching catalog ID from the rust-review skill's rules.md (e.g. "CON-003", "SAF-001") when the finding maps to a listed rule; use "" for a novel finding with no catalog rule. Do not force a bad fit.
${lens === 'tests' && plan.sizeBucket === 'large' ? 'If `cargo mutants` is installed, you MAY run it time-boxed on the changed files to find weak tests; skip silently if absent.' : ''}

ALREADY-FOUND (do not repeat; look for what these MISSED):
${priorSummary}

Return {lens, findings[]}.

Observability: the rust-review workflow records this run — do NOT write your own record.`
}

function key(f) {
  return `${(f.file || '').toLowerCase()}:${f.line || 0}:${(f.title || '').toLowerCase().replace(/\s+/g, ' ').trim()}`
}

phase('Lenses')
const seen = new Set()
const pool = []
// Seed findings (from the gate) enter the pool first and seed the dedup set.
for (const f of seedFindings) {
  const k = key(f)
  if (!seen.has(k)) { seen.add(k); pool.push(f) }
}

const notRun = []   // stages/lenses that were IN SCOPE but did not complete (budget or terminal error) → verdict marked INCOMPLETE
const ranAtLeastOnce = new Set()   // lenses that returned a result in some round; the rest silently dropped
let dry = false
for (let round = 1; round <= plan.maxRounds && !dry; round++) {
  const priorSummary = pool.length
    ? pool.map(f => `${f.file || '?'}:${f.line || 0} ${f.title}`).join('\n')
    : 'none yet'
  const results = (await parallel(plan.lenses.map(lens => () =>
    agent(lensPrompt(lens, priorSummary), { label: `lens:${lens} r${round}`, agentType: 'craft:rust-reviewer', phase: 'Lenses', schema: FINDINGS_SCHEMA, model: plan.lensModel }),
  ))).filter(Boolean)
  for (const r of results) ranAtLeastOnce.add(r.lens)
  const fresh = []
  for (const r of results) {
    for (const f0 of (r.findings || [])) {
      // Force source to the lens name: the per-dimension tally and the strict-mode
      // maintainability escalation key off source, and a worker may mislabel it (e.g. "refactoring").
      const f = { ...f0, source: r.lens }
      const k = key(f)
      if (!seen.has(k)) { seen.add(k); fresh.push(f) }
    }
  }
  pool.push(...fresh)
  log(`Lenses round ${round}: +${fresh.length} new (pool ${pool.length})`)
  if (!fresh.length) dry = true
}

// Lenses that never returned a result in any round were silently dropped — a null from parallel()
// means the agent died (budget hard-ceiling after retries, or a terminal API error), NOT a clean
// pass (a clean pass returns {lens, findings: []}). Flag them so a budget-nuked run cannot read as
// complete — most dangerously as a false "Approve — no findings" below.
const droppedLenses = plan.lenses.filter(l => !ranAtLeastOnce.has(l))
if (droppedLenses.length) {
  notRun.push(`lenses that never returned (${droppedLenses.join('/')})`)
  log(`⚠️ ${droppedLenses.length} lens(es) never returned — likely budget or terminal error: ${droppedLenses.join(', ')}. Review marked INCOMPLETE.`)
}

if (!pool.length) {
  await logRun(reviewRecord({ verdict: `Approve${notRun.length ? ' (INCOMPLETE)' : ''}`, findings: summarizeFindings([]), dimensions: [], verification: null, notRun }))
  const verdictLine = notRun.length
    ? `⚠️ Approve (INCOMPLETE) — gate ${gateStatus}; no findings survived, but ${notRun.join('; ')} — coverage is NOT trustworthy, re-run with more budget.`
    : `✅ Approve — gate ${gateStatus}; no findings across ${plan.lenses.length} lenses.`
  return [`## Verdict`, verdictLine, ``, `## Gate`, gateProvenance].join('\n')
}

// ================= Verify =================
phase('Verify')
function verifyPrompt(f, idx) {
  return `You are skeptic #${idx + 1} trying to REFUTE a Rust review finding. Default to refuted=true when uncertain — only let real findings through.

FINDING: [${f.severity}] ${f.title}
  at ${f.file || '?'}:${f.line || 0}
  why: ${f.why}
  source: ${f.source}

Open the cited file and check:
1. citedLineMatches: does ${f.file || '?'}:${f.line || 0} actually contain what the finding claims? (If the citation is wrong/hallucinated → citedLineMatches=false.)
2. reachable: is this code reachable in production, or is it test/example/dead code? (Test-only → reachable=false.)
3. refuted: taking 1 and 2 together plus your judgement, does the finding NOT hold up?

Return {refuted, citedLineMatches, reachable, reason}.`
}

// Reusable: verify a pool of findings → {confirmed, suspected, dropped}.
// Called here for the lens pool, and again in Task 6 for the critic's follow-up findings.
async function verifyPool(items) {
  const judged = await parallel(items.map(f => () => {
    const isHigh = f.severity === 'Critical' || f.severity === 'High'
    const votes = isHigh ? Math.max(1, plan.verifyVotes) : 1
    return parallel(Array.from({ length: votes }, (_unused, i) => () =>
      agent(verifyPrompt(f, i), { label: `verify:${f.file || '?'}:${f.line || 0}#${i + 1}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: plan.lensModel }),
    )).then(vs => {
      const v = vs.filter(Boolean)
      if (!v.length) return { ...f, tier: 'suspected' } // verification died → don't drop, demote
      const half = v.length / 2
      const lineOk = v.filter(x => x.citedLineMatches).length >= Math.ceil(half)
      const reach = v.filter(x => x.reachable).length >= Math.ceil(half)
      const refutes = v.filter(x => x.refuted).length
      let tier
      if (!lineOk) tier = 'refuted'            // hallucinated citation
      else if (refutes > half) tier = 'refuted'
      else if (reach && refutes === 0) tier = 'confirmed'
      else tier = 'suspected'
      return { ...f, tier }
    })
  }))
  const vp = judged.filter(Boolean)
  return {
    confirmed: vp.filter(f => f.tier === 'confirmed'),
    suspected: vp.filter(f => f.tier === 'suspected'),
    dropped: vp.filter(f => f.tier === 'refuted').length,
  }
}

// `let` so the Task 6 completeness critic can extend these with follow-up findings.
let { confirmed, suspected, dropped } = await verifyPool(pool)
log(`Verify: ${confirmed.length} confirmed · ${suspected.length} suspected · ${dropped} refuted`)

// ================= Synthesize =================
phase('Synthesize')

// Completeness critic WITH bounded follow-up (large bucket, budget-gated).
// The critic names lenses that should have run but didn't; we re-run those once,
// dedup against everything already seen, verify them through verifyPool, and merge
// the survivors into confirmed/suspected. Bounded: one extra round, only lenses from
// the catalog not yet run, and only while the budget allows.
const CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['missingLenses', 'notes'],
  properties: {
    missingLenses: { type: 'array', items: { type: 'string' }, description: 'lenses from the candidate list that should also run; empty if coverage is complete' },
    notes: { type: 'string', description: 'one line on anything else likely missed, or "coverage complete"' },
  },
}

let criticNotes = ''
const criticInScope = plan.sizeBucket === 'large' || plan.securitySensitive
if (criticInScope && (!budget.total || budget.remaining() > 90000)) {
  const candidates = ALL_LENSES.filter(l => !plan.lenses.includes(l))
  const critic = await agent(
    `You are a completeness critic for a Rust review of the diff (base ${plan.baseRef || 'HEAD'}).
Lenses already run: ${plan.lenses.join(', ')}. Confirmed: ${confirmed.length}, Suspected: ${suspected.length}.
Name any review lens that was NOT run but SHOULD be, given what the diff touches — choose ONLY from: ${JSON.stringify(candidates)}.
Also note in one line anything else likely missed (a changed file no finding touched, a claim left unverified). If coverage is complete, return missingLenses: [] and notes: "coverage complete".`,
    { label: 'critic', phase: 'Synthesize', schema: CRITIC_SCHEMA, effort: 'low' },
  )
  criticNotes = critic?.notes ?? ''
  const followups = (critic?.missingLenses ?? []).filter(l => candidates.includes(l))
  if (followups.length && (!budget.total || budget.remaining() > 60000)) {
    log(`Completeness critic → follow-up lenses: ${followups.join(', ')}`)
    const priorSummary = `Earlier lenses already produced ${pool.length} findings — do NOT repeat them; surface only what your lens would add.`
    const extra = (await parallel(followups.map(lens => () =>
      agent(lensPrompt(lens, priorSummary), { label: `lens:${lens} (critic)`, agentType: 'craft:rust-reviewer', phase: 'Synthesize', schema: FINDINGS_SCHEMA, model: plan.lensModel }),
    ))).filter(Boolean).flatMap(r => r.findings || [])
    const fresh = extra.filter(f => { const k = key(f); if (seen.has(k)) return false; seen.add(k); return true })
    if (fresh.length) {
      const v = await verifyPool(fresh)
      confirmed = confirmed.concat(v.confirmed)
      suspected = suspected.concat(v.suspected)
      dropped += v.dropped   // keep the refuted tally complete so totalVerified/refuteRate stay accurate
      log(`Critic follow-up: +${v.confirmed.length} confirmed · +${v.suspected.length} suspected · ${v.dropped} refuted`)
    }
  } else if (followups.length) {
    notRun.push(`critic follow-up lenses (${followups.join('/')})`)
    log(`Budget low (~${Math.round(budget.remaining() / 1000)}k left) — SKIPPED critic follow-up lenses: ${followups.join(', ')}. Review marked INCOMPLETE.`)
  }
} else if (criticInScope) {
  notRun.push('completeness-critic')
  log(`Budget low (~${Math.round(budget.remaining() / 1000)}k left) — SKIPPED completeness critic (in scope: ${plan.securitySensitive ? 'security-sensitive' : 'large'}). Review marked INCOMPLETE.`)
}

const report = await agent(
  `You are consolidating a Rust review into ONE markdown report. Do NOT invent findings — only use what is given.

VERDICT RULE: the verdict is driven ONLY by Confirmed findings.
- ⛔ Block if any Confirmed Critical or High.
- ⚠️ Warning if Confirmed Medium only.
- ✅ Approve if no Confirmed Critical/High/Medium.
Suspected findings NEVER change the verdict — they are surfaced for the author.${strict ? '\nSTRICT MODE: the maintainability bar is a presumption of block — if ANY Confirmed finding has source "maintainability" at Medium or above, the verdict is ⛔ Block (state in the verdict line that strict maintainability mode escalated it).' : ''}

CALIBRATE severities across the Confirmed set so the same kind of issue is not Critical in one place and Medium in another; adjust outliers and say so in one line if you do.

Produce, in order:
1. \`## Verdict\` — one line (emoji + reason).${notRun.length ? ` Append " · ⚠️ INCOMPLETE — the token budget cut the review short before these ran: ${notRun.join('; ')}; findings may be undercounted." to the verdict line.` : ''}
2. \`## Gate\` — ${JSON.stringify(gateProvenance)}.
3. \`## Confirmed\` — findings by severity (Critical first), each as \`severity · file:line · [ruleId] · what · why · fix\` and a blast-radius note when present. Include the \`ruleId\` in brackets when the finding has a non-empty one; omit the brackets otherwise.
4. \`## Suspected (needs confirmation)\` — same format; omit the section if empty.
5. \`## Fix first\` — the few highest-leverage Confirmed items.
${criticNotes && criticNotes.trim() && criticNotes.trim() !== 'coverage complete' ? `6. \`## Coverage gaps\` — surface verbatim: ${JSON.stringify(criticNotes)}` : ''}

CONFIRMED (JSON): ${JSON.stringify(confirmed, null, 2)}

SUSPECTED (JSON): ${JSON.stringify(suspected, null, 2)}`,
  { label: 'synthesis', phase: 'Synthesize', effort: 'medium' },
)

// Optional: post Confirmed findings as inline PR comments (lever D, best-effort).
if (postComments && confirmed.length) {
  await agent(
    `Post these Confirmed Rust-review findings as inline comments on the current branch's PR using \`gh\`. If gh is missing/unauthenticated or there is no PR, do nothing and report that — never fail.
For each finding with a real file:line, add a review comment "[severity] why — fix" anchored to that file:line. Findings:
${JSON.stringify(confirmed.map(f => ({ file: f.file, line: f.line, severity: f.severity, why: f.why, fix: f.fix })), null, 2)}`,
    { label: 'pr-comments', phase: 'Synthesize', effort: 'low' },
  )
}

const allReviewFindings = confirmed.concat(suspected)
const totalVerified = confirmed.length + suspected.length + dropped
await logRun(reviewRecord({
  verdict: finalVerdict(confirmed) + (notRun.length ? ' (INCOMPLETE)' : ''),
  findings: summarizeFindings(allReviewFindings),
  dimensions: plan.lenses.map(l => {
    const s = summarizeFindings(confirmed.filter(f => (f.source || '') === l))
    return { dimension: l, verdict: '', findingCount: s.total, bySeverity: s.bySeverity }
  }),
  verification: { candidates: totalVerified, confirmed: confirmed.length, refuteRate: totalVerified ? Math.round((dropped / totalVerified) * 100) / 100 : 0 },
  notRun,
}))

return report
