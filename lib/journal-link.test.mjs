// journal-link.mjs locates the workflow transcript (journal.jsonl) belonging to a stalled run, so
// its findings can seed a recovered record's ledger. Matching is deliberately conservative — the
// wrong journal would seed the next review with another repo's findings — so these tests pin the
// safety properties (ambiguity resolves to nothing, the time window is enforced both directions, a
// unique-in-window candidate is matched only on a positive branch tie, never on uniqueness alone) and
// not just the happy path.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { slugifyProjectPath, findJournalForRun, JOURNAL_ACTIVE_BOUND_MS, isPlausibleSessionId } from './journal-link.mjs'

function tmpDir(prefix = 'craft-journal-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// Builds `<claudeHome>/projects/<slug>/<session>/subagents/workflows/<wf>/journal.jsonl` with the
// given birth/mtime, mirroring the layout findJournalForRun reads. When `branch` is given, a
// `base`-shaped result line (the same shape `classifyResult` in craft-log-run.mjs recognizes:
// `Array.isArray(files) && baseRef`) is appended carrying it — that is the field `findJournalForRun`
// now requires to agree with the caller's own `branch` before it will match a unique-in-window
// candidate. Omitting `branch` plants a journal with no recoverable branch at all, for the tests that
// exercise that refusal.
function plantJournal(claudeHome, project, { birthMs, mtimeMs = birthMs, session = 's1', wf = 'wf1', branch = '' } = {}) {
  const slug = slugifyProjectPath(path.resolve(project))
  const dir = path.join(claudeHome, 'projects', slug, session, 'subagents', 'workflows', wf)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'journal.jsonl')
  const lines = ['{"type":"started","agentId":"a1"}']
  if (branch) {
    lines.push(JSON.stringify({
      type: 'result',
      result: { baseRef: 'origin/main', branch, head: 'deadbeef', files: ['a.txt'] },
    }))
  }
  fs.writeFileSync(file, lines.join('\n') + '\n')
  const atime = new Date(birthMs)
  fs.utimesSync(file, atime, new Date(mtimeMs))
  // utimesSync cannot set birthtime on most platforms; the harness reads real filesystem birthtime,
  // so these tests use the real fs.statSync(file).birthtimeMs it was actually created with and only
  // vary runStartMs / the window bounds around that, rather than trying to forge birthtime.
  return file
}

test('slugifyProjectPath replaces every non-alphanumeric character, so a dot doubles up with the adjoining slash', () => {
  assert.equal(slugifyProjectPath('/Users/x/projects/my/craft'), '-Users-x-projects-my-craft')
  // The case the header calls out by name: a `.` next to a `/` produces a DOUBLE dash, not a single
  // one — a slugifier that collapsed runs of separators would silently mismatch this directory.
  assert.equal(slugifyProjectPath('/Users/x/.claude/worktrees/agent-1'), '-Users-x--claude-worktrees-agent-1')
  assert.equal(slugifyProjectPath('/a/b.c'), '-a-b-c')
})

test('a single matching journal in the window, with an agreeing branch, is found', () => {
  const claudeHome = tmpDir()
  const project = tmpDir('craft-proj-')
  const file = plantJournal(claudeHome, project, { birthMs: Date.now(), branch: 'feat/x' })
  const runStartMs = fs.statSync(file).birthtimeMs
  const hit = findJournalForRun({ project, runStartMs, branch: 'feat/x', claudeHome })
  assert.equal(hit.found, true)
  assert.equal(hit.file, file)
  assert.equal(hit.dir, path.dirname(file))
})

test('two candidate journals in the same window resolve to nothing, not to a guess', () => {
  const claudeHome = tmpDir()
  const project = tmpDir('craft-proj-')
  const f1 = plantJournal(claudeHome, project, { birthMs: Date.now(), session: 's1', wf: 'wf1', branch: 'feat/x' })
  const runStartMs = fs.statSync(f1).birthtimeMs
  // A second journal born within the same tolerance window — real ambiguity.
  plantJournal(claudeHome, project, { birthMs: runStartMs, session: 's2', wf: 'wf2', branch: 'feat/x' })
  const hit = findJournalForRun({ project, runStartMs, branch: 'feat/x', claudeHome })
  assert.deepEqual(hit, { found: false, reason: 'ambiguous-journals', count: 2 })
})

