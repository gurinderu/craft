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

// Temporary terminal return for this task — replaced in Task 2.
return JSON.stringify(plan, null, 2)
