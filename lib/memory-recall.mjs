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
// A record without an id merges and reads under the id derived from its kind, title and scope (recordId;
// realm @nick/craft, node #222), and the memory line says once for how many records it was derived,
// naming the first few. A backend that keeps its own ids (an MCP server with its own write skill) is
// asked for kind, title and scope as stored and its own id in `links` as `store: <id>`; the ENGINE, not
// the agent, sets such a record's id to the skill's (withSkillId), so `answers:`/`supersedes:` links
// match (realm @nick/craft, node #215). A passed and a recalled record whose ids differ are still one
// when the ids derived from their kind, title and scope match (skillRecordId). Recall returns active
// records only, so a record the store withdrew or superseded comes back apart, in `inactive`, ids only:
// any passed record one of them names is held back and named once (realm @nick/craft, node #224) —
// unless the passed record is dated later than the inactive one and than every active recalled record
// that supersedes or answers it (realm @nick/craft, node #229); then that successor's link no longer drops it.
// Inlined into src/review.js, src/adversarial-review.js and src/rust-audit.js.
import { decisionText, derivedRecordId, hasControlChar, linkedIds, recordId, skillRecordId, supersededIds } from './prior-decision-record.mjs'

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
    inactive: {
      type: 'array', description: 'matching superseded or withdrawn records, named only — never applied; they hold back a passed copy not dated later',
      items: { type: 'object', properties: Object.fromEntries(['id', 'storeId', 'kind', 'title', 'scope', 'status', 'date'].map(k => [k, { type: 'string' }])) },
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
1. Invoke the craft:memory skill with the Skill tool and run its recall for those paths, no topic, status active only: once for kind decision, once for kind question. Then find the decision and question records for those paths whose status is superseded or withdrawn (the recall's history, or the backend's search filtered by status) — only to name them in inactive, never in decisions or questions.
2. If that skill is unavailable, follow its backend order yourself; the first that applies wins: (a) an explicit setting, env CRAFT_MEMORY, else a line \`craft-memory: <value>\` in AGENTS.md or CLAUDE.md at the repo root (mcp | harness | repo | none; a pinned backend that is unavailable means none); (b) a connected memory or knowledge-graph MCP server found by capability: load the deferred tools of the session with ToolSearch and take a server whose tools offer both a search over stored items and a create of a new item, judged by what the tools do, never by a server or tool name; use only its search; (c) the project memory files of the harness: Claude Code keeps them in \`~/.claude/projects/<slug>/memory/\` with \`MEMORY.md\` as the index, keyed by the repository's main checkout, never a worktree or subdirectory: root = \`dirname "$(git rev-parse --path-format=absolute --git-common-dir)"\`, \`pwd\` only outside a git repo; <slug> = root with every character that is not an ASCII letter or digit replaced by \`-\` (for example \`/home/alice/src/app\` → \`-home-alice-src-app\`) — an observed convention, not a documented one; \`~/.claude/projects/<slug>/memory\` must exist: read MEMORY.md, then only the matching files; else say \`none — harness memory directory <path>/memory not found\` and never guess a near match; (d) \`.craft/memory/decision/\` and \`.craft/memory/question/\` in the repo. None applies: backend none.
3. A record matches a path when its scope equals the path, is a directory containing it, names its component, or is \`.\`.
4. A stale matching decision — one that no longer holds against the code as it is now (its reason is gone): supersede nothing — leave it out of decisions and list it in stale as {id, why}; superseding stays with craft:addressing-findings.
Return {backend, why, decisions, questions, stale, inactive}: backend names the store used (or none); why is one line naming the rule that chose it, or why there is none, or that recall found nothing; decisions are the matching active decision records verbatim in the record shape id, kind, title, body, scope, status, date, author, commit, deferred, links (nothing rewritten or summarised; [] when none) — kind, title and scope always as stored; when the store keeps its own id for a record, add it to links as \`store: <id>\` (the review sets the record id from kind, title and scope itself); questions are the matching active question records in the same shape, verbatim ([] when none); stale is [] when none; inactive is the matching superseded or withdrawn records as {id, storeId, kind, title, scope, status, date} — storeId the store's own id when it keeps one, date the store's last-write date of that record as YYYY-MM-DD or full ISO ([] when none): the review holds back any record it is handed that is one of them, unless the handed record is dated later.`
}

