// enrich-cost --run-id: each record a Workflow run filed gets its own slice of the run's agents
// (realm @nick/craft, nodes #393, #389).
import { test, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './craft-log-run.mjs'
import { findRunDir, isLogRunLabel, sliceAgents } from './run-cost-slices.mjs'
import { logRunDispatch } from './run-logging.mjs'
import { COST_RULE, costProblem } from './run-record.mjs'

const RUN = 'wf_abc123-def'
/** @type {string[]} */
const made = []
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function home() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-runcost-'))
  made.push(d)
  return d
}

/** @param {string} claudeHome @param {string} [slug] @param {string} [session] */
function runDir(claudeHome, slug = '-repo', session = 's1') {
  const dir = path.join(claudeHome, 'projects', slug, session, 'subagents', 'workflows', RUN)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * One agent: its meta, and a transcript starting at `minute` with `out` output tokens; a log-run agent's
 * tool result names `filed`.
 * @param {string} dir @param {string} id @param {{ minute: number, out: number, label?: string, filed?: string }} a
 */
function agent(dir, id, { minute, out, label = 'lens', filed }) {
  const ts = `2026-10-29T10:${String(minute).padStart(2, '0')}:00.000Z`
  /** @type {Record<string, unknown>[]} */
  const lines = [
    { type: 'user', timestamp: ts, message: { role: 'user', content: 'task' } },
    { type: 'assistant', timestamp: ts, message: { id: `msg_${id}`, usage: { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } },
  ]
  if (filed) lines.push({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: `${filed}` }] } })
  fs.writeFileSync(path.join(dir, `agent-${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'workflow-subagent', description: label }))
}

/** @param {string} claudeHome @param {string} name */
function record(claudeHome, name) {
  const file = path.join(claudeHome, name)
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, name }))
  return file
}

/** @param {string} file */
const costOf = file => JSON.parse(fs.readFileSync(file, 'utf8')).cost

/** @param {string} claudeHome */
const enrich = claudeHome => run(['enrich-cost', '--run-id', RUN, '--claude-home', claudeHome, '--store', claudeHome], {}, claudeHome)

test('the logger labels logRunDispatch gives are the ones a slice ends at', () => {
  assert.ok(isLogRunLabel(logRunDispatch({ a: 1 }).label))
  assert.ok(isLogRunLabel(logRunDispatch({ a: 'x'.repeat(40000) }).label))
  assert.ok(!isLogRunLabel('log-run-ish'))
})

test('one record takes every agent of its run', async () => {
  const h = home()
  const dir = runDir(h)
  const rec = record(h, 'r1.json')
  agent(dir, 'a', { minute: 1, out: 10 })
  agent(dir, 'b', { minute: 2, out: 20, label: 'log-run (30KB)', filed: `wrote ${rec} (folded 2 checkpoint(s))` })
  const r = await enrich(h)
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  const cost = costOf(rec)
  assert.equal(cost.output, 30)
  assert.equal(cost.agents, 2)
  assert.equal(cost.source, RUN)
  assert.equal(cost.rule, COST_RULE)
  assert.deepEqual(cost.slice, { index: 1, of: 1 })
  assert.equal(costProblem(cost), null)
})

test('a resumed tail\'s second record gets only the agents after the first record\'s logger', async () => {
  const h = home()
  const dir = runDir(h)
  const first = record(h, 'r1.json')
  const second = record(h, 'r2.json')
  agent(dir, 'a', { minute: 1, out: 1 })
  agent(dir, 'b', { minute: 2, out: 2, label: 'log-run', filed: `wrote ${first}` })
  agent(dir, 'c', { minute: 3, out: 4 })
  agent(dir, 'd', { minute: 4, out: 8, label: 'log-run', filed: `craft-log-run WARNING: x\nwrote ${second}` })
  const r = await enrich(h)
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  assert.deepEqual([costOf(first).output, costOf(first).agents, costOf(first).slice], [3, 2, { index: 1, of: 2 }])
  assert.deepEqual([costOf(second).output, costOf(second).agents, costOf(second).slice], [12, 2, { index: 2, of: 2 }])
  // Two disjoint slices of one run share a source and stay apart by their slice.
  assert.equal(costOf(second).source, costOf(first).source)
})

test('agents after the last record\'s logger go to the last record, counted as its tail', async () => {
  const h = home()
  const dir = runDir(h)
  const rec = record(h, 'r1.json')
  agent(dir, 'a', { minute: 1, out: 1, label: 'log-run', filed: `already filed ${rec}` })
  agent(dir, 'b', { minute: 5, out: 2 })
  agent(dir, 'c', { minute: 6, out: 4 })
  const r = await enrich(h)
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  assert.deepEqual(costOf(rec).slice, { index: 1, of: 1, tail: 2 })
  assert.equal(costOf(rec).output, 7)
  assert.match(r.stdout.join('\n'), /2 after the last record's logger/)
})

test('a run id with no transcript directory is refused by name', async () => {
  const h = home()
  const r = await enrich(h)
  assert.equal(r.exitCode, 1)
  assert.match(r.stderr.join('\n'), /no transcript directory for run wf_abc123-def/)
})

test('a run id found in two real directories is refused, a linked one counts once', () => {
  const h = home()
  const real = runDir(h, '-repo', 's1')
  agent(real, 'a', { minute: 1, out: 1 })
  const linkParent = path.join(h, 'projects', '-repo', 's2', 'subagents', 'workflows')
  fs.mkdirSync(linkParent, { recursive: true })
  fs.symlinkSync(real, path.join(linkParent, RUN))
  assert.equal(findRunDir(RUN, h), fs.realpathSync(real))
  agent(runDir(h, '-other', 's3'), 'b', { minute: 1, out: 1 })
  assert.throws(() => findRunDir(RUN, h), /has 2 transcript directories and none holds the others' agents/)
})

test('of a run copied by the session that resumed it, the copy holding every agent is the run', () => {
  const h = home()
  const first = runDir(h, '-repo', 's1')
  agent(first, 'a', { minute: 1, out: 1 })
  const copy = runDir(h, '-repo', 's2')
  agent(copy, 'a', { minute: 1, out: 1 })
  agent(copy, 'b', { minute: 2, out: 1 })
  assert.equal(findRunDir(RUN, h), fs.realpathSync(copy))
})

test('a run that filed no record, or a malformed run id, writes nothing', async () => {
  const h = home()
  const dir = runDir(h)
  agent(dir, 'a', { minute: 1, out: 1, label: 'log-run', filed: 'craft-log-run FAILED: no' })
  const r = await enrich(h)
  assert.equal(r.exitCode, 1)
  assert.match(r.stderr.join('\n'), /no log-run agent of this run reported a filed record/)
  assert.throws(() => findRunDir('../etc', h), /not a Workflow run id/)
})

test('an unreadable record refuses the whole run before any record is written', async () => {
  const h = home()
  const dir = runDir(h)
  const first = record(h, 'r1.json')
  agent(dir, 'a', { minute: 1, out: 1, label: 'log-run', filed: `wrote ${first}` })
  agent(dir, 'b', { minute: 2, out: 1, label: 'log-run', filed: `wrote ${path.join(h, 'gone.json')}` })
  const r = await enrich(h)
  assert.equal(r.exitCode, 1)
  assert.equal(costOf(first), undefined)
})

test('sliceAgents ends a record filed twice at its later filing', () => {
  const slices = sliceAgents([
    { name: 'a', start: 1, record: '' }, { name: 'b', start: 2, record: '/r.json' },
    { name: 'c', start: 3, record: '' }, { name: 'd', start: 4, record: '/r.json' },
  ])
  assert.deepEqual(slices, [{ record: '/r.json', transcripts: ['a', 'b', 'c', 'd'], tail: 0 }])
})
