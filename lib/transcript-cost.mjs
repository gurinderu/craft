// The REAL cost of a run, counted from its per-agent transcripts — the counting core enrich-cost
// (lib/craft-log-run.mjs) and its by-run-id form (lib/run-cost-slices.mjs) share, so both count by one
// rule (realm @nick/craft, nodes #98, #357).
import fs from 'node:fs'
import path from 'node:path'
import { COST_RULE, COST_RULE_PER_LINE } from './run-record.mjs'

/** @param {unknown} e */
function errText(e) {
  return String((e && /** @type {Error} */ (e).message) || e)
}

// The REAL cost of a run, summed after it finishes and folded into its record. A workflow's live
// sandbox can only ever record `outputTokens` = `budget.spent()` — the harness POOL — and that pool
// describes under 1% of real spend. The other ~99% is cache_read/cache_write, and it is written ONLY
// into the per-agent transcripts (`<run-dir>/agent-*.jsonl`) the runtime lays down outside the
// sandbox's reach, so no engine running inside the sandbox can ever record it. So this is a separate,
// post-hoc command the LAUNCHER runs — the launcher is the party that holds the runId, hence the run
// directory. It never runs as part of a review.
//
// `sumTranscriptUsage` is the pure, testable core: it takes a transcript's raw bytes (or an array of
// already-parsed lines) and sums the four token classes over the `type === 'assistant'` records'
// `.message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
// `cache_creation_input_tokens`). That record shape and those field names are an EXTERNAL SURFACE
// owned by the Claude Code runtime, not by craft — pinned in the realm (realm @nick/craft, node #98)
// with the runtime version they were observed against; read that node before assuming the shape.
// Tolerant by construction — a `.jsonl` transcript is a stream a run may have been killed mid-line,
// and non-assistant records (user turns, tool results) carry no usage — so a blank, malformed or
// usage-less line is skipped, never allowed to abort the sum.
// ONCE PER MESSAGE (realm @nick/craft, node #357): the runtime writes one model message as several
// assistant lines sharing `message.id`, each repeating its usage — summing lines overstated cost ~1.8x.
// Lines of one id are folded into the largest value each class carries (a later line can carry a
// larger output_tokens), then counted once. A line with no id has nothing to fold by: counted alone.
/** @param {string | any[] | null | undefined} input */
export function sumTranscriptUsage(input) {
  return countTranscriptUsage(input).total
}

// The sum, with the number of usage lines that carried no message id (`unkeyed`): each counted alone,
// so enrich-cost cannot claim the per-message rule for them (realm @nick/craft, nodes #98, #357).
/** @param {string | any[] | null | undefined} input */
function countTranscriptUsage(input) {
  const lines = Array.isArray(input) ? input : String(input ?? '').split('\n')
  const total = { output: 0, input: 0, cacheRead: 0, cacheWrite: 0 }
  /** @type {Map<unknown, typeof total>} */
  const byMessage = new Map()
  let unkeyed = 0
  for (const line of lines) {
    const rec = assistantUsage(line)
    if (!rec) continue
    const one = tokenClasses(rec.usage)
    if (rec.id == null) unkeyed++
    foldMessage(byMessage, rec.id ?? Symbol('no message id'), one)
  }
  for (const one of byMessage.values()) for (const k of TOKEN_CLASSES) total[k] += one[k]
  return { total, unkeyed }
}

const TOKEN_CLASSES = /** @type {const} */ (['output', 'input', 'cacheRead', 'cacheWrite'])

// Fold one line's counts into its message: the first line stands, a later one raises any class it exceeds.
/** @param {Map<unknown, Record<typeof TOKEN_CLASSES[number], number>>} byMessage @param {unknown} key @param {Record<typeof TOKEN_CLASSES[number], number>} one */
function foldMessage(byMessage, key, one) {
  const seen = byMessage.get(key)
  if (!seen) { byMessage.set(key, one); return }
  for (const k of TOKEN_CLASSES) seen[k] = Math.max(seen[k], one[k])
}

// The four token classes of one usage object, a missing or non-numeric field read as 0.
/** @param {any} u */
function tokenClasses(u) {
  return { output: Number(u.output_tokens) || 0, input: Number(u.input_tokens) || 0,
    cacheRead: Number(u.cache_read_input_tokens) || 0, cacheWrite: Number(u.cache_creation_input_tokens) || 0 }
}

