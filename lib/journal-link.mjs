// Links a stalled `.partial` run to the workflow transcript the harness already wrote for it, so a
// review that stalls mid-flight leaves a REAL ledger behind (not just `{total, bySeverity}`) for the
// next review to reuse.
//
// WHY THIS EXISTS. `recoverPartials` (craft-log-run.mjs) promotes a dead run's phase checkpoints into
// a `partial: true` record, but a checkpoint only ever carried counts. The full per-finding evidence
// — file, line, symbol, severity, tier, disposition, fingerprint — is not in the checkpoint at all;
// it is in `journal.jsonl`, the transcript the harness appends to as each lens/gate agent returns
// (see `findingsFromJournal` in craft-log-run.mjs). This module locates the journal that belongs to a
// given stalled run and rebuilds its findings into ledger-shaped entries.
//
// MATCHING IS DELIBERATELY CONSERVATIVE. A journal carries no per-entry timestamp and no repo
// identity of its own — only its filesystem location (under the project's slugified path) and its
// file times say anything about which run it belongs to. Picking the WRONG journal would seed the
// next review with another run's (possibly another repo's) findings, which is worse than finding
// none: `findJournalForRun` resolves to `{found:false}` on anything but a single, well-timed
// candidate, never to a guess.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A journal's `birthtimeMs` is set when the workflow's FIRST agent starts, which is at or shortly
// after the partial run's own directory was minted (the directory name's timestamp is the first
// checkpoint's `stamp()`). Ten minutes is generous slack for the gap between "workflow started" and
// "first phase checkpointed" without being wide enough to plausibly straddle two separate runs of
// the same repo (the shortest gap between two real runs observed in this store is well over an
// hour).
export const JOURNAL_START_TOLERANCE_MS = 10 * 60 * 1000

// A journal cannot still be growing hours after the run that owns it started — reuse the same bound
// `REJOIN_WINDOW_MS` uses in craft-log-run.mjs for "how long can one run plausibly run".
export const JOURNAL_ACTIVE_BOUND_MS = 6 * 60 * 60 * 1000

// The Claude Code harness slugifies a project's absolute path into its `~/.claude/projects/<slug>`
// directory name by replacing every non-alphanumeric character with `-` (verified against real
// session directories on this machine: `/a/b.c` → `-a-b-c`, a literal `.` and `/` both become `-`,
// existing `-` characters pass through unchanged since the replacement is idempotent on them).
export function slugifyProjectPath(p) {
  return String(p).replace(/[^A-Za-z0-9]/g, '-')
}

function findJournalFiles(projectDir) {
  const out = []
  if (!fs.existsSync(projectDir)) return out
  for (const session of fs.readdirSync(projectDir)) {
    const wfRoot = path.join(projectDir, session, 'subagents', 'workflows')
    if (!fs.existsSync(wfRoot) || !fs.statSync(wfRoot).isDirectory()) continue
    for (const wf of fs.readdirSync(wfRoot)) {
      const j = path.join(wfRoot, wf, 'journal.jsonl')
      if (fs.existsSync(j)) out.push(j)
    }
  }
  return out
}

// `project` — the reviewed repo root (the same `repoKey` value checkpoints carry). `runStartMs` —
// the stalled run's own start time (its directory name's timestamp). Returns `{found:false, reason}`
// on anything ambiguous; only a single candidate within the time window is ever returned.
export function findJournalForRun({ project, runStartMs, claudeHome = path.join(os.homedir(), '.claude') } = {}) {
  if (!project || !Number.isFinite(runStartMs)) return { found: false, reason: 'no-identity' }
  const slug = slugifyProjectPath(path.resolve(project))
  const projectDir = path.join(claudeHome, 'projects', slug)
  const candidates = findJournalFiles(projectDir)
    .map(file => {
      const st = fs.statSync(file)
      return { file, birthMs: st.birthtimeMs, mtimeMs: st.mtimeMs }
    })
    // A filesystem that cannot report birthtime (reported as 0 or epoch) gives us nothing reliable
    // to match on — treat it as absent rather than let a 1970 timestamp slip past the window check.
    .filter(c => Number.isFinite(c.birthMs) && c.birthMs > 0)
    .filter(c => Math.abs(c.birthMs - runStartMs) <= JOURNAL_START_TOLERANCE_MS)
    .filter(c => c.mtimeMs - runStartMs >= 0 && c.mtimeMs - runStartMs <= JOURNAL_ACTIVE_BOUND_MS)
  if (candidates.length === 0) return { found: false, reason: 'no-journal-found' }
  // Two candidates in the same window is exactly the ambiguity the header above warns about —
  // resolving to nothing is the safe default, never "pick the newest" or "pick the first".
  if (candidates.length > 1) return { found: false, reason: 'ambiguous-journals', count: candidates.length }
  return { found: true, dir: path.dirname(candidates[0].file), file: candidates[0].file }
}
