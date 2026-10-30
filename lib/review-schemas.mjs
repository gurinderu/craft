// The JSON schemas the review engine (src/review.js) hands its agents, and the shapes of their answers:
// imported by the engine and by the tests, so a test reads the schema the engine dispatches.
import { HARM_LEVELS } from './harm-levels.mjs'

/**
 * A JSON schema handed to agent(), tagged with the shape the sandbox validates the answer into. The tag
 * is never set at runtime; it only lets `ragent` return `T | null` for the schema it was given.
 * @template T
 * @typedef {{ type: string, readonly __yields?: T, [k: string]: unknown }} Schema
 */
/**
 * The answers of the schema'd agents, one per schema — each mirrors its schema's `required` and
 * optional properties exactly.
 * @typedef {{ runner: string, blockers: string[], missingTools: string[], ciCovers: string[], probes: Array<{ source: string, calls: number }>, partial: boolean, notes: string }} PreflightAnswer  PREFLIGHT_SCHEMA
 * @typedef {{ severity: 'Critical' | 'High' | 'Medium' | 'Low' | 'Info', title: string, file: string, line: number, why: string, whereChecked: string, fix: string, blastRadius: string, source: string, ruleId: string, toolRule?: string, fp?: string, symbol?: string, tier?: string, disposition?: string, deletionOrRecoveryPath?: boolean, harm?: string, harmLevel?: string, repoRule?: { file: string, text: string } }} FindingAnswer  FINDING_ITEM
 * @typedef {{ fp: string, file: string, line: number, symbol: string, severity: string, tier: string, disposition: string, source: string, sources?: string[], ruleId: string, title: string, why: string, whyRef?: { record: string, fp: string }, deferral?: { id: string, reason: string, who: string, when: string, link: string, commit: string } }} LedgerAnswer  LEDGER_ITEM
 * @typedef {{ found: boolean, round: number, head: string, ledger: LedgerAnswer[], ledgerCount: number, reason: string, priorFindings: number, journalSourced: boolean, sameFpBasis?: boolean, fpBasisKnown?: boolean, priorFpRevisions?: number[], priorFpRevisionsCheck?: string }} PriorRoundAnswer  PRIOR_ROUND_SCHEMA
 * @typedef {{ baseRef: string, files: string[], spec: string, branch: string, head: string, baseIsHead?: boolean, notes: string }} DetectAnswer  DETECT_SCHEMA
 * @typedef {{ sizeBucket: 'small' | 'medium' | 'large', lenses: string[], isLibrary: boolean, securitySensitive: boolean, intent: string, churn: string[], repoRules?: string[], notes: string, surfaces?: { crossBoundarySymbol?: boolean, wireForm?: boolean, invariantType?: boolean } }} ScoutAnswer  SCOUT_SCHEMA
 * @typedef {{ status: 'pass' | 'fail' | 'unknown', provenance: string, failedChecks: string[], carriedChecks: string[], seedFindings: FindingAnswer[], notes: string }} GateAnswer  GATE_SCHEMA
 * @typedef {{ lens: string, findings: FindingAnswer[] }} FindingsAnswer  FINDINGS_SCHEMA
 * @typedef {{ refuted: boolean, citedLineMatches: boolean, reachable: boolean, premiseSupported: boolean, reason: string, harmSupported?: boolean, confirmedHarmLevel?: string }} VerdictAnswer  VERDICT_SCHEMA
 * @typedef {{ verdicts: Array<VerdictAnswer & { index: number }> }} BatchVerdictAnswer  BATCH_VERDICT_SCHEMA
 * @typedef {{ missingLenses: string[], notes: string }} CriticAnswer  CRITIC_SCHEMA
 * @typedef {{ agents: Array<{ name: string, description: string, tools: string, disallowedTools: string }>, sessionCommonDir: string, repoCommonDir: string }} AgentDefinitionsAnswer  AGENT_DEFINITIONS_SCHEMA
 * @typedef {{ changed: boolean, reason: string }} ChangedAnswer  CHANGED_SCHEMA
 * @typedef {{ posted: number, reason: string }} PrCommentsAnswer  PR_COMMENTS_SCHEMA
 * @typedef {{ status: 'resolved' | 'still-open' | 'cannot-tell' | 'regressed', currentLine: number, note: string, invariant: string, attack: string }} AdjudicateAnswer  ADJUDICATE_SCHEMA
 * @typedef {{ defeated: boolean, attack: string }} AttackAnswer  ATTACK_SCHEMA
 * @typedef {{ runDir: string, error?: string }} CheckpointAnswer  CHECKPOINT_SCHEMA
 * @typedef {{ groups: number[][] }} DedupAnswer  DEDUP_SCHEMA
 */
