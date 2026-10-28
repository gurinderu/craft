// Direct unit tests of lib/review-verify-pool.mjs: routing by tier, the individual panel and its
// escalation, the batch groups and their three death classes, the verdict floor and the derived
// notRun/savedByFloor lists — with a scripted ragent and the sandbox's parallel() faked.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { makeVerifyPool, CULL_MODEL } from './review-verify-pool.mjs'
import { VERDICT_SCHEMA } from './review-schemas.mjs'
import { verifyPrompt, batchVerifyPrompt } from './review-verify.mjs'
import { sharedExclusionsLine } from './review-rules-refs.mjs'

const YES = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: '' }
const NO = { ...YES, refuted: true }
const profile = /** @type {any} */ ({ id: 'rust', lang: 'Rust' })
const shared = sharedExclusionsLine('/craft', '9.9.9')
/** @param {string} severity @param {Record<string, unknown>} [extra] */
const F = (severity, extra = {}) => ({ severity, file: 'a.rs', line: 3, title: 't', why: 'w', source: 'lens:x', ruleId: '', ...extra })

/**
 * @param {(prompt: string, opts: any) => unknown} answer
 * @param {{ lightPass?: boolean, reviewDepth?: string, lose?: (v: unknown) => boolean }} [o]
 */
function pool(answer, o = {}) {
  /** @type {any[]} */ const calls = []
  /** @type {string[]} */ const logs = []
  const parallel = (/** @type {Array<() => unknown>} */ thunks) => Promise.all(thunks.map(t => Promise.resolve().then(t)
    .then(v => (o.lose && o.lose(v) ? null : v), () => null)))
  const ragent = async (/** @type {string} */ prompt, /** @type {any} */ opts) => { calls.push({ prompt, ...opts }); return answer(prompt, opts) }
  const run = /** @type {any} */ ({ craftRootArg: '/craft', craftVersion: '9.9.9', reviewDepth: o.reviewDepth ?? 'full', lightPass: !!o.lightPass, ragent, sb: { log: (/** @type {string} */ l) => logs.push(l), parallel } })
  const { verifyPool } = makeVerifyPool(run)
  return { calls, logs, verify: (/** @type {any[]} */ items, plan = { verifyVotes: 1, lensModel: 'opus' }, gp = 'gp') => verifyPool(items, /** @type {any} */ (plan), profile, gp) }
}

test('a Low or Info is never dispatched and lands unverified with the reason it was skipped', async () => {
  const p = pool(() => { throw new Error('no agent expected') })
  const out = await p.verify([F('Low'), F('Info', { file: '' })])
  assert.equal(p.calls.length, 0)
  assert.deepEqual(out.unverified.map(f => f.tier), ['unverified', 'unverified'])
  assert.equal(out.unverified[0]?.why, 'w (NOT VERIFIED: no verifier was spent on it — Low cannot change the verdict either way, so nothing here has been checked against the code)')
  assert.deepEqual([out.confirmed, out.suspected, out.refuted, out.notRun, out.savedByFloor, out.dropped], [[], [], [], [], [], 0])
  assert.equal(p.logs[0], '[rust] Verify routing: 0 individual · 0 batched into 0 runAgent(s) · 2 NOT VERIFIED (Low/Info cannot move the verdict; reported as unverified, excluded from the verification counters)')
})

