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

// There USED to be a birthtime-based start-tolerance window here (`JOURNAL_START_TOLERANCE_MS`,
// 10 minutes) enforced on this project-slug path only. It was measured wrong: the gap between a
// run's start and its journal's birthtime, measured live, is min 11.8 / median 15.4 / max 298.7
// minutes — the MINIMUM alone exceeds a 10-minute window, so the filter rejected every real run that
// took this path, silently (the tests that exercised it planted a zero-gap fixture, which reality
// never produces — see journal-link.test.mjs). Widening it to cover the measured range is not a fix
// either: 298.7 minutes is most of `JOURNAL_ACTIVE_BOUND_MS` itself (360 minutes), so a window wide
// enough to admit real runs stops discriminating anything the active-bound check does not already
// discriminate. The birthtime filter is dropped entirely on this path now, matching the session-id
// path below, which never had one. What still guards against matching a NEIGHBOURING run's journal
// is candidate uniqueness plus `JOURNAL_ACTIVE_BOUND_MS`: two journals under the same project slug
// both active within the bound resolve to `ambiguous-journals`, never a guess — see the filter below.

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

// `sessionId` is never validated between the shell (`$CLAUDE_CODE_SESSION_ID`) and this function —
// it is threaded through checkpoints, `dirIdentity` and back out here to become a `path.join`
// segment. `path.join(projectsRoot, slug, sessionId, …)` normalises `..` silently, so a value
// containing `../` would escape `~/.claude/projects` entirely. A real harness session id is a UUID,
// but this guard is deliberately looser than "UUID-shaped": it accepts any single path segment built
// from letters, digits, `-` and `_` — no `.`, no `/`, no whitespace — which is enough to make
// traversal and multi-segment paths impossible while still accepting the readable session-id
// fixtures this repo's own tests use (e.g. `sess-abc`). Anything else is treated as ABSENT rather
// than as an error that aborts recovery — recovery degrades to the project-slug path (or to no
// ledger at all), the existing fail-open shape for "session id unusable", not a new failure mode.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export function isPlausibleSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id)
}

// The session-id path (`sessionId` known): search every project slug's directory for THIS session
// id directly, because the recorded `project` path proved unreliable — measured live, 27 of 49
// stalled runs executed inside a throwaway agent worktree while the harness recorded the session
// under the real repo's slug, so the two sides disagree on project path. The session id does not
// have that problem: it is the harness's own directory name, read from `$CLAUDE_CODE_SESSION_ID` at
// the moment the checkpoint was written, independent of which path the workflow believed it was in.
// The project slug is therefore a WILDCARD here on purpose, not a second identity check.
function findJournalFilesForSession(claudeHome, sessionId) {
  const out = []
  const projectsRoot = path.join(claudeHome, 'projects')
  if (!fs.existsSync(projectsRoot)) return out
  for (const slug of fs.readdirSync(projectsRoot)) {
    const wfRoot = path.join(projectsRoot, slug, sessionId, 'subagents', 'workflows')
    if (!fs.existsSync(wfRoot) || !fs.statSync(wfRoot).isDirectory()) continue
    for (const wf of fs.readdirSync(wfRoot)) {
      const j = path.join(wfRoot, wf, 'journal.jsonl')
      if (fs.existsSync(j)) out.push(j)
    }
  }
  return out
}

// `project` — the reviewed repo root (the same `repoKey` value checkpoints carry). `runStartMs` —
// the stalled run's own start time (its directory name's timestamp). `sessionId`, when known, takes
// a DIFFERENT and much narrower path (see findJournalFilesForSession above): the session id has
// already narrowed the candidate set to "workflow runs in THIS session", so no birthtime filter is
// needed there either. What both paths share is `JOURNAL_ACTIVE_BOUND_MS` as a plain sanity bound (a
// journal cannot belong to a run that had not yet started, nor still be "active" long after any real
// review finishes) — applied only when `runStartMs` is known; a session with exactly one workflow run
// needs no time check to be unambiguous at all. Returns `{found:false, reason}` on anything
// ambiguous; only a single candidate is ever returned.
export function findJournalForRun({ project, runStartMs, sessionId = '', claudeHome = path.join(os.homedir(), '.claude') } = {}) {
  // A non-UUID-shaped sessionId is treated as absent, not as a reason to abort recovery — see
  // isPlausibleSessionId above. Independent of fix #1 (identity spread order in craft-log-run.mjs):
  // this guards the value at the point it becomes a filesystem path, regardless of how it got here.
  if (sessionId && !isPlausibleSessionId(sessionId)) sessionId = ''
  if (sessionId) {
    const candidates = findJournalFilesForSession(claudeHome, sessionId)
      .map(file => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
      // Applied only when we have something to compare against — see the note above on why the
      // birthtime tolerance itself is not part of this path.
      .filter(c => !Number.isFinite(runStartMs) || (c.mtimeMs - runStartMs >= 0 && c.mtimeMs - runStartMs <= JOURNAL_ACTIVE_BOUND_MS))
    if (candidates.length === 0) return { found: false, reason: 'no-journal-found' }
    // Several workflow runs can live under one session — that is ordinary, not a defect in the
    // session-id path. Resolving to nothing here is the same discipline as the project-slug path:
    // never "pick the newest", never "pick the first".
    if (candidates.length > 1) return { found: false, reason: 'ambiguous-journals', count: candidates.length }
    return { found: true, dir: path.dirname(candidates[0].file), file: candidates[0].file }
  }
  if (!project || !Number.isFinite(runStartMs)) return { found: false, reason: 'no-identity' }
  const slug = slugifyProjectPath(path.resolve(project))
  const projectDir = path.join(claudeHome, 'projects', slug)
  const candidates = findJournalFiles(projectDir)
    .map(file => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    // No birthtime filter (see the header note above on why it was dropped). The active-bound check
    // is what now stands between this path and matching a neighbouring run's journal, together with
    // candidate uniqueness below: two journals both active within the bound is ambiguity, not a
    // guess.
    .filter(c => c.mtimeMs - runStartMs >= 0 && c.mtimeMs - runStartMs <= JOURNAL_ACTIVE_BOUND_MS)
  if (candidates.length === 0) return { found: false, reason: 'no-journal-found' }
  // Two candidates in the same window is exactly the ambiguity the header above warns about —
  // resolving to nothing is the safe default, never "pick the newest" or "pick the first".
  if (candidates.length > 1) return { found: false, reason: 'ambiguous-journals', count: candidates.length }
  return { found: true, dir: path.dirname(candidates[0].file), file: candidates[0].file }
}
