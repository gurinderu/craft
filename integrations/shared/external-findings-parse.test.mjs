// The external reviewer's findings read from GitHub's PR comments and reviews (lib/external-findings-parse.mjs).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  defaultReviewers,
  detectReviewer,
  parseFindings,
  statusReplies,
  DEFAULT_SEVERITY,
  FLUENCE_SEVERITY,
  FINDING_COMMENT_MARKER,
} from './external-findings-parse.mjs'

const sha = (/** @type {number} */ i) => String(i).repeat(40).slice(0, 40)
const ID = /FR-[A-Z]+-[0-9a-f]{6}/
/** @param {number} id @param {string} body @param {Record<string, unknown>} [over] */
const comment = (id, body, over = {}) => ({
  id,
  user: { login: 'ext-reviewer' },
  body,
  path: 'src/a.rs',
  line: 40,
  original_commit_id: sha(1),
  created_at: '2026-10-01T10:00:00Z',
  html_url: `https://github.com/example/repo/pull/7#discussion_r${id}`,
  ...over,
})
/** @param {string} body @param {string} at @param {Record<string, unknown>} [over] */
const review = (body, at, over = {}) => ({ author: { login: 'ext-reviewer' }, body, submittedAt: at, commit: { oid: sha(1) }, ...over })
/** @param {any[]} reviews */
const pr = reviews => ({ author: { login: 'pr-author' }, headRefName: 'feat/x', commits: [{ oid: sha(1) }, { oid: sha(2) }], reviews })
const opts = { reviewers: ['ext-reviewer'], idRe: ID, exRe: null, sevRe: DEFAULT_SEVERITY }

test('the default reviewers are every commenter and reviewer but the PR author and CI bots', () => {
  const comments = [comment(1, 'x'), comment(2, 'y', { user: { login: 'pr-author' } }), comment(3, 'z', { user: { login: 'github-actions[bot]' } })]
  const p = pr([
    review('ok', '2026-10-01T10:00:00Z', { author: { login: 'second-reviewer' } }),
    review('', '2026-10-01T10:00:00Z', { author: { login: 'ci' } }),
  ])
  assert.deepEqual(defaultReviewers(p, comments), ['ext-reviewer', 'second-reviewer'])
})

test("status replies are keyed by their root comment; other replies and other people's are not", () => {
  const comments = [
    comment(10, 'Fixed at `2222222`', { in_reply_to_id: 1 }),
    comment(11, 'Still present at `1111111` here', { in_reply_to_id: 1 }),
    comment(12, 'thanks', { in_reply_to_id: 1 }),
    comment(13, 'Fixed at `2222222`', { in_reply_to_id: 2, user: { login: 'pr-author' } }),
    comment(14, 'Fixed at\n`abcdef1` after all', { in_reply_to_id: 3 }),
    comment(15, 'Fixed in 9cc55d23.', { in_reply_to_id: 4 }),
    comment(16, 'Still present at b743def687c0.\n\nThe gap remains.', { in_reply_to_id: 4 }),
  ]
  const r = statusReplies(comments, ['ext-reviewer'])
  assert.deepEqual([...r.keys()], [1, 3, 4])
  assert.deepEqual(
    r.get(3)?.map(x => x.sha),
    ['abcdef1'],
    'the backticked form still reads past a newline',
  )
  assert.deepEqual(
    r.get(4)?.map(x => [x.status, x.sha]),
    [
      ['fixed', '9cc55d23'],
      ['still present', 'b743def687c0'],
    ],
  )
  assert.deepEqual(
    r.get(1)?.map(x => [x.status, x.sha]),
    [
      ['fixed', '2222222'],
      ['still present', '1111111'],
    ],
  )
})

