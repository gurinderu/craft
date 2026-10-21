import { test } from 'vitest'
import assert from 'node:assert/strict'
import { SWITCH_ENV } from './role-hook.mjs'
import { CODEX_PROMPT_TEXT, CODEX_SUBAGENT_TEXT, PROMPT_TEXT, SUBAGENT_TEXT, workText } from './work-hook-text.mjs'
import { harness } from './hook-harness.mjs'
import { promptKind } from './work-hook-kind.mjs'

test('findings and PR-comment requests, in English and Russian, are the findings class', () => {
  for (const p of [
    'address the review findings on #42',
    'Work through the findings from the last run',
    'please fix the PR comments',
    'there are comments on the PR, handle them',
    'resolve review feedback',
    'Fix the review and push',
    'разбери находки ревью',
    'поправь замечания',
    'ответь на комментарии к PR',
    'посмотри комментарии к пулреквесту',
    'нужны фиксы по ревью',
    'пофикси по комментариям',
    'посмотри пр на предмет новых комментов',
    'посмотри на другие пр, там есть ревью и что нужно пофиксить?',
    'check the PR for new comments',
    'поправь то, что написали в ревью',
  ]) assert.equal(promptKind(p), 'findings', p)
})

test('review and PR requests, in English and Russian, are the review class', () => {
  for (const p of [
    'review this branch',
    'Can you do a code review?',
    'open a PR when done',
    'what about the pull request',
    'сделай ревью ветки',
    'отдай на ревьюера',
    'открой пулл-реквест',
    '/craft:review',
    'что там по моему пр',
    'смержи пры',
  ]) assert.equal(promptKind(p), 'review', p)
})

test('ordinary coding talk is no class', () => {
  for (const p of [
    'fix the failing test',
    'add comments to this function',
    'preview the page',
    'I reviewed the plan yesterday; now implement step 2',
    'print the PRODUCT table',
    'зафиксируй решение в графе',
    'фиксация версий в lockfile',
    'пофикси тест',
    'добавь комментарии в код',
    'замечательно, продолжай',
    'и пр.',
    'пофикси прод',
    'посмотри комменты в коде',
    '',
  ]) assert.equal(promptKind(p), null, p)
})

test('a background agent\'s result handed back as a prompt is not a request, whatever its words', () => {
  assert.equal(promptKind('<task-notification>\n<result>review findings: 3</result>\n</task-notification>'), null)
})

test('the texts: four imperative prompt lines, three subagent lines, naming the skills, memory verbs and off switch', () => {
  const lines = PROMPT_TEXT.split('\n')
  assert.equal(lines.length, 4)
  assert.ok(PROMPT_TEXT.startsWith('craft: before your first tool call'))
  for (const name of ['craft:addressing-findings', 'craft:review workflow', 'craft:develop', 'craft:memory', 'record-decision', 'record-rule', 'record-question', 'memory backend:', 'brief', 'main session', `${SWITCH_ENV}=0`]) {
    assert.ok(PROMPT_TEXT.includes(name), name)
  }
  assert.ok(lines.every(l => l.startsWith('craft: ')))
  const sub = SUBAGENT_TEXT.split('\n')
  assert.equal(sub.length, 3)
  for (const name of ['craft:addressing-findings', 'craft:memory', 'record-question', 'main session', `${SWITCH_ENV}=0`]) assert.ok(SUBAGENT_TEXT.includes(name), name)
  // A reviewer subagent is not sent into the fix loop: the review case has its own clause (realm @nick/craft, #288).
  assert.ok(/brief is to work review findings[^;]*craft:addressing-findings/.test(sub[0] ?? ''), sub[0])
  assert.ok(/brief is to review: report findings only, change no code/.test(sub[0] ?? ''), sub[0])
})

test('the harness: Codex by turn_id or its PLUGIN_ROOT, Claude Code otherwise (its SessionStart carries model too)', () => {
  assert.equal(harness({ hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'x' }, {}), 'codex')
  assert.equal(harness({ hook_event_name: 'SessionStart', model: 'gpt-5' }, { PLUGIN_ROOT: '/p' }), 'codex')
  assert.equal(harness({ hook_event_name: 'SessionStart', model: 'claude-opus-5-5' }, { CLAUDE_PLUGIN_ROOT: '/p' }), 'claude-code')
  assert.equal(harness({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', turn_id: '' }, {}), 'claude-code')
})

test('the Codex texts send the session to SKILL.md, never to a Claude Code tool, and keep memory, the brief split and the off switch', () => {
  assert.deepEqual(workText('claude-code'), { prompt: PROMPT_TEXT, subagent: SUBAGENT_TEXT })
  assert.deepEqual(workText('codex'), { prompt: CODEX_PROMPT_TEXT, subagent: CODEX_SUBAGENT_TEXT })
  for (const text of [CODEX_PROMPT_TEXT, CODEX_SUBAGENT_TEXT]) {
    for (const banned of ['Skill tool', 'Workflow', 'workflow', 'craft:develop', 'craft:review ']) assert.ok(!text.includes(banned), banned)
    for (const name of ['SKILL.md', 'craft:addressing-findings', 'craft:memory', 'record-decision', 'record-rule', 'record-question', `${SWITCH_ENV}=0`]) assert.ok(text.includes(name), name)
    assert.ok(text.split('\n').every(l => l.startsWith('craft: ')))
  }
  // No review agent to dispatch: the session reviews, with a rubric for Rust or Nix and without one otherwise.
  assert.match(CODEX_PROMPT_TEXT, /review agents and engines exist only in Claude Code, so review the diff in this session yourself/)
  assert.match(CODEX_PROMPT_TEXT, /craft:rust-review \(Rust\) or craft:nix-review \(Nix\), otherwise read the diff for defects/)
  assert.match(CODEX_PROMPT_TEXT, /findings by severity with file:line/)
  assert.ok(CODEX_PROMPT_TEXT.includes('brief'))
  assert.match(CODEX_SUBAGENT_TEXT, /brief is to review: report findings only, change no code/)
})
