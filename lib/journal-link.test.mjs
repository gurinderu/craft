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
import { slugifyProjectPath, findJournalForRun, JOURNAL_START_TOLERANCE_MS, JOURNAL_ACTIVE_BOUND_MS } from './journal-link.mjs'

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

test('a journal born too early (outside the start tolerance) is not matched', () => {
  const claudeHome = tmpDir()
  const project = tmpDir('craft-proj-')
  const file = plantJournal(claudeHome, project, { birthMs: Date.now() })
  const trueBirth = fs.statSync(file).birthtimeMs
  // birthtime cannot be forged via utimesSync (mtime/atime only), so isolate the start-tolerance
  // check by moving runStartMs itself outside the tolerance window relative to the journal's REAL
  // birth, while keeping mtime just after runStartMs — well inside the active-bound window — so
  // only the start-tolerance filter, not the active-bound filter, can be responsible for the miss.
  const runStartMs = trueBirth + JOURNAL_START_TOLERANCE_MS + 60_000
  fs.utimesSync(file, new Date(runStartMs + 1000), new Date(runStartMs + 1000))
  const hit = findJournalForRun({ project, runStartMs, claudeHome })
  assert.equal(hit.found, false)
  assert.equal(hit.reason, 'no-journal-found')
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
