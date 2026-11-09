// The light re-review after fixes (skills/addressing-findings, step 7; realm @nick/craft, node #12): with the commit
// the addressed review was made on as `base` and `fresh`, craft:review's lenses diff exactly base...HEAD, the fix
// commits, even when an older run on the branch could be chained to. Without `fresh` it chains to that run's head.
// Executed through the engine harness: the lens prompts carry the diff range each lens is told to run.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { nudgeText } from './work-hook-text.mjs'

// base...HEAD is the fix commits only while no merge sits between: a trunk merged in after the review rides along.
// The engine harness scripts git's answers, so a merged history is not observable here; the guard is the session's
// step before the run, checked in the texts that send the session to it.
test('step 7 and the hook texts check for a merge since the reviewed commit before a light re-review', () => {
  const skill = fs.readFileSync(new URL('../skills/addressing-findings/SKILL.md', import.meta.url), 'utf8')
  const step7 = skill.slice(skill.indexOf('7. Re-review'), skill.indexOf('\n8. '))
  assert.match(step7, /--is-ancestor <that commit> HEAD`[\s\S]*`git rev-list --merges <that commit>\.\.HEAD`[\s\S]*ask[\s\S]*the human/)
  assert.match(step7, /`base: <trunk>`, still `fresh: true`/)
  for (const who of ['claude-code', 'codex']) assert.match(nudgeText(who), /a merge since it, as trunk merged in, means ask the human first/)
})
