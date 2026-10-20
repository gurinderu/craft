// The SessionStart hook's trace (realm @nick/craft, node #281): one JSON line per run in ~/.craft/hooks.jsonl —
// whether it spoke, on what, or why it stayed silent — and what lib/analyze-runs.mjs reads back from it. Writing
// never fails the session (#276); the file is bounded by rotation to one older generation.
import fs from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 256 * 1024

/** @typedef {{ ts: string, repo: string, source: string, spoke: boolean, found: string[], silent: string | null }} HookEntry */

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
 * The hook section of the run report: firings against silences (by reason), and how many workflow runs in the
 * store came from a repo where the hook spoke at least once.
 * @param {HookEntry[] | null} entries @param {Array<Record<string, unknown>>} records @returns {string[]}
 */
export function renderHookSection(entries, records) {
  const out = ['', '## Start hook']
  if (entries === null) return [...out, 'No hook log (~/.craft/hooks.jsonl) — the SessionStart hook has not run here.']
  const spoke = entries.filter(e => e.spoke)
  /** @type {Map<string, number>} */
  const reasons = new Map()
  for (const e of entries) if (!e.spoke) reasons.set(e.silent ?? 'unknown', (reasons.get(e.silent ?? 'unknown') ?? 0) + 1)
  const why = [...reasons].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', ')
  out.push(`- runs: ${entries.length} — spoke ${spoke.length}, silent ${entries.length - spoke.length}${why ? ` (${why})` : ''}`)
  const spokeIn = new Set(spoke.map(e => e.repo))
  const runs = records.filter(r => r['kind'] === 'workflow')
  const joined = runs.filter(r => typeof r['project'] === 'string' && spokeIn.has(r['project'])).length
  out.push(`- review runs from repos where the hook spoke: ${joined} of ${runs.length} (${spokeIn.size} repo(s))`)
  return out
}
