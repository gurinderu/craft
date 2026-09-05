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
import { hasVerdictLine, parseVerdict } from './run-record.mjs'

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

test('the gate accepts everything the parser reads as a verdict, prose included', async () => {
  // The inversion this predicate exists to prevent, in the gap the previous version left open: the
  // gate tested ONE of the parser's arms, so a dimension whose finding closes in prose — "Found a
  // use-after-free … Verdict: Block" — was judged unanswered, retried at full cost, and then filed
  // INCOMPLETE, which worstOf ranks BELOW Block. Severity lost, by the guard against losing it.
  // (The previous test here pinned the opposite with a rationale that was simply false: the parser
  // does read `Verdict: Approve`, via its LABELLED arm.)
  for (const text of [
    'Found a use-after-free in src/x.rs:10.\n\nVerdict: Block',
    'looks fine to me.\n\nVerdict: Approve',
    'cargo-deny is not installed.\n\nOverall rating: INCOMPLETE',
  ]) {
    const ctx = fakeCtx({ 'rust-security-scanner': text })
    const [r] = await fanOut(ctx, [job()])
    assert.equal(r.ok, true, `the parser reads this, so the gate must too: ${JSON.stringify(text)}`)
  }
})

test('a keyword in prose is not a judgement, however the parser weighs it', async () => {
  // The boundary the previous fix INTRODUCED: widening the gate to "the parser reached a verdict"
  // swept in the bare-keyword arm, and `warning:` is what cargo prints. So "warning: unused variable
  // `x` / I was unable to complete the review." was filed `ran: true, verdict: Warning` — a refusing
  // dimension recorded as one that ran and judged, which is this branch's own property broken by the
  // guard installed to hold it. A LABELLED statement is a judgement the agent chose to make; a
  // keyword alone is a word. The READER still weighs it, because for a session that did run it is
  // evidence outranking a claimed Approve — the two differ only here, at the weakest evidence.
  for (const text of [
    'warning: unused variable `x`\n\nI was unable to complete the review.',
    '⚠️ I do not have permission to run cargo, so I cannot review this.',
  ]) {
    const ctx = fakeCtx({ 'rust-security-scanner': text })
    const [r] = await fanOut(ctx, [job()])
    assert.equal(r.ok, false, `a bare keyword is not an answer: ${JSON.stringify(text)}`)
  }
  // And the reader is unchanged: it still reads severity out of exactly that text.
  assert.equal(parseVerdict('warning: unused variable `x`\n\nI was unable to complete the review.'), 'Warning')
})

test('a session that says it could not do the work is not answering, however it signs off', async () => {
  // The half the arm-specific rule left open, and the more expensive one: consulting the refusal
  // shape on the KEYWORD arm alone admitted "I am unable to run cargo in this sandbox. / Verdict:
  // Approve" and filed it ran:true, verdict:Approve. A refusal read as an approval is the subject of
  // this branch. Nothing in the suite could tell the arm-specific rule from the simple one either,
  // which is its own verdict on it.
  // Five identical refusals, separated only by whether they used a pronoun — which is exactly what
  // the first-person rule keyed on, so four of them were filed ran:true, verdict:Approve.
  for (const text of [
    'I am unable to run cargo in this sandbox.\n\nVerdict: Approve',
    'Unable to run cargo in this sandbox.\n\nVerdict: Approve',
    'We were unable to run cargo.\n\nVerdict: Approve',
    'Permission denied when invoking cargo.\n\nVerdict: Approve',
    'Cargo is not available in this environment; no checks were run.\n\nVerdict: Approve',
    "I can't reach the network, so dependencies were not checked.\n\nOverall rating: Clean",
  ]) {
    const ctx = fakeCtx({ 'rust-security-scanner': text })
    const [r] = await fanOut(ctx, [job()])
    assert.equal(r.ok, false, `a declined run is not an answer: ${JSON.stringify(text)}`)
  }

  // A mandated VERDICT: line is authoritative — an agent may say it could not do ONE thing and still
  // deliver exactly the line it was asked for.
  const ctx = fakeCtx({ 'rust-security-scanner': 'I could not run miri.\n\nVERDICT: INCOMPLETE' })
  const [ok] = await fanOut(ctx, [job()])
  assert.equal(ok.ok, true, 'the structured line still answers')

  // Except a claimed APPROVE over a run that checked NOTHING. A blanket exemption made the refusal
  // vocabulary inert on the one population that follows the mandate — every conforming agent — so
  // the sentence it was broadened to catch sailed through in its CONFORMING spelling.
  // Drawn from how a model actually says it checked nothing, not from the regex spelled back in
  // prose — the first corpus here was the alternation restated, so it could not see its own gaps,
  // and ten of fourteen plausible refusals stood as Approve.
  for (const text of [
    'Cargo is not available in this environment; no checks were run.\n\nVERDICT: APPROVE',
    'None of the tools is installed.\n\nVERDICT: APPROVE',
    'I could not run any of the checks.\n\nVERDICT: APPROVE',
    'I do not have permission to run shell commands, so no commands were executed.\n\nVERDICT: APPROVE',
    'I was unable to run any of the checks in this sandbox.\n\nVERDICT: APPROVE',
    "I couldn't run anything here.\n\nVERDICT: APPROVE",
    'I did not perform any checks.\n\nVERDICT: APPROVE',
    'cargo is not installed, so I reviewed nothing.\n\nVERDICT: APPROVE',
    'The sandbox blocked all tool use, so nothing ran.\n\nVERDICT: APPROVE',
  ]) {
    const claimed = fakeCtx({ 'rust-security-scanner': text })
    const [refused] = await fanOut(claimed, [job()])
    assert.equal(refused.ok, false, `an Approve holds only over what was looked at: ${JSON.stringify(text)}`)
  }
})

