// What counts as a finding, executed. Before this file the splitter had no test at all: it was not
// exported, `tsc` was the only gate, and a splitter that turns prose into forty child sessions —
// or drops a Critical past the fortieth without a word — is perfectly type-clean.
//
// The rule it implements is asymmetric on purpose. A line wrongly TREATED as a finding costs one
// wasted validation; a line wrongly DROPPED costs a finding nobody ever looked at, in a plan that
// presents itself as a complete triage. So the splitter discards only what is structurally furniture
// — code fences, headings, a table's rule — and everything else is either an item or the
// continuation of one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitFindings, runTriageFindings } from './triage-findings.ts'

test('a bullet list is one finding per bullet', () => {
  const { findings, dropped, skipped } = splitFindings('- first thing\n- second thing\n* third thing')
  assert.deepEqual(findings, ['- first thing', '- second thing', '* third thing'])
  assert.equal(dropped, 0)
  assert.equal(skipped, 0)
})

test('a wrapped continuation stays with its finding, indented or not', () => {
  // Indented was the easy half. Markdown wraps at column ZERO, so "indented means continuation" was
  // true of code and false of prose — and an ordinary report then saturated the cap on paragraph
  // fragments while real findings past it were dropped.
  const indented = splitFindings('- Critical: the parser drops bytes\n  see src/parse.rs:88 for the site')
  assert.equal(indented.findings.length, 1, 'an indented continuation belongs to the bullet above')
  assert.match(indented.findings[0], /drops bytes see src\/parse\.rs:88/)

  const wrapped = splitFindings('- Critical: the parser drops bytes\nsee src/parse.rs:88 for the site')
  assert.equal(wrapped.findings.length, 1, 'and so does one wrapped at column zero')
})

test('a paragraph is ONE finding, and a blank line ends it', () => {
  // The measurement that made this necessary: docs/observability.md, 141 lines, produced 40 findings
  // (the cap) and dropped 52 before this rule — forty child sessions spent on half-sentences. With
  // paragraphs coalesced it produces 17 and drops none.
  const { findings } = splitFindings('The parser drops bytes\nwhen the buffer wraps.\n\nThe retry loop\nnever terminates.')
  assert.equal(findings.length, 2, 'two paragraphs, two findings')
  assert.match(findings[0], /drops bytes when the buffer wraps/)
  assert.match(findings[1], /retry loop never terminates/)
})

test('an inline code span is not a fence, and does not swallow the findings after it', () => {
  // A line that opens AND closes backticks on itself is not a block delimiter. Toggling on it made
  // every finding after that line vanish — and silently, because `dropped` stayed 0, so the loud
  // "N were NOT triaged" banner never fired. That was a loss path this file INVENTED: before it,
  // no fence could lose a finding.
  // The discriminating shape, and finding it took a falsifier that did NOT go red: with only an
  // inline span and no real block afterwards, the unterminated-fence recovery hands the swallowed
  // lines back at EOF, so the bug and the fix look identical. They part company when a genuine
  // fenced block closes later — the close then discards what the phantom fence had collected, and
  // the finding between them is gone for good.
  const { findings, dropped } = splitFindings(
    [
      '- Critical: src/a.rs:10 growth',
      '```cargo test``` fails on main',
      '- High: src/b.rs:20 panic',
      '```',
      'some sample output',
      '```',
      '- Medium: src/c.rs:5 unwrap',
    ].join('\n'),
  )
  assert.equal(findings.length, 3, 'all three findings survive the inline span and the real block')
  assert.match(findings[1], /src\/b\.rs:20/, 'the one between them is not eaten by a phantom fence')
  assert.match(findings[2], /src\/c\.rs:5/)
  assert.ok(!findings.some(f => /sample output/.test(f)), 'and the real block is still not a finding')
  assert.equal(dropped, 0)
})

test('an unterminated fence returns what it held rather than eating the rest', () => {
  // A stray ``` used as a divider, or a truncated paste. Swallowing the remainder loses findings on
  // a guess; re-reading it costs some noise, and noise is visible where a missing Critical is not.
  const { findings } = splitFindings('- one\n```\n- two\n- three')
  assert.equal(findings.length, 3, 'nothing is lost to a fence that never closed')
})