/**
 * @typedef {{ why?: string, file?: string, severity?: string, title?: string, line?: number, source?: string, ruleId?: string, toolRule?: string, fp?: string, symbol?: string, tier?: string, disposition?: string, whyRef?: { record?: unknown, fp?: unknown }, fix?: string, whereChecked?: string, blastRadius?: string, verifySkipped?: boolean, votesDiscarded?: number, carriedUnverified?: boolean, ledgerDupOfUnverifiedPrior?: boolean, [k: string]: unknown }} Finding  a finding as a model reports it (FindingAnswer, LedgerAnswer), then as the pipeline stamps it
 */

// ---- shared schemas ----
// What a verifier says of the harm a finding claims (lib/harm-verify.mjs, realm @nick/craft, node #407);
// optional, so a vote without them is still a judgement and simply verifies no harm.
export const HARM_VERDICT_PROPS = {
  harmSupported: { type: 'boolean', description: 'true only if the code shows the claimed harm (effect, who, recovery) as stated' },
  confirmedHarmLevel: { type: 'string', enum: HARM_LEVELS, description: 'when several harms are listed: the worst listed one the code shows; omit otherwise' },
}
export const FINDING_ITEM = {
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
    // A gate tool's own rule name, set by the gate on its seeds — what tells two lints sharing a catalog ruleId apart (realm @nick/craft, node #236).
    toolRule: { type: 'string', description: 'gate seeds only: the tool\'s own rule name copied from the tool output line that names it (clippy lint "clippy::needless_pass_by_value", semgrep rule id, statix code, semver-checks check name) — never from memory; omit when the output names none or the finding is not a tool\'s' },
    fp: { type: 'string', description: 'line-tolerant fingerprint; empty if not from a ledger' },
    symbol: { type: 'string', description: 'enclosing fn/type name; empty if unknown' },
    tier: { type: 'string', description: 'confirmed|suspected|unverified|refuted; empty if n/a' },
    disposition: { type: 'string', description: 'open|closed|rejected|justified|deferred|covered; empty if n/a' },
    // Optional: set by the reconciler and failure-windows lenses only; read by applyPathFloor before verification.
    deletionOrRecoveryPath: { type: 'boolean', description: 'reconciler and failure-windows lenses only: true when the defect sits on a deletion or recovery path (finalizer removal, teardown, a delete handler, crash or partial-failure recovery); omit otherwise' },
    // Optional, so a seed, a ledger-carried finding and an older record stay valid; a lens names them on every
    // finding (realm @nick/craft, node #379). harmLevel is what the path floor and the harm cap (lib/harm-cap.mjs) read.
    harm: { type: 'string', description: 'the harm this finding names: its effect, who is affected, and how they recover (by itself, by retry, by an operator\'s hand, not at all)' },
    harmLevel: { type: 'string', enum: HARM_LEVELS, description: 'the `harmLevel` column of the first row of the review-rules severity.md table (read top down, worst first) the harm honestly fills; the engine caps severity at that row\'s ceiling' },
    // Required by the cap for harmLevel `repo-rule`: one without it is read as `none` (lib/harm-repo-rule.mjs).
    repoRule: {
      type: 'object',
      additionalProperties: false,
      required: ['file', 'text'],
      description: 'harmLevel repo-rule only: the reviewed repository\'s written rule this finding breaks — omit otherwise',
      properties: {
        file: { type: 'string', description: 'the repository file that states the rule (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, a documented convention), as a path from the repo root' },
        text: { type: 'string', description: 'the rule, quoted from that file' },
      },
    },
  },
}

