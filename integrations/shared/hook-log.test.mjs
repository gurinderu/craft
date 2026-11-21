import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hookLogPath, readHookLog, renderHookSection } from './hook-log.mjs'

/** @type {string[]} */
const made = []
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})
const tmp = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-hook-log-')))
  made.push(d)
  return d
}

/** @param {Partial<import('./hook-log.mjs').HookEntry>} e @returns {import('./hook-log.mjs').HookEntry} */
const entry = e => ({ ts: '2026-10-20T12:00:00.000Z', repo: '/r/a', source: 'startup', spoke: true, found: ['AGENTS.md'], silent: null, ...e })

/** Lines as the craft binary appends them (cli/bin/craft/src/hook/role/entry.rs). @param {string} file @param {string[]} lines */
const write = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, lines.map(l => `${l}\n`).join(''))
}

test('the log reads back under ~/.craft, the older generation first; a torn line is skipped; no file reads as null', () => {
  const file = hookLogPath(tmp())
  assert.equal(readHookLog(file), null)
  write(`${file}.1`, [JSON.stringify(entry({ repo: '/old' }))])
  write(file, [JSON.stringify(entry({})), '{"torn', JSON.stringify(entry({ spoke: false, found: [], silent: 'off-env' }))])
  assert.deepEqual(
    readHookLog(file)?.map(e => [e.repo, e.silent]),
    [
      ['/old', null],
      ['/r/a', null],
      ['/r/a', 'off-env'],
    ],
  )
})

test('the report section: firings against silences by reason, review runs joined by repo and time', () => {
  assert.match(renderHookSection(null, []).join('\n'), /No hook log/)
  const entries = [
    entry({}),
    entry({ repo: '/r/b', spoke: false, found: [], silent: 'nothing-declared' }),
    entry({ repo: '/r/c', spoke: false, found: [], silent: 'nothing-declared' }),
    entry({ spoke: false, found: [], silent: 'off-env' }),
  ]
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
  assert.match(text, /review runs after the start hook \(SessionStart\) spoke in their repo: 2 of 5 \(1 repo\(s\)\)/)
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
  assert.equal(lines[1], '## craft hooks')
  assert.deepEqual(lines.slice(2, 5), [
    '- SessionStart: 1 run(s) — spoke 1, silent 0',
    '- SubagentStart: 1 run(s) — spoke 1, silent 0',
    '- UserPromptSubmit: 2 run(s) — spoke 1, silent 1 (already-said 1)',
  ])
})

test('only a SessionStart line that spoke starts the review-run join; the other events do not', () => {
  const records = [{ kind: 'workflow', project: '/r/a', ts: '2026-10-21T08-00-00Z' }]
  const promptOnly = [entry({ event: 'UserPromptSubmit', session: 's' }), entry({ spoke: false, found: [], silent: 'nothing-declared' })]
  assert.match(renderHookSection(promptOnly, records).join('\n'), /: 0 of 1 \(0 repo\(s\)\)/)
})

test('the report section splits each event by harness only when more than one harness wrote the log', () => {
  const one = renderHookSection([entry({}), entry({ harness: 'claude-code' })], [])
  assert.equal(one[2], '- SessionStart: 2 run(s) — spoke 2, silent 0')
  const lines = renderHookSection([entry({}), entry({ harness: 'codex' }), entry({ event: 'UserPromptSubmit', harness: 'codex' })], [])
  assert.deepEqual(lines.slice(2, 5), [
    '- SessionStart (claude-code): 1 run(s) — spoke 1, silent 0',
    '- SessionStart (codex): 1 run(s) — spoke 1, silent 0',
    '- UserPromptSubmit (codex): 1 run(s) — spoke 1, silent 0',
  ])
})

test("a line from before the harness field is OpenCode's by an OpenCode event, Claude Code's otherwise", () => {
  const compacted = entry({ event: 'session.compacted', spoke: false, silent: 'context-reset' })
  const lines = renderHookSection([entry({}), entry({ event: 'chat.message' }), compacted, entry({ event: 'UserPromptSubmit', harness: 'codex' })], [])
  assert.deepEqual(lines.slice(2, 6), [
    '- SessionStart (claude-code): 1 run(s) — spoke 1, silent 0',
    '- chat.message (opencode): 1 run(s) — spoke 1, silent 0',
    '- session.compacted (opencode): 1 run(s) — spoke 0, silent 1 (context-reset 1)',
    '- UserPromptSubmit (codex): 1 run(s) — spoke 1, silent 0',
  ])
})

test('a Codex start that said only the readiness lines is its own row and does not start the review-run join', () => {
  const records = [{ kind: 'workflow', project: '/r/a', ts: '2026-10-21T08-00-00Z' }]
  const readinessOnly = entry({ harness: 'codex', found: [], reason: 'codex-readiness', readiness: ['sandbox'] })
  const text = renderHookSection([readinessOnly], records).join('\n')
  assert.match(text, /- SessionStart codex-readiness: 1 run\(s\) — spoke 1, silent 0/)
  assert.match(text, /: 0 of 1 \(0 repo\(s\)\)/)
})

test('the hooks report shows the nudge and the reminder as rows of their own, apart from the request texts', () => {
  const lines = renderHookSection(
    [
      entry({ event: 'UserPromptSubmit', source: '', found: [], kind: 'other-language' }),
      entry({ event: 'UserPromptSubmit', source: '', found: [], reason: 'language-reminder' }),
      entry({ event: 'UserPromptSubmit', source: '', found: [], reason: 'language-reminder' }),
      entry({ event: 'UserPromptSubmit', source: '', found: [], reason: 're-review-nudge' }),
      entry({ event: 'UserPromptSubmit', source: '', found: [], spoke: false, silent: 'no-kind' }),
      entry({ event: 'UserPromptSubmit', source: '', found: [], spoke: false, silent: 'not-human' }),
    ],
    [],
  )
  assert.deepEqual(lines.slice(2, 5), [
    '- UserPromptSubmit: 3 run(s) — spoke 1, silent 2 (no-kind 1, not-human 1)',
    '- UserPromptSubmit language-reminder: 2 run(s) — spoke 2, silent 0',
    '- UserPromptSubmit re-review-nudge: 1 run(s) — spoke 1, silent 0',
  ])
})
