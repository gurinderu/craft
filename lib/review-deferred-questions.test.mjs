// Deferred findings as open questions (realm @nick/craft, node #204), through the real review and
// adversarial-review engines (lib/engine-harness.mjs): a finding an active `question` record answers
// is listed under "Known and deferred", kept out of the verdict and persisted as `deferred`; it is
// raised again on Critical/High, on a changed scope, or when the question's commit is unknown — the
// same machinery as a set-aside decision, which keeps behaving as before.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { liftPriorDecisionSections } from './prior-decision-report.mjs'

test('rust-audit lift: a nested report\'s Known and deferred section is carried out verbatim with the other prior-decision sections', () => {
  const nested = '## Verdict\nApprove\n\n## Known and deferred (open question — not in the verdict)\n- Medium · `src/parse.rs:12` · t · KNOWN AND DEFERRED: x\n\n## Notes\nn'
  const { rest, lifted } = liftPriorDecisionSections(nested)
  assert.match(lifted, /^## Known and deferred[\s\S]*KNOWN AND DEFERRED: x$/)
  assert.doesNotMatch(rest, /Known and deferred/)
  assert.match(rest, /## Notes\nn/)
})