// The persisted ledger entry has its OWN shape (the 11 required fields `toLedgerEntry` always writes,
// plus an OPTIONAL `sources` — see below) — NOT FINDING_ITEM. Reusing FINDING_ITEM here would require
// `fix`/`blastRadius` (which the ledger omits), so a strict validator could reject the loader's output
// and null out `priorRound`, silently degrading a re-review to a first pass. `sources` is optional (not
// in `required`) so pre-existing ledgers written without it still validate; it is persisted so the
// strict-mode maintainability escalation (isMaintainability's merged-`sources` clause) survives a
// re-review — without it the reconstructed prior has no `sources` and the escalation silently no-ops.
export const LEDGER_ITEM = {
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
    // Optional: a gate tool's own rule name, present only on a seed whose tool output named it (realm @nick/craft, node #236).
    toolRule: { type: 'string' },
    title: { type: 'string' },
    why: { type: 'string' },
    // Optional (not in `required`): present only on an item whose `why` the loader script shortened for
    // transport, and it points at where the FULL `why` is recoverable — the finding's birth record: a
    // finalized record filename, or a surviving partial-directory basename for an evidence-recovery item.
    // The schema must PERMIT it so the loader's verbatim copy validates — additionalProperties
    // is false, so an emitted `whyRef` the schema did not name would null out the whole prior round.
    whyRef: {
      type: 'object',
      additionalProperties: false,
      required: ['record', 'fp'],
      properties: {
        record: { type: 'string' },
        fp: { type: 'string' },
      },
    },
    // Optional: present only on a `deferred` row a question set aside — the question's id, reason,
    // author, date, link and commit (deferralOf). The carry track reads the deferral from here, never
    // from the mark in `why`, which the transport cuts.
    deferral: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'reason', 'who', 'when', 'link', 'commit'],
      properties: {
        id: { type: 'string' },
        reason: { type: 'string' },
        who: { type: 'string' },
        when: { type: 'string' },
        link: { type: 'string' },
        commit: { type: 'string' },
      },
    },
  },
}

/** @type {Schema<PriorRoundAnswer>} */
export const PRIOR_ROUND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['found', 'round', 'head', 'ledger', 'ledgerCount', 'priorFindings', 'journalSourced', 'reason'],
  properties: {
    found: { type: 'boolean' },
    round: { type: 'integer', description: 'the prior round number; 0 when found=false' },
    head: { type: 'string', description: 'prior HEAD sha; empty when found=false' },
    ledger: { type: 'array', items: LEDGER_ITEM, description: 'prior findings with fp/symbol/tier/disposition; empty when found=false' },
    ledgerCount: { type: 'integer', description: 'the ledger length the script computed — copy it as printed; the workflow checks it against the array it received and treats a mismatch as a truncated transport' },
    reason: { type: 'string', description: 'why there is no prior round (no-store, no-index, no-candidate-rows, unattributable-rows-only, ancestry-rejected, detail-unreadable, partial-only, git-unavailable); empty when found=true' },
    priorFindings: { type: 'integer', description: 'total findings the prior round reported (its record findings.total); 0 when found=false or unknown — used to detect a round that found bugs but persisted no ledger' },
    journalSourced: { type: 'boolean', description: 'true when this ledger was reconstructed from a stalled run\'s journal.jsonl rather than a normal completed round; false when found=false. Its `head` may equal the OPERATOR\'S current HEAD (a re-run on the same stalled commit before any fix), so the workflow must not diff head...HEAD off it — see shouldFullRescan.' },
    sameFpBasis: { type: 'boolean', description: 'true when the prior round fingerprinted its findings under the SAME basis as this round (the basis is not the engine revision: a telemetry-only revision bump keeps it); false when it differs or is unknown, and when found=false. The recidivism/tombstone check compares fp only when this is true. Copy it exactly as the loader printed it, and OMIT it when the loader did not print it — never supply a value of your own: an omitted value is reported as a lost basis verdict.' },
    fpBasisKnown: { type: 'boolean', description: 'true when the loader could establish the prior round\'s fingerprint basis at all; false when it could not (a round recovered from a stopped run whose checkpoints do not attest to one basis, an unreadable record, a record with no revision or a newer one). Copy it exactly as the loader printed it, and omit it when the loader did not print it.' },
    priorFpRevisions: { type: 'array', items: { type: 'integer' }, description: 'the raw engine revisions the prior round\'s fingerprints were minted under (empty when none can be established). The ENGINE decides comparability from these with its own table. Copy it exactly as the loader printed it, and omit it when the loader did not print it.' },
    priorFpRevisionsCheck: { type: 'string', description: 'the same revisions as a comma-separated string, printed by the loader next to priorFpRevisions so the engine can tell the array survived transport. Copy it exactly as printed, and omit it when the loader did not print it.' },
  },
}

