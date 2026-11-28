// Canonical, tested helpers for building craft run records. The engines import them and esbuild bundles
// them in (integrations/shared/build-engines.mjs): this file is the only copy.

// Greenness has ONE authority, audit-evidence's GREEN_VERDICT (realm @nick/craft, #53): worstVerdict
// reads it from there, and an engine that bundles worstVerdict bundles GREEN_VERDICT with it.
import { GREEN_VERDICT } from './audit-evidence.mjs'

/** @param {unknown} v @returns {unknown[]} */
const entryList = v => (Array.isArray(v) ? v : [])

/** @param {unknown} v @returns {v is unknown[]} */
const isEntryList = v => Array.isArray(v)

/** A field of a parsed JSON value, undefined when it is no object. @param {unknown} v @param {string} key @returns {unknown} */
const entryField = (v, key) => (v && typeof v === 'object' ? /** @type {Record<string, unknown>} */ (v)[key] : undefined)

/** @typedef {'Critical' | 'High' | 'Medium' | 'Low' | 'Info'} Severity */
/** @typedef {'accept' | 'reject' | 'defer' | 'needs-decision' | 'conflict'} TriageVerdict */
/** @typedef {{ file?: unknown, symbol?: unknown, ruleId?: unknown, title?: unknown }} FindingKey */
/**
 * A run record as a reader gets it from the store (realm @nick/craft, #132): the ONE description every
 * reader shares. Records are parsed JSON written by several engine revisions and by hand, so every field
 * is optional and every leaf is `unknown` until a guard (`isCount`, `costProblem`, a `typeof`) says
 * otherwise; nested objects are typed so the guard has a shape to narrow.
 * @typedef {{ total?: unknown, cacheRead?: unknown, cacheWrite?: unknown, input?: unknown, output?: unknown,
 *   agents?: unknown, skipped?: unknown, partsUnmeasured?: unknown, source?: unknown, rule?: unknown, slice?: unknown }} RecordCost
 * @typedef {{ chained?: unknown, ledgerDegraded?: unknown, journalSourced?: unknown, fpComparable?: unknown,
 *   basisMismatch?: unknown, tombstonesDropped?: unknown, priorRound?: unknown, priorHead?: unknown,
 *   [k: string]: unknown }} RecordReReview
 * @typedef {{ language?: unknown, lenses?: unknown, model?: unknown, maxRounds?: unknown, verifyVotes?: unknown,
 *   size?: unknown, securitySensitive?: unknown, isLibrary?: unknown, [k: string]: unknown }} RecordScout
 * @typedef {{ candidates?: unknown, refuteRate?: unknown, unverified?: unknown, thinned?: unknown,
 *   confirmed?: unknown, [k: string]: unknown }} RecordVerification
 * @typedef {{ agents?: unknown, agentsOf?: 'tasks' | undefined, wallClockMinutes?: unknown, longestStallSeconds?: unknown, [k: string]: unknown }} RecordRuntimeStats  agentsOf: what `agents` counts — 'tasks' on a cli-review record (its task agents only), absent where it counts every agent transcript
 * @typedef {{ dropped?: unknown, dispatched?: unknown, lensesRan?: unknown, [k: string]: unknown }} RecordSurfaceGate
 * @typedef {{ total?: unknown, [k: string]: unknown }} RecordFindings
 * @typedef {{
 *   schemaVersion?: unknown, kind?: unknown, name?: unknown, ts?: unknown, project?: unknown, branch?: unknown,
 *   head?: unknown, base?: unknown, path?: unknown, filesDigest?: unknown, dirty?: unknown, round?: unknown,
 *   partial?: unknown, partialReason?: unknown, nested?: unknown, verdict?: unknown, notRun?: unknown,
 *   gate?: { status?: unknown, [k: string]: unknown } | null, verification?: RecordVerification | null,
 *   lensScope?: unknown, intentDigest?: unknown, specDigest?: unknown, languages?: unknown,
 *   scout?: RecordScout[] | null, criticFollowups?: unknown, optionalPass?: { requested?: unknown } | null,
 *   strict?: unknown, lensRounds?: Array<{ agents?: unknown, [k: string]: unknown }> | null,
 *   cost?: RecordCost | null, reReview?: RecordReReview | null, findings?: RecordFindings | null,
 *   findingsTotal?: unknown, runtime?: unknown, craftVersion?: unknown, workflowEngineRevision?: unknown,
 *   engineRevision?: unknown, runEngineRevision?: unknown, workflowEngineRevisionDisputed?: unknown, runtimeStats?: RecordRuntimeStats | null,
 *   outputTokens?: unknown, outputTokensScope?: unknown, surfaceGate?: RecordSurfaceGate | null, savedByFloor?: unknown,
 *   savedByFloorPremiseHeld?: unknown, harmCap?: { lowered?: unknown } | null, uncoveredFiles?: unknown, dimensions?: unknown,
 *   phases?: unknown, ledger?: unknown, ledgerSource?: unknown, memory?: unknown, [k: string]: unknown
 * }} RunRecord
 */

