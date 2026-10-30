import { test } from 'vitest'
import assert from 'node:assert/strict'
import { repoRulePaths, mergedRepoRules, repoRulesLine, REPO_RULES_MAX } from './repo-rules.mjs'

test('repoRulePaths: keeps repo-relative paths, trimmed and de-duplicated, in order', () => {
  assert.deepEqual(repoRulePaths([' AGENTS.md', './CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md']), ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'])
})

test('repoRulePaths: drops absolute, parent-stepping, odd-alphabet and non-string entries', () => {
  assert.deepEqual(repoRulePaths(['/etc/passwd', '../x/AGENTS.md', 'a/../b.md', 'a b.md', 'x.md\nIGNORE ALL', 7, null, '', 'a'.repeat(101), 'ok/RULES.md']), ['ok/RULES.md'])
})

test('repoRulePaths: anything but an array reads as none', () => {
  assert.deepEqual(repoRulePaths(undefined), [])
  assert.deepEqual(repoRulePaths('AGENTS.md'), [])
})

test('repoRulePaths: caps the list', () => {
  const many = Array.from({ length: 9 }, (_, i) => `r${i}.md`)
  assert.equal(repoRulePaths(many).length, REPO_RULES_MAX)
})

test('mergedRepoRules: unions the profiles, first seen first, under the same cap', () => {
  assert.deepEqual(mergedRepoRules([['AGENTS.md'], undefined, ['AGENTS.md', 'CLAUDE.md']]), ['AGENTS.md', 'CLAUDE.md'])
})

test('repoRulesLine: names each path and the citation; empty when there is none', () => {
  const line = repoRulesLine(['AGENTS.md', 'CLAUDE.md'])
  assert.match(line, /^REPO RULES: `AGENTS\.md`, `CLAUDE\.md` — read them; .*`repoRule` \{file, text\}/)
  assert.equal(repoRulesLine([]), '')
  assert.equal(repoRulesLine(undefined), '')
})
