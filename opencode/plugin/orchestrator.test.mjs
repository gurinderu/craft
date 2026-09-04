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
import { fanOut } from './orchestrator.ts'

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

const VERDICT = /^\s*VERDICT:\s*(APPROVE|WARNING|BLOCK|INCOMPLETE)\b/mi
const job = (over = {}) => ({ label: 'security', agent: 'rust-security-scanner', prompt: 'p', expect: VERDICT, ...over })

test('output without the answer the job asked for is NOT a result', async () => {
  // The defect, in its own words: a session that says something but answers nothing used to be
  // `ok: true`. The text is kept — a refusal is the most useful thing to show a reader about why —
  // but it must never be reported as a dimension that ran.
  const ctx = fakeCtx({ 'rust-security-scanner': 'I cannot run that command without permission.' })
  const [r] = await fanOut(ctx, [job()])
  assert.equal(r.ok, false, 'a refusal is not a verdict')
  assert.match(r.text, /INCOMPLETE \(not run\)/, 'and it is reported as not run')
  assert.match(r.text, /without the machine-readable verdict line/, 'naming why, not blaming an unrelated bug')
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
  const [r] = await fanOut(ctx, [{ label: 'review', agent: 'slow', prompt: 'p', expect: VERDICT, timeoutMs: 20 }])
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
    { label: 'a', agent: 'good', prompt: 'p', expect: VERDICT },
    { label: 'b', agent: 'bad', prompt: 'p', expect: VERDICT },
  ])
  assert.deepEqual(rs.map(r => r.ok), [true, false])
  assert.match(rs[1].text, /INCOMPLETE \(not run\)/)
})
