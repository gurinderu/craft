// The PR-thread rejection rule (lib/pr-thread-rule.mjs, read across a PR by lib/pr-rejections.mjs) over answers shaped as `gh api graphql`
// returns them (observed on gh 2.101.0: reviewThreads → isResolved, isOutdated, path, resolvedBy,
// comments → author.login, body, url, createdAt, originalCommit.oid), and the comment format the
// engine posts (lib/finding-comment.mjs).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findingCommentBody, readFindingComment, FINDING_COMMENT_MARKER } from './finding-comment.mjs'
import { rejectionsFromThreads, run, PR_THREADS_MAX } from './pr-rejections.mjs'
import { decisionId, THREAD_COMMENTS_MAX, REJECTION_TITLE_MAX, REJECTION_REASON_MAX } from './pr-thread-rule.mjs'

const SHA = '33d0240d4fe01138d7ac11798003c13b1f6dd24e'
const ROOT = { author: { login: 'gurinderu' }, body: findingCommentBody({ severity: 'Medium', title: 'unwrap in parser may panic', why: 'panics', fix: 'return an error' }), url: 'https://github.com/o/r/pull/9#discussion_r1', createdAt: '2026-10-01T10:00:00Z', originalCommit: { oid: SHA } }
/** @param {string} body @param {string} [who] */
const reply = (body, who = 'alice') => ({ author: { login: who }, body, url: 'https://github.com/o/r/pull/9#discussion_r2', createdAt: '2026-10-02T11:00:00Z', originalCommit: { oid: SHA } })
/** @param {any[]} comments @param {Record<string, unknown>} [over] */
const thread = (comments, over = {}) => ({ isResolved: false, isOutdated: false, path: 'src/parse.rs', resolvedBy: null, comments: { totalCount: comments.length, nodes: comments }, ...over })
/** @param {any[]} nodes @param {number} [totalCount] */
const answer = (nodes, totalCount = nodes.length) => ({ data: { repository: { pullRequest: { reviewThreads: { totalCount, nodes } } } } })

test('comment format: the engine body reads back as the finding; anything without the marker is not craft\'s', () => {
  assert.deepEqual(readFindingComment(ROOT.body), { severity: 'Medium', title: 'unwrap in parser may panic' })
  assert.ok(ROOT.body.endsWith(FINDING_COMMENT_MARKER))
  assert.equal(readFindingComment('[Medium] unwrap in parser may panic\n\npanics — return an error'), null, 'no marker')
  assert.equal(readFindingComment(`Medium: unwrap\n${FINDING_COMMENT_MARKER}`), null, 'no [Severity] title line')
})

test('rule: a reply opening with a rejection, as the last word, records a decision with author, link and commit', () => {
  const r = /** @type {any} */ (rejectionsFromThreads(answer([thread([ROOT, reply('Not a bug: the input is validated upstream.')])])))
  assert.equal(r.decisions.length, 1)
  assert.deepEqual(r.decisions[0], {
    id: decisionId('unwrap in parser may panic', 'src/parse.rs'), kind: 'decision', title: 'unwrap in parser may panic',
    body: 'Not a bug: the input is validated upstream.', scope: 'src/parse.rs', status: 'active', date: '2026-10-02',
    author: 'alice', commit: SHA, links: ['https://github.com/o/r/pull/9#discussion_r2', 'https://github.com/o/r/pull/9#discussion_r1'],
  })
  for (const opener of ['By design — see ADR 4', "won't fix", 'This is intentional', 'false positive here', "That's working as intended"]) {
    assert.equal(/** @type {any} */ (rejectionsFromThreads(answer([thread([ROOT, reply(opener)])]))).decisions.length, 1, opener)
  }
})

test('rule: conservative — mid-sentence, not the last word, the poster\'s own reply, a non-craft root: nothing recorded', () => {
  const none = (/** @type {any[]} */ cs, over = {}) => /** @type {any} */ (rejectionsFromThreads(answer([thread(cs, over)]))).decisions.length
  assert.equal(none([ROOT, reply('Fixed in abc123 — this was not a bug before the refactor though')]), 0, 'does not open with a rejection')
  assert.equal(none([ROOT, reply('Not a bug.'), reply('Actually it is, fixing', 'bob')]), 0, 'the rejection is not the last word')
  assert.equal(none([ROOT, reply('Not a bug.', 'gurinderu')]), 0, 'the poster cannot reject its own finding')
  assert.equal(none([{ ...ROOT, body: '[Medium] unwrap in parser may panic' }, reply('Not a bug.')]), 0, 'a root without the marker cannot be tied to a finding')
  const r = /** @type {any} */ (rejectionsFromThreads(answer([thread([ROOT, reply('Fixed, thanks')])])))
  assert.match(r.skipped[0], /src\/parse\.rs: unwrap in parser may panic — the last reply does not open with a rejection/)
})

