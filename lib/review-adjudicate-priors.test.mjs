// Direct unit tests of lib/review-adjudicate-priors.mjs: how a re-review settles each prior-round
// finding — tombstones carved out, unverified priors carried, dismissals carry-checked, deferrals
// held or released, the rest adjudicated and a resolved Critical/High red-teamed — with a scripted
// ragent and the sandbox's parallel() and phase() faked.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { adjudicatePhase } from './review-adjudicate-priors.mjs'
import { CHANGED_SCHEMA, ADJUDICATE_SCHEMA, ATTACK_SCHEMA } from './review-schemas.mjs'

/** @param {string} file @param {Record<string, unknown>} [extra] */
const P = (file, extra = {}) => ({ fp: `fp-${file}`, file, line: 4, symbol: 'sym', severity: 'Medium', tier: 'confirmed', disposition: 'open', source: 'lens:x', ruleId: 'R-1', title: 't', why: 'w', ...extra })
const DEFERRAL = { id: 'Q-1', reason: 'later', who: 'nick', when: '2026-01-01', link: 'l', commit: 'c' }

/**
 * @param {any[] | null} ledger
 * @param {(prompt: string, opts: any) => unknown} answer
 * @param {{ head?: string, decisions?: any[], results?: any[], unverified?: any[] }} [o]
 */
async function run(ledger, answer, o = {}) {
  /** @type {any[]} */ const calls = []
  /** @type {string[]} */ const logs = []
  /** @type {string[]} */ const phases = []
  const sb = {
    log: (/** @type {string} */ l) => logs.push(l),
    phase: (/** @type {string} */ p) => phases.push(p),
    parallel: (/** @type {Array<() => unknown>} */ ts) => Promise.all(ts.map(t => Promise.resolve().then(t).catch(() => null))),
  }
  const ragent = async (/** @type {string} */ prompt, /** @type {any} */ opts) => { calls.push({ prompt, ...opts }); return answer(prompt, opts) }
  const reviewRun = /** @type {any} */ ({ ragent, sb, priorDecisionsIn: { decisions: o.decisions ?? [] } })
  const priorRound = ledger && /** @type {any} */ ({ round: 2, head: o.head ?? 'abc', ledger })
  const state = /** @type {any} */ ({ tierLists: { unverified: o.unverified ?? [] }, priorRound, results: o.results ?? [{ plan: { lensModel: 'big' } }], active: [{ rubricSkill: 'craft:rust-review' }] })
  const out = await adjudicatePhase(reviewRun, state)
  return { ...out, calls, logs, phases }
}
/** @param {Record<string, unknown>} byPrefix */
const by = byPrefix => (/** @type {string} */ _p, /** @type {any} */ o) => {
  const hit = Object.entries(byPrefix).find(([k]) => o.label.startsWith(k))
  return hit ? hit[1] : null
}
/** @param {any} out */
const files = out => Object.fromEntries(Object.entries(out.adjudicated).map(([k, v]) => [k, /** @type {any[]} */ (v).map(f => f.file)]))

test('without a prior ledger nothing is entered or dispatched', async () => {
  for (const ledger of [null, []]) {
    const out = await run(ledger, () => { throw new Error('none') }, { unverified: [{ file: 'u' }] })
    assert.deepEqual([out.phases, out.calls, out.logs, out.priorTombstones, out.carriedDeferred()], [[], [], [], [], []])
    assert.deepEqual(out.unverified, [{ file: 'u' }])
    assert.deepEqual(files(out), { resolved: [], stillOpen: [], regressed: [], carried: [], retired: [] })
  }
})

test('closed rows become tombstones and unverified priors re-enter the unverified track, both undispatched', async () => {
  const out = await run([P('c.rs', { disposition: 'closed', severity: 'HIGH' }), P('u.rs', { tier: 'unverified', fix: 'keep', why: 'w — fix incomplete: x' }), P('v.rs', { tier: 'unverified' })], () => null, { unverified: [{ file: 'own' }] })
  assert.deepEqual(out.phases, ['Adjudicate'])
  assert.deepEqual(out.priorTombstones.map(f => [f.file, f.severity]), [['c.rs', 'High']], 'severity is canonical from the load on')
  assert.equal(out.calls.length, 0)
  assert.deepEqual(out.unverified.map(f => [f.file, f.tier, f.fix, f.blastRadius, f.carriedUnverified]), [
    ['own', undefined, undefined, undefined, undefined],
    ['u.rs', 'unverified', 'keep', '', true],
    ['v.rs', 'unverified', 'verify it first — nothing has checked this claim against the code', '', true],
  ])
  assert.equal(out.unverified[1]?.why, 'w (STILL NOT VERIFIED: carried from round 2, where no verifier judged it; nothing has checked it against the code since)')
  assert.equal(out.logs[0], '2 prior finding(s) carry the unverified tier — never checked against the code, so nothing to adjudicate: carried forward as unverified rather than promoted to still-open')
})

