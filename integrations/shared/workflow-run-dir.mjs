// Where a Workflow run's per-agent transcripts live (realm @nick/craft, node #393; the binary's own walk for
// `craft runs enrich-cost` is cli/crates/craft-store/src/cost/run_dir.rs): the harness writes them to
// `<claudeHome>/projects/<slug>/<session>/subagents/workflows/<runId>/`.
import fs from 'node:fs'
import path from 'node:path'

/** @param {string} dir @returns {string[]} */
function entries(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

// Every Workflow run directory under `<claudeHome>/projects`: of one project slug and one session when they
// are given, of all of them otherwise. Entries that cannot be listed hold none. The one walk of this layout
// (realm @nick/craft, nodes #393, #428) — the stalled run's journal and the logger's own transcript
// (integrations/shared/journal-link.mjs, integrations/shared/transcript-record.mjs) are found through it.
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