/**
 * Where the decisions came from: `recalled` by this engine, `launcher` — recalled by the engine that
 * launched this one (`_recalled`), or `none`; `passed` counts the launcher's own records (accepted on
 * their own, or as forwarded by the launching audit), `added` those of them the recall did not already
 * hold (under `launcher`: those of them applied; the cap's refusals are named in their own section);
 * `derived` the applied records whose id was derived, their own having none, and `derivedNamed` the
 * first DERIVED_NAMED_MAX of them as `<id> (<title, cut>)`.
 * @typedef {{ source: 'recalled' | 'launcher' | 'none', count: number, why: string, questions?: number, passed?: number, added?: number, derived?: number, derivedNamed?: string[] }} MemorySource
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

// The memory skill's id: `<kind>-` and 10 hex chars.
export const SKILL_ID_FORM = /^(decision|question|lesson)-[0-9a-f]{10}$/

/**
 * A recalled record with the skill's id set by the engine: one that carries a `store: <id>` link, or an
 * id not of the skill's form (a store's own), gets skillRecordId — the store's id kept in links as
 * `store: <id>` — so `answers:`/`supersedes:` links match (realm @nick/craft, node #215). A record without
 * an id, or one whose kind, title or scope is missing, is left as it is. @param {unknown} x @returns {unknown}
 */
export function withSkillId(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return x
  const o = /** @type {Record<string, unknown>} */ (x)
  const links = Array.isArray(o['links']) ? o['links'] : []
  const stored = links.some(l => /^store:\s*\S/i.test(decisionText(l)))
  const sid = engineRecordId(o, stored)
  return sid ? { ...o, id: sid, links: stored ? links : [...links, `store: ${decisionText(o['id'])}`] } : x
}

/**
 * The id withSkillId sets: skillRecordId when the record's own id differs from it and is a store's (a
 * `store:` link beside it, or not of the skill's form); '' when the record keeps its own.
 * @param {Record<string, unknown>} o @param {boolean} stored @returns {string}
 */
export function engineRecordId(o, stored) {
  const [id, sid] = [decisionText(o['id']), skillRecordId(o)]
  return id && sid && sid !== id && (stored || !SKILL_ID_FORM.test(id)) ? sid : ''
}

/**
 * A record the store withdrew or superseded, as the recall named it: every id it is known by (its own,
 * the store's, the skill's from kind, title and scope), its status and its last-write date ('' when none).
 * @typedef {{ ids: string[], status: string, date: string }} InactiveRecord
 */
/** The recall's `inactive` list, read; an entry without any id is dropped. @param {unknown} list @returns {InactiveRecord[]} */
export function inactiveRecords(list) {
  return (Array.isArray(list) ? list : []).flatMap(x => {
    const o = /** @type {Record<string, unknown>} */ (x && typeof x === 'object' && !Array.isArray(x) ? x : {})
    const ids = [...new Set([decisionText(o['id']), decisionText(o['storeId']), skillRecordId(o)].filter(Boolean))]
    return ids.length ? [{ ids, status: recallText(o['status']) || 'inactive', date: recallText(o['date']) }] : []
  })
}

/**
 * What the recall agent returned, read: the decisions and questions to hand to parsePriorDecisions (a
 * list, possibly empty, each id set by withSkillId), the inactive records that hold back a passed copy,
 * and the source to report. A dead or off-shape answer applies nothing and is named.
 * @param {unknown} raw @param {number} cut paths past RECALL_PATHS_MAX
 * @returns {{ decisions: unknown[], memory: MemorySource, inactive: InactiveRecord[] }}
 */
