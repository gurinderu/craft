// The OpenCode findings texts (lib/work-hook-opencode.mjs) recall before triage and re-review before any reply; the
// Claude Code and Codex texts are the craft binary's, held byte for byte by content/parity/hook-cases.json.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { OPENCODE_FINDINGS_TEXT, OPENCODE_OTHER_LANGUAGE_TEXT } from './work-hook-opencode.mjs'

test("the OpenCode findings texts recall before triage and re-review before any reply, in OpenCode's words", () => {
  const recall = /before triage \(its step 0\): [^;]*recall\(<finding keywords>, <path>\) for every path the findings touch/
  const reReview =
    /after the fixes are in \(every fixer returned and pushed\) and before posting any reply: run a light re-review of the fix commits only \(base: the commit the review was made on; a merge since it, as trunk merged in, means ask the human first\), [^;]*, repeating until no Medium-or-higher finding is open \(the whole diff only on the human's word\); replies wait for it\./
  for (const text of [OPENCODE_FINDINGS_TEXT, OPENCODE_OTHER_LANGUAGE_TEXT]) {
    assert.match(text, recall, text)
    assert.match(text, reReview, text)
  }
  assert.match(OPENCODE_FINDINGS_TEXT, /load the memory skill with the skill tool and recall/)
  assert.match(
    OPENCODE_FINDINGS_TEXT,
    /\), here in this session over git diff <that commit>\.\.HEAD: for Rust code the rust-review skill or the rust-audit tool, otherwise your own review pass, repeating/,
  )
})
