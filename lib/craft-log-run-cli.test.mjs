// The logger's command line, run in-process (realm @nick/craft, #172): the engines read its exit codes
// and its stdout, so each command is pinned by what it does and how it exits, not by its wording.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './craft-log-run.mjs'

const RECORD = {
  schemaVersion: 1, runtime: 'claude-code', kind: 'workflow', name: 'review', nested: false, via: null,
  verdict: 'Block', findings: { total: 2, bySeverity: { Critical: 0, High: 2, Medium: 0, Low: 0, Info: 0 } },
  dimensions: [], verification: { candidates: 5, confirmed: 2, refuteRate: 0.6 },
}

/** A store and a directory that is no repository, removed after `body`. @param {(store: string, dir: string) => Promise<void>} body */
async function scratch(body) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-cli-store-'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-cli-dir-'))
  try { await body(store, dir) } finally {
    for (const d of [store, dir]) fs.rmSync(d, { recursive: true, force: true })
  }
}

/** @param {string} store */
const records = store => fs.readdirSync(store).filter(f => f.endsWith('.json'))

test('write files the record from stdin, keyed to the cwd when --project is absent', () => scratch(async (store, dir) => {
  const r = await run(['write', '--store', store], process.env, dir, () => JSON.stringify(RECORD))
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  assert.equal(records(store).length, 1)
  assert.ok(r.stdout[0]?.includes(/** @type {string} */ (records(store)[0])))
  const row = JSON.parse(fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8'))
  assert.equal(row.project, fs.realpathSync(dir))
}))

test('a write with no record, or one that is not a JSON object, fails with 1 and files nothing', () => scratch(async (store, dir) => {
  for (const stdin of ['', '  \n', '[1]', '{']) {
    const r = await run(['write', '--store', store, '--project', dir], process.env, dir, () => stdin)
    assert.equal(r.exitCode, 1, JSON.stringify(stdin))
    assert.deepEqual(r.stdout, [])
    assert.match(r.stderr.join('\n'), /^craft-log-run FAILED: /)
  }
  assert.deepEqual(records(store), [])
}))

test('no command or an unknown one is refused with 2 and touches nothing', () => scratch(async (store, dir) => {
  for (const argv of [[], ['nope', '--store', store], ['--store', store]]) {
    const r = await run(argv, process.env, dir, () => { throw new Error('stdin must not be read') })
    assert.equal(r.exitCode, 2, argv.join(' '))
    assert.deepEqual(r.stdout, [])
    assert.equal(r.stderr.length, 1)
  }
  assert.deepEqual(fs.readdirSync(store), [])
}))

test('a checkpoint outside the store is refused as a path, not as a checkpoint', () => scratch(async (store, dir) => {
  const r = await run(['checkpoint', '--phase', 'Scout', '--dir', dir, '--store', store, '--project', dir], process.env, dir,
    () => JSON.stringify({ kind: 'workflow', name: 'review', phase: 'Scout' }))
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  assert.equal(r.stderr.length, 1)
  const { runDir, file } = JSON.parse(/** @type {string} */ (r.stdout[0]))
  assert.ok(runDir.startsWith(store) && fs.existsSync(file))
  assert.deepEqual(fs.readdirSync(dir), [])
}))

test('prior-round degrades to "none" with exit 0, and warns on stderr about a damaged index', () => scratch(async (store, dir) => {
  const none = await run(['prior-round', '--store', store, '--project', dir], process.env, dir)
  assert.equal(none.exitCode, 0)
  assert.equal(JSON.parse(/** @type {string} */ (none.stdout[0])).found, false)
  assert.deepEqual(none.stderr, [])
  fs.writeFileSync(path.join(store, 'index.jsonl'), 'not json\n')
  const damaged = await run(['prior-round', '--store', store, '--project', dir], process.env, dir)
  assert.equal(damaged.exitCode, 0)
  assert.equal(damaged.stdout.length, 1)
  assert.equal(damaged.stderr.length, 1)
}))

test('commands missing their arguments fail with 1', () => scratch(async (store, dir) => {
  // from-journal takes its directory positionally, so it is given no flag that could be read as one.
  const cases = [['enrich-cost', '--store', store], ['enrich-cost', '--run-dir', dir, '--store', store], ['backfill-engine', '--store', store], ['from-journal']]
  for (const argv of cases) {
    const r = await run(argv, process.env, dir)
    assert.equal(r.exitCode, 1, argv.join(' '))
    assert.deepEqual(r.stdout, [])
  }
}))

test('recover on an empty store succeeds and files nothing', () => scratch(async (store, dir) => {
  const r = await run(['recover', '--store', store, '--project', dir], process.env, dir)
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  assert.equal(r.stdout.length, 1)
  assert.deepEqual(records(store), [])
}))

test('repair-index is dry without --apply, and fails with 1 when there is no index', () => scratch(async (store, dir) => {
  const missing = await run(['repair-index', '--store', store], process.env, dir)
  assert.equal(missing.exitCode, 1)
  const index = path.join(store, 'index.jsonl')
  const text = '{"a":1}\n{\n  "b": 2\n}\n'
  fs.writeFileSync(index, text)
  const dry = await run(['repair-index', '--store', store], process.env, dir)
  assert.equal(dry.exitCode, 0, dry.stderr.join('\n'))
  assert.equal(fs.readFileSync(index, 'utf8'), text, 'a dry run writes nothing')
  const applied = await run(['repair-index', '--store', store, '--apply'], process.env, dir)
  assert.equal(applied.exitCode, 0, applied.stderr.join('\n'))
  assert.equal(fs.readFileSync(index, 'utf8'), '{"a":1}\n{"b":2}\n')
}))