export function readMemoryRecall(raw, cut) {
  const r = /** @type {Record<string, unknown>} */ (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})
  const tail = cut > 0 ? `; ${cut} changed path(s) past the bound of ${RECALL_PATHS_MAX} were not recalled for` : ''
  const list = r['decisions']
  const inactive = inactiveRecords(r['inactive'])
  if (!Array.isArray(list)) return { decisions: [], inactive, memory: { source: 'none', count: 0, why: `the recall agent died or returned no decision list, so nothing recalled was applied — findings are raised normally${tail}` } }
  const backend = recallText(r['backend']) || 'an unnamed backend'
  const why = recallText(r['why']) || 'no reason given'
  const stale = staleTail(r['stale'])
  const questions = recalledQuestions(r['questions'])
  const all = [...list, ...questions].map(withSkillId)
  if (!all.length) return { decisions: [], inactive, memory: { source: 'none', count: 0, why: `${why} (backend ${backend})${stale}${tail}` } }
  return { decisions: all, inactive, memory: { source: 'recalled', count: all.length, why: `${backend} (${why})${stale}${tail}`, ...(questions.length ? { questions: questions.length } : {}) } }
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
 * The recalled records with the launcher's appended, one per id: a passed record whose id a WELL-FORMED
 * recalled record already holds is dropped — the recalled one is the store's current state, a status
 * other than active included (it is then applied by neither copy). A malformed recalled record claims no
 * id, so the passed one stands and the reader refuses the recalled one by name (realm @nick/craft, node
 * #218). A record is held under its id and under the one derived from its kind, title and scope
 * (skillRecordId), so a recalled record with a store's own id and a passed copy without one are one;
 * a record with neither is kept, for the reader to refuse by name.
 * `addedAt` is each added record's index in the passed list.
 * @template T @param {T[]} recalled @param {T[]} passed @param {(x: T) => boolean} [readable]
 * @returns {{ merged: T[], addedAt: number[] }}
 */
export function mergeById(recalled, passed, readable = () => true) {
  const held = new Set(recalled.filter(x => readable(x)).flatMap(heldIds))
  const addedAt = passed.flatMap((x, i) => (heldIds(x).some(id => held.has(id)) ? [] : [i]))
  return { merged: [...recalled, ...addedAt.map(i => /** @type {T} */ (passed[i]))], addedAt }
}

/** A record's id, and the one derived from its kind, title and scope. @param {unknown} x @returns {string[]} */
export function heldIds(x) {
  const o = /** @type {Record<string, unknown>} */ (x && typeof x === 'object' && !Array.isArray(x) ? x : {})
  return [recordId(o), skillRecordId(o)].filter(Boolean)
}

// An ISO date: YYYY-MM-DD, or a full timestamp that starts with one; groups: year, month, day, hour,
// minute, seconds, zone.
export const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?(Z|[+-]\d{2}:\d{2})?)?$/

/** The days of month `m` (1-12) of year `y`. @param {number} y @param {number} m @returns {number} */
export function monthDays(y, m) {
  if (m === 2) return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28
  return [4, 6, 9, 11].includes(m) ? 30 : 31
}