test('rules and lone bold headings are furniture, quoted notes are not', () => {
  // A `---` or `***` separator is layout. A `> quoted note` might well BE the finding, and the cost
  // of keeping it is one wasted validation against the cost of dropping a real one.
  const { findings, skipped } = splitFindings('- a\n---\n***\n> quoted note\n**Bold heading**\n- b')
  assert.deepEqual(findings, ['- a', '> quoted note', '- b'])
  assert.equal(skipped, 3, 'the two rules and the bold heading are counted as skipped')
})

test('prose is triaged, not discarded because something else was structured', () => {
  // The trap in the first attempt: one structured line anywhere flipped the whole blob into
  // "structured mode" and every plain sentence was DROPPED. A mixed report is the ordinary case, so
  // that lost real findings in exactly the situation the tool is used for. Nothing is dropped now.
  //
  // What it costs, said plainly rather than papered over: two adjacent prose lines with no blank
  // line between them are INDISTINGUISHABLE from one wrapped paragraph, so they arrive as a single
  // finding. That is a deliberate trade and it is not free — the validator judges both sentences in
  // one job. It is chosen because the opposite error is far worse: splitting wrapped prose produced
  // forty fragment-findings on an ordinary report and dropped everything past the cap. Merging
  // degrades a judgment; splitting loses findings outright.
  const { findings, skipped } = splitFindings(
    'The parser drops trailing bytes.\nThe retry loop never terminates.\n- src/a.rs:10 unbounded growth',
  )
  assert.equal(findings.length, 2, 'the prose block is one finding, the bullet is another')
  assert.match(findings[0], /drops trailing bytes.*never terminates/, 'and neither sentence is lost')
  assert.match(findings[1], /src\/a\.rs:10/)
  assert.equal(skipped, 0)

  // Separated by a blank line, they are two findings — which is how a report that means two says so.
  const separated = splitFindings('The parser drops trailing bytes.\n\nThe retry loop never terminates.')
  assert.equal(separated.findings.length, 2)
})

test('code fences are not findings', () => {
  const { findings, skipped } = splitFindings(
    '- real finding\n```\n1. this is sample output\n2. so is this\n```\n- another real one',
  )
  assert.deepEqual(findings, ['- real finding', '- another real one'])
  assert.equal(skipped, 2, 'and what was skipped is counted, not silently swallowed')
})

test("a table's furniture is not a finding", () => {
  const { findings, skipped } = splitFindings('| finding | severity |\n|---|---|\n| src/a.rs:1 leak | High |')
  assert.equal(findings.length, 2, 'the header row is content; only the rule is furniture')
  assert.ok(!findings.some(f => /^\|[\s|:-]*\|$/.test(f)), 'the |---|---| rule never becomes a finding')
  assert.equal(skipped, 1)
})

test('headings are not findings', () => {
  const { findings } = splitFindings('## Findings\n- the actual one')
  assert.deepEqual(findings, ['- the actual one'])
})

test('the cap is reported, because a dropped finding is one nobody looked at', () => {
  // Exactly at the cap, and one past it. The silent `.slice(0, 40)` was the whole defect: a Critical
  // at line 41 vanished from the plan AND from the run record, and the plan still called itself a
  // triage of the input.
  const at = splitFindings(Array.from({ length: 40 }, (_, i) => `- f${i}`).join('\n'))
  assert.equal(at.findings.length, 40)
  assert.equal(at.dropped, 0, 'exactly at the cap drops nothing')

  const over = splitFindings(Array.from({ length: 41 }, (_, i) => `- f${i}`).join('\n'))
  assert.equal(over.findings.length, 40)
  assert.equal(over.dropped, 1, 'and one past it is counted so the caller can say so')
})

test('an empty blob yields nothing rather than a phantom finding', () => {
  assert.deepEqual(splitFindings('').findings, [])
  assert.deepEqual(splitFindings('\n\n   \n').findings, [])
})

