export const meta = {
  name: 'adversarial-review',
  description: 'Adversarial multi-phase diff review with bounded verifier fan-out — scout-scaled lenses, throttled batches with retries, strict-majority verification, verified coverage gaps. A run whose scout, lenses or coverage critic died reports its verdict as INCOMPLETE with a not-run list, never as a clean approval; unjudged individual checks are recorded as advisory instead. Subscription-friendly: steady request rate, no burst.',
  whenToUse: 'Deep adversarial, language-agnostic review of any diff — mixed / non-Rust-Nix codebases, or when money-path (payments/ledger) invariants matter, or on a rate-limited subscription (steady request rate). For a Rust or Nix diff prefer the `review` workflow (auto-detects language). Distinct from `review --strict`, which is the harsh maintainability-block mode of the generic engine. It reviews ONLY the checkout the session runs in: there is no `repo` argument, and passing one is refused with nothing run (use `review` with repo= instead). priorDecisions — ONLY inside an object argument, {priorDecisions: [<recalled decision and question records>]}; as a string (key=value or JSON text) it is refused, nothing of it applied — applies the same rules as review: a matching finding below critical/high whose scope is unchanged since the commit of the decision is returned under rejectedBefore, marked, outside the verdict; one an active question (a deferred finding) answers comes back under knownDeferred by the same rules; refusals come back as priorDecisionsNotApplied. The engine itself always recalls the active decisions and questions for the paths of the diff through the craft:memory skill; priorDecisions is optional and ADDS to that recall, never replaces it (merged by id, the recalled record kept on a clash; an empty list adds nothing), and the source comes back as memory {source, count, why, passed?, added?}. It posts nothing to a PR: to post findings there run review with comment — never post findings by hand (they would lack the marker that ties a later rejection to its finding).',
  phases: [
    { title: 'Prep', detail: 'scout the diff (size, lens subset) + warm up the codebase-memory index', model: 'haiku' },
    { title: 'Review', detail: 'scout-picked finder lenses, throttled batches with retries; two-tier dedup (mechanical + thresholded semantic clusterer)' },
    { title: 'Verify', detail: '1 combined verifier per finding, 3-lens panel for critical/high; throttled + retries + budget guard' },
    { title: 'Coverage', detail: 'completeness critic; its gaps are verified through the same pipeline' },
  ],
}

// ---- args ----
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
const A = normalizeArgs(args, log)
// The project's recalled prior decisions, read before anything can return, so a malformed argument
// is named on every return path (the rules: lib/prior-decisions.mjs).
// >>> craft-inline lib/prior-decision-record.mjs DECISION_FIELD_MAX PRIOR_RECORD_KINDS decisionScopeParts decisionText recordKind supersededIds decisionFields decisionProblem SAFE_SCOPE hasControlChar decisionAnchorProblem readPriorDecision
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
// <<< craft-inline
// >>> craft-inline lib/prior-decisions.mjs PRIOR_DECISIONS_MAX DECISION_TITLE_OVERLAP decisionLabel printableId cutNames parsePriorDecisions titleWords decisionAnswers reraisedBySeverity priorDecisionsRefusedSection
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
// <<< craft-inline
// >>> craft-inline lib/memory-recall.mjs RECALL_PATHS_MAX RECORD_TEXT_FIELDS MEMORY_RECALL_SCHEMA memoryRecallPrompt recallText staleTail recalledQuestions readMemoryRecall initialMemory skippedMemory mergeById withPassed parseMerged mergeAndRead mergeRecall memoryParts readLaunch acceptedMemory recallDecisions
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
 * The recalled records with the launcher's appended, one per id: a passed record whose id a READABLE
 * recalled record already holds is dropped — the recalled one is the store's current state. A malformed
 * recalled record claims no id, so the passed one stands and the reader refuses the recalled one by name
 * (realm @nick/craft, node #218). A record without an id is kept, for the reader to refuse by name.
 * `addedAt` is each added record's index in the passed list.
 * @template T @param {T[]} recalled @param {T[]} passed @param {(x: T) => boolean} [readable]
 * @returns {{ merged: T[], addedAt: number[] }}
 */
function mergeById(recalled, passed, readable = () => true) {
  /** @param {T} x */
  const idOf = x => (x && typeof x === 'object' ? recallText(/** @type {Record<string, unknown>} */ (x)['id']) : '')
  const held = new Set(recalled.filter(x => readable(x)).map(idOf).filter(Boolean))
  const addedAt = passed.flatMap((x, i) => (held.has(idOf(x)) ? [] : [i]))
  return { merged: [...recalled, ...addedAt.map(i => /** @type {T} */ (passed[i]))], addedAt }
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
 * record back to its index in the launcher's list). The applied records split by part: a recalled id is
 * one a readable recalled record holds, and `passed` counts the applied rest — the launcher's records
 * new to this run, after the cap (realm @nick/craft, node #218).
 * @template {{ id: string, kind?: string }} D
 * @param {unknown[]} list @param {number} recalledLen @param {ParseDecisions<D>} parse @param {number[]} [passedAt]
 * @returns {{ prior: { decisions: D[], refused: string[] }, recalled: D[], passed: number }}
 */
function parseMerged(list, recalledLen, parse, passedAt = []) {
  /** @param {number} i */
  const labelOf = i => (i < recalledLen ? `recalled decision #${i}` : `passed decision #${passedAt[i - recalledLen] ?? i - recalledLen}`)
  const prior = parse(list, labelOf)
  const held = new Set(list.slice(0, recalledLen).flatMap(x => parse([x]).decisions.map(d => d.id)))
  const recalled = prior.decisions.filter(d => held.has(d.id))
  return { prior, recalled, passed: prior.decisions.length - recalled.length }
}

/**
 * The recall's records merged with the launcher's list (mergeById, a recalled record readable by
 * `parse` kept on an id clash) and read once (parseMerged); `parts` is how the merged list splits —
 * what a launching audit forwards as `_memoryParts`, so it adds up to the list.
 * @template {{ id: string, kind?: string }} D
 * @param {unknown[]} recalled @param {unknown[]} passed @param {ParseDecisions<D>} parse
 * @returns {{ merged: unknown[], parts: { recalled: number, passed: number }, read: { prior: { decisions: D[], refused: string[] }, recalled: D[], passed: number } }}
 */
function mergeAndRead(recalled, passed, parse) {
  const { merged, addedAt } = mergeById(recalled, passed, x => parse([x]).decisions.length > 0)
  return { merged, parts: { recalled: recalled.length, passed: addedAt.length }, read: parseMerged(merged, recalled.length, parse, addedAt) }
}

/**
 * The recall's answer merged RAW with the launcher's `priorDecisions` (mergeAndRead), read once by
 * `parse` (parsePriorDecisions) under its one cap: the decisions to apply, every refusal (a launcher's
 * argument that is no list still named), the refusals not already logged at launch (the recall's and
 * the cap's), and the source — its new count the launcher's records applied that the recall did not hold.
 * @template {{ id: string, kind?: string }} D
 * @param {{ decisions: unknown[], memory: MemorySource }} r @param {unknown} passedRaw @param {ParseDecisions<D>} parse
 * @returns {{ prior: { decisions: D[], refused: string[] }, recalledRefused: string[], memory: MemorySource }}
 */
function mergeRecall(r, passedRaw, parse) {
  const alone = parse(passedRaw)
  const { read: m } = mergeAndRead(r.decisions, Array.isArray(passedRaw) ? /** @type {unknown[]} */ (passedRaw) : [], parse)
  return {
    prior: { decisions: m.prior.decisions, refused: Array.isArray(passedRaw) ? m.prior.refused : [...alone.refused, ...m.prior.refused] },
    recalledRefused: m.prior.refused.filter(x => !x.startsWith('passed decision #')),
    memory: withPassed(acceptedMemory(r.memory, m.recalled), alone.decisions.length, m.passed),
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
// <<< craft-inline
// Set by a parent workflow that already recalled for this run: no recall here; `_memory` is why it found
// none, `_memoryParts` how its list splits into its recall's records and its launcher's.
const recalledByLauncher = A['_recalled'] === true
const launch = readLaunch(A['priorDecisions'], recalledByLauncher, A['_memory'], A['_memoryParts'], parsePriorDecisions)
let priorDecisionsIn = launch.prior
for (const r of priorDecisionsIn.refused) log(`WARNING: priorDecisions: ${r}`)
// Where the decisions came from (recalled by this engine, by its launcher, or none) and what the launcher
// passed beside them; every returned object names it.
let memory = launch.memory
/** What a returned object adds: the memory source, and what of priorDecisions was not applied. */
const priorRefusedResult = () => ({
  memory,
  ...(priorDecisionsIn.refused.length ? { priorDecisionsNotApplied: priorDecisionsIn.refused } : {}),
})
/** @param {string} key @returns {string} the argument as a string, '' when absent or falsy */
const stringArg = key => A[key] ? String(A[key]) : ''

const diffBase = stringArg('diffBase')
const intentArg = stringArg('intent')
const viaArg = stringArg('_via')   // set by a parent workflow
// Where craft itself lives, so the logger can find lib/craft-log-run.mjs. It selects NO repository:
// this engine has no `repo` argument (see the refusal above) and always reviews the checkout the
// session runs in. As an installed plugin CLAUDE_PLUGIN_ROOT is
// set for us; launched by scriptPath from a checkout it is NOT, and the fallback would resolve
// against the reviewed repo — where the script is not. Pass craftRoot then.
const craftRootArg = stringArg('craftRoot')
/** @returns {number} */
const batchArg = () => A['batch'] ? Math.max(1, Number(A['batch'])) : 4
const BATCH = batchArg()
const RETRY_BATCH = 2                 // retry rounds run even quieter than the main pass
/** @returns {number} */
const maxRetriesArg = () => A['maxRetries'] != null ? Math.max(0, Number(A['maxRetries'])) : 2
const MAX_RETRY_ROUNDS = maxRetriesArg()
const BUDGET_FLOOR = 40_000           // stop spawning agents below this many remaining tokens

// ---- schemas ----
const FINDINGS = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'file', 'line', 'severity', 'description', 'fix', 'whereChecked'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          description: { type: 'string' },
          fix: { type: 'string' },
          whereChecked: { type: 'string', description: 'OFF-SITE EVIDENCE: the file:line you actually opened to establish a load-bearing premise living OUTSIDE the cited line — a dependency\'s behaviour, reachability from an entry point, the absence of a guard in a caller, what a sibling path does. Comma-separate several. Empty string ONLY when the finding rests on no off-site claim at all' },
        },
      },
    },
  },
}
const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['refuted', 'reasoning', 'severity', 'premiseSupported'],
  properties: {
    refuted: { type: 'boolean' },
    premiseSupported: { type: 'boolean', description: 'true if the load-bearing premise is self-contained at the cited line or actually shown by the code at whereChecked; false if it is an off-site claim with no evidence that checks out. Unsupported is NOT the same as refuted — set refuted on its own merits' },
    reasoning: { type: 'string' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'not-an-issue'] },
  },
}
const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['baseRef', 'sizeBucket', 'lenses', 'changedFiles', 'notes'],
  properties: {
    baseRef: { type: 'string', description: 'git ref the diff was computed against; empty if none resolved' },
    sizeBucket: { type: 'string', enum: ['small', 'medium', 'large'] },
    lenses: { type: 'array', items: { type: 'string' }, description: 'subset of the lens catalog to run' },
    changedFiles: { type: 'array', items: { type: 'string' }, description: 'EVERY path the diff touches, verbatim from `git diff --name-only` against the resolved base — repo-relative, no truncation, no globbing. An empty array means the diff genuinely resolved to no files; it is read as "nothing was reviewed", so never return [] as a shortcut' },
    notes: { type: 'string' },
  },
}
const WARMUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['indexed', 'notes'],
  properties: {
    indexed: { type: 'boolean', description: 'true if the codebase-memory index exists and covers the diff base' },
    notes: { type: 'string' },
  },
}