/** The day `by` (-1, 0 or 1) days from y-m-d, as YYYY-MM-DD. @param {number} y @param {number} m @param {number} d @param {number} by @returns {string} */
export function shiftedDay(y, m, d, by) {
  let [yy, mm, dd] = [y, m, d + by]
  if (dd < 1) [yy, mm] = mm === 1 ? [yy - 1, 12] : [yy, mm - 1]
  if (dd < 1) dd = monthDays(yy, mm)
  if (dd > monthDays(yy, mm)) [yy, mm, dd] = mm === 12 ? [yy + 1, 1, 1] : [yy, mm + 1, 1]
  return `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
}

/** A zone's offset in minutes east of UTC (none or `Z`: 0); null when out of range. @param {string | undefined} z @returns {number | null} */
export function zoneMinutes(z) {
  if (!z || z === 'Z') return 0
  const [h, m] = [Number(z.slice(1, 3)), Number(z.slice(4, 6))]
  return h < 24 && m < 60 ? (z[0] === '-' ? -1 : 1) * (h * 60 + m) : null
}

/**
 * An ISO date read by hand (the engines' sandbox has no `Date`): its UTC day and, for a timestamp, its
 * seconds into that day (a timestamp without a zone is UTC); null when `v` is no ISO date or names a
 * day or time the calendar lacks (2026-02-30, 24:10).
 * @param {string} v @returns {{ day: string, at: number | null } | null}
 */
export function isoMoment(v) {
  const p = ISO_DATE.exec(v)
  if (!p) return null
  const [y, m, d] = [Number(p[1]), Number(p[2]), Number(p[3])]
  if (m < 1 || m > 12 || d < 1 || d > monthDays(y, m)) return null
  if (p[4] === undefined) return { day: v, at: null }
  const clock = utcSeconds(p)
  if (clock === null) return null
  const by = clock < 0 ? -1 : clock >= 86400 ? 1 : 0
  return { day: shiftedDay(y, m, d, by), at: clock - by * 86400 }
}

/**
 * A timestamp's time of day in UTC seconds from its own day's midnight (below 0 or past 86400 when the
 * zone moves it to another day); null when the time or the zone is out of range.
 * @param {RegExpExecArray} p ISO_DATE's match @returns {number | null}
 */
export function utcSeconds(p) {
  const [h, min, sec, off] = [Number(p[4]), Number(p[5]), Number(p[6] ?? 0), zoneMinutes(p[7])]
  return h > 23 || min > 59 || sec >= 60 || off === null ? null : (h * 60 + min - off) * 60 + sec
}

/**
 * Why passed date `p` does not override record `e` (an inactive copy, or an active successor); '' when
 * it is later (realm @nick/craft, node #229). Two timestamps compare to the instant; otherwise by the
 * UTC day, so a same-day pair is not later.
 * @param {string} p @param {{ status: string, date: string }} e @returns {string}
 */
export function notLaterWhy(p, e) {
  const [a, b] = [isoMoment(p), isoMoment(e.date)]
  if (!a) return 'the passed record carries no ISO date to set against it'
  if (!b) return `the ${e.status} record carries no ISO date to compare`
  const sameDayLater = a.day === b.day && a.at != null && b.at != null && a.at > b.at
  return a.day > b.day || sameDayLater ? '' : `the passed record's date ${p} is not later than the ${e.status} record's ${e.date}`
}

/**
 * An active recalled record whose `supersedes:`/`answers:` links name another: its id, date and the ids
 * it names — it opposes a passed copy of a record it names, as the store's inactive copy does.
 * @typedef {{ id: string, status: 'active', date: string, names: string[] }} Successor
 */
/** The successors among the recalled records `active` accepts. @param {unknown[]} recalled @param {(x: unknown) => boolean} active @returns {Successor[]} */
export function successorRecords(recalled, active) {
  return recalled.flatMap(x => {
    if (!active(x)) return []
    const o = /** @type {Record<string, unknown>} */ (x)
    const names = supersededIds(Array.isArray(o['links']) ? o['links'] : [])
    return names.length ? [{ id: recordId(o), status: /** @type {const} */ ('active'), date: decisionText(o['date']) || decisionText(o['when']), names }] : []
  })
}

/** Every id a passed record is known by: heldIds and its `store: <id>` links. @param {unknown} x @returns {string[]} */
export function passedAliases(x) {
  const o = /** @type {Record<string, unknown>} */ (x && typeof x === 'object' && !Array.isArray(x) ? x : {})
  return [...heldIds(o), ...linkedIds(Array.isArray(o['links']) ? o['links'] : [], /^store:\s*(\S+)$/i)]
}

/**
 * The passed records (those at `only`) an inactive record names (by any of its ids) or an active
 * recalled successor supersedes or answers, each named once (realm @nick/craft, node #224). One stands
 * only when dated later than EVERY record opposing it (node #229): the override is named, `… applied
 * over <what>: newer`, and its aliases go to `freed` — a successor's link to it no longer drops it.
 * Otherwise it is held back: `… not applied: held by <id> (active, <date>) (<why>)` when a successor is
 * not older, else `… not applied: <status> in memory (<why>)`.
 * @param {unknown[]} passed @param {InactiveRecord[]} inactive @param {number[]} [only] @param {Successor[]} [successors]
 * @returns {{ at: Set<number>, refused: string[], overrides: string[], freed: string[] }}
 */
export function blockedPassed(passed, inactive, only = passed.map((_, i) => i), successors = []) {
  /** @type {Set<number>} */
  const at = new Set()
  /** @type {{ refused: string[], overrides: string[], freed: string[] }} */
  const out = { refused: [], overrides: [], freed: [] }
  for (const i of only) {
    const ids = passedAliases(passed[i])
    const hits = inactive.filter(e => e.ids.some(id => ids.includes(id)))
    const over = successors.filter(s => s.names.some(id => ids.includes(id)))
    if (!hits.length && !over.length) continue
    const label = `passed decision #${i}${idTail(ids[0])}`
    const v = opposedVerdict(passed[i], hits, over)
    if (v.refused) {
      at.add(i)
      out.refused.push(`${label} not applied: ${v.refused}`)
      continue
    }
    out.overrides.push(`${label} applied over ${v.over}: newer`)
    if (over.length) out.freed.push(...ids)
  }
  return { at, ...out }
}

