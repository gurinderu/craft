// enrich-cost by a Workflow run id: every record the run filed gets the cost of its own slice of the
// run's agents (realm @nick/craft, nodes #393, #115, #389). The engine sandbox cannot see its run id,
// so the launcher, which reads `wf_…` off the Workflow completion, runs this after the run has ended.
// A run that resumed files a second record; summing the whole directory into each, or enriching the
// first while the run still grew, gave a cost no field said was partial. Counting is transcript-cost's
// one rule (#98, #357) — this module only decides which transcripts belong to which record.
import fs from 'node:fs'
import path from 'node:path'
import { runTranscripts, measureCost } from './transcript-cost.mjs'

// The logger agent's label, as `logRunDispatch` in lib/run-logging.mjs names it: `log-run`, or
// `log-run (<n>KB)` for a large payload.
const LOG_RUN_LABEL = /^log-run(?: \(\d+KB\))?$/
// What craft-log-run prints for a filed record (`write`/`finalize`, or a proven retry).
const FILED_LINE = /^(?:wrote|already filed) (\/.+?\.json)(?: \(.*\))?$/gm

/** @param {string} description @returns {boolean} */
export function isLogRunLabel(description) {
  return LOG_RUN_LABEL.test(description)
}

/** @param {string} dir @returns {string[]} */
function entries(dir) {
  try { return fs.readdirSync(dir) } catch { return [] }
}