// Deterministic re-read of the diff's file list, used only to gate the inert-only green exit.
// `fileCount` comes from `wc -l`, `files` from the same command's output: the two disagreeing is
// how the cross-check's OWN truncation is caught, so both are required.
const CROSSCHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'fileCount', 'files'],
  properties: {
    ok: { type: 'boolean', description: 'true only if git ran and files holds every path it printed, complete and verbatim' },
    fileCount: { type: 'integer', description: 'the number printed by `git diff --name-only <base> | wc -l`' },
    files: { type: 'array', items: { type: 'string' }, description: 'every path from `git diff --name-only <base>`, verbatim, untruncated' },
  },
}

// What each schema'd agent hands back when it returns at all. `agent()` resolves to `null` when the
// agent was skipped or died, so every read below goes through `Typedef | null`. The shapes are the
// schemas' — model output, so the guards that re-check a field at runtime stay where they are.
/**
 * @typedef {{ title: string, file: string, line: number, severity: string, description: string, fix: string, whereChecked: string }} RawFinding
 * @typedef {{ findings: RawFinding[] }} FindingsResult
 * @typedef {{ refuted: boolean, premiseSupported: boolean, reasoning: string, severity: string }} VerdictResult
 * @typedef {{ baseRef: string, sizeBucket: 'small' | 'medium' | 'large', lenses: string[], changedFiles: string[], notes: string }} ScoutResult
 * @typedef {{ indexed: boolean, notes: string }} WarmupResult
 * @typedef {{ ok: boolean, fileCount: number, files: string[] }} CrosscheckResult
 * @typedef {{ clusters: number[][] }} ClustersResult
 * @typedef {RawFinding & { lens: string, sources: string[] }} LensFinding  a finding tagged with the lens(es) that raised it
 */

/** @param {unknown} f @returns {f is string} a non-blank path from a model-returned file list */
const isPath = f => typeof f === 'string' && f.trim() !== ''

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const isEscalated = (/** @type {{ lens?: string, severity: string }} */ f) => f.lens !== 'complexity' && (f.severity === 'critical' || f.severity === 'high')

// The craft release that produced a run. Recorded on the run record and index line so an
// aggregate can be filtered to ONE engine version: without it, runs from every rubric the store
// has ever seen blend together. MUST match `.claude-plugin/plugin.json` — `lib/check-workflows.mjs`
// fails the build if it drifts. Kept OUTSIDE the craft-inline fence below, whose contents are
// byte-compared against lib/run-record.mjs.
const CRAFT_VERSION = '0.24.0' // x-release-please-version

// ---- run-record helpers (VERBATIM mirror of lib/run-record.mjs — the sandbox can't import; keep in sync) ----
// >>> craft-inline lib/run-record.mjs SEVERITIES countBySeverity summarizeFindings refuteRate repoRefusal
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
 * @param {number} refuted
 * @param {number} candidates
 * @returns {number}
 */
function refuteRate(refuted, candidates) {
  return candidates ? Math.round((refuted / candidates) * 100) / 100 : 0
}

/**
 * @param {{ engine: string, repo: string, craftVersion: string, outputTokens: number, via?: string }} o
 *   `via`: the parent workflow that dispatched this run, '' when it was not nested
 */
function repoRefusal({ engine, repo, craftVersion, outputTokens, via = '' }) {
  return {
    record: {
      schemaVersion: 1, runtime: 'claude-code', craftVersion, kind: 'workflow', name: engine,
      nested: !!via, via: via || null,
      verdict: 'INCOMPLETE (repo not supported)', findings: summarizeFindings([]), dimensions: [], verification: null,
      notRun: ['`repo` argument refused — this engine reviews only the session\'s own checkout'],
      outputTokens,
    },
    report: [
      `## Verdict`,
      `⚠️ INCOMPLETE — \`repo=${repo}\` was given, but \`${engine}\` does not support reviewing a repository other than the one this session runs in: its agents would read THIS checkout and report a normal-looking verdict for the wrong code. Nothing ran.`,
      ``,
      `Either run \`craft:review\` with \`repo=\` (that engine threads a working-directory directive through its prompts), or start a session inside that repository and run \`${engine}\` there.`,
    ].join('\n'),
  }
}
// <<< craft-inline
// ---- the one write path (shared with every other record-filing engine) ----
// The sandbox cannot import, so lib/run-logging.mjs reaches this script the same way run-record.mjs
// does: a fenced region regenerated and byte-compared by `node lib/check-workflows.mjs`.
// >>> craft-inline lib/run-logging.mjs LOGRUN_SCHEMA shq loggerPrelude payloadVersion engineRevisionFlag runDirFlags logRunPrompt logRunDispatch logRunOutcome quietly makeRunLogger telemetryLossNoter
const LOGRUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean', description: 'true only if the script ran and printed no craft-log-run FAILED line' },
    error: { type: 'string', description: 'when ok is false, the failing line verbatim; when ok is true AND the script printed a craft-log-run WARNING line, that line verbatim; empty otherwise' },
  },
}