/** @type {Severity[]} */
export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info']

/**
 * @param {unknown} findings
 * @returns {Record<Severity, number>}
 */
export function countBySeverity(findings) {
  const by = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 }
  for (const f of entryList(findings)) {
    const severity = /** @type {PropertyKey} */ (entryField(f, 'severity'))
    if (Object.prototype.hasOwnProperty.call(by, severity)) by[/** @type {Severity} */ (severity)] += 1
  }
  return by
}

/**
 * @param {unknown} findings
 * @returns {{ total: number, bySeverity: Record<Severity, number> }}
 */
export function summarizeFindings(findings) {
  const bySeverity = countBySeverity(findings)
  return { total: SEVERITIES.reduce((n, s) => n + bySeverity[s], 0), bySeverity }
}

// What a record's `outputTokens` counts (integrations/shared/run-budget.mjs).
/** The `outputTokensScope` of a record whose `outputTokens` is the turn's pool grown while its engine ran. */
export const TURN_DELTA = 'turn-delta'

/** A record's `outputTokensScope`, only when one is named. @param {unknown} scope @returns {{ outputTokensScope?: unknown }} */
export const scopeField = scope => (scope != null && scope !== '' ? { outputTokensScope: scope } : {})

/**
 * The scope beside a record's figure: none without a number to say what it counts, as the binary's record writer.
 * @param {unknown} tokens @param {unknown} scope @returns {{ outputTokensScope?: unknown }}
 */
export const tokensScope = (tokens, scope) => (typeof tokens === 'number' ? scopeField(scope) : {})

/**
 * A record's `outputTokens` and, when it is a number, the scope that says what it counts.
 * @param {number | null} tokens @returns {{ outputTokens: number | null, outputTokensScope?: string }}
 */
export const scopedTokens = tokens => (tokens === null ? { outputTokens: null } : { outputTokens: tokens, outputTokensScope: TURN_DELTA })

// The refusal of an argument the engine cannot honour (a `repo` no agent could `cd` to, an option it does not
// take): an INCOMPLETE record carrying the refusal's class in `notRun`, and the report naming the argument —
// filed and returned before any work agent, as every refusal is (realm @nick/craft, nodes #159, #411).
/**
 * @param {{ engine: string, why: string, notRun: string[], craftVersion: string, outputTokens: number | null, via?: string }} o
 *   `why`: the sentences naming each refused argument; `notRun`: their classes, without the caller's values;
 *   `via`: the parent workflow that dispatched this run, '' when it was not nested
 */
export function argumentRefusal({ engine, why, notRun, craftVersion, outputTokens, via = '' }) {
  return {
    record: {
      schemaVersion: 1,
      runtime: 'claude-code',
      craftVersion,
      kind: 'workflow',
      name: engine,
      nested: !!via,
      via: via || null,
      verdict: 'INCOMPLETE (argument refused)',
      findings: summarizeFindings([]),
      dimensions: [],
      verification: null,
      notRun,
      ...scopedTokens(outputTokens),
    },
    report: [`## Verdict`, `⚠️ INCOMPLETE — ${why}`].join('\n'),
  }
}

