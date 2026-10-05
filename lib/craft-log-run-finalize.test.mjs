// Finalize and recover, pinned at their edges: whose directory a finalize may fold and delete, which
// observation of git the record is filed under, the warning a moved working copy earns, what a
// failed cleanup leaves behind, and what a recovered record says about a run that never finished.
import { test, vi, onTestFinished } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { checkpointDir, writeCheckpoint, finalizeRun, recoverPartials, recordFilename, stamp } from './craft-log-run.mjs'
import { slugifyProjectPath } from './journal-link.mjs'

const RECORD = { schemaVersion: 1, runtime: 'claude-code', kind: 'workflow', name: 'review', verdict: 'Approve' }
const NOW = new Date('2026-10-02T12:00:00Z')
const LATER = new Date(NOW.getTime() + 60 * 1000)
const P = '/p'

/** @param {string} [prefix] */
const tmp = (prefix = 'craft-fin-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** @param {string} file @returns {Record<string, any>} */
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
/** @param {string} store @param {Record<string, unknown>} payload @param {Date} [at] */
const dirWith = (store, payload, at = NOW) => {
  const dir = checkpointDir(RECORD, { store, now: at, project: P })
  writeCheckpoint(dir, 'scout', payload, { project: P })
  return dir
}
/** @param {() => void} fn @returns {string[]} what was written to stderr through console.error */
const stderrOf = fn => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    fn()
    return spy.mock.calls.map(c => String(c[0]))
  } finally {
    spy.mockRestore()
  }
}

test('a searched directory on another branch is not this run\'s: kept, not folded, even when git knows no branch', () => {
  const store = tmp()
  const dir = dirWith(store, { branch: 'other', head: 'h0' })
  const r = finalizeRun({ ...RECORD, branch: 'mine' }, { store, project: P, dir, rejoin: true, now: LATER, gitId: { branch: '', head: '' } })
  assert.deepEqual([r.folded, r.kept], [0, true])
  assert.equal(readJson(r.file)['branch'], 'mine')
})

test('a record whose directory is not its own is filed under write-time git, not the directory\'s identity', () => {
  const store = tmp()
  const dir = dirWith(store, { branch: 'other', head: 'h0' })
  const r = finalizeRun({ ...RECORD, branch: 'mine' }, { store, project: P, dir, rejoin: true, now: LATER, gitId: { branch: 'mine', head: 'h1' } })
  assert.equal(r.kept, true)
  assert.deepEqual([readJson(r.file)['branch'], readJson(r.file)['head']], ['mine', 'h1'])
})

test('finalize with no directory: no dir reported, no phases, no session, commit read off the project', () => {
  const store = tmp()
  const project = tmp('craft-fin-repo-')
  execFileSync('git', ['init', '-q'], { cwd: project })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'i'], { cwd: project })
  const r = finalizeRun(RECORD, { store, project, now: NOW })
  assert.equal(r.dir, '')
  const rec = readJson(r.file)
  assert.equal('phases' in rec, false)
  assert.equal(rec['session'], null)
  assert.equal(rec['commit'], execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim())
})

test('a run directory that cannot be read is neither folded nor removed, and the read error is reported', () => {
  const store = tmp()
  fs.mkdirSync(path.join(store, '.partial'))
  const dir = path.join(store, '.partial', 'not-a-dir')
  fs.writeFileSync(dir, '')
  const r = finalizeRun(RECORD, { store, project: P, dir, now: NOW })
  assert.match(r.unreadable, /ENOTDIR/)
  assert.equal(r.folded, 0)
  assert.equal('phases' in readJson(r.file), false)
  assert.ok(fs.existsSync(dir))
})

test('an empty run directory is this run\'s: removed, not kept', () => {
  const store = tmp()
  const dir = path.join(store, '.partial', 'empty')
  fs.mkdirSync(dir, { recursive: true })
  const r = finalizeRun(RECORD, { store, project: P, dir, now: NOW })
  assert.deepEqual([r.kept, r.unreadable, fs.existsSync(dir)], [false, '', false])
})

