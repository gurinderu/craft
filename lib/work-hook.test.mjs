import { test } from 'vitest'
import assert from 'node:assert/strict'
import { SWITCH_ENV } from './role-hook.mjs'
import { CODEX_PROMPT_TEXT, CODEX_SUBAGENT_TEXT, FINDINGS_TEXT, REVIEW_TEXT, SUBAGENT_TEXT, workText } from './work-hook-text.mjs'
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

test('the Claude Code texts per kind: one call first, one reason, a verbatim brief line, the launcher holds the memory', () => {
  const counts = [[FINDINGS_TEXT, 5], [REVIEW_TEXT, 5], [SUBAGENT_TEXT, 5]]
  for (const [text, n] of /** @type {[string, number][]} */ (counts)) {
    assert.equal(text.split('\n').length, n, text)
    assert.ok(text.split('\n').every(l => l.startsWith('craft: ')))
    assert.ok(text.includes(`${SWITCH_ENV}=0`))
  }
  for (const text of [FINDINGS_TEXT, REVIEW_TEXT]) {
    assert.ok(text.startsWith('craft: before your first tool call'))
    for (const name of ['craft: why:', 'main session', 'record-decision', 'record-rule', 'record-question', 'memory backend:']) assert.ok(text.includes(name), name)
    // Subagents lack the memory tools: the launcher briefs the records and records their verdicts (skills/memory, "Subagents").
    assert.match(text, /put the records craft:memory recalls, verbatim with their ids, into each brief, and record each finding you or a subagent reject or defer/)
  }
  // Findings: one call, a brief line that sends the subagent into the skill and has it report, not record (#288).
  assert.match(FINDINGS_TEXT, /^craft: before your first tool call on this request, make one call: Skill\("craft:addressing-findings"\)\./)
  assert.match(FINDINGS_TEXT, /re-review loop stays with this main session/)
  assert.match(FINDINGS_TEXT, /paste this line verbatim into each subagent's brief: "[^"]*craft:addressing-findings[^"]*report each finding you reject or defer, with its reason, in your result; your launcher records it\."/)
  assert.doesNotMatch(FINDINGS_TEXT, /craft:develop/)
  // Review: develop or the review workflow, both in the main session; a delegated reviewer only reports.
  assert.match(REVIEW_TEXT, /make one call, here in the main session: Skill\("craft:develop"\) for the review loop up to a PR, or the craft:review workflow for one pass\. Never hand either to a subagent/)
  assert.match(REVIEW_TEXT, /at most 4 rounds, then it stops[^;]*\), then one full review before the PR/)
  assert.match(REVIEW_TEXT, /paste this line verbatim into its brief: "Review only: report findings only, change no code and record nothing; [^"]*"/)
  assert.doesNotMatch(REVIEW_TEXT, /addressing-findings/)
  const sub = SUBAGENT_TEXT.split('\n')
  for (const work of ['triaging PR comments', 'posting replies to review threads', 'fixing per review comments']) assert.ok(sub[0]?.includes(work), work)
  assert.match(sub[0] ?? '', /before your first tool call, run Skill\("craft:addressing-findings"\)/)
  assert.match(SUBAGENT_TEXT, /you lack the memory tools: the records your launcher recalled are in your brief; report each finding you reject or defer, with its reason, in your result/)
  assert.doesNotMatch(SUBAGENT_TEXT, /record-decision|record each/)
  assert.match(SUBAGENT_TEXT, /brief is only to review: report findings only, change no code and record nothing/)
})

test('the harness: Codex by turn_id or its PLUGIN_ROOT, Claude Code otherwise (its SessionStart carries model too)', () => {
  assert.equal(harness({ hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'x' }, {}), 'codex')
  assert.equal(harness({ hook_event_name: 'SessionStart', model: 'gpt-5' }, { PLUGIN_ROOT: '/p' }), 'codex')
  assert.equal(harness({ hook_event_name: 'SessionStart', model: 'claude-opus-5-5' }, { CLAUDE_PLUGIN_ROOT: '/p' }), 'claude-code')
  assert.equal(harness({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', turn_id: '' }, {}), 'claude-code')
})

test('the Codex texts send the session to SKILL.md, never to a Claude Code tool; findings may be delegated, a review stays here', () => {
  assert.deepEqual(workText('claude-code'), { prompt: FINDINGS_TEXT, subagent: SUBAGENT_TEXT })
  assert.deepEqual(workText('claude-code', 'findings'), { prompt: FINDINGS_TEXT, subagent: SUBAGENT_TEXT })
  assert.deepEqual(workText('claude-code', 'review'), { prompt: REVIEW_TEXT, subagent: SUBAGENT_TEXT })
  assert.deepEqual(workText('codex', 'review'), { prompt: CODEX_PROMPT_TEXT, subagent: CODEX_SUBAGENT_TEXT })
  assert.deepEqual(workText('codex', 'findings'), { prompt: CODEX_PROMPT_TEXT, subagent: CODEX_SUBAGENT_TEXT })
  assert.equal(CODEX_PROMPT_TEXT.split('\n').length, 4)
  assert.equal(CODEX_SUBAGENT_TEXT.split('\n').length, 2)
  for (const text of [CODEX_PROMPT_TEXT, CODEX_SUBAGENT_TEXT]) {
    for (const banned of ['Skill tool', 'Workflow', 'workflow', 'craft:develop', 'craft:review ']) assert.ok(!text.includes(banned), banned)
    for (const name of ['SKILL.md', 'craft:addressing-findings', `${SWITCH_ENV}=0`]) assert.ok(text.includes(name), name)
    assert.ok(text.split('\n').every(l => l.startsWith('craft: ')))
  }
  for (const name of ['craft:memory', 'record-decision', 'record-rule', 'record-question', 'memory backend:']) assert.ok(CODEX_PROMPT_TEXT.includes(name), name)
  // No review agent to dispatch: the session reviews, with a rubric for Rust or Nix and without one otherwise.
  assert.match(CODEX_PROMPT_TEXT, /craft ships no review agents or engines to Codex, so review the diff in this session yourself, not in a subagent/)
  assert.match(CODEX_PROMPT_TEXT, /craft:rust-review \(Rust\) or craft:nix-review \(Nix\), otherwise read the diff for defects/)
  assert.match(CODEX_PROMPT_TEXT, /findings by severity with file:line/)
  // Only findings work is delegated; the launcher briefs the records and records the subagent's verdicts.
  assert.match(CODEX_PROMPT_TEXT, /findings work may go to a subagent with these same instructions in its brief, plus the records craft:memory recalls; record each rejection or deferral it reports\. A review stays in this session\./)
  assert.doesNotMatch(CODEX_PROMPT_TEXT, /delegating this/)
  assert.match(CODEX_SUBAGENT_TEXT, /report each finding you reject or defer, with its reason, in your result; your launcher records it/)
  assert.doesNotMatch(CODEX_SUBAGENT_TEXT, /craft:memory/)
  assert.match(CODEX_SUBAGENT_TEXT, /brief is to review: report findings only, change no code/)
})