// The blocking property: uniqueness within the window is exactly what a NEIGHBOURING run's journal
// satisfies when the stalled run's OWN journal is missing (the measured common case for this path —
// see the header in journal-link.mjs). Planting only the wrong-branch neighbour and no true match
// proves the fallback no longer matches on the absence of rivals alone.
test('a unique, well-timed journal for a DIFFERENT branch is refused, not matched on uniqueness alone', () => {
  const claudeHome = tmpDir()
  const project = tmpDir('craft-proj-')
  const file = plantJournal(claudeHome, project, { birthMs: Date.now(), branch: 'someone-elses-branch' })
  const runStartMs = fs.statSync(file).birthtimeMs
  const hit = findJournalForRun({ project, runStartMs, branch: 'my-branch', claudeHome })
  assert.equal(hit.found, false)
  assert.equal(hit.reason, 'branch-mismatch')
})

// The other half of the same property: when the CALLING side has no branch to tie against (an older
// checkpoint predating the `branch` field, or one where it never resolved), there is nothing to prove
// a match with, so a unique-in-window candidate must still be refused rather than accepted on
// uniqueness alone.
test('no branch known on the calling side refuses a unique-in-window candidate rather than matching it', () => {
  const claudeHome = tmpDir()
  const project = tmpDir('craft-proj-')
  const file = plantJournal(claudeHome, project, { birthMs: Date.now(), branch: 'feat/x' })
  const runStartMs = fs.statSync(file).birthtimeMs
  const hit = findJournalForRun({ project, runStartMs, claudeHome }) // no `branch` passed
  assert.equal(hit.found, false)
  assert.equal(hit.reason, 'no-branch-known')
})

// A journal with no recoverable `base` entry at all (e.g. the run died before the base phase ever
// wrote a result) has no branch to tie against either, so it is refused the same way.
test('a candidate journal with no base entry (no branch to read) is refused even with a known caller branch', () => {
  const claudeHome = tmpDir()
  const project = tmpDir('craft-proj-')
  const file = plantJournal(claudeHome, project, { birthMs: Date.now() }) // no branch written into the journal
  const runStartMs = fs.statSync(file).birthtimeMs
  const hit = findJournalForRun({ project, runStartMs, branch: 'feat/x', claudeHome })
  assert.equal(hit.found, false)
  assert.equal(hit.reason, 'branch-mismatch')
})

// The property that broke: the project-slug path used to enforce a 10-minute birthtime tolerance
// against runStartMs, but the gap this path actually sees in reality is min 11.8 / median 15.4 / max
// 298.7 minutes (see the header note in journal-link.mjs) — the measured MINIMUM alone exceeds the
// old window, so no real run could ever pass it. This fixture models a realistic 15-minute gap (the
// measured median) between the run's start and the journal's activity, with no birthtime forged at
// all, and pins that the journal is still found now that the birthtime filter is gone — with an
// agreeing branch, so the assertion is actually pinned to something: deleting the active-bound filter
// below would still leave this candidate refused by mtime being outside the window if the gap logic
// regressed, and deleting the branch tie would make this test pass for a WRONG journal too, which the
// dedicated branch-mismatch test above catches instead.
test('a realistic run-start-to-journal gap (15 minutes, the measured median) is found when the branch agrees', () => {
  const claudeHome = tmpDir()
  const project = tmpDir('craft-proj-')
  const file = plantJournal(claudeHome, project, { birthMs: Date.now(), branch: 'feat/x' })
  const trueBirth = fs.statSync(file).birthtimeMs
  const runStartMs = trueBirth - 15 * 60 * 1000
  // mtime moves forward with the gap too, staying well inside the active-bound window.
  fs.utimesSync(file, new Date(trueBirth), new Date(trueBirth + 1000))
  const hit = findJournalForRun({ project, runStartMs, branch: 'feat/x', claudeHome })
  assert.equal(hit.found, true)
  assert.equal(hit.file, file)
})

test('a journal still "active" long after the run should have ended is not matched (too late / too long-lived)', () => {
  const claudeHome = tmpDir()
  const project = tmpDir('craft-proj-')
  const birthMs = Date.now()
  const file = plantJournal(claudeHome, project, { birthMs, branch: 'feat/x' })
  const trueBirth = fs.statSync(file).birthtimeMs
  // mtime far beyond the active bound relative to runStartMs — the journal cannot plausibly still
  // belong to a run that started at runStartMs.
  const future = new Date(trueBirth + JOURNAL_ACTIVE_BOUND_MS + 60_000)
  fs.utimesSync(file, future, future)
  const hit = findJournalForRun({ project, runStartMs: trueBirth, branch: 'feat/x', claudeHome })
  assert.equal(hit.found, false)
  assert.equal(hit.reason, 'no-journal-found')
})

test('no project directory at all degrades to not-found, never throws', () => {
  const claudeHome = tmpDir()
  const hit = findJournalForRun({ project: '/nope/does/not/exist', runStartMs: Date.now(), branch: 'feat/x', claudeHome })
  assert.equal(hit.found, false)
  assert.equal(hit.reason, 'no-journal-found')
})