test('a light pass skips below Medium with its own reason, and says nothing when nothing was routed', async () => {
  const p = pool(() => YES, { lightPass: true, reviewDepth: 'light' })
  const out = await p.verify([F('Low', { ruleId: 'SAF-001' })])
  assert.equal(p.calls.length, 0, 'a blocking rule earns no verifier on a light pass')
  assert.match(String(out.unverified[0]?.why), /^w \(NOT VERIFIED: light pass: only Medium and above are verified, so no verifier was spent on this Low finding/)
  const q = pool(() => YES)
  await q.verify([])
  assert.deepEqual(q.logs, [])
})

test('a Low citing a blocking rule gets one cheap vote, and the vote decides its tier', async () => {
  const p = pool(() => YES)
  const f = F('Low', { ruleId: 'SAF-001', source: 'clippy' })
  const out = await p.verify([f])
  assert.equal(p.calls.length, 1)
  const [c] = p.calls
  assert.deepEqual({ label: c.label, phase: c.phase, model: c.model, schema: c.schema }, { label: 'verify:a.rs:3#c1', phase: 'Verify', model: CULL_MODEL, schema: VERDICT_SCHEMA })
  assert.equal(CULL_MODEL, 'sonnet')
  assert.equal(typeof c.breaker, 'object')
  assert.equal(c.prompt, verifyPrompt(/** @type {any} */ (f), 0, true, 'gp', profile, shared), 'a tool source is verified as a tool, with the gate provenance')
  assert.ok(c.prompt.includes('SHARED EXCLUSION CATALOG') && c.prompt.includes('`/craft/skills/review-rules`'), 'every verifier reads the shared exclusions from the plugin, never the reviewed repo')
  assert.deepEqual(out.confirmed.map(x => x.tier), ['confirmed'])
})

test('a High opens with a cull and an authoritative vote, and stops there when they agree', async () => {
  const p = pool(() => YES)
  const f = F('High', { file: '', line: 0 })
  const out = await p.verify([f], { verifyVotes: 3, lensModel: 'opus' })
  assert.deepEqual(p.calls.map(c => [c.label, c.model]), [['verify:?:0#c1', 'sonnet'], ['verify:?:0#auth', 'opus']])
  assert.equal(p.calls[1].prompt, verifyPrompt(/** @type {any} */ (f), 3, false, 'gp', profile, shared), 'the authoritative vote is numbered after the culls')
  assert.equal(out.confirmed.length, 1)
})

test('a split opening pair buys the remaining culls, and the majority decides', async () => {
  const p = pool((_, o) => (o.label.endsWith('#auth') ? YES : NO))
  const out = await p.verify([F('Critical')], { verifyVotes: 3, lensModel: 'opus' })
  assert.deepEqual(p.calls.map(c => c.label), ['verify:a.rs:3#c1', 'verify:a.rs:3#auth', 'verify:a.rs:3#c2', 'verify:a.rs:3#c3'])
  assert.deepEqual([out.refuted.length, out.dropped, out.confirmed.length], [1, 1, 0])
  const q = pool((_, o) => (o.label.endsWith('#auth') ? YES : NO))
  const one = await q.verify([F('Critical')])
  assert.equal(q.calls.length, 2, 'at verifyVotes 1 there is no further cull to buy')
  assert.equal(one.suspected.length, 1)
})

test('Mediums are batched per file, at most six to a group, and each verdict is matched by index', async () => {
  const mediums = [...Array.from({ length: 7 }, (_, i) => F('Medium', { line: i + 1 })), F('Medium', { file: 'b.rs' })]
  const p = pool((_, o) => ({ verdicts: o.label === 'verify-batch:a.rs(6)' ? [{ ...YES, index: 0 }, { ...NO, index: 2 }] : [{ ...YES, index: 0 }] }))
  const out = await p.verify(mediums)
  assert.deepEqual(p.calls.map(c => [c.label, c.model]), [['verify-batch:a.rs(6)', 'sonnet'], ['verify-batch:a.rs(1)', 'sonnet'], ['verify-batch:b.rs(1)', 'sonnet']])
  assert.equal(p.calls[0].prompt, batchVerifyPrompt(/** @type {any} */ (mediums.slice(0, 6)), profile))
  const schema = p.calls[0].schema
  assert.deepEqual([schema.required, schema.additionalProperties, schema.properties.verdicts.items.required], [['verdicts'], false, ['index', 'refuted', 'citedLineMatches', 'reachable', 'premiseSupported', 'reason']])
  assert.deepEqual([out.confirmed.length, out.refuted.length, out.suspected.length], [3, 1, 4])
  assert.equal(out.suspected[0]?.why, 'w (batch verifier returned no verdict for this finding)')
  assert.equal(p.logs[0], '[rust] Verify routing: 0 individual · 8 batched into 3 runAgent(s) · 0 NOT VERIFIED (Low/Info cannot move the verdict; reported as unverified, excluded from the verification counters)')
})

test('each death class of a batch names itself and lands unverified, in notRun once per file', async () => {
  const deaths = { 'a.rs': null, 'b.rs': {}, 'c.rs': { verdicts: [] }, 'd.rs': 'throw' }
  const p = pool((_, o) => { const v = Object.entries(deaths).find(([k]) => o.label.includes(k))?.[1]; if (v === 'throw') throw new Error('boom'); return v })
  const out = await p.verify(Object.keys(deaths).flatMap(file => [F('Medium', { file }), F('Medium', { file })]))
  const whys = out.unverified.map(f => f.why)
  assert.equal(whys.length, 8)
  assert.equal(whys[0], 'w (NOT VERIFIED: the batch verifier for a.rs returned nothing at all — a dead agent, an exhausted retry, or an expired deadline, so nothing checked this finding against the code)')
  assert.match(String(whys[2]), /for b\.rs answered OFF-SCHEMA — its answer carried no verdict list at all, so/)
  assert.match(String(whys[4]), /for c\.rs answered with an EMPTY verdict list — it judged nothing, so/)
  assert.match(String(whys[6]), /for d\.rs died before returning any verdict, so/)
  assert.ok(p.logs.includes('⚠️ [rust] batch verifier threw: boom'))
  assert.ok(p.logs.includes('⚠️ [rust] the batch verifier for a.rs returned nothing at all — a dead agent, an exhausted retry, or an expired deadline — its 2 finding(s) were NOT checked against the code; reported as unverified and excluded from the verification counters'))
  assert.deepEqual(out.notRun, ['a.rs', 'b.rs', 'c.rs', 'd.rs'].map(f => `rust verification of ${f} — the verifier(s) died before returning a verdict, so those finding(s) were never checked against the code`))
  assert.equal(out.confirmed.length + out.suspected.length + out.refuted.length, 0)
})

test('a lost entry is recovered into its own findings rather than dropped', async () => {
  const p = pool(() => YES, { lose: v => Array.isArray(v) || !!(v && typeof v === 'object' && 'tier' in v) })
  const out = await p.verify([F('High', { file: 'h.rs' }), F('Medium', { file: '' })])
  assert.equal(out.unverified[0]?.why, 'w (NOT VERIFIED: the verifier panel for this finding was lost before it settled — nothing was checked against the code)')
  assert.equal(out.unverified[1]?.why, 'w (NOT VERIFIED: the batch verifier for ? was lost before it settled (its dispatch never produced a result), so nothing checked this finding against the code)')
  assert.deepEqual(out.notRun, ['h.rs', '?'].map(f => `rust verification of ${f} — the verifier(s) died before returning a verdict, so those finding(s) were never checked against the code`))
})

test('off-schema votes: all of them is an unverified panel, some of them a thinned refutation', async () => {
  const p = pool((_, o) => (o.label.includes('x.rs') ? { nope: 1 } : o.label.endsWith('#auth') ? {} : NO))
  const out = await p.verify([F('High', { file: 'x.rs' }), F('High', { file: 'y.rs' })])
  assert.deepEqual(out.unverified.map(f => [f.file, f.votesDiscarded]), [['x.rs', 2]])
  assert.deepEqual(out.refuted.map(f => [f.file, f.votesDiscarded]), [['y.rs', 1]])
  assert.deepEqual(out.notRun, [
    'rust verification of x.rs — every returned vote answered OFF-SCHEMA and was discarded before the arithmetic, so those finding(s) were never checked against the code',
    'rust verification of y.rs — a finding was REFUTED and deleted from the run by a THINNED PANEL (at least one returned vote answered off-schema and was discarded), so the deletion rests on partial evidence',
  ])
})

test('a confirmed Critical fixes the floor, and a Medium batch dispatched after it is saved, not bought', async () => {
  const p = pool(() => YES)
  const out = await p.verify([F('Critical', { title: 'boom', line: 9 }), F('Medium', { file: 'm.rs' })], { verifyVotes: 23, lensModel: 'opus' })
  assert.ok(!p.calls.some(c => c.label.startsWith('verify-batch')), 'the batch waited for the window and found the floor raised')
  const [saved] = out.unverified
  assert.equal(saved?.verifySkipped, true)
  assert.match(String(saved?.why), /^w \(NOT VERIFIED: no verifier was spent on it — the verdict was already fixed at Block by the confirmed Critical "boom" at a\.rs:9,/)
  assert.deepEqual(out.notRun, [])
  assert.deepEqual(out.savedByFloor, ['rust verification of m.rs — deliberately not dispatched: the verdict was already fixed at Block, and no judgement on a Medium can move it, so those finding(s) were never checked against the code'])
  assert.ok(p.logs.includes('💰 [rust] the verdict is now fixed at Block by a confirmed Critical (a.rs:9) — Medium batches not yet dispatched can no longer move it and will not be bought'))
  assert.ok(p.logs.some(l => l.startsWith('💰 [rust] the batch verifier for m.rs was NOT dispatched — no verifier was spent on it') && l.endsWith('its 1 finding(s) are reported as unverified and excluded from the verification counters')))
  assert.ok(p.logs.includes('[rust] Verify dispatched through a sliding window of ≤24 agents (25 worst-case agents queued) — a deeper queue makes the per-agent deadline fire on waiting rather than on hanging; the window refills as each verifier settles, so nothing waits on a batch\'s slowest member'))
})

test('a queue that fits the window is dispatched without the window note', async () => {
  const p = pool(() => YES)
  await p.verify([F('Critical')], { verifyVotes: 23, lensModel: 'opus' })
  assert.ok(!p.logs.some(l => l.includes('sliding window')), 'exactly 24 worst-case agents fit')
})
