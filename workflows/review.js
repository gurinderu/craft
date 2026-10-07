export const meta = {
  name: 'review',
  description: 'Elastic deep review of a diff — auto-detects the language(s) touched, scout-scaled lens fan-out, loop-until-dry, tool-grounded seed findings, adversarial + self-verification, synthesized into one Confirmed/Suspected/Unverified report with a verdict. Rust and Nix profiles built in.',
  whenToUse: 'The single review path for any diff/PR before commit or merge. The engine itself always recalls the active decisions and questions for the paths of the diff through the craft:memory skill; priorDecisions is optional and ADDS to that recall, never replaces it (merged by id, the recalled record kept on a clash; an empty list adds nothing), and the report names both parts. To post findings on a PR pass comment — never post findings by hand: only comments from the engine carry the marker that ties a later rejection to its finding. Auto-detects language; pin with args.languages (e.g. ["rust"] or ["nix"]). Scales depth to the diff automatically. To review ANOTHER repository pass repo=<absolute path> — without it every git command runs in the checkout the session itself sits in; path= is a repo-relative pathspec, NOT a way to select the repo. The performance / api-idioms / api-boundary lenses are an OPTIONAL pass that is OFF by default — request it with optional=true (or optional=performance,api-boundary); every report names what it skipped. priorDecisions — ONLY inside an object argument, {priorDecisions: [<decision and question records the launcher holds beyond what the engine recalls, such as rejections read from PR threads>]}; as a string (key=value or JSON text) it is refused and nothing of it applied, and in a key=value string nothing after it is read as an option — sets aside a finding the project already rejected — listed under Rejected before with who, when, why and a link, never dropped — unless it is Critical/High or its scope changed since the commit of the decision; a finding an active question (a deferred finding) answers is listed under Known and deferred by the same rules; a malformed value applies nothing and is named in the report. deadlineMs=<ms> is a diagnostic knob, not a review option: it replaces the per-phase wall-clock deadline table wholesale and will kill healthy lenses if set below their real duration.',
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
 * @typedef {{ fp: string, file: string, line: number, symbol: string, severity: string, tier: string, disposition: string, source: string, sources?: string[], ruleId: string, title: string, why: string, whyRef?: { record: string, fp: string }, deferral?: { id: string, reason: string, who: string, when: string, link: string, commit: string } }} LedgerAnswer  LEDGER_ITEM
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
let repoArg = argString('repo')
const ABSOLUTE_PATH = /^(\/|~(\/|$)|[A-Za-z]:[\\/])/
let ambiguousPath = ''
/** @type {string[]} */
let scopeNotRun = []
let scopeDetail = ''
const scopeSection = () => (scopeNotRun.length ? `\n\n## Scope\n⚠️ ${scopeDetail || scopeNotRun.join('\n⚠️ ')}\n` : '')
const DECISION_FIELD_MAX = { id: 80, title: 200, scope: 300, reason: 1200, who: 120, when: 40, link: 500 }

const PRIOR_RECORD_KINDS = ['decision', 'question']

/** Path segments with `.`, empty segments and separators folded; `..` kept literal. @param {string} p */
function decisionScopeParts(p) {
  return p.split(/[\\/]+/).filter(s => s && s !== '.')
}

/** @param {unknown} v @returns {string} */
function decisionText(v) {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * A record's kind, lower-cased; a record without one takes the kind its id prefix names, for every
 * kind of the memory skill (id = `<kind>-<hash>`: `decision-`, `question-`, `lesson-`), and is a
 * `decision` only when its id names none — a launcher that leaves `kind` out must not turn a deferral
 * into a rejection, nor a lesson into a decision.
 * @param {Record<string, unknown>} o @returns {string}
 */
function recordKind(o) {
  if (o['kind'] != null) return decisionText(o['kind']).toLowerCase()
  const m = /^(decision|question|lesson)-/i.exec(decisionText(o['id']))
  return m ? String(m[1]).toLowerCase() : 'decision'
}

/** The ids a record's `supersedes: <id>` and `answers: <id>` links name. @param {unknown[]} links @returns {string[]} */
function supersededIds(links) {
  return links.flatMap(l => {
    const m = /^(?:supersedes|answers):\s*(\S+)$/i.exec(decisionText(l))
    return m ? [String(m[1])] : []
  })
}

/**
 * The decision's fields as strings, trimmed. A memory record (skills/memory) is read as it is
 * recalled: `body`, `date` and `author` stand in for `reason`, `when` and `who`, and the first
 * http(s) URL in `links` for `link`. `kind` is `question` only when recordKind reads one; `deferred` only
 * a boolean `true`.
 * @param {Record<string, unknown>} o @returns {PriorDecision}
 */
function decisionFields(o) {
  /** @param {string} k @param {string} [alt] */
  const f = (k, alt = '') => decisionText(o[k]) || decisionText(o[alt])
  const links = Array.isArray(o['links']) ? o['links'] : []
  const url = decisionText(links.find(l => /^https?:\/\//.test(decisionText(l))))
  return { id: f('id'), title: f('title'), scope: f('scope') || '.', reason: f('reason', 'body'), who: f('who', 'author'), when: f('when', 'date'), link: f('link') || url, commit: f('commit'), kind: recordKind(o) === 'question' ? 'question' : 'decision', deferred: o['deferred'] === true, supersedes: supersededIds(links) }
}

/**
 * What is wrong with a decision, as the tail of a refusal sentence; '' when nothing is.
 * @param {Record<string, unknown>} o @param {PriorDecision} d @returns {string}
 */
function decisionProblem(o, d) {
  if (!PRIOR_RECORD_KINDS.includes(recordKind(o))) return ` is a ${JSON.stringify(recordKind(o))} record, not a decision or a question`
  if (o['status'] != null && decisionText(o['status']) !== 'active') return ` is not active (status ${JSON.stringify(o['status'])})`
  if (!d.id || !d.title || !d.reason) return ' lacks an id, a title or a reason'
  const over = Object.entries(DECISION_FIELD_MAX).find(([k, max]) => d[/** @type {keyof typeof DECISION_FIELD_MAX} */ (k)].length > max)
  if (over) return `: ${over[0]} is ${d[/** @type {keyof typeof DECISION_FIELD_MAX} */ (over[0])].length} chars, over the ${over[1]}-char ceiling`
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
 * One decision as given, checked: a refusal sentence, or the decision. `at` is its index in the list,
 * or the label a refusal opens with (lib/memory-recall.mjs names the part it came from).
 * @param {unknown} raw @param {number | string} at @returns {PriorDecision | string}
 */
function readPriorDecision(raw, at) {
  const label = typeof at === 'number' ? `decision #${at}` : at
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${label} is not an object`
  const o = /** @type {Record<string, unknown>} */ (raw)
  const d = decisionFields(o)
  const problem = decisionProblem(o, d)
  return problem ? `${label}${d.id && !hasControlChar(d.id) ? ` (${d.id})` : ''}${problem}` : d
}
const PRIOR_DECISIONS_MAX = 100

const DECISION_TITLE_OVERLAP = 0.6

/** A refusal's label for the record at index `i`. @param {number} i @returns {string} */
const decisionLabel = i => `decision #${i}`

/** The record's id when it is fit to print, else ''. @param {unknown} item @returns {string} */
function printableId(item) {
  const id = item && typeof item === 'object' ? decisionText(/** @type {Record<string, unknown>} */ (item)['id']) : ''
  return id && id.length <= DECISION_FIELD_MAX.id && !hasControlChar(id) ? id : ''
}

/**
 * The records past the cap, each named (its label and id), the names bounded by the cap itself.
 * @param {unknown[]} cut @param {(i: number) => string} labelOf @returns {string}
 */
function cutNames(cut, labelOf) {
  const named = cut.slice(0, PRIOR_DECISIONS_MAX).map((item, k) => {
    const id = printableId(item)
    return `${labelOf(PRIOR_DECISIONS_MAX + k)}${id ? ` (${id})` : ''}`
  })
  const more = cut.length - named.length
  return `${named.join(', ')}${more ? ` and ${more} more` : ''}`
}

/**
 * The `priorDecisions` argument (or a recall's answer merged with it), checked. Absent → nothing of it applied, no refusal
 * (the engine's own recall still runs: lib/memory-recall.mjs). Anything else that is not a list → nothing applied, each problem named.
 * @param {unknown} raw @param {(i: number) => string} [labelOf] how a refusal names the record at index i
 * @returns {{ decisions: PriorDecision[], refused: string[] }}
 */
function parsePriorDecisions(raw, labelOf = decisionLabel) {
  if (raw == null || raw === '') return { decisions: [], refused: [] }
  if (typeof raw === 'string') return { decisions: [], refused: ['priorDecisions arrived as a string — only a list inside an object argument is read (in a key=value string nothing from priorDecisions on was read as an option) — no decision applied'] }
  const list = raw
  if (!Array.isArray(list)) return { decisions: [], refused: ['priorDecisions is not a list — no decision applied'] }
  /** @type {PriorDecision[]} */
  const decisions = []
  /** @type {string[]} */
  const refused = []
  list.slice(0, PRIOR_DECISIONS_MAX).forEach((item, i) => {
    const d = readPriorDecision(item, labelOf(i))
    if (typeof d === 'string') refused.push(d)
    else if (decisions.some(x => x.id === d.id)) refused.push(`${labelOf(i)} (${d.id}) repeats an id already given — not applied`)
    else decisions.push(d)
  })
  if (list.length > PRIOR_DECISIONS_MAX) {
    refused.push(`${list.length - PRIOR_DECISIONS_MAX} decision(s) past the cap of ${PRIOR_DECISIONS_MAX} were not applied — findings they would answer are raised normally: ${cutNames(list.slice(PRIOR_DECISIONS_MAX), labelOf)}`)
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
const RECALL_PATHS_MAX = 60

const RECORD_TEXT_FIELDS = ['id', 'kind', 'title', 'body', 'scope', 'status', 'date', 'author', 'commit']

const MEMORY_RECALL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['backend', 'why', 'decisions'],
  properties: {
    backend: { type: 'string', description: 'the memory backend recall used, or none' },
    why: { type: 'string', description: 'one line: the rule that chose the backend, or why there is none, or that recall found nothing' },
    decisions: {
      type: 'array', description: 'the matching active decision records, verbatim',
      items: { type: 'object', properties: { ...Object.fromEntries(RECORD_TEXT_FIELDS.map(k => [k, { type: 'string' }])), deferred: { type: 'boolean' }, links: { type: 'array', items: { type: 'string' } } } },
    },
    questions: {
      type: 'array', description: 'the matching active question records (open questions, deferred findings among them), verbatim',
      items: { type: 'object', properties: { ...Object.fromEntries(RECORD_TEXT_FIELDS.map(k => [k, { type: 'string' }])), deferred: { type: 'boolean' }, links: { type: 'array', items: { type: 'string' } } } },
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
  return `Recall the remembered decisions and open questions of this project for a code review. READ ONLY: write, record, edit or create nothing anywhere (no memory record, no file, no MCP create call).
Scope: ${scope}
1. Invoke the craft:memory skill with the Skill tool and run its recall for those paths, no topic, status active only: once for kind decision, once for kind question.
2. If that skill is unavailable, follow its backend order yourself; the first that applies wins: (a) an explicit setting, env CRAFT_MEMORY, else a line \`craft-memory: <value>\` in AGENTS.md or CLAUDE.md at the repo root (mcp | harness | repo | none; a pinned backend that is unavailable means none); (b) a connected memory or knowledge-graph MCP server found by capability: load the deferred tools of the session with ToolSearch and take a server whose tools offer both a search over stored items and a create of a new item, judged by what the tools do, never by a server or tool name; use only its search; (c) the project memory files of the harness: Claude Code keeps them in \`~/.claude/projects/<slug>/memory/\` with \`MEMORY.md\` as the index, keyed by the repository's main checkout, never a worktree or subdirectory: root = \`dirname "$(git rev-parse --path-format=absolute --git-common-dir)"\`, \`pwd\` only outside a git repo; <slug> = root with every character that is not an ASCII letter or digit replaced by \`-\` (for example \`/home/alice/src/app\` → \`-home-alice-src-app\`) — an observed convention, not a documented one; \`~/.claude/projects/<slug>/memory\` must exist: read MEMORY.md, then only the matching files; else say \`none — harness memory directory <path>/memory not found\` and never guess a near match; (d) \`.craft/memory/decision/\` and \`.craft/memory/question/\` in the repo. None applies: backend none.
3. A record matches a path when its scope equals the path, is a directory containing it, names its component, or is \`.\`.
4. A stale matching decision — one that no longer holds against the code as it is now (its reason is gone): supersede nothing — leave it out of decisions and list it in stale as {id, why}; superseding stays with craft:addressing-findings.
Return {backend, why, decisions, questions, stale}: backend names the store used (or none); why is one line naming the rule that chose it, or why there is none, or that recall found nothing; decisions are the matching active decision records verbatim in the record shape id, kind, title, body, scope, status, date, author, commit, deferred, links (nothing rewritten or summarised; [] when none); questions are the matching active question records in the same shape, verbatim ([] when none); stale is [] when none.`
}

/**
 * Where the decisions came from: `recalled` by this engine, `launcher` — recalled by the engine that
 * launched this one (`_recalled`), or `none`; `passed` counts the launcher's own records (accepted on
 * their own, or as forwarded by the launching audit), `added` those of them the recall did not already
 * hold (under `launcher`: those of them applied; the cap's refusals are named in their own section).
 * @typedef {{ source: 'recalled' | 'launcher' | 'none', count: number, why: string, questions?: number, passed?: number, added?: number }} MemorySource
 */
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
 * The recalled questions, each tagged `kind: question` when it carries no kind (an object without one
 * is still a question: it came back in that list). @param {unknown} list @returns {unknown[]}
 */
function recalledQuestions(list) {
  return (Array.isArray(list) ? list : []).map(q => (q && typeof q === 'object' && !Array.isArray(q) && !('kind' in q) ? { ...q, kind: 'question' } : q))
}

/**
 * What the recall agent returned, read: the decisions and questions to hand to parsePriorDecisions (a
 * list, possibly empty) and the source to report. A dead or off-shape answer applies nothing and is named.
 * @param {unknown} raw @param {number} cut paths past RECALL_PATHS_MAX @returns {{ decisions: unknown[], memory: MemorySource }}
 */
function readMemoryRecall(raw, cut) {
  const r = /** @type {Record<string, unknown>} */ (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})
  const tail = cut > 0 ? `; ${cut} changed path(s) past the bound of ${RECALL_PATHS_MAX} were not recalled for` : ''
  const list = r['decisions']
  if (!Array.isArray(list)) return { decisions: [], memory: { source: 'none', count: 0, why: `the recall agent died or returned no decision list, so nothing recalled was applied — findings are raised normally${tail}` } }
  const backend = recallText(r['backend']) || 'an unnamed backend'
  const why = recallText(r['why']) || 'no reason given'
  const stale = staleTail(r['stale'])
  const questions = recalledQuestions(r['questions'])
  const all = [...list, ...questions]
  if (!all.length) return { decisions: [], memory: { source: 'none', count: 0, why: `${why} (backend ${backend})${stale}${tail}` } }
  return { decisions: all, memory: { source: 'recalled', count: all.length, why: `${backend} (${why})${stale}${tail}`, ...(questions.length ? { questions: questions.length } : {}) } }
}

/**
 * The source before any recall: not yet recalled, with the launcher's accepted records counted; or, when
 * the launching engine already recalled (`_recalled`), its outcome — `note` is why it found none.
 * @param {number} passed the launcher's records accepted @param {boolean} [recalled] @param {unknown} [note]
 * @returns {MemorySource}
 */
function initialMemory(passed, recalled = false, note = '') {
  if (recalled) return { source: 'launcher', count: passed, why: recallText(note) }
  /** @type {MemorySource} */
  const m = { source: 'none', count: 0, why: 'not recalled — the run ended before its recall step' }
  return passed ? { ...m, passed } : m
}

/**
 * The source at an exit that ends the run before its recall step: not yet recalled → why it never will be.
 * @param {MemorySource} m @param {string} why @returns {MemorySource}
 */
function skippedMemory(m, why) {
  return m.source === 'none' ? { ...m, why: `not recalled — ${why}` } : m
}

/**
 * The recalled records with the launcher's appended, one per id: a passed record whose id the recall
 * already holds is dropped — the recalled one is the store's current state. A record without an id is
 * kept, for the reader to refuse by name. `addedAt` is each added record's index in the passed list.
 * @template T @param {T[]} recalled @param {T[]} passed @returns {{ merged: T[], added: number, addedAt: number[] }}
 */
function mergeById(recalled, passed) {
  /** @param {T} x */
  const idOf = x => (x && typeof x === 'object' ? recallText(/** @type {Record<string, unknown>} */ (x)['id']) : '')
  const held = new Set(recalled.map(idOf).filter(Boolean))
  const addedAt = passed.flatMap((x, i) => (held.has(idOf(x)) ? [] : [i]))
  return { merged: [...recalled, ...addedAt.map(i => /** @type {T} */ (passed[i]))], added: addedAt.length, addedAt }
}

/**
 * The source with the launcher's part: nothing when it passed no record.
 * @param {MemorySource} m @param {number} passed @param {number} added @returns {MemorySource}
 */
function withPassed(m, passed, added) {
  return passed ? { ...m, passed, added } : m
}

/**
 * A merged list (its first `recalledLen` records the recall's, the rest the launcher's) read ONCE by
 * `parse`, so one cap holds across both parts; each refusal names its part (`passedAt` maps a passed
 * record back to its index in the launcher's list). The applied records split by part.
 * @template {{ id: string, kind?: string }} D
 * @param {unknown[]} list @param {number} recalledLen @param {ParseDecisions<D>} parse @param {number[]} [passedAt]
 * @returns {{ prior: { decisions: D[], refused: string[] }, recalled: D[], passed: number }}
 */
function parseMerged(list, recalledLen, parse, passedAt = []) {
  /** @param {number} i */
  const labelOf = i => (i < recalledLen ? `recalled decision #${i}` : `passed decision #${passedAt[i - recalledLen] ?? i - recalledLen}`)
  const prior = parse(list, labelOf)
  const held = new Set(list.slice(0, recalledLen).flatMap(x => (x && typeof x === 'object' ? [recallText(/** @type {Record<string, unknown>} */ (x)['id'])] : [])))
  const recalled = prior.decisions.filter(d => held.has(d.id))
  return { prior, recalled, passed: prior.decisions.length - recalled.length }
}

/**
 * The recall's answer merged RAW with the launcher's `priorDecisions` (the recalled record kept on an id
 * clash), then read once by `parse` (parsePriorDecisions) under its one cap: the decisions to apply,
 * every refusal (a launcher's argument that is no list still named), the refusals not already logged at
 * launch (the recall's and the cap's), and the source.
 * @template {{ id: string, kind?: string }} D
 * @param {{ decisions: unknown[], memory: MemorySource }} r @param {unknown} passedRaw @param {ParseDecisions<D>} parse
 * @returns {{ prior: { decisions: D[], refused: string[] }, recalledRefused: string[], memory: MemorySource }}
 */
function mergeRecall(r, passedRaw, parse) {
  const alone = parse(passedRaw)
  const { merged, added, addedAt } = mergeById(r.decisions, Array.isArray(passedRaw) ? /** @type {unknown[]} */ (passedRaw) : [])
  const m = parseMerged(merged, r.decisions.length, parse, addedAt)
  return {
    prior: { decisions: m.prior.decisions, refused: Array.isArray(passedRaw) ? m.prior.refused : [...alone.refused, ...m.prior.refused] },
    recalledRefused: m.prior.refused.filter(x => !x.startsWith('passed decision #')),
    memory: withPassed(acceptedMemory(r.memory, m.recalled), alone.decisions.length, added),
  }
}

/**
 * How a launching audit's forwarded list splits (`_memoryParts`): the first `recalled` records its
 * recall's, the next `passed` its launcher's. Anything off-shape, or not adding up to the list, is ignored.
 * @param {unknown} parts @param {unknown} list @returns {{ recalled: number, passed: number } | null}
 */
function memoryParts(parts, list) {
  const p = /** @type {Record<string, unknown>} */ (parts && typeof parts === 'object' ? parts : {})
  const [recalled, passed] = [p['recalled'], p['passed']]
  if (!Array.isArray(list) || !Number.isInteger(recalled) || !Number.isInteger(passed)) return null
  const [a, b] = [/** @type {number} */ (recalled), /** @type {number} */ (passed)]
  return a >= 0 && b >= 0 && a + b === list.length ? { recalled: a, passed: b } : null
}

/**
 * The `priorDecisions` argument read at launch, and the source before any recall. A launcher that
 * already recalled and says how its list splits (`partsArg`) gets each refusal and the memory line
 * named by part; otherwise the list is read as one.
 * @template {{ id: string, kind?: string }} D
 * @param {unknown} raw @param {boolean} recalled `_recalled` @param {unknown} note `_memory` @param {unknown} partsArg `_memoryParts`
 * @param {ParseDecisions<D>} parse @returns {{ prior: { decisions: D[], refused: string[] }, memory: MemorySource }}
 */
function readLaunch(raw, recalled, note, partsArg, parse) {
  const parts = recalled ? memoryParts(partsArg, raw) : null
  if (!parts) {
    const prior = parse(raw)
    return { prior, memory: acceptedMemory(initialMemory(prior.decisions.length, recalled, note), prior.decisions) }
  }
  const m = parseMerged(/** @type {unknown[]} */ (raw), parts.recalled, parse)
  return { prior: m.prior, memory: withPassed(acceptedMemory(initialMemory(0, true, note), m.prior.decisions), parts.passed, m.passed) }
}

/**
 * A recalled source (by this engine or the launching one) once parsePriorDecisions read its list: the
 * count is the records it accepted, the questions among them counted apart; the refused are named in their own section.
 * @param {MemorySource} m @param {Array<{ kind?: string }>} accepted @returns {MemorySource}
 */
function acceptedMemory(m, accepted) {
  if (m.source === 'none') return m
  const questions = accepted.filter(d => d.kind === 'question').length
  /** @type {MemorySource} */
  const out = { source: m.source, count: accepted.length, why: m.why }
  return questions ? { ...out, questions } : out
}

/** `N decision(s) and M open question(s)` of a source. @param {MemorySource} m @returns {string} */
function countedRecords(m) {
  const q = m.questions || 0
  return `${m.count - q} decision(s)${q ? ` and ${q} open question(s)` : ''}`
}

/**
 * The line of a review the launching audit recalled for: what it applied — split into the audit's
 * recall and its launcher's records when the audit said how (`_memoryParts`) — or why that recall found
 * none (and what the audit's own launcher passed). @param {MemorySource} m @returns {string}
 */
function launcherLine(m) {
  const parts = m.passed ? ` — ${m.count - (m.added ?? 0)} recalled, ${m.added ?? 0} of the ${m.passed} passed by its launcher` : ''
  if (!m.why) return `memory: recalled by the launching audit — ${m.count ? `applied ${countedRecords(m)}${parts}` : `none${parts}`}`
  return `memory: recalled by the launching audit — none (${m.why})${m.count ? `; applied ${m.count} passed by its launcher` : ''}`
}

/**
 * One line, both parts: what the recall gave, then what the launcher added.
 * @param {MemorySource} m @param {boolean} [forwarded] the list went unparsed to nested reviews (rust-audit):
 * the count is what recall returned, not what was accepted @returns {string}
 */
function memoryLine(m, forwarded = false) {
  if (m.source === 'launcher') return launcherLine(m)
  const plus = m.passed ? `; plus ${m.passed} passed by the launcher${m.source === 'recalled' ? ` (${m.added ?? m.passed} new)` : ''}` : ''
  if (m.source !== 'recalled') return `memory: none — ${m.why}${plus}`
  return forwarded
    ? `memory: returned ${countedRecords(m)} from ${m.why}${plus}; each nested review reports how many it applied`
    : `memory: recalled ${countedRecords(m)} from ${m.why}${plus}`
}

/** The report section naming the source. @param {MemorySource} m @param {boolean} [forwarded] @returns {string} */
function memorySection(m, forwarded = false) {
  return `\n\n## Memory\n- ${memoryLine(m, forwarded)}\n`
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
    return { decisions: [], memory: { source: 'none', count: 0, why: `the recall agent did not run (${msg}) — nothing recalled applied; findings are raised normally` } }
  }
  return readMemoryRecall(raw, Math.max(0, paths.length - RECALL_PATHS_MAX))
}
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
/**
 * A question's deferral as a structured field on the ledger row: its id, reason, author, date, link and
 * commit. A carried row is read by this field, never by the mark in its `why` — the between-round
 * transport cuts every `why` at its cap, and the mark sits at the tail.
 * @typedef {{ id: string, reason: string, who: string, when: string, link: string, commit: string }} Deferral
 */
/**
 * The deferral a question record (a PriorDecision of kind `question`) sets on the finding it sets aside.
 * @param {Deferral} d @returns {Deferral}
 */
function deferralOf(d) {
  return { id: d.id, reason: d.reason, who: d.who, when: d.when, link: d.link, commit: d.commit }
}

/**
 * The deferral a ledger row carries, every part a string; null when it carries none (a row marked
 * `deferred` with no question record behind it).
 * @param {unknown} v @returns {Deferral | null}
 */
function deferralOn(v) {
  if (!v || typeof v !== 'object') return null
  const o = /** @type {Record<string, unknown>} */ (v)
  /** @param {string} k */
  const s = k => (typeof o[k] === 'string' ? /** @type {string} */ (o[k]) : '')
  return s('id') ? { id: s('id'), reason: s('reason'), who: s('who'), when: s('when'), link: s('link'), commit: s('commit') } : null
}
/** What a record is called in a note: `decision` or `question`. @param {PriorDecision} d @returns {string} */
function priorKindLabel(d) {
  return d.kind === 'question' ? 'question' : 'decision'
}

/**
 * Whether a record is a deferral or a decision — the records a finding is matched against. A question is
 * a deferral only when it says so, `deferred: true` (addressing-findings writes it when the author
 * defers; the memory skill's record shape documents it). A question without it (a needs-decision
 * question) is context: its finding is raised normally, unlabelled.
 * @param {PriorDecision} d
 */
function matchesFindings(d) {
  return d.kind !== 'question' || d.deferred
}

/**
 * Whether a record can set a finding aside: every decision; a question only when it records a deferral
 * (`deferred: true`) AND a commit, which the scope check compares against. A deferral without a commit
 * is still matched (matchesFindings) so its finding is raised again and named, never silently.
 * @param {PriorDecision} d
 */
function recordsDeferral(d) {
  return d.kind !== 'question' || (d.deferred && !!d.commit)
}

/**
 * Whether a carried deferral no longer holds: a record in hand (recalled or passed) names its question
 * in a `supersedes:` / `answers:` link — the memory skill's own way to close a question. The question's
 * ABSENCE never releases it (realm @nick/craft, node #204): absence has benign causes — a launcher
 * forwarding decisions only, a recall answer without its optional `questions` list, a recall from
 * another backend than the one the deferral was written to.
 * @param {Deferral} deferral @param {PriorDecision[]} records
 */
function deferralReleased(deferral, records) {
  return records.some(d => d.supersedes.includes(deferral.id))
}

/** The KNOWN AND DEFERRED mark of a deferral. @param {Deferral} x */
function deferralMark(x) {
  return `KNOWN AND DEFERRED: ${x.reason} — ${x.who || 'author not recorded'}, ${x.when || 'date not recorded'}, ${x.link || 'no link'} (question ${x.id})`
}

/** The mark a set-aside finding carries. @param {PriorDecision} d */
function priorDecisionMark(d) {
  if (d.kind === 'question') return deferralMark(deferralOf(d))
  return `REJECTED BEFORE: ${d.reason} — ${d.who || 'author not recorded'}, ${d.when || 'date not recorded'}, ${d.link || 'no link'} (${priorKindLabel(d)} ${d.id})`
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
  if (reraisedBySeverity(f.severity)) return `a Critical/High finding is never set aside by a prior ${d.kind === 'question' ? 'deferred question' : 'decision'}`
  if (!d.commit) return `the ${priorKindLabel(d)} records no commit, so an unchanged scope cannot be established`
  if (missing.has(d.id)) return commitMissingReason(d)
  if (!unchanged.has(d.id)) return `the code in ${d.scope} changed since ${d.commit} (or that could not be checked)`
  return ''
}

/** The note a finding raised again despite record `d` carries. @param {PriorDecision} d @param {string} why */
function reraisedNote(d, why) {
  const before = d.kind === 'question' ? 'Deferred before' : 'Rejected before'
  return `${before} (${priorKindLabel(d)} ${d.id}, ${d.who || 'author not recorded'}, ${d.when || 'date not recorded'}) — raised again: ${why}.`
}

/**
 * Split one tier's findings by the decisions. `unchanged` holds the ids of decisions whose scope was
 * observed unchanged since their commit; every other decision cannot set a finding aside. The mark
 * is appended to `noteField` — `why` in review, `description` in adversarial-review.
 * @template {DecidableFinding} F
 * @param {F[]} findings @param {PriorDecision[]} decisions @param {Set<string>} unchanged @param {string} tier @param {string} [noteField]
 * @param {Set<string>} [missing]  ids whose commit the repo does not know
 * @returns {{ kept: F[], setAside: Array<SetAside<F>>, reraised: number }}
 */
function splitByDecisions(findings, decisions, unchanged, tier, noteField = 'why', missing = new Set()) {
  /** @type {F[]} */
  const kept = []
  /** @type {Array<SetAside<F>>} */
  const setAside = []
  let reraised = 0
  for (const f of findings) {
    const d = decisions.find(x => decisionAnswers(f, x))
    if (!d) { kept.push(f); continue }
    const why = reraiseReason(f, d, unchanged, missing)
    const note = `${String(f[noteField] ?? '')} · `
    if (!why) {
      const deferral = d.kind === 'question' ? { deferral: deferralOf(d) } : {}
      setAside.push({ ...f, priorTier: String(f.tier || tier), priorDecision: d.id, priorKind: d.kind, ...deferral, [noteField]: note + priorDecisionMark(d) })
      continue
    }
    reraised++
    kept.push({ ...f, [noteField]: note + reraisedNote(d, why) })
  }
  return { kept, setAside, reraised }
}

/**
 * A `why` without its KNOWN AND DEFERRED mark, whole or cut by the transport anywhere inside it.
 * @param {string} why
 */
function whyWithoutDeferredMark(why) {
  const head = ' · KNOWN AND DEFERRED'
  const at = why.indexOf(head)
  if (at >= 0) return why.slice(0, at)
  for (let n = head.length - 1; n > 2; n--) if (why.endsWith(head.slice(0, n))) return why.slice(0, -n)
  return why
}

/**
 * The report sections listing the findings set aside, each with its mark: those a decision answers
 * under Rejected before, those a deferred question answers under Known and deferred — the mark of a
 * deferred one rendered from its structured deferral, so a `why` the transport cut loses none of it.
 * @param {Array<DecidableFinding & { priorKind?: string, deferral?: unknown }>} setAside @returns {string}
 */
function priorRejectedSection(setAside) {
  /** @param {DecidableFinding & { deferral?: unknown }} f */
  const note = f => {
    const deferral = deferralOn(f.deferral)
    return deferral ? `${whyWithoutDeferredMark(String(f.why ?? ''))} · ${deferralMark(deferral)}` : String(f.why ?? '')
  }
  /** @param {DecidableFinding & { deferral?: unknown }} f */
  const setAsideLine = f => `- ${String(f.severity ?? '?')} · \`${String(f.file || '?')}:${String(f['line'] || 0)}\` · ${String(f.title ?? '')} · ${note(f)}`
  const rejected = setAside.filter(f => f.priorKind !== 'question')
  const deferred = setAside.filter(f => f.priorKind === 'question')
  return (rejected.length ? `\n\n## Rejected before (set aside — not in the verdict)\n${rejected.map(setAsideLine).join('\n')}` : '')
    + (deferred.length ? `\n\n## Known and deferred (open question — not in the verdict)\n${deferred.map(setAsideLine).join('\n')}` : '')
}

/**
 * Applies the decisions to every tier of an engine's findings. `checkScopes` runs the scope check for
 * the decisions it is handed (never called with none) and returns the agent's raw answer. `refused`:
 * the decisions whose commit the repo does not know, for the report's Prior decisions not applied.
 * @template {DecidableFinding} F
 * @param {Record<string, F[]>} tiers @param {PriorDecision[]} given  questions that record no deferral are dropped (matchesFindings)
 * @param {(toCheck: PriorDecision[]) => Promise<unknown>} checkScopes @param {string} [noteField]
 * @returns {Promise<{ tiers: Record<string, F[]>, setAside: Array<SetAside<F>>, reraised: number, notes: string[], refused: string[] }>}
 */
async function applyPriorDecisions(tiers, given, checkScopes, noteField = 'why') {
  /** @type {Array<SetAside<F>>} */
  let setAside = []
  /** @type {string[]} */
  const notes = []
  const context = given.length - given.filter(matchesFindings).length
  if (context) notes.push(`${context} open question(s) record no deferral — context only, set nothing aside`)
  const replaced = new Set(given.flatMap(d => d.supersedes))
  const superseded = given.filter(d => matchesFindings(d) && replaced.has(d.id))
  if (superseded.length) notes.push(`${superseded.length} record(s) superseded by another given record — not applied: ${superseded.map(d => d.id).join(', ')}`)
  const decisions = given.filter(d => matchesFindings(d) && !replaced.has(d.id))
  if (!decisions.length) return { tiers, setAside, reraised: 0, notes, refused: [] }
  const { toCheck, unchanged, missing } = await runScopeCheck(decisionsToCheck(Object.values(tiers).flat(), decisions), checkScopes, notes)
  const refused = decisions.filter(d => !recordsDeferral(d)).map(d => `question ${d.id}: records a deferral but no commit, so an unchanged scope cannot be established — raised normally`)
    .concat(toCheck.filter(d => missing.has(d.id)).map(d => `${priorKindLabel(d)} ${d.id}: ${commitMissingReason(d)}`))
  let reraised = 0
  /** @type {Record<string, F[]>} */
  const out = {}
  for (const [tier, list] of Object.entries(tiers)) {
    const r = splitByDecisions(list, decisions, unchanged, tier, noteField, missing)
    out[tier] = r.kept
    setAside = setAside.concat(r.setAside)
    reraised += r.reraised
  }
  const questions = decisions.filter(d => d.kind === 'question').length
  const deferred = setAside.filter(f => f.priorKind === 'question').length
  notes.push(`${decisions.length - questions} decision(s) given, ${setAside.length - deferred} finding(s) set aside as rejected before, ${reraised} raised again`
    + (questions ? `; ${questions} deferred question(s) given, ${deferred} finding(s) set aside as known and deferred` : ''))
  return { tiers: out, setAside, reraised, notes, refused }
}

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
/** @param {unknown} abs @param {unknown} repo */
function relativeToRepo(abs, repo) {
  const r = pathSegments(repo)
  const p = pathSegments(abs)
  if (!r.length || p.length < r.length) return null
  for (let i = 0; i < r.length; i++) if (p[i] !== r[i]) return null
  return p.slice(r.length).join('/')
}
function resolveScopePath() {
  if (ABSOLUTE_PATH.test(pathArg)) {
    const rel = repoArg ? relativeToRepo(pathArg, repoArg) : null
    if (rel != null) {
      log(`⚠️ path=${pathArg} is absolute but sits inside repo=${repoArg} — read as the repo-relative scope ${shq(rel)}.`)
      pathArg = rel
    } else if (repoArg) {
      const msg = `the requested scope path=${pathArg} was DROPPED: it is ABSOLUTE and does not resolve inside repo=${repoArg}, and an absolute pathspec matches nothing (the review would have seen an EMPTY diff). The review below therefore covers the WHOLE repository, not the requested scope — re-run with a repo-relative path to narrow it.`
      log(`⚠️ ${msg}`)
      scopeNotRun = ['the requested scope was DROPPED — an absolute `path` that does not resolve inside `repo`, so the review covered the whole repository instead']
      scopeDetail = msg
      pathArg = ''
    } else {
      ambiguousPath = pathArg
    }
  }
}
resolveScopePath()
const craftRootArg = argString('craftRoot')
const loggerPreludeNow = () => loggerPrelude(craftRootArg, CRAFT_VERSION, repoArg)
const LOGGER_PATH = '"$CRAFT_LOGGER"'
const viaArg = argString('_via')   // set by a parent workflow (e.g. rust-audit)
const strict = !!A['strict']   // harsh maintainability mode: confirmed maintainability findings become presumptive blockers
const recalledByLauncher = A['_recalled'] === true
const launch = readLaunch(A['priorDecisions'], recalledByLauncher, argString('_memory'), A['_memoryParts'], parsePriorDecisions)
let priorDecisionsIn = launch.prior
let memory = launch.memory
for (const r of priorDecisionsIn.refused) log(`⚠️ priorDecisions: ${r}`)
const requestedLangs = A['languages']
const freshArg = !!A['fresh']   // force a full first-pass review, ignore any prior round
const fullEvery = fullEveryArg()
/** @returns {number} */
function fullEveryArg() {
  return (A['fullEvery'] != null) ? Math.max(0, Number(A['fullEvery'])) : 3
}

const GATE_TIME_BUDGET = `
TIME BUDGET (hard): wrap EVERY build/lint/test command in \`timeout\` so the shell kills it instead of
you waiting — e.g. \`timeout 600 cargo clippy … ; echo "EXIT=\${PIPESTATUS[0]}"\`. Allow roughly 10
minutes for the primary gate command and 5 for each optional one. A command that hits the timeout is
NOT a failure and NOT a retry: record that signal as unknown, say in notes which command timed out and
after how long, and move on to the next one. Never re-run a timed-out build hoping it is faster the
second time — the cache is no warmer and you will spend the whole review on it. status=fail is
reserved for a check that actually RAN and came back red. If the primary gate times out, the review
continues on the remaining signals with status=unknown — an incomplete gate beats a dead run.`

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
/** @param {Preflight | null | undefined} pf */
function preflightIsPartial(pf) {
  if (!pf) return false
  if (pf.partial === true) return true
  return /\bPARTIAL:/.test(flattenField(pf.notes || ''))
}

/** @param {Preflight | null | undefined} pf */
function preflightBrief(pf) {
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

const CONDITIONAL_LENSES = ['failure-windows']

/** @type {Record<string, keyof NonNullable<ScoutAnswer['surfaces']>>} */
const SURFACE_GATED_LENSES = { 'negative-space': 'crossBoundarySymbol', 'compat': 'wireForm', 'invariants': 'invariantType' }

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

const OPTIONAL_LENSES = ['performance', 'api-idioms', 'api-boundary']

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
/** @type {Set<string>} */
const optionalDispatched = new Set()
/** @type {Set<string>} */
const optionalNamedByCritic = new Set()
const optionalTally = () => optionalTallyFrom(results, optionalDispatched, optionalRequested)
const optionalSection = () => {
  const skipped = optionalTally().skipped
  if (!skipped.length) return ''
  const named = skipped.filter(l => optionalNamedByCritic.has(l))
  if (failedProfiles(results).length) {
    const unrequested = skipped.filter(l => !optionalRequested.includes(l))
    const criticLine = named.length ? `\n⚠️ The completeness critic named ${named.join(', ')} as an uncovered surface for THIS diff. It was not dispatched; once the gate is green, weigh including it in that re-run.\n` : ''
    return `\n\n## Not looked at — the optional pass did not run\n⚠️ These lenses were NOT dispatched, so this review makes NO statement about what they cover: ${skipped.join(', ')}. That is an absence of a result, not a clean one. The mechanical gate is red, which blocks this review by itself — fix the gate first.${unrequested.length ? ` ${unrequested.join(', ')} ${unrequested.length === 1 ? 'is' : 'are'} off by default; add \`optional=${unrequested.join(',')}\` to the re-run only if you want ${unrequested.length === 1 ? 'it' : 'them'}.` : ''}\n` + criticLine
  }
  const criticLine = named.length ? `\n⚠️ The completeness critic named ${named.join(', ')} as an uncovered surface for THIS diff. It was still not dispatched — the optional pass is bought by an explicit request, not by a model mid-run — so buy it deliberately with \`optional=${named.join(',')}\`.\n` : ''
  return `\n\n## Not looked at — the optional pass did not run\n⚠️ These lenses were NOT dispatched, so this review makes NO statement about what they cover: ${skipped.join(', ')}. That is an absence of a result, not a clean one. They are off by default because they returned no High findings on the run that was measured — one diff of one repository, so the basis is a single point, not a settled law; to buy them, re-run with \`optional=true\` (or \`optional=${skipped.join(',')}\`).\n`
    + criticLine
}

/** @type {Result[]} */
const results = []
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
/** @type {Set<string>} */
const surfaceGateDispatched = new Set()
/** @type {Set<string>} */
const surfaceGateNamedByCritic = new Set()
const surfaceGateTally = () => ({ dropped: savedSurfaceDrops(results, surfaceGateDispatched) })
const surfaceGateSection = () => {
  const dropped = surfaceGateTally().dropped
  if (!dropped.length) return ''
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
    whyRef: {
      type: 'object',
      additionalProperties: false,
      required: ['record', 'fp'],
      properties: {
        record: { type: 'string' },
        fp: { type: 'string' },
      },
    },
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
/** @type {Schema<AttackAnswer>} */
const ATTACK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['defeated', 'attack'],
  properties: {
    defeated: { type: 'boolean', description: 'true only if a concrete input/state defeats the fix' },
    attack: { type: 'string', description: 'the concrete input/state and why it slips past the fix; empty if none found' },
  },
}

const CRAFT_VERSION = '0.24.0' // x-release-please-version
/** @type {Record<string, number>} */
const SEV_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 }
/** @type {Record<string, string>} */
const DEMOTE = { Critical: 'High', High: 'Medium', Medium: 'Low', Low: 'Info', Info: 'Info' }
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
    whereChecked: flattenField(f['whereChecked']),
  }
}
/** @param {unknown} s */
function shq(s) { return `'${String(s ?? '').replace(/'/g, `'\\''`)}'` }
/** @param {unknown} s */
function isCommitish(s) {
  const v = String(s ?? '').trim()
  if (!v) return false
  if (/^[0-9a-fA-F]{7,40}$/.test(v)) return true
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(v)
}

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

/** @param {{ invariant?: unknown }} adj @param {Finding} f */
function redTeamInvariant(adj, f) {
  return sanitizeAttack(adj.invariant) || sanitizeAttack(f['why'])
}

const AGENT_TRIES = 2
const REPO_DIRECTIVE = repoDirective()
function repoDirective() {
  return repoArg
    ? `WORKING DIRECTORY: this review targets the repository at ${shq(repoArg)} — NOT the directory you start in. Before ANY git / cargo / nix / file command, \`cd\` there (or pass \`git -C\`). Every file path in this review is relative to that root. If that directory does not exist or is not a git repository, say so and stop rather than reviewing whatever repo you happen to be sitting in.\n\n`
    : ''
}

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

const DEADLINE_HIT = { craftDeadline: true }
const DEFAULT_DEADLINE_MS = 1800000
/** @type {Record<string, number>} */
const PHASE_DEADLINE_MS = { Scout: 900000, Gate: 1800000, Lenses: 5400000, Verify: 1800000, Adjudicate: 1800000, Synthesize: 1800000 }
const deadlineArg = deadlineArgMs()
function deadlineArgMs() {
  return Number(A['deadlineMs']) > 0 ? Number(A['deadlineMs']) : 0
}
const RETRY_FLOOR_MS = 60000
const retryFloorMs = (/** @type {unknown} */ totalMs) => Math.min(RETRY_FLOOR_MS, Math.floor((Number(totalMs) > 0 ? Number(totalMs) : 0) / 2))
function announceDeadlineOverride() {
  if (deadlineArg) {
    const m = (/** @type {number} */ v) => (v >= 60000 ? `${Math.round(v / 60000)}min` : `${Math.max(1, Math.round(v / 1000))}s`)
    const moved = (/** @type {number} */ dir) => Object.entries(PHASE_DEADLINE_MS).filter(([, v]) => (dir < 0 ? v > deadlineArg : v < deadlineArg)).map(([k, v]) => `${k} ${m(v)}→${m(deadlineArg)}`)
    const shortened = moved(-1)
    const lengthened = moved(1)
    log(`⏱️ deadlineMs=${deadlineArg} replaces the per-phase deadline table for every phase that does not name its own`
      + `${shortened.length ? ` — SHORTENING ${shortened.join(', ')}. A phase cut below the live distribution will fire its deadline on healthy agents, and a transcript full of deadline fires reads like an API outage.` : ''}`
      + `${lengthened.length ? ` — LENGTHENING ${lengthened.join(', ')}.` : ''}`
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
  const { deadlineMs: _deadlineMs, breaker, ...agentOpts } = opts
  const ms = deadlineMsFor(opts)
  const budget = makeDeadlineBudget(ms, { floorMs: retryFloorMs(ms) })
  try {
    return /** @type {T | null} */ (await withBudget(prompt, agentOpts, budget, breaker, opts))
  } finally {
    budget.dispose()
  }
}

/** @param {string} prompt @param {AgentOptions} agentOpts @param {ReturnType<typeof makeDeadlineBudget>} budget @param {ReturnType<typeof makeDeathBreaker> | null | undefined} breaker @param {AgentOpts} opts @returns {Promise<unknown>} */
async function withBudget(prompt, agentOpts, budget, breaker, opts) {
  for (let attempt = 1; ; attempt++) {
    const o = attempt === 1 ? agentOpts : { ...agentOpts, label: `retry:${agentOpts.label || 'agent'}` }
    const res = await Promise.race([agent(`${REPO_DIRECTIVE}${prompt}`, o), budget.hit])
    const spentOut = budget.belowFloor()
    if (res === DEADLINE_HIT) {
      logDeadlineFire(o, budget)
      return null
    }
    if (res !== null && res !== undefined) {
      if (breaker) breaker.recordLive()
      return res
    }
    if (!redispatchAfterDeath(attempt, spentOut, budget, breaker, opts)) return null
  }
}

/** A deadline fire, logged against the budget it spent. @param {AgentOptions} o @param {ReturnType<typeof makeDeadlineBudget>} budget */
function logDeadlineFire(o, budget) {
  const ms = budget.total()
  const waited = ms >= 60000 ? `${Math.round(ms / 60000)}min budget` : `${Math.max(1, Math.round(ms / 1000))}s budget`
  log(`⏱️ agent '${o.label || '?'}' exhausted its ${waited} with no response — abandoning the wait (the deadline is one budget shared by the attempts and a fire spends it, so there is nothing left to re-dispatch into; treated as a dead agent)`)
}

/**
 * After an attempt that came back empty: whether to re-dispatch (true) or treat the agent as dead (false).
 * @param {number} attempt @param {boolean} spentOut @param {ReturnType<typeof makeDeadlineBudget>} budget
 * @param {ReturnType<typeof makeDeathBreaker> | null | undefined} breaker @param {AgentOpts} opts @returns {boolean}
 */
function redispatchAfterDeath(attempt, spentOut, budget, breaker, opts) {
  if (attempt >= AGENT_TRIES) return false
  if (spentOut) {
    log(`⏱️ agent '${opts.label || '?'}' returned no result with less than the ${Math.round(retryFloorMs(budget.total()) / 1000)}s floor left of its ${Math.round(budget.total() / 1000)}s deadline budget — NOT re-dispatching (a second attempt would time out before it could answer); treated as a dead agent`)
    return false
  }
  if (breaker && !breaker.deathAllowsRedispatch()) {
    log(`⛔ agent '${opts.label || '?'}' returned no result — ${breaker.deaths()} of the last ${breaker.observed()} windowed verification dispatches returned nothing, so this one is NOT re-dispatched (the re-dispatch is for a one-off failure, and at this rate it is not one); treated as a dead agent, reported as unverified exactly like every other death`)
    return false
  }
  log(`⚠️ agent '${opts.label || '?'}' returned no result (API death or skip) — re-dispatching once`)
  return true
}

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
/** @type {string[]} */
const telemetryLost = []
/** @param {string} what @param {unknown} [why] */
function noteTelemetryLoss(what, why) {
  const line = `${what}${why ? ` — ${why}` : ''}`
  telemetryLost.push(line)
  log(`⚠️ telemetry lost: ${line}`)
}
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

/** @type {string | null} */
let reReviewMemoryNote = null
const reReviewMemorySection = () => (reReviewMemoryNote ? `## ⚠️ Re-review memory off\n${reReviewMemoryNote}\n\n` : '')
/** @type {{ id: string, agent: string, error: string }[]} */
const reviewerAgentUnavailable = []
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
/** @param {Profile} profile @param {unknown} error */
function noteReviewerAgentMissing(profile, error) {
  if (!reviewerAgentUnavailable.some(x => x.id === profile.id)) reviewerAgentUnavailable.push({ id: profile.id, agent: profile.reviewerAgent, error: String(error || '').slice(0, 160) })
}
/** @type {Record<string, number>} */
const reviewerAgentFallbacks = {}
/** @type {Record<string, string>} */
const reviewerAgentNames = {}           // profile id -> its reviewer agent type, for the report line
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

/** @param {string} reportText */
function out(reportText) {
  return `${telemetryLostSection(telemetryLost)}${reReviewMemorySection()}${reviewerAgentSection()}${reportText}${optionalSection()}${surfaceGateSection()}${memorySection(memory)}${priorDecisionsRefusedSection(priorDecisionsIn.refused)}`
}

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
/** @param {string} phase @param {Record<string, unknown>} payloadIn @param {string} group */
async function checkpoint(phase, payloadIn, group) {
  const payload = { kind: 'workflow', name: 'review', craftVersion: CRAFT_VERSION, ...payloadIn, workflowEngineRevision: ENGINE_REVISION }
  const asked = runDir
  const armRejoin = !runDir && checkpointFailed
  if (armRejoin) rejoinArmed = true
  const { answer: res, threw } = splitThrew(await ragentQuietly(
    checkpointPrompt({ payload, craftRoot: craftRootArg, repo: repoArg, phase, dir: runDir, rejoin: armRejoin }),
    { label: `checkpoint:${phase}`, phase: group, schema: CHECKPOINT_SCHEMA, model: 'haiku', effort: 'low' },
  ))
  if (res?.runDir) {
    if (asked && res.runDir !== asked) {
      noteTelemetryLoss(`phase checkpoint '${phase}'`, `the logger minted ${res.runDir} instead of the run's own ${asked} — earlier phase slices there will not be folded`)
    }
    runDir = res.runDir
  } else {
    checkpointFailed = true
    noteTelemetryLoss(`phase checkpoint '${phase}'`, threw || res?.error || 'the logger agent returned no runDir')
  }
}

const logRun = makeRunLogger({
  call: ragentQuietly,
  phase: 'Synthesize',
  target: () => ({ craftRoot: craftRootArg, repo: repoArg, command: 'finalize', dir: runDir, rejoin: rejoinArmed }),
  prepare: recordIn => ({ ...recordIn, workflowEngineRevision: ENGINE_REVISION }),
  noteLoss: telemetryLossNoter(telemetryLost, log),
})

/** @param {Finding} f */
function key(f) {
  return `${(f['file'] || '').toLowerCase()}:${f['line'] || 0}:${(f['title'] || '').toLowerCase().replace(/\s+/g, ' ').trim()}`
}

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
  if (journalSourced) return true
  const n = Number(fullEvery)
  if (!Number.isFinite(n) || n < 1) return false
  return Number(thisRound) % n === 0
}

/** @param {Profile} profile @param {string | undefined} source */
function isToolSource(profile, source) {
  return !((source !== undefined && profile.lenses.includes(source)) || source === 'negative-space' || source === 'dep-context')
}

phase('Scout')
async function ambiguousPathExit() {
  const msg = `path=${ambiguousPath} is an absolute path and no \`repo\` was given, so it is ambiguous: it could name the REPOSITORY to review (pass it as \`repo\`) or a directory INSIDE the repository to narrow to (pass it relative to the repo root). Nothing ran — re-dispatch with one of those two spellings.`
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null,
    languages: [], verdict: 'INCOMPLETE (ambiguous path)', findings: summarizeFindings([]), dimensions: [], verification: null,
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
  if (!detected) return { exit: await detectDiedExit(), detected: null }
  return { exit: null, detected }
}
const detection = await detectChanges()
if (detection.exit !== null) return detection.exit
const detected = detection.detected
/** What the detect agent resolved, normalised: the base, the changed files, the spec and the run's identity. @param {DetectAnswer} detected */
function detectedChange(detected) {
  const baseRef = detected.baseRef ?? baseArg
  const changedFiles = (Array.isArray(detected.files) ? detected.files : []).map(decodeGitPath)
  const spec = (typeof detected.spec === 'string' ? detected.spec : '').slice(0, 4000)
  const branch = branchFromAbbrevRef((typeof detected.branch === 'string' ? detected.branch : '').trim())
  const head = (typeof detected.head === 'string' ? detected.head : '').trim()
  return { baseRef, changedFiles, spec, branch, head }
}
const { baseRef, changedFiles, spec, branch, head } = detectedChange(detected)

async function loadPriorRound() {
  /** @type {PriorRound | null} */
  let priorRound = null
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
  if (!priorRound?.['found']) {
    priorReason = rejectedPriorReason(priorRound, priorReadThrew)
    priorRound = null
  }
  if (priorRound && !isCommitish(priorRound['head'])) {
    log(`⚠️ prior-round head ${JSON.stringify(priorRound['head'])} is not a safe commit-ish — falling back to the base ref for the fix-range diff`)
    priorRound['head'] = baseRef
  }
  return { priorRound, priorReason }
}
/** @param {PriorRound | null} priorRound @param {string} priorReadThrew */
function rejectedPriorReason(priorRound, priorReadThrew) {
  const priorReason = priorRound?.['reason'] || 'no-prior-round'
  if (priorRound?.['reason']) log(`No prior round: ${priorRound['reason']}`)
  notePriorReadFailure(priorRound, priorReadThrew)
  return priorReason
}
/** @param {PriorRound | null} priorRound @param {string} priorReadThrew */
function notePriorReadFailure(priorRound, priorReadThrew) {
  const READ_FAILURES = ['loader-did-not-run', 'git-unavailable']
  const readFailed = !priorRound || !!priorReadThrew || READ_FAILURES.some(r => String(/** @type {PriorRound} */ (priorRound)['reason'] || '').startsWith(r))
  if (readFailed) {
    noteTelemetryLoss('the prior-round ledger', priorReadThrew || priorRound?.['reason'] || 'the loader agent returned no result')
  }
}
/** @param {PriorRound | null} priorRound */
function announcePriorRound(priorRound) {
  if (priorRound && ledgerTruncated(priorRound)) {
    log(`⚠️ prior-round ledger arrived TRUNCATED: the loader printed ${priorRound['ledgerCount']} entr(ies), ${priorRound['ledger']?.length || 0} survived transport — treating the round as degraded and forcing a full re-scan.`)
  }
  if (priorRound) log(`Re-review: prior round ${priorRound['round']} @ ${flattenField(priorRound['head'])} · ${priorRound['ledger']?.length || 0} ledger finding(s)`)
  else log(freshArg ? 'Fresh review (—fresh): prior round ignored' : 'First review for this branch (no prior round)')
}
const { priorRound, priorReason } = await loadPriorRound()

const reReview = reReviewMemory(priorReason)
function applyReReviewNote() {
  if (reReview.note) {
    reReviewMemoryNote = reReview.note
    log(`⚠️ ${reReview.note}`)
  }
}
applyReReviewNote()

const thisRound = roundNumber()
function roundNumber() {
  return priorRound ? (priorRound['round'] || 1) + 1 : 1
}
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
const lensBase = lensScope()
function lensScope() {
  const lensBase = (priorRound && !fullRescan) ? priorRound.head : baseRef
  if (priorRound) {
    log(`Re-review round ${thisRound} lens scope: ${fullRescan
      ? `FULL base...HEAD re-scan (fullEvery=${fullEvery}${priorLedgerDegraded ? ', ledger degraded' : ''}${priorRoundJournalSourced ? ', prior round journal-sourced' : ''}) — earlier misses in untouched code are re-checked`
      : `incremental delta ${flattenField(priorRound['head'])}...HEAD (fix commits only)`}`)
  }
  return lensBase
}

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
const coverage = resolveCoverage({ profiles: PROFILES, changedFiles, detectedActive, pinnedLangs })
const active = coverage.active
async function coverageExit() {
  if (coverage.outcome === 'no-profile') memory = skippedMemory(memory, 'no language profile for the changed files')
  else if (coverage.outcome !== 'review') memory = skippedMemory(memory, 'nothing to review')
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
const languageStop = unknownLangs.length ? await unknownPinExit() : await coverageExit()
if (languageStop !== null) return languageStop
async function recallMemory() {
  if (recalledByLauncher || !changedFiles.length) return
  const r = await recallDecisions(p => ragent(p, { label: 'memory-recall', phase: 'Scout', schema: MEMORY_RECALL_SCHEMA, effort: 'low' }), changedFiles, baseRef || '')
  const m = mergeRecall(r, A['priorDecisions'], parsePriorDecisions)
  priorDecisionsIn = m.prior
  memory = m.memory
  for (const x of m.recalledRefused) log(`⚠️ priorDecisions: ${x}`)
}
await recallMemory()
function logActiveProfiles() {
  log(`Active profiles: ${active.map(p => p.id).join(', ')}${pinnedLangs ? ` (pinned: ${pinnedLangs.join(',')})` : ''} · base ${baseRef || 'HEAD'}`)
}
logActiveProfiles()

const uncoveredFiles = changedFiles.filter((/** @type {string} */ f) => !active.some(p => p.detect([f])))
const uncoveredGap = coverageGapFiles(uncoveredFiles)
function logUncoveredFiles() {
  if (uncoveredFiles.length) log(`Outside all active profiles (not reviewed): ${uncoveredFiles.join(', ')}${uncoveredGap.length ? ` — ${uncoveredGap.length} unreviewed source file(s)` : ' (docs/assets/lockfiles/project config only — not a coverage gap)'}`)
}
logUncoveredFiles()

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

/** @param {Finding} f @param {number} idx @param {boolean} isTool @param {string} gateProvenance @param {Profile} profile */
function verifyPrompt(f, idx, isTool, gateProvenance, profile) {
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
  const base = /** @type {Finding} */ (members.slice().sort((a, b) => (/** @type {number} */ (/** @type {unknown} */ (isToolSrc(b))) - /** @type {number} */ (/** @type {unknown} */ (isToolSrc(a)))) || ((SEV_RANK[a['severity'] ?? ''] ?? 9) - (SEV_RANK[b['severity'] ?? ''] ?? 9)))[0])
  const others = members.filter(m => m !== base)
  const sources = [...new Set(members.map(m => m['source']).filter(Boolean))]
  const whereChecked = [...new Set(members.map(m => m['whereChecked']).filter(Boolean))].join('; ')
  return { ...base, sources, whereChecked, why: `${base['why']} (same defect also reported by: ${others.map(m => m['source']).join(', ')})` }
}

/** @param {Finding[]} pool @param {Profile} profile */
async function dedupPool(pool, profile) {
  if (pool.length < 2) return pool
  const isToolSrc = (/** @type {Finding} */ f) => isToolSource(profile, f['source'])
  const listing = pool.map((/** @type {Finding} */ f, /** @type {number} */ i) => `${i}. ${f['file'] || '?'}:${f['line'] || 0} [${f['severity']}] (${f['source']}) ${f['title']} — ${String(f['why'] || '').slice(0, 160)}`).join('\n')
  const res = await dedupModelGroups(profile, listing)
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

const CULL_MODEL = 'sonnet'

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

const CRITICAL_TIER_RULES = new Set(['SAF-001', 'SAF-002', 'SAF-003', 'SAF-004', 'SAF-005', 'SAF-006', 'SAF-008', 'ERR-001', 'ERR-002'])
const BATCH_SIZE = 6
/** @param {Finding} f */
function verifyTier(f) {
  if (f['severity'] === 'Critical' || f['severity'] === 'High') return 'individual'
  if (f['severity'] === 'Medium') return 'batch'
  return CRITICAL_TIER_RULES.has(f['ruleId'] || '') ? 'individual' : 'skip'
}
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
/** @type {(f: Finding, why: string) => Finding} */
const NOT_VERIFIED = (f, why) => ({ ...f, tier: 'unverified', why: `${f['why']} (NOT VERIFIED: ${why})` })
/** @param {unknown} res  the batch verifier's answer, which may be off-schema (see VOTE_AXES) */
function batchDeath(res) {
  if (!res) return 'returned nothing at all — a dead agent, an exhausted retry, or an expired deadline'
  const verdicts = /** @type {{ verdicts?: unknown }} */ (res).verdicts
  if (!Array.isArray(verdicts)) return 'answered OFF-SCHEMA — its answer carried no verdict list at all'
  if (!/** @type {unknown[]} */ (verdicts).length) return 'answered with an EMPTY verdict list — it judged nothing'
  return null
}
/** @type {Array<'refuted' | 'citedLineMatches' | 'reachable' | 'premiseSupported'>} */
const VOTE_AXES = ['refuted', 'citedLineMatches', 'reachable', 'premiseSupported']
/** @param {unknown} v  a verifier's answer, typed or not: the schema is not trusted here @returns {v is Vote} */
function isVerdictShaped(v) {
  return !!v && typeof v === 'object' && VOTE_AXES.every(k => typeof (/** @type {Record<string, unknown>} */ (v))[k] === 'boolean')
}
/** @param {Vote | null | undefined} a @param {Vote | null | undefined} b */
function votesAgree(a, b) {
  if (!isVerdictShaped(a) || !isVerdictShaped(b)) return false
  return VOTE_AXES.every(k => a[k] === b[k])
}
/** @param {Finding} f @param {unknown[]} live @param {Vote[]} v @returns {Finding} */
function decideTier(f, live, v) {
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
  return { ...f, tier, ...(demoted === undefined ? {} : { severity: demoted }), why: `${f['why']} (severity demoted ${f['severity']}→${demoted}: not on a production-reachable path)` }
}
/** @param {Finding} f @param {Array<Vote | null | undefined>} votes @returns {Finding} */
function tierFromVotes(f, votes) {
  const live = votes.filter(Boolean)
  const v = live.filter(isVerdictShaped)
  const judged = decideTier(f, live, v)
  const discarded = live.length - v.length
  if (!discarded) return judged
  if (judged['tier'] === 'unverified') return { ...judged, votesDiscarded: discarded }
  const share = v.length * 2 < live.length ? 'a minority of' : v.length * 2 === live.length ? 'exactly half of' : 'most of'
  return {
    ...judged,
    votesDiscarded: discarded,
    why: `${judged['why']} (PANEL THINNED: ${discarded} of ${live.length} returned votes answered off-schema and were discarded before the arithmetic — this ${judged['tier']} stands on ${v.length} of ${live.length} returned votes, ${share} the panel that answered)`,
  }
}
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
  const breaker = makeDeathBreaker()
  /** @type {{ individual: Finding[], batch: Finding[], skip: Finding[] }} */
  const route = { individual: [], batch: [], skip: [] }
  for (const f of items) route[verifyTier(f)].push(f)

  const floor = makeVerdictFloor()

  /** @type {Finding[]} */
  const unverified = route.skip.map(f => ({
    ...f,
    tier: 'unverified',
    why: `${f['why']} (NOT VERIFIED: no verifier was spent on it — ${f['severity']} cannot change the verdict either way, so nothing here has been checked against the code)`,
  }))

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

  const deadGroup = (/** @type {Finding[]} */ group, /** @type {string} */ why) => {
    const what = `the batch verifier for ${/** @type {Finding} */ (group[0])['file'] || '?'} ${why}`
    log(`⚠️ [${profile.id}] ${what} — its ${group.length} finding(s) were NOT checked against the code; reported as unverified and excluded from the verification counters`)
    return group.map((/** @type {Finding} */ f) => NOT_VERIFIED(f, `${what}, so nothing checked this finding against the code`))
  }

  const floorSkippedGroup = (/** @type {Finding[]} */ group) => {
    log(`💰 [${profile.id}] the batch verifier for ${/** @type {Finding} */ (group[0])['file'] || '?'} was NOT dispatched — ${floorSkipReason(floor)}; its ${group.length} finding(s) are reported as unverified and excluded from the verification counters`)
    return group.map((/** @type {Finding} */ f) => ({ ...NOT_VERIFIED(f, floorSkipReason(floor)), verifySkipped: true }))
  }

  const batchThunks = groups.map(group => () =>
    (verdictNeutralNow(group[0], floor)
      ? Promise.resolve(floorSkippedGroup(group))
      : ragent(batchVerifyPrompt(group, profile), { label: `verify-batch:${/** @type {Finding} */ (group[0])['file'] || '?'}(${group.length})`, phase: 'Verify', breaker, schema: BATCH_VERDICT_SCHEMA, model: CULL_MODEL })
      .then(res => {
        const death = batchDeath(res)
        if (death) return deadGroup(group, death)
        return group.map((/** @type {Finding} */ f, /** @type {number} */ i) => {
          const v = (res?.verdicts ?? []).find(x => x && x['index'] === i)
          return v ? tierFromVotes(f, [v]) : { ...f, tier: 'suspected', why: `${f['why']} (batch verifier returned no verdict for this finding)` }
        })
      })
      .catch((/** @type {unknown} */ err) => {
        log(`⚠️ [${profile.id}] batch verifier threw: ${String((err && /** @type {{ message?: unknown }} */ (err).message) || err).slice(0, 160)}`)
        return deadGroup(group, 'died before returning any verdict')
      })))

  if (route.skip.length || groups.length) {
    log(`[${profile.id}] Verify routing: ${route.individual.length} individual · ${route.batch.length} batched into ${groups.length} agent(s) · ${route.skip.length} NOT VERIFIED (Low/Info cannot move the verdict; reported as unverified, excluded from the verification counters)`)
  }

  const individualThunks = route.individual.map(f => () => {
    const isTool = isToolSource(profile, f['source'])
    const isHigh = f['severity'] === 'Critical' || f['severity'] === 'High'
    const n1 = isHigh ? Math.max(1, plan.verifyVotes) : 1
    const cull = (/** @type {number} */ i) => () =>
      ragent(verifyPrompt(f, i, isTool, gateProvenance, profile), { label: `verify:${f['file'] || '?'}:${f['line'] || 0}#c${i + 1}`, phase: 'Verify', breaker, schema: VERDICT_SCHEMA, model: CULL_MODEL })
    if (!isHigh) return parallel([cull(0)]).then(vs => tierFromVotes(f, vs))
    const auth = () =>
      ragent(verifyPrompt(f, n1, isTool, gateProvenance, profile), { label: `verify:${f['file'] || '?'}:${f['line'] || 0}#auth`, phase: 'Verify', breaker, schema: VERDICT_SCHEMA, model: plan.lensModel })
    return parallel([cull(0), auth]).then(async vs => {
      const opening = vs.filter(Boolean)
      if (opening.length === 2 && votesAgree(opening[0], opening[1])) return tierFromVotes(f, opening)
      const rest = await parallel(Array.from({ length: Math.max(0, n1 - 1) }, (/** @type {unknown} */ _unused, /** @type {number} */ i) => cull(i + 1)))
      return tierFromVotes(f, opening.concat(rest.filter(Boolean)))
    })
  })
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
  const settledVerdicts = await weightedWindow(entries, VERIFY_WINDOW_AGENTS, run => parallel([run]).then(rs => rs[0]))
  const judged = settledVerdicts.slice(0, route.individual.length)
    .map((r, i) => (/** @type {Finding | null | undefined} */ (r) || NOT_VERIFIED(/** @type {Finding} */ (route.individual[i]), 'the verifier panel for this finding was lost before it settled — nothing was checked against the code')))
  const batched = settledVerdicts.slice(route.individual.length)
    .flatMap((r, i) => (r ? /** @type {Finding[]} */ (r) : deadGroup(/** @type {Finding[]} */ (groups[i]), 'was lost before it settled (its dispatch never produced a result)')))
  /** @type {Finding[]} */
  const settled = judged.concat(batched)
  const vp = settled.filter(f => f.tier !== 'unverified')
  const deaths = settled.filter(f => f.tier === 'unverified')
  const refuted = vp.filter(f => f.tier === 'refuted')
  return {
    confirmed: vp.filter(f => f.tier === 'confirmed'),
    suspected: vp.filter(f => f.tier === 'suspected'),
    unverified: unverified.concat(deaths),
    notRun: [...new Set([
      ...deaths.filter(f => !f.verifySkipped && !((f.votesDiscarded ?? 0) > 0)).map(f => `${profile.id} verification of ${f.file || '?'} — the verifier(s) died before returning a verdict, so those finding(s) were never checked against the code`),
      ...deaths.filter(f => !f.verifySkipped && (f.votesDiscarded ?? 0) > 0).map(f => `${profile.id} verification of ${f.file || '?'} — every returned vote answered OFF-SCHEMA and was discarded before the arithmetic, so those finding(s) were never checked against the code`),
      ...refuted.filter(f => (f.votesDiscarded || 0) > 0).map(f => `${profile.id} verification of ${f.file || '?'} — a finding was REFUTED and deleted from the run by a THINNED PANEL (at least one returned vote answered off-schema and was discarded), so the deletion rests on partial evidence`),
    ])],
    savedByFloor: [...new Set(deaths.filter(f => f.verifySkipped).map(f => `${profile.id} verification of ${f.file || '?'} — deliberately not dispatched: the verdict was already fixed at Block, and no judgement on a Medium can move it, so those finding(s) were never checked against the code`))],
    dropped: refuted.length,
    refuted,
  }
}

const RIGOR_BY_SIZE = {
  small: { maxRounds: 1, verifyVotes: 1 },
  medium: { maxRounds: 2, verifyVotes: 1 },
  large: { maxRounds: 3, verifyVotes: 3 },
}
const LENS_MODEL = 'opus'

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
  for (const l of (profile.alwaysLenses || [])) addOfferedLens(profile, plan, l)
  const scoutedReconciler = Array.isArray(scout?.lenses) && scout.lenses.includes('reconciler')
  if (scoutedReconciler) addOfferedLens(profile, plan, 'failure-windows')
  if (strict) addOfferedLens(profile, plan, 'maintainability')
}

/** The rigor floors: security, the size-driven lenses, and an explicit optional request. @param {Profile} profile @param {Plan} plan */
function addRigorFloors(profile, plan) {
  if (plan.securitySensitive) applySecurityFloor(profile, plan)
  if (plan.securitySensitive || plan.sizeBucket === 'large') addMissingLens(plan, 'negative-space')
  if (plan.sizeBucket === 'large') addOfferedLens(profile, plan, 'compat')
  if (changedFiles.some(isContractOrSchemaPath)) addOfferedLens(profile, plan, 'compat')
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
  const surfaces = { ...(scout?.surfaces || {}) }
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

/** The single dispatch point's record of what ran, for the optional and surface-gate tallies. @param {string} lens */
function noteLensDispatched(lens) {
  if (OPTIONAL_LENSES.includes(lens)) optionalDispatched.add(lens)
  if (SURFACE_GATED_LENSES[lens]) surfaceGateDispatched.add(lens)
}

/** The preflight pass and its declared-probe audit, both logged. @param {Profile} profile */
async function runPreflight(profile) {
const preflight = await ragent(preflightPrompt(profile, { baseRef }),
  { label: `preflight:${profile.id}`, schema: PREFLIGHT_SCHEMA, phase: 'Gate', model: 'haiku', effort: 'low', deadlineMs: 300000 })
const probeViolations = auditPreflightProbes(preflight)
if (probeViolations.length) {
  log(`⚠️ [${profile.id}] PREFLIGHT PROBE BUDGET BREACHED (${probeViolations.length}): ${probeViolations.join(' · ')}`)
}
if (preflight) {
  log(preflightLine(profile, preflight))
} else {
  log(`⚠️ [${profile.id}] Preflight unavailable (failed or passed its deadline) — the gate establishes the environment itself, and its provenance says so.`)
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
  const scout = await ragent(scoutPrompt(profile), { label: `scout:${profile.id}`, schema: SCOUT_SCHEMA, model: 'haiku', effort: 'low', phase: 'Scout' })
  const scoutFailed = !scout
  const scoutNotRun = scoutFailed
    ? [`${profile.id} scout classification — the plan is the conservative fallback (all lenses, 3-vote, 2 rounds), not a scouted one`]
    : []
  const { plan, surfaceDropped } = planFromScout(profile, scout)
  const optionalScope = profile.lenses.filter((/** @type {string} */ l) => OPTIONAL_LENSES.includes(l))
  logScoutPlan(profile, scout, plan)

  /** @type {Map<string, string>} */
  const lensFailures = new Map()
  let reviewerAgentMissing = false
  const dispatchKey = (/** @type {string} */ lens, /** @type {Slice | null} */ slice) => (slice ? `${lens} :: ${slice.key}` : lens)
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
      const fallback = await runGeneric()
      if (answeredFindings(fallback)) noteReviewerAgentFallback(profile)
      return fallback
    } catch (e) {
      return reviewerAgentThrew(e, lens, slice, runGeneric)
    }
  }

  /** @param {unknown} e @param {string} lens @param {Slice | null} slice @param {() => Promise<FindingsAnswer | null>} runGeneric */
  async function reviewerAgentThrew(e, lens, slice, runGeneric) {
    const msg = String((e && /** @type {{ message?: unknown }} */ (e).message) || e)
    if (!isAgentTypeMissing(msg, profile.reviewerAgent)) {
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

  const { preflight, probeViolations } = await runPreflight(profile)

  const gate = await ragent(profile.gate({ baseRef, isLibrary: plan.isLibrary, securitySensitive: plan.securitySensitive, preflight }),
    { label: `gate:${profile.id}`, schema: GATE_SCHEMA, phase: 'Gate', effort: 'medium' })
  const { gateStatus, gateProvenance, failedChecks, carriedChecks } = gateFields(gate)
  const seedFindings = gateSeedFindings(gate)
  logGate(profile, gateStatus, gateProvenance, failedChecks, carriedChecks)
  const toolProvenance = toolProvenanceFor(gateProvenance, preflight)
  await checkpoint(`${profile.id}-plan`, {
    language: profile.id, branch, head, baseRef, round: thisRound,
    scout: { size: plan.sizeBucket, lenses: plan.lenses, maxRounds: plan.maxRounds, verifyVotes: plan.verifyVotes, securitySensitive: plan.securitySensitive },
    gate: { status: gateStatus, provenance: gateProvenance, failedChecks, carriedChecks, seeds: seedFindings.length },
    preflight: preflightCheckpoint(preflight, probeViolations),
  }, 'Gate')
  if (gateStatus === 'fail') {
    return { profile, plan, surfaceDropped, optionalScope, ranLenses: /** @type {string[]} */ ([]), lensRounds: [], gateStatus, gateProvenance, failedChecks, carriedChecks, confirmed: [], suspected: [], unverified: [], dropped: 0, notRun: [...scoutNotRun], criticNotes: '', probeViolations }
  }

  await probeReviewerAgent()

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

  phase('Lenses')
  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {Finding[]} */
  const pool = []
  for (const f of seedFindings) { const k = key(f); if (!seen.has(k)) { seen.add(k); pool.push(f) } }
  const notRun = [...scoutNotRun]
  /** @type {Set<string>} */
  const expectedDispatches = new Set()
  /** @type {Set<string>} */
  const returnedDispatches = new Set()
  /** @type {Array<{ round: number, agents: number, returned: number, newFindings: number }>} */
  const lensRounds = []
  /** @type {string[]} */
  let criticFollowupLenses = []
  const diffSlices = sliceDiff(changedFiles, { owns: f => profile.detect([f]) })
  if (diffSlices.length) log(`[${profile.id}] diff sliced into ${diffSlices.length} scope(s) for the code-intrinsic lenses: ${diffSlices.map(g => `${g.key} (${g.files.length})`).join(' · ')}. Whole-diff lenses (${WHOLE_DIFF_LENSES.join(', ')}) still see everything.`)
  const lensSlicesFor = (/** @type {string} */ lens) => (diffSlices.length && sliceableLens(lens) ? diffSlices : [null])
  /** @param {number} round */
  async function lensRound(round) {
    const priorSummary = priorFoundSummary(pool)
    const dispatches = plan.lenses.flatMap(lens => lensSlicesFor(lens).map(slice => ({ lens, slice })))
    for (const d of dispatches) expectedDispatches.add(dispatchKey(d.lens, d.slice))
    const settled = await weightedWindow(
      dispatches.map(d => ({ weight: 1, run: () => runLens(d.lens, lensPrompt(d.lens, priorSummary, profile, plan, d.slice), 'Lenses', ` r${round}${d.slice ? ` ${d.slice.key}` : ''}`, d.slice) })),
      LENS_WINDOW_AGENTS,
      (run, i) => run().then(r => (r ? { ...r, __key: dispatchKey(/** @type {(typeof dispatches)[number]} */ (dispatches[i]).lens, /** @type {(typeof dispatches)[number]} */ (dispatches[i]).slice), __lens: /** @type {(typeof dispatches)[number]} */ (dispatches[i]).lens } : null)),
    )
    const results = settled.filter(r => r != null)
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
    lensRounds.push({ round, agents: dispatches.length, returned: results.length, newFindings: fresh.length })
    log(`[${profile.id}] Lenses round ${round}: +${fresh.length} new (pool ${pool.length})`)
    return !fresh.length
  }
  let dry = false
  for (let round = 1; round <= plan.maxRounds && !dry; round++) dry = await lensRound(round)

  const lensesWithHoles = () => plan.lenses.filter(l => [...expectedDispatches].some(k => (k === l || k.startsWith(`${l} :: `)) && !returnedDispatches.has(k)))
  /** @param {FindingsAnswer & { __lens: string }} r */
  function absorbResurrected(r) {
    const lens = r.__lens
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

  function reportDroppedLenses() {
    const droppedLenses = [...expectedDispatches].filter(k => !returnedDispatches.has(k))
    if (droppedLenses.length) {
      const reasonFor = (/** @type {string} */ k) => lensFailures.get(k) || lensFailures.get(k.split(' :: ')[0] ?? k) || 'returned no result (skipped or died without an error)'
      const reasons = droppedLenses.map(k => `${k}: ${reasonFor(k)}`).join(' · ')
      notRun.push(`${profile.id} lenses that never returned — ${reasons}`)
      log(`⚠️ [${profile.id}] ${droppedLenses.length} lens dispatch(es) never returned (${reasons}). Review marked INCOMPLETE.`)
    }
    return droppedLenses
  }
  const droppedLenses = reportDroppedLenses()
  const ranLenses = plan.lenses.filter(l => [...expectedDispatches].every(k => (k !== l && !k.startsWith(`${l} :: `)) || returnedDispatches.has(k)))
  await checkpoint(`${profile.id}-lenses`, {
    language: profile.id, branch, head, baseRef, round: thisRound, ranLenses, droppedLenses, lensRounds,
    candidates: summarizeFindings(pool),
    candidatesBySource: pool.reduce((m, f) => ({ ...m, [f.source || 'unknown']: (m[f.source || 'unknown'] || 0) + 1 }), /** @type {Record<string, number>} */ ({})),
    notRun,
  }, 'Lenses')
  if (!pool.length) {
    return { profile, plan, surfaceDropped, optionalScope, ranLenses, lensRounds, gateStatus, gateProvenance, failedChecks, carriedChecks, confirmed: [], suspected: [], unverified: [], dropped: 0, notRun, criticNotes: '', probeViolations }
  }

  phase('Verify')
  const deduped = await dedupPool(rollupPool(pool, profile), profile)
  let { confirmed, suspected, unverified, dropped, refuted, notRun: verifyNotRun, savedByFloor } = await verifyPool(deduped, plan, profile, toolProvenance)
  notRun.push(...verifyNotRun)
  log(`[${profile.id}] Verify: ${confirmed.length} confirmed · ${suspected.length} suspected · ${dropped} refuted · ${unverified.length} not verified`)
  await checkpoint(`${profile.id}-verify`, {
    language: profile.id, branch, head, baseRef, round: thisRound,
    verdict: finalVerdict(confirmed),
    findings: summarizeFindings(confirmed),
    verification: { candidates: deduped.length - unverified.length, confirmed: confirmed.length, suspected: suspected.length, refuted: dropped, unverified: unverified.length },
  }, 'Verify')

  phase('Synthesize')
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
    const named = (critic?.missingLenses ?? []).filter((/** @type {string} */ l) => candidates.includes(l))
    const followups = refuseCriticNames(named)
    if (followups.length && (!budget.total || budget.remaining() > 60000)) {
      await criticFollowups(followups)
    } else if (followups.length) {
      notRun.push(`${profile.id} critic follow-up lenses (${followups.join('/')})`)
      log(`Budget low (~${Math.round(budget.remaining() / 1000)}k left) — SKIPPED [${profile.id}] critic follow-up lenses. Review marked INCOMPLETE.`)
    }
  }
  /** @param {string[]} named @returns {string[]} */
  function refuseCriticNames(named) {
    for (const l of named) if (!admittedLens(l)) optionalNamedByCritic.add(l)
    const refusedOptional = named.filter((/** @type {string} */ l) => !admittedLens(l))
    if (refusedOptional.length) log(`[${profile.id}] Completeness critic named optional lens(es) ${refusedOptional.join(', ')} — NOT dispatched (the optional pass is bought by an explicit \`optional=\` request); reported as uncovered.`)
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

async function reviewActiveProfiles() {
  for (const p of active) results.push(await reviewProfile(p))
}
await reviewActiveProfiles()

const gateFailed = /** @type {Result[]} */ (failedProfiles(results))
const runGate = gateRecord(results)
const mergedProvenance = runGate.provenance
const mergedGateStatus = runGate.status

function carriedSection() {
  const all = results.flatMap(r => (r.carriedChecks || []).map(c => `- [${r.profile.id}] ${c}`))
  return all.length
    ? `\n## Pre-existing — reported, not blocking\nThese are real and RED, but this diff did not cause them and no edit to the changed files clears them:\n${all.join('\n')}\n`
    : ''
}

const carriedLine = (() => {
  const all = results.flatMap(r => (r.carriedChecks || []).map(c => `[${r.profile.id}] ${c}`))
  return all.length
    ? ` Then a \`## Pre-existing — reported, not blocking\` section listing these VERBATIM, one per line — they are RED and real but this diff did not cause them, so they must appear in the report while changing NOTHING about the verdict: ${JSON.stringify(all)}.`
    : ''
})()

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
    optionalPass: { requested: optionalRequested, ...optionalTally(), namedByCritic: [...optionalNamedByCritic] },
    surfaceGate: surfaceGateRecord(results, { dispatched: surfaceGateDispatched, namedByCritic: surfaceGateNamedByCritic }),
    preflightProbeViolations: results.flatMap(r => (r['probeViolations'] || []).map((/** @type {string} */ v) => `[${r.profile.id}] ${v}`)),
    reReview: { chained: reReview.chained, reason: reReview.reason, basisVerdict: priorBasisVerdict, basisMismatch: priorBasisMismatch, basisOverridesLogger, fpComparable: priorFpComparable, tombstonesDropped: tombstonesDroppedForBasis, ledgerDegraded: priorLedgerDegraded, journalSourced: priorRoundJournalSourced, priorRound: priorRound?.['round'] ?? null, priorHead: priorRound?.['head'] ?? null },
    lensScope: fullRescan ? 'full' : 'delta',
    strict,
    fullEvery,
    ...agentUnavailableRecord(reviewerAgentUnavailable.map(x => x.agent),
      Object.entries(reviewerAgentFallbacks).map(([id, count]) => ({ agent: reviewerAgentNames[id] || id, count }))),
    base: baseRef || '',
    path: pathArg || '',
    criticFollowups: results.flatMap(r => (r['criticFollowupLenses'] || []).map((/** @type {string} */ l) => `${r.profile.id}:${l}`)).sort(),
    intentDigest: digest(intentArg),
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
let unverified = results.flatMap(r => r['unverified'] || [])

/** @type {{ resolved: Finding[], stillOpen: Finding[], regressed: Finding[], carried: Finding[], retired: Finding[] }} */
const adjudicated = { resolved: [], stillOpen: [], regressed: [], carried: [], retired: [] }
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
      carriedUnverified: true,
      why: `${baseWhy(f['why'])} (STILL NOT VERIFIED: carried from round ${priorRound['round']}, where no verifier judged it; nothing has checked it against the code since)`,
    })))
  }
}
/** @param {Finding} f */
function deferralHeld(f) {
  const deferral = deferralOn(f['deferral'])
  if (!deferral) {
    log(`Re-review: ${f['file']}:${f['line']} is marked deferred but carries no question's deferral — adjudicated like any prior`)
    return false
  }
  if (reraisedBySeverity(f['severity'])) return false
  if (!deferralReleased(deferral, priorDecisionsIn.decisions)) return true
  log(`Re-review: the deferral on ${f['file']}:${f['line']} no longer holds — a record supersedes or answers its question ${deferral.id} — adjudicated like any prior`)
  return false
}
/** @param {Finding} f */
function isSettledPrior(f) {
  const d = f['disposition']
  return d === 'rejected' || d === 'justified' || (d === 'deferred' && deferralHeld(f))
}
/** Carried deferred priors, for the Known and deferred section. */
const carriedDeferred = () => adjudicated.carried.filter(f => f['disposition'] === 'deferred').map(f => ({ ...f, priorKind: 'question' }))
async function adjudicatePriors() {
  if (priorRound?.['ledger']?.length) {
    phase('Adjudicate')
    const priorLedgerAll = priorRound['ledger'].map(f => ({ ...f, severity: canonicalSeverity(f['severity']) }))
    priorTombstones.push(...priorLedgerAll.filter((/** @type {Finding} */ f) => f['disposition'] === 'closed'))
    const priorLive = priorLedgerAll.filter((/** @type {Finding} */ f) => f['disposition'] !== 'closed')
    const priorUnverified = priorLive.filter((/** @type {Finding} */ f) => String(f['tier'] || '') === 'unverified')
    carryUnverifiedPriors(priorUnverified, priorRound)
    const priorLedger = priorLive.filter((/** @type {Finding} */ f) => String(f['tier'] || '') !== 'unverified')
    const settled = priorLedger.filter(isSettledPrior)
    /** @type {Finding[]} */
    const toCheck = priorLedger.filter(f => !settled.includes(f))

    const carriedResults = (await parallel(settled.map((/** @type {Finding} */ f) => () => {
      const pf = promptFields(f)
      return ragent(
        `A prior review finding was set aside by the author (disposition: ${f['disposition']}). Decide only whether the CODE AROUND IT CHANGED since commit ${flattenField(priorRound['head'])}. Shell + read only.
FINDING: [${pf.severity}] ${pf.title} — at ${pf.file}:${f['line']} (symbol ${pf.symbol}), rule ${pf.ruleId}.
Run \`git diff ${priorRound.head ? `${shq(priorRound.head)}...HEAD` : 'HEAD'} -- ${shq(f.file)}\` and judge whether the enclosing symbol/region was touched. Return {changed: <bool>, reason}.`,
        { label: `carry:${f['file']}:${f['line']}`, phase: 'Adjudicate', schema: CHANGED_SCHEMA, model: CULL_MODEL },
      ).then(r => ({ f, changed: r == null ? null : !!r.changed }))
    }))).filter(x => x != null)
    let carryDied = 0
    /** @param {(typeof carriedResults)[number]} c */
    const applyCarry = c => {
      const { f, changed } = c
      if (changed === null) { carryDied++; log(`⚠️ carry-check for ${f.file}:${f.line} died — kept as carried by default`); adjudicated.carried.push(f) }
      else if (changed && f['disposition'] === 'deferred') toCheck.push(f)
      else if (changed) adjudicated.stillOpen.push({ ...f, why: `${baseWhy(f.why)} (reopened: dismissed as ${f.disposition}, but the code around it changed — re-verify the justification)` })
      else if (f['disposition'] === 'deferred') adjudicated.carried.push(f)
      else adjudicated.retired.push(f)
    }
    for (const c of carriedResults) applyCarry(c)

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

/** The judged tracks' findings absorbed into the still-live priors they repeat. @param {Finding[]} livePriors @param {Set<Finding>} retired */
function absorbIntoLivePriors(livePriors, retired) {
  const { runs, updates, absorbed, keptAtRetired } = absorbAcross([confirmed, suspected], livePriors, retired, matchesPrior)
  for (const [host, why] of updates) host.why = why
  confirmed = /** @type {(typeof runs)[number]} */ (runs[0]).kept
  suspected = /** @type {(typeof runs)[number]} */ (runs[1]).kept
  if (absorbed) log(`Re-review: absorbed ${absorbed} new finding(s) into a still-live prior at the same file+rule — recorded on the prior's why (and delivered to next round's adjudicator as its own prompt lines) so they outlive it, not listed twice`)
  if (keptAtRetired) log(`Re-review: ${keptAtRetired} new finding(s) matched a prior that RETIRED this round — kept as findings rather than absorbed into a host that does not reach the next ledger`)
}
/** Unverified findings at a site a live prior tracks: marked, or collapsed onto an unverified prior. @param {Finding[]} trackingHosts @param {Set<Finding>} retired @param {Finding[]} carriedUnverified */
function trackUnverifiedAtPriors(trackingHosts, retired, carriedUnverified) {
  const tracked = markTrackedUnverified(unverified.filter(f => !f.carriedUnverified), trackingHosts, retired, matchesPrior)
  unverified = tracked.kept.concat(carriedUnverified)
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
  tombstonesDroppedForBasis = priorTombstones.length
  if (priorBasisVerdict === 'absent') {
    const note = `The prior round's answer carried no fingerprint-basis verdict (sameFpBasis), so its ${priorTombstones.length} resolved/dismissed finding(s) were not compared against this round and are no longer remembered. This is a transport or version-skew loss, not a fingerprint-basis change.`
    reReviewMemoryNote = reReviewMemoryNote ? `${reReviewMemoryNote}\n${note}` : note
    log(`⚠️ ${note}`)
  } else if (priorBasisVerdict === 'unknown') {
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
function reconcileWithPriors() {
  if (priorRound) {
    const livePriors = [...adjudicated.stillOpen, ...adjudicated.regressed, ...adjudicated.carried, ...adjudicated.retired]
    const retired = new Set(adjudicated.retired)
    const carriedUnverified = unverified.filter(f => f.carriedUnverified)
    if (livePriors.length) absorbIntoLivePriors(livePriors, retired)
    const trackingHosts = [...livePriors, ...carriedUnverified]
    if (trackingHosts.length) trackUnverifiedAtPriors(trackingHosts, retired, carriedUnverified)
    if (priorTombstones.length && !priorFpComparable) dropTombstonesForBasis()
    else if (priorTombstones.length) flagReturningDefects()
  }
}
reconcileWithPriors()

const dropped = results.reduce((n, r) => n + r['dropped'], 0)
const thinned = results
  .flatMap(r => [...r['confirmed'], ...r['suspected'], ...(r['refuted'] || []), ...(r['unverified'] || [])])
  .filter(f => (f.votesDiscarded || 0) > 0).length
const notRun = [...scopeNotRun, ...results.flatMap(r => r['notRun'])]
const savedByFloor = results.flatMap(r => r['savedByFloor'] || [])
const coverageNotes = uncoveredGap.length ? [uncoveredNotRunNote(uncoveredGap)] : []
const incompleteNotes = [...notRun, ...coverageNotes]
const criticNotes = results.map(r => r['criticNotes']).filter(n => n && n.trim() && n.trim() !== 'coverage complete').map(n => n.trim()).join(' · ')

const hasAdjudicated = hasAdjudicatedTracks()
function hasAdjudicatedTracks() {
  return !!(adjudicated.stillOpen.length || adjudicated.regressed.length || adjudicated.resolved.length || adjudicated.carried.length || adjudicated.retired.length)
}
function nothingSurvived() {
  return !confirmed.length && !suspected.length && !unverified.length && !hasAdjudicated && !priorTombstones.length && !priorRejected.length
}
async function noFindingsExit() {
  const earlySuffix = verdictSuffix({ notRun, coverageNotes })
  await logRun(reviewRecord({ verdict: `Approve${earlySuffix}`, round: thisRound, findings: summarizeFindings([]), dimensions: [], verification: { candidates: dropped, confirmed: 0, refuteRate: refuteRate(dropped, dropped) }, notRun }))
  const verdictLine = earlySuffix
    ? `⚠️ Approve${earlySuffix} — gate ${mergedGateStatus}; no findings survived, but ${incompleteNotes.join('; ')} — this verdict covers ONLY what ran. Files listed as matching no language profile are outside this engine (${supportedLangLabel(PROFILES)}) and re-running will not review them — review them by hand or with a tool that speaks their language${notRun.length ? '; anything else in the list is a failure to fix and re-run' : ''}.`
    : `✅ Approve — gate ${mergedGateStatus}; no findings across ${active.map(p => p.id).join('+')}.`
  return out([`## Verdict`, verdictLine, ``, `## Gate`, mergedProvenance, carriedSection(),
    ...(uncoveredFiles.length ? [``, `## Not reviewed (no language profile)`, ...uncoveredFiles.map((/** @type {string} */ f) => `- ${f}`)] : []),
  ].join('\n') + scopeSection())
}
/** @type {Array<Finding & { priorTier: string, priorDecision: string, priorKind: 'decision' | 'question' }>} */
let priorRejected = []
/** The ledger disposition of a set-aside finding. @param {{ priorKind: string }} f */
const priorDisposition = f => (f.priorKind === 'question' ? 'deferred' : 'rejected')
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
  priorRejected = r.setAside.map(f => /^(confirmed|suspected|unverified)$/.test(f.priorTier) ? f : { ...f, priorTier: 'confirmed' })
  for (const n of r.notes) log(`priorDecisions: ${n}`)
  priorDecisionsIn.refused.push(...r.refused)
}
await setAsidePriorDecisions()
if (nothingSurvived()) return await noFindingsExit()

const UNVERIFIED_PREAMBLE = 'These were not verified: no verifier was spent on them because a Low/Info finding cannot change the verdict, or because the verdict was already fixed at Block by a confirmed Critical/High and a Medium cannot move it, or the verifier that should have judged them died before returning a verdict, or every vote the panel DID return answered off-schema and carried none of the judgements the tier is decided on — each entry says which in its own `why`. Nothing below has been checked against the code — treat each as a lead, not a finding.'
phase('Synthesize')
const isRereview = !!priorRound
const rereviewData = rereviewDataOf()
function rereviewDataOf() {
  return isRereview ? {
    resolved: adjudicated.resolved, stillOpen: adjudicated.stillOpen,
    regressed: adjudicated.regressed, carried: adjudicated.carried, retired: adjudicated.retired, neu: confirmed,
  } : null
}
const incompleteClause = incompleteClauseOf()
function incompleteClauseOf() {
  return incompleteNotes.length
    ? ` Append " · ⚠️ ${notRun.length ? 'INCOMPLETE — part of this review did not run' : 'PARTIAL COVERAGE — a coverage hole a re-run will not fix'}: ${incompleteNotes.join('; ')}; findings may be undercounted." to the verdict line.`
    : ''
}
let synthesisUnusable = false
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
7. \`## 🔽 Carried\` — settled priors (rejected/justified/deferred) that are re-checked again next round, collapsed to a count + one-line list; omit if empty.
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
const totalVerified = confirmed.length + suspected.length + dropped + priorRejected.filter(f => f.priorTier !== 'unverified').length - priorRejectedLive
/** The verdict the record carries: the re-review tracks or the confirmed set, escalated by strict maintainability. */
function decideRecordVerdict() {
  let recordVerdict = isRereview
    ? rereviewVerdict({ stillOpen: adjudicated.stillOpen, regressed: adjudicated.regressed, neu: confirmed })
    : finalVerdict(confirmed)
  if (isRereview && strict && [...adjudicated.stillOpen, ...adjudicated.regressed, ...confirmed]
    .some(f => isMaintainability(f) && (f.severity === 'Critical' || f.severity === 'High' || f.severity === 'Medium'))) {
    recordVerdict = 'Block'
  }
  return recordVerdict
}
const recordVerdict = decideRecordVerdict()
const floorPremiseHeld = !savedByFloor.length || recordVerdict === 'Block'
function reportRevokedPremise() {
  if (!floorPremiseHeld) {
    notRun.push(...savedByFloor.map(n => `${n} — AND THE PREMISE DID NOT HOLD: the run ended at ${recordVerdict}, not Block, so the saving rested on a confirmed finding that did not reach the verdict; re-run to check them`))
    log(`⚠️ ${savedByFloor.length} verification(s) were skipped because the verdict was already Block, but the run ended at ${recordVerdict} — the skipped findings are reported as a coverage hole, not as a saving`)
  }
}
reportRevokedPremise()
/** @param {Finding} f @param {string | undefined} disposition @param {string} [tier] */
const toLedgerEntry = (f, disposition, tier) => ({
  ...ledgerLocation(f),
  severity: f['severity'], tier: tier || f['tier'] || 'suspected', disposition: disposition || f['disposition'] || 'open',
  source: f['source'] || '', ruleId: f['ruleId'] || '', title: f['title'] || '', why: String(f['why'] || '').split(TRACKED_MARK).join('').replace(THINNED_CLAUSE, ''),
  ...ledgerSources(f),
  ...ledgerWhyRef(f),
  ...ledgerDeferral(f),
})
/** A ledger entry's `deferral`, present only on a finding a question set aside. @param {Finding} f */
function ledgerDeferral(f) {
  const deferral = deferralOn(f['deferral'])
  return deferral ? { deferral } : {}
}
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
  return f['whyRef'] && typeof f['whyRef'].record === 'string' && typeof f['whyRef'].fp === 'string'
    ? { whyRef: { record: f['whyRef'].record, fp: f['whyRef'].fp } } : {}
}
const toTombstone = (/** @type {Finding} */ f, origin = 'resolved') => {
  const { whyRef: _whyRef, ...entry } = toLedgerEntry(f, 'closed', f['tier'])
  return { ...entry, fp: fingerprint(f), why: `${origin} in round ${thisRound}` }
}
const liveLedgerCount = confirmed.length + suspected.length +
  unverified.filter(f => !f.ledgerDupOfUnverifiedPrior).length +
  adjudicated.stillOpen.length + adjudicated.regressed.length + adjudicated.carried.length + priorRejected.length
const tombstones = assembleTombstones()
function assembleTombstones() {
  return pruneTombstones([
    ...adjudicated.resolved.map(f => toTombstone(f, 'resolved')),
    ...adjudicated.retired.map(f => toTombstone(f, 'dismissed')),
    ...(priorFpComparable ? priorTombstones : []),
  ], { max: tombstoneBudget(liveLedgerCount) })
}
const reviewLedger = assembleLedger()
function assembleLedger() {
  return isRereview
    ? [
      ...confirmed.map(f => toLedgerEntry(f, 'open', 'confirmed')),
      ...suspected.map(f => toLedgerEntry(f, 'open', 'suspected')),
      ...unverified.filter(f => !f.ledgerDupOfUnverifiedPrior).map(f => toLedgerEntry(f, 'open', 'unverified')),
      ...adjudicated.stillOpen.map(f => toLedgerEntry(f, 'open')),
      ...adjudicated.regressed.map(f => toLedgerEntry(f, 'open')),
      ...tombstones,
      ...adjudicated.carried.map(f => toLedgerEntry(f, f['disposition'])),
      ...priorRejected.map(f => toLedgerEntry(f, priorDisposition(f), f.priorTier)),
    ]
    : allReviewFindings.map(f => toLedgerEntry(f, 'open', f.tier || 'suspected')).concat(priorRejected.map(f => toLedgerEntry(f, priorDisposition(f), f.priorTier)))
}
async function persistLedgerShards() {
  for (const shard of shardLedger(reviewLedger)) {
    await checkpoint(`${LEDGER_SHARD_PHASE}-${String(shard.ledgerShard.index).padStart(2, '0')}`, { branch, head, ...shard }, 'Synthesize')
  }
}
await persistLedgerShards()
await logRun(reviewRecord({
  verdict: recordVerdict + verdictSuffix({ notRun, coverageNotes, floorPremiseHeld }),
  savedByFloor,
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
    const ran = r.ranLenses ? r.ranLenses.includes(l) : true
    return { dimension: `${r.profile.id}:${l}`, ran, verdict: '', findingCount: s.total, bySeverity: s.bySeverity, confirmedCount, suspectedCount, refutedCount, unverifiedCount }
  })),
  verification: { candidates: totalVerified, confirmed: confirmed.length, refuteRate: refuteRate(dropped, totalVerified), unverified: unverified.length, thinned },
  notRun,
}))

function fallbackReport() {
  const cause = synthesisUnusable ? 'synthesis agent returned no usable report' : 'synthesis agent died twice'
  const emoji = { Block: '⛔ Block', Warning: '⚠️ Warning', Approve: '✅ Approve' }[isRereview ? recordVerdict : finalVerdict(confirmed)]
  const fmt = (/** @type {Finding} */ f) => `- ${f['severity']} · \`${f['file'] || '?'}:${f['line'] || 0}\`${f['ruleId'] ? ` · [${f['ruleId']}]` : ''} · ${f['title']} · ${f['why']} · Fix: ${f['fix']}${f['whereChecked'] ? ` · Premise checked at: ${f['whereChecked']}` : ''}`
  const bySev = (/** @type {Finding[]} */ a) => a.slice().sort((/** @type {Finding} */ x, /** @type {Finding} */ y) => (SEV_RANK[x['severity'] ?? ''] ?? 9) - (SEV_RANK[y['severity'] ?? ''] ?? 9))
  return [
    `## Verdict`,
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

return out(markVerdictIncomplete(report || fallbackReport()) + floorPremiseSection() + priorRejectedSection([...priorRejected, ...carriedDeferred()]) + scopeSection())
