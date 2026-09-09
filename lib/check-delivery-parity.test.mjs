// The gate that compares the two deliveries, and the one that must be shown FIRING: a checker for
// a defect nobody can reproduce is a checker nobody trusts. The first case here is the defect that
// actually happened.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { parseVerdict, hasVerdictLine } from '../opencode/plugin/run-record.mjs'
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
  const problems = checkParity(root, port, {})
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
  assert.deepEqual(checkParity(root, port, {}), [])
})

test('an outcome the port gained and the root lacks is caught too', () => {
  // Both directions: a port that grew a verdict its origin cannot reach is the same divergence,
  // and it is the likelier one now that the port is edited by hand more often.
  const root = new Map([['rust-reviewer', 'Verdicts: **Approve** / **Block**, or `INCOMPLETE (not run)`.']])
  const port = new Map([
    ['rust-reviewer', 'Verdicts: **Approve** / **Warning** / **Block**, or `INCOMPLETE (not run)`.'],
  ])
  const problems = checkParity(root, port, {})
  assert.equal(problems.length, 1)
  assert.match(problems[0], /opencode\/agents\/ can report concern and agents\/ cannot/)
})

test('an unpaired agent must be excused by name, and the excuse expires', () => {
  const body = 'Verdicts: **Approve** / **Warning** / **Block**, or `INCOMPLETE (not run)`.'
  const excuse = { 'nix-reviewer': 'the OpenCode delivery ships no Nix profile — there is no nix-review command to call it' }

  // Not excused: shipping for one delivery only is a divergence until someone says otherwise.
  const surprise = checkParity(new Map([['rust-semver', body]]), new Map(), {})
  assert.equal(surprise.length, 1)
  assert.match(surprise[0], /ships only for Claude Code/)

  // Excused by an explicit allowlist entry: nix-reviewer has no OpenCode profile to call it.
  assert.deepEqual(checkParity(new Map([['nix-reviewer', body]]), new Map(), excuse), [])

  // And the excuse cannot outlive what it excused: once the port exists, the entry is stale.
  const stale = checkParity(new Map([['nix-reviewer', body]]), new Map([['nix-reviewer', body]]), excuse)
  assert.equal(stale.length, 1)
  assert.match(stale[0], /UNPAIRED_BY_DESIGN/)
  assert.match(stale[0], /now exists — drop the entry/)
})

test('a stale excuse for a deleted root file is caught too', () => {
  // The direction the root-keyed loop cannot reach: it only visits names present in `root`, so an
  // allowlist entry whose ROOT file was DELETED (present in neither map) is never visited by that
  // loop and its excuse lingers forever. A synthetic allowlist entry for a name absent from both
  // sides pins this — it states its own premise rather than depending on the real allowlist.
  const problems = checkParity(new Map(), new Map(), { 'ghost-reviewer': 'stood in for a deleted root file' })
  assert.ok(
    problems.some((p) => p.includes('ghost-reviewer') && p.includes('neither side')),
    'an UNPAIRED_BY_DESIGN entry for a name on neither side must be flagged as stale',
  )
})

