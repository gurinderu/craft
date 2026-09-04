// The first executable tests of the OpenCode delivery's dispatcher.
//
// Nothing here needed inventing to make it testable: Node strips TypeScript types on import, so
// `orchestrator.ts` loads directly. The reason it went untested for its whole life is that nobody
// tried — `tsc --noEmit` was the only gate, and a type-clean dispatcher can still call a dead
// session alive. That is not a hypothetical: `ok: text.length > 0` meant a refusal, a permission
// error, or "I'll start by looking at the repo" counted as a result, and that text then reached the
// verdict parser, which falls through to APPROVE. A dimension whose child session errored out
// reported Approve — the one outcome this engine exists to make impossible.
//
// `fanOut` reaches the outside world through exactly one seam: `ctx.client.session`. A fake client
// drives the whole dispatcher, which is the same shape the Claude Code engines are tested with.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fanOut, runAnswering } from './orchestrator.ts'
// The PRODUCTION predicate, imported rather than re-spelled. A local copy is what let the gate and
// the parser drift apart in the first place: the copy rejected a bolded `**VERDICT: BLOCK**` that
// the parser accepts, so a real Block was re-run and then filed as INCOMPLETE — which ranks BELOW
// Block, so the Block vanished from the top-level verdict.
import { hasVerdictLine } from './run-record.mjs'

// Answers keyed by agent name; a function may answer differently per attempt, which is how the
// sequential retry is exercised.
function fakeCtx(answers, calls = []) {
  return {
    calls,
    client: {
      session: {
        create: async ({ body }) => ({ id: `s-${calls.length}`, title: body?.title }),
        prompt: async ({ body }) => {
          const agent = body?.agent ?? ''
          calls.push(agent)
          const nth = calls.filter(a => a === agent).length - 1
          const answer = typeof answers[agent] === 'function' ? await answers[agent](nth) : answers[agent]
          if (answer instanceof Error) throw answer
          return { parts: [{ type: 'text', text: String(answer ?? '') }] }
        },
      },
    },
  }
}

const job = (over = {}) => ({ label: 'security', agent: 'rust-security-scanner', prompt: 'p', answered: hasVerdictLine, ...over })

test('output without the answer the job asked for is NOT a result', async () => {
  // The defect, in its own words: a session that says something but answers nothing used to be
  // `ok: true`. The text is kept — a refusal is the most useful thing to show a reader about why —
  // but it must never be reported as a dimension that ran.
  const ctx = fakeCtx({ 'rust-security-scanner': 'I cannot run that command without permission.' })
  const [r] = await fanOut(ctx, [job()])
  assert.equal(r.ok, false, 'a refusal is not a verdict')
  assert.match(r.text, /INCOMPLETE \(not run\)/, 'and it is reported as not run')
  assert.match(r.text, /without the machine-readable line/, 'naming why, not blaming an unrelated bug')
  assert.match(r.text, /I cannot run that command/, 'while keeping what the session actually said')
})

test('an answer carrying the verdict line is a result', async () => {
  const ctx = fakeCtx({ 'rust-security-scanner': 'cargo-audit found nothing.\n\nVERDICT: APPROVE' })
  const [r] = await fanOut(ctx, [job()])
  assert.equal(r.ok, true)
  assert.match(r.text, /VERDICT: APPROVE/)
  assert.ok(!/INCOMPLETE/.test(r.text), 'a real answer is not decorated with a not-run note')
})

test('a job with no expectation keeps the old non-empty rule', async () => {
  // Deliberate: jobs whose output is prose by design have no marker to demand, and inventing one
  // for them would be a false discriminator.
  const ctx = fakeCtx({ writer: 'some prose' })
  const [r] = await fanOut(ctx, [{ label: 'w', agent: 'writer', prompt: 'p' }])
  assert.equal(r.ok, true)
})

test('the sequential retry is what rescues a first-pass failure', async () => {
  // The #8528/#6573 mitigation. Answer nothing the first time, properly the second.
  const calls = []
  const ctx = fakeCtx({ 'rust-security-scanner': n => (n === 0 ? '' : 'ok\n\nVERDICT: WARNING') }, calls)
  const [r] = await fanOut(ctx, [job()])
  assert.equal(r.ok, true, 'the retry result is the one that counts')
  assert.match(r.text, /VERDICT: WARNING/)
  assert.equal(calls.length, 2, 'and it took exactly one retry')
})