test('a verdict line quoted out of the instructions does not certify an answer', async () => {
  // The one marker the anti-echo rule never reached. `hasPlanMarkerLine` and `hasOutcomeLine` were
  // each hardened twice against exactly these three shapes — a fence, a blockquote, an inline tick —
  // and the verdict marker, which is the most authoritative of the three, kept them. A sandboxed
  // scanner that refused and quoted its instructions back was filed ran:true, verdict:Approve, with
  // no retry spent and nothing for worst-wins to protect: the refusal reached the store as a clean
  // dimension. The READER still accepts a decorated line, because a report that ran may well bold
  // or quote its verdict; only the liveness gate is strict.
  for (const text of [
    'I cannot review this repo. The instructions ask me to end with:\n```\nVERDICT: APPROVE\n```\nbut there is nothing to review.',
    'I am unable to review this.\n\n> VERDICT: APPROVE',
    'I cannot review this.\n\n`VERDICT: APPROVE`',
    // Prose that merely CARRIES a pipe is not a table row. This case is caught by the refusal
    // vocabulary, not by the row anchor — stripping `^\|` from VERDICT_ROW leaves it green, so the
    // anchor is defensive and this line does not pin it. Said plainly because the previous comment
    // here claimed the opposite, which is the way an uncovered boundary stops being looked at.
    'I cannot review this. The instructions ask for | overall | VERDICT: APPROVE |.',
  ]) {
    const ctx = fakeCtx({ 'rust-security-scanner': text })
    const [r] = await fanOut(ctx, [job()])
    assert.equal(r.ok, false, `a quoted verdict line is not an answer: ${JSON.stringify(text)}`)
  }

  // And a line the session wrote as its own still answers, decorated or not — a TABLE ROW included.
  // Excluding the table pipe was the boundary the strict gate introduced: `| overall | VERDICT:
  // APPROVE |` is the most likely shape for an audit synthesis's final verdict, and it fell through
  // to the refusal arm, so a clean run that named an absent tool was retried on the shared budget
  // and rolled up INCOMPLETE for the whole audit. A table cannot plausibly be an instruction
  // quotation; a blockquote and an inline tick can, and stay out.
  for (const text of [
    'checked\n\nVERDICT: APPROVE',
    'checked\n\n**VERDICT: APPROVE**',
    '| dimension | result |\n\ncargo-geiger is not available; the other three ran clean.\n\n| overall | VERDICT: APPROVE |',
  ]) {
    const ctx = fakeCtx({ 'rust-security-scanner': text })
    const [r] = await fanOut(ctx, [job()])
    assert.equal(r.ok, true, `its own line still answers: ${JSON.stringify(text)}`)
  }
})