// ---- the wiring, through the real entry point ------------------------------------------------
// The sibling file gained this a commit ago and this one did not, which is why two defects in it —
// a planner predicate satisfied by a refusal, and a record that could not say the plan never came —
// were invisible to a suite that covered the splitter thoroughly.

function fakeCtx(answerFor) {
  return {
    directory: '/repo',
    worktree: '/repo',
    $: () => ({ quiet: async () => ({ stdout: '' }) }),
    client: {
      session: {
        create: async () => ({ id: 's' }),
        prompt: async ({ body }) => {
          const text = body?.parts?.[0]?.text ?? ''
          const isPlan = /ordered fix plan/i.test(text)
          return { parts: [{ type: 'text', text: answerFor({ isPlan }) }] }
        },
      },
    },
  }
}

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'craft-triage-'))
  const prev = process.env.CRAFT_RUNS_DIR
  process.env.CRAFT_RUNS_DIR = dir
  return Promise.resolve(fn(dir)).finally(() => {
    if (prev === undefined) delete process.env.CRAFT_RUNS_DIR
    else process.env.CRAFT_RUNS_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  })
}

const record = dir => JSON.parse(readFileSync(join(dir, readdirSync(dir).find(f => f.endsWith('.json'))), 'utf8'))

test('a planner that refuses does not produce a plan, on screen or in the store', async () => {
  // The first predicate accepted "I cannot build the triage ledger from these results", because
  // "triage ledger" is a phrase the PROMPT supplies in bold. A keyword the prompt hands the model
  // tests nothing; the terminal marker tests whether it got to the end.
  await withStore(async dir => {
    const ctx = fakeCtx(({ isPlan }) =>
      isPlan ? 'I cannot build the triage ledger from these results.' : 'checked\n\nOUTCOME: accept')
    const out = await runTriageFindings(ctx, { locator: '- Critical: src/a.rs:10 growth' })
    assert.match(out, /INCOMPLETE \(not run\) — the fix plan was not produced/)
    assert.equal(record(dir).planned, false, 'and the store says so too')
  })
})

test('a real plan is used, and the store agrees', async () => {
  await withStore(async dir => {
    const ctx = fakeCtx(({ isPlan }) =>
      isPlan ? '## Triage ledger\n\n1. fix a\n\nPLAN: READY' : 'checked\n\nOUTCOME: accept')
    const out = await runTriageFindings(ctx, { locator: '- Critical: src/a.rs:10 growth' })
    assert.match(out, /Triage ledger/)
    assert.ok(!/was not produced/.test(out))
    assert.equal(record(dir).planned, true)
  })
})

test('findings past the cap are named on screen AND in the store', async () => {
  await withStore(async dir => {
    const ctx = fakeCtx(({ isPlan }) => (isPlan ? 'plan\n\nPLAN: READY' : 'checked\n\nOUTCOME: accept'))
    const many = Array.from({ length: 45 }, (_, i) => `- f${i}: src/a.rs:${i} thing`).join('\n')
    const out = await runTriageFindings(ctx, { locator: many })
    assert.match(out, /5 finding\(s\) past the first 40 were NOT triaged/, 'the reader is told first')
    assert.equal(record(dir).untriaged, 5, 'and the store carries the same number')
  })
})

test('a validation answering in the wrong case is still an answer', async () => {
  // `OUTCOME: Accept` is correct and capitalised. Judged strictly it was re-run at full cost and
  // then filed not-run — the inversion the shared predicate exists to prevent, and there is no
  // second reader here whose strictness would justify it.
  await withStore(async dir => {
    const ctx = fakeCtx(({ isPlan }) => (isPlan ? 'plan\n\nPLAN: READY' : 'looks right\n\nOUTCOME: Accept'))
    await runTriageFindings(ctx, { locator: '- Critical: src/a.rs:10 growth' })
    assert.deepEqual(record(dir).notRun, [], 'nothing is filed as not-run')
  })
})