test('a directory attesting the head but no branch improves the head and leaves the branch alone, with no git at all', () => {
  const store = tmp()
  const dir = dirWith(store, { head: 'h0' })
  const r = finalizeRun({ ...RECORD, branch: 'b-raw' }, { store, project: P, dir, now: LATER })
  assert.equal(r.folded, 1)
  assert.deepEqual([readJson(r.file)['branch'], readJson(r.file)['head']], ['b-raw', 'h0'])
})

test('a working copy that moved branch mid-run is said on stderr, with both identities, heads cut to 8', () => {
  const store = tmp()
  const dir = dirWith(store, { branch: 'b0', head: 'aaaaaaaaaaaa' })
  const lines = stderrOf(() => finalizeRun(RECORD, { store, project: P, dir, now: LATER, gitId: { branch: 'b1', head: 'aaaaaaaaaaaa' } }))
  assert.deepEqual(lines, ['craft-log-run WARNING: the working copy moved during this run (b1@aaaaaaaa now, b0@aaaaaaaa when it started) — filed under the identity it reviewed'])
})

test('a field git could not observe at write time is not a move', () => {
  const store = tmp()
  const dir = dirWith(store, { branch: 'b0', head: 'h0' })
  assert.deepEqual(stderrOf(() => finalizeRun(RECORD, { store, project: P, dir, now: LATER, gitId: { branch: 'b0', head: '' } })), [])
})

test('a moved head with no branch on either side names the branch as ?', () => {
  const store = tmp()
  const dir = dirWith(store, { head: 'h0' })
  const lines = stderrOf(() => finalizeRun(RECORD, { store, project: P, dir, now: LATER, gitId: { branch: '', head: 'h1' } }))
  assert.deepEqual(lines, ['craft-log-run WARNING: the working copy moved during this run (?@h1 now, ?@h0 when it started) — filed under the identity it reviewed'])
})

test('a record that carries its own phases keeps them; folded checkpoints do not replace them', () => {
  const store = tmp()
  const dir = dirWith(store, {})
  const r = finalizeRun({ ...RECORD, phases: ['own'] }, { store, project: P, dir, now: LATER })
  assert.equal(r.folded, 1)
  assert.deepEqual(readJson(r.file)['phases'], ['own'])
  assert.equal(fs.existsSync(dir), false, 'the folded directory is removed')
})

test('a run directory that cannot be removed is reported, the record kept', { skip: process.getuid?.() === 0 }, () => {
  const store = tmp()
  const dir = dirWith(store, {})
  fs.chmodSync(path.join(store, '.partial'), 0o555)
  try {
    const r = finalizeRun(RECORD, { store, project: P, dir, now: LATER })
    assert.match(r.unreadable, /^the run directory could not be removed: .*EACCES/)
    assert.ok(fs.existsSync(r.file))
  } finally {
    fs.chmodSync(path.join(store, '.partial'), 0o755)
  }
})

test('recover on a store with no partial directory recovers nothing', () => {
  assert.deepEqual(recoverPartials({ store: tmp(), project: P, now: NOW }), [])
})

test('recover promotes directories in name order, skips stray files, writes one index line each and leaves a README', () => {
  const store = tmp()
  for (const s of [3, 1, 2, 0]) dirWith(store, { round: 1 }, new Date(NOW.getTime() + s * 1000))
  fs.writeFileSync(path.join(store, '.partial', 'stray.txt'), '')
  const out = recoverPartials({ store, project: P, now: LATER })
  assert.deepEqual(out.map(o => path.basename(o.file)), [0, 1, 2, 3].map(s => recordFilename({ ...RECORD, ts: stamp(new Date(NOW.getTime() + s * 1000)) })))
  const lines = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').split('\n')
  assert.equal(lines.length, 5)
  assert.equal(lines[4], '')
  for (const l of lines.slice(0, 4)) assert.equal(typeof JSON.parse(l), 'object')
  assert.ok(fs.existsSync(path.join(store, 'README.md')))
  assert.deepEqual(fs.readdirSync(path.join(store, '.partial')), ['stray.txt'], 'every promoted directory with a round is removed')
})

