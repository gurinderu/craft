// A launcher's priorDecisions ADD to the engine's own recall; they never replace it. Before, a passed
// list (an empty one included) skipped the recall, so a launcher that built two decisions by hand from
// PR-thread replies kept every decision of the project's memory out of the review, and the report did
// not say memory was never asked. Only an engine that already recalled for this run skips the recall
// of the reviews it launches, by an internal flag.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
// Two decisions a launcher built by hand from PR-thread replies (the pr-rejections shape).
const P0 = {
  id: 'thread-1',
  title: 'unwrap in parser may panic',
  scope: 'src/parse.rs',
  reason: 'validated upstream',
  who: 'alice',
  when: '2026-10-01',
  link: 'https://x/pr/1#c1',
  commit: 'abc1234',
}
const P1 = {
  id: 'thread-2',
  title: 'clone in loop is wasteful',
  scope: 'src/loop.rs',
  reason: 'loop runs twice',
  who: 'bob',
  when: '2026-10-02',
  link: 'https://x/pr/1#c2',
  commit: 'abc1234',
}
// The owner's active decision in the project's memory backend.
const RECALLED = {
  id: 'decision-f830e51f89',
  kind: 'decision',
  title: 'magic number in config',
  body: 'documented in the spec',
  scope: 'src/config.rs',
  status: 'active',
  date: '2026-09-01',
  author: 'owner',
  commit: 'abc1234',
  links: [],
}
/** @param {any} run */
const recalls = run => run.calls.filter((/** @type {{ label: string }} */ c) => c.label === 'memory-recall').length

const AUDIT_SCOUT = {
  baseRef: 'main',
  hasUnsafe: false,
  crates: [
    { name: 'a', path: 'a' },
    { name: 'b', path: 'b' },
  ],
  changedCrates: [
    { name: 'a', path: 'a' },
    { name: 'b', path: 'b' },
  ],
  edges: [],
  repoRoot: '/r',
  notes: 'n',
}
const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }

test('rust-audit (realm #218): a malformed recalled record does not shadow a valid passed one with its id; junk is not counted new', async () => {
  const run = await runEngine('rust-audit', {
    args: { priorDecisions: [P0, { id: 'junk' }] },
    script: {
      scout: AUDIT_SCOUT,
      workflow: () => '## Verdict\n✅ Approve',
      synthesis: 'the audit body',
      'memory-recall': { backend: 'repo', why: 'w', decisions: [{ id: P0.id }] },
      '*': green,
    },
  })
  const a = /** @type {any} */ (
    /** @type {any[]} */ (run.calls.find(c => c.label === 'workflow' && !(/** @type {any} */ (c.argv)?.[1]?.gateOnly))?.argv ?? [])[1]
  )
  assert.deepEqual(a.priorDecisions, [{ id: P0.id }, P0, { id: 'junk' }])
  // The nested CLI review takes the recall only as records: the split has no carrier there (realm @nick/craft, #150).
  assert.ok(!('_memoryParts' in a), 'no split is forwarded; the audit line alone prints K')
  assert.match(
    run.report,
    /## Memory\n- memory: returned 1 decision\(s\) from repo \(w\); plus 1 passed by the launcher \(1 new\);/,
    'K is the accepted count, as in review',
  )
})

test('rust-audit: one recall, merged with the passed list, forwarded with the internal flag so nested reviews do not recall again', async () => {
  const clash = { ...P1, id: RECALLED.id }
  const run = await runEngine('rust-audit', {
    args: { priorDecisions: [P0, clash] },
    script: {
      scout: AUDIT_SCOUT,
      workflow: () => '## Verdict\n✅ Approve',
      synthesis: 'the audit body',
      'memory-recall': { backend: 'repo', why: 'w', decisions: [RECALLED] },
      '*': green,
    },
  })
  assert.equal(recalls(run), 1, "a passed list does not skip the audit's recall")
  const nested = run.calls.filter(c => c.label === 'workflow' && !(/** @type {any} */ (c.argv)?.[1]?.gateOnly))
  assert.ok(nested.length >= 2)
  for (const c of nested) {
    const a = /** @type {any[]} */ (c.argv)[1]
    assert.deepEqual(a.priorDecisions, [RECALLED, P0], 'merged by id, the recalled record kept on a clash')
    assert.equal(a._recalled, true, 'the nested review skips its own recall')
  }
  assert.match(
    run.report,
    /## Memory\n- memory: returned 1 decision\(s\) from repo \(w\); plus 2 passed by the launcher \(1 new\); each nested review reports how many it applied\n/,
  )
})

// One cap across the merged set (realm @nick/craft, node #218): recalled and passed records merge raw by
// id, then are read once, so a run never applies more than PRIOR_DECISIONS_MAX (100) — in review, in
// adversarial-review, and in the reviews rust-audit launches. Titles share no word, so a finding
// matches its own decision only.
/** @param {number} k */
const recalledAt = k => ({
  id: `r-${k}`,
  kind: 'decision',
  title: `r${k}x r${k}y r${k}z`,
  body: `reason r-${k}`,
  scope: 'src',
  status: 'active',
  date: '2026-09-01',
  author: 'owner',
  commit: 'abc1234',
  links: [],
})
/** @param {number} k */
const passedAt = k => ({
  id: `p-${k}`,
  title: `p${k}x p${k}y p${k}z`,
  scope: 'src',
  reason: `reason p-${k}`,
  who: 'alice',
  when: '2026-10-01',
  link: 'https://x/pr/1#c1',
  commit: 'abc1234',
})
const R80 = Array.from({ length: 80 }, (_, k) => recalledAt(k))
const P80 = Array.from({ length: 80 }, (_, k) => passedAt(k))

test('rust-audit (realm #218): the merged list reaches each nested review whole, the audit counting new under the same cap', async () => {
  const audit = await runEngine('rust-audit', {
    args: { priorDecisions: P80 },
    script: {
      scout: AUDIT_SCOUT,
      workflow: () => '## Verdict\n✅ Approve',
      synthesis: 'the audit body',
      'memory-recall': { backend: 'repo', why: 'w', decisions: R80 },
      '*': green,
    },
  })
  const nested = audit.calls.filter(c => c.label === 'workflow' && !(/** @type {any} */ (c.argv)?.[1]?.gateOnly))
  assert.ok(nested.length >= 2)
  for (const c of nested)
    assert.ok(
      !('_memoryParts' in /** @type {any[]} */ (c.argv)[1]),
      'no split is forwarded: the nested CLI review has no carrier for it (realm @nick/craft, #150)',
    )
  assert.match(
    audit.report,
    /## Memory\n- memory: returned 80 decision\(s\) from repo \(w\); plus 80 passed by the launcher \(20 new\);/,
    'the audit counts new under the same cap',
  )
  /** @type {any} */
  const a = /** @type {any[]} */ (nested[0]?.argv ?? [])[1]
  assert.equal(a.priorDecisions.length, 160)
  assert.equal(a._recalled, true, 'the nested CLI review recalls none and applies the list under its own cap')
})
