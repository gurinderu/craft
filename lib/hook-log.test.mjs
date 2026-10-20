import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendHookLog, hookLogPath, readHookLog, renderHookSection, repoKey } from './hook-log.mjs'

/** @type {string[]} */
const made = []
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-hook-log-'))); made.push(d); return d }

/** @param {Partial<import('./hook-log.mjs').HookEntry>} e @returns {import('./hook-log.mjs').HookEntry} */
const entry = e => ({ ts: '2026-10-20T12:00:00.000Z', repo: '/r/a', source: 'startup', spoke: true, found: ['AGENTS.md'], silent: null, ...e })

test('entries append under ~/.craft and read back; a torn line is skipped; no file reads as null', () => {
  const file = hookLogPath(tmp())
  assert.equal(readHookLog(file), null)
  appendHookLog(entry({}), file)
  fs.appendFileSync(file, '{"torn\n')
  appendHookLog(entry({ spoke: false, found: [], silent: 'off-env' }), file)
  assert.deepEqual(readHookLog(file)?.map(e => e.silent), [null, 'off-env'])
})

test('past its cap the log rotates to one older generation, read first', () => {
  const file = hookLogPath(tmp())
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(entry({ repo: '/old' }))}\n${'x'.repeat(300 * 1024)}\n`)
  appendHookLog(entry({ repo: '/new' }), file)
  assert.ok(fs.statSync(file).size < 1024)
  assert.deepEqual(readHookLog(file)?.map(e => e.repo), ['/old', '/new'])
})

test('appending never throws, even where ~/.craft cannot be made', () => {
  const blocker = path.join(tmp(), 'file')
  fs.writeFileSync(blocker, '')
  assert.doesNotThrow(() => appendHookLog(entry({}), hookLogPath(blocker)))
})

test('the repo key is the main checkout for a linked worktree, the root otherwise', () => {
  const main = tmp()
  fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true })
  fs.writeFileSync(path.join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n')
  const wt = tmp()
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`)
  assert.equal(repoKey(wt), main)
  assert.equal(repoKey(main), main)
  const sub = tmp()
  fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../x/.git/modules/s\n')
  assert.equal(repoKey(sub), sub)
})

test('the report section: firings against silences by reason, review runs joined by repo and time', () => {
  assert.match(renderHookSection(null, []).join('\n'), /No hook log/)
  const entries = [entry({}), entry({ repo: '/r/b', spoke: false, found: [], silent: 'nothing-declared' }), entry({ repo: '/r/c', spoke: false, found: [], silent: 'nothing-declared' }), entry({ spoke: false, found: [], silent: 'off-env' })]
  const records = [
    { kind: 'workflow', project: '/r/a', ts: '2026-10-20T12-00-00Z' },
    { kind: 'workflow', project: '/r/a', ts: '2026-10-21T08-00-00Z' },
    { kind: 'workflow', project: '/r/a', ts: '2026-10-20T11-59-59Z' },
    { kind: 'workflow', project: '/r/a' },
    { kind: 'workflow', project: '/r/b', ts: '2026-10-21T08-00-00Z' },
    { kind: 'agent', project: '/r/a', ts: '2026-10-21T08-00-00Z' },
  ]
  const text = renderHookSection(entries, records).join('\n')
  assert.match(text, /- SessionStart: 4 run\(s\) — spoke 1, silent 3 \(nothing-declared 2, off-env 1\)/)
  assert.match(text, /review runs after the hook spoke in their repo: 2 of 5 \(1 repo\(s\)\)/)
  const later = [entry({ ts: '2026-10-22T00:00:00.000Z' }), entry({})]
  assert.match(renderHookSection(later, records).join('\n'), /: 2 of 5/, 'the first spoke line counts, not the last')
})

test('the report section counts each hook event apart, SessionStart first; a line without an event is SessionStart', () => {
  const entries = [
    entry({}),
    entry({ event: 'UserPromptSubmit', session: 's', kind: 'review' }),
    entry({ event: 'UserPromptSubmit', session: 's', kind: 'review', spoke: false, found: [], silent: 'already-said' }),
    entry({ event: 'SubagentStart', session: 's', agent: 'general-purpose' }),
  ]
  const lines = renderHookSection(entries, [])
  assert.deepEqual(lines.slice(2, 5), [
    '- SessionStart: 1 run(s) — spoke 1, silent 0',
    '- SubagentStart: 1 run(s) — spoke 1, silent 0',
    '- UserPromptSubmit: 2 run(s) — spoke 1, silent 1 (already-said 1)',
  ])
})
