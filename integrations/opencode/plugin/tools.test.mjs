// The tools the plugin registers: the review runs the craft binary through bin/craft (here onto a fake binary named
// by CRAFT_BIN) on the caller's model, and the audit and the triage nest their children under the caller.
import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeExecutable } from '../../../lib/write-executable.mjs'
import { TOOLS, nestedUnder } from './tools.ts'

/** @param {import('./host.ts').ModelRef} [model] @returns {import('./host.ts').Host & { asked: import('./host.ts').ChildRequest[] }} */
function fakeHost(model) {
  /** @type {import('./host.ts').ChildRequest[]} */
  const asked = []
  return {
    asked, directory: os.tmpdir(), worktree: os.tmpdir(), sh: async () => '', callerModel: async () => model,
    runChild: async req => { asked.push(req); return 'done' },
  }
}

const saved = { bin: process.env['CRAFT_BIN'], models: process.env['CRAFT_OPENCODE_MODELS'] }
afterEach(() => {
  if (saved.bin === undefined) delete process.env['CRAFT_BIN']
  else process.env['CRAFT_BIN'] = saved.bin
  if (saved.models === undefined) delete process.env['CRAFT_OPENCODE_MODELS']
  else process.env['CRAFT_OPENCODE_MODELS'] = saved.models
})

/** A fake binary that keeps its argv beside itself and prints a run's events and answer. @returns {string} its argv file */
function fakeBinary() {
  const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-oc-')), 'craft')
  const round = JSON.stringify({ type: 'round', round: 1, phase: 'lenses', tasks: 1 })
  const result = JSON.stringify({ type: 'result', verdict: 'Approve', report: '/r/report.md', run: '/r', findings: 0, exit_code: 0 })
  writeExecutable(bin, `#!/bin/sh\necho "$*" > "$(dirname "$0")/argv"\necho '${round}' >&2\necho '${result}' >&2\nprintf '## Verdict\\n\\n✅ Approve\\n'\n`)
  process.env['CRAFT_BIN'] = bin
  return path.join(path.dirname(bin), 'argv')
}

test('the review runs the binary with the opencode backend on the caller\'s model, its progress the title, its answer titled', async () => {
  const argv = fakeBinary()
  const review = TOOLS.find(t => t.name === 'review')
  /** @type {string[]} */
  const titles = []
  const answer = await review?.run(fakeHost({ providerID: 'p', modelID: 'm' }), { args: '--base main' }, { sessionID: 'ses_caller', progress: t => titles.push(t) })
  assert.equal(fs.readFileSync(argv, 'utf8').trim(), 'review run --backend opencode --events json --base main --models p/m')
  assert.deepEqual(titles, ['craft review: lenses, round 1 — 0 running, 0 done'])
  assert.deepEqual(answer, { title: 'craft review: Approve', output: '## Verdict\n\n✅ Approve' })
})

test('flags that name the models keep them, and a call with no session runs on opencode\'s own model', async () => {
  const argv = fakeBinary()
  const review = TOOLS.find(t => t.name === 'review')
  await review?.run(fakeHost({ providerID: 'p', modelID: 'm' }), { args: '--models=a/b' }, { sessionID: 'ses_caller' })
  assert.equal(fs.readFileSync(argv, 'utf8').trim(), 'review run --backend opencode --events json --models=a/b')
  await review?.run(fakeHost({ providerID: 'p', modelID: 'm' }), {}, {})
  assert.equal(fs.readFileSync(argv, 'utf8').trim(), 'review run --backend opencode --events json')
})

test('CRAFT_OPENCODE_MODELS keeps the session model off the flags: the binary maps the tiers from it', async () => {
  const argv = fakeBinary()
  process.env['CRAFT_OPENCODE_MODELS'] = 'a/b'
  const review = TOOLS.find(t => t.name === 'review')
  await review?.run(fakeHost({ providerID: 'p', modelID: 'm' }), { args: '--base main' }, { sessionID: 'ses_caller' })
  assert.equal(fs.readFileSync(argv, 'utf8').trim(), 'review run --backend opencode --events json --base main')
})

test('the plugin offers the review beside the audit and the triage', () => {
  assert.deepEqual(TOOLS.map(t => t.name), ['rust-audit', 'triage-findings', 'review'])
})

test('the audit and the triage nest their children under the caller too, and keep the rest of the host', async () => {
  const host = fakeHost()
  const nested = nestedUnder(host, 'ses_caller')
  await nested.runChild({ title: 't', agent: 'rust-reviewer', prompt: 'x' })
  assert.equal(host.asked[0]?.parentID, 'ses_caller')
  assert.equal(nested.directory, os.tmpdir())
  assert.equal(nestedUnder(host, undefined), host, 'no caller: the host as it is')
})