// The run's transcript directory: `<claudeHome>/projects/<slug>/<session>/subagents/workflows/<runId>`.
// A resumed session links the run's directory under its own session too, so one directory reached
// by two paths is one; of two real directories the one holding all the others' agents is the run;
// otherwise, or with none, the run is refused by name.
/** @param {string} runId @param {string} claudeHome @returns {string} */
export function findRunDir(runId, claudeHome) {
  if (!/^wf_[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`not a Workflow run id: ${runId}`)
  const projects = path.join(claudeHome, 'projects')
  /** @type {Set<string>} */
  const found = new Set()
  for (const slug of entries(projects)) {
    for (const session of entries(path.join(projects, slug))) {
      const dir = path.join(projects, slug, session, 'subagents', 'workflows', runId)
      try {
        const real = fs.realpathSync(dir)
        if (fs.statSync(real).isDirectory()) found.add(real)
      } catch { /* not this session's run */ }
    }
  }
  if (!found.size) throw new Error(`no transcript directory for run ${runId} under ${projects}`)
  const whole = holdingAll([...found])
  if (whole) return whole
  throw new Error(`run ${runId} has ${found.size} transcript directories and none holds the others' agents, refusing to pick one: ${[...found].join(', ')}`)
}

// The one directory holding every agent transcript the others hold, or ''. Observed on this machine
// (2026-10-29): a session that resumed a run had COPIED its directory (155 identical transcripts) and
// went on adding to the copy, so the copy is the whole run. Agent ids are random, so two different
// runs never share a transcript name.
/** @param {string[]} dirs @returns {string} */
function holdingAll(dirs) {
  const names = dirs.map(d => new Set(entries(d).filter(n => /^agent-.*\.jsonl$/.test(n))))
  const i = names.findIndex(mine => names.every(other => [...other].every(n => mine.has(n))))
  return i < 0 ? '' : /** @type {string} */ (dirs[i])
}

/** @param {string} file @returns {any} */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** @param {string} line @returns {any} */
function parseLine(line) {
  try { return JSON.parse(line) } catch { return null }
}

// The text of a tool result's content: a string, or the text of its text blocks.
/** @param {unknown} content @returns {string} */
function resultText(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map(b => (b && typeof b.text === 'string' ? b.text : '')).join('\n') : ''
}

// The record file a log-run agent's tool results name last, or ''.
/** @param {any[]} lines @returns {string} */
function filedRecord(lines) {
  let file = ''
  for (const rec of lines) {
    const content = rec?.type === 'user' && Array.isArray(rec.message?.content) ? rec.message.content : []
    for (const block of content) {
      if (block?.type !== 'tool_result') continue
      for (const m of resultText(block.content).matchAll(FILED_LINE)) file = /** @type {string} */ (m[1])
    }
  }
  return file
}

/**
 * One agent of the run: its transcript, when it started (its first timestamped line, else the file's
 * mtime), and the record it filed when it is a log-run agent that reported one.
 * @param {string} runDir @param {string} name
 * @returns {{ name: string, start: number, record: string }}
 */
function readAgent(runDir, name) {
  const file = path.join(runDir, name)
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { /* counted as skipped by measureCost */ }
  const lines = text.split('\n').filter(l => l.trim()).map(parseLine)
  const stamped = lines.map(r => Date.parse(r?.timestamp)).find(t => Number.isFinite(t))
  let start = stamped ?? 0
  if (stamped === undefined) try { start = fs.statSync(file).mtimeMs } catch { /* unordered: first */ }
  const meta = readJson(path.join(runDir, name.replace(/\.jsonl$/, '.meta.json')))
  const record = isLogRunLabel(String(meta?.description ?? '')) ? filedRecord(lines) : ''
  return { name, start, record }
}

/**
 * The run's records in filing order, each with the transcripts of its slice: the agents that started
 * after the previous record's log-run agent, up to and including its own. Agents that started after
 * the last log-run (a dead tail) go to the last record and are counted in its `tail`.
 * @param {{ name: string, start: number, record: string }[]} agents
 * @returns {{ record: string, transcripts: string[], tail: number }[]}
 */
export function sliceAgents(agents) {
  const ordered = [...agents].sort((a, b) => a.start - b.start || a.name.localeCompare(b.name))
  // A record filed twice (the engine's retry: `already filed`) ends its slice at the later filing.
  /** @type {Map<string, number>} */
  const boundary = new Map()
  for (const a of ordered) if (a.record) boundary.set(a.record, a.start)
  const bounds = [...boundary].sort((a, b) => a[1] - b[1])
  if (!bounds.length) throw new Error('no log-run agent of this run reported a filed record')
  const slices = bounds.map(([record]) => ({ record, transcripts: /** @type {string[]} */ ([]), tail: 0 }))
  const last = /** @type {(typeof slices)[number]} */ (slices[slices.length - 1])
  for (const a of ordered) {
    const i = bounds.findIndex(([, end]) => a.start <= end)
    const slice = i < 0 ? last : /** @type {(typeof slices)[number]} */ (slices[i])
    if (i < 0) slice.tail++
    slice.transcripts.push(a.name)
  }
  return slices
}

/**
 * Every record the run filed, each with its slice's cost. Measures and reads every record before any
 * write, so a refusal leaves all of them as they were.
 * @param {{ runId: string, claudeHome: string, warnings: string[],
 *   readRecord: (file: string) => Record<string, unknown>, writeRecord: (file: string, record: Record<string, unknown>) => void }} opts
 */
export function enrichRunCost({ runId, claudeHome, warnings, readRecord, writeRecord }) {
  const runDir = findRunDir(runId, claudeHome)
  const transcripts = runTranscripts(runDir)
  if (!transcripts.length) throw new Error(`no agent-*.jsonl transcripts under ${runDir}`)
  const slices = sliceAgents(transcripts.map(name => readAgent(runDir, name)))
  const costs = slices.map((s, i) => {
    const cost = measureCost(runDir, s.transcripts, warnings, runId)
    cost.slice = { index: i + 1, of: slices.length, ...(s.tail ? { tail: s.tail } : {}) }
    return { file: s.record, cost, record: readRecord(s.record) }
  })
  // Replaced, never appended: a re-run re-slices and re-sums.
  for (const { file, cost, record } of costs) writeRecord(file, { ...record, cost })
  return { runDir, costs }
}