// The refusal of a `repo` argument by an engine whose agents run git/cargo wherever the session sits:
// accepting it silently reads THIS checkout and reports a normal-looking verdict for the wrong code.
// The engine files `record` through its logRun — a repeated wrong dispatch has to reach the `notRun`
// fragility ranking — and returns `report`, before anything has run. One helper for every engine that
// refuses, so the record and the advice cannot drift between them.
/**
 * @param {{ engine: string, repo: string, craftVersion: string, outputTokens: number | null, via?: string }} o
 *   `via`: the parent workflow that dispatched this run, '' when it was not nested
 */
export function repoRefusal({ engine, repo, craftVersion, outputTokens, via = '' }) {
  return {
    record: {
      schemaVersion: 1,
      runtime: 'claude-code',
      craftVersion,
      kind: 'workflow',
      name: engine,
      nested: !!via,
      via: via || null,
      verdict: 'INCOMPLETE (repo not supported)',
      findings: summarizeFindings([]),
      dimensions: [],
      verification: null,
      // The CLASS, not the caller's path: `notRun` is ranked by exact string, so a path here would
      // make every repetition of this same misuse its own count-1 row.
      notRun: ["`repo` argument refused — this engine reviews only the session's own checkout"],
      ...scopedTokens(outputTokens),
    },
    report: [
      `## Verdict`,
      `⚠️ INCOMPLETE — \`repo=${repo}\` was given, but \`${engine}\` does not support reviewing a repository other than the one this session runs in: its agents would read THIS checkout and report a normal-looking verdict for the wrong code. Nothing ran.`,
      ``,
      `Either run \`craft:review\` with \`repo=\` (that engine threads a working-directory directive through its prompts), or start a session inside that repository and run \`${engine}\` there.`,
    ].join('\n'),
  }
}

// An UNRECOGNISED verdict must never default to the most permissive outcome: an aggregate that
// turns `INCOMPLETE (no language profile)` back into `Approve` re-creates, one layer up, exactly the
// overclaim the leaf verdicts were fixed to avoid. Anything that is not a verdict we can read as
// green — INCOMPLETE included — aggregates to Warning.
/**
 * @param {unknown} verdicts
 * @returns {string}
 */
export function worstVerdict(verdicts) {
  const vs = (Array.isArray(verdicts) ? verdicts : []).map(v => String(v || ''))
  // ZERO verdicts is not unanimous green — it is the ABSENCE of any evidence: every dimension died,
  // or nothing ran at all. Returning Approve here renders a total outage as a pass, the same
  // overclaim in its purest form. An empty set aggregates to INCOMPLETE, which no consumer reads
  // as green.
  if (!vs.length) return 'INCOMPLETE (no verdicts)'
  if (vs.some(v => /Block|At-risk|UB-found/i.test(v))) return 'Block'
  if (vs.some(v => /Warning|Concerns/i.test(v))) return 'Warning'
  // Greenness is the ONE authority (GREEN_VERDICT), not a private substring: a verdict that is not a
  // whole-string green — INCOMPLETE, or a canonical word with a trailing clause — aggregates to Warning.
  if (vs.some(v => /INCOMPLETE/i.test(v) || !GREEN_VERDICT.test(v))) return 'Warning'
  return 'Approve'
}

/**
 * @param {unknown} confirmed
 * @returns {string}
 */
export function reviewVerdict(confirmed) {
  const by = countBySeverity(confirmed)
  if (by.Critical || by.High) return 'Block'
  if (by.Medium) return 'Warning'
  return 'Approve'
}

// Normalized, word-order-independent word-set of a finding title. Used inside the fingerprint and
// for fuzzy cross-round matching so a lightly reworded title still matches its prior-round twin.
/**
 * @param {unknown} title
 * @returns {string}
 */
export function titleShingle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ')
}

// The enclosing symbol, folded to one key across the ways two lens agents spell the same one:
// case (`Foo::Bar` vs `foo::bar`), the `fn `/`impl ` keyword, and generic parameters (`parse<T>`).
// Kept deliberately small — it absorbs decoration noise, not structure: a rename is still a
// different symbol, which is the acceptable, rare identity loss the fingerprint is built to take.
/**
 * @param {unknown} symbol
 * @returns {string}
 */
