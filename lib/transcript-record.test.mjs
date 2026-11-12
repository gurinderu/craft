// The logger reading the run record from its own agent transcript (realm @nick/craft, node #429; the layout,
// node #428): the nonce, locating the one transcript, and every miss. Everything under temporary directories —
// never the real ~/.claude, never the real ~/.craft.
import { test, onTestFinished } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recordNonce, NONCE_RE } from './record-nonce.mjs'
import { readRecordFromTranscript, transcriptPrompt, promptRecordText, TRANSCRIPT_MISS, TRANSCRIPT_RECENT_MS } from './transcript-record.mjs'
import { logRunPrompt, checkpointPrompt } from './run-logging.mjs'

const RECORD = { schemaVersion: 1, kind: 'workflow', name: 'review', findings: [{ title: 'é"\\\n', line: 3 }] }
const CALL = { command: 'write' }

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-tr-'))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// One agent transcript as the harness lays it down: a first line, then the prompt as the first `user` line.
/** @param {string} home @param {{ session?: string, slug?: string, run?: string, agent?: string, content: unknown }} o */
function agentTranscript(home, { session = 'sess-1', slug = '-p', run = 'wf_1', agent = 'a1', content }) {
  const dir = path.join(home, 'projects', slug, session, 'subagents', 'workflows', run)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `agent-${agent}.jsonl`)
  const lines = [{ type: 'queue-operation' }, { type: 'user', message: { role: 'user', content } }, { type: 'assistant', message: { content: [] } }]
  fs.writeFileSync(file, `${lines.map(l => JSON.stringify(l)).join('\n')}\n`)
  return file
}

test('the nonce is deterministic, and differs with the record, command, phase, retry and attempt', () => {
  const n = recordNonce(RECORD, CALL)
  assert.match(n, NONCE_RE)
  assert.equal(recordNonce(JSON.parse(JSON.stringify(RECORD, null, 2)), CALL), n, 'the same over the record as the prompt prints it')
  const others = [
    recordNonce({ ...RECORD, name: 'x' }, CALL),
    recordNonce(RECORD, { command: 'finalize' }),
    recordNonce(RECORD, { command: 'write', phase: 'p' }),
    recordNonce(RECORD, { command: 'write', retry: true }),
    recordNonce(RECORD, { command: 'write', attempt: 1 }),
  ]
  assert.equal(new Set([n, ...others]).size, 6)
  assert.equal(recordNonce(RECORD, { command: 'write', attempt: 0 }), n, 'attempt 0 is the first dispatch')
})

test('the prompt is the first user line, its content a string or an array of text blocks', () => {
  const asLines = (/** @type {unknown} */ content) =>
    [{ type: 'x' }, 'not json', { type: 'user', message: { content } }].map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')
  assert.equal(transcriptPrompt(asLines('hello')), 'hello')
  assert.equal(transcriptPrompt(asLines([{ type: 'text', text: 'hel' }, { type: 'image' }, { text: 'lo' }])), 'hello')
  assert.equal(transcriptPrompt('{"type":"assistant"}'), '')
})

test('the record is the JSON after the last RECORD or PAYLOAD heading, up to its closing brace', () => {
  const prompt = logRunPrompt({ record: RECORD })
  assert.deepEqual(JSON.parse(promptRecordText(`${prompt}\n\nappended by the harness`)), RECORD)
  assert.deepEqual(JSON.parse(promptRecordText(checkpointPrompt({ payload: RECORD, phase: 'p' }))), RECORD)
  assert.equal(promptRecordText('no heading'), '')
})

test('found in this session: the record of the one prompt carrying the nonce', () => {
  const home = tmp()
  const prompt = logRunPrompt({ record: RECORD })
  agentTranscript(home, { content: prompt })
  agentTranscript(home, { agent: 'other', content: logRunPrompt({ record: { other: 1 } }) })
  const nonce = recordNonce(RECORD, CALL)
  const got = readRecordFromTranscript(nonce, { claudeHome: home, sessionId: 'sess-1', call: CALL })
  assert.ok('text' in got, JSON.stringify(got))
  assert.deepEqual(JSON.parse(got.text), RECORD)
})

