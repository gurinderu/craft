// journal-link.mjs locates the workflow transcript (journal.jsonl) belonging to a stalled run, so
// its findings can seed a recovered record's ledger. Matching is deliberately conservative — the
// wrong journal would seed the next review with another repo's findings — so these tests pin the
// safety properties (ambiguity resolves to nothing, the time window is enforced both directions)
// and not just the happy path.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { slugifyProjectPath, findJournalForRun, JOURNAL_ACTIVE_BOUND_MS } from './journal-link.mjs'

function tmpDir(prefix = 'craft-journal-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('slugifyProjectPath replaces every non-alphanumeric character, so a dot doubles up with the adjoining slash', () => {
  assert.equal(slugifyProjectPath('/Users/x/projects/my/craft'), '-Users-x-projects-my-craft')
  // The case the header calls out by name: a `.` next to a `/` produces a DOUBLE dash, not a single
  // one — a slugifier that collapsed runs of separators would silently mismatch this directory.
  assert.equal(slugifyProjectPath('/Users/x/.claude/worktrees/agent-1'), '-Users-x--claude-worktrees-agent-1')
  assert.equal(slugifyProjectPath('/a/b.c'), '-a-b-c')
})

// Builds `<claudeHome>/projects/<slug>/<session>/subagents/workflows/<wf>/journal.jsonl` with the
// given birth/mtime, mirroring the layout findJournalForRun reads.
function plantJournal(claudeHome, project, { birthMs, mtimeMs = birthMs, session = 's1', wf = 'wf1' } = {}) {
  const slug = slugifyProjectPath(path.resolve(project))
  const dir = path.join(claudeHome, 'projects', slug, session, 'subagents', 'workflows', wf)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'journal.jsonl')
  fs.writeFileSync(file, '{"type":"started","agentId":"a1"}\n')
  const atime = new Date(birthMs)
  fs.utimesSync(file, atime, new Date(mtimeMs))
  // utimesSync cannot set birthtime on most platforms; the harness reads real filesystem birthtime,
  // so these tests use the real fs.statSync(file).birthtimeMs it was actually created with and only
  // vary runStartMs / the window bounds around that, rather than trying to forge birthtime.
  return file
}

test('a single matching journal in the window is found', () => {
  const claudeHome = tmpDir()
  const project = tmpDir('craft-proj-')
  const file = plantJournal(claudeHome, project, { birthMs: Date.now() })
  const runStartMs = fs.statSync(file).birthtimeMs
  const hit = findJournalForRun({ project, runStartMs, claudeHome })
  assert.equal(hit.found, true)
  assert.equal(hit.file, file)
  assert.equal(hit.dir, path.dirname(file))
})

test('two candidate journals in the same window resolve to nothing, not to a guess', () => {
  const claudeHome = tmpDir()
  const project = tmpDir('craft-proj-')
  const f1 = plantJournal(claudeHome, project, { birthMs: Date.now(), session: 's1', wf: 'wf1' })
  const runStartMs = fs.statSync(f1).birthtimeMs
  // A second journal born within the same tolerance window — real ambiguity.
  plantJournal(claudeHome, project, { birthMs: runStartMs, session: 's2', wf: 'wf2' })
  const hit = findJournalForRun({ project, runStartMs, claudeHome })
  assert.deepEqual(hit, { found: false, reason: 'ambiguous-journals', count: 2 })
})

// The property that broke: the project-slug path used to enforce a 10-minute birthtime tolerance
// against runStartMs, but the gap this path actually sees in reality is min 11.8 / median 15.4 / max
// 298.7 minutes (see the header note in journal-link.mjs) — the measured MINIMUM alone exceeds the
// old window, so no real run could ever pass it. This fixture models a realistic 15-minute gap (the
// measured median) between the run's start and the journal's activity, with no birthtime forged at
// all, and pins that the journal is still found now that the birthtime filter is gone.
test('a realistic run-start-to-journal gap (15 minutes, the measured median) is found', () => {
  const claudeHome = tmpDir()
  const project = tmpDir('craft-proj-')
  const file = plantJournal(claudeHome, project, { birthMs: Date.now() })
  const trueBirth = fs.statSync(file).birthtimeMs
  const runStartMs = trueBirth - 15 * 60 * 1000
  // mtime moves forward with the gap too, staying well inside the active-bound window.
  fs.utimesSync(file, new Date(trueBirth), new Date(trueBirth + 1000))
  const hit = findJournalForRun({ project, runStartMs, claudeHome })
  assert.equal(hit.found, true)
  assert.equal(hit.file, file)
})

