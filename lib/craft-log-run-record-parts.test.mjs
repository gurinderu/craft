// The shared run logger (lib/run-logging.mjs, makeRunLogger) sending a large record in parts, each part and
// the final header run through the real lib/craft-log-run.mjs, the way a logger agent runs the prompt's
// command (realm @nick/craft, node #396). Every engine binds this one writer.
import { test, onTestFinished } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './craft-log-run.mjs'
import { makeRunLogger } from './run-logging.mjs'

// A record well past 100 KB, nested, with a string larger than a part on its own.
const BIG = {
  schemaVersion: 1, kind: 'workflow', name: 'triage-findings', craftVersion: '9.9.9', round: 2, verdict: 'Warning',
  findings: Array.from({ length: 150 }, (_, i) => ({ title: `t${i}`, file: `src/f${i % 5}.rs`, line: i, why: `${i} `.padEnd(700, 'w'), sources: ['a', { n: i }] })),
  notes: 'é"\\\n'.repeat(8000),
}

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-rp-'))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** @param {string} store */
const filed = store => fs.readdirSync(store).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(store, f), 'utf8')))
/** @param {string} prompt */
const payloadOf = prompt => /** @type {string} */ (/\n(?:RECORD|PAYLOAD):\s*\n([\s\S]+)$/.exec(prompt)?.[1])

/**
 * A logger agent that runs the prompt's command against `store`. `drop(label, n)` answers the n-th call of a
 * label as a dead agent: before the script ran (`'before'`) or after it (`'after'`).
 * @param {string} store @param {(label: string, n: number) => '' | 'before' | 'after'} [drop]
 */