test('a job that times out says so, and does not blame an opencode bug', async () => {
  // The 90-second ceiling fired on essentially every real Rust workspace, because the agents are
  // told to run clippy and the test suite — and the message then sent the reader looking for a
  // version problem. A deadline must report itself as a deadline.
  const ctx = fakeCtx({ slow: () => new Promise(() => {}) })
  const [r] = await fanOut(ctx, [{ label: 'review', agent: 'slow', prompt: 'p', answered: hasVerdictLine, timeoutMs: 20 }])
  assert.equal(r.ok, false)
  assert.match(r.text, /no result within/, 'the cause named is the deadline')
  assert.match(r.text, /may simply need longer/, 'and the reader is pointed at the real remedy')
  assert.ok(!/#8528/.test(r.text), 'not at an unrelated upstream bug')
})

test('a session that throws is reported as an error, not as silence', async () => {
  const ctx = fakeCtx({ 'rust-security-scanner': new Error('permission denied') })
  const [r] = await fanOut(ctx, [job()])
  assert.equal(r.ok, false)
  assert.match(r.text, /errored/)
  assert.match(r.text, /permission denied/, 'the actual error survives to the reader')
})

test('one dead dimension does not take the live ones down with it', async () => {
  const ctx = fakeCtx({
    good: 'fine\n\nVERDICT: APPROVE',
    bad: '',
  })
  const rs = await fanOut(ctx, [
    { label: 'a', agent: 'good', prompt: 'p', answered: hasVerdictLine },
    { label: 'b', agent: 'bad', prompt: 'p', answered: hasVerdictLine },
  ])
  assert.deepEqual(rs.map(r => r.ok), [true, false])
  assert.match(rs[1].text, /INCOMPLETE \(not run\)/)
})

test('a verdict a model would ordinarily write — decorated — still counts as an answer', async () => {
  // The gate and the parser must agree about what an answer looks like, and the parser tolerates
  // markdown decoration on purpose. A stricter gate does not fail safe: it re-runs a dimension that
  // DID answer, and on the second bolded verdict files it as INCOMPLETE — which worstOf ranks below
  // Block, so a real Block disappears from the top-level verdict.
  for (const line of ['**VERDICT: BLOCK**', '> VERDICT: BLOCK', '`VERDICT: BLOCK`', '- VERDICT: BLOCK', '| VERDICT: BLOCK |']) {
    const ctx = fakeCtx({ 'rust-security-scanner': `findings above\n\n${line}` })
    const [r] = await fanOut(ctx, [job()])
    assert.equal(r.ok, true, `decorated verdict must be accepted: ${line}`)
  }
})

test('lowercase prose is NOT an answer, because the parser does not treat it as one', async () => {
  // `Verdict: Approve` in ordinary case is explicitly non-authoritative for the parser — it exists to
  // be weighed against evidence, not to decide. A gate that accepted it would admit exactly the
  // shape the parser refuses to trust.
  const ctx = fakeCtx({ 'rust-security-scanner': 'looks fine to me.\n\nVerdict: Approve' })
  const [r] = await fanOut(ctx, [job()])
  assert.equal(r.ok, false)
  assert.match(r.text, /INCOMPLETE \(not run\)/)
})

test('a settled race leaves no timer behind', async () => {
  // The regression this catches presents as a CI job that STALLS for the whole deadline, not as a
  // named failure — so it is asserted directly rather than left to be noticed by a hang. Node keeps
  // a pending setTimeout in its handle list; a job that answered immediately must leave none.
  const before = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length
  const ctx = fakeCtx({ 'rust-security-scanner': 'done\n\nVERDICT: APPROVE' })
  await fanOut(ctx, [job({ timeoutMs: 60_000 })])
  const after = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length
  assert.equal(after, before, 'the deadline timer must be cleared when the job settles first')
})

test('a single call is held to the same standard as a fan-out job', async () => {
  // The consolidation step bypassed all of this — no predicate, no deadline — so the audit's most
  // authoritative text was the one path exempt from the rule the rest of this file is about. A
  // refusal from that session was non-empty, so it became the report AND was filed as a verdict.
  const refusing = fakeCtx({ '': 'I am not able to consolidate this audit because the results are unclear.' })
  const bad = await runAnswering(refusing, '', 'p', hasVerdictLine)
  assert.equal(bad.ok, false, 'prose without the mandated line is not a consolidation')

  const answering = fakeCtx({ '': 'the report\n\nVERDICT: WARNING' })
  const good = await runAnswering(answering, '', 'p', hasVerdictLine)
  assert.equal(good.ok, true)
  assert.match(good.text, /VERDICT: WARNING/)
})

test('a single call carries a deadline, so a hung session cannot hang the run', async () => {
  const ctx = fakeCtx({ '': () => new Promise(() => {}) })
  const r = await runAnswering(ctx, '', 'p', hasVerdictLine, 20)
  assert.equal(r.ok, false, 'it must give up rather than wait forever')
})

test('the sequential retries share one budget instead of multiplying the deadline', async () => {
  // Raising the per-job deadline made the retry arithmetic unlivable: ten dimensions retried one
  // after another is hours with nothing on screen. Whoever is left when the budget runs out is
  // reported not-run WITHOUT being attempted, which is the truthful thing to say about them.
  const calls = []
  const ctx = fakeCtx({ slow: () => new Promise(() => {}) }, calls)
  const jobs = Array.from({ length: 3 }, (_, i) => ({
    label: `d${i}`, agent: 'slow', prompt: 'p', answered: hasVerdictLine, timeoutMs: 40,
  }))
  const rs = await fanOut(ctx, jobs)
  assert.deepEqual(rs.map(r => r.ok), [false, false, false])
  assert.equal(calls.length, 6, 'three concurrent attempts and three retries, none skipped at this budget')
  for (const r of rs) assert.match(r.text, /INCOMPLETE \(not run\)/)
})

test('a retry clipped by the budget is described by the deadline it actually ran under', async () => {
  // It used to read the UNCLIPPED deadline, so a job given ninety seconds was told the reader "no
  // result within 20 minutes … it may simply need longer" — a false span pointing at a deadline
  // that never fired.
  const ctx = fakeCtx({ slow: () => new Promise(() => {}) })
  const [r] = await fanOut(ctx, [{ label: 'd', agent: 'slow', prompt: 'p', answered: hasVerdictLine, timeoutMs: 30 }])
  assert.match(r.text, /no result within 30 ms/, 'the span named is the one that applied')
  assert.ok(!/minutes/.test(r.text), 'and not a deadline that never ran')
})

test('the note names the line THIS job required, not a line from another engine', async () => {
  // Hard-coded, it sent the forty triage jobs looking for a `VERDICT:` line their prompt never
  // mentions — the same wrong-cause reporting this file fixed for timeout-versus-silence.
  const ctx = fakeCtx({ validator: 'I cannot judge this one.' })
  const [r] = await fanOut(ctx, [{
    label: 'f1', agent: 'validator', prompt: 'p', answered: () => false, requires: 'OUTCOME: line',
  }])
  assert.match(r.text, /without the OUTCOME: line the prompt requires/)
  assert.ok(!/verdict/i.test(r.text), 'and never names a line the job did not ask for')
})

test('a retry is clipped to what is left of the shared budget', async () => {
  // The previous version of this test could not reach the clipping branch: with thirty minutes
  // remaining, Math.min(job.timeoutMs, left) is always the job's own value, so the assertion held
  // whether or not the clipping existed. The budget is injectable now, so the case is constructible.
  const ctx = fakeCtx({ slow: () => new Promise(() => {}) })
  const jobs = [
    { label: 'a', agent: 'slow', prompt: 'p', answered: () => false, timeoutMs: 30 },
    // Large enough that the shared budget must clip it, small enough that pass 1 — which runs it in
    // full — does not cost a minute. A test that spends the suite's whole runtime proving a
    // millisecond of arithmetic buys nothing the same branch cannot show in 300ms.
    { label: 'b', agent: 'slow', prompt: 'p', answered: () => false, timeoutMs: 300 },
  ]
  const rs = await fanOut(ctx, jobs, 80) // 80ms of retry budget for both
  assert.match(rs[1].text, /no result within/, 'the second retry ran under a clipped deadline')
  assert.ok(!/300 ms/.test(rs[1].text), 'and is not described by the deadline it never got')
})

test('a job left over when the budget is spent is not attempted, and says so', async () => {
  const ctx = fakeCtx({ slow: () => new Promise(() => {}) })
  const jobs = Array.from({ length: 3 }, (_, i) => ({
    label: `d${i}`, agent: 'slow', prompt: 'p', answered: () => false, timeoutMs: 50,
  }))
  const rs = await fanOut(ctx, jobs, 60)
  const skipped = rs.filter(r => /retry budget for this run was already spent/.test(r.text))
  assert.ok(skipped.length >= 1, 'at least one job is honestly reported as never retried')
})