/** ` (<id>)` for a label; '' for no id or one with a control character. @param {string | undefined} id @returns {string} */
export function idTail(id) {
  return id && !hasControlChar(id) ? ` (${id})` : ''
}

/**
 * One passed record against the records opposing it: why it is held back (a successor not older first,
 * then an inactive copy), or, when it is later than all of them, what it is applied over.
 * @param {unknown} x @param {InactiveRecord[]} hits @param {Successor[]} over @returns {{ refused?: string, over?: string }}
 */
export function opposedVerdict(x, hits, over) {
  const o = /** @type {Record<string, unknown>} */ (x)
  const date = decisionText(o['when']) || decisionText(o['date'])
  const held = over.map(s => ({ s, why: notLaterWhy(date, s) })).find(h => h.why)
  if (held) return { refused: `held by ${held.s.id} (active, ${held.s.date || 'undated'}) (${held.why})` }
  const stop = hits.map(e => ({ e, why: notLaterWhy(date, e) })).find(h => h.why)
  if (stop) return { refused: `${stop.e.status} in memory (${stop.why})` }
  const last = hits.length ? [hits.reduce((m, e) => (notLaterWhy(e.date, m) ? m : e))].map(e => `a ${e.status} record of ${e.date}`) : []
  return { over: [...last, ...over.map(s => `${s.id} (active, ${s.date})`)].join(' and ') }
}

/** The record without its `supersedes:`/`answers:` links to any of `freed`; itself when it has none. @param {unknown} x @param {Set<string>} freed @returns {unknown} */
export function withoutLinksTo(x, freed) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return x
  const o = /** @type {Record<string, unknown>} */ (x)
  if (!Array.isArray(o['links'])) return x
  const links = o['links'].filter(l => !supersededIds([l]).some(id => freed.has(id)))
  return links.length === o['links'].length ? x : { ...o, links }
}

/**
 * The source with the launcher's part: nothing when it passed no record.
 * @param {MemorySource} m @param {number} passed @param {number} added @returns {MemorySource}
 */
export function withPassed(m, passed, added) {
  return passed ? { ...m, passed, added } : m
}

// How many derived ids the memory line names, and how much of each title it shows.
export const DERIVED_NAMED_MAX = 3
export const DERIVED_TITLE_MAX = 40

/**
 * The source with how many of the applied records had their id derived, the first few named; unchanged when none.
 * @param {MemorySource} m @param {Array<{ id?: string, title?: string, derived?: boolean }>} applied @returns {MemorySource}
 */
