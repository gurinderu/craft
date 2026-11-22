// The light re-review after fixes (skills/addressing-findings, step 7; realm @nick/craft, node #12): with the commit
// the addressed review was made on as `base` and `fresh`, craft:review's lenses diff exactly base...HEAD, the fix
// commits, even when an older run on the branch could be chained to. Without `fresh` it chains to that run's head.
// Executed through the engine harness: the lens prompts carry the diff range each lens is told to run.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// base...HEAD is the fix commits only while no merge sits between: a trunk merged in after the review rides along.
// The engine harness scripts git's answers, so a merged history is not observable here; the guard is the session's
// step before the run, checked in the texts that send the session to it.
test('step 7 and the hook texts check for a merge since the reviewed commit before a light re-review', () => {
  const skill = fs.readFileSync(new URL('../../skills/addressing-findings/SKILL.md', import.meta.url), 'utf8')
  const step7 = skill.slice(skill.indexOf('7. Re-review'), skill.indexOf('\n8. '))
  assert.match(step7, /--is-ancestor <that commit> HEAD`[\s\S]*`git rev-list --merges <that commit>\.\.HEAD`[\s\S]*ask[\s\S]*the human/)
  assert.match(step7, /`base: <trunk>`, still `fresh: true`/)
  // The prompt hook's re-review nudge, in each harness's words: the craft binary's, as its parity cases hold it.
  const cases = JSON.parse(fs.readFileSync(new URL('../../content/parity/hook-cases.json', import.meta.url), 'utf8')).cases
  const nudges = cases.filter((/** @type {{ entry: { reason?: string } | null }} */ c) => c.entry?.reason === 're-review-nudge')
  assert.deepEqual([...new Set(nudges.map((/** @type {{ entry: { harness: string } }} */ c) => c.entry.harness))].sort(), ['claude-code', 'codex'])
  for (const c of nudges) assert.match(c.stdout, /a merge since it, as trunk merged in, means ask the human first/)
})

// A re-review round over fix commits runs at depth light (the diff-scoped lenses once, Medium and above verified,
// every prior the chain left open adjudicated whatever the depth); full depth runs in develop's first round and its
// final full review only.
test("develop's later rounds, step 7 and the hook nudges run the re-review at depth light", () => {
  const develop = fs.readFileSync(new URL('../../skills/develop/SKILL.md', import.meta.url), 'utf8')
  const row = (/** @type {string} */ name) => develop.split('\n').find(l => l.startsWith(`| ${name} |`)) ?? ''
  assert.match(row('1'), /`\{ base: <trunk>, fresh: true, fullEvery: 0 \}`/)
  assert.match(row('2 and later, light'), /`\{ base: <trunk>, fullEvery: 0, depth: 'light' \}`/)
  const phase5 = develop.slice(develop.indexOf('## Phase 5'), develop.indexOf('## Phase 6'))
  assert.match(phase5, /`\{ base: <trunk>, strict: true, fresh: true \}`/)
  assert.doesNotMatch(phase5, /depth: 'light'/)
  const skill = fs.readFileSync(new URL('../../skills/addressing-findings/SKILL.md', import.meta.url), 'utf8')
  const step7 = skill.slice(skill.indexOf('7. Re-review'), skill.indexOf('\n8. '))
  assert.match(step7, /`\{ base: <that commit>, fresh: true, delta: true, fullEvery: 0, depth: 'light' \}`/)
  const cases = JSON.parse(fs.readFileSync(new URL('../../content/parity/hook-cases.json', import.meta.url), 'utf8')).cases
  const nudges = cases.filter((/** @type {{ entry: { reason?: string } | null }} */ c) => c.entry?.reason === 're-review-nudge')
  for (const c of nudges) assert.match(c.stdout, /fullEvery: 0, depth: 'light' \}|--full-every 0 --depth light/)
})
