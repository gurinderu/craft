// A rejection in another reviewer's thread (realm @nick/craft, node #302): the root carries no craft marker
// and may come from anyone; the last word rejects it, from an owner, member or collaborator — the PR
// author only when they are one; it is recorded like a craft thread's (lib/pr-thread-rule.mjs), and both kinds of thread
// read side by side across one PR (lib/pr-rejections.mjs). Fields as `gh api graphql` returns them.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { findingCommentBody } from './finding-comment.mjs'
import { rejectionsFromThreads } from './pr-rejections.mjs'
import { decisionId } from './pr-thread-rule.mjs'
import { remarkTitle, reviewerThreadDecision, REMARK_TITLE_MAX } from './pr-reviewer-thread.mjs'

const SHA = '33d0240d4fe01138d7ac11798003c13b1f6dd24e'
/** @param {string} who @param {string} assoc @param {string} body @param {string} [url] */
const comment = (who, assoc, body, url = 'https://x/pull/9#r2') => ({ author: { login: who }, authorAssociation: assoc, body, url, createdAt: '2026-10-02T11:00:00Z', originalCommit: { oid: SHA } })
const REMARK = comment('snitch-bot', 'NONE', '**FR-12: retry loop has no upper bound**\n\nIt may spin forever.', 'https://x/pull/9#r1')
/** @param {any[]} comments @param {Record<string, unknown>} [over] */
const thread = (comments, over = {}) => ({ path: 'src/retry.rs', originalLine: 40, comments: { totalCount: comments.length, nodes: comments }, ...over })
/** @param {any[]} nodes @param {string} [prAuthor] */
const answer = (nodes, prAuthor = 'carol') => ({ data: { repository: { pullRequest: { author: { login: prAuthor }, reviewThreads: { totalCount: nodes.length, nodes } } } } })
/** @param {unknown} a @returns {{ decisions: any[], skipped: string[] }} */
const read = a => /** @type {any} */ (rejectionsFromThreads(a))

test('another reviewer\'s remark rejected by a PR author who maintains the repo is a decision, titled by its first line, anchored at its line', () => {
  const r = read(answer([thread([REMARK, comment('carol', 'OWNER', 'By design: the caller caps it.')])]))
  assert.deepEqual(r.decisions, [{
    id: decisionId('FR-12: retry loop has no upper bound', 'src/retry.rs'), kind: 'decision', title: 'FR-12: retry loop has no upper bound',
    body: 'By design: the caller caps it.', scope: 'src/retry.rs', status: 'active', date: '2026-10-02', author: 'carol', commit: SHA,
    links: ['https://x/pull/9#r2', 'https://x/pull/9#r1'], line: 40,
  }])
  assert.deepEqual(r.skipped, [])
})

test('a maintainer who is not the PR author may reject a remark; a human reviewer\'s root counts like a tool\'s', () => {
  for (const assoc of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    const r = read(answer([thread([comment('dave', 'NONE', 'Nit: this clone looks unneeded'), comment('alice', assoc, 'Not an issue, it is cheap here')])]))
    assert.equal(r.decisions[0]?.author, 'alice', assoc)
    assert.equal(r.decisions[0]?.title, 'Nit: this clone looks unneeded')
  }
})

