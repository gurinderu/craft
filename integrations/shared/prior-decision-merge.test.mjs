// A record naming no commit anchored by the merge on the trunk of the pull request of this repository it links
// (realm @nick/craft, node #682): the links read, the scope-check answer read, and the split it drives, held to
// the case content/parity/memory-cases.json gives the Rust port; the scope-check line against a repository is
// integrations/shared/prior-decision-merge-repo.test.mjs.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parsePriorDecisions } from './prior-decisions.mjs'
import { pullLinks } from './prior-decision-record.mjs'
import { anchorMissingReason, anchorSince, decisionDate, hasAnchor } from './prior-decision-anchor.mjs'
import { applyPriorDecisions } from './prior-decision-apply.mjs'
import { SCOPE_CHECK_SCHEMA, readScopeCheck, runScopeCheck, scopeCheckPrompt } from './prior-decision-scope.mjs'

const parsed = (/** @type {Array<Record<string, unknown>>} */ ...over) =>
  /** @type {any[]} */ (parsePriorDecisions(over.map(o => ({ title: 't', reason: 'r', scope: 'src/a.rs', ...o }))).decisions)

const UNMERGED = 'no pull request of this repository it links is merged on the trunk, and it records no date — raised normally'

test('links: a pull request is a GitHub pull URL, its repository lower-cased, and nothing else is', () => {
  const links = [
    'https://github.com/owner/repo/pull/7',
    ' https://github.com/Owner/Repo/pull/8#discussion_r1 ',
    'HTTPS://GITHUB.COM/o.w_n-er/r.e_p-o/PULL/9/files',
    'https://github.com/o/r/pull/10?diff=split',
    'https://github.com/o/r/pull/123456789',
    'https://github.com/o/r/pull/1234567890',
    'https://github.com/o/r/pull/012',
    'https://github.com/o/r/pull/0',
    'https://github.com/o/r/pull/12abc',
    'https://github.com/o/r/pull/',
    'https://github.com/o/r/pull',
    'https://github.com/o/r/issues/12',
    'https://github.com/o/r/pulls/12',
    'https://github.com//r/pull/12',
    'https://github.com/o/r+x/pull/12',
    'https://github.com/o/r/x/pull/12',
    'http://github.com/o/r/pull/12',
    'https://gitlab.com/o/r/pull/12',
    'https://github.com.evil/o/r/pull/12',
    'https://example.com/pr/1#r1',
    'supersedes: decision-aaaaaaaaaa',
    42,
  ]
  assert.deepEqual(pullLinks(links), [
    { repo: 'owner/repo', number: 7 },
    { repo: 'owner/repo', number: 8 },
    { repo: 'o.w_n-er/r.e_p-o', number: 9 },
    { repo: 'o/r', number: 10 },
    { repo: 'o/r', number: 123456789 },
  ])
  const [d, plain] = parsed({ id: 'decision-p', links: ['https://example.com/x', 'https://github.com/o/r/pull/7'] }, { id: 'decision-q', when: '2026-05-01' })
  assert.deepEqual(d.pulls, [{ repo: 'o/r', number: 7 }])
  assert.equal(d.link, 'https://example.com/x')
  assert.equal('pulls' in plain, false)
})

test('anchor: a pull request it links anchors a record with no commit and no date; its words name the merge, else the date', () => {
  const [linked, undated, committed] = parsed(
    { id: 'decision-p', when: '2026-05-01', links: ['https://github.com/o/r/pull/7'] },
    { id: 'decision-u', links: ['https://github.com/o/r/pull/7'] },
    { id: 'decision-c', commit: 'abc1234', links: ['https://github.com/o/r/pull/7'] },
  )
  assert.ok(hasAnchor(undated))
  assert.equal(decisionDate(undated), '')
  assert.equal(anchorSince(linked, 7), 'the merge of PR #7')
  assert.equal(anchorSince(linked), 'the decision date 2026-05-01')
  assert.equal(anchorSince(undated), 'a merge on the trunk')
  assert.equal(anchorSince(committed), 'abc1234')
  assert.equal(anchorMissingReason(linked, 'future'), 'the decision date 2026-05-01 is in the future, so no commit precedes it — raised normally')
  assert.equal(anchorMissingReason(linked, 'unmerged'), UNMERGED)
  for (const said of ['missing', 'unmerged']) assert.equal(anchorMissingReason(undated, said), UNMERGED)
  assert.equal(anchorMissingReason(committed, 'unmerged'), 'commit abc1234 not found in this repo — raised normally')
})

