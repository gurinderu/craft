// Where a Workflow run's per-agent transcripts live (realm @nick/craft, node #393): the harness writes
// them to `<claudeHome>/projects/<slug>/<session>/subagents/workflows/<runId>/`.
import fs from 'node:fs'
import path from 'node:path'

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