export function normalizeSymbol(symbol) {
  let s = String(symbol || '')
    .toLowerCase()
    .replace(/\b(?:fn|impl)\s+/g, '')
  // Strip generics INNERMOST-first, looping until stable. A single /<[^>]*>/g pass stops its class at
  // the first `>`, so a NESTED generic like `Vec<Map<K,V>>` would keep the inner and trailing `>`
  // (`vec>`) and defeat the fold. `<[^<>]*>` matches only a bracket pair with no bracket inside — an
  // innermost generic — and repeating it collapses arbitrary nesting away, leaving no stray symbol.
  let prev
  do {
    prev = s
    s = s.replace(/<[^<>]*>/g, '')
  } while (s !== prev)
  return s.trim()
}

// Line-tolerant finding identity. A finding with a ruleId (a catalog rule) gets an EXACT, title-free
// identity: file + normalizeSymbol(symbol) + ruleId. The title is deliberately dropped there — it is
// natural language two agents rarely word the same, so anchoring identity on it left the fingerprint
// uncomparable across rounds (matchesPrior on the old title basis recognised 2 of 59 re-discoveries),
// and the ruleId already IS the normalized, lens-scoped claim (source/lens are therefore not in the
// key — adding lens would only manufacture false negatives when the same defect resurfaces under
// another lens). A finding with NO ruleId has no such stable identity, so it keeps the title in its
// basis: without it every ad-hoc finding at one file collapses to a single file-only hash, and a
// cross-lens/journal dedup keyed on this (dedupJournalFindings) would merge distinct defects. The
// tombstone/recidivism check only ever keys ruleId findings, so it never sees the title-bearing form.
// djb2 (not crypto) — the sandbox has no crypto and bans Math.random, and we only need a stable,
// collision-resistant-enough key, computed identically in the lib and in the engines that bundle it.
/**
 * @param {FindingKey | null | undefined} f
 * @returns {string}
 */
export function fingerprint(f) {
  /** @type {FindingKey} */
  const k = f || {}
  /** @type {unknown} */
  const ruleId = k.ruleId || ''
  const basis = ruleId
    ? [k.file || '', normalizeSymbol(k.symbol), ruleId].join('\0')
    : [k.file || '', normalizeSymbol(k.symbol), '', titleShingle(k.title)].join('\0')
  let h = 5381
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}

// What the comment inside the function below must not be read as saying:
//
// `engineRevision` is deliberately absent from the projection. The in-body note is about
// craftVersion and stays true of craftVersion; it is NOT a claim that the index carries the engine
// discriminator, because a version names a RELEASE and one release (0.16.0) spanned two engines.
// So: index.jsonl is filterable by version only, and a version slice is not an engine slice.
// Nothing is lost today — `craft runs retro`, the only engine-aware reader, loads the DETAIL
// files, where the revision always is; and `backfillEngineRevision` correspondingly rewrites detail
// files only, leaving existing index lines unattributed on purpose (the index is append-only, and a
// real store was found holding 29 unparsable lines that any rewrite would silently drop).
// Adding the column is a genuine improvement, and it belongs in the move that also teaches the
// workflow writers to stamp a revision: this projection is bundled into three engines
// that stamp none, so the column would land there as a permanent `null` beside real values.

/**
 * @param {{ schemaVersion?: unknown, runtime?: unknown, ts?: unknown, kind?: unknown, name?: unknown,
 *   craftVersion?: unknown, craftCommit?: unknown, project?: unknown, commit?: unknown, dirty?: unknown,
 *   branch?: unknown, head?: unknown, round?: unknown, verdict?: unknown, findings?: { total?: unknown } | null,
 *   nested?: unknown, via?: unknown, outputTokens?: unknown, outputTokensScope?: unknown, driver?: unknown }} r
 */
export function indexProjection(r) {
  return {
    schemaVersion: r.schemaVersion,
    runtime: r.runtime ?? null,
    ts: r.ts,
    kind: r.kind,
    name: r.name,
    // craftVersion/craftCommit must ride in the INDEX, not just the detail file: the whole point is
    // filtering an aggregate down to one engine version, and that is done by scanning index.jsonl.
    craftVersion: r.craftVersion ?? null,
    craftCommit: r.craftCommit ?? null,
    project: r.project,
    commit: r.commit,
    dirty: r.dirty,
    branch: r.branch ?? null,
    head: r.head ?? null,
    round: r.round ?? 0,
    verdict: r.verdict,
    findingsTotal: r.findings ? r.findings.total : 0,
    nested: r.nested,
    via: r.via,
    outputTokens: r.outputTokens ?? null,
    // What outputTokens counts, only when a writer named it (integrations/shared/run-budget.mjs).
    ...scopeField(r.outputTokensScope),
    // Only when stamped, so the JS engine's index lines stay as they were: the chain selector skips a CLI run by it.
    ...(r.driver != null ? { driver: r.driver } : {}),
  }
}