test('a number in a reply, or a hex word not right after its status, is no SHA', () => {
  const comments = [
    comment(20, 'Not reproduced after 10000000 runs', { in_reply_to_id: 1 }),
    comment(21, 'Fixed in 12345678.', { in_reply_to_id: 1 }),
    comment(22, 'Fixed upstream, see deadbeef0 for the change', { in_reply_to_id: 1 }),
    comment(23, 'Still present: the 1234567 run and abcdef1 too', { in_reply_to_id: 1 }),
  ]
  assert.deepEqual([...statusReplies(comments, ['ext-reviewer']).keys()], [])
})

test('an inline finding carries its id, severity and the round of the review that submitted it', () => {
  const p = pr([review('round one', '2026-10-01T10:05:00Z'), review('too early', '2026-10-01T09:00:00Z')])
  const { findings, unanchored } = parseFindings(p, [comment(1, 'FR-RACE-abc123 should-fix\nthe lock is dropped')], opts)
  assert.equal(unanchored, 0)
  assert.equal(findings.length, 1)
  assert.deepEqual(
    { ...findings[0], body: undefined },
    {
      id: 'FR-RACE-abc123',
      path: 'src/a.rs',
      line: 40,
      sev: 'should-fix',
      tier: 'should-fix',
      body: undefined,
      ctx: 'FR-RACE-abc123 should-fix',
      url: 'https://github.com/example/repo/pull/7#discussion_r1',
      rootId: 1,
      round: { at: '2026-10-01T10:05:00Z', head: sha(1) },
      rounds: 1,
    },
  )
})

test('with an id pattern, a root comment without an id is skipped and counted; replies are never findings', () => {
  const comments = [comment(1, 'Fixed at `1111111`'), comment(2, 'FR-X-aaaaaa', { in_reply_to_id: 1 })]
  assert.deepEqual(parseFindings(pr([]), comments, opts), { findings: [], excluded: 0, unanchored: 1, preExisting: 0 })
})

test('a finding raised again keeps its earliest round and counts the rounds', () => {
  const later = comment(2, 'FR-RACE-abc123 again', { created_at: '2026-10-03T10:00:00Z', original_commit_id: sha(2) })
  const { findings } = parseFindings(pr([]), [later, comment(1, 'FR-RACE-abc123 first')], opts)
  assert.equal(findings[0]?.rounds, 2)
  assert.equal(findings[0].round.head, sha(1))
})

test('review-body bullets with an id add findings with no inline anchor, severity from their heading', () => {
  const body =
    '## Must fix\n- **FR-WIRE-111111** stored range `src/b.rs:12` fails\n- plain bullet\n### Optional\n- **FR-NIT-222222** naming\n- **FR-RACE-abc123** dup of inline'
  const { findings } = parseFindings(pr([review(body, '2026-10-02T00:00:00Z')]), [comment(1, 'FR-RACE-abc123 inline')], opts)
  const byId = Object.fromEntries(findings.map(f => [f.id, f]))
  assert.deepEqual(Object.keys(byId).sort(), ['FR-NIT-222222', 'FR-RACE-abc123', 'FR-WIRE-111111'])
  assert.deepEqual([byId['FR-WIRE-111111']?.path, byId['FR-WIRE-111111']?.line, byId['FR-WIRE-111111']?.sev], ['src/b.rs', 12, 'must-fix'])
  assert.equal(byId['FR-NIT-222222']?.sev, 'optional')
  assert.equal(byId['FR-RACE-abc123']?.rootId, 1, 'the inline comment wins over the bullet')
})

test('the exclude pattern drops a finding by its first line, with every comment under the same id', () => {
  const comments = [
    comment(1, 'FR-DOC-333333 docs typo'),
    comment(2, 'FR-DOC-333333 still here', { created_at: '2026-10-02T00:00:00Z' }),
    comment(3, 'FR-RACE-abc123 race'),
  ]
  const { findings, excluded } = parseFindings(pr([]), comments, { ...opts, exRe: /typo/i })
  assert.deepEqual(
    findings.map(f => f.id),
    ['FR-RACE-abc123'],
  )
  assert.equal(excluded, 1)
})

