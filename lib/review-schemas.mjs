// The JSON schemas the review engine (src/review.js) hands its agents, and the shapes of their answers:
// imported by the engine and by the tests, so a test reads the schema the engine dispatches.
// The schemas the judging agents answer in are data in content/schemas/ (lib/content.mjs, realm @nick/craft, node #452);
// a finding's schema is one file the others reference as `{ "$ref": "finding-item.schema.json" }`. Of its optional fields:
// `toolRule` tells two lints sharing a catalog ruleId apart (#236); `deletionOrRecoveryPath` is read by applyPathFloor
// before verification; `externalSystem` names the foreign system a premise rests on (#430); `harm` and `harmLevel` are
// optional so a seed, a ledger-carried finding and an older record stay valid (#379), harmLevel being what the path
// floor and the harm cap (lib/harm-cap.mjs) read; `repoRule` is required by the cap for harmLevel `repo-rule`, one
// without it read as `none` (lib/harm-repo-rule.mjs). A verdict's `behaviourIntended`, `harmSupported` and
// `confirmedHarmLevel` say what a verifier makes of the harm a finding claims (lib/harm-verify.mjs, #407): the schema
// requires them, the type keeps them optional so a vote without them is still a judgement that verifies no harm.
// Every harm level enum is HARM_LEVELS (lib/harm-levels.mjs), `confirmedHarmLevel`'s with null for none.
import { resolveRefs } from './content.mjs'
import findingItem from '../content/schemas/finding-item.schema.json' with { type: 'json' }
import scoutSchema from '../content/schemas/scout.schema.json' with { type: 'json' }
import gateSchema from '../content/schemas/gate.schema.json' with { type: 'json' }
import findingsSchema from '../content/schemas/findings.schema.json' with { type: 'json' }
import verdictSchema from '../content/schemas/verdict.schema.json' with { type: 'json' }
import criticSchema from '../content/schemas/critic.schema.json' with { type: 'json' }
import adjudicateSchema from '../content/schemas/adjudicate.schema.json' with { type: 'json' }
import changedSchema from '../content/schemas/changed.schema.json' with { type: 'json' }
import attackSchema from '../content/schemas/attack.schema.json' with { type: 'json' }

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
 * @typedef {{ severity: 'Critical' | 'High' | 'Medium' | 'Low' | 'Info', title: string, file: string, line: number, why: string, whereChecked: string, fix: string, blastRadius: string, source: string, ruleId: string, toolRule?: string, fp?: string, symbol?: string, tier?: string, disposition?: string, deletionOrRecoveryPath?: boolean, externalSystem?: string, harm?: string, harmLevel?: string, repoRule?: { file: string, text: string } }} FindingAnswer  FINDING_ITEM
 * @typedef {{ fp: string, file: string, line: number, symbol: string, severity: string, tier: string, disposition: string, source: string, sources?: string[], ruleId: string, title: string, why: string, whyRef?: { record: string, fp: string }, deferral?: { id: string, reason: string, who: string, when: string, link: string, commit: string } }} LedgerAnswer  LEDGER_ITEM
 * @typedef {{ found: boolean, round: number, head: string, ledger: LedgerAnswer[], ledgerCount: number, reason: string, priorFindings: number, journalSourced: boolean, sameFpBasis?: boolean, fpBasisKnown?: boolean, priorFpRevisions?: number[], priorFpRevisionsCheck?: string }} PriorRoundAnswer  PRIOR_ROUND_SCHEMA
 * @typedef {{ baseRef: string, files: string[], spec: string, branch: string, head: string, baseIsHead?: boolean, notes: string }} DetectAnswer  DETECT_SCHEMA
 * @typedef {{ sizeBucket: 'small' | 'medium' | 'large', lenses: string[], isLibrary: boolean, securitySensitive: boolean, intent: string, churn: string[], repoRules?: string[], notes: string, surfaces?: { crossBoundarySymbol?: boolean, wireForm?: boolean, invariantType?: boolean } }} ScoutAnswer  SCOUT_SCHEMA
 * @typedef {{ status: 'pass' | 'fail' | 'unknown', provenance: string, failedChecks: string[], carriedChecks: string[], seedFindings: FindingAnswer[], notes: string }} GateAnswer  GATE_SCHEMA
 * @typedef {{ lens: string, findings: FindingAnswer[] }} FindingsAnswer  FINDINGS_SCHEMA
 * @typedef {{ refuted: boolean, citedLineMatches: boolean, reachable: boolean, premiseSupported: boolean, reason: string, behaviourIntended?: boolean, harmSupported?: boolean, confirmedHarmLevel?: string | null }} VerdictAnswer  VERDICT_SCHEMA
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
export const FINDING_ITEM = findingItem
/** What a `$ref` in a content/ schema may name. */
const FINDING_REF = { 'finding-item.schema.json': findingItem }

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
// code rather than in the prompt. Its `surfaces` is OPTIONAL by design and not required, nor any key in it
// (realm @nick/craft #102): their absence is what makes the surface gate fail-open — the gate drops a lens only
// where the scout AFFIRMATIVELY set the needed surface false.
/** @type {Schema<ScoutAnswer>} */
export const SCOUT_SCHEMA = scoutSchema

export const GATE_SCHEMA = /** @type {Schema<GateAnswer>} */ (resolveRefs(gateSchema, FINDING_REF))

export const FINDINGS_SCHEMA = /** @type {Schema<FindingsAnswer>} */ (resolveRefs(findingsSchema, FINDING_REF))

/** @type {Schema<VerdictAnswer>} */
export const VERDICT_SCHEMA = verdictSchema

/** @type {Schema<CriticAnswer>} */
export const CRITIC_SCHEMA = criticSchema

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
export const CHANGED_SCHEMA = changedSchema

/** @type {Schema<PrCommentsAnswer>} */
export const PR_COMMENTS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['posted', 'reason'],
  properties: {
    posted: { type: 'integer', description: 'how many inline comments were actually created; 0 if none' },
    reason: { type: 'string', description: 'the PR posted to, or why nothing was posted' },
  },
}

/** @type {Schema<AdjudicateAnswer>} */
export const ADJUDICATE_SCHEMA = adjudicateSchema

// `cannot-tell` exists so that "I could not determine this" has somewhere to go OTHER than
// `resolved`. Without it an adjudicator that cannot find the site (file deleted/renamed, symbol
// gone, the diff unreadable) has only three boxes, and the one that means "no attack succeeded"
// is the one it drifts into — closing a finding nobody verified. It routes to the still-open
// track (the same safe direction a DEAD adjudicator already takes) and annotates `why`, so the
// report shows the item as unverified rather than silently fixed. See adjudicateOne.
// Red-team verdict on a "resolved" Critical/High prior: an independent attempt to defeat the fix.
/** @type {Schema<AttackAnswer>} */
export const ATTACK_SCHEMA = attackSchema