// A review run of either driver: craft:review's (`review` — the JS engine's, or the Rust CLI's once it carries the
// name, stamped `driver: 'cli'`) or the CLI's under its interim name (`cli-review`, integrations/shared/cli-review-record.mjs). The
// readers of the review population (depth, round pairs, partial twins, external matches) count every one; the chain
// readers (selectPriorRounds below, integrations/shared/craft-log-run.mjs) do not — a CLI record's ledger is the binary's chain.
/** @param {{ name?: unknown } | null | undefined} r @returns {boolean} */
export function isReviewRun(r) {
  return !!r && (r.name === 'review' || r.name === 'cli-review')
}

// Which chain a review run is a round of: the CLI's (either name) or the JS engine's. Rounds of two chains on one
// branch are numbered apart and never each other's prior.
/** @param {{ name?: unknown, driver?: unknown } | null | undefined} r @returns {'cli' | 'js'} */
export function reviewChain(r) {
  return r && (r.name === 'cli-review' || r.driver === 'cli') ? 'cli' : 'js'
}

// A `review` workflow run of this engine's chain: a CLI review's ledger is the binary's own chain, not this one.
/** @template {{ kind?: unknown, name?: unknown, driver?: unknown }} T @param {T | null | undefined} e @returns {e is T} */
const isJsReviewEntry = e => !!e && e.kind === 'workflow' && e.name === 'review' && reviewChain(e) === 'js'

// All prior `review` runs for this project+branch from the loaded index.jsonl entries, NEWEST FIRST.
// ts strings are UTC and lexically sortable (YYYY-MM-DDTHH-MM-SSZ), so a string sort is chronological.
// Callers walk this list: a candidate can be rejected downstream (head no longer an ancestor after a
// rebase, unreadable detail record) and the next-newest must still be reachable.
/**
 * @template {{ kind?: unknown, name?: unknown, driver?: unknown, project?: unknown, branch?: unknown, nested?: unknown, ts?: unknown }} E
 * @param {readonly (E | null | undefined)[]} indexEntries  parsed index.jsonl lines (untyped JSON; a non-array reads as none)
 * @param {{ project: unknown, branch: unknown }} key
 * @returns {E[]}
 */
export function selectPriorRounds(indexEntries, { project, branch }) {
  /** @type {E[]} */
  const hits = []
  for (const e of isEntryList(indexEntries) ? indexEntries : []) {
    if (!isJsReviewEntry(e)) continue
    if (e.project !== project || e.branch !== branch || !e.branch) continue
    // A NESTED child is not a round. `rust-audit` fans out one `review` per crate through
    // `parallel`, and every sibling files under the same (project, branch) as the parent — so a
    // crate slice would otherwise become the predecessor of a later whole-repository review and
    // hand it a ledger scoped to one crate, or become the "prior round" of a sibling that is still
    // running. The chain belongs to the top-level run, which is the thing that has a history.
    // The reader half of this decision is in integrations/claude-code/src/review.js: a child does not read the chain.
    if (e.nested) continue
    hits.push(e)
  }
  return hits.sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
}

// `git rev-parse --abbrev-ref HEAD` prints the literal string `HEAD` on a detached HEAD, which is
// NOT a branch name. Map it to '' so a detached run files no branch: findPriorRound/selectPriorRounds
// then report `no-branch` and the run does not chain review rounds — filing "HEAD" as a branch would
// pool every unrelated detached context under one shared key. A real branch name (and '' when git
// could not resolve one) passes through unchanged. The one place this rule lives: gitIdentity
// (integrations/shared/craft-log-run.mjs) and the review engine's detect capture (integrations/claude-code/src/review.js) both route
// their branch value through here (realm @nick/craft #104).
/**
 * @param {string} ref
 * @returns {string}
 */