// The usage object of one transcript line, with its message id, when it is an assistant record carrying
// one; null otherwise.
/** @param {unknown} line @returns {{ id: unknown, usage: any } | null} */
function assistantUsage(line) {
  /** @type {any} */
  let rec = line
  if (typeof line === 'string') {
    if (!line.trim()) return null
    try { rec = JSON.parse(line) } catch { return null }
  }
  if (!rec || typeof rec !== 'object' || rec.type !== 'assistant') return null
  const u = rec.message && rec.message.usage
  return u && typeof u === 'object' ? { id: rec.message.id, usage: u } : null
}


/** @param {string} runDir @returns {string[]} */
export function runTranscripts(runDir) {
  let names
  try {
    names = fs.readdirSync(runDir)
  } catch (e) {
    throw new Error(`run directory not readable: ${runDir} (${errText(e)})`)
  }
  return names.filter(n => /^agent-.*\.jsonl$/.test(n)).sort()
}

/**
 * @typedef {{ output: number, input: number, cacheRead: number, cacheWrite: number, total: number, agents: number, skipped?: number, source?: string, rule?: string,
 *   slice?: { index: number, of: number, tail?: number } }} RunCost
 */

/** @param {string} runDir @param {string[]} transcripts @param {string[]} warnings @returns {{ cost: RunCost, skipped: number, unkeyed: number }} */
function sumTranscripts(runDir, transcripts, warnings) {
  /** @type {RunCost} */
  const cost = { output: 0, input: 0, cacheRead: 0, cacheWrite: 0, total: 0, agents: 0 }
  let skipped = 0
  let unkeyed = 0
  for (const name of transcripts) {
    let u
    try {
      const counted = countTranscriptUsage(fs.readFileSync(path.join(runDir, name), 'utf8'))
      u = counted.total
      unkeyed += counted.unkeyed
    } catch (e) {
      // One unreadable entry must not discard every good transcript's cost. Skip it, warn, keep summing.
      skipped++
      warnings.push(`craft-log-run WARNING: skipped unreadable transcript ${name}: ${errText(e)}`)
      continue
    }
    cost.output += u.output
    cost.input += u.input
    cost.cacheRead += u.cacheRead
    cost.cacheWrite += u.cacheWrite
    cost.agents++
  }
  return { cost, skipped, unkeyed }
}

// The cost of `transcripts` (names under `runDir`), finished the one way every enrich-cost writes it:
// `total`, `skipped` when some could not be read, `source`, the counting `rule`, and the loud warnings.
// Throws when none of them could be read. `source` defaults to the run directory's name (its run id).
/** @param {string} runDir @param {string[]} transcripts @param {string[]} warnings @param {string} [source] @returns {RunCost} */
export function measureCost(runDir, transcripts, warnings, source = path.basename(path.resolve(runDir))) {
  const { cost, skipped, unkeyed } = sumTranscripts(runDir, transcripts, warnings)
  // Every matching transcript unreadable is the no-data case — a cost of all zeros here would read as a
  // real measurement of a free run, so throw instead, the same stance as no matching transcripts at all.
  if (!cost.agents) throw new Error(`no readable agent-*.jsonl transcripts under ${runDir} (${skipped} matched but unreadable)`)
  cost.total = cost.output + cost.input + cost.cacheRead + cost.cacheWrite
  if (skipped) cost.skipped = skipped   // legible on the record itself, not only on stderr
  // Where the cost came from, so a comparison can tell two records summed from the same transcripts
  // (or one record's transcripts credited to another) apart from two real runs (realm @nick/craft #97).
  cost.source = source
  // Tells this count from one summed per line, before #357 — or, when the harness wrote usage lines with
  // no message id (realm @nick/craft, node #98), says the count fell back to per line (#357).
  cost.rule = unkeyed ? COST_RULE_PER_LINE : COST_RULE
  if (unkeyed) warnings.push(`craft-log-run WARNING: ${unkeyed} usage line(s) without a message id, each counted alone — the cost may be overstated; marked rule "${COST_RULE_PER_LINE}" (realm @nick/craft, node #98)`)
  // Readability (the `!cost.agents` throw above) is not the same guard as zero-sum: transcripts can
  // parse fine yet carry no usage — an empty/truncated transcript, or the runtime renaming a usage
  // field (external surface, realm @nick/craft, node #98). A real run is never free, so an all-zeros
  // cost with agents summed is almost certainly a measurement failure. WARN loudly but still file it
  // (a trivial run is theoretically possible): recorded-and-flagged beats refused. Readers class it
  // 'empty' (costProblem in lib/run-record.mjs) and name it, never averaging it in as a near-free run.
  if (cost.agents > 0 && cost.total === 0) {
    warnings.push(`craft-log-run WARNING: ${cost.agents} transcript(s) summed to zero tokens — a real run is never free; likely the transcript usage schema drifted (realm @nick/craft, node #98)`)
  }
  return cost
}