test('a dismissal is carry-checked: unchanged retires, changed reopens, a dead check keeps it carried', async () => {
  const ledger = [P('same.rs', { disposition: 'rejected' }), P('moved.rs', { disposition: 'justified' }), P('dead.rs', { disposition: 'rejected' })]
  const out = await run(ledger, (_, o) => (o.label.includes('same') ? { changed: false } : o.label.includes('moved') ? { changed: 1 } : null))
  assert.deepEqual(files(out), { resolved: [], stillOpen: ['moved.rs'], regressed: [], carried: ['dead.rs'], retired: ['same.rs'] })
  const [c] = out.calls
  assert.deepEqual({ label: c.label, phase: c.phase, schema: c.schema, model: c.model }, { label: 'carry:same.rs:4', phase: 'Adjudicate', schema: CHANGED_SCHEMA, model: 'sonnet' })
  assert.match(c.prompt, /^A prior review finding was set aside by the author \(disposition: rejected\)\. Decide only whether the CODE AROUND IT CHANGED since commit abc\./)
  assert.ok(c.prompt.includes("Run `git diff 'abc'...HEAD -- 'same.rs'`"))
  assert.ok(c.prompt.includes('FINDING: [Medium] t — at same.rs:4 (symbol sym), rule R-1.'))
  assert.equal(out.adjudicated.stillOpen[0]?.why, 'w (reopened: dismissed as justified, but the code around it changed — re-verify the justification)')
  assert.ok(out.logs.includes('⚠️ carry-check for dead.rs:4 died — kept as carried by default'))
  assert.ok(out.logs.at(-1)?.endsWith('· 1 carry died'))
})

test('with no prior head the carry-check diffs against HEAD alone', async () => {
  const out = await run([P('a.rs', { disposition: 'rejected' })], () => ({ changed: false }), { head: '' })
  assert.ok(out.calls[0].prompt.includes("Run `git diff HEAD -- 'a.rs'`"))
})

test('a held deferral is carried while its code stands, and adjudicated once it moved', async () => {
  const ledger = [P('kept.rs', { disposition: 'deferred', deferral: DEFERRAL }), P('moved.rs', { disposition: 'deferred', deferral: DEFERRAL })]
  const out = await run(ledger, by({ 'carry:kept': { changed: false }, 'carry:moved': { changed: true }, adjudicate: { status: 'still-open', attack: '' } }))
  assert.deepEqual(files(out), { resolved: [], stillOpen: ['moved.rs'], regressed: [], carried: ['kept.rs'], retired: [] })
  assert.deepEqual(out.calls.map(c => c.label), ['carry:kept.rs:4', 'carry:moved.rs:4', 'adjudicate:moved.rs:4'])
  assert.deepEqual(out.carriedDeferred().map(f => [f.file, f.priorKind]), [['kept.rs', 'question']])
})

test('a deferral holds nothing without a question, on a Critical/High, or once a record releases it', async () => {
  const ledger = [
    P('bare.rs', { disposition: 'deferred' }),
    P('high.rs', { disposition: 'deferred', deferral: DEFERRAL, severity: 'high' }),
    P('released.rs', { disposition: 'deferred', deferral: DEFERRAL }),
  ]
  const decisions = [{ id: 'D-9', supersedes: ['Q-1'] }]
  const out = await run(ledger, by({ adjudicate: { status: 'regressed', note: 'n' } }), { decisions })
  assert.deepEqual(out.calls.map(c => c.label), ['adjudicate:bare.rs:4', 'adjudicate:high.rs:4', 'adjudicate:released.rs:4'])
  assert.ok(out.logs.includes('Re-review: bare.rs:4 is marked deferred but carries no question\'s deferral — adjudicated like any prior'))
  assert.ok(out.logs.includes('Re-review: the deferral on released.rs:4 no longer holds — a record supersedes or answers its question Q-1 — adjudicated like any prior'))
  assert.equal(out.adjudicated.regressed.length, 3)
  assert.equal(out.carriedDeferred().length, 0)
})