export function withDerived(m, applied) {
  const derived = applied.filter(d => d.derived)
  /** @param {string} t */
  const cut = t => (t.length > DERIVED_TITLE_MAX ? `${t.slice(0, DERIVED_TITLE_MAX)}…` : t)
  const derivedNamed = derived.slice(0, DERIVED_NAMED_MAX).map(d => `${d.id ?? ''} (${cut(d.title ?? '')})`)
  return derived.length ? { ...m, derived: derived.length, derivedNamed } : m
}

/** The derived ids' tail of the memory line; '' when none was derived. @param {MemorySource} m @returns {string} */
export function derivedTail(m) {
  if (!m.derived) return ''
  const named = m.derivedNamed ?? []
  const more = m.derived - named.length
  return `; id derived for ${m.derived} record(s)${named.length ? `: ${named.join(', ')}` : ''}${more > 0 && named.length ? ` and ${more} more` : ''}`
}

/**
 * The list with the id derived for each record that carries none (derivedRecordId), so the reviews it is
 * forwarded to receive records with their id; anything else unchanged. @param {unknown} list @returns {unknown}
 */
export function withDerivedIds(list) {
  if (!Array.isArray(list)) return list
  return list.map(x => {
    const id = x && typeof x === 'object' && !Array.isArray(x) ? derivedRecordId(/** @type {Record<string, unknown>} */ (x)) : ''
    return id ? { .../** @type {object} */ (x), id } : x
  })
}

/**
 * @template {{ id: string, kind?: string, derived?: boolean }} D
 * @typedef {(raw: unknown, labelOf?: (i: number) => string) => { decisions: D[], refused: string[] }} ParseDecisions
 */

/**
 * A merged list (its first `recalledLen` records the recall's, the rest the launcher's) read ONCE by
 * `parse`, so one cap holds across both parts; each refusal names its part (`passedAt` maps a passed
 * record back to its index in the launcher's list). The applied records split by part: a recalled id is
 * one a readable recalled record holds, and `passed` counts the applied rest — the launcher's records
 * new to this run, after the cap (realm @nick/craft, node #218).
 * @template {{ id: string, kind?: string, derived?: boolean }} D
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
 * The recall's records merged with the launcher's list (mergeById, a recalled record `parse` reads
 * whatever its status kept on an id clash) and read once (parseMerged); `parts` is how the merged list splits —
 * what a launching audit forwards as `_memoryParts`, so it adds up to the list. A passed record an
 * `inactive` record names, or an active recalled successor supersedes or answers, is left out of the
 * merge and named in `blocked`, or, dated later than all of them, kept and named in `overrides`, the
 * successors' links to it dropped from the merged list (blockedPassed) — checked only once the recall's own records did not already
 * hold it: a copy of a record the recall returned is the same decision, dropped silently.
 * @template {{ id: string, kind?: string, derived?: boolean }} D
 * @param {unknown[]} recalled @param {unknown[]} passed @param {ParseDecisions<D>} parse @param {InactiveRecord[]} [inactive]
 * @returns {{ merged: unknown[], parts: { recalled: number, passed: number }, read: { prior: { decisions: D[], refused: string[] }, recalled: D[], passed: number }, blocked: string[], overrides: string[] }}
 */
export function mergeAndRead(recalled, passed, parse, inactive = []) {
  // Status aside: a well-formed record that is not active still holds its id (realm @nick/craft, node #218).
  /** @param {unknown} x */
  const wellFormed = x => parse([x && typeof x === 'object' && !Array.isArray(x) ? { ...x, status: null } : x]).decisions.length > 0
  const fresh = mergeById(recalled, passed, wellFormed).addedAt
  const block = blockedPassed(passed, inactive, fresh, successorRecords(recalled, x => parse([x]).decisions.length > 0))
  const addedAt = fresh.filter(i => !block.at.has(i))
  // A successor's link to a passed copy newer than it no longer drops that copy (realm @nick/craft, node #229).
  const freed = new Set(block.freed)
  const merged = [...(freed.size ? recalled.map(x => withoutLinksTo(x, freed)) : recalled), ...addedAt.map(i => passed[i])]
  return { merged, parts: { recalled: recalled.length, passed: addedAt.length }, read: parseMerged(merged, recalled.length, parse, addedAt), blocked: block.refused, overrides: block.overrides }
}