test('scope answer: a merge is read with its number only for a record with no commit that links that request', async () => {
  const ans = {
    unchanged: [],
    missing: [],
    unusable: [{ id: 'u', word: 'unmerged' }],
    merged: [
      { id: 'a', pr: 7 },
      { id: 'b', pr: 8 },
      { id: 'c', pr: 7 },
      { id: 7, pr: 7 },
      { id: 'd', pr: '7' },
      { id: 'e', pr: 7.5 },
    ],
    reason: '',
  }
  assert.deepEqual(readScopeCheck(ans)?.merged, [
    { id: 'a', pr: 7 },
    { id: 'b', pr: 8 },
    { id: 'c', pr: 7 },
  ])
  assert.deepEqual(readScopeCheck({ unchanged: [], merged: 'x' })?.merged, [])
  const pr7 = ['https://github.com/o/r/pull/7']
  const ds = parsed({ id: 'a', links: pr7 }, { id: 'b', links: pr7 }, { id: 'c', commit: 'abc1234', links: pr7 }, { id: 'u', links: pr7 })
  const { merged, missing } = await runScopeCheck(ds, async () => ans, [])
  assert.deepEqual([...merged], [['a', 7]])
  assert.deepEqual([...missing], [['u', 'unmerged']])
  assert.ok(SCOPE_CHECK_SCHEMA.required.includes('merged'))
  assert.deepEqual(SCOPE_CHECK_SCHEMA.properties.merged.items.required, ['id', 'pr'])
  assert.match(scopeCheckPrompt(ds), /merged: \[\{id, pr\} for every id whose status was followed by merge and a number, pr that number\]/)
})

/**
 * What the case's scope check answers, as the Rust port's `scope_seen` reads it: each record's anchor named by the
 * first pull request `#N` the case's `merged` lists, else its day, else its first pull request.
 * @param {Record<string, any>} c @param {any[]} ds
 */
function caseAnswer(c, ds) {
  /** @type {{ unchanged: string[], missing: string[], unusable: Array<{ id: string, word: string }>, merged: Array<{ id: string, pr: number }> }} */
  const out = { unchanged: [], missing: [], unusable: [], merged: [] }
  for (const d of ds) {
    const pulls = /** @type {Array<{ number: number }>} */ (d.pulls ?? [])
    const merged = pulls.find(p => c['merged'].includes(`#${p.number}`))
    if (merged) out.merged.push({ id: d.id, pr: merged.number })
    const name = merged ? `#${merged.number}` : decisionDate(d) || `#${pulls[0]?.number}`
    if (c['unchanged'].includes(name)) out.unchanged.push(d.id)
    if (c['missing'].includes(name)) out.missing.push(d.id)
    if (c['unusable'][name]) out.unusable.push({ id: d.id, word: c['unusable'][name] })
  }
  return out
}

test('apply: the parity case of pull request anchors is split as the Rust port splits it', async () => {
  const file = JSON.parse(readFileSync(new URL('../../content/parity/memory-cases.json', import.meta.url), 'utf8'))
  const c = file.cases.find((/** @type {{ merged?: unknown }} */ x) => x.merged)
  const { decisions } = parsePriorDecisions(c.recall.decisions)
  const r = await applyPriorDecisions({ confirmed: c.findings }, decisions, async ds => caseAnswer(c, /** @type {any[]} */ (ds)))
  const pick = (/** @type {any[]} */ fs) => fs.map(f => ({ title: f.title, why: f.why }))
  assert.deepEqual(pick(r.tiers['confirmed'] ?? []), c.expected.kept)
  assert.deepEqual(pick(r.setAside), pick(c.expected.setAside))
  assert.ok(r.refused.includes(`decision decision-f5f5f5f5f5: ${UNMERGED}`), r.refused.join('\n'))
})
