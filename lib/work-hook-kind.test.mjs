import { test } from 'vitest'
import assert from 'node:assert/strict'
import { promptKind } from './work-hook-kind.mjs'

test('findings and PR-comment requests are the findings class', () => {
  for (const p of [
    'address the review findings on #42',
    'Work through the findings from the last run',
    'please fix the PR comments',
    'there are comments on the PR, handle them',
    'resolve review feedback',
    'Fix the review and push',
    'check the PR for new comments',
    'PR comments',
    'review comments on the parser',
    'fix the review findings',
    'address the feedback',
    'address the reviewer\'s feedback',
    'address the feedback on the parser',
    'check the open PRs for new comments',
    'address the comments on the open PR',
    'fix the MR comments',
    'there are new comments in the merge request',
  ]) assert.equal(promptKind(p), 'findings', p)
})

test('review and PR requests, by word or by URL, are the review class', () => {
  for (const p of [
    'review this branch',
    'Can you do a code review?',
    'open a PR when done',
    'what about the pull request',
    '/craft:review',
    'open an MR for it',
    'look at https://github.com/acme/app/pull/12',
    'see https://gitlab.com/acme/app/-/merge_requests/7',
  ]) assert.equal(promptKind(p), 'review', p)
})

test('a fix or comment word beside a PR the request makes is the work itself, not feedback', () => {
  for (const [p, kind] of /** @type {[string, 'review' | null][]} */ ([
    ['fix the bug and open a PR', 'review'],
    ['add comments to the parser and open a PR', 'review'],
    ['fix lint and push the PR', 'review'],
    ['add doc comments and create a PR', 'review'],
    // A Latin lowercase "pr" is no PR word: it stands in paths and commands ("lib/pr.mjs", "gh pr view").
    ['add doc comments and create a pr', null],
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
    'fix the feedback form validation',
    'add a comments section to the feedback page',
    'fix the reviewers list in CODEOWNERS',
    'greet Mr Smith',
    '',
  ]) assert.equal(promptKind(p), null, p)
})

// Non-Latin samples are built from code points: the hook's sources carry English only. Words are space-separated,
// letters dot-separated hex.
/** @param {string} hex @returns {string} */
const u = hex => hex.split(' ').map(w => String.fromCodePoint(...w.split('.').map(h => parseInt(h, 16)))).join(' ')
// Greek "fix the comments in the PR".
const GREEK = `${u('3b4.3b9.3cc.3c1.3b8.3c9.3c3.3b5 3c4.3b1 3c3.3c7.3cc.3bb.3b9.3b1 3c3.3c4.3bf')} PR`
// The observed continuation (#287): Russian "finish the work please".
const FINISH_RU = u('434.43e.434.435.43b.430.439 440.430.431.43e.442.443 43f.43b.438.437')
// Japanese "please review".
const JAPANESE = u('30ec.30d3.30e5.30fc.3057.3066.304f.3060.3055.3044')

test('a prompt mostly in another script is other-language, whatever English words it carries; a foreign name in English is not', () => {
  for (const p of [GREEK, FINISH_RU, JAPANESE, `${FINISH_RU}, review`]) {
    assert.equal(promptKind(p), 'other-language', p)
    assert.equal(promptKind(p, 'findings'), 'other-language', 'a recent kind does not reach it')
  }
  assert.equal(promptKind('review the parser for Zoë'), 'review', 'Latin letters with diacritics are Latin')
  assert.equal(promptKind(`review the strings in i18n/el.json, e.g. ${u('3bd.3b1.3b9')}`), 'review', 'a short quote')
  assert.equal(promptKind(u('3b1.3b2')), null, 'too few letters to call')
})

test('a background agent\'s result handed back as a prompt is not a request, whatever its words', () => {
  assert.equal(promptKind('<task-notification>\n<result>review findings: 3</result>\n</task-notification>'), null)
})
