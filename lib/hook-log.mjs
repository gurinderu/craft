// craft's hooks' trace (realm @nick/craft, nodes #281, #283): one JSON line per run in ~/.craft/hooks.jsonl — the
// event, whether it spoke, on what, or why it stayed silent — and what lib/analyze-runs.mjs reads back from it. Writing
// never fails the session (#276); the file is bounded by rotation to one older generation.
import fs from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 256 * 1024

/**
 * `event` is the hook event (a line without one is SessionStart's, written before the field); `session` the
 * harness's session id, `kind` the prompt class (lib/work-hook-kind.mjs) and `agent` the subagent type, where the
 * event has them.
 * @typedef {{ ts: string, repo: string, source: string, spoke: boolean, found: string[], silent: string | null,
 *   event?: string, session?: string, kind?: string, agent?: string }} HookEntry
 */

/** @param {string} home @returns {string} */
export function hookLogPath(home) {
  return path.join(home, '.craft', 'hooks.jsonl')
}

/**
 * The repo's key as run records spell `project`: the main checkout's root, also from a linked worktree (whose
 * `.git` file names a gitdir with a `commondir`). Without that shape, the root's real path.
 * @param {string} root @returns {string}
 */
export function repoKey(root) {
  /** @param {string} p */
  const real = p => { try { return fs.realpathSync(p) } catch { return p } }
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(root, '.git'), 'utf8'))
    if (!m) return real(root)
    const gitdir = path.resolve(root, (m[1] ?? '').trim())
    const common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim())
    return path.basename(common) === '.git' ? real(path.dirname(common)) : real(root)
  } catch { return real(root) }
}

/**
 * Append one entry; past MAX_BYTES the file becomes `<file>.1` (replacing the older one) first. Every error is
 * swallowed: a lost line is better than a failed session.
 * @param {HookEntry} entry @param {string} file
 */
export function appendHookLog(entry, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`) } catch { /* no file yet */ }
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`)
  } catch { /* silence */ }
}

/** Both generations, oldest first; a line that does not parse is skipped. @param {string} file @returns {HookEntry[] | null} */
export function readHookLog(file) {
  /** @type {HookEntry[]} */
  const entries = []
  let any = false
  for (const f of [`${file}.1`, file]) {
    let text
    try { text = fs.readFileSync(f, 'utf8') } catch { continue }
    any = true
    for (const line of text.split('\n')) {
      try {
        const e = /** @type {HookEntry} */ (JSON.parse(line))
        if (e && typeof e.repo === 'string' && typeof e.spoke === 'boolean') entries.push(e)
      } catch { /* a torn or blank line */ }
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

/** Per repo, when the start hook first spoke there (ms). @param {HookEntry[]} entries @returns {Map<string, number>} */
function firstSpokeByRepo(entries) {
  /** @type {Map<string, number>} */
  const first = new Map()
  for (const e of entries) {
    if (hookEvent(e) !== 'SessionStart') continue
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
  return [...reasons].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', ')
}

/** The event a line belongs to; a line from before the field is SessionStart's. @param {HookEntry} e */
export function hookEvent(e) {
  return typeof e.event === 'string' && e.event !== '' ? e.event : 'SessionStart'
}

/**
 * The hooks section of the run report: per event, firings against silences (by reason), and how many workflow
 * runs in the store came from a repo after the start hook (SessionStart only) first spoke there (a run's ts at
 * or after that repo's first spoke line; a run without a readable ts is not counted).
 * @param {HookEntry[] | null} entries @param {Array<Record<string, unknown>>} records @returns {string[]}
 */
export function renderHookSection(entries, records) {
  const out = ['', '## craft hooks']
  if (entries === null) return [...out, 'No hook log (~/.craft/hooks.jsonl) — no craft hook has run here.']
  const events = [...new Set(entries.map(hookEvent))].sort((a, b) => Number(b === 'SessionStart') - Number(a === 'SessionStart') || a.localeCompare(b))
  for (const event of events) {
    const mine = entries.filter(e => hookEvent(e) === event)
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