test('missing identity (no project or non-finite runStartMs) is refused up front', () => {
  assert.equal(findJournalForRun({ runStartMs: Date.now() }).reason, 'no-identity')
  assert.equal(findJournalForRun({ project: '/x' }).reason, 'no-identity')
})

// ---- the session-id path -----------------------------------------------------------------------
// The project-slug path proved unreliable on the live store: a run executing inside a throwaway
// agent worktree has the harness recording the session under the REAL repo's slug, not the
// worktree's — so the two sides record different paths, and every project-slug match then misses.
// The session id has no such problem: it is the harness's own directory name, read at the moment the
// checkpoint was written, independent of the project string the run believed it was reviewing. These
// tests plant journals under a session id with an ARBITRARY, wrong-looking project slug to prove the
// lookup does not depend on the slug matching at all. The branch tie applies on this path too — a
// session can outlive a single workflow run, so uniqueness-within-a-session is not proof either.

test('a session id finds its journal under ANY project slug, including one that does not match the given project', () => {
  const claudeHome = tmpDir()
  const project = tmpDir('craft-proj-')
  // Deliberately planted under a slug that has nothing to do with `project` — the worktree case.
  const file = plantJournal(claudeHome, '/some/other/worktree/path', { birthMs: Date.now(), session: 'sess-abc', branch: 'feat/x' })
  const runStartMs = fs.statSync(file).birthtimeMs
  const hit = findJournalForRun({ project, runStartMs, sessionId: 'sess-abc', branch: 'feat/x', claudeHome })
  assert.equal(hit.found, true)
  assert.equal(hit.file, file)
})

test('the session-id path drops the birthtime tolerance entirely — a journal whose REAL birthtime is an hour before runStartMs still matches', () => {
  const claudeHome = tmpDir()
  const project = tmpDir('craft-proj-')
  const file = plantJournal(claudeHome, project, { birthMs: Date.now(), session: 'sess-late', branch: 'feat/x' })
  // The real, unforged birthtime (utimesSync cannot set it — see plantJournal's own note) is left
  // untouched here on purpose: moving mtime EARLIER than birthtime, as the other tests in this file
  // do, causes some filesystems (observed on this machine's APFS) to pull birthtime down with it,
  // which would make this falsifier pass for the wrong reason. Instead runStartMs is moved an hour
  // BEFORE the untouched real birth — well outside the old (now-removed) 10-minute start tolerance —
  // while mtime (== birth) stays within JOURNAL_ACTIVE_BOUND_MS (6 hours) of it, so only the
  // (dropped) start-tolerance check, never the active-bound check, is what this test is pinning.
  const trueBirth = fs.statSync(file).birthtimeMs
  const runStartMs = trueBirth - 60 * 60 * 1000
  const hit = findJournalForRun({ project, runStartMs, sessionId: 'sess-late', branch: 'feat/x', claudeHome })
  assert.equal(hit.found, true)
  assert.equal(hit.file, file)
})

test('a session with exactly one workflow run and an agreeing branch is unambiguous even with no runStartMs at all', () => {
  const claudeHome = tmpDir()
  const file = plantJournal(claudeHome, '/whatever', { birthMs: Date.now(), session: 'sess-solo', branch: 'feat/x' })
  const hit = findJournalForRun({ sessionId: 'sess-solo', branch: 'feat/x', claudeHome })
  assert.equal(hit.found, true)
  assert.equal(hit.file, file)
})

// A session's uniqueness is not proof either: the journal it uniquely finds can still be for a
// different branch than the run actually being recovered (e.g. a resumed session that reviewed one
// branch, then another, before the run under recovery).
test('a session with exactly one workflow run but a DIFFERENT branch is refused, not matched on session uniqueness alone', () => {
  const claudeHome = tmpDir()
  const file = plantJournal(claudeHome, '/whatever', { birthMs: Date.now(), session: 'sess-solo-2', branch: 'someone-elses-branch' })
  const hit = findJournalForRun({ sessionId: 'sess-solo-2', branch: 'my-branch', claudeHome })
  assert.equal(hit.found, false)
  assert.equal(hit.reason, 'branch-mismatch')
  assert.notEqual(hit.file, file)
})

