// The external reviewer's findings read from GitHub's PR comments and reviews (lib/external-findings-parse.mjs).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { defaultReviewers, parseFindings, statusReplies, DEFAULT_SEVERITY } from './external-findings-parse.mjs'
import { FINDING_COMMENT_MARKER } from './finding-comment.mjs'

const sha = (/** @type {number} */ i) => String(i).repeat(40).slice(0, 40)
const ID = /FR-[A-Z]+-[0-9a-f]{6}/
/** @param {number} id @param {string} body @param {Record<string, unknown>} [over] */
const comment = (id, body, over = {}) => ({ id, user: { login: 'ext-reviewer' }, body, path: 'src/a.rs', line: 40, original_commit_id: sha(1),
  created_at: '2026-10-01T10:00:00Z', html_url: `https://github.com/example/repo/pull/7#discussion_r${id}`, ...over })
/** @param {string} body @param {string} at @param {Record<string, unknown>} [over] */
const review = (body, at, over = {}) => ({ author: { login: 'ext-reviewer' }, body, submittedAt: at, commit: { oid: sha(1) }, ...over })
/** @param {any[]} reviews */
const pr = reviews => ({ author: { login: 'pr-author' }, headRefName: 'feat/x', commits: [{ oid: sha(1) }, { oid: sha(2) }], reviews })
const opts = { reviewers: ['ext-reviewer'], idRe: ID, exRe: null, sevRe: DEFAULT_SEVERITY }

test('the default reviewers are every commenter and reviewer but the PR author and CI bots', () => {
  const comments = [comment(1, 'x'), comment(2, 'y', { user: { login: 'pr-author' } }), comment(3, 'z', { user: { login: 'github-actions[bot]' } })]
  const p = pr([review('ok', '2026-10-01T10:00:00Z', { author: { login: 'second-reviewer' } }), review('', '2026-10-01T10:00:00Z', { author: { login: 'ci' } })])
  assert.deepEqual(defaultReviewers(p, comments), ['ext-reviewer', 'second-reviewer'])
})

test('status replies are keyed by their root comment; other replies and other people\'s are not', () => {
  const comments = [comment(10, 'Fixed at `2222222`', { in_reply_to_id: 1 }), comment(11, 'Still present at `1111111` here', { in_reply_to_id: 1 }),
    comment(12, 'thanks', { in_reply_to_id: 1 }), comment(13, 'Fixed at `2222222`', { in_reply_to_id: 2, user: { login: 'pr-author' } })]
  const r = statusReplies(comments, ['ext-reviewer'])
  assert.deepEqual([...r.keys()], [1])
  assert.deepEqual(r.get(1)?.map(x => [x.status, x.sha]), [['fixed', '2222222'], ['still present', '1111111']])
})

test('an inline finding carries its id, severity and the round of the review that submitted it', () => {
  const p = pr([review('round one', '2026-10-01T10:05:00Z'), review('too early', '2026-10-01T09:00:00Z')])
  const { findings, unanchored } = parseFindings(p, [comment(1, 'FR-RACE-abc123 should-fix\nthe lock is dropped')], opts)
  assert.equal(unanchored, 0)
  assert.equal(findings.length, 1)
  assert.deepEqual({ ...findings[0], body: undefined }, { id: 'FR-RACE-abc123', path: 'src/a.rs', line: 40, sev: 'should-fix', body: undefined,
    ctx: 'FR-RACE-abc123 should-fix', url: 'https://github.com/example/repo/pull/7#discussion_r1', rootId: 1, round: { at: '2026-10-01T10:05:00Z', head: sha(1) }, rounds: 1 })
})

test('with an id pattern, a root comment without an id is skipped and counted; replies are never findings', () => {
  const comments = [comment(1, 'Fixed at `1111111`'), comment(2, 'FR-X-aaaaaa', { in_reply_to_id: 1 })]
  assert.deepEqual(parseFindings(pr([]), comments, opts), { findings: [], excluded: 0, unanchored: 1 })
})

test('a finding raised again keeps its earliest round and counts the rounds', () => {
  const later = comment(2, 'FR-RACE-abc123 again', { created_at: '2026-10-03T10:00:00Z', original_commit_id: sha(2) })
  const { findings } = parseFindings(pr([]), [later, comment(1, 'FR-RACE-abc123 first')], opts)
  assert.equal(findings[0]?.rounds, 2)
  assert.equal(findings[0]?.round.head, sha(1))
})

test('review-body bullets with an id add findings with no inline anchor, severity from their heading', () => {
  const body = '## Must fix\n- **FR-WIRE-111111** stored range `src/b.rs:12` fails\n- plain bullet\n### Optional\n- **FR-NIT-222222** naming\n- **FR-RACE-abc123** dup of inline'
  const { findings } = parseFindings(pr([review(body, '2026-10-02T00:00:00Z')]), [comment(1, 'FR-RACE-abc123 inline')], opts)
  const byId = Object.fromEntries(findings.map(f => [f.id, f]))
  assert.deepEqual(Object.keys(byId).sort(), ['FR-NIT-222222', 'FR-RACE-abc123', 'FR-WIRE-111111'])
  assert.deepEqual([byId['FR-WIRE-111111']?.path, byId['FR-WIRE-111111']?.line, byId['FR-WIRE-111111']?.sev], ['src/b.rs', 12, 'must-fix'])
  assert.equal(byId['FR-NIT-222222']?.sev, 'optional')
  assert.equal(byId['FR-RACE-abc123']?.rootId, 1, 'the inline comment wins over the bullet')
})

test('the exclude pattern drops a finding by its first line, with every comment under the same id', () => {
  const comments = [comment(1, 'FR-DOC-333333 docs typo'), comment(2, 'FR-DOC-333333 still here', { created_at: '2026-10-02T00:00:00Z' }), comment(3, 'FR-RACE-abc123 race')]
  const { findings, excluded } = parseFindings(pr([]), comments, { ...opts, exRe: /typo/i })
  assert.deepEqual(findings.map(f => f.id), ['FR-RACE-abc123'])
  assert.equal(excluded, 1)
})

test('without an id pattern, each root comment is a finding keyed by its own GitHub id, stable across pushes', () => {
  const { findings } = parseFindings(pr([]), [comment(1, 'a\nb'), comment(2, 'a\nb', { line: 55 }), comment(3, 'other')], { ...opts, idRe: null })
  assert.deepEqual(findings.map(f => f.id), ['r1', 'r2', 'r3'])
})

test('a comment or review carrying craft\'s finding marker is never the external reviewer\'s', () => {
  const craft = `[High] lock dropped\n${FINDING_COMMENT_MARKER}`
  const comments = [comment(1, craft, { user: { login: 'craft-poster' } }), comment(2, `FR-RACE-abc123 ${craft}`), comment(3, 'FR-RACE-def456 race')]
  const p = pr([review(`## Must fix\n- **FR-WIRE-111111** x ${FINDING_COMMENT_MARKER}`, '2026-10-02T00:00:00Z', { author: { login: 'craft-poster' } })])
  assert.deepEqual(defaultReviewers(p, comments), ['ext-reviewer'])
  assert.deepEqual(parseFindings(p, comments, { ...opts, reviewers: ['ext-reviewer', 'craft-poster'] }).findings.map(f => f.id), ['FR-RACE-def456'])
})
