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
import { TRANSCRIPT_MISS_EXIT } from './transcript-record.mjs'

// A record well past 100 KB, nested, with a string larger than a part on its own.
const BIG = {
  schemaVersion: 1,
  kind: 'workflow',
  name: 'triage-findings',
  craftVersion: '9.9.9',
  round: 2,
  verdict: 'Warning',
  findings: Array.from({ length: 150 }, (_, i) => ({
    title: `t${i}`,
    file: `src/f${i % 5}.rs`,
    line: i,
    why: `${i} `.padEnd(700, 'w'),
    sources: ['a', { n: i }],
  })),
  notes: 'é"\\\n'.repeat(8000),
}

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-rp-'))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** @param {string} store */
const filed = store =>
  fs
    .readdirSync(store)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(store, f), 'utf8')))
/** @param {string} prompt */
const payloadOf = prompt => /** @type {string} */ (/\n(?:RECORD|PAYLOAD):\s*\n([\s\S]+)$/.exec(prompt)?.[1])

/**
 * A logger agent that runs the prompt's commands against `store`, as a model would: step 1 reads the record
 * from the agent's transcript, and only on its TRANSCRIPT-MISS does step 2, when the prompt has one, copy the
 * payload through stdin (realm @nick/craft, node #429). With `transcripts` each prompt is laid down as an agent
 * transcript under a temporary CLAUDE_CONFIG_DIR first, as the harness does; without, that directory stays
 * empty and step 1 misses. `drop(label, n)` answers the n-th call of a label as a dead agent: before the script
 * ran (`'before'`) or after it (`'after'`).
 * @param {string} store @param {(label: string, n: number) => '' | 'before' | 'after'} [drop]
 * @param {{ transcripts?: boolean }} [o]
 */
function loggerAgent(store, drop = () => '', { transcripts = false } = {}) {
  const claudeHome = tmp()
  /** @type {{ label: string, prompt: string, payloadBytes: number, steps: number }[]} */
  const calls = []
  /** @param {string} prompt @param {{ label: string }} opts */
  const call = async (prompt, opts) => {
    const n = calls.filter(c => c.label === opts.label).length
    const payload = payloadOf(prompt)
    const at = { label: opts.label, prompt, payloadBytes: payload.length, steps: 1 }
    calls.push(at)
    const how = drop(opts.label, n)
    if (how === 'before') return null
    if (transcripts) layTranscript(claudeHome, prompt, calls.length)
    const { cmd, argv, nonce } = commandOf(prompt, store)
    const env = { CLAUDE_CONFIG_DIR: claudeHome }
    const first = await run([...argv, '--from-transcript', nonce], env, store, () => '')
    const fallback = first.exitCode === TRANSCRIPT_MISS_EXIT && prompt.includes('CRAFT_RECORD_EOF')
    if (fallback) at.steps = 2
    const r = fallback ? await run(argv, env, store, () => payload) : first
    if (how === 'after') return null
    return answer(cmd, r, [...(fallback ? first.stdout : []), ...r.stdout, ...r.stderr])
  }
  return { calls, call }
}

/** @param {string} claudeHome @param {string} prompt @param {number} n */
function layTranscript(claudeHome, prompt, n) {
  const dir = path.join(claudeHome, 'projects', '-p', 'sess-1', 'subagents', 'workflows', 'wf_1')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `agent-${n}.jsonl`),
    [{ type: 'system' }, { type: 'user', message: { content: prompt } }].map(l => JSON.stringify(l)).join('\n'),
  )
}

// Step 1's command line as argv against `store`, and its nonce.
/** @param {string} prompt @param {string} store @returns {{ cmd: string, argv: string[], nonce: string }} */
function commandOf(prompt, store) {
  const line = /node "\$CRAFT_LOGGER" (\w+) (.*)--project "\$PWD" --from-transcript (\S+)/.exec(prompt)
  const [cmd, flags, nonce] = [String(line?.[1]), String(line?.[2]).replace(/\$\{[^}]*\}/g, ''), String(line?.[3])]
  const argv = [
    cmd,
    ...[...flags.matchAll(/(--[\w-]+)(?: '([^']*)'| (\d+))?/g)].flatMap(m => [m[1], m[2] ?? m[3]].filter(x => x !== undefined)),
    '--store',
    store,
    '--project',
    store,
  ]
  return { cmd, argv: /** @type {string[]} */ (argv), nonce }
}

// What the agent returns for the last command it ran: a checkpoint's runDir, else ok and every printed line.
/** @param {string} cmd @param {{ exitCode: number, stdout: string[] }} r @param {string[]} output */
function answer(cmd, r, output) {
  if (cmd === 'checkpoint') return r.exitCode ? { runDir: '', error: output.join(' ') } : { runDir: JSON.parse(String(r.stdout[0])).runDir }
  return r.exitCode ? { ok: false, output, error: output.join(' ') } : { ok: true, output }
}

/** @param {unknown} prompt */
const nonceIn = prompt => /NONCE: (craft-[0-9a-f]{16})/.exec(String(prompt))?.[1]

