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

test('the texts: one call first, one reason, delegation allowed with a verbatim brief line, memory and off switch', () => {
  const lines = PROMPT_TEXT.split('\n')
  assert.ok(lines.length <= 5, String(lines.length))
  assert.ok(lines.every(l => l.startsWith('craft: ')))
  assert.ok(PROMPT_TEXT.startsWith('craft: before your first tool call'))
  for (const name of ['Skill("craft:addressing-findings")', 'Skill("craft:develop")', 'craft:review workflow', 'craft: why:', 'craft:memory', 'record-decision', 'record-rule', 'record-question', 'memory backend:', 'main session', `${SWITCH_ENV}=0`]) {
    assert.ok(PROMPT_TEXT.includes(name), name)
  }
  // Delegation does not argue with the session's rules: the skill loads here, a quoted line goes into each brief
  // (realm @nick/craft, #288).
  assert.match(PROMPT_TEXT, /delegating is fine: load the skill here first, then paste this line verbatim into each subagent's brief: "[^"]*craft:addressing-findings[^"]*craft:memory\."/)
  assert.doesNotMatch(PROMPT_TEXT, /keep the review loop here/)
  const sub = SUBAGENT_TEXT.split('\n')
  assert.ok(sub.length <= 5, String(sub.length))
  assert.ok(sub.every(l => l.startsWith('craft: ')))
  for (const name of ['Skill("craft:addressing-findings")', 'craft:memory', 'record-question', 'main session', `${SWITCH_ENV}=0`]) assert.ok(SUBAGENT_TEXT.includes(name), name)
  // Triage, replies and fixes per comments are findings work; a reviewer subagent is not sent into the fix loop (#288).
  for (const work of ['triaging PR comments', 'posting replies to review threads', 'fixing per review comments']) assert.ok(sub[0]?.includes(work), work)
  assert.match(sub[0] ?? '', /before your first tool call, run Skill\("craft:addressing-findings"\)/)
  assert.match(SUBAGENT_TEXT, /brief is only to review: report findings only, change no code and record nothing/)
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
  assert.match(CODEX_PROMPT_TEXT, /need Claude Code and are not available here/)
  assert.ok(CODEX_PROMPT_TEXT.includes('brief'))
  assert.match(CODEX_SUBAGENT_TEXT, /brief is to review: report findings only, change no code/)
})