/** @param {unknown} s */
function shq(s) { return `'${String(s ?? '').replace(/'/g, `'\\''`)}'` }

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

// A lost record NEVER fails the run: killing a review over a bookkeeping write would teach everyone
// to ignore the very marker this exists to raise. It is reported instead — in the notRun notes a
// human actually reads, because an empty store is otherwise indistinguishable from "never run".
/** @type {string[]} */
const telemetryLost = []
// "lost" is asserted per line, not stamped on every line: the record landing while its run DIRECTORY
// was refused is a different fact, and calling it a lost record is the same conflation the other
// three engines dropped — the one that teaches a reader to skip the marker. A line that says the
// record itself landed keeps its own wording.
const telemetryNotes = () => telemetryLost.map(l => (
  /^the run directory \(the record itself landed\)/.test(l)
    ? `⚠️ telemetry: ${l} — the record for this run is in the store; what the directory held may not be.`
    : `⚠️ telemetry lost: ${l} — this run may be missing or incomplete in the run store. Read this verdict, not the store, for what it did.`))

// The shared run-record writer (lib/run-logging.mjs), bound to this engine's phase and loss note.
const logRun = makeRunLogger({
  call: quietly(agent), phase: 'Coverage', target: () => ({ craftRoot: craftRootArg }),
  noteLoss: telemetryLossNoter(telemetryLost, log),
})
// adversarial-review uses lowercase severities internally; the store schema is capitalized.
/** @template {{ severity: string }} F @param {F} f */
const capSeverity = f => ({ ...f, severity: f.severity ? f.severity.charAt(0).toUpperCase() + f.severity.slice(1) : f.severity })

// The fields every run record of this engine opens with, in the order the store has always seen them.
const recordHead = () => ({
  schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'adversarial-review',
  nested: !!viaArg, via: viaArg || null,
})

// ---- lens catalog ----
/** @type {Record<string, string>} */
const LENS_BRIEF = {
  correctness: 'logic and spec conformance: does the change do what it is supposed to? Wrong behavior behind correct-looking code, off-by-one, inverted conditions, missed requirements, broken invariants.',
  security: 'security: injection, authz/authn gaps, tenant isolation breaks, secrets in code, unsafe deserialization, path traversal, SSRF, untrusted input reaching sinks.',
  money: 'money-path invariants: float arithmetic on amounts, lost cents in splits/rounding, missing idempotency on payment operations, double-charge/double-credit windows, currency mixups, ledger imbalance.',
  concurrency: 'concurrency: races on shared state, check-then-act windows, missing transactions/locks, lock ordering, blocking calls in async contexts, unbounded queues.',
  errors: 'error handling: swallowed errors, panic/crash on recoverable failures, missing rollback/cleanup on the error path, error messages leaking internals.',
  performance: 'performance: N+1 queries, work inside hot loops, unbounded memory growth, missing pagination/limits, accidental O(n^2).',
  complexity: 'complexity metrics from the codebase-memory graph (metrics-or-nothing; skipped when the repo is not indexed).',
}
const ALL_LENSES = Object.keys(LENS_BRIEF)

/** @param {string} lens */
function finderPrompt(lens) {
  const base = diffBase ? `\`${diffBase}\`` : 'resolve it yourself: merge-base with origin/main, then main, then HEAD~1; target uncommitted changes if the tree is dirty'
  if (lens === 'complexity') {
    return `You are the complexity review lens, grounded in the codebase-memory knowledge graph.
Use ToolSearch to load the codebase-memory MCP tools (list_projects, index_status, detect_changes, search_graph, query_graph).

Step 0 — availability gate: call list_projects / index_status for this repository. If the project is NOT indexed, or the index predates the diff base, return {"findings": []} immediately. Never estimate complexity by eye; this lens is metrics-or-nothing.
Step 1: detect_changes (diff base: ${base}) to get the functions touched by the diff and their impact radius.
Step 2: for each touched function, read its complexity properties from the graph: cognitive, complexity (cyclomatic), loop_depth, transitive_loop_depth, linear_scan_in_loop, alloc_in_loop, recursion_in_loop, unguarded_recursion, param_count. One query_graph call can fetch them all.
Step 3: report ONLY findings grounded in those numbers, quoting the metric values in the description. Calibrate severity by whether THIS diff introduced or worsened the metric, not by pre-existing debt:
- diff introduces/deepens transitive_loop_depth >= 3 on a caller-reachable path -> high
- diff adds linear_scan_in_loop (hidden O(n^2)) or alloc_in_loop on a hot path -> medium..high
- diff adds unguarded_recursion or recursion_in_loop -> high
- diff sharply raises cognitive complexity of a function -> medium
- pre-existing debt merely touched by the diff -> low, mention briefly
Each finding: exact file, line, metric values, and a concrete fix (extract, hoist the scan, use a map, cap recursion).

Return {findings: []-shaped JSON}.`
  }
  return `You are the **${lens}** review lens for a diff. Review ONLY this slice; ignore everything else (other lenses cover it).

SLICE: ${LENS_BRIEF[lens]}
Diff base: ${base}.
${intentArg ? `INTENT (what the change should do): ${intentArg}` : ''}
CONTEXT EXPANSION (required): for each finding, read the surrounding code and trace callers of the changed symbols before judging — do not read the diff in isolation.
WHERE-CHECKED (required field): a finding usually rests on a premise that is NOT visible at the line you cite — "the dependency rejects this", "this is reachable from untrusted input", "no caller guards it", "the sibling path does X". Pin every such premise to a \`file:line\` you ACTUALLY OPENED, dependency sources included, and put them in \`whereChecked\`. An off-site premise you did not open is not admissible: open it, or drop the claim and report only what the cited line shows. Use "" only when the finding needs no off-site premise.
CONFIDENCE: report everything you suspect, located to file:line. Do NOT self-censor borderline findings — adversarial verification happens downstream.

Return {findings: []-shaped JSON}.`
}

// ---- throttled runner (VERBATIM mirror of lib/throttled-runner.mjs — the sandbox can't import) ----
// The runner reports its own leftovers into `notRun`; callers that report them their own way (the
// finder lenses, which mark one BLOCKING entry per dead dimension) pass `reportUnjudged: false`.
// >>> craft-inline lib/throttled-runner.mjs unjudgedNotRun makeThrottledRunner
/**
 * @param {string} tag
 * @param {unknown[] | number | null | undefined} unfinished
 * @param {{ total?: number }} [opts]
 * @returns {{ label: string, note: string, incomplete: boolean }[]}
 */
