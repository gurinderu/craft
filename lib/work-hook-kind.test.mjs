import { test } from 'vitest'
import assert from 'node:assert/strict'
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
    'PR comments',
    'review comments on the parser',
    'fix the review findings',
    'address the feedback',
    'комменты к пр',
    'глянь комменты в пр',
    'замечания по ревью',
    'пофикси по ревью',
    'исправь то, что сказали в пулл-реквесте',
    'address the reviewer\'s feedback',
    'address the feedback on the parser',
    'фидбек по ревью',
    'посмотри фидбек по пр',
    'check the open PRs for new comments',
    'address the comments on the open PR',
    'в открытом пр есть комменты, поправь',
    'посмотри пр 12, там Вася оставил несколько новых комментов',
    'поправь по комментам и запушь пр',
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

test('a fix or comment word beside a PR the request makes is the work itself, not feedback', () => {
  for (const [p, kind] of /** @type {[string, 'review' | null][]} */ ([
    ['fix the bug and open a PR', 'review'],
    ['исправь баг и создай пр', 'review'],
    ['add comments to the parser and open a PR', 'review'],
    ['сделай фичу и открой пр', 'review'],
    ['fix lint and push the PR', 'review'],
    ['add doc comments and create a PR', 'review'],
    // A Latin lowercase "pr" is no PR word: it stands in paths and commands ("lib/pr.mjs", "gh pr view").
    ['add doc comments and create a pr', null],
    ['пофикси линт и открой пулреквест', 'review'],
    ['добавь комментарии к функции и сделай пр', 'review'],
    ['исправь тесты и запушь новый пр', 'review'],
    ['fix the flaky test, then request a review', 'review'],
  ])) assert.equal(promptKind(p), kind, p)
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
    'fix the feedback form validation',
    'add a comments section to the feedback page',
    'исправь форму фидбека',
    'fix the reviewers list in CODEOWNERS',
    'поправь отступы, комменты и пр.',
    'исправь опечатки и пр.',
    '',
  ]) assert.equal(promptKind(p), null, p)
})

test('a background agent\'s result handed back as a prompt is not a request, whatever its words', () => {
  assert.equal(promptKind('<task-notification>\n<result>review findings: 3</result>\n</task-notification>'), null)
})