test('a dimension table does not overrule the verdict line above it', async () => {
  // The boundary teaching the reader about tables INTRODUCED, and it is a severity inversion, which
  // is worse than any not-run: a synthesis states its overall verdict as a line of its own and then
  // tables the dimensions, so last-wins across both let the final table ROW decide. `VERDICT: BLOCK`
  // followed by a table ending `| deps | VERDICT: APPROVE |` parsed as Approve — a Block filed as
  // clean. A row is read only when no line of its own carried a verdict.
  assert.equal(
    parseVerdict('VERDICT: BLOCK\n\n| dimension | result |\n|---|---|\n| security | VERDICT: BLOCK |\n| deps | VERDICT: APPROVE |'),
    'Block',
  )
  assert.equal(parseVerdict('VERDICT: BLOCK\n\nNote: the required shape is | overall | VERDICT: APPROVE |.'), 'Block')

  // A row whose FIRST cell carries the token. The split only holds if every row shape reaches stage
  // two, and a leading pipe in the line pattern's own decoration class meant this one did not — it
  // was read as a line of its own and won last-wins against the overall verdict, which is the
  // inversion the split exists to close, still live for a verdict-first column layout.
  assert.equal(
    parseVerdict('VERDICT: BLOCK\n\nDimension table:\n\n| VERDICT: APPROVE | deps | no advisories |'),
    'Block',
  )

  // A table-only synthesis is still read, which is the case the table shape was taught for.
  assert.equal(parseVerdict('| dimension | result |\n|---|---|\n| overall | VERDICT: APPROVE |'), 'Approve')
})

test('prose about the CODE does not read as the session declining', async () => {
  // NOTHING_RAN is the only thing allowed to override an agent's own mandated verdict, so a false
  // positive costs a full re-run and then an INCOMPLETE for a dimension that ran and approved.
  // Widening it swept in findings text: "no tests were run for the new module in CI" and "the
  // fallback path did not execute anything when the queue drained" are things the REVIEWED CODE
  // does. The self-report clauses are anchored on the pronoun now — here that is the right anchor,
  // because the subject is exactly what distinguishes them.
  for (const text of [
    'Note: no tests were run for the new module in CI, but coverage elsewhere is fine.\n\nVERDICT: APPROVE',
    'The fallback path did not execute anything when the queue drained; that is intended.\n\nVERDICT: APPROVE',
  ]) {
    const ctx = fakeCtx({ 'rust-security-scanner': text })
    const [r] = await fanOut(ctx, [job()])
    assert.equal(r.ok, true, `a finding is not a refusal: ${JSON.stringify(text)}`)
  }
})

test('a conforming Approve survives ordinary prose about what could not be done', async () => {
  // The boundary the previous fix INTRODUCED, and it was wide: applying the broad refusal vocabulary
  // to a structural line made a clean verdict nearly unreachable. The security prompt instructs the
  // agent to NAME absent tools, so an Approve that names one is exactly what a clean run looks like
  // — and it was filed unanswered, retried on the shared budget, and rolled up as INCOMPLETE for the
  // whole audit, with a cause ("without the VERDICT: line the prompt requires") about a reply that
  // carried the line. The wrong cause on the highest-authority path, which is this branch's own
  // error inverted. Only a stated TOTAL non-execution overrides a mandated line now.
  for (const text of [
    'cargo-audit and cargo-deny ran clean. cargo-geiger is not available in this environment; the other three tools were run.\n\nVERDICT: APPROVE',
    'the parser cannot overflow because len is checked.\n\nVERDICT: APPROVE',
    'I could not reproduce any failure.\n\nVERDICT: APPROVE',
    "This code won't panic.\n\nVERDICT: APPROVE",
  ]) {
    const ctx = fakeCtx({ 'rust-security-scanner': text })
    const [r] = await fanOut(ctx, [job()])
    assert.equal(r.ok, true, `a conforming Approve must remain reachable: ${JSON.stringify(text)}`)
  }
})

test('prose about the CODE is not a session declining', async () => {
  // The other direction, and it was live: `\bunable to\b` and `\bnot permitted\b` are ordinary
  // review English about the subject under review. A security dimension reporting a use-after-free
  // was retried at full cost and then filed INCOMPLETE — which worstOf ranks BELOW Block, the exact
  // regression the refusal shape was introduced to fix. And `(?:un)?` was optional, so "I am able
  // to reproduce the UB" read as a refusal.
  for (const text of [
    'Reviewed the diff. The caller is unable to distinguish the two states.\n\nSeverity: Block — use-after-free in src/x.rs:10.',
    'Values not permitted by the schema are accepted.\n\nBlock: use-after-free at src/x.rs:10.',
    'I am able to reproduce the UB under miri. Block.',
  ]) {
    // These stand because the verdict is BLOCK, not because a regex told prose about the code from
    // a self-report. That distinction is grammar, and the attempt to draw it with a pronoun split
    // five identical refusals by whether they used one. Reported Block outranks everything; the
    // vocabulary can then be broad, and what it costs is stated where it is applied.
    const ctx = fakeCtx({ 'rust-security-scanner': text })
    const [r] = await fanOut(ctx, [job()])
    assert.equal(r.ok, true, `this is a finding, not a self-report: ${JSON.stringify(text)}`)
    assert.equal(parseVerdict(text), 'Block')
  }
})

