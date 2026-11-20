// The OpenCode reminder line (lib/work-hook-opencode.mjs) and the hooks report's rows for the nudge and the reminder
// lines the craft binary's prompt hook writes (lib/hook-log.mjs).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { OPENCODE_REMINDER_TEXT } from './work-hook-opencode.mjs'
import { renderHookSection } from './hook-log.mjs'

const NOW = new Date('2026-10-21T12:00:00Z')
/** @typedef {import('./hook-log.mjs').HookEntry} HookEntry */
/** A prompt hook line. @param {Partial<HookEntry>} x @returns {HookEntry} */
const line = x => ({ ts: NOW.toISOString(), repo: '/r', source: '', event: 'UserPromptSubmit', session: 's', spoke: true, found: [], silent: null, ...x })

test("the OpenCode reminder line: one line, English only, in OpenCode's words", () => {
  const text = OPENCODE_REMINDER_TEXT
  assert.equal(text.split('\n').length, 1)
  assert.match(
    text,
    /^craft: if this request is about review findings, PR comments or a review, the craft lines above apply: .*addressing-findings.* first for findings; .* for a review; recall memory before triage; before posting replies, run a light re-review of the fix commits only \(base: the commit the review was made on; a merge since it, as trunk merged in, means ask the human first\): .+\.$/,
  )
  assert.doesNotMatch(text, /[^\x20-\x7e]/u)
  assert.match(text, /: the rust-review skill for Rust code, otherwise your own review pass over them in this session\.$/)
  assert.doesNotMatch(text, /Skill\(|Workflow|craft:develop/)
})

test('the hooks report shows the nudge and the reminder as rows of their own, apart from the request texts', () => {
  const lines = renderHookSection(
    [
      line({ kind: 'other-language' }),
      line({ reason: 'language-reminder' }),
      line({ reason: 'language-reminder' }),
      line({ reason: 're-review-nudge' }),
      line({ spoke: false, silent: 'no-kind' }),
      line({ spoke: false, silent: 'not-human' }),
    ],
    [],
  )
  assert.deepEqual(lines.slice(2, 5), [
    '- UserPromptSubmit: 3 run(s) — spoke 1, silent 2 (no-kind 1, not-human 1)',
    '- UserPromptSubmit language-reminder: 2 run(s) — spoke 2, silent 0',
    '- UserPromptSubmit re-review-nudge: 1 run(s) — spoke 1, silent 0',
  ])
})