/** @param {ReturnType<typeof loggerAgent>} agent @param {{ command?: string, dir?: string }} [to] */
function logger(agent, to = {}) {
  /** @type {string[]} */
  const lost = []
  const logRun = makeRunLogger({
    call: agent.call,
    phase: 'Plan',
    target: () => ({ craftRoot: '/nowhere', ...to }),
    noteLoss: (what, why) => lost.push(`${what} — ${why}`),
  })
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
  // Of the calls that offer the heredoc: the transcript-only first call carries the record, but nobody copies it.
  const largest = Math.max(...agent.calls.filter(c => c.prompt.includes('CRAFT_RECORD_EOF')).map(c => c.payloadBytes))
  assert.ok(largest <= 20 * 1024, `the largest payload one call asks to copy is ${largest} bytes`)
  assert.ok(
    parts.every(c => c.payloadBytes <= 17 * 1024),
    'each part near 16 KB at most',
  )
  const fin = /** @type {{ prompt: string }} */ (agent.calls.at(-1))
  assert.match(fin.prompt, /node "\$CRAFT_LOGGER" finalize --attempt 1 --dir '[^']+\/\.partial\/[^']+'/)
  const [record, ...more] = filed(store)
  assert.equal(more.length, 0)
  for (const k of ['ts', 'project', 'commit', 'dirty', 'engineRevision', 'craftCommit', 'branch', 'head', 'session']) delete record[k]
  assert.deepEqual(record, BIG)
  assert.deepEqual(fs.readdirSync(path.join(store, '.partial')), [], "the parts' directory is folded away")
})

test("a record past 100 KB read from the logger's own transcript is filed by ONE call, no parts, exactly as sent", async () => {
  const store = tmp()
  const agent = loggerAgent(store, () => '', { transcripts: true })
  const { logRun, lost } = logger(agent)
  await logRun(BIG)
  assert.deepEqual(lost, [])
  assert.deepEqual(
    agent.calls.map(c => [c.label.replace(/\d+KB/, 'NKB'), c.steps]),
    [['log-run (NKB)', 1]],
  )
  assert.doesNotMatch(String(agent.calls[0]?.prompt), /CRAFT_RECORD_EOF/, 'no heredoc is offered for a record past one call')
  const [record, ...more] = filed(store)
  assert.equal(more.length, 0)
  for (const k of ['ts', 'project', 'commit', 'dirty', 'engineRevision', 'craftCommit', 'branch', 'head', 'session']) delete record[k]
  assert.deepEqual(record, BIG)
})

test('the transcript call missing, the record goes down in parts: the miss costs one call', async () => {
  const store = tmp()
  const agent = loggerAgent(store)
  const { logRun, lost } = logger(agent)
  await logRun(BIG)
  assert.deepEqual(lost, [])
  assert.match(String(agent.calls[0]?.label), /^log-run \(\d+KB\)$/)
  assert.equal(agent.calls[0]?.steps, 1)
  assert.ok(agent.calls.slice(1, -1).every(c => c.label.startsWith('checkpoint:record-') && c.steps === 2))
})

test("the transcript call's agent dead on both tries: the record still lands, in parts", async () => {
  const store = tmp()
  const agent = loggerAgent(store, label => (/^log-run \(/.test(label) ? 'before' : ''), { transcripts: true })
  const { logRun, lost } = logger(agent)
  await logRun(BIG)
  assert.deepEqual(lost, [])
  assert.equal(agent.calls.filter(c => /^log-run \(/.test(c.label)).length, 2, 'the transcript call and its one re-dispatch')
  assert.ok(agent.calls.filter(c => c.label.startsWith('checkpoint:record-')).length >= 7)
  const [record, ...more] = filed(store)
  assert.equal(more.length, 0)
  assert.deepEqual(record.findings, BIG.findings)
})

test('every dispatch of one record carries its own nonce: a part asked twice reads its own transcript', async () => {
  const store = tmp()
  // The transcript call dies, so the record goes in parts; part 02's first agent files it and dies after.
  /** @param {string} label @param {number} n @returns {'' | 'before' | 'after'} */
  const drop = (label, n) => (/^log-run \(/.test(label) ? 'before' : label === 'checkpoint:record-02' && n === 0 ? 'after' : '')
  const agent = loggerAgent(store, drop, { transcripts: true })
  const { logRun, lost } = logger(agent)
  await logRun(BIG)
  assert.deepEqual(lost, [])
  const twice = agent.calls.filter(c => c.label === 'checkpoint:record-02')
  assert.equal(twice.length, 2)
  assert.notEqual(nonceIn(twice[0]?.prompt), nonceIn(twice[1]?.prompt))
  assert.equal(twice[1]?.steps, 1, 'the second ask found its own prompt, no heredoc')
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
  const first = await run(['checkpoint', '--phase', 'plan', '--store', store, '--project', store], {}, store, () =>
    JSON.stringify({ kind: 'workflow', name: 'review', plan: 1 }),
  )
  const dir = JSON.parse(String(first.stdout[0])).runDir
  const agent = loggerAgent(store)
  const { logRun } = logger(agent, { command: 'finalize', dir })
  await logRun(BIG)
  assert.ok(agent.calls.filter(c => c.label.startsWith('checkpoint:record-')).every(c => c.prompt.includes(`--dir '${dir}'`)))
  const [record] = filed(store)
  assert.deepEqual(
    record.phases.map((/** @type {{ phase: string }} */ p) => p.phase),
    ['plan'],
  )
  assert.deepEqual(record.findings, BIG.findings)
})

test('a record under the threshold still goes in one call', async () => {
  const store = tmp()
  const agent = loggerAgent(store)
  const { logRun } = logger(agent)
  await logRun({ kind: 'workflow', name: 'triage-findings', verdict: 'ok' })
  assert.deepEqual(
    agent.calls.map(c => c.label),
    ['log-run'],
  )
  assert.equal(filed(store)[0].verdict, 'ok')
})