test('the adjudicator is asked with the rubric and the lens model, and every fate is tallied', async () => {
  const ledger = ['res', 'open', 'dead', 'cant', 'demote'].map(n => P(`${n}.rs`))
  const out = await run(ledger, by({
    'adjudicate:res': { status: 'resolved', attack: '', note: '' },
    'adjudicate:open': { status: 'still-open', attack: 'x' },
    'adjudicate:cant': { status: 'cannot-tell', note: 'gone' },
    'adjudicate:demote': { status: 'resolved', attack: 'still breaks' },
  }))
  const c = out.calls[0]
  assert.deepEqual({ label: c.label, phase: c.phase, schema: c.schema, model: c.model }, { label: 'adjudicate:res.rs:4', phase: 'Adjudicate', schema: ADJUDICATE_SCHEMA, model: 'big' })
  assert.match(c.prompt, /^You are adjudicating whether a prior review finding is still present after a fix attempt\. Load the craft:rust-review skill for the rubric\./)
  assert.ok(c.prompt.includes('  originally at res.rs:4 (enclosing symbol sym), rule R-1\n  why it mattered: w\n'))
  assert.equal(out.calls.length, 5, 'a resolved Medium is not red-teamed')
  assert.deepEqual(files(out), { resolved: ['res.rs'], stillOpen: ['open.rs', 'dead.rs', 'cant.rs', 'demote.rs'], regressed: [], carried: [], retired: [] })
  for (const l of [
    '⚠️ adjudicator for demote.rs:4 returned resolved WITH an attack — demoting to still-open',
    '⚠️ adjudicator for cant.rs:4 could not tell — kept still-open, marked UNVERIFIED in the report',
    '⚠️ adjudicator for dead.rs:4 died — no verdict returned; kept still-open by default',
  ]) assert.ok(out.logs.includes(l), l)
  assert.equal(out.logs.at(-1), 'Adjudicate: 1 resolved · 4 still-open · 0 regressed · 0 carried · 0 carried→retired (code unchanged; leaves the ledger) · 0 overturned by red-team · 0 red-team died · 0 invalid red-team · 1 adjudicator died · 1 could not tell · 0 carry died')
})

test('a resolved Critical/High is red-teamed: a real attack reopens it, a dead or empty one does not', async () => {
  const ledger = ['beat', 'dead', 'empty', 'held'].map(n => P(`${n}.rs`, { severity: 'Critical' }))
  const out = await run(ledger, by({
    adjudicate: { status: 'resolved', attack: '', note: '', invariant: 'inv' },
    'redteam:beat': { defeated: true, attack: 'overlap' },
    'redteam:empty': { defeated: true, attack: '' },
    'redteam:held': { defeated: false, attack: '' },
  }), { results: [] })
  const rt = out.calls.filter(c => c.label.startsWith('redteam'))
  assert.deepEqual(rt.map(c => c.label), ['redteam:beat.rs:4', 'redteam:dead.rs:4', 'redteam:empty.rs:4', 'redteam:held.rs:4'])
  assert.deepEqual({ phase: rt[0].phase, schema: rt[0].schema, model: rt[0].model }, { phase: 'Adjudicate', schema: ATTACK_SCHEMA, model: 'opus' }, 'no plan: the default model')
  assert.match(rt[0].prompt, /^A code-review finding was raised on an earlier revision of this repo and the author has since pushed fix commits\. Attack the fix\./)
  assert.ok(rt[0].prompt.includes('INVARIANT it violated: inv'))
  assert.deepEqual(files(out), { resolved: ['dead.rs', 'empty.rs', 'held.rs'], stillOpen: ['beat.rs'], regressed: [], carried: [], retired: [] })
  assert.ok(out.logs.includes('⚠️ red-team for dead.rs:4 died — "resolved" stands on the adjudicator\'s own attack pass only'))
  assert.ok(out.logs.includes('⚠️ red-team for empty.rs:4 claimed defeat with NO attack — invalid verdict discarded, keeping resolved'))
  assert.match(String(out.logs.at(-1)), /· 1 overturned by red-team · 1 red-team died · 1 invalid red-team · 0 adjudicator died ·/)
})