function unjudgedNotRun(tag, unfinished, { total = 0 } = {}) {
  const count = Array.isArray(unfinished) ? unfinished.length : Number(unfinished) || 0
  if (count <= 0) return []
  const key = String(tag || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'checks'
  const wholePass = total > 0 && count >= total
  return [{
    label: `${key}-checks-unjudged`,
    note: wholePass
      ? `the entire ${tag} pass produced no verdict (${count} check(s)) — nothing it was judging was verified`
      : `${count} ${tag} check(s) got no verdict — the findings they were judging were decided on a partial panel, or not decided at all`,
    incomplete: wholePass,
  }]
}

/**
 * @typedef {object} ThrottledJob
 * @property {string} prompt
 * @property {string} label
 * @property {object} [schema]
 * @property {'low' | 'medium' | 'high' | 'xhigh' | 'max'} [effort]
 * @property {(v: unknown) => void} onResult  `v` is the agent's answer (model output), never null
 * @property {() => void} [onMissing]
 */
/**
 * @typedef {object} ThrottledDeps
 * @property {(prompt: string, opts: { label: string, phase: string, schema?: object | undefined, effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined }) => Promise<unknown>} agent
 * @property {(fns: Array<() => Promise<unknown>>) => Promise<unknown[]>} parallel
 * @property {(msg: string) => void} log
 * @property {(label: string, note: string, incomplete: boolean) => void} markNotRun
 * @property {number} batch
 * @property {number} retryBatch
 * @property {number} maxRetryRounds
 * @property {{ total: number | null, remaining: () => number }} budget  `total` is null when no token target was set
 * @property {number} budgetFloor
 */
/**
 * @param {ThrottledDeps} deps
 * @returns {(jobs: ThrottledJob[], tag: string, phaseTitle: string, opts?: { reportUnjudged?: boolean }) => Promise<ThrottledJob[]>}
 */
function makeThrottledRunner(deps) {
  const { agent, parallel, log, markNotRun, batch: BATCH, retryBatch, maxRetryRounds, budget, budgetFloor } = deps
  /**
   * @param {ThrottledJob[]} pending
   * @param {number} size
   * @param {number} round
   * @param {string} tag
   * @param {string} phaseTitle
   * @param {{ done: number, jobs: ThrottledJob[] }} progress  `done` counts across rounds
   * @returns {Promise<{ failed: ThrottledJob[], unfinished: ThrottledJob[] | null }>}
   */
  const runRound = async (pending, size, round, tag, phaseTitle, progress) => {
    /** @type {ThrottledJob[]} */
    const failed = []
    for (let i = 0; i < pending.length; i += size) {
      if (budget.total && budget.remaining() < budgetFloor) {
        const skipped = pending.length - i + failed.length
        log(`Budget guard: ~${Math.round(budget.remaining() / 1000)}k tokens left -> stopping ${tag}, ${skipped} calls skipped`)
        return { failed, unfinished: pending.slice(i).concat(failed) }
      }
      const slice = pending.slice(i, i + size)
      const res = await parallel(slice.map(j => () =>
        agent(j.prompt, { label: (round ? `retry${round}:` : '') + j.label, phase: phaseTitle, schema: j.schema, effort: j.effort })))
      res.forEach((v, k) => {
        if (v) { /** @type {ThrottledJob} */ (slice[k]).onResult(v); progress.done++ } else failed.push(/** @type {ThrottledJob} */ (slice[k]))
      })
      log(`${tag}: ${progress.done}/${progress.jobs.length} calls done`)
    }
    return { failed, unfinished: null }
  }
  /**
   * @param {ThrottledJob[]} unfinished
   * @param {string} tag
   * @param {number} total
   * @param {boolean} reportUnjudged
   */
  const settle = (unfinished, tag, total, reportUnjudged) => {
    for (const j of unfinished) if (typeof j.onMissing === 'function') j.onMissing()
    if (reportUnjudged) for (const e of unjudgedNotRun(tag, unfinished, { total })) markNotRun(e.label, e.note, e.incomplete)
  }
  return async function runThrottled(jobs, tag, phaseTitle, { reportUnjudged = true } = {}) {
    let pending = jobs
    const progress = { done: 0, jobs }
    /** @type {ThrottledJob[] | null} */
    let unfinished = null
    for (let round = 0; round <= maxRetryRounds && pending.length && !unfinished; round++) {
      const size = round === 0 ? BATCH : retryBatch
      if (round > 0) log(`${tag} retry round ${round}: ${pending.length} failed calls, batches of ${size}`)
      const ran = await runRound(pending, size, round, tag, phaseTitle, progress)
      unfinished = ran.unfinished
      if (!unfinished) pending = ran.failed
    }
    if (!unfinished) unfinished = pending
    settle(unfinished, tag, jobs.length, reportUnjudged)
    return unfinished
  }
}
// <<< craft-inline

// ---- coverage honesty (VERBATIM mirror of lib/review-coverage.mjs — the sandbox can't import) ----
// Only the LANGUAGE-AGNOSTIC half is mirrored here. This engine declares no language profiles, so
// every material file is in scope for its lenses and there is no "matched no profile" gap to
// report; what it does share with review.js is the pair of guards that stop a run which looked at
// nothing from returning a bare Approve.
// >>> craft-inline lib/review-coverage.mjs noChangedFilesMessage INERT_EXT INERT_NAMES GENERATED_PATH GENERATED_FILE isInertUncovered materialUncovered nothingToReviewMessage
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

/** @param {number} fileCount */
function nothingToReviewMessage(fileCount) {
  return `NOTHING NEEDED REVIEWING — all ${fileCount} changed file(s) are documentation, assets, lockfiles or generated output; none carries reviewable code. No lens ran because none had anything to look at.`
}
// <<< craft-inline

// ================= Prep: scout + index warm-up (2 agents, parallel) =================
// `repo` is NOT supported by this engine: every agent it dispatches runs git/cargo wherever the
// session sits. Accepting it silently is the failure this family exists to end — the caller names
// another repository, the engine reads its own, and the verdict looks entirely normal for the wrong
// code (measured 2026-09-17 on `review`, before `repo` reached that engine's argument list: 57
// agents, 2.04M tokens, nothing reviewed). Refuse before anything runs, and name what does work.
// The comment above used to promise this argument while nothing read it (realm @nick/craft, #65).
// MOVED here from the argument block, and the move IS the fix. Refused up there it returned before
// `logRun` and its dependencies existed, so a repeatedly mis-dispatched engine filed no record at
// all — and `notRun` fragility ranking, which is the one place a repeated wrong dispatch would show
// up, never saw it. This is still before the first phase, so nothing has run when it refuses.
if (A['repo']) {
  const refused = repoRefusal({ engine: 'adversarial-review', repo: String(A['repo']), craftVersion: CRAFT_VERSION, outputTokens: budget.spent(), via: viaArg })
  await logRun(refused.record)
  return refused.report + priorDecisionsRefusedSection(priorDecisionsIn.refused)
}

/** @returns {string} the scout's instruction for resolving the diff base */
const scoutBaseStep = () => diffBase ? `Use \`${diffBase}\`.` : 'Try in order: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`. If the tree has uncommitted changes, target those.'

phase('Prep')
const [scoutRaw, warmupRaw] = await parallel([
  () => agent(
    `You are scouting a diff to plan an adversarial review. Use shell + read only — do NOT review yet.
1. Resolve the diff base. ${scoutBaseStep()}
2. Inspect \`git diff --stat\` and list every touched path with \`git diff --name-only\` (same base) into changedFiles — complete and verbatim. sizeBucket: small = a few files / < ~80 changed lines; large = many files / > ~400 lines or auth/money/concurrency-heavy; medium otherwise.
3. lenses: choose from ${JSON.stringify(ALL_LENSES)}.
   - small: only the touched categories (minimum 2; always include 'correctness').
   - medium: the categories plausibly in play.
   - large: all of them.
   Decide "in play" from the diff: payments/amounts/ledger -> money; async/threads/locks/transactions -> concurrency; input parsing/auth/tenancy -> security; loops/queries -> performance; always consider 'correctness' and 'errors'. Include 'complexity' whenever the diff is medium/large (it self-skips if the repo is not indexed).`,
    { label: 'scout', schema: SCOUT_SCHEMA, model: 'haiku', effort: 'low' },
  ),
  () => agent(
    `You are warming up the codebase-memory index for a review. Use ToolSearch to load the codebase-memory MCP tools.
1. Check list_projects / index_status for this repository.
2. If the project is not indexed or the index is stale relative to the current HEAD, run index_repository with mode=fast on the repo root and wait for it.
3. Return indexed=true only if a usable index exists when you are done. If the MCP server is unavailable, return indexed=false — never error.`,
    { label: 'index-warmup', schema: WARMUP_SCHEMA, effort: 'low' },
  ),
])
const scout = /** @type {ScoutResult | null} */ (scoutRaw)
const warmup = /** @type {WarmupResult | null} */ (warmupRaw)

/** @param {ScoutResult | null} scout @returns {string[]} the scout's lenses that are in the catalog, or every lens */
const scoutLenses = scout => (scout?.lenses?.length ? scout.lenses.filter((/** @type {string} */ l) => ALL_LENSES.includes(l)) : ALL_LENSES)
/**
 * The complexity lens is metrics-or-nothing: without a usable index it is dropped from the plan.
 * @param {{ lenses: string[] }} plan @param {WarmupResult | null} warmup
 */
function dropComplexityUnlessIndexed(plan, warmup) {
  if (!(warmup?.indexed)) {
    plan.lenses = plan.lenses.filter((/** @type {string} */ l) => l !== 'complexity')
    log(`codebase-memory index unavailable (${warmup?.notes ?? 'warm-up died'}) -> complexity lens dropped`)
  }
}
/** @param {ScoutResult | null} scout @param {WarmupResult | null} warmup */
function planReview(scout, warmup) {
  const plan = {
    baseRef: scout?.baseRef ?? diffBase,
    sizeBucket: scout?.sizeBucket ?? 'medium',
    lenses: scoutLenses(scout),
  }
  dropComplexityUnlessIndexed(plan, warmup)
  log(`Scout: ${plan.sizeBucket} diff -> lenses: ${plan.lenses.join(', ')} · ${scout?.notes ?? 'scout died, running all lenses'}`)
  return plan
}
const plan = planReview(scout, warmup)
/** @param {string[]} lenses @returns {{ size: string, lenses: string[], indexed: boolean, batch: number }} the record's `scout` field */
const scoutRecord = lenses => ({ size: plan.sizeBucket, lenses, indexed: !!(warmup?.indexed), batch: BATCH })

// ---- coverage guard: a run that looked at nothing must not report a green Approve ----
// The scout enumerates the diff; three outcomes have to be told apart, and only the third is a
// review. A dead scout is NOT an empty diff — it is an unknown one, so it opens `notRun` and the
// review proceeds over all lenses rather than short-circuiting to a verdict about nothing.
// A scout that came back WITHOUT a `changedFiles` array is the dead-scout case, not the empty-diff
// one: the list is unknown, not empty. Folding it into `!scout` also keeps the `: null` below from
// reaching `!changedFiles.length`, which threw a TypeError and aborted the run before any lens ran
// and before any run record was filed — the most permissive failure there is, an invisible one.
//
// Two things are recorded per entry, and they are not the same thing.
//   `label` goes in the RUN RECORD. `lib/analyze-runs.mjs` ranks `notRun` by EXACT STRING to
//   surface fragility that REPEATS across runs, so a label must be bare and aggregatable — no
//   counts, no lens lists, no file names. A note like "3 finder lens(es) never returned:
//   correctness, concurrency" is unique to its run and fills the ranking with count-1 rows,
//   sinking the real repeats. `lens:correctness` aggregates into `3× lens:correctness`.
//   `note` is the human sentence: it goes to the log and to the returned object, where it is read
//   once, by a person, about this run.
//   `incomplete` decides whether the entry downgrades the VERDICT. Not everything recorded here is
//   a coverage hole: a single verification check with no verdict, or coverage gaps skipped at the
//   budget floor, leave their findings reported as Suspected — already the honest label — and they
//   fire on routine runs. A marker that fires on every run stops being read, which is exactly what
//   would destroy it on the runs where a dimension really did go unreviewed. So those are recorded
//   (the fragility signal is kept) but advisory; only an unreviewed dimension downgrades. This is
//   the same line `review.js` draws: dead lenses and skipped critics mark INCOMPLETE, individual
//   unverified checks do not.
/** @type {{ label: string, note: string, incomplete: boolean }[]} */
const notRun = []
/** @type {(label: string, note: string, incomplete?: boolean) => number} */
const markNotRun = (label, note, incomplete = true) => notRun.push({ label, note, incomplete })
const notRunLabels = () => notRun.map(e => e.label)
const notRunNotes = () => notRun.map(e => e.note)
const notRunBlocking = () => notRun.filter(e => e.incomplete)
const runThrottled = makeThrottledRunner({
  agent, parallel, log, markNotRun,
  batch: BATCH, retryBatch: RETRY_BATCH, maxRetryRounds: MAX_RETRY_ROUNDS,
  budget, budgetFloor: BUDGET_FLOOR,
})
/**
 * Files the record of a run that ended before any lens ran.
 * @param {string} verdict @param {string[]} labels  its notRun classes
 */
async function fileEarlyExit(verdict, labels) {
  await logRun({
    ...recordHead(),
    verdict, findings: summarizeFindings([]),
    scout: scoutRecord([]),
    dimensions: [], verification: { candidates: 0, confirmed: 0, refuteRate: 0 },
    notRun: labels, outputTokens: budget.spent(),
  })
}

/**
 * An INCOMPLETE early exit: logged, filed under its one notRun class, and returned with its message.
 * @param {string} verdict @param {string} label @param {string} msg
 */
async function incompleteExit(verdict, label, msg) {
  log(`INCOMPLETE — ${msg}`)
  await fileEarlyExit(verdict, [label])
  return { verdict, confirmed: [], suspected: [], notRun: [msg].concat(telemetryNotes()), scout: { size: plan.sizeBucket, lenses: [], deadLenses: [] }, ...priorRefusedResult() }
}

/** @returns {string} the cross-check's instruction for resolving the diff base */
const crossBaseStep = () => diffBase ? `The caller pinned it: use \`${diffBase}\`.` : 'Try in order: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`. If the tree has uncommitted changes, target those.'

/**
 * Why the cross-check does not confirm the scout's all-inert list, or null when it does.
 * @param {CrosscheckResult | null} cross @param {string[]} changedFiles @returns {string | null}
 */
function inertDisagreement(cross, changedFiles) {
  const crossFiles = (cross?.ok && Array.isArray(cross.files)) ? cross.files.filter(isPath) : null
  // Read only where `crossFiles` is set, and that implies a live `cross`.
  const crossCount = cross?.fileCount
  if (!crossFiles) return 'the cross-check never returned a usable list'
  if (crossFiles.length !== crossCount) return `the cross-check list is incomplete (${crossFiles.length} paths vs ${crossCount} reported by git)`
  if (crossFiles.length !== changedFiles.length) return `git reports ${crossFiles.length} changed file(s), the scout reported ${changedFiles.length}`
  if (materialUncovered(crossFiles).length) return `git's list contains reviewable code the scout did not report: ${materialUncovered(crossFiles).join(', ')}`
  return null
}

// All inert (docs/assets/lockfiles/generated). Nothing ran AND nothing needed to — an honest
// green, deliberately not marked INCOMPLETE: a marker that fires on every README-only change
// stops being read on the diffs that do hide unreviewed code.
//
// But this is the ONE exit where a green rests entirely on the scout's file list, and that list
// comes from a model, not from `git`. A scout that truncated, globbed, or resolved the wrong base
// and happened to emit only docs and lockfiles would approve a real code diff. The script itself
// has no shell (the Workflow sandbox has no filesystem or Node API), so the deterministic route
// is a second, single-purpose agent that does nothing but transcribe `git diff --name-only`. It
// is cheap and only fires on this branch. The green is taken only if that independent list is
// complete by its own `wc -l`, agrees with the scout's size, and is itself entirely inert;
// anything else — including a dead cross-check — falls back to INCOMPLETE.
//
// The base is resolved INDEPENDENTLY, not taken from `plan.baseRef`. Pinning the cross-check to
// the scout's own base would leave the wrong-base case structurally invisible — both agents would
// diff the same wrong ref, agree perfectly, and the green would be granted. Resolving it again
// from the same deterministic ladder turns a wrong base into a differing file list, which the
// comparison below already catches. Only an explicit `diffBase` argument is passed through: there
// the base is the caller's, not the scout's, so there is nothing to cross-check.
//
// What this still does NOT catch: `fileCount` and `files` come from the same model in the same
// response, so the self-consistency arm is self-reported — a model that truncates the list AND
// lowers its own count to match defeats it. What that arm actually rules out is the ordinary
// failure (a list shortened while the count stays honest), not a coordinated one.
/** @param {string[]} changedFiles  the scout's list, every path inert */
async function inertExit(changedFiles) {
  const cross = /** @type {CrosscheckResult | null} */ (await agent(
    `You are cross-checking a diff's file list. Run shell only — do NOT review, summarise, or judge anything.
1. Resolve the diff base YOURSELF — do not take it from anyone else. ${crossBaseStep()}
2. Run \`git diff --name-only <base>\` and \`git diff --name-only <base> | wc -l\`.
3. Return every path VERBATIM in \`files\` — no truncation, no globbing, no sorting, no elision — and the \`wc -l\` number in \`fileCount\`.
4. Set ok=true ONLY if the git command succeeded and \`files\` holds every path it printed. If anything failed, or you had to shorten the list for any reason, set ok=false.`,
    { label: 'inert-crosscheck', phase: 'Prep', schema: CROSSCHECK_SCHEMA, model: 'haiku', effort: 'low' },
  ))
  const why = inertDisagreement(cross, changedFiles)
  if (why) {
    return await incompleteExit('INCOMPLETE (unconfirmed inert diff)', 'inert-diff-unconfirmed',
      `NOT REVIEWED — the scout said every changed file was inert (docs/assets/lockfiles/generated), but ${why}. The scout's file list is the only thing that green rested on, so it is not granted: no lens ran, and this is not an approval. Re-run, checking the diff base.`)
  }
  const msg = nothingToReviewMessage(changedFiles.length)
  log(msg)
  memory = skippedMemory(memory, 'nothing to review')
  await fileEarlyExit('Approve', [])
  return { verdict: 'Approve', confirmed: [], suspected: [], notRun: telemetryNotes(), summary: msg, scout: { size: plan.sizeBucket, lenses: [], deadLenses: [] }, ...priorRefusedResult() }
}

/**
 * Tells apart the scout's three outcomes: an unknown diff (opens notRun; the review proceeds), an
 * empty one and an all-inert one (both end the run here). Returns the early result, or null to review.
 * @param {ScoutResult | null} scout
 */
async function coverageGuard(scout) {
  const changedFiles = Array.isArray(scout?.changedFiles) ? scout.changedFiles.filter(isPath) : null
  if (!scout || !changedFiles) {
    markNotRun('scout-dead', scout
      ? 'the scout returned no file list — the diff was never enumerated, so what the lenses saw is unverified'
      : 'scout died — the diff was never enumerated, so what the lenses saw is unverified')
    return null
  }
  if (!changedFiles.length) {
    memory = skippedMemory(memory, 'nothing to review')
    return await incompleteExit('INCOMPLETE (empty diff)', 'empty-diff', noChangedFilesMessage())
  }
  if (!materialUncovered(changedFiles).length) return await inertExit(changedFiles)
  return null
}
const early = await coverageGuard(scout)
if (early) return early
// ONE read-only agent recalls the decisions through the craft:memory skill for the diff's paths (realm
// @nick/craft, node #203); its answer is parsed like a passed list and the passed records merge into it.
async function recallMemory() {
  if (recalledByLauncher) return
  if (budget.total && budget.remaining() < BUDGET_FLOOR) {
    memory = withPassed({ source: 'none', count: 0, why: `recall did not run — budget below the floor (~${Math.round(budget.remaining() / 1000)}k left)` }, priorDecisionsIn.decisions.length, priorDecisionsIn.decisions.length)
    return
  }
  const paths = Array.isArray(scout?.changedFiles) ? scout.changedFiles.filter(isPath) : []
  const r = await recallDecisions(p => agent(p, { label: 'memory-recall', phase: 'Prep', schema: MEMORY_RECALL_SCHEMA, effort: 'low' }), paths, plan.baseRef || '')
  const m = mergeRecall(r, A['priorDecisions'], parsePriorDecisions)
  priorDecisionsIn = m.prior
  memory = m.memory
  for (const x of m.recalledRefused) log(`WARNING: priorDecisions: ${x}`)
}
await recallMemory()

// ================= Review: throttled finder lenses =================
/**
 * Lenses whose answer came back and is not a review, marked not-run one entry per lens.
 * @param {string[]} lenses @param {Map<string, FindingsResult | null>} lensResults @returns {string[]}
 */
function markMalformedLenses(lenses, lensResults) {
  // A result is model output: the schema is enforced by the tool, but a lens that came back without a
  // findings array is a lens that did not review, not one that found nothing — and must not crash the run.
  // It is dead for every consumer of `deadLenses` (the all-dead check, the critic's prompt, the returned
  // scout), not only for `notRun`.
  const malformedLenses = lenses.filter((/** @type {string} */ lens) => {
    const r = lensResults.get(lens)
    return r != null && !Array.isArray(r.findings)
  })
  if (malformedLenses.length) {
    log(`WARNING: finder lens(es) answered without a findings array: ${malformedLenses.join(', ')}`)
    for (const l of malformedLenses) markNotRun(`lens:${l}`, `the ${l} finder lens returned no findings array — that dimension went unreviewed`)
  }
  return malformedLenses
}

/**
 * Runs the finder lenses throttled; returns every finding tagged with its lens, and the lenses that
 * did not review (died, or answered without a findings array).
 * @param {string[]} lenses
 */
async function runFinderLenses(lenses) {
  /** @type {Map<string, FindingsResult | null>} */
  const lensResults = new Map()
  const deadLensJobs = await runThrottled(
    lenses.map((/** @type {string} */ lens) => ({
      prompt: finderPrompt(lens),
      label: `review:${lens}`,
      schema: FINDINGS,
      effort: 'medium',
      onResult: (/** @type {unknown} */ r) => lensResults.set(lens, /** @type {FindingsResult | null} */ (r)),
    })),
    'Review', 'Review', { reportUnjudged: false },
  )
  const diedLenses = deadLensJobs.map(j => j.label.replace(/^.*review:/, ''))
  if (diedLenses.length) {
    log(`WARNING: finder lens(es) returned nothing: ${diedLenses.join(', ')}`)
    // One entry PER dead lens: `lens:correctness` is what aggregates across runs into
    // "3× lens:correctness", which is the whole point of ranking `notRun`.
    for (const l of diedLenses) markNotRun(`lens:${l}`, `the ${l} finder lens never returned — that dimension went unreviewed`)
  }
  const malformedLenses = markMalformedLenses(lenses, lensResults)
  /** @type {string[]} */
  const deadLenses = [...new Set([...diedLenses, ...malformedLenses])]
  if (lenses.length && deadLenses.length === lenses.length) markNotRun('all-lenses-dead', 'EVERY finder lens died — no lens looked at this diff at all')

  const all = lenses.flatMap((/** @type {string} */ lens) => {
    const r = lensResults.get(lens)
    return r && Array.isArray(r.findings) ? r.findings.map(x => ({ ...x, lens })) : []
  })
  return { deadLenses, all }
}

phase('Review')
const { deadLenses, all } = await runFinderLenses(plan.lenses)

// ---- dedup, tier 1 (mechanical): neighbor line-buckets + title-token similarity ----
// Merging requires BOTH nearby lines (|Δ| <= 5, buckets k-1..k+1 so bucket borders don't split)
// AND similar titles — proximity alone never merges, so two distinct issues in one window
// survive as two findings. Under-merge costs one cheap verify agent; over-merge silently
// loses a finding — stay conservative.
const normTokens = (/** @type {unknown} */ t) => new Set(String(t || '').toLowerCase().replace(/[^a-z0-9а-яё]+/gi, ' ').split(' ').filter(w => w.length > 2))
/** @param {unknown} a @param {unknown} b */
function titleSimilar(a, b) {
  const tokensA = normTokens(a), B = normTokens(b)
  if (!tokensA.size || !B.size) return false
  let inter = 0
  for (const w of tokensA) if (B.has(w)) inter++
  return inter / (tokensA.size + B.size - inter) > 0.5
}
/**
 * The first entry in bucket b-1, b or b+1 of the finding's file that lies within 5 lines and has a similar title.
 * @param {Map<string, LensFinding[]>} buckets @param {RawFinding} f @param {number} b @returns {LensFinding | null}
 */
function nearbySimilar(buckets, f, b) {
  for (const nb of [b - 1, b, b + 1]) {
    for (const e of (buckets.get(`${f.file}:${nb}`) || [])) {
      if (Math.abs(e.line - f.line) <= 5 && titleSimilar(e.title, f.title)) return e
    }
  }
  return null
}
/**
 * Folds a duplicate into the entry it hit: its lens joins the sources, and a more severe duplicate's wording wins.
 * @param {LensFinding} hit @param {RawFinding & { lens: string }} f
 */
function absorbDuplicate(hit, f) {
  if (!hit.sources.includes(f.lens)) hit.sources.push(f.lens)
  if (SEV_RANK[/** @type {keyof typeof SEV_RANK} */ (f.severity)] < SEV_RANK[/** @type {keyof typeof SEV_RANK} */ (hit.severity)]) {
    Object.assign(hit, { title: f.title, line: f.line, severity: f.severity, description: f.description, fix: f.fix, lens: f.lens })
  }
}
/** @param {(RawFinding & { lens: string })[]} all @returns {LensFinding[]} the pool after mechanical dedup, most severe first */
function mechanicalDedup(all) {
  /** @type {Map<string, LensFinding[]>} */
  const buckets = new Map()   // `${file}:${bucket}` -> entries in that bucket
  /** @type {LensFinding[]} */
  const merged = []
  for (const f of all) {
    const b = Math.floor(f.line / 10)
    const hit = nearbySimilar(buckets, f, b)
    if (hit) {
      absorbDuplicate(hit, f)
      continue
    }
    const entry = { ...f, sources: [f.lens] }
    merged.push(entry)
    const key = `${f.file}:${b}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(entry)
    else buckets.set(key, [entry])
  }
  return merged.sort((a, b) => SEV_RANK[/** @type {keyof typeof SEV_RANK} */ (a.severity)] - SEV_RANK[/** @type {keyof typeof SEV_RANK} */ (b.severity)])
}
let kept = mechanicalDedup(all)
log(`Review: ${all.length} raw findings -> ${kept.length} after mechanical dedup`)

// ---- dedup, tier 2 (semantic, thresholded): one haiku clusterer for cross-vocabulary duplicates ----
// Catches what token overlap can't: different lenses describing one defect in different words
// ("TOCTOU at debit" vs "race on balance update"). Runs only on large pools where duplicates
// are likely; merges keep BOTH formulations so an over-eager merge degrades to a verbose
// description instead of a lost finding.
const DEDUP_THRESHOLD = 15
/** @returns {boolean} whether the budget still allows spawning agents (an unlimited one always does) */
const budgetAllows = () => !budget.total || budget.remaining() > BUDGET_FLOOR
/**
 * Merges each cluster's duplicates into its most severe member, keeping both formulations.
 * @param {LensFinding[]} kept @param {number[][]} clusters @returns {Set<number>} the indices merged away
 */
function mergeClusters(kept, clusters) {
  /** @type {Set<number>} */
  const drop = new Set()
  // Only ever called with an index the filter below has bounded to `kept`.
  const at = (/** @type {number} */ i) => /** @type {LensFinding} */ (kept[i])
  for (const cluster of clusters) {
    const idxs = [...new Set(Array.isArray(cluster) ? cluster : [])]
      .filter(i => Number.isInteger(i) && i >= 0 && i < kept.length && !drop.has(i))
      .sort((x, y) => SEV_RANK[/** @type {keyof typeof SEV_RANK} */ (at(x).severity)] - SEV_RANK[/** @type {keyof typeof SEV_RANK} */ (at(y).severity)])
    if (idxs.length < 2) continue
    const head = at(/** @type {number} */ (idxs[0]))
    for (const i of idxs.slice(1)) {
      mergeDuplicate(head, at(i))
      drop.add(i)
    }
  }
  return drop
}
/** @param {LensFinding} head @param {LensFinding} dup */
function mergeDuplicate(head, dup) {
  for (const s of dup.sources) if (!head.sources.includes(s)) head.sources.push(s)
  head.description += `\n[merged duplicate] ${dup.title} @ ${dup.file}:${dup.line}: ${dup.description}`
}
/** @param {LensFinding[]} kept @returns {Promise<LensFinding[]>} the pool after the semantic clusterer, or `kept` itself when it merged nothing */
async function semanticDedup(kept) {
  const CLUSTERS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['clusters'],
    properties: {
      clusters: {
        type: 'array',
        items: { type: 'array', items: { type: 'number' }, description: 'indices of findings that are the SAME defect' },
        description: 'only groups of 2+; singletons are omitted; empty if no duplicates',
      },
    },
  }
  const clusterer = /** @type {ClustersResult | null} */ (await agent(
    `You are deduplicating review findings. Below is a numbered list. Return clusters of indices that describe THE SAME underlying defect — same root cause, one fix would resolve all of them — even when phrased in different vocabulary or cited at nearby-but-different lines (e.g. a check-site vs a write-site of one race).
Merge ONLY when confident the fix is literally the same change. Two different problems in the same function are NOT a cluster. When in doubt, do not merge. Return {"clusters": []} if there are no duplicates.

FINDINGS:
${kept.map((f, i) => `${i}. [${f.severity}] ${f.title} @ ${f.file}:${f.line} (lenses: ${f.sources.join(',')}) — ${f.description}`).join('\n')}`,
    { label: 'dedup-semantic', phase: 'Review', schema: CLUSTERS_SCHEMA, model: 'haiku', effort: 'low' },
  ))
  // Model output: a live clusterer whose `clusters` is not an array merged nothing — say so, never throw.
  const clusters = Array.isArray(clusterer?.clusters) ? clusterer.clusters : []
  if (clusterer && !Array.isArray(clusterer.clusters)) log('WARNING: semantic dedup returned clusters that are not an array — no semantic merge applied')
  const drop = mergeClusters(kept, clusters)
  if (!drop.size) {
    log('Semantic dedup: no cross-vocabulary duplicates found')
    return kept
  }
  const rest = kept.filter((_f, i) => !drop.has(i))
  log(`Semantic dedup: merged ${drop.size} duplicate(s) -> ${rest.length} findings`)
  return rest
}
if (kept.length > DEDUP_THRESHOLD && budgetAllows()) kept = await semanticDedup(kept)

// ================= Verify =================
phase('Verify')
const COMBINED_INSTR = `You are an adversarial verifier. Try to REFUTE this finding. Check ALL THREE dimensions in one pass:
1. code — is the claim factually true in the code as written? Read the actual code; do not trust the description.
2. exploit — construct a concrete end-to-end scenario that triggers the issue. If you cannot, that counts against the finding.
3. severity — calibrate real impact for the multi-tenant money-path, and confirm the issue is in scope for THIS diff.
Return refuted=true if ANY dimension fails. Default to refuted=true when uncertain. Return the calibrated severity.
Also set premiseSupported: identify the ONE claim that, if false, makes the finding evaporate. If it lives outside the cited line, OPEN the finding's whereChecked location and check it actually shows that; premiseSupported=false when the premise is off-site and whereChecked is empty, points elsewhere, or merely restates the cited line. Unsupported is NOT disproven — do not raise refuted for it; the field demotes the finding on its own.`
const COMBINED_METRIC_INSTR = `You are an adversarial verifier for a METRIC-BACKED complexity finding.
Use ToolSearch to load the codebase-memory MCP tools. Check ALL THREE dimensions:
1. metric — re-read the metric values yourself via query_graph; refute if they don't match the claim or the index is unavailable.
2. attribution — confirm THIS diff introduced or worsened the metric (compare against detect_changes); pre-existing debt misattributed to the diff -> refute or downgrade.
3. severity — calibrate real impact: is the function on a hot / caller-reachable path (trace_path), or dead-end cold code?
Return refuted=true if ANY dimension fails; default to refuted=true when uncertain.
Also set premiseSupported: true when you re-read the metric values yourself and they back the claim, false when the numbers came only from the finding's own description. Unsupported is NOT disproven — it demotes the finding without marking it refuted.`
/** @type {[string, string][]} */
const PANEL_LENSES = [
  ['code', 'Verify ONLY the factual claim against the code as written. Read the code yourself; refute if the description misstates it.'],
  ['exploit', 'Try to construct a concrete end-to-end exploit/trigger scenario. Refute if no realistic path exists.'],
  ['severity', 'Calibrate real-world severity for the multi-tenant money-path and check the issue is in scope for this diff. Refute if severity is inflated or out of scope.'],
]

// Builds verify jobs for a set of findings, writing votes into `sink[idx]`.
// Single combined verifier (effort low) for medium/low; 3-lens panel (effort high)
// for critical/high; metric-aware single verifier for complexity findings.
/**
 * @param {LensFinding[]} findings
 * @param {unknown[][]} sink  per-finding raw votes, one slot per finding
 */
function buildVerifyJobs(findings, sink) {
  /** @type {Parameters<typeof runThrottled>[0]} */
  const jobs = []
  // `sink` is built as one array per finding, so `idx` from `findings.forEach` always has a slot.
  const slot = (/** @type {number} */ idx) => /** @type {unknown[]} */ (sink[idx])
  findings.forEach((f, idx) => {
    const ctx = `FINDING [${f.severity}] ${f.title} @ ${f.file}:${f.line}\n` +
      `Independently reported by lenses: ${(f.sources || [f.lens]).join(', ')}\n${f.description}\nProposed fix: ${f.fix}\n` +
      `Off-site evidence claimed: ${f.whereChecked || '(none — the finding claims to be self-contained at the cited line)'}`
    /** @type {(lens: string, instr: string, effort: 'low' | 'high', tagged: boolean) => number} */
    const push = (lens, instr, effort, tagged) => jobs.push({
      prompt: `${instr}\n\n${ctx}`,
      label: `verify${tagged ? `[${lens}]` : ''}:${f.file}:${f.line}`,
      schema: VERDICT,
      effort,
      onResult: (/** @type {unknown} */ v) => slot(idx).push({ lens, .../** @type {VerdictResult | null} */ (v) }),
      // A check that never returned leaves a placeholder, so the judge can SEE the panel is short.
      // Without it a 3-lens panel that lost one member is indistinguishable from a 2-lens panel.
      onMissing: () => slot(idx).push({ lens, missing: true }),
    })
    if (f.lens === 'complexity') push('metric', COMBINED_METRIC_INSTR, 'low', true)
    else if (isEscalated(f)) for (const [lens, instr] of PANEL_LENSES) push(lens, instr, 'high', true)
    else push('combined', COMBINED_INSTR, 'low', false)
  })
  return jobs
}

// >>> craft-inline lib/adversarial-judge.mjs usableVote judgeVotes
/**
 * @param {unknown} v  an agent-returned verdict object of unknown shape (model output)
 * @param {Record<string, number>} SEV_RANK
 * @returns {v is Vote}
 */
function usableVote(v, SEV_RANK) {
  if (!v || typeof v !== 'object') return false
  const o = /** @type {{ refuted?: unknown, premiseSupported?: unknown, severity?: unknown }} */ (v)
  return typeof o.refuted === 'boolean'
    && typeof o.premiseSupported === 'boolean'
    && (o.severity === 'not-an-issue' || SEV_RANK[/** @type {string} */ (o.severity)] != null)
}

/**
 * The findings come back as they went in — the caller's own type — with the judge's verdict fields added.
 * @template {{ severity: string }} F
 * @param {F[]} findings
 * @param {Array<unknown[] | undefined>} sink  per-finding raw votes (model output, possibly malformed or `{ missing: true }`)
 * @param {Record<string, number>} SEV_RANK
 */
function judgeVotes(findings, sink, SEV_RANK) {

  /** @type {(sev: string) => number} */
  const rankOf = sev => /** @type {number} */ (SEV_RANK[sev])
  const ranks = Object.keys(SEV_RANK).sort((a, b) => rankOf(a) - rankOf(b))
  const MOST = /** @type {string} */ (ranks[0])
  const LEAST = /** @type {string} */ (ranks[ranks.length - 1])
  /** @type {(sev: string) => 'block' | 'warning' | 'approve'} */
  const tierOf = sev => (rankOf(sev) <= rankOf('high') ? 'block' : sev === 'medium' ? 'warning' : 'approve')
  /** @type {(f: F, votes: Vote[], missing: number, pad: string) => string} */
  const calibrateWith = (f, votes, missing, pad) => {
    const sevs = votes.filter(v => !v.refuted && v.severity !== 'not-an-issue')
      .map(v => v.severity)
      .concat(Array.from({ length: missing }, () => pad))
      .sort((a, b) => rankOf(a) - rankOf(b))
    return sevs.length ? /** @type {string} */ (sevs[Math.floor(sevs.length / 2)]) : f.severity
  }
  /** @type {(f: F, votes: Vote[], missing: number) => string} */
  const calibrate = (f, votes, missing) => calibrateWith(f, votes, missing, f.severity)
  /** @type {(raw: unknown[] | undefined) => Array<Vote | { lens?: unknown, missing: true }>} */
  const readVotes = raw => (raw || []).map(v => (usableVote(v, SEV_RANK) && !v.missing) ? v : { lens: v && /** @type {{ lens?: unknown }} */ (v).lens, missing: true })
  /** @type {(panel: number, votes: Vote[], missing: number) => { refuteUndecided: boolean, survives: boolean }} */
  const refuteAxis = (panel, votes, missing) => {
    const refutes = votes.filter(v => v.refuted).length
    const survivesIfAbsentRefute = votes.length > 0 && (refutes + missing) * 2 < panel
    const survivesIfAbsentConfirm = votes.length > 0 && refutes * 2 < panel
    const refuteUndecided = survivesIfAbsentRefute !== survivesIfAbsentConfirm
    return { refuteUndecided, survives: !refuteUndecided && survivesIfAbsentRefute }
  }
  /** @type {(panel: number, votes: Vote[], missing: number, survives: boolean) => { premiseUndecided: boolean, premiseUnsupported: boolean }} */
  const premiseAxis = (panel, votes, missing, survives) => {
    const supported = votes.filter(v => v.premiseSupported).length
    const unsupportedIfAbsentUnsupported = supported * 2 <= panel
    const unsupportedIfAbsentSupported = (supported + missing) * 2 <= panel
    const premiseUndecided = survives && unsupportedIfAbsentUnsupported !== unsupportedIfAbsentSupported
    return { premiseUndecided, premiseUnsupported: survives && !premiseUndecided && unsupportedIfAbsentUnsupported }
  }
  /** @type {(f: F, votes: Vote[], missing: number, open: boolean) => boolean} */
  const severityAxisUndecided = (f, votes, missing, open) => open && missing > 0
    && tierOf(calibrateWith(f, votes, missing, MOST)) !== tierOf(calibrateWith(f, votes, missing, LEAST))
  /** @type {(f: F, votes: Vote[], missing: number, undecided: boolean) => { undecidedByAbsence: boolean, couldHaveBlocked: boolean }} */
  const absenceOutcome = (f, votes, missing, undecided) => {
    const undecidedByAbsence = missing > 0 && (undecided || votes.length === 0)
    const reachable = votes.length ? calibrateWith(f, votes, missing, MOST) : MOST
    return { undecidedByAbsence, couldHaveBlocked: undecidedByAbsence && tierOf(reachable) === 'block' }
  }
  const judged = findings.map((f, idx) => {
    const all = readVotes(sink[idx])
    const missing = all.filter(v => v.missing).length
    const votes = /** @type {Vote[]} */ (all.filter(v => !v.missing))
    const { refuteUndecided, survives } = refuteAxis(all.length, votes, missing)
    const { premiseUndecided, premiseUnsupported } = premiseAxis(all.length, votes, missing, survives)
    const severityUndecided = severityAxisUndecided(f, votes, missing, survives && !premiseUnsupported)
    const undecided = refuteUndecided || premiseUndecided || severityUndecided
    const confirmed = survives && !premiseUnsupported && !premiseUndecided && !severityUndecided
    const { undecidedByAbsence, couldHaveBlocked } = absenceOutcome(f, votes, missing, undecided)
    return { ...f, confirmed, premiseUnsupported, couldHaveBlocked, undecidedByAbsence, votes, severity: confirmed ? calibrate(f, votes, missing) : f.severity }
  })
  return {
    confirmed: judged.filter(v => v.confirmed),
    refuted: judged.filter(v => !v.confirmed && !v.premiseUnsupported && !v.undecidedByAbsence && v.votes.length > 0),
    suspected: judged.filter(v => v.undecidedByAbsence || v.votes.length === 0 || v.premiseUnsupported),
  }
}
// <<< craft-inline
/** @template {LensFinding} F @param {F[]} findings @param {Parameters<typeof judgeVotes>[1]} sink */
const judge = (findings, sink) => judgeVotes(findings, sink, SEV_RANK)

/** @type {unknown[][]} */
const votes = kept.map(() => [])
const verifyJobs = buildVerifyJobs(kept, votes)
log(`Verify plan: ${kept.length} findings -> ${verifyJobs.length} checks (${kept.filter(isEscalated).length} escalated to 3-lens panel), throttled to ${BATCH} concurrent`)
// `runThrottled` records the unjudged checks in `notRun` itself (advisory) — see the region above.
/** @param {unknown[]} unverified */
const warnUnverified = unverified => { if (unverified.length) log(`WARNING: ${unverified.length} checks got no verdict after retries`) }
warnUnverified(await runThrottled(verifyJobs, 'Verify', 'Verify'))

const judged = judge(kept, votes)
let { confirmed, refuted } = judged
// Wider than the judge's own output: coverage gaps left unverified at the budget floor join this list
// as they are, with no panel and none of the judge's per-finding flags.
/** @type {Array<(typeof judged.suspected)[number] | (LensFinding & { confirmed: false, votes: never[] })>} */
let suspected = judged.suspected
log(`Verify done: ${confirmed.length} confirmed, ${refuted.length} refuted, ${suspected.length} suspected (no verdict)`)
// A finding nobody decided must reach the VERDICT, not only the Suspected list. Suspected downgrades
// nothing — `baseVerdict` is computed from `confirmed` alone — so a run in which every escalated
// finding lost the one panel member that would have decided it prints a bare `Approve`, identical to
// a run whose panels all voted and cleared them. Blocking, and narrow: it needs an escalated
// (critical/high) finding whose absent vote was the deciding one, which is the exact case where the
// engine cannot say whether this run should have blocked.
// Gated on what the absent vote could have DECIDED, never on the finder's label. `isEscalated` reads
// the finder's severity and lens — the fields that shaped the panel — and both of its clauses leak
// here: a complexity finding is excluded by lens although the lens emits `high` and gets a single
// verifier, and a `medium` finding is excluded by severity although one verifier can calibrate it to
// `critical`. The judge computes the reachable tier instead.
/** @param {typeof judged} j */
function markUndecidedEscalated(j) {
  const undecidedEscalated = [...j.confirmed, ...j.refuted, ...j.suspected].filter(f => f.undecidedByAbsence && f.couldHaveBlocked)
  if (undecidedEscalated.length) {
    markNotRun('escalated-findings-undecided', `${undecidedEscalated.length} critical/high finding(s) lost the panel vote that would have decided them — this run cannot say whether it should have blocked`)
  }
}
markUndecidedEscalated(judged)

// ================= Coverage: critic, then verify its gaps through the same pipeline =================
/**
 * The completeness critic (retried once), and its gaps tagged as coverage findings; a critic that died
 * twice or answered without a findings array is not-run and yields no gaps.
 * @param {{ title: string, file: string, line: number }[]} confirmed @param {{ title: string, file: string, line: number }[]} refuted
 * @returns {Promise<LensFinding[]>}
 */
async function criticGaps(confirmed, refuted) {
  const CRITIC_PROMPT = `You are a completeness critic for an adversarial diff review (diff base: ${plan.baseRef || 'HEAD'}).
Ask: what is MISSING — a changed file no finding touched, a category of bug not checked, a dimension left uncovered?
Report each gap as a concrete located finding (file:line of the suspicious spot, severity, description, fix).
CONFIRMED findings (do not repeat them): ${JSON.stringify(confirmed.map(f => `${f.title} @ ${f.file}:${f.line}`))}
REFUTED claims (do NOT re-report these — they were adversarially disproven): ${JSON.stringify(refuted.map(f => `${f.title} @ ${f.file}:${f.line}`))}
Dead lenses this run (their dimension is UNCOVERED — look there first): ${JSON.stringify(deadLenses)}
If coverage is complete, return {"findings": []}.`
  let critic = /** @type {FindingsResult | null} */ (await agent(CRITIC_PROMPT, { label: 'coverage-critic', phase: 'Coverage', schema: FINDINGS, effort: 'high' }))
  if (!critic) {
    log('Coverage critic failed, retrying once')
    critic = /** @type {FindingsResult | null} */ (await agent(CRITIC_PROMPT, { label: 'coverage-critic-retry', phase: 'Coverage', schema: FINDINGS, effort: 'high' }))
  }
  if (!critic) {
    // Without this the critic's silence is indistinguishable from "coverage is complete": `?? []`
    // below yields zero gaps, and a diff whose blind spots were never looked for reads as covered.
    log('WARNING: coverage critic died twice — completeness was never checked')
    markNotRun('coverage-critic-dead', 'the coverage critic died twice — no completeness check ran, so blind spots in this review are unknown')
  }

  // A live critic whose `findings` is not an array checked nothing we can read — that is not-run under
  // its own label, never a silent "coverage is complete" and never a crash.
  if (critic && !Array.isArray(critic.findings)) {
    log('WARNING: coverage critic answered without a findings array — completeness was never checked')
    markNotRun('coverage-critic-malformed', 'the coverage critic answered without a findings array — no usable completeness check ran, so blind spots in this review are unknown')
  }
  // Critic findings do not bypass verification — they ride the same throttled pipeline.
  return (critic && Array.isArray(critic.findings) ? critic.findings : []).map(f => ({ ...f, lens: 'coverage', sources: ['coverage'] }))
}
phase('Coverage')
const gaps = await criticGaps(confirmed, refuted)

/**
 * Verifies the critic's gaps through the same pipeline, or — below the budget floor — reports them
 * as suspected; returns the confirmed and suspected lists with the gaps' outcome folded in.
 * @param {LensFinding[]} gaps @param {typeof confirmed} found @param {typeof suspected} doubtful
 */
async function withGapVerdicts(gaps, found, doubtful) {
  if (gaps.length && budgetAllows()) {
    log(`Coverage critic raised ${gaps.length} gap(s) -> verifying through the same pipeline`)
    /** @type {unknown[][]} */
    const gapVotes = gaps.map(() => [])
    // Opts out of the runner's advisory entry and marks its own BLOCKING one, for the reason the
    // budget-floor branch below spells out: a coverage gap is the critic's claim that something went
    // UNREVIEWED. Crossing the budget floor midway through this pass leaves exactly the same blind
    // spots unopened as failing to start it, so the two must land on the same side of the line —
    // otherwise the identical run reads `Approve` or `Approve (INCOMPLETE)` depending only on which
    // side of the first batch the floor happened to fall. Same label, so analyze-runs aggregates both.
    const unverifiedGapJobs = await runThrottled(buildVerifyJobs(gaps, gapVotes), 'Coverage-verify', 'Coverage', { reportUnjudged: false })
    if (unverifiedGapJobs.length) {
      log(`WARNING: ${unverifiedGapJobs.length} coverage-gap checks got no verdict`)
      markNotRun('coverage-gaps-unverified', `${unverifiedGapJobs.length} coverage-gap check(s) got no verdict — the blind spots they name went unopened`)
    }
    const g = judge(gaps, gapVotes)
    log(`Coverage gaps: +${g.confirmed.length} confirmed · +${g.suspected.length} suspected · ${g.refuted.length} refuted`)
    return { found: found.concat(g.confirmed), doubtful: doubtful.concat(g.suspected), refutedGaps: g.refuted.length }
  }
  if (gaps.length) {
    log(`Budget too low to verify ${gaps.length} coverage gap(s) -> reported as suspected`)
    // Blocking, unlike `verify-checks-unjudged`, and the difference is epistemic rather than a matter
    // of degree. An unjudged *finding* is a claim that something is wrong; reporting it as Suspected
    // is already the honest answer, and the review still looked. A coverage gap is the critic's claim
    // that something went UNREVIEWED — the same category as a dead lens, which downgrades. Leaving it
    // advisory would let a plain `Approve` stand on a run whose named blind spots nobody opened.
    // It does not fire on routine runs: it needs the budget floor reached AND gaps raised.
    markNotRun('coverage-gaps-unverified', `${gaps.length} coverage gap(s) were never verified (budget floor reached) — they are reported as Suspected, and the blind spots they name went unopened`)
    return { found, doubtful: doubtful.concat(gaps.map(f => ({ ...f, confirmed: false, votes: [] }))), refutedGaps: 0 }
  }
  return { found, doubtful, refutedGaps: 0 }
}
const gapped = await withGapVerdicts(gaps, confirmed, suspected)
confirmed = gapped.found
suspected = gapped.doubtful
const refutedGaps = gapped.refutedGaps

// ---- Prior decisions: the project's recorded rejections, handed in by the launching session ----
// The same rules as review (the module carries them): a matching finding below critical/high whose
// decision's scope is unchanged since the recorded commit leaves the verdict and is returned under
// `rejectedBefore`, marked in its description; anything else is raised again with the decision named.
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
// >>> craft-inline lib/ledger-deferral.mjs deferralOf
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
// <<< craft-inline
// >>> craft-inline lib/prior-decision-apply.mjs priorKindLabel matchesFindings recordsDeferral deferralMark priorDecisionMark commitMissingReason reraiseReason reraisedNote splitByDecisions applyPriorDecisions
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
// <<< craft-inline
const prior = await applyPriorDecisions(
  /** @type {Record<string, Array<(typeof confirmed)[number] | (typeof suspected)[number]>>} */ ({ confirmed, suspected }),
  priorDecisionsIn.decisions,
  toCheck => agent(scopeCheckPrompt(toCheck), { label: 'decision-scope', phase: 'Coverage', schema: SCOPE_CHECK_SCHEMA, effort: 'low' }),
  'description',
)
for (const n of prior.notes) log(`priorDecisions: ${n}`)
// A decision whose commit this repo does not know is named with the refusals, apart from a changed scope.
priorDecisionsIn.refused.push(...prior.refused)
confirmed = /** @type {typeof confirmed} */ (prior.tiers['confirmed'])
suspected = /** @type {typeof suspected} */ (prior.tiers['suspected'])
/**
 * One list of set-aside findings as a result field, absent when empty: `rejectedBefore` for those a
 * decision answers, `knownDeferred` for those an open (deferred) question answers.
 * @param {string} key @param {typeof prior.setAside} list
 */
function setAsideField(key, list) {
  return list.length ? { [key]: list.map(({ votes: _v, ...f }) => f) } : {}
}
/** What the returned object adds for prior decisions — nothing at all when none were given. */
function priorDecisionsResult() {
  return {
    ...setAsideField('rejectedBefore', prior.setAside.filter(f => f.priorKind !== 'question')),
    ...setAsideField('knownDeferred', prior.setAside.filter(f => f.priorKind === 'question')),
    ...priorRefusedResult(),
  }
}

// A verdict must never claim more coverage than the run had: a dimension that went unreviewed
// downgrades the verdict, so a run where the work died cannot read exactly like a clean one. The
// advisory entries (see `markNotRun`) are recorded and printed but do NOT downgrade — their
// findings are already reported as Suspected, and a marker that fires on routine runs stops being
// read on the runs that need it.
/** @param {{ severity: string }[]} found @returns {string} */
function verdictOf(found) {
  const baseVerdict = found.some(f => f.severity === 'critical' || f.severity === 'high') ? 'Block'
    : found.some(f => f.severity === 'medium') ? 'Warning' : 'Approve'
  return notRunBlocking().length ? `${baseVerdict} (INCOMPLETE)` : baseVerdict
}
const verdict = verdictOf(confirmed)
log(`Verdict: ${verdict} — ${confirmed.length} confirmed, ${suspected.length} suspected`)
for (const e of notRun) log(`${e.incomplete ? 'NOT RUN' : 'PARTIAL'}: ${e.note}`)

// ---- run record ----
const candidates = kept.length + gaps.length
const refutedTotal = refuted.length + refutedGaps
await logRun({
  ...recordHead(),
  verdict,
  findings: summarizeFindings([...confirmed, ...suspected].map(capSeverity)),
  scout: scoutRecord(plan.lenses),
  dimensions: plan.lenses.map((/** @type {string} */ l) => {
    const s = summarizeFindings(confirmed.filter(f => (f.sources || []).includes(l)).map(capSeverity))
    return { dimension: l, verdict: '', findingCount: s.total, bySeverity: s.bySeverity }
  }),
  verification: { candidates, confirmed: confirmed.length, refuteRate: refuteRate(refutedTotal, candidates) },
  notRun: notRunLabels(),
  outputTokens: budget.spent(),
})

return {
  verdict,
  confirmed: confirmed.map(({ votes: v, ...f }) => ({ ...f, votes: v.length, refutes: v.filter(x => x.refuted).length })),
  suspected: suspected.map(({ votes: v, ...f }) => f),
  notRun: notRunNotes().concat(telemetryNotes()),
  scout: { size: plan.sizeBucket, lenses: plan.lenses, deadLenses },
  // Only when given: an invocation without priorDecisions returns exactly what it always did.
  ...priorDecisionsResult(),
}