/**
 * The recall's answer merged RAW with the launcher's `priorDecisions` (mergeAndRead), read once by
 * `parse` (parsePriorDecisions) under its one cap: the decisions to apply, every refusal (a launcher's
 * argument that is no list still named), the refusals not already logged at launch (the recall's and
 * the cap's, and the passed records an inactive one holds back), and the source — its new count the
 * launcher's records applied that the recall did not hold, its why naming each newer passed record
 * applied over an inactive one.
 * @template {{ id: string, kind?: string, derived?: boolean }} D
 * @param {{ decisions: unknown[], memory: MemorySource, inactive?: InactiveRecord[] }} r @param {unknown} passedRaw @param {ParseDecisions<D>} parse
 * @returns {{ prior: { decisions: D[], refused: string[] }, recalledRefused: string[], memory: MemorySource }}
 */
export function mergeRecall(r, passedRaw, parse) {
  const alone = parse(passedRaw)
  const { read: m, blocked, overrides } = mergeAndRead(r.decisions, Array.isArray(passedRaw) ? /** @type {unknown[]} */ (passedRaw) : [], parse, r.inactive)
  const memory = withDerived(withPassed(acceptedMemory(r.memory, m.recalled), alone.decisions.length, m.passed), m.prior.decisions)
  return {
    prior: { decisions: m.prior.decisions, refused: [...(Array.isArray(passedRaw) ? [] : alone.refused), ...m.prior.refused, ...blocked] },
    recalledRefused: [...m.prior.refused.filter(x => !x.startsWith('passed decision #')), ...blocked],
    memory: overrides.length ? { ...memory, why: `${memory.why}; ${overrides.join('; ')}` } : memory,
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
 * @template {{ id: string, kind?: string, derived?: boolean }} D
 * @param {unknown} raw @param {boolean} recalled `_recalled` @param {unknown} note `_memory` @param {unknown} partsArg `_memoryParts`
 * @param {ParseDecisions<D>} parse @returns {{ prior: { decisions: D[], refused: string[] }, memory: MemorySource }}
 */
export function readLaunch(raw, recalled, note, partsArg, parse) {
  const parts = recalled ? memoryParts(partsArg, raw) : null
  if (!parts) {
    const prior = parse(raw)
    return { prior, memory: withDerived(acceptedMemory(initialMemory(prior.decisions.length, recalled, note), prior.decisions), prior.decisions) }
  }
  const m = parseMerged(/** @type {unknown[]} */ (raw), parts.recalled, parse)
  return { prior: m.prior, memory: withDerived(withPassed(acceptedMemory(initialMemory(0, true, note), m.prior.decisions), parts.passed, m.passed), m.prior.decisions) }
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
  return `${sourceLine(m, forwarded)}${derivedTail(m)}`
}

/** memoryLine without the derived ids' tail. @param {MemorySource} m @param {boolean} forwarded @returns {string} */
export function sourceLine(m, forwarded) {
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
 * @returns {Promise<{ decisions: unknown[], memory: MemorySource, inactive: InactiveRecord[] }>}
 */
export async function recallDecisions(ask, paths, base) {
  let raw
  try {
    raw = await ask(memoryRecallPrompt(paths, base))
  } catch (e) {
    const msg = recallText(e instanceof Error ? e.message : String(e))
    return { decisions: [], inactive: [], memory: { source: 'none', count: 0, why: `the recall agent did not run (${msg}) — nothing recalled applied; findings are raised normally` } }
  }
  return readMemoryRecall(raw, Math.max(0, paths.length - RECALL_PATHS_MAX))
}
