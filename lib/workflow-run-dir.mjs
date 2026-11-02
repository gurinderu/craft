// Where a Workflow run's per-agent transcripts live (realm @nick/craft, node #393): the harness writes
// them to `<claudeHome>/projects/<slug>/<session>/subagents/workflows/<runId>/`.
import fs from 'node:fs'
import path from 'node:path'

/** @param {string} dir @returns {string[]} */
function entries(dir) {
  try { return fs.readdirSync(dir) } catch { return [] }
}

// Every Workflow run directory under `<claudeHome>/projects`: of one project slug and one session when they
// are given, of all of them otherwise. Entries that cannot be listed hold none. The one walk of this layout
// (realm @nick/craft, nodes #393, #428) — the run's directory, the stalled run's journal and the logger's own
// transcript (lib/journal-link.mjs, lib/transcript-record.mjs) are all found through it.
/** @param {string} claudeHome @param {{ slug?: string, session?: string }} [scope] @returns {string[]} */
export function workflowRunDirs(claudeHome, { slug, session } = {}) {
  const projects = path.join(claudeHome, 'projects')
  /** @type {string[]} */
  const out = []
  for (const s of slug === undefined ? entries(projects) : [slug]) {
    for (const sess of session === undefined ? entries(path.join(projects, s)) : [session]) {
      const workflows = path.join(projects, s, sess, 'subagents', 'workflows')
      for (const run of entries(workflows)) out.push(path.join(workflows, run))
    }
  }
  return out
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
  for (const dir of workflowRunDirs(claudeHome).filter(d => path.basename(d) === runId)) {
    try {
      const real = fs.realpathSync(dir)
      if (fs.statSync(real).isDirectory()) found.add(real)
    } catch { /* not this session's run */ }
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