test('a session with two workflow runs is ambiguous, and resolves to nothing rather than a guess', () => {
  const claudeHome = tmpDir()
  const now = Date.now()
  plantJournal(claudeHome, '/proj-a', { birthMs: now, session: 'sess-two', wf: 'wf1', branch: 'feat/x' })
  plantJournal(claudeHome, '/proj-b', { birthMs: now, session: 'sess-two', wf: 'wf2', branch: 'feat/x' })
  const hit = findJournalForRun({ sessionId: 'sess-two', runStartMs: now, branch: 'feat/x', claudeHome })
  assert.deepEqual(hit, { found: false, reason: 'ambiguous-journals', count: 2 })
})

test('a session-id journal too far outside the active bound is still refused — the bound is not dropped, only the start tolerance', () => {
  const claudeHome = tmpDir()
  const project = tmpDir('craft-proj-')
  const file = plantJournal(claudeHome, project, { birthMs: Date.now(), session: 'sess-stale', branch: 'feat/x' })
  const trueBirth = fs.statSync(file).birthtimeMs
  const future = new Date(trueBirth + JOURNAL_ACTIVE_BOUND_MS + 60_000)
  fs.utimesSync(file, future, future)
  const hit = findJournalForRun({ project, runStartMs: trueBirth, sessionId: 'sess-stale', branch: 'feat/x', claudeHome })
  assert.equal(hit.found, false)
  assert.equal(hit.reason, 'no-journal-found')
})

test('an unknown session id degrades to not-found, never throws', () => {
  const claudeHome = tmpDir()
  const hit = findJournalForRun({ sessionId: 'sess-nope', runStartMs: Date.now(), branch: 'feat/x', claudeHome })
  assert.equal(hit.found, false)
  assert.equal(hit.reason, 'no-journal-found')
})

// isPlausibleSessionId is the guard applied at the point sessionId becomes a filesystem path segment
// (SESSION_ID_RE in journal-link.mjs). Pin it directly so deleting the guard line in findJournalForRun
// cannot pass silently — every session-id fixture elsewhere in this file is UUID/readable-id shaped
// and would never exercise a traversal payload on its own.
test('isPlausibleSessionId rejects traversal and separator payloads, accepts UUID-shaped ids', () => {
  assert.equal(isPlausibleSessionId('../x'), false)
  assert.equal(isPlausibleSessionId('../../../../etc'), false)
  assert.equal(isPlausibleSessionId('a/b'), false)
  assert.equal(isPlausibleSessionId('a\\b'), false)
  assert.equal(isPlausibleSessionId('123e4567-e89b-12d3-a456-426614174000'), true)
})

// The property that actually matters: a traversal-shaped sessionId reaching findJournalForRun must
// not escape the given claudeHome and read a journal planted OUTSIDE it. This is real filesystem
// behaviour, not a regex check — it plants a genuine journal above claudeHome and confirms the
// traversal id cannot reach it.
test('a traversal-shaped sessionId cannot escape claudeHome to reach a journal planted outside it', () => {
  const claudeHome = tmpDir('craft-journal-home-')
  // findJournalFilesForSession only iterates slugs that already exist under `<claudeHome>/projects`,
  // then joins `<slug>/<sessionId>/...` — so a real slug directory has to exist for the traversal to
  // have anything to walk from. `path.join(claudeHome, 'projects', slug, '../../evil', ...)` climbs
  // two levels back up (past `slug`, past `projects`) and lands on `<claudeHome>/evil` — plant the
  // real journal exactly there, outside the `projects/` tree the guard is meant to confine matches to.
  const slugDir = path.join(claudeHome, 'projects', 'some-project-slug')
  fs.mkdirSync(slugDir, { recursive: true })
  const escapeDir = path.join(claudeHome, 'evil', 'subagents', 'workflows', 'wf1')
  fs.mkdirSync(escapeDir, { recursive: true })
  // Carry a matching `branch` result line so that IF the traversal reached this journal, the branch
  // tie alone would not save the guard — the assertion must fail because of the sessionId guard, not
  // because of an incidental branch mismatch.
  const escapeLines = [
    '{"type":"started","agentId":"a1"}',
    JSON.stringify({ type: 'result', result: { baseRef: 'origin/main', branch: 'feat/x', head: 'deadbeef', files: ['a.txt'] } }),
  ]
  fs.writeFileSync(path.join(escapeDir, 'journal.jsonl'), escapeLines.join('\n') + '\n')
  try {
    const hit = findJournalForRun({ sessionId: '../../evil', runStartMs: Date.now(), branch: 'feat/x', claudeHome })
    // A rejected sessionId degrades to absent (isPlausibleSessionId returns false for '../../evil'),
    // so this falls through to the project-slug path — which, given no project/runStartMs match,
    // also resolves to not-found. Either way the escaped journal must never be returned.
    assert.equal(hit.found, false)
  } finally {
    fs.rmSync(path.join(claudeHome, 'evil'), { recursive: true, force: true })
  }
})