export function branchFromAbbrevRef(ref) {
  return ref === 'HEAD' ? '' : ref
}

// ---- engine identity -------------------------------------------------------------------------
// A DISCRIMINATOR the version string cannot supply. `craftVersion` names a RELEASE, not a
// behaviour: per-run rigor (maxRounds/verifyVotes/lensModel) moved from a model's unbounded answer
// to a fixed in-code table INSIDE the 0.16.0 window, so records of both engines carry the identical
// string and only a timestamp — which nobody reading a report has — separates them. A before/after
// built on that filter is unsound and reads exactly like a sound one.
//
// So: a monotonic integer, bumped BY HAND whenever the engine's behaviour changes in a way that
// changes what its telemetry MEANS — rigor constants, the verification protocol, the lens roster,
// the severity rubric, how findings are counted. Cosmetics, prompt wording that does not move the
// numbers, and pure refactors do not bump it.
//
// TRADE-OFF, stated plainly: nothing can enforce the bump. No gate can tell a behavioural change
// from a cosmetic one, so the number is only as honest as the person editing the engine — and a
// MISSED bump asserts sameness, where a missing field would merely have admitted ignorance. Two
// consequences follow, and both are deliberate: the reading side (`craft runs retro`, cli/crates/craft-store/src/retro.rs) treats an
// ABSENT revision as an unknown engine rather than folding it in with the current one; and the
// stronger alternative — fingerprinting the behavioural constants a run actually used, which cannot
// be forgotten — is not what ships here, because the engine does not report those constants in the
// record (only `scout` echoes some of them) and inventing that reporting means editing the workflow
// scripts. When it does report them, this integer should give way to that fingerprint.
//
// WHO MAINTAINS IT: whoever changes engine behaviour, in the same commit as the change. Log:
//   1 — every engine up to and including the one that asked Scout for its own rigor budget.
//   2 — the engine as it stands on trunk today. Rigor derived in code from the size bucket
//       (RIGOR_BY_SIZE), a dead scout reading INCOMPLETE, verification dispatched through a sliding
//       window rather than waves, and the ledger's principled removal rule. It also carries the one
//       change here that alters what a RECORDED NUMBER means rather than only how the engine
//       behaves: `rust-audit`'s unused-crates `refuteRate` went from (candidates − confirmed)
//       / candidates to (judged − confirmed) / judged, `null` when nothing was judged, because a
//       dead verifier used to count as a refutation. `craft runs retro` averages that field, so mixing
//       the two would average two different quantities under one name. (Other workflows still
//       compute dropped/candidates and are untouched; they now share `refuteRate()` above, same formula.)
//   3 — the finding fingerprint (`fp`) was re-anchored. A finding WITH a ruleId now hashes on
//       file + normalizeSymbol(symbol) + ruleId, dropping the title shingle the old basis carried
//       (file + symbol + ruleId + titleShingle); a finding with no ruleId keeps the title, so ad-hoc
//       findings do not collapse. This changes what a RECORDED `fp` MEANS for every catalog finding —
//       the same defect hashes to a different value across the boundary, and a round-N `fp` is no
//       longer comparable to a round-(N+1) one computed under the old basis — so cross-round identity
//       (the recidivism/tombstone check) is only sound within one FINGERPRINT BASIS (FP_BASIS_SINCE
//       below). That is exactly the "changes what its telemetry means" case this field exists to
//       mark, so it earns the bump.
//   4 — three changes to what a `review` record's fields MEAN, none touching the fingerprint:
//       `surfaceGate.dropped` stopped counting the surface-gate drops of a profile that then FAILED
//       its mechanical gate (they had read as saved passes on a mixed run); `optionalPass.skipped`
//       stopped listing a red-gated profile's UNREQUESTED optional lenses (they had read as a
//       purchase the run declined — requested ones still read as skipped); and
//       `surfaceGate.lensesRan` became true for a profile whose lens agents came back but lost a
//       slice per lens (it used to require one lens complete on every slice). The fingerprint basis
//       is unchanged, so an r3 prior round stays comparable under r4 and no review loop in flight
//       loses its tombstones (realm @nick/craft #108). Caveat for a reader slicing r3 against r4:
//       the three changes merged while the number still read 3, so r3 records written by a TRUNK
//       build between those merges and this bump already carry the r4 meanings. No release carried
//       them (0.21.0 predates all three), so an installed plugin's r3 records are clean r3.
//
// WHY 2 AND NOT 3, WRITTEN DOWN BECAUSE IT LOOKED LIKE A MISSED BUMP: revision 2 was BORN already
// describing an engine that contained all of the above. Two of those changes were on trunk eight
// hours before this field existed; the other two merged within thirty-one seconds of the commit that
// introduced it. So no run was ever recorded under a narrower revision 2 — every record in existence
// predates the field entirely and reads `r?`, and bumping would have created a bucket nothing can
// ever be in. What was needed was not a new number but an honest description of the one that shipped.
//
// The lesson, and it is NOT "changes merged together are one engine": before reaching for a new
// number, ask whether any record actually carries the current one. A revision only earns a successor
// once something is recorded under it — until then the honest move is to widen its description, not
// to strand it. Reading a git log as a sequence is what made this look like a miss; the store is
// what settled it.