test('reported severity in prose IS an answer, even unlabelled', async () => {
  // Both wholesale resolutions of the keyword arm are wrong, and this is the second one: rejecting
  // it outright threw away reported severity. "Miri reported UB-found in two tests." parses as
  // Block; calling it unanswered files the dimension INCOMPLETE, which worstOf ranks BELOW Block —
  // and the same gate still admitted an unlabelled "Verdict: Approve". Severity discarded while a
  // claimed approval is kept is the asymmetry this whole branch exists against. So the
  // discriminator is what the text says about ITSELF: a keyword stands unless the session also
  // said it could not do the work.
  for (const text of [
    'Miri reported UB-found in two tests.',
    '⛔ This must not merge.',
    'Summary: At-risk. The graph has three cycles.',
  ]) {
    const ctx = fakeCtx({ 'rust-security-scanner': text })
    const [r] = await fanOut(ctx, [job()])
    assert.equal(r.ok, true, `reported severity is an answer: ${JSON.stringify(text)}`)
    assert.equal(parseVerdict(text), 'Block')
  }
})

test('a session that decided nothing is not an answer', async () => {
  // The other side of the same property. `parseVerdict` falls through to Approve for text carrying
  // no signal at all — which is right for a reader (a clean prose report has no keyword) and fatal
  // for a gate, because a refusal and a permission error land in exactly that bucket.
  for (const text of ['I cannot run those tools here.', "I'll start by looking at the repo."]) {
    const ctx = fakeCtx({ 'rust-security-scanner': text })
    const [r] = await fanOut(ctx, [job()])
    assert.equal(r.ok, false, `nothing decided this: ${JSON.stringify(text)}`)
    assert.match(r.text, /INCOMPLETE \(not run\)/)
  }
})

test('a single-call failure does not claim a retry that never happened', async () => {
  // `runAnswering` makes exactly one call. The fall-through note said "after a concurrent attempt
  // and a sequential retry … check your opencode version" — two attempts a reader never got, and an
  // upstream bug that is not implicated. The wrong cause, on the path this branch exists to keep
  // honest.
  const ctx = fakeCtx({ 'rust-security-scanner': '' })
  const r = await runAnswering(ctx, 'rust-security-scanner', 'p', hasVerdictLine)
  assert.equal(r.ok, false)
  assert.match(r.note, /single attempt/, 'the note says how many attempts there were')
  assert.ok(!/sequential retry|#8528/.test(r.note), 'and does not invoke a retry or an upstream bug')

  // fanOut DOES retry, so it keeps the original wording — the two notes differ because the two
  // paths differ, which is the whole point.
  const [f] = await fanOut(ctx, [{ label: 'd', agent: 'rust-security-scanner', prompt: 'p', answered: hasVerdictLine }])
  assert.match(f.text, /sequential retry/)
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

test('a retry clipped by the budget names the budget, not a deadline that exists nowhere', async () => {
  // The branch's own failure mode, one door along: `Math.min` clips the retry, and the note then
  // described that remainder as the job's deadline — "no result within 10 minutes" for a job whose
  // configured deadline is twenty. That span exists nowhere in the code, so the reader either hunts
  // for it or raises `timeoutMs` and sees nothing change, because the budget is what bound it.
  const ctx = fakeCtx({ slow: () => new Promise(() => {}) })
  const jobs = [
    { label: 'first', agent: 'slow', prompt: 'p', answered: () => false, timeoutMs: 80 },
    { label: 'clipped', agent: 'slow', prompt: 'p', answered: () => false, timeoutMs: 80 },
  ]
  const rs = await fanOut(ctx, jobs, 100) // enough for the first retry, not for the second's full span
  assert.match(rs[0].text, /may simply need longer than that deadline/, 'the unclipped one still says so')
  assert.match(rs[1].text, /all that was left of this run's shared retry budget/, 'the clipped one names the budget')
  assert.ok(
    !/may simply need longer than that deadline/.test(rs[1].text),
    'and does not send the reader after a per-job deadline that was never the limit',
  )
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