/** @type {Schema<DetectAnswer>} */
export const DETECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['baseRef', 'files', 'spec', 'branch', 'head', 'baseIsHead', 'notes'],
  properties: {
    baseRef: { type: 'string', description: 'git ref the diff was computed against; empty if none resolved' },
    files: { type: 'array', items: { type: 'string' }, description: 'changed file paths in the diff' },
    spec: { type: 'string', description: 'verbatim change description — the open PR title+body, else the commit messages on the diff range; truncated to ~4000 chars; empty string if none' },
    branch: { type: 'string', description: 'current git branch name; empty string if detached HEAD' },
    head: { type: 'string', description: 'current HEAD short SHA; empty string if not a git repo' },
    baseIsHead: { type: 'boolean', description: 'true when the resolved base and HEAD are the same commit (git rev-parse of each); false otherwise or when none resolved' },
    notes: { type: 'string', description: 'one line on what was detected' },
  },
}

// Scout classifies; it does not budget. maxRounds/verifyVotes/lensModel are deterministic functions
// of sizeBucket (RIGOR_BY_SIZE in src/review.js), so the script derives them instead of asking a haiku to
// recite a lookup table it could contradict — the same reason the "always" lenses are enforced in
// code rather than in the prompt.
/** @type {Schema<ScoutAnswer>} */
export const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sizeBucket', 'lenses', 'isLibrary', 'securitySensitive', 'intent', 'churn', 'repoRules', 'notes'],
  properties: {
    sizeBucket: { type: 'string', enum: ['small', 'medium', 'large'] },
    lenses: { type: 'array', items: { type: 'string' }, description: 'subset of the profile lens catalog to run' },
    isLibrary: { type: 'boolean', description: 'true if a published library (→ semver-checks); always false where not applicable' },
    securitySensitive: { type: 'boolean' },
    intent: { type: 'string', description: 'what the change should do, from the brief/args; empty if unknown' },
    churn: { type: 'array', items: { type: 'string' }, description: 'hot/often-changed files to scrutinize; may be empty' },
    repoRules: { type: 'array', items: { type: 'string' }, description: 'repo-relative paths of the repository\'s own rule files (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, …); paths only; may be empty' },
    notes: { type: 'string', description: 'one line on what was detected' },
    // realm @nick/craft #102: OPTIONAL by design — and NOT in `required` above on purpose. Its absence
    // (and a missing key within it) is what makes the surface gate fail-open: the gate drops a lens
    // only where the scout AFFIRMATIVELY set the needed surface false. Each key is likewise optional.
    surfaces: {
      type: 'object',
      additionalProperties: false,
      properties: {
        crossBoundarySymbol: { type: 'boolean', description: 'diff changes the signature/shape of an exported/pub symbol that unchanged code depends on' },
        wireForm: { type: 'boolean', description: 'diff changes a contract another version reads, calls or deploys against — CRD schema or API version, serde type, HTTP/OpenAPI, protocol, CLI flag/exit code/output format, config key, env var, Helm value, changed default, renamed exported name' },
        invariantType: { type: 'boolean', description: 'diff changes a type that carries an invariant other code relies on' },
      },
    },
  },
}

/** @type {Schema<GateAnswer>} */
export const GATE_SCHEMA = {
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

/** @type {Schema<FindingsAnswer>} */
export const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'findings'],
  properties: {
    lens: { type: 'string' },
    findings: { type: 'array', items: FINDING_ITEM },
  },
}