test('without an id pattern, each root comment is a finding keyed by its own GitHub id, stable across pushes', () => {
  const { findings } = parseFindings(pr([]), [comment(1, 'a\nb'), comment(2, 'a\nb', { line: 55 }), comment(3, 'other')], { ...opts, idRe: null })
  assert.deepEqual(
    findings.map(f => f.id),
    ['r1', 'r2', 'r3'],
  )
})

test("a comment or review carrying craft's finding marker is never the external reviewer's", () => {
  const craft = `[High] lock dropped\n${FINDING_COMMENT_MARKER}`
  const comments = [comment(1, craft, { user: { login: 'craft-poster' } }), comment(2, `FR-RACE-abc123 ${craft}`), comment(3, 'FR-RACE-def456 race')]
  const p = pr([review(`## Must fix\n- **FR-WIRE-111111** x ${FINDING_COMMENT_MARKER}`, '2026-10-02T00:00:00Z', { author: { login: 'craft-poster' } })])
  assert.deepEqual(defaultReviewers(p, comments), ['ext-reviewer'])
  assert.deepEqual(
    parseFindings(p, comments, { ...opts, reviewers: ['ext-reviewer', 'craft-poster'] }).findings.map(f => f.id),
    ['FR-RACE-def456'],
  )
})

// fluence-review as it posts on a PR: a `<Severity>: <title>` root comment and a status reply, each with its
// `<!-- review:request-… -->` mark, review bodies with `<!-- review:feedback`; the account may be the PR author's.
const MARK = '<!-- review:request-0a1b2c:1 -->'
/** @param {number} id @param {string} first @param {Record<string, unknown>} [over] */
const fluence = (id, first, over = {}) =>
  comment(id, `${first}\n\nTrigger: a reply arrives late.\n\nImpact: a critical section is skipped.\n\n${MARK}`, { user: { login: 'pr-author' }, ...over })

test("fluence-review's own marks name the reviewer, even when the PR author's account posts it", () => {
  const comments = [fluence(1, 'Important: the late reply is lost'), comment(2, 'a human note', { user: { login: 'second-reviewer' } })]
  const p = pr([
    review('Review: 1 Important new.\n\n<!-- review:feedback\nTo the coding agent -->', '2026-10-01T10:05:00Z', { author: { login: 'pr-author' } }),
  ])
  assert.deepEqual(defaultReviewers(p, comments), ['second-reviewer'], 'the default would leave the author out')
  assert.deepEqual(detectReviewer(p, comments), { reviewers: ['pr-author'], marked: true })
  for (const body of ['x <!-- snitch:run1:src9 -->', 'Review: 1 Nit new.\n\n<!-- review:feedback\nTo the coding agent -->', `Nit: x\n\n${MARK}`]) {
    assert.deepEqual(detectReviewer(pr([]), [comment(5, body, { user: { login: 'bot-poster' } })]), { reviewers: ['bot-poster'], marked: true }, body)
  }
  assert.deepEqual(
    detectReviewer(pr([]), [comment(5, 'see FR-RACE-abc123 in the log')]),
    { reviewers: ['ext-reviewer'], marked: false },
    'a bare id in prose is no mark',
  )
  for (const body of ['> ## Fluence Review · repo#7 @ abc\n\nI disagree', '> - **FR-RACE-abc123** · must-fix · verified · RACE\n\nnot a race']) {
    assert.deepEqual(
      detectReviewer(pr([]), [comment(5, body, { user: { login: 'quoter' } })]),
      { reviewers: ['quoter'], marked: false },
      `visible text anyone can quote is no mark: ${body}`,
    )
  }
})

test('without any fluence-review mark the default reviewers stay', () => {
  assert.deepEqual(detectReviewer(pr([]), [comment(1, 'x'), comment(2, 'y', { user: { login: 'pr-author' } })]), {
    reviewers: ['ext-reviewer'],
    marked: false,
  })
})

