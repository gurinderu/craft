// The run record a logger prompt carries, read back from that logger agent's own transcript on disk, so the
// model never re-emits it into a heredoc (realm @nick/craft, node #429). `craft-log-run <write|finalize|
// checkpoint> --from-transcript <nonce>` comes here instead of to stdin; anything short of one sure record is a
// TRANSCRIPT-MISS, and the prompt then falls back to the heredoc copy (lib/run-logging.mjs).
//
// The layout is the harness's, observed rather than documented (realm @nick/craft, node #428, Claude Code
// 2.1.309): a Workflow agent's transcript is `<claudeHome>/projects/<slug>/<session>/subagents/workflows/<runId>/
// agent-<id>.jsonl`, and its first `user` line — the file's second — holds the agent's whole prompt as
// `message.content` (a string, or an array of `{ text }`), on disk before the agent's first command runs.
import fs from 'node:fs'
import path from 'node:path'
import { workflowRunDirs } from './workflow-run-dir.mjs'
import { isPlausibleSessionId } from './journal-link.mjs'
import { NONCE_RE, recordNonce } from './record-nonce.mjs'

export { TRANSCRIPT_MISS } from './record-nonce.mjs'
// Distinct from 1 (FAILED) and 2 (usage): nothing was written, and the heredoc may still be tried.
export const TRANSCRIPT_MISS_EXIT = 3
// Without a session id, only the agent transcripts written to this recently are searched.
export const TRANSCRIPT_RECENT_MS = 30 * 60 * 1000

/** @typedef {{ command: string, phase?: string, retry?: boolean }} NonceCall */
/** @typedef {{ text: string } | { miss: string }} TranscriptRecord */

/** @param {string} dir @returns {string[]} */
function agentTranscripts(dir) {
  try {
    return fs.readdirSync(dir).filter(n => /^agent-.*\.jsonl$/.test(n)).map(n => path.join(dir, n))
  } catch {
    return []
  }
}

// The text of a message's content: a string as it is, an array's text blocks joined.
/** @param {unknown} content @returns {string} */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(b => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('')
}

// The agent's prompt: the content of the transcript's first `user` line ('' when there is none).
/** @param {string} text @returns {string} */
export function transcriptPrompt(text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    /** @type {any} */
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (rec && rec.type === 'user') return contentText(rec.message && rec.message.content)
  }
  return ''
}

// The prompts that carry `nonce`, one per distinct transcript file (a linked copy is the same file).
/** @param {string[]} files @param {string} nonce @returns {string[]} */
function promptsCarrying(files, nonce) {
  /** @type {Map<string, string>} */
  const found = new Map()
  for (const file of files) {
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    if (!text.includes(nonce)) continue
    const prompt = transcriptPrompt(text)
    if (!prompt.includes(nonce)) continue
    let real = file
    try { real = fs.realpathSync(file) } catch { /* read a moment ago: keep the path as found */ }
    found.set(real, prompt)
  }
  return [...found.values()]
}

/** @param {string} file @param {number} now @returns {boolean} */
function recent(file, now) {
  try { return now - fs.statSync(file).mtimeMs <= TRANSCRIPT_RECENT_MS } catch { return false }
}

// The record a prompt ends with: the JSON after its last `RECORD:` (or a checkpoint's `PAYLOAD:`) heading,
// up to the first line that is a lone `}` — the record is printed indented, so that line closes it, and
// anything the harness may append after the prompt is not read as part of it.
/** @param {string} prompt @returns {string} */
export function promptRecordText(prompt) {
  const at = Math.max(prompt.lastIndexOf('\nRECORD:\n'), prompt.lastIndexOf('\nPAYLOAD:\n'))
  if (at < 0) return ''
  const body = prompt.slice(prompt.indexOf(':\n', at) + 2)
  const end = body.search(/^\}$/m)
  return end < 0 ? body : body.slice(0, end + 1)
}

/**
 * The record of the one logger prompt carrying `nonce`: searched first among this session's Workflow agents,
 * then among every project's agent transcripts written in the last 30 minutes. Exactly one prompt must carry
 * the nonce, its record must parse to an object, and the nonce recomputed over that record for `call` must be
 * `nonce` — anything else is a miss with its reason.
 * @param {string} nonce
 * @param {{ claudeHome: string, sessionId?: string, call: NonceCall, now?: number }} o
 * @returns {TranscriptRecord}
 */
export function readRecordFromTranscript(nonce, { claudeHome, sessionId = '', call, now = Date.now() }) {
  if (!NONCE_RE.test(nonce)) return { miss: `not a record nonce: ${JSON.stringify(nonce)}` }
  const prompts = promptsFor(nonce, claudeHome, sessionId, now)
  if (prompts.length !== 1) return { miss: `${prompts.length} agent transcripts under ${path.join(claudeHome, 'projects')} carry ${nonce}` }
  return recordOf(/** @type {string} */ (prompts[0]), nonce, call)
}

// The prompts carrying `nonce`: this session's agents first, else every project's recent ones.
/** @param {string} nonce @param {string} claudeHome @param {string} sessionId @param {number} now @returns {string[]} */
function promptsFor(nonce, claudeHome, sessionId, now) {
  const inSession = isPlausibleSessionId(sessionId)
    ? promptsCarrying(workflowRunDirs(claudeHome, { session: sessionId }).flatMap(agentTranscripts), nonce)
    : []
  if (inSession.length) return inSession
  return promptsCarrying(workflowRunDirs(claudeHome).flatMap(agentTranscripts).filter(f => recent(f, now)), nonce)
}

// The record a prompt carries, when it parses to an object and is the one `nonce` names for `call`.
/** @param {string} prompt @param {string} nonce @param {NonceCall} call @returns {TranscriptRecord} */
function recordOf(prompt, nonce, call) {
  const text = promptRecordText(prompt)
  /** @type {unknown} */
  let record
  try { record = JSON.parse(text) } catch (e) { return { miss: `the record in the transcript does not parse: ${String(/** @type {Error} */ (e).message || e)}` } }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { miss: 'the record in the transcript is not a JSON object' }
  if (recordNonce(record, call) !== nonce) return { miss: `the record in the transcript is not the one ${nonce} names` }
  return { text }
}
