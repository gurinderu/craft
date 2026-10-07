// The review engines' own recall of the project's decisions (realm @nick/craft, node #203): every launch
// runs ONE read-only agent that invokes the craft:memory skill's recall for the
// diff's paths. It relies on a Workflow agent having the Skill tool and the session's MCP tools as
// deferred tools reachable through ToolSearch (realm @nick/craft, node #201), and on the observed path
// rule of the harness's project memory (realm @nick/craft, node #209: the slug rule the prompt states in
// its step 2 (c)). The prompt and every report line are shipped text: they carry no realm reference and
// no author path — those live in these comments only. What it returns goes through
// parsePriorDecisions unchanged; the report names where the decisions came from and how many were accepted.
// The same agent returns the active open questions for those paths in their own list (realm @nick/craft,
// node #204: a deferred finding is a question); they join the decisions, tagged with their kind, and
// the memory line counts them apart.
// A launcher's priorDecisions ADD to the recall, never replace it (realm @nick/craft, node #218): the
// passed records merge into the recalled ones by id, RAW, the recalled record kept on a clash (it is the
// store's current state); the merged list is read once, under one cap (PRIOR_DECISIONS_MAX) — the same
// in review, adversarial-review and the reviews rust-audit launches — each refusal naming its part, and
// the memory line names both parts. Only an engine that already recalled for this run skips the recall
// of the reviews it launches, by the internal `_recalled` argument, and says how its list splits by
// `_memoryParts`.
// Inlined into src/review.js, src/adversarial-review.js and src/rust-audit.js.

// The most changed paths one recall prompt lists; the rest are counted, and the count is reported.
export const RECALL_PATHS_MAX = 60

export const RECORD_TEXT_FIELDS = ['id', 'kind', 'title', 'body', 'scope', 'status', 'date', 'author', 'commit']

// The record shape of skills/memory/SKILL.md, verbatim.
export const MEMORY_RECALL_SCHEMA = {
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
export function memoryRecallPrompt(paths, base) {
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
export const recallText = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

/** The stale decisions the agent left out, as one line's tail. @param {unknown} list @returns {string} */
export function staleTail(list) {
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
export function recalledQuestions(list) {
  return (Array.isArray(list) ? list : []).map(q => (q && typeof q === 'object' && !Array.isArray(q) && !('kind' in q) ? { ...q, kind: 'question' } : q))
}

/**
 * What the recall agent returned, read: the decisions and questions to hand to parsePriorDecisions (a
 * list, possibly empty) and the source to report. A dead or off-shape answer applies nothing and is named.
 * @param {unknown} raw @param {number} cut paths past RECALL_PATHS_MAX @returns {{ decisions: unknown[], memory: MemorySource }}
 */
export function readMemoryRecall(raw, cut) {
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
export function initialMemory(passed, recalled = false, note = '') {
  if (recalled) return { source: 'launcher', count: passed, why: recallText(note) }
  /** @type {MemorySource} */
  const m = { source: 'none', count: 0, why: 'not recalled — the run ended before its recall step' }
  return passed ? { ...m, passed } : m
}

/**
 * The source at an exit that ends the run before its recall step: not yet recalled → why it never will be.
 * @param {MemorySource} m @param {string} why @returns {MemorySource}
 */
export function skippedMemory(m, why) {
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
export function mergeById(recalled, passed, readable = () => true) {
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
export function withPassed(m, passed, added) {
  return passed ? { ...m, passed, added } : m
}

/**
 * @template {{ id: string, kind?: string }} D
 * @typedef {(raw: unknown, labelOf?: (i: number) => string) => { decisions: D[], refused: string[] }} ParseDecisions
 */

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
export function parseMerged(list, recalledLen, parse, passedAt = []) {
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
export function mergeAndRead(recalled, passed, parse) {
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
export function mergeRecall(r, passedRaw, parse) {
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
export function memoryParts(parts, list) {
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
export function readLaunch(raw, recalled, note, partsArg, parse) {
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
export function acceptedMemory(m, accepted) {
  if (m.source === 'none') return m
  const questions = accepted.filter(d => d.kind === 'question').length
  /** @type {MemorySource} */
  const out = { source: m.source, count: accepted.length, why: m.why }
  return questions ? { ...out, questions } : out
}

/** `N decision(s) and M open question(s)` of a source. @param {MemorySource} m @returns {string} */
export function countedRecords(m) {
  const q = m.questions || 0
  return `${m.count - q} decision(s)${q ? ` and ${q} open question(s)` : ''}`
}

/**
 * The line of a review the launching audit recalled for: what it applied — split into the audit's
 * recall and its launcher's records when the audit said how (`_memoryParts`) — or why that recall found
 * none (and what the audit's own launcher passed). @param {MemorySource} m @returns {string}
 */
export function launcherLine(m) {
  const parts = m.passed ? ` — ${m.count - (m.added ?? 0)} recalled, ${m.added ?? 0} of the ${m.passed} passed by its launcher` : ''
  if (!m.why) return `memory: recalled by the launching audit — ${m.count ? `applied ${countedRecords(m)}${parts}` : `none${parts}`}`
  return `memory: recalled by the launching audit — none (${m.why})${m.count ? `; applied ${m.count} passed by its launcher` : ''}`
}

/**
 * One line, both parts: what the recall gave, then what the launcher added.
 * @param {MemorySource} m @param {boolean} [forwarded] the list went unparsed to nested reviews (rust-audit):
 * the count is what recall returned, not what was accepted @returns {string}
 */
export function memoryLine(m, forwarded = false) {
  if (m.source === 'launcher') return launcherLine(m)
  const plus = m.passed ? `; plus ${m.passed} passed by the launcher${m.source === 'recalled' ? ` (${m.added ?? m.passed} new)` : ''}` : ''
  if (m.source !== 'recalled') return `memory: none — ${m.why}${plus}`
  return forwarded
    ? `memory: returned ${countedRecords(m)} from ${m.why}${plus}; each nested review reports how many it applied`
    : `memory: recalled ${countedRecords(m)} from ${m.why}${plus}`
}

/** The report section naming the source. @param {MemorySource} m @param {boolean} [forwarded] @returns {string} */
export function memorySection(m, forwarded = false) {
  return `\n\n## Memory\n- ${memoryLine(m, forwarded)}\n`
}

/**
 * Runs the one recall agent through `ask` (the engine's agent call, schema MEMORY_RECALL_SCHEMA). A
 * refused dispatch (the budget wall) is named and applies nothing: the run meets the same wall on its
 * next dispatch, as it would have without a recall.
 * @param {(prompt: string) => Promise<unknown>} ask @param {string[]} paths @param {string} base
 * @returns {Promise<{ decisions: unknown[], memory: MemorySource }>}
 */
export async function recallDecisions(ask, paths, base) {
  let raw
  try {
    raw = await ask(memoryRecallPrompt(paths, base))
  } catch (e) {
    const msg = recallText(e instanceof Error ? e.message : String(e))
    return { decisions: [], memory: { source: 'none', count: 0, why: `the recall agent did not run (${msg}) — nothing recalled applied; findings are raised normally` } }
  }
  return readMemoryRecall(raw, Math.max(0, paths.length - RECALL_PATHS_MAX))
}