test('conservative: no reply, a fixed reply, a later word, a drive-by rejecter, an outsider dismissing their own remark', () => {
  const none = (/** @type {any[]} */ cs, prAuthor = 'carol') => read(answer([thread(cs)], prAuthor))
  assert.deepEqual(none([REMARK]), { decisions: [], skipped: [] }, 'no reply is no rejection, and an open remark is not listed')
  const resolved = read(answer([thread([REMARK], { isResolved: true, resolvedBy: { login: 'carol' } })]))
  assert.deepEqual(resolved, { decisions: [], skipped: [] }, 'resolved silently is not a rejection (node #185)')
  assert.deepEqual(none([REMARK, comment('carol', 'CONTRIBUTOR', 'Fixed in abc123')]), { decisions: [], skipped: [] })
  assert.equal(none([REMARK, comment('carol', 'CONTRIBUTOR', 'Not a bug.'), comment('snitch-bot', 'NONE', 'It is.')]).decisions.length, 0)
  const driveBy = none([REMARK, comment('mallory', 'NONE', 'Not a bug.')])
  assert.equal(driveBy.decisions.length, 0)
  assert.match(driveBy.skipped.join('\n'), /src\/retry\.rs: FR-12: retry loop has no upper bound \(reviewer snitch-bot\) — rejected by mallory \(association NONE\), who is neither the PR author/)
  assert.match(driveBy.skipped.join('\n'), /1 rejection\(s\) not recorded: the replier is neither the PR author/)
  const self = none([comment('carol', 'CONTRIBUTOR', 'unbounded retry'), comment('carol', 'CONTRIBUTOR', 'Not a bug.')])
  assert.equal(self.decisions.length, 0)
  assert.match(self.skipped.join('\n'), /rejected by carol \(association CONTRIBUTOR\), the PR author but not an owner, member or collaborator: another reviewer's remark is not theirs to settle, not recorded/)
  assert.match(self.skipped.join('\n'), /1 rejection\(s\) of another reviewer's remark not recorded: the PR author is not OWNER\/MEMBER\/COLLABORATOR/)
  // A second account (node #302): the remark from one login, the PR author's rejection from another.
  const second = none([REMARK, comment('carol', 'CONTRIBUTOR', 'Not a bug.')])
  assert.equal(second.decisions.length, 0, 'an outside PR author cannot settle another reviewer\'s remark for the project')
  assert.match(second.skipped.join('\n'), /\(reviewer snitch-bot\) — rejected by carol \(association CONTRIBUTOR\), the PR author but not/)
  for (const assoc of ['NONE', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', '']) {
    assert.equal(none([REMARK, comment('carol', assoc, 'Not a bug.')]).decisions.length, 0, assoc)
  }
  const owner = none([comment('nick', 'OWNER', 'unbounded retry'), comment('nick', 'OWNER', 'Not a bug.')], 'nick')
  assert.equal(owner.decisions.length, 1, 'a maintainer may settle their own remark')
})

test('bounds and anchors: past the comments read, no text, no commit — named, not recorded', () => {
  const many = reviewerThreadDecision(thread([REMARK, comment('carol', 'OWNER', 'Not a bug.')], { comments: { totalCount: 60, nodes: [REMARK, comment('carol', 'OWNER', 'Not a bug.')] } }), 'carol')
  assert.match(String(many), /60 comments, past the 50 read/)
  const blank = reviewerThreadDecision(thread([comment('x', 'NONE', '  \n'), comment('carol', 'OWNER', 'Not a bug.')]), 'carol')
  assert.match(String(blank), /\(remark without text\) .* no text to title the decision/)
  const noCommit = reviewerThreadDecision(thread([{ ...REMARK, originalCommit: null }, comment('carol', 'OWNER', 'Not a bug.')]), 'carol')
  assert.match(String(noCommit), /no path or commit to anchor the decision to/)
  assert.equal(reviewerThreadDecision({ path: 'a' }, 'carol'), null)
})

test('remarkTitle drops heading, quote and emphasis marks and cuts a long line at a word', () => {
  assert.equal(remarkTitle('\n\n> ### **Unbounded retry**  \nmore'), 'Unbounded retry')
  assert.equal(remarkTitle('- `x` leaks'), '`x` leaks', 'code spans are kept')
  assert.equal(remarkTitle(''), '')
  const long = remarkTitle(`${'word '.repeat(40)}end`)
  assert.ok(long.length <= REMARK_TITLE_MAX + 1 && long.endsWith('…'), long)
  assert.ok(!long.slice(0, -1).endsWith(' '))
  assert.equal(remarkTitle('x'.repeat(200)), `${'x'.repeat(REMARK_TITLE_MAX)}…`, 'one long word is cut where it is')
})

test('both kinds of thread on one PR: a craft finding and another reviewer\'s remark are each recorded', () => {
  const craftRoot = comment('nick', 'OWNER', findingCommentBody({ severity: 'Medium', title: 'unwrap in parser may panic', why: 'panics', fix: 'return an error' }), 'https://x/pull/9#c1')
  const r = read(answer([
    thread([craftRoot, comment('carol', 'CONTRIBUTOR', 'Not a bug: validated upstream.')], { path: 'src/parse.rs' }),
    thread([REMARK, comment('alice', 'MEMBER', "Won't fix: capped by the caller.")]),
  ]))
  assert.deepEqual(r.decisions.map(d => [d.scope, d.title]), [['src/parse.rs', 'unwrap in parser may panic'], ['src/retry.rs', 'FR-12: retry loop has no upper bound']])
})