/** @type {Schema<VerdictAnswer>} */
export const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['refuted', 'citedLineMatches', 'reachable', 'premiseSupported', 'reason'],
  properties: {
    refuted: { type: 'boolean', description: 'true if the finding does not hold up' },
    citedLineMatches: { type: 'boolean', description: 'true if the cited file:line actually contains what the finding claims' },
    reachable: { type: 'boolean', description: 'true if the path is reachable in production (not test/example-only)' },
    premiseSupported: { type: 'boolean', description: 'true if the load-bearing premise is either self-contained at the cited line or actually shown by the code at whereChecked; false if it is an off-site claim with no evidence that checks out' },
    ...HARM_VERDICT_PROPS,
    reason: { type: 'string' },
  },
}

/** @type {Schema<CriticAnswer>} */
export const CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['missingLenses', 'notes'],
  properties: {
    missingLenses: { type: 'array', items: { type: 'string' }, description: 'lenses from the candidate list that should also run; empty if coverage is complete' },
    notes: { type: 'string', description: 'one line on anything else likely missed, or "coverage complete"' },
  },
}

/** @type {Schema<AgentDefinitionsAnswer>} */
export const AGENT_DEFINITIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['agents', 'sessionCommonDir', 'repoCommonDir'],
  properties: {
    sessionCommonDir: { type: 'string', description: 'the absolute git common dir of the directory you start in, "" when it is not a git repository' },
    repoCommonDir: { type: 'string', description: 'the absolute git common dir of the reviewed repository, "" when none was named or it is not a git repository' },
    agents: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'tools', 'disallowedTools'],
        properties: {
          name: { type: 'string', description: 'the frontmatter `name`, or the file name without .md when there is none' },
          description: { type: 'string', description: 'the frontmatter `description`, verbatim' },
          tools: { type: 'string', description: 'the frontmatter `tools` value verbatim, "" when absent' },
          disallowedTools: { type: 'string', description: 'the frontmatter `disallowedTools` value verbatim, "" when absent' },
        },
      },
    },
  },
}

/** @type {Schema<ChangedAnswer>} */
export const CHANGED_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['changed', 'reason'],
  properties: { changed: { type: 'boolean' }, reason: { type: 'string' } },
}

/** @type {Schema<PrCommentsAnswer>} */
export const PR_COMMENTS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['posted', 'reason'],
  properties: {
    posted: { type: 'integer', description: 'how many inline comments were actually created; 0 if none' },
    reason: { type: 'string', description: 'the PR posted to, or why nothing was posted' },
  },
}

/** @type {Schema<AdjudicateAnswer>} */
export const ADJUDICATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['status', 'currentLine', 'note', 'invariant', 'attack'],
  properties: {
    status: { type: 'string', enum: ['resolved', 'still-open', 'cannot-tell', 'regressed'] },
    currentLine: { type: 'integer', description: 're-located 1-based line; 0 if not found' },
    note: { type: 'string' },
    invariant: { type: 'string', description: 'one-sentence invariant the finding violated' },
    attack: { type: 'string', description: 'the successful attack on the fix; empty string if every attack failed' },
  },
}

// `cannot-tell` exists so that "I could not determine this" has somewhere to go OTHER than
// `resolved`. Without it an adjudicator that cannot find the site (file deleted/renamed, symbol
// gone, the diff unreadable) has only three boxes, and the one that means "no attack succeeded"
// is the one it drifts into — closing a finding nobody verified. It routes to the still-open
// track (the same safe direction a DEAD adjudicator already takes) and annotates `why`, so the
// report shows the item as unverified rather than silently fixed. See adjudicateOne.
// Red-team verdict on a "resolved" Critical/High prior: an independent attempt to defeat the fix.
/** @type {Schema<AttackAnswer>} */
export const ATTACK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['defeated', 'attack'],
  properties: {
    defeated: { type: 'boolean', description: 'true only if a concrete input/state defeats the fix' },
    attack: { type: 'string', description: 'the concrete input/state and why it slips past the fix; empty if none found' },
  },
}