test('rule: resolved by someone else with no reply and the code unchanged records; outdated or unresolved does not', () => {
  const resolved = /** @type {any} */ (rejectionsFromThreads(answer([thread([ROOT], { isResolved: true, resolvedBy: { login: 'alice' } })])))
  assert.equal(resolved.decisions[0]?.author, 'alice')
  assert.match(resolved.decisions[0]?.body, /Resolved by alice without a reply or a change/)
  assert.equal(/** @type {any} */ (rejectionsFromThreads(answer([thread([ROOT], { isResolved: true, isOutdated: true, resolvedBy: { login: 'alice' } })]))).decisions.length, 0, 'outdated: the code changed')
  assert.equal(/** @type {any} */ (rejectionsFromThreads(answer([thread([ROOT])]))).decisions.length, 0, 'unresolved')
  assert.equal(/** @type {any} */ (rejectionsFromThreads(answer([thread([ROOT], { isResolved: true, resolvedBy: { login: 'gurinderu' } })]))).decisions.length, 0, 'resolved by the poster')
})

test('bound: threads past PR_THREADS_MAX are named as unread, not dropped', () => {
  const many = Array.from({ length: PR_THREADS_MAX + 2 }, () => thread([ROOT, reply('Not a bug.')]))
  const r = /** @type {any} */ (rejectionsFromThreads(answer(many)))
  assert.equal(r.decisions.length, PR_THREADS_MAX)
  assert.match(r.skipped.join('\n'), /2 thread\(s\) past the 500 read were not examined/)
  const unpaged = /** @type {any} */ (rejectionsFromThreads(answer([thread([ROOT, reply('Not a bug.')])], 140)))
  assert.match(unpaged.skipped.join('\n'), /139 thread\(s\) past the 500 read/, 'an answer that was not paginated names what it did not carry')
})

test('pages: a slurped array of answers is read as one; a malformed page refuses the whole input', () => {
  const t = () => thread([ROOT, reply('Not a bug.')])
  const r = /** @type {any} */ (rejectionsFromThreads([answer([t(), t()], 3), answer([t()], 3)]))
  assert.equal(r.decisions.length, 3)
  assert.deepEqual(r.skipped, [])
  assert.match(String(rejectionsFromThreads([answer([t()]), { data: null }])), /not a reviewThreads answer/)
  assert.match(String(rejectionsFromThreads([])), /not a reviewThreads answer/)
})

test('bound: a thread with more comments than were read is skipped — its last word is unknown', () => {
  const t = thread([ROOT, reply('Not a bug.')])
  t.comments.totalCount = THREAD_COMMENTS_MAX + 1
  const r = /** @type {any} */ (rejectionsFromThreads(answer([t])))
  assert.equal(r.decisions.length, 0)
  assert.match(r.skipped[0], /51 comments, past the 50 read: the last word is unknown/)
})

test('bound: a reason or a title over the memory record\'s ceiling is refused, never cut', () => {
  const atCap = 'Not a bug.' + ' x'.repeat((REJECTION_REASON_MAX - 10) / 2)
  assert.equal(atCap.length, REJECTION_REASON_MAX)
  assert.equal(/** @type {any} */ (rejectionsFromThreads(answer([thread([ROOT, reply(atCap)])]))).decisions.length, 1)
  const over = /** @type {any} */ (rejectionsFromThreads(answer([thread([ROOT, reply(atCap + 'y')])])))
  assert.equal(over.decisions.length, 0)
  assert.match(over.skipped[0], /reason is 1201 chars, over 1200: summarise it and record by hand/)
  const longTitle = { ...ROOT, body: findingCommentBody({ severity: 'Low', title: 't'.repeat(REJECTION_TITLE_MAX + 1), why: 'w', fix: 'f' }) }
  assert.match(/** @type {any} */ (rejectionsFromThreads(answer([thread([longTitle, reply('Not a bug.')])]))).skipped[0], /title over 200 chars/)
})

test('decision id: the memory skill\'s hash of kind, normalized title and scope', () => {
  // printf 'decision\nunwrap in parser is fine\nsrc/parse.rs' | sha256sum | cut -c1-10
  assert.equal(decisionId('  Unwrap in   parser is FINE ', './src/parse.rs/'), decisionId('unwrap in parser is fine', 'src/parse.rs'))
  assert.equal(decisionId('unwrap in parser is fine', 'src/parse.rs'), 'decision-46833ecec3')
})

test('cli: unreadable input exits 2 and says why; a good answer prints the records', async () => {
  const bad = await run([])
  assert.equal(bad.exitCode, 2)
  assert.match(bad.stderr.join('\n'), /usage: pr-rejections/)
  const missing = await run(['/nonexistent/threads.json'])
  assert.equal(missing.exitCode, 2)
  assert.match(missing.stderr.join('\n'), /cannot read/)
  assert.match(String(rejectionsFromThreads({ data: {} })), /^not a reviewThreads answer/)
})

test('cli: a reviewThreads answer on disk prints the decision records as JSON', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-rejections-'))
  try {
    const file = path.join(dir, 'threads.json')
    fs.writeFileSync(file, JSON.stringify(answer([thread([ROOT, reply('By design.')])])))
    const r = await run([file])
    assert.equal(r.exitCode, 0)
    const out = JSON.parse(r.stdout.join('\n'))
    assert.equal(out.decisions[0].author, 'alice')
    assert.equal(out.decisions[0].commit, SHA)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