test('a journal still "active" long after the run should have ended is not matched (too late / too long-lived)', () => {
  const claudeHome = tmpDir()
  const project = tmpDir('craft-proj-')
  const birthMs = Date.now()
  const file = plantJournal(claudeHome, project, { birthMs })
  const trueBirth = fs.statSync(file).birthtimeMs
  // mtime far beyond the active bound relative to runStartMs — the journal cannot plausibly still
  // belong to a run that started at runStartMs.
  const future = new Date(trueBirth + JOURNAL_ACTIVE_BOUND_MS + 60_000)
  fs.utimesSync(file, future, future)
  const hit = findJournalForRun({ project, runStartMs: trueBirth, claudeHome })
  assert.equal(hit.found, false)
  assert.equal(hit.reason, 'no-journal-found')
})

test('no project directory at all degrades to not-found, never throws', () => {
  const claudeHome = tmpDir()
  const hit = findJournalForRun({ project: '/nope/does/not/exist', runStartMs: Date.now(), claudeHome })
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
// lookup does not depend on the slug matching at all.

test('a session id finds its journal under ANY project slug, including one that does not match the given project', () => {
  const claudeHome = tmpDir()
  const project = tmpDir('craft-proj-')
  // Deliberately planted under a slug that has nothing to do with `project` — the worktree case.
  const file = plantJournal(claudeHome, '/some/other/worktree/path', { birthMs: Date.now(), session: 'sess-abc' })
  const runStartMs = fs.statSync(file).birthtimeMs
  const hit = findJournalForRun({ project, runStartMs, sessionId: 'sess-abc', claudeHome })
  assert.equal(hit.found, true)
  assert.equal(hit.file, file)
})

test('the session-id path drops the birthtime tolerance entirely — a journal whose REAL birthtime is an hour before runStartMs still matches', () => {
  const claudeHome = tmpDir()
  const project = tmpDir('craft-proj-')
  const file = plantJournal(claudeHome, project, { birthMs: Date.now(), session: 'sess-late' })
  // The real, unforged birthtime (utimesSync cannot set it — see plantJournal's own note) is left
  // untouched here on purpose: moving mtime EARLIER than birthtime, as the other tests in this file
  // do, causes some filesystems (observed on this machine's APFS) to pull birthtime down with it,
  // which would make this falsifier pass for the wrong reason. Instead runStartMs is moved an hour
  // BEFORE the untouched real birth — well outside JOURNAL_START_TOLERANCE_MS (10 minutes) — while
  // mtime (== birth) stays within JOURNAL_ACTIVE_BOUND_MS (6 hours) of it, so only the (dropped)
  // start-tolerance check, never the active-bound check, is what this test is pinning.
  const trueBirth = fs.statSync(file).birthtimeMs
  const runStartMs = trueBirth - 60 * 60 * 1000
  const hit = findJournalForRun({ project, runStartMs, sessionId: 'sess-late', claudeHome })
  assert.equal(hit.found, true)
  assert.equal(hit.file, file)
})

test('a session with exactly one workflow run is unambiguous even with no runStartMs at all', () => {
  const claudeHome = tmpDir()
  const file = plantJournal(claudeHome, '/whatever', { birthMs: Date.now(), session: 'sess-solo' })
  const hit = findJournalForRun({ sessionId: 'sess-solo', claudeHome })
  assert.equal(hit.found, true)
  assert.equal(hit.file, file)
})

test('a session with two workflow runs is ambiguous, and resolves to nothing rather than a guess', () => {
  const claudeHome = tmpDir()
  const now = Date.now()
  plantJournal(claudeHome, '/proj-a', { birthMs: now, session: 'sess-two', wf: 'wf1' })
  plantJournal(claudeHome, '/proj-b', { birthMs: now, session: 'sess-two', wf: 'wf2' })
  const hit = findJournalForRun({ sessionId: 'sess-two', runStartMs: now, claudeHome })
  assert.deepEqual(hit, { found: false, reason: 'ambiguous-journals', count: 2 })
})

test('a session-id journal too far outside the active bound is still refused — the bound is not dropped, only the start tolerance', () => {
  const claudeHome = tmpDir()
  const project = tmpDir('craft-proj-')
  const file = plantJournal(claudeHome, project, { birthMs: Date.now(), session: 'sess-stale' })
  const trueBirth = fs.statSync(file).birthtimeMs
  const future = new Date(trueBirth + JOURNAL_ACTIVE_BOUND_MS + 60_000)
  fs.utimesSync(file, future, future)
  const hit = findJournalForRun({ project, runStartMs: trueBirth, sessionId: 'sess-stale', claudeHome })
  assert.equal(hit.found, false)
  assert.equal(hit.reason, 'no-journal-found')
})

test('an unknown session id degrades to not-found, never throws', () => {
  const claudeHome = tmpDir()
  const hit = findJournalForRun({ sessionId: 'sess-nope', runStartMs: Date.now(), claudeHome })
  assert.equal(hit.found, false)
  assert.equal(hit.reason, 'no-journal-found')
})
