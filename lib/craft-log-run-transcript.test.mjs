// `craft-log-run <write|checkpoint|finalize> --from-transcript <nonce>`: the record from the logger agent's own
// transcript instead of stdin, and the prompt's step 1 run as the agent runs it (realm @nick/craft, node #429).
// Temporary store and CLAUDE_CONFIG_DIR only.
import { test, onTestFinished } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { run } from './craft-log-run.mjs'
import { recordNonce } from './record-nonce.mjs'
import { TRANSCRIPT_MISS, TRANSCRIPT_MISS_EXIT } from './transcript-record.mjs'
import { logRunPrompt, checkpointPrompt, transcriptMissed } from './run-logging.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RECORD = { schemaVersion: 1, kind: 'workflow', name: 'triage-findings', verdict: 'Pass', findings: [{ title: 't', why: 'x'.repeat(40000) }] }

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-lrt-'))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** @param {string} home @param {string} prompt */
function lay(home, prompt) {
  const dir = path.join(home, 'projects', '-p', 'sess-1', 'subagents', 'workflows', 'wf_1')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `agent-${fs.readdirSync(dir).length}.jsonl`), `${JSON.stringify({ type: 'x' })}\n${JSON.stringify({ type: 'user', message: { content: prompt } })}\n`)
}

/** @param {string} store */
const details = store => (fs.existsSync(store) ? fs.readdirSync(store).filter(f => f.endsWith('.json')) : [])
const noStdin = () => { throw new Error('stdin read on the transcript path') }

test('write: the record is read from the transcript, not stdin, and filed as the stdin path files it', async () => {
  const [home, store] = [tmp(), tmp()]
  lay(home, logRunPrompt({ record: RECORD }))
  const nonce = recordNonce(RECORD, { command: 'write' })
  const r = await run(['write', '--from-transcript', nonce, '--store', store, '--project', store], { CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_SESSION_ID: 'sess-1' }, store, noStdin)
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  assert.match(String(r.stdout[0]), /^wrote /)
  const [file] = details(store)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store, String(file)), 'utf8')).findings, RECORD.findings)
})

test('a miss prints one TRANSCRIPT-MISS line, exits 3 and writes nothing', async () => {
  const [home, store] = [tmp(), tmp()]
  const nonce = recordNonce(RECORD, { command: 'finalize' })
  const r = await run(['finalize', '--from-transcript', nonce, '--store', store, '--project', store], { CLAUDE_CONFIG_DIR: home }, store, noStdin)
  assert.equal(r.exitCode, TRANSCRIPT_MISS_EXIT)
  assert.deepEqual(r.stdout.length, 1)
  assert.ok(String(r.stdout[0]).startsWith(`${TRANSCRIPT_MISS} `))
  assert.deepEqual(r.stderr, [])
  assert.deepEqual(fs.readdirSync(store), [])
  // The nonce names the call too: a write's prompt is not a finalize's record.
  lay(home, logRunPrompt({ record: RECORD }))
  const other = await run(['finalize', '--from-transcript', recordNonce(RECORD, { command: 'write' }), '--store', store, '--project', store], { CLAUDE_CONFIG_DIR: home }, store, noStdin)
  assert.match(String(other.stdout[0]), /not the one craft-[0-9a-f]{16} names/)
})

test('checkpoint: the phase is part of the nonce, and the runDir comes back as from stdin', async () => {
  const [home, store] = [tmp(), tmp()]
  lay(home, checkpointPrompt({ payload: RECORD, phase: 'gate' }))
  const nonce = recordNonce(RECORD, { command: 'checkpoint', phase: 'gate' })
  const r = await run(['checkpoint', '--phase', 'gate', '--from-transcript', nonce, '--store', store, '--project', store], { CLAUDE_CONFIG_DIR: home }, store, noStdin)
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  assert.ok(JSON.parse(String(r.stdout[0])).runDir.startsWith(path.join(store, '.partial')))
})

// The fenced block of step 1, run by bash in the reviewed repo, as the logger agent runs it.
/** @param {string} prompt @param {string} home @param {string} store @param {string} repo */
function stepOne(prompt, home, store, repo) {
  const lines = prompt.split('\n')
  const open = lines.findIndex(l => l.trim() === '```')
  const close = lines.findIndex((l, k) => k > open && l.trim() === '```')
  const script = lines.slice(open + 1, close).join('\n').replace('--project "$PWD"', `--store '${store}' --project "$PWD"`)
  return spawnSync('bash', ['-c', script], { cwd: repo, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_SESSION_ID: 'sess-1' } })
}

test('step 1 of the prompt, run by a shell, files the record from the agent\'s transcript; without one it misses', () => {
  const [home, store, repo] = [tmp(), tmp(), tmp()]
  const prompt = logRunPrompt({ record: RECORD, craftRoot: ROOT, repo })
  const missed = stepOne(prompt, home, store, repo)
  assert.equal(missed.status, TRANSCRIPT_MISS_EXIT)
  assert.ok(missed.stdout.startsWith(TRANSCRIPT_MISS))
  assert.ok(transcriptMissed({ ok: false, output: missed.stdout.split('\n') }))
  lay(home, prompt)
  const filed = stepOne(prompt, home, store, repo)
  assert.equal(filed.status, 0, filed.stderr)
  assert.equal(details(store).length, 1)
})

test('the transcript-only prompt offers no heredoc; the default one does, behind the transcript read', () => {
  const only = logRunPrompt({ record: RECORD, fallback: false })
  assert.doesNotMatch(only, /CRAFT_RECORD_EOF/)
  assert.match(only, /--from-transcript craft-[0-9a-f]{16}\n/)
  const both = logRunPrompt({ record: RECORD })
  assert.ok(both.indexOf('--from-transcript') < both.indexOf('CRAFT_RECORD_EOF'))
  assert.ok(!transcriptMissed({ ok: true, output: ['wrote x'] }))
  assert.ok(transcriptMissed({ ok: false, error: `${TRANSCRIPT_MISS} 0 agent transcripts` }))
})