test('both severity vocabularies read without flags, each with its tier; the first line names it', () => {
  const comments = [
    fluence(1, 'Critical: data is lost'),
    fluence(2, 'Important: the late reply is lost'),
    fluence(3, 'Nit: a name is vague'),
    fluence(4, 'Pre-existing: the base has it too'),
    comment(5, '- **FR-RACE-abc123** · should-fix · verified · RACE'),
    comment(6, 'FR-X-000000 optional naming'),
  ]
  const o = { ...opts, reviewers: ['pr-author', 'ext-reviewer'], idRe: null, sevRe: FLUENCE_SEVERITY }
  assert.deepEqual(
    parseFindings(pr([]), comments, o).findings.map(f => [f.id, f.sev, f.tier]),
    [
      ['r1', 'critical', 'must-fix'],
      ['r2', 'important', 'should-fix'],
      ['r3', 'nit', 'optional'],
      ['r4', 'pre-existing', null],
      ['r5', 'should-fix', 'should-fix'],
      ['r6', 'optional', 'optional'],
    ],
  )
})

test("a generic reviewer's line opening with a fluence-review word is no severity; the old words still are", () => {
  const comments = [
    comment(1, 'Important to note: the lock is held across the await'),
    comment(2, 'Critical path:\nnit picking aside, this is should-fix'),
    comment(3, 'Nit: naming'),
  ]
  assert.deepEqual(
    parseFindings(pr([]), comments, { ...opts, idRe: null }).findings.map(f => [f.id, f.sev, f.tier]),
    [
      ['r1', null, null],
      ['r2', 'should-fix', 'should-fix'],
      ['r3', null, null],
    ],
  )
})

test("with fluence-review's marks, only marked comments are the reviewer's: the author's own replies and notes are not", () => {
  const comments = [
    fluence(1, 'Important: the late reply is lost'),
    comment(2, 'Important: my own note on the PR', { user: { login: 'pr-author' } }),
    comment(3, 'Fixed in b743def6: the test now asserts the body.', { user: { login: 'pr-author' }, in_reply_to_id: 1 }),
    comment(4, `Still present at 3800674e796d.\n\n${MARK}`, { user: { login: 'pr-author' }, in_reply_to_id: 1 }),
    comment(5, `Fixed in 7249e18fdac0.\n\n${MARK}`, { user: { login: 'pr-author' }, in_reply_to_id: 1 }),
  ]
  const o = { ...opts, reviewers: ['pr-author'], idRe: null, marked: true }
  assert.deepEqual(
    parseFindings(pr([]), comments, o).findings.map(f => f.id),
    ['r1'],
  )
  assert.deepEqual(
    statusReplies(comments, o.reviewers, o.marked)
      .get(1)
      ?.map(x => [x.status, x.sha]),
    [
      ['still present', '3800674e796d'],
      ['fixed', '7249e18fdac0'],
    ],
  )
})

test('the exclude pattern still drops the new format by its first line or its body heading', () => {
  const body = '## Must fix\n- **FR-WIRE-111111** · must-fix · verified\n## Seen before\n- **FR-RACE-222222** · should-fix · verified'
  const comments = [fluence(1, 'Pre-existing: the base has it too'), fluence(2, 'Important: Open question: is the fence needed?'), fluence(3, 'Nit: kept')]
  const o = {
    ...opts,
    reviewers: ['pr-author'],
    idRe: /FR-[A-Z]+-[0-9a-f]{6}/,
    exRe: /pre-existing|question|seen before|not.verified/i,
    sevRe: FLUENCE_SEVERITY,
    marked: true,
  }
  const p = pr([review(`${body}\n${MARK}`, '2026-10-02T00:00:00Z', { author: { login: 'pr-author' } })])
  const { findings, excluded } = parseFindings(p, comments, o)
  assert.deepEqual(
    findings.map(f => [f.id, f.sev]),
    [['FR-WIRE-111111', 'must-fix']],
  )
  assert.equal(excluded, 1, 'the inline comments carry no FR- id, so only the Seen before item is dropped')
  const inline = parseFindings(p, comments, { ...o, idRe: null })
  assert.deepEqual(
    inline.findings.map(f => f.id),
    ['r3'],
  )
  assert.equal(inline.excluded, 2)
})

