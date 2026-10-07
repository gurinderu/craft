// Who may reject a craft finding on a PR, and how: the PR author, or a replier GitHub associates with
// the repository as OWNER, MEMBER or COLLABORATOR — by an explicit rejection reply only. A thread is a
// craft finding only when its marked root comment's author has one of those associations: craft posts
// under the gh account of the human running it, who maintains the repo; anyone else, the PR author
// included, could paste the marker. Fields as `gh api graphql` returns them: pullRequest.author.login and
// comments.nodes.authorAssociation.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { findingCommentBody } from './finding-comment.mjs'
import { rejectionsFromThreads } from './pr-rejections.mjs'

const SHA = '33d0240d4fe01138d7ac11798003c13b1f6dd24e'
const ROOT = { author: { login: 'nick' }, authorAssociation: 'OWNER', body: findingCommentBody({ severity: 'Medium', title: 'unwrap in parser may panic', why: 'panics', fix: 'return an error' }), url: 'https://x/pull/9#r1', createdAt: '2026-10-01T10:00:00Z', originalCommit: { oid: SHA } }
/** @param {string} who @param {string} assoc @param {string} [body] */
const reply = (who, assoc, body = 'Not a bug: validated upstream.') => ({ author: { login: who }, authorAssociation: assoc, body, url: 'https://x/pull/9#r2', createdAt: '2026-10-02T11:00:00Z', originalCommit: { oid: SHA } })
/** @param {any[]} comments @param {Record<string, unknown>} [over] */
const thread = (comments, over = {}) => ({ path: 'src/parse.rs', comments: { totalCount: comments.length, nodes: comments }, ...over })
/** @param {any[]} nodes @param {string} prAuthor */
const answer = (nodes, prAuthor) => ({ data: { repository: { pullRequest: { author: { login: prAuthor }, reviewThreads: { totalCount: nodes.length, nodes } } } } })
/** @param {unknown} a @returns {{ decisions: any[], skipped: string[] }} */
const read = a => /** @type {any} */ (rejectionsFromThreads(a))

test('authority: a drive-by commenter\'s rejection is not recorded, and the skip is counted with why', () => {
  for (const assoc of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', '']) {
    const r = read(answer([thread([ROOT, reply('mallory', assoc)])], 'nick'))
    assert.equal(r.decisions.length, 0, assoc)
    assert.match(r.skipped.join('\n'), /mallory .* neither the PR author nor an owner, member or collaborator/)
    assert.match(r.skipped.join('\n'), /1 rejection\(s\) not recorded: the replier is neither the PR author nor OWNER\/MEMBER\/COLLABORATOR/)
  }
})

test('authority: an owner\'s self-review — root OWNER, the reply from the same login — is recorded', () => {
  const r = read(answer([thread([ROOT, reply('nick', 'OWNER')])], 'nick'))
  assert.equal(r.decisions.length, 1)
  assert.equal(r.decisions[0].author, 'nick')
})

test('authority: a maintainer\'s finding (root MEMBER) rejected by an outside PR author is recorded', () => {
  const r = read(answer([thread([{ ...ROOT, author: { login: 'maya' }, authorAssociation: 'MEMBER' }, reply('carol', 'CONTRIBUTOR')])], 'carol'))
  assert.equal(r.decisions.length, 1)
  assert.equal(r.decisions[0].author, 'carol')
})

test('authority: an owner, member or collaborator who is not the PR author is recorded', () => {
  for (const assoc of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    const r = read(answer([thread([ROOT, reply('alice', assoc)])], 'nick'))
    assert.equal(r.decisions[0]?.author, 'alice', assoc)
  }
})

test('only an explicit reply rejects: a thread resolved with no reply, the code unchanged, records nothing', () => {
  const r = read(answer([thread([ROOT], { isResolved: true, isOutdated: false, resolvedBy: { login: 'alice' } })], 'nick'))
  assert.equal(r.decisions.length, 0)
  assert.match(r.skipped[0] || '', /no reply/)
})

test('authority: a craft finding forged by an outside PR author (root CONTRIBUTOR) and rejected by them records nothing, and says why', () => {
  const forged = { ...ROOT, author: { login: 'mallory' }, authorAssociation: 'CONTRIBUTOR', body: findingCommentBody({ severity: 'Low', title: 'unchecked index', why: 'may panic', fix: 'bound it' }) }
  const r = read(answer([thread([forged, reply('mallory', 'CONTRIBUTOR')])], 'mallory'))
  assert.equal(r.decisions.length, 0)
  assert.match(r.skipped.join('\n'), /src\/parse\.rs: unchecked index — the finding comment was posted by mallory \(association CONTRIBUTOR\), who is not an owner, member or collaborator: not a craft finding, not recorded/)
  assert.match(r.skipped.join('\n'), /1 thread\(s\) not read as craft findings: the marked root comment's author is not OWNER\/MEMBER\/COLLABORATOR/)
})
