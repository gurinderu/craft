// The agents of one Workflow run, as enrich-cost --run-id slices them (realm @nick/craft, node #393): when
// each started, the engine it ran under, and the record its logger filed. Read off the harness's files —
// `agent-*.jsonl` transcripts and `agent-*.meta.json` (`description`, `workflowPhase`), Claude Code 2.1.x.
import fs from 'node:fs'
import path from 'node:path'

// The logger agent's label, as `logRunDispatch` in lib/run-logging.mjs names it: `log-run`, or
// `log-run (<n>KB)` for a large payload.
const LOG_RUN_LABEL = /^log-run(?: \(\d+KB\))?$/
// What craft-log-run prints for a filed record (`write`/`finalize`, or a proven retry).
const FILED_LINE = /^(?:wrote|already filed) (\/.+?\.json)(?: \(.*\))?$/gm
// The service agents that run a step of the craft binary for cli-review (lib/cli-review-steps.mjs): the binary files
// the run's record itself and its step's `filing` names the file (cli/crates/craft-review/src/filing.rs) — as
// `recordFile` when this step's own segment's work was filed, as `refiledFile` when it filed again a record of work
// done before (a finished run's, or a stopped part's). The start, the submits and a resume name their own segment's
// record; a status read and a re-file run in the same Workflow run right after its own submit was lost, so the record
// they name is this run's either way. A resume's `refiledFile` is a later run's re-file of an earlier run's record,
// and takes none of this run's cost (realm @nick/craft, nodes #393, #389).
const OWN_STEP = /^step:(?:start|resume|submit:\d+)$/
const RECOVERY_STEP = /^step:(?:status|refile)$/
// The record file a binary step's `filing` names, as the JSON string literal it prints: its own segment's, and a re-file's.
const OWN_KEY = /"recordFile":("(?:[^"\\]|\\.)*")/g
const ANY_KEY = /"(?:recordFile|refiledFile)":("(?:[^"\\]|\\.)*")/g
// The phase the harness gives every agent of a nested workflow: `▸ craft:review`, and `▸ craft:review #2`…
// for the further instances one run nests (rust-audit's per-crate reviews). Observed on 2026-10-29 across
// this machine's run directories; a registry without the plugin prefix shows `▸ <name>`.
const NESTED_PHASE = /^▸ (?:[\w.-]+:)?([\w.-]+?)(?: #\d+)?$/

/**
 * The last record file `text` says craft-log-run filed, '' when none.
 * @param {string} text @returns {string}
 */
export function filedIn(text) {
  let file = ''
  for (const m of text.matchAll(FILED_LINE)) file = /** @type {string} */ (m[1])
  return file
}

/**
 * The last record file a binary step's output names under `keys`, '' when none.
 * @param {RegExp} keys @returns {(text: string) => string}
 */
const namedIn = keys => text => {
  let file = ''
  for (const m of text.matchAll(keys)) {
    try {
      file = String(JSON.parse(String(m[1])))
    } catch {
      /* a cut literal names nothing */
    }
  }
  return file
}

/** @param {string} description @returns {boolean} */
export function isLogRunLabel(description) {
  return LOG_RUN_LABEL.test(description)
}

/**
 * The nested engine an agent's phase names: its instance (the phase itself) and the engine's name; both ''
 * for an agent of the top-level engine.
 * @param {unknown} phase @returns {{ instance: string, engine: string }}
 */
export function engineOfPhase(phase) {
  const m = NESTED_PHASE.exec(String(phase ?? ''))
  return m ? { instance: String(phase), engine: /** @type {string} */ (m[1]) } : { instance: '', engine: '' }
}

/** @param {string} file @returns {any} */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** @param {string} line @returns {any} */
function parseLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

// The text of a tool result's content: a string, or the text of its text blocks.
/** @param {unknown} content @returns {string} */
function resultText(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map(b => (b && typeof b.text === 'string' ? b.text : '')).join('\n') : ''
}

// The record file an agent's tool results name last, read by `read`, or ''.
/** @param {any[]} lines @param {(text: string) => string} read @returns {string} */
function filedRecord(lines, read) {
  let file = ''
  for (const rec of lines) {
    const content = rec?.type === 'user' && Array.isArray(rec.message?.content) ? rec.message.content : []
    for (const block of content) {
      if (block?.type === 'tool_result') file = read(resultText(block.content)) || file
    }
  }
  return file
}

/**
 * The record an agent filed: a log-run agent's by craft-log-run's line, a cli-review step's by the binary's `filing`.
 * @param {string} label @param {any[]} lines @returns {string}
 */
function recordOf(label, lines) {
  if (isLogRunLabel(label)) return filedRecord(lines, filedIn)
  if (OWN_STEP.test(label)) return filedRecord(lines, namedIn(OWN_KEY))
  return RECOVERY_STEP.test(label) ? filedRecord(lines, namedIn(ANY_KEY)) : ''
}

/**
 * @typedef {{ name: string, start: number, record: string, instance: string, engine: string }} RunAgent
 */

/**
 * One agent of the run: its transcript, when it started (its first timestamped line, else the file's
 * mtime), the nested engine it ran under, and the record it filed when it is a log-run agent that
 * reported one, or a cli-review step whose binary named the record it filed.
 * @param {string} runDir @param {string} name @returns {RunAgent}
 */
export function readAgent(runDir, name) {
  const file = path.join(runDir, name)
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    /* counted as skipped by measureCost */
  }
  const lines = text
    .split('\n')
    .filter(l => l.trim())
    .map(parseLine)
  const stamped = lines.map(r => Date.parse(r?.timestamp)).find(t => Number.isFinite(t))
  let start = stamped ?? 0
  if (stamped === undefined)
    try {
      start = fs.statSync(file).mtimeMs
    } catch {
      /* unordered: first */
    }
  const meta = readJson(path.join(runDir, name.replace(/\.jsonl$/, '.meta.json')))
  const record = recordOf(String(meta?.description ?? ''), lines)
  return { name, start, record, ...engineOfPhase(meta?.workflowPhase) }
}