test('a port of nothing is caught', () => {
  const body = 'Verdicts: **Approve** / **Block**, or `INCOMPLETE (not run)`.'
  const problems = checkParity(new Map(), new Map([['ghost', body]]), {})
  assert.equal(problems.length, 1)
  assert.match(problems[0], /has no counterpart under agents\//)
})

test('a second, unrelated allowlist entry does not disturb a test about something else', () => {
  // The property the injectable parameter buys: adding a second entry to UNPAIRED_BY_DESIGN must
  // not break a test whose subject is not the allowlist. Before this parameter, every synthetic
  // map had to carry the real allowlist's contents to stay quiet, so a second real entry would have
  // forced padding at every such call site (realm @nick/craft).
  const body = 'Verdicts: **Approve** / **Block**, or `INCOMPLETE (not run)`.'
  const root = new Map([['rust-reviewer', body], ['nix-reviewer', body], ['some-other-agent', body]])
  const port = new Map([['rust-reviewer', body]])
  const twoEntryAllowlist = { 'nix-reviewer': 'reason one', 'some-other-agent': 'reason two' }
  assert.deepEqual(checkParity(root, port, twoEntryAllowlist), [])
})

test('a rubric word is not found inside a longer one', () => {
  // `\b` matches between `k` and `-`, so a naive boundary finds `At-risk` inside `At-risky` and
  // `Block` inside `Blocking`. The hyphenated words are the reason the boundary is spelled out.
  assert.deepEqual([...outcomesReported('Blocking issues are listed below.')], [])
  assert.deepEqual([...outcomesReported('The design is At-risky at best.')], [])
  assert.deepEqual([...outcomesReported('Cleanup is pending.')], [])
  assert.deepEqual([...outcomesReported('Rate it **At-risk**.')], ['bad'])

  // The hyphen specifically: `(?<![\w-])`/`(?![\w-])` excludes `-` from the boundary class, not
  // just `\w`. Relaxing either class to plain `\w` (dropping the `-`) does not redden any of the
  // four assertions above — `\w` alone already stops `Blocking`/`At-risky`/`Cleanup` — so those do
  // not pin the hyphen at all. These do: `Semi-Clean` must not read as `Clean`, and `Block-list`
  // must not read as `Block`, because a hyphen sits directly against the rubric word on one side.
  assert.deepEqual([...outcomesReported('Rate it Semi-Clean for now.')], [])
  assert.deepEqual([...outcomesReported('See the Block-list policy.')], [])
})

test('the bare token is not the rubric phrase', () => {
  // The enumeration in the machine line contains `INCOMPLETE`; only the rubric phrase names the
  // outcome. This is the single distinction the first case above rests on.
  assert.deepEqual([...outcomesReported(MACHINE_LINE)], [])
  assert.deepEqual([...outcomesReported('report `INCOMPLETE (not run)` and stop')], ['incomplete'])
})

test('the vocabulary is what the parser actually reads', () => {
  // The tripwire. `parseVerdict`'s fallthrough is `Approve` by design (`parseVerdict('banana')` is
  // `Approve`), so asserting the RETURNED TOKEN for the `ok` row is vacuous — any word, real or
  // invented, would pass. `hasVerdictLine` is the one that distinguishes recognised vocabulary from
  // fallthrough, so the `ok` row is pinned by RECOGNITION: each word, in a realistic `Verdict: X`
  // line, must be recognised — and a control non-word in the same shape must not be. The other three
  // rows keep the direct `parseVerdict` assertion: their outcomes are not the fallthrough, so
  // asserting the returned token there is not vacuous.
  for (const w of OUTCOMES.ok) {
    assert.equal(hasVerdictLine(`Verdict: ${w}`), true, `${w} should be recognised as a reported verdict`)
  }
  assert.equal(
    hasVerdictLine('Verdict: banana'),
    false,
    'an invented word must NOT be recognised — otherwise the ok-row assertions above prove nothing',
  )

  const expected = { concern: 'Warning', bad: 'Block', incomplete: 'INCOMPLETE (not run)' }
  for (const outcome of ['concern', 'bad', 'incomplete']) {
    for (const w of OUTCOMES[outcome]) {
      assert.equal(parseVerdict(w), expected[outcome], `${w} should read as ${expected[outcome]}`)
    }
  }
})

test('the gate reads the body, not the frontmatter — a real file gutted of body signal fails', () => {
  // The falsifier from the review: take the real opencode/agents/rust-reviewer.md, replace every
  // body occurrence of INCOMPLETE with APPROVE (gutting the not-run path), leave the frontmatter
  // untouched. Before this gate stripped frontmatter, the description line alone kept the outcome
  // set fully covered and the mutation went undetected.
  const root = readAgents(fileURLToPath(new URL('../agents', import.meta.url)))
  const port = readAgents(fileURLToPath(new URL('../opencode/agents', import.meta.url)))
  const real = port.get('rust-reviewer')
  const fmEnd = real.indexOf('\n---\n', real.indexOf('---\n') + 4) + 5
  const frontmatter = real.slice(0, fmEnd)
  const body = real.slice(fmEnd)
  const gutted = frontmatter + body.replaceAll('INCOMPLETE', 'APPROVE')

  const mutatedPort = new Map(port)
  mutatedPort.set('rust-reviewer', gutted)
  const problems = checkParity(root, mutatedPort)
  assert.ok(
    problems.some((p) => p.includes('rust-reviewer')),
    'a body-level INCOMPLETE→APPROVE mutation must be caught even though the frontmatter still names INCOMPLETE',
  )
})

test('the repository itself is in parity', () => {
  // The gate over the real tree, so a divergence landing on main fails here and not only in CI.
  const root = readAgents(fileURLToPath(new URL('../agents', import.meta.url)))
  const port = readAgents(fileURLToPath(new URL('../opencode/agents', import.meta.url)))
  assert.ok(root.size > 0, 'agents/ must not read empty — an empty read passes vacuously')
  assert.deepEqual(checkParity(root, port), [])
})