test('a recovered record: the first positive round on any checkpoint, defaults where the checkpoints say nothing', () => {
  const store = tmp()
  const dir = checkpointDir(RECORD, { store, now: NOW, project: P })
  writeCheckpoint(dir, 'scout', { round: 0 }, { project: P })
  writeCheckpoint(dir, 'gate', { round: 2 }, { project: P })
  const [o] = recoverPartials({ store, project: P, now: LATER })
  assert.ok(o)
  assert.equal(o.round, 2)
  const rec = readJson(o.file)
  assert.deepEqual([rec['runtime'], rec['kind'], rec['verdict'], rec['branch'], rec['verifySeen']], ['claude-code', 'workflow', 'INCOMPLETE', null, 0])
  assert.deepEqual(rec['findings'], { total: 0, bySeverity: { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 } })
})

test('a directory with a round is promoted even over an existing file of its name', () => {
  const store = tmp()
  const dir = dirWith(store, { round: 1 })
  fs.writeFileSync(path.join(store, `${path.basename(dir)}.json`), '{}')
  const out = recoverPartials({ store, project: P, now: LATER })
  assert.equal(out.length, 1)
  assert.equal(readJson(path.join(store, `${path.basename(dir)}.json`))['partial'], true)
})

test('a directory whose name is not a run stamp is promoted under its own name as a workflow, stamped now', () => {
  const store = tmp()
  const dir = path.join(store, '.partial', 'junk')
  writeCheckpoint(dir, 'scout', { round: 1 }, { project: P })
  const [o] = recoverPartials({ store, project: P, now: LATER })
  assert.ok(o)
  assert.equal(path.basename(o.file), `${stamp(LATER)}-workflow-junk.json`)
})

/** @param {string} claudeHome @param {string} project @param {unknown[]} entries */
const plantJournal = (claudeHome, project, entries) => {
  const dir = path.join(claudeHome, 'projects', slugifyProjectPath(path.resolve(project)), 's1', 'subagents', 'workflows', 'wf1')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return dir
}
const BASE = { type: 'result', agentId: 'b', result: { baseRef: 'origin/main', branch: 'feat/x', head: 'h', files: ['a.rs'] } }
/** @param {string} store @param {string} project @param {Date} now */
const deadRun = (store, project, now) => {
  const dir = checkpointDir(RECORD, { store, now, project })
  writeCheckpoint(dir, 'scout', { round: 1, branch: 'feat/x' }, { project, session: 's1' })
}

test('a journal that is found but holds no finding leaves the record checkpoint-only, with no miss reason and no ledger', () => {
  const store = tmp()
  const claudeHome = tmp('craft-fin-home-')
  const project = tmp('craft-fin-proj-')
  const now = new Date()
  deadRun(store, project, now)
  plantJournal(claudeHome, project, [BASE])
  const [o] = recoverPartials({ store, project, now, claudeHome })
  assert.ok(o)
  const rec = readJson(o.file)
  assert.equal(rec['partialReason'], 'run ended before it could write a final record — reconstructed from phase checkpoints')
  assert.equal('ledger' in rec, false)
})

test('a journal whose verify verdicts all linked supplies a journal ledger', () => {
  const store = tmp()
  const claudeHome = tmp('craft-fin-home-')
  const project = tmp('craft-fin-proj-')
  const now = new Date()
  deadRun(store, project, now)
  const finding = { severity: 'High', title: 'unwrap panics', file: 'a.rs', line: 1, why: 'w', source: 'safety' }
  const jdir = plantJournal(claudeHome, project, [
    BASE,
    { type: 'result', agentId: 'l1', result: { lens: 'safety', findings: [finding] } },
    { type: 'result', agentId: 'v1', result: { refuted: false, citedLineMatches: true } },
  ])
  fs.writeFileSync(path.join(jdir, 'agent-v1.jsonl'), JSON.stringify({ type: 'user', message: { content: 'FINDING: [High] unwrap panics\n  at a.rs:1' } }) + '\n')
  const [o] = recoverPartials({ store, project, now, claudeHome })
  assert.ok(o)
  const rec = readJson(o.file)
  assert.deepEqual([rec['verifySeen'], rec['verifyLinked'], rec['ledgerSource']], [1, 1, 'journal'])
})