// The current engine revision (the log above says what each one means). Imported by the review engine
// with the fingerprint-basis table below, so the side that computes fingerprints decides their basis.
export const ENGINE_REVISION = 4

// The FINGERPRINT BASIS is a separate question from the engine revision, and it is answered here,
// not by comparing revisions: the revision is also the telemetry label the analyzer slices on, and a
// telemetry-only bump must not make the re-review memory treat every prior round as incomparable —
// that drops each in-flight loop's tombstones and skips its recidivism check (realm @nick/craft #108).
// Each entry is the engine revision at which a basis BEGAN; a revision's basis is the latest entry at
// or below it. Add an entry — not a bump of ENGINE_REVISION alone — whenever `fingerprint()` changes
// what a recorded `fp` means.
//   1 — the title-anchored basis (file + symbol + ruleId + title shingle).
//   3 — the ruleId-anchored basis (see revision 3 above).
export const FP_BASIS_SINCE = [1, 3]

// The basis a record stamped with `rev` fingerprinted under; null when `rev` is not a revision
// (a legacy record with no field) — such a record is never comparable.
/**
 * @param {unknown} rev
 * @returns {number | null}
 */
export function fpBasisOf(rev) {
  if (!Number.isInteger(rev) || /** @type {number} */ (rev) < 1) return null
  return Math.max(...FP_BASIS_SINCE.filter(b => b <= /** @type {number} */ (rev)))
}

// Whether the basis `priorRev` fingerprinted under can be established at all: a revision this engine
// knows — not missing (a legacy record), not newer than this engine (a table it does not have). The
// complement is not "the basis changed" but "nobody can say", and the engine reports it as lost
// re-review memory rather than an expected reset (realm @nick/craft #110).
/**
 * @param {unknown} priorRev
 * @param {number} [currentRev]
 * @returns {boolean}
 */
export function fpBasisEstablished(priorRev, currentRev = ENGINE_REVISION) {
  return Number.isInteger(priorRev) && /** @type {number} */ (priorRev) >= 1 && /** @type {number} */ (priorRev) <= currentRev
}

// The basis verdict from the RAW revisions a prior round's fingerprints were minted under (one for a
// finished record, one per checkpoint for a recovered round), decided against `currentRev` — the
// caller's own revision and table. Known only when every revision is established and all map to ONE
// basis; then comparable when that basis is the caller's. Imported by the review engine, which
// computes the fingerprints and so is the side that decides (realm @nick/craft #111).
/**
 * @param {unknown} revs
 * @param {number} [currentRev]
 * @returns {{ sameFpBasis: boolean, fpBasisKnown: boolean }}
 */
export function basisVerdictFromRevisions(revs, currentRev = ENGINE_REVISION) {
  const list = Array.isArray(revs) ? revs : []
  if (!list.length || !list.every(r => fpBasisEstablished(r, currentRev))) return { sameFpBasis: false, fpBasisKnown: false }
  const bases = new Set(list.map(fpBasisOf))
  if (bases.size !== 1) return { sameFpBasis: false, fpBasisKnown: false }
  return { sameFpBasis: fpBasisOf(list[0]) === fpBasisOf(currentRev), fpBasisKnown: true }
}
