import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hookLogPath, readHookLog } from './hook-log.mjs'
import { hookEntryRun } from './hook-entry-run.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-hook-entry-'))
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

const entry = { ts: 't', repo: 'r', source: '', spoke: true, found: [], silent: null, event: 'PreToolUse' }

test('prints what the decision says and logs its entry; no entry logs nothing; a throw is silence', () => {
  assert.deepEqual(hookEntryRun(input => ({ stdout: `said ${input}`, entry }), () => 'x', home), { exitCode: 0, stdout: ['said x'], stderr: [] })
  assert.deepEqual(hookEntryRun(() => ({ stdout: '', entry: null }), () => 'x', home), { exitCode: 0, stdout: [], stderr: [] })
  assert.deepEqual(hookEntryRun(() => { throw new Error('boom') }, () => 'x', home), { exitCode: 0, stdout: [], stderr: [] })
  assert.deepEqual(readHookLog(hookLogPath(home)), [entry])
})
