// The gate that compares the two deliveries, and the one that must be shown FIRING: a checker for
// a defect nobody can reproduce is a checker nobody trusts. The first case here is the defect that
// actually happened.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVerdict } from '../opencode/plugin/run-record.mjs'
import { OUTCOMES, outcomesReported, checkParity, readAgents } from './check-delivery-parity.mjs'

// The shape an OpenCode agent has to carry: a rubric, then the machine-read line whose instruction
// ENUMERATES all four tokens. The enumeration is what makes a naive word-count blind.
const MACHINE_LINE =
  'End with `VERDICT: X` where X is exactly one of the four tokens `APPROVE`, `WARNING`, `BLOCK`, `INCOMPLETE`.'

test('a port that lost the INCOMPLETE path is caught, though it still enumerates the token', () => {
  // The defect this checker exists for, in its own words: a fix shipped for Claude Code did not
  // reach the port, an unrun Miri reported Clean, and every gate stayed green because each judged
  // one file's shape alone. Note the port below CONTAINS the string `INCOMPLETE` — counting the
  // token would call it covered, which is why the rubric phrase is what is measured.
  const root = new Map([
    ['rust-miri', 'Rate: **Clean** if Miri ran and found nothing, **UB-found** ⛔ Block otherwise.\nIf nightly or miri is missing, report `INCOMPLETE (not run)` — an unrun Miri is never Clean.'],
  ])
  const port = new Map([
    ['rust-miri', `Rate: **Clean** if Miri ran and found nothing, **UB-found** otherwise.\n${MACHINE_LINE}`],
  ])
  const problems = checkParity(root, port)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /rust-miri/)
  assert.match(problems[0], /agents\/ can report incomplete and opencode\/agents\/ cannot/)
})

test('the machine line alone is not a divergence', () => {
  // The false positive the first two versions of this checker produced, twice: the OpenCode port
  // must carry `VERDICT: X` and the Claude Code agent must not, so comparing the words as written
  // flagged every pair. Measuring the transport and calling it the meaning is the shape this
  // repository keeps producing; here it is pinned so a later "tightening" cannot bring it back.
  const rubric = 'Rate **Healthy** / **Concerns** / **At-risk**, or `INCOMPLETE (not run)` if no graph was built.'
  const root = new Map([['rust-architecture-reviewer', rubric]])
  const port = new Map([['rust-architecture-reviewer', `${rubric}\n${MACHINE_LINE}`]])
  assert.deepEqual(checkParity(root, port), [])
})

test('an outcome the port gained and the root lacks is caught too', () => {
  // Both directions: a port that grew a verdict its origin cannot reach is the same divergence,
  // and it is the likelier one now that the port is edited by hand more often.
  const root = new Map([['rust-reviewer', 'Verdicts: **Approve** / **Block**, or `INCOMPLETE (not run)`.']])
  const port = new Map([
    ['rust-reviewer', 'Verdicts: **Approve** / **Warning** / **Block**, or `INCOMPLETE (not run)`.'],
  ])
  const problems = checkParity(root, port)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /opencode\/agents\/ can report concern and agents\/ cannot/)
})

test('an unpaired agent must be excused by name, and the excuse expires', () => {
  const body = 'Verdicts: **Approve** / **Warning** / **Block**, or `INCOMPLETE (not run)`.'

  // Not excused: shipping for one delivery only is a divergence until someone says otherwise.
  const surprise = checkParity(new Map([['rust-semver', body]]), new Map())
  assert.equal(surprise.length, 1)
  assert.match(surprise[0], /ships only for Claude Code/)

  // Excused by the real list: nix-reviewer has no OpenCode profile to call it.
  assert.deepEqual(checkParity(new Map([['nix-reviewer', body]]), new Map()), [])

  // And the excuse cannot outlive what it excused: once the port exists, the entry is stale.
  const stale = checkParity(new Map([['nix-reviewer', body]]), new Map([['nix-reviewer', body]]))
  assert.equal(stale.length, 1)
  assert.match(stale[0], /UNPAIRED_BY_DESIGN/)
  assert.match(stale[0], /now exists — drop the entry/)
})

test('a port of nothing is caught', () => {
  const body = 'Verdicts: **Approve** / **Block**, or `INCOMPLETE (not run)`.'
  const problems = checkParity(new Map(), new Map([['ghost', body]]))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /has no counterpart under agents\//)
})

test('a rubric word is not found inside a longer one', () => {
  // `\b` matches between `k` and `-`, so a naive boundary finds `At-risk` inside `At-risky` and
  // `Block` inside `Blocking`. The hyphenated words are the reason the boundary is spelled out.
  assert.deepEqual([...outcomesReported('Blocking issues are listed below.')], [])
  assert.deepEqual([...outcomesReported('The design is At-risky at best.')], [])
  assert.deepEqual([...outcomesReported('Cleanup is pending.')], [])
  assert.deepEqual([...outcomesReported('Rate it **At-risk**.')], ['bad'])
})

test('the bare token is not the rubric phrase', () => {
  // The enumeration in the machine line contains `INCOMPLETE`; only the rubric phrase names the
  // outcome. This is the single distinction the first case above rests on.
  assert.deepEqual([...outcomesReported(MACHINE_LINE)], [])
  assert.deepEqual([...outcomesReported('report `INCOMPLETE (not run)` and stop')], ['incomplete'])
})

test('the vocabulary is what the parser actually reads', () => {
  // The tripwire. Every word in the table is run through the parser that reads these verdicts in
  // production, and must land on the outcome the table claims. A vocabulary held by memory drifts
  // from the engine the moment either moves — which is the defect class this checker lives inside,
  // so the checker is not allowed to hold one.
  const expected = { ok: 'Approve', concern: 'Warning', bad: 'Block', incomplete: 'INCOMPLETE (not run)' }
  for (const [outcome, words] of Object.entries(OUTCOMES)) {
    for (const w of words) {
      assert.equal(parseVerdict(w), expected[outcome], `${w} should read as ${expected[outcome]}`)
    }
  }
})

test('the repository itself is in parity', () => {
  // The gate over the real tree, so a divergence landing on main fails here and not only in CI.
  const root = readAgents(new URL('../agents', import.meta.url).pathname)
  const port = readAgents(new URL('../opencode/agents', import.meta.url).pathname)
  assert.ok(root.size > 0, 'agents/ must not read empty — an empty read passes vacuously')
  assert.deepEqual(checkParity(root, port), [])
})