function loggerAgent(store, drop = () => '') {
  /** @type {{ label: string, prompt: string, payloadBytes: number }[]} */
  const calls = []
  /** @param {string} prompt @param {{ label: string }} opts */
  const call = async (prompt, opts) => {
    const n = calls.filter(c => c.label === opts.label).length
    const payload = payloadOf(prompt)
    calls.push({ label: opts.label, prompt, payloadBytes: payload.length })
    const how = drop(opts.label, n)
    if (how === 'before') return null
    const line = /node "\$CRAFT_LOGGER" (\w+) (.*)--project/.exec(prompt)
    const [cmd, flags] = [String(line?.[1]), String(line?.[2]).replace(/\$\{[^}]*\}/g, '')]
    const argv = [cmd, ...[...flags.matchAll(/(--[\w-]+)(?: '([^']*)'| (\d+))?/g)].flatMap(m => [m[1], m[2] ?? m[3]].filter(x => x !== undefined)), '--store', store, '--project', store]
    const r = await run(/** @type {string[]} */ (argv), {}, store, () => payload)
    if (how === 'after') return null
    if (cmd === 'checkpoint') return r.exitCode ? { runDir: '', error: r.stderr.join(' ') } : { runDir: JSON.parse(String(r.stdout[0])).runDir }
    const warning = r.stderr.find(l => l.startsWith('craft-log-run WARNING'))
    return r.exitCode ? { ok: false, error: r.stderr.join(' ') } : { ok: true, ...(warning ? { error: warning } : {}) }
  }
  return { calls, call }
}

/** @param {ReturnType<typeof loggerAgent>} agent @param {{ command?: string, dir?: string }} [to] */
function logger(agent, to = {}) {
  /** @type {string[]} */
  const lost = []
  const logRun = makeRunLogger({ call: agent.call, phase: 'Plan', target: () => ({ craftRoot: '/nowhere', ...to }), noteLoss: (what, why) => lost.push(`${what} — ${why}`) })
  return { logRun, lost }
}

test('a record past 100 KB is filed through parts of at most 16 KB and lands exactly as sent', async () => {
  const store = tmp()
  const agent = loggerAgent(store)
  const { logRun, lost } = logger(agent)
  await logRun(BIG)
  assert.deepEqual(lost, [])
  const parts = agent.calls.filter(c => c.label.startsWith('checkpoint:record-'))
  assert.ok(parts.length >= 7)
  const largest = Math.max(...agent.calls.map(c => c.payloadBytes))
  assert.ok(largest <= 20 * 1024, `the largest payload one call carries is ${largest} bytes`)
  assert.ok(parts.every(c => c.payloadBytes <= 17 * 1024), 'each part near 16 KB at most')
  const fin = /** @type {{ prompt: string }} */ (agent.calls.at(-1))
  assert.match(fin.prompt, /node "\$CRAFT_LOGGER" finalize --dir '[^']+\/\.partial\/[^']+'/)
  const [record, ...more] = filed(store)
  assert.equal(more.length, 0)
  for (const k of ['ts', 'project', 'commit', 'dirty', 'engineRevision', 'craftCommit', 'branch', 'head', 'session', 'trackedDirty']) delete record[k]
  assert.deepEqual(record, BIG)
  assert.deepEqual(fs.readdirSync(path.join(store, '.partial')), [], 'the parts\' directory is folded away')
})

test('a part whose logger died is tried once more, and a part copied twice files once', async () => {
  const store = tmp()
  const agent = loggerAgent(store, (label, n) => (label === 'checkpoint:record-02' && n === 0 ? 'after' : ''))
  const { logRun, lost } = logger(agent)
  await logRun(BIG)
  assert.deepEqual(lost, [])
  assert.equal(agent.calls.filter(c => c.label === 'checkpoint:record-02').length, 2)
  const [record] = filed(store)
  assert.deepEqual(record.findings, BIG.findings)
  assert.equal(record.recordInParts, undefined)
})

test('a part that never lands: the record is filed with what the rest hold, and both losses are said', async () => {
  const store = tmp()
  const agent = loggerAgent(store, label => (label === 'checkpoint:record-03' ? 'before' : ''))
  const { logRun, lost } = logger(agent)
  await logRun(BIG)
  assert.match(lost[0] ?? '', /^record part 'record-03' — /)
  assert.match(lost[1] ?? '', /the run directory \(the record itself landed\)|declared in \d+ part\(s\)/)
  const [record] = filed(store)
  assert.equal(record.recordInParts.seen, record.recordInParts.of - 1)
  assert.equal(record.verdict, 'Warning')
})

test('no part lands: the whole record goes in one call, as before', async () => {
  const store = tmp()
  const agent = loggerAgent(store, label => (label.startsWith('checkpoint:') ? 'before' : ''))
  const { logRun } = logger(agent)
  await logRun(BIG)
  const fin = /** @type {{ prompt: string, label: string }} */ (agent.calls.at(-1))
  assert.match(fin.label, /^log-run \(\d+KB\)$/)
  assert.match(fin.prompt, /node "\$CRAFT_LOGGER" write /)
  const [record] = filed(store)
  assert.deepEqual(record.findings, BIG.findings)
})

test('a finalize whose logger died after filing is answered "already filed" on the re-dispatch', async () => {
  const store = tmp()
  const agent = loggerAgent(store, (label, n) => (label === 'log-run' && n === 0 ? 'after' : ''))
  const { logRun, lost } = logger(agent)
  await logRun(BIG)
  assert.deepEqual(lost, [])
  assert.equal(filed(store).length, 1, 'filed once')
})

test('the parts go into the directory the engine already has, and finalize folds its phases with them', async () => {
  const store = tmp()
  const first = await run(['checkpoint', '--phase', 'plan', '--store', store, '--project', store], {}, store, () => JSON.stringify({ kind: 'workflow', name: 'review', plan: 1 }))
  const dir = JSON.parse(String(first.stdout[0])).runDir
  const agent = loggerAgent(store)
  const { logRun } = logger(agent, { command: 'finalize', dir })
  await logRun(BIG)
  assert.ok(agent.calls.filter(c => c.label.startsWith('checkpoint:record-')).every(c => c.prompt.includes(`--dir '${dir}'`)))
  const [record] = filed(store)
  assert.deepEqual(record.phases.map((/** @type {{ phase: string }} */ p) => p.phase), ['plan'])
  assert.deepEqual(record.findings, BIG.findings)
})

test('a record under the threshold still goes in one call', async () => {
  const store = tmp()
  const agent = loggerAgent(store)
  const { logRun } = logger(agent)
  await logRun({ kind: 'workflow', name: 'triage-findings', verdict: 'ok' })
  assert.deepEqual(agent.calls.map(c => c.label), ['log-run'])
  assert.equal(filed(store)[0].verdict, 'ok')
})
