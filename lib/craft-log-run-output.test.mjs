// Everything a logger run says goes through the arrays `run` returns (realm @nick/craft, #172): `runIfMain`
// prints them after `run` settles, so a line printed directly from inside the work would land ahead of
// the lines it belongs to. Each warning is pinned here as returned, never printed.
import { test, vi, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { run, checkpointDir, writeCheckpoint, repoKey } from './craft-log-run.mjs'

const RECORD = { schemaVersion: 1, runtime: 'claude-code', kind: 'workflow', name: 'review', verdict: 'Approve' }

/** @param {string} prefix */
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

/** The console, silenced and recorded for the length of one test. */
function spyConsole() {
  return [vi.spyOn(console, 'log').mockImplementation(() => undefined), vi.spyOn(console, 'error').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)]
}

afterEach(() => { vi.restoreAllMocks() })

/** @param {ReturnType<typeof spyConsole>} spies */
function assertSilent(spies) {
  for (const s of spies) assert.equal(s.mock.calls.length, 0, JSON.stringify(s.mock.calls))
}

test('finalize returns the moved-working-copy warning in stderr, after nothing it printed itself', async () => {
  const store = tmp('craft-out-store-')
  const repo = tmp('craft-out-repo-')
  try {
    execFileSync('git', ['init', '-q', repo])
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
    const project = repoKey(repo)
    const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project })
    writeCheckpoint(dir, 'rust-plan', { branch: 'feat/start', head: 'startsha1' }, { project })
    const spies = spyConsole()
    const r = await run(['finalize', '--dir', dir, '--store', store, '--project', repo], process.env, repo, () => JSON.stringify(RECORD))
    assertSilent(spies)
    assert.equal(r.exitCode, 0, r.stderr.join('\n'))
    assert.match(r.stdout[0] ?? '', /^wrote .*folded 1 checkpoint/)
    assert.equal(r.stderr.length, 1, r.stderr.join('\n'))
    assert.match(r.stderr[0] ?? '', /^craft-log-run WARNING: the working copy moved during this run \(.*feat\/start@startsha when it started\)/)
  } finally {
    for (const d of [store, repo]) fs.rmSync(d, { recursive: true, force: true })
  }
})

test('enrich-cost returns its skipped-transcript and zero-sum warnings in stderr, in that order', async () => {
  const dir = tmp('craft-out-cost-')
  try {
    const runDir = path.join(dir, 'run')
    fs.mkdirSync(runDir)
    fs.writeFileSync(path.join(runDir, 'agent-a.jsonl'), JSON.stringify({ type: 'assistant', message: { content: 'hi' } }) + '\n')
    fs.mkdirSync(path.join(runDir, 'agent-b.jsonl'))   // matches the glob, unreadable as a file
    const recordFile = path.join(dir, 'rec.json')
    fs.writeFileSync(recordFile, JSON.stringify({ schemaVersion: 1, name: 'review' }))
    const spies = spyConsole()
    const r = await run(['enrich-cost', '--run-dir', runDir, '--record', recordFile, '--store', dir, '--project', dir], process.env, dir)
    assertSilent(spies)
    assert.equal(r.exitCode, 0, r.stderr.join('\n'))
    assert.match(r.stdout[0] ?? '', /^enriched .* 1 agent\(s\) \(1 unreadable, skipped\)/)
    assert.equal(r.stderr.length, 2, r.stderr.join('\n'))
    assert.match(r.stderr[0] ?? '', /^craft-log-run WARNING: skipped unreadable transcript agent-b\.jsonl: /)
    assert.match(r.stderr[1] ?? '', /^craft-log-run WARNING: 1 transcript\(s\) summed to zero tokens/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a throw while resolving the common flags is a FAILED line with 1, not a rejected run', async () => {
  const store = tmp('craft-out-flags-')
  try {
    // No `--project` and a cwd that is no path: resolving the project throws before any command runs.
    const cwd = /** @type {string} */ (/** @type {unknown} */ (null))
    const r = await run(['write', '--store', store], process.env, cwd, () => JSON.stringify(RECORD))
    assert.equal(r.exitCode, 1)
    assert.deepEqual(r.stdout, [])
    assert.equal(r.stderr.length, 1)
    assert.match(r.stderr[0] ?? '', /^craft-log-run FAILED: /)
    assert.deepEqual(fs.readdirSync(store), [])
  } finally { fs.rmSync(store, { recursive: true, force: true }) }
})

// A warning raised before a later throw is part of what the run said: it goes into stderr the moment it
// arises, so the FAILED line follows it instead of replacing it — the order the printing logger had.
test('enrich-cost keeps its skipped-transcript warning ahead of the FAILED line when the record is missing', async () => {
  const dir = tmp('craft-out-costfail-')
  try {
    const runDir = path.join(dir, 'run')
    fs.mkdirSync(runDir)
    fs.writeFileSync(path.join(runDir, 'agent-a.jsonl'), JSON.stringify({ type: 'assistant', message: { usage: { output_tokens: 3 } } }) + '\n')
    fs.mkdirSync(path.join(runDir, 'agent-c.jsonl'))
    const spies = spyConsole()
    const r = await run(['enrich-cost', '--run-dir', runDir, '--record', path.join(dir, 'missing.json'), '--store', dir, '--project', dir], process.env, dir)
    assertSilent(spies)
    assert.equal(r.exitCode, 1)
    assert.deepEqual(r.stdout, [])
    assert.equal(r.stderr.length, 2, r.stderr.join('\n'))
    assert.match(r.stderr[0] ?? '', /^craft-log-run WARNING: skipped unreadable transcript agent-c\.jsonl: .*EISDIR/)
    assert.match(r.stderr[1] ?? '', /^craft-log-run FAILED: record not readable at /)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('finalize keeps the moved-working-copy warning ahead of the FAILED line when the write fails', async () => {
  const store = tmp('craft-out-finfail-')
  const repo = tmp('craft-out-finrepo-')
  try {
    execFileSync('git', ['init', '-q', repo])
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
    const project = repoKey(repo)
    const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project })
    writeCheckpoint(dir, 'rust-plan', { branch: 'feat/start', head: 'startsha1' }, { project })
    fs.mkdirSync(path.join(store, 'index.jsonl'))   // the index append fails after the warning is known
    const spies = spyConsole()
    const r = await run(['finalize', '--dir', dir, '--store', store, '--project', repo], process.env, repo, () => JSON.stringify(RECORD))
    assertSilent(spies)
    assert.equal(r.exitCode, 1)
    assert.deepEqual(r.stdout, [])
    assert.equal(r.stderr.length, 2, r.stderr.join('\n'))
    assert.match(r.stderr[0] ?? '', /^craft-log-run WARNING: the working copy moved during this run /)
    assert.match(r.stderr[1] ?? '', /^craft-log-run FAILED: .*EISDIR/)
  } finally {
    for (const d of [store, repo]) fs.rmSync(d, { recursive: true, force: true })
  }
})