test('content as an array of text blocks is read the same', () => {
  const home = tmp()
  const prompt = checkpointPrompt({ payload: RECORD, phase: 'gate' })
  agentTranscript(home, {
    content: [
      { type: 'text', text: prompt.slice(0, 100) },
      { type: 'text', text: prompt.slice(100) },
    ],
  })
  const call = { command: 'checkpoint', phase: 'gate' }
  const got = readRecordFromTranscript(recordNonce(RECORD, call), { claudeHome: home, sessionId: 'sess-1', call })
  assert.ok('text' in got, JSON.stringify(got))
})

test("with no session id (or none matching) the recent transcripts of every project are searched; old ones nowhere, the session's own included", () => {
  const home = tmp()
  const file = agentTranscript(home, { slug: '-elsewhere', session: 'sess-9', content: logRunPrompt({ record: RECORD }) })
  const nonce = recordNonce(RECORD, CALL)
  assert.ok('text' in readRecordFromTranscript(nonce, { claudeHome: home, call: CALL }))
  assert.ok('text' in readRecordFromTranscript(nonce, { claudeHome: home, sessionId: 'sess-1', call: CALL }))
  const old = (Date.now() - TRANSCRIPT_RECENT_MS - 60_000) / 1000
  fs.utimesSync(file, old, old)
  assert.match(miss(readRecordFromTranscript(nonce, { claudeHome: home, call: CALL })), /^0 agent transcripts/)
  // The session's own directory is bounded the same way: an old transcript there is not read either.
  assert.match(miss(readRecordFromTranscript(nonce, { claudeHome: home, sessionId: 'sess-9', call: CALL })), /^0 agent transcripts/)
})

/** @param {import('./transcript-record.mjs').TranscriptRecord} got */
const miss = got => ('miss' in got ? got.miss : '')

test('exactly one: none, two, a nonce only in a later line, and a linked copy', () => {
  const home = tmp()
  const nonce = recordNonce(RECORD, CALL)
  const o = { claudeHome: home, sessionId: 'sess-1', call: CALL }
  assert.match(miss(readRecordFromTranscript(nonce, o)), /^0 agent transcripts under .* carry craft-/)
  const first = agentTranscript(home, { content: logRunPrompt({ record: RECORD }) })
  // A linked copy of the same file is the same transcript.
  fs.symlinkSync(first, path.join(path.dirname(first), 'agent-link.jsonl'))
  assert.ok('text' in readRecordFromTranscript(nonce, o))
  // The nonce in an assistant line only (a command the agent ran) is not a prompt carrying it.
  agentTranscript(home, { agent: 'a2', content: 'some other prompt' })
  fs.appendFileSync(path.join(path.dirname(first), 'agent-a2.jsonl'), `${JSON.stringify({ type: 'assistant', message: { content: nonce } })}\n`)
  assert.ok('text' in readRecordFromTranscript(nonce, o))
  agentTranscript(home, { run: 'wf_2', content: logRunPrompt({ record: RECORD }) })
  assert.match(miss(readRecordFromTranscript(nonce, o)), /^2 agent transcripts/)
})

test('a malformed nonce, an unparsable record, a non-object and a record its nonce does not name are misses', () => {
  const home = tmp()
  assert.match(miss(readRecordFromTranscript('craft-zz', { claudeHome: home, call: CALL })), /not a record nonce/)
  const nonce = recordNonce(RECORD, CALL)
  const o = { claudeHome: home, sessionId: 'sess-1', call: CALL }
  agentTranscript(home, { content: `NONCE: ${nonce}\nRECORD:\n{ "a": ` })
  assert.match(miss(readRecordFromTranscript(nonce, o)), /does not parse/)
  agentTranscript(home, { content: `NONCE: ${nonce}\nRECORD:\n[1]` })
  assert.match(miss(readRecordFromTranscript(nonce, o)), /not a JSON object/)
  agentTranscript(home, { content: `NONCE: ${nonce}\nRECORD:\n{ "forged": true }` })
  assert.match(miss(readRecordFromTranscript(nonce, o)), /not the one craft-[0-9a-f]{16} names/)
  assert.ok(TRANSCRIPT_MISS.startsWith('craft-log-run '))
})
