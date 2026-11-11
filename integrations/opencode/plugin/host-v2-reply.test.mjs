// A 2.x child session's reply deadline, against a fake `ctx` whose session never finishes (the hang seen on 2.2.7).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { finishedReply, noReplyText, replyDeadlineMs } from './host-v2-reply.ts'
import { v2Host } from './host-v2.ts'
import { reviewChild } from './tools.ts'
import { runTask } from '../../../lib/opencode-review-task.mjs'
import { runRound, saidSection, heardRound } from '../../../lib/task-process-round.mjs'

const ROOT = path.resolve(import.meta.dirname, '../../..')

/** A session that never finishes: `wait` resolves (or, `hang`, never does) and `context` holds only the prompt. @param {{ hang?: boolean }} [o] */
function stuckCtx({ hang = false } = {}) {
  /** @type {unknown[][]} */
  const sent = []
  const ctx = /** @type {import('./opencode-v2.js').V2Context} */ (/** @type {unknown} */ ({
    location: { directory: '/repo' },
    session: {
      create: async () => { sent.push(['create']); return { id: 'ses_1' } },
      prompt: async () => { sent.push(['prompt']) },
      wait: () => (sent.push(['wait']), hang ? new Promise(() => {}) : Promise.resolve()),
      context: async () => [{ type: 'user' }],
      interrupt: async (/** @type {unknown} */ input) => { sent.push(['interrupt', input]); return { interrupted: true } },
    },
  }))
  return { ctx, sent, count: (/** @type {string} */ name) => sent.filter(s => s[0] === name).length }
}

test('only a finished assistant turn is a reply', () => {
  assert.equal(finishedReply([]), null)
  assert.equal(finishedReply([{ type: 'user' }]), null)
  assert.equal(finishedReply([{ type: 'assistant', content: [{ type: 'text', text: 'half' }] }]), null, 'still streaming')
  assert.equal(finishedReply([{ type: 'assistant', time: { created: 1, completed: 2 } }]), '', 'finished, said nothing')
  assert.equal(finishedReply([{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: ' a ' }] }]), 'a')
})

test('the reply deadline is CRAFT_OPENCODE_REPLY_MIN minutes, five when it names no positive number', () => {
  assert.equal(replyDeadlineMs({}), 300000)
  assert.equal(replyDeadlineMs({ CRAFT_OPENCODE_REPLY_MIN: '2' }), 120000)
  assert.equal(replyDeadlineMs({ CRAFT_OPENCODE_REPLY_MIN: '0' }), 300000)
  assert.equal(replyDeadlineMs({ CRAFT_OPENCODE_REPLY_MIN: 'soon' }), 300000)
  assert.equal(noReplyText(300000), 'no reply from OpenCode 2.x child session within 5 min')
})

test('a session that never finishes is interrupted at the reply deadline and fails with the named error', async () => {
  const f = stuckCtx()
  await assert.rejects(v2Host(f.ctx, 1, 30).runChild({ title: 't', agent: '', prompt: 'p' }), { message: noReplyText(30) })
  assert.equal(f.count('interrupt'), 1)
  const polls = f.count('wait')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(f.count('wait'), polls, 'the polling stops with the deadline')
})

test('a `wait` that never returns still ends: at the reply deadline, and at the caller\'s own (clamped) deadline', async () => {
  const hung = stuckCtx({ hang: true })
  await assert.rejects(v2Host(hung.ctx, 1, 60000).runChild({ title: 't', agent: '', prompt: 'p', deadlineMs: 30 }), { message: noReplyText(30) })
  assert.equal(hung.count('interrupt'), 1)
  const stop = new AbortController()
  const caller = stuckCtx({ hang: true })
  const run = v2Host(caller.ctx, 1, 60000).runChild({ title: 't', agent: '', prompt: 'p', signal: stop.signal })
  setTimeout(() => stop.abort(), 10)
  await assert.rejects(run, /stopped at its deadline/)
  assert.equal(caller.count('interrupt'), 1)
})

test('a review task past its reply deadline is not tried again, and its error is what the agents said', async () => {
  const f = stuckCtx()
  await assert.rejects(reviewChild(v2Host(f.ctx, 1, 20), undefined, undefined)({ title: 't', agent: '', prompt: 'p' }), { message: noReplyText(20) })
  assert.equal(f.count('create'), 1, 'a deadline failure is not the empty reply the retry is for')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-oc-reply-'))
  try {
    fs.writeFileSync(path.join(dir, 'p.md'), 'TASK')
    fs.writeFileSync(path.join(dir, 's.json'), '{}')
    const t = { id: 'scout-rust', label: 'scout:rust', kind: 'scout', model: 'haiku', promptFile: path.join(dir, 'p.md'), schemaFile: path.join(dir, 's.json'), answerFile: path.join(dir, 'a', 't.json') }
    const g = stuckCtx()
    const runChild = reviewChild(v2Host(g.ctx, 1, 20), undefined, undefined)
    const ctx = { concurrency: 1, host: 'OpenCode', log: () => {}, runTask: (/** @type {any} */ task) => runTask(task, { runChild, pluginRoot: ROOT, repo: dir, models: new Map() }) }
    const round = await runRound(/** @type {any} */ ([t]), 1, ctx, { limit: '', login: '' })
    assert.equal(round.allDied, true)
    const r = { spent: { agents: 0 }, said: new Map(), allDied: false }
    heardRound(r, round)
    assert.match(saidSection(r.said), /## What the agents said[\s\S]*1 task\(s\): `no reply from OpenCode 2\.x child session within 0\.00033 min`/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