test('Pre-existing findings set aside are counted on their own, out of the findings and the exclusions', () => {
  const comments = [fluence(1, 'Pre-existing: the base has it too'), fluence(2, 'Important: the late reply is lost')]
  const o = { ...opts, reviewers: ['pr-author'], idRe: null, sevRe: FLUENCE_SEVERITY, marked: true }
  const aside = parseFindings(pr([]), comments, { ...o, asidePreExisting: true })
  assert.deepEqual([aside.findings.map(f => f.id), aside.excluded, aside.preExisting], [['r2'], 0, 1])
  const kept = parseFindings(pr([]), comments, o)
  assert.deepEqual([kept.findings.map(f => f.id), kept.preExisting], [['r1', 'r2'], 0])
})

// Copied from fluence-review's comments on a real PR, the prose shortened and the path anonymised; the marks are
// byte-exact. The root and the reviewer's status reply carry a `<!-- review:request-… -->` mark, the author's own
// "Fixed in" reply from the same account none.
const REAL = [
  {
    id: 4579538408,
    user: { login: 'pr-author' },
    body: 'Important: Equal-revision test accepts the wrong conflict reason\n\nTrigger: An equal-revision mismatch returns another 409.\n\nMechanism: The test asserts only status.\n\nImpact: Callers could abandon a valid update.\n\nFix: Assert the error body for both mismatches.\n\n<!-- review:request-118fe7079f10b18136ead8b0b3b4d642b9a034574e0ec80aad964d45762b9ec7:1 -->',
    path: 'src/api/subnet_tests.rs',
    line: 151,
    original_line: 155,
    original_commit_id: 'da02edcead0aefab2ee0539807eb00c3f6ce0216',
    created_at: '2026-11-15T18:04:52Z',
  },
  {
    id: 4579548827,
    user: { login: 'pr-author' },
    body: 'Fixed in b743def6: both mismatches now assert the error body; matching replays still assert 200 with no write.',
    path: 'src/api/subnet_tests.rs',
    line: 151,
    original_line: 155,
    original_commit_id: 'da02edcead0aefab2ee0539807eb00c3f6ce0216',
    created_at: '2026-11-15T18:07:52Z',
    in_reply_to_id: 4579538408,
  },
  {
    id: 4579678970,
    user: { login: 'pr-author' },
    body: 'Fixed in b743def687c0.\n\n<!-- review:request-915a3be02ae9b346986fd0cc15d1e7d2769394c7706d3d0f42bfd319577c3797:thread:PRRT_kwDOMdhCSs63sPjO -->',
    path: 'src/api/subnet_tests.rs',
    line: 151,
    original_line: 155,
    original_commit_id: 'da02edcead0aefab2ee0539807eb00c3f6ce0216',
    created_at: '2026-11-15T18:41:13Z',
    in_reply_to_id: 4579538408,
  },
]

test("fluence-review's real comments: the marked root is a finding, its marked status reply counts, the author's own reply does not", () => {
  const p = { ...pr([]), commits: [{ oid: 'da02edcead0aefab2ee0539807eb00c3f6ce0216' }] }
  assert.deepEqual(detectReviewer(p, REAL), { reviewers: ['pr-author'], marked: true })
  const o = { reviewers: ['pr-author'], idRe: null, exRe: null, sevRe: FLUENCE_SEVERITY, marked: true }
  const { findings } = parseFindings(p, REAL, o)
  assert.deepEqual(
    findings.map(f => [f.id, f.sev, f.tier, f.path, f.line]),
    [['r4579538408', 'important', 'should-fix', 'src/api/subnet_tests.rs', 151]],
  )
  assert.deepEqual(
    statusReplies(REAL, o.reviewers, o.marked)
      .get(4579538408)
      ?.map(x => [x.status, x.sha]),
    [['fixed', 'b743def687c0']],
  )
})
