// craft's hooks' trace (realm @nick/craft, nodes #281, #283, #550): one JSON line per run in ~/.craft/hooks.jsonl — the
// event, whether it spoke, on what, or why it stayed silent — which the craft binary's hooks write, bounded by rotation
// to one older generation (cli/bin/craft/src/hook/role/entry.rs), and what lib/analyze-runs.mjs reads back from it.
import fs from 'node:fs'
import path from 'node:path'
import { parseJson } from './json-object.mjs'

/**
 * `event` is the hook event (a line without one is SessionStart's, written before the field); `session` the
 * harness's session id, `kind` the prompt class (cli/bin/craft/src/hook/role/kind.rs) and `agent` the subagent type, where the
 * event has them; `harness` which harness ran the hook (`claude-code` or `codex`, from the craft binary's hooks, or `opencode` from the OpenCode plugin's;
 * a line from before the field is derived from its event — hookHarness); `reason` what a line that spoke said when
 * it was not a request's text (the prompt hook's `re-review-nudge` and `language-reminder`), or, on every line of the
 * Agent-tool hook, `reviewer-dispatch` (cli/bin/craft/src/hook/role/dispatch.rs), so its rows stand apart from other PreToolUse lines;
 * on a SessionStart line under Codex that said only the readiness lines, `codex-readiness`; `readiness` names the
 * readiness lines a Codex start said (`sandbox`; once also `binary`; cli/bin/craft/src/hook/role/readiness.rs).
 * @typedef {{ ts: string, repo: string, source: string, spoke: boolean, found: string[], silent: string | null,
 *   event?: string, harness?: string, session?: string, kind?: string, agent?: string, reason?: string,
 *   readiness?: string[] }} HookEntry
 */

/** @param {string} home @returns {string} */
export function hookLogPath(home) {
  return path.join(home, '.craft', 'hooks.jsonl')
}

/** Both generations, oldest first; a line that does not parse is skipped. @param {string} file @returns {HookEntry[] | null} */
export function readHookLog(file) {
  /** @type {HookEntry[]} */
  const entries = []
  let any = false
  for (const f of [`${file}.1`, file]) {
    let text
    try {
      text = fs.readFileSync(f, 'utf8')
    } catch {
      continue
    }
    any = true
    for (const line of text.split('\n')) {
      try {
        /** @type {Partial<HookEntry> | null} */
        const e = parseJson(line)
        if (e && typeof e.repo === 'string' && typeof e.spoke === 'boolean') entries.push(/** @type {HookEntry} */ (e))
      } catch {
        /* a torn or blank line */
      }
    }
  }
  return any ? entries : null
}

/**
 * A timestamp in ms: ISO (the hook's) or a run record's `2026-10-01T15-14-29Z` (dashes in the time); NaN if neither.
 * @param {unknown} ts @returns {number}
 */
function millis(ts) {
  if (typeof ts !== 'string') return NaN
  return Date.parse(ts.replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3'))
}

/**
 * Per repo, when the start hook's role text first spoke there (ms); a line that said only something else (`reason`:
 * the Codex readiness lines) does not count. @param {HookEntry[]} entries @returns {Map<string, number>}
 */
function firstSpokeByRepo(entries) {
  /** @type {Map<string, number>} */
  const first = new Map()
  for (const e of entries) {
    if (hookEvent(e) !== 'SessionStart' || e.reason) continue
    const t = millis(e.ts)
    if (e.spoke && !Number.isNaN(t) && t < (first.get(e.repo) ?? Infinity)) first.set(e.repo, t)
  }
  return first
}

/** The silences by reason, most frequent first: `nothing-declared 2, off-env 1`. @param {HookEntry[]} entries */
function silentReasons(entries) {
  /** @type {Map<string, number>} */
  const reasons = new Map()
  for (const e of entries) if (!e.spoke) reasons.set(e.silent ?? 'unknown', (reasons.get(e.silent ?? 'unknown') ?? 0) + 1)
  return [...reasons]
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r} ${n}`)
    .join(', ')
}

/** The event a line belongs to; a line from before the field is SessionStart's. @param {HookEntry} e */
export function hookEvent(e) {
  return typeof e.event === 'string' && e.event !== '' ? e.event : 'SessionStart'
}

// The events only the OpenCode work hook writes (cli/bin/craft/src/hook/role/opencode.rs).
const OPENCODE_EVENTS = new Set(['chat.message', 'session.compacted'])

/**
 * The harness a line was written under; a line from before the field is OpenCode's by an OpenCode event, else
 * Claude Code's (Codex wrote the field from its first line).
 * @param {HookEntry} e @returns {string}
 */
function hookHarness(e) {
  if (typeof e.harness === 'string' && e.harness !== '') return e.harness
  return OPENCODE_EVENTS.has(hookEvent(e)) ? 'opencode' : 'claude-code'
}

/**
 * The hooks section of the run report: per event (and per harness, when more than one wrote the log), firings against
 * silences (by reason); a line that spoke with a `reason` (the nudge, the reminder) — no request's text — is its own row; how many workflow
 * runs in the store came from a repo after the start hook (SessionStart only) first spoke there (a run's ts at
 * or after that repo's first spoke line; a run without a readable ts is not counted).
 * @param {HookEntry[] | null} entries @param {Array<Record<string, unknown>>} records @returns {string[]}
 */
export function renderHookSection(entries, records) {
  const out = ['', '## craft hooks']
  if (entries === null) return [...out, 'No hook log (~/.craft/hooks.jsonl) — no craft hook has run here.']
  const several = new Set(entries.map(hookHarness)).size > 1
  /** @param {HookEntry} e */
  const group = e => `${hookEvent(e)}${e.reason ? ` ${e.reason}` : ''}${several ? ` (${hookHarness(e)})` : ''}`
  const start = (/** @type {string} */ g) => Number(g.startsWith('SessionStart'))
  const groups = [...new Set(entries.map(group))].sort((a, b) => start(b) - start(a) || a.localeCompare(b))
  for (const event of groups) {
    const mine = entries.filter(e => group(e) === event)
    const spoke = mine.filter(e => e.spoke).length
    const why = silentReasons(mine)
    out.push(`- ${event}: ${mine.length} run(s) — spoke ${spoke}, silent ${mine.length - spoke}${why ? ` (${why})` : ''}`)
  }
  const firstSpoke = firstSpokeByRepo(entries)
  const runs = records.filter(r => r['kind'] === 'workflow')
  const joined = runs.filter(r => {
    const since = typeof r['project'] === 'string' ? firstSpoke.get(r['project']) : undefined
    return since !== undefined && millis(r['ts']) >= since
  }).length
  out.push(`- review runs after the start hook (SessionStart) spoke in their repo: ${joined} of ${runs.length} (${firstSpoke.size} repo(s))`)
  return out
}
