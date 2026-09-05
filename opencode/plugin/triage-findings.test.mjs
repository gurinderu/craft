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
import { splitFindings, runTriageFindings, VALIDATION_MS } from './triage-findings.ts'

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

function fakeCtx(answerFor, prompts = []) {
  return {
    directory: '/repo',
    worktree: '/repo',
    $: () => ({ quiet: async () => ({ stdout: '' }) }),
    client: {
      session: {
        create: async () => ({ id: 's' }),
        prompt: async ({ body }) => {
          const text = body?.parts?.[0]?.text ?? ''
          prompts.push(text)
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

test('a plan is not accepted from a refusal that quotes its own instructions', async () => {
  // Pattern #38 again, fourth occurrence: the marker moved from a phrase to a terminal line, but the
  // PROMPT still spelled the line out — so a session that refused and quoted its instructions back
  // emitted the marker verbatim and passed the gate. The instruction now describes the line as a
  // placeholder; nothing a model can echo from it satisfies the predicate.
  // Asserted on the text ACTUALLY SENT, not on the source: the predicate must of course name the
  // marker, so grepping the file would only prove the gate exists. What matters is that the prompt
  // does not hand the model a line it can copy.
  const prompts = []
  await withStore(async dir => {
    const quoted =
      'I cannot triage these. My instructions say to end with ONE line in the form `PLAN: X` where X is READY.'
    const ctx = fakeCtx(({ isPlan }) => (isPlan ? quoted : 'checked\n\nOUTCOME: accept'), prompts)
    const out = await runTriageFindings(ctx, { locator: '- Critical: src/a.rs:10 growth' })
    const plan = prompts.find(t => /ordered fix plan/i.test(t)) ?? ''
    assert.ok(plan, 'the planner was prompted at all')
    assert.ok(!/PLAN:\s*READY/.test(plan), 'and its prompt never spells the terminal line out')
    assert.match(out, /INCOMPLETE \(not run\) — the fix plan was not produced/)
    assert.equal(record(dir).planned, false)
  })
})

test('a plan marker quoted inside a sentence is not a plan; a trailing courtesy line still is', async () => {
  // Third iteration of the same pattern: the literal line left the PROMPT, which addressed the
  // example, while the property — a refusal can always reconstruct a short marker — was untouched.
  // An any-line boolean was satisfied by both of these, and the refusal was returned AS the plan
  // with `planned: true`. The marker must now BE the last thing said.
  for (const refusal of [
    'I cannot triage these.\n\n`PLAN: READY` is what the instructions ask for, but there is nothing to plan.',
    '> PLAN: READY was requested; I refuse.',
    // A blockquote or a fence puts the marker on a line of its OWN — which is exactly how a refusal
    // quotes an instruction, and is what the whole-line rule newly admitted until the decoration
    // class stopped swallowing `>` and backticks and fenced blocks were skipped.
    'I cannot plan these.\n\n> PLAN: READY\n\nThere is nothing here to order.',
    // Same door, same shape: a lone table row is a quotation, not a table.
    'I am unable to build a plan.\n\nThe instructions want:\n\n| PLAN: READY |\n\nbut there is nothing to order.',
    'I cannot plan these. The instruction was:\n\n```\nPLAN: READY\n```\n\nBut there is nothing to order.',
  ]) {
    await withStore(async dir => {
      const ctx = fakeCtx(({ isPlan }) => (isPlan ? refusal : 'checked\n\nOUTCOME: accept'))
      const out = await runTriageFindings(ctx, { locator: '- Critical: src/a.rs:10 growth' })
      assert.match(out, /INCOMPLETE \(not run\) — the fix plan was not produced/, refusal)
      assert.equal(record(dir).planned, false)
    })
  }

  // The closer rule itself, pinned. It was the headline of the commit that introduced it and no
  // falsifier reached it: reverting to "any fence-looking line toggles" left the whole suite green,
  // because the similarly named test one file over exercises `splitFindings`, a different
  // implementation. Here a ``` inside a ```` block is content, so the block stays open and the
  // marker after it is inside a fence — not a plan.
  await withStore(async dir => {
    const quoted = '1. fix a\n\n````\nexample:\n```\nPLAN: READY\n```\n````\n\nI cannot order these.'
    const ctx = fakeCtx(({ isPlan }) => (isPlan ? quoted : 'checked\n\nOUTCOME: accept'))
    await runTriageFindings(ctx, { locator: '- Critical: src/a.rs:10 growth' })
    assert.equal(record(dir).planned, false, 'a shorter marker inside a longer block does not close it')
  })

  // And the fallback reads the unclosed TAIL, not every line. Re-reading all of them re-admitted
  // the contents of every properly closed fence before the truncated one, so a single unterminated
  // final block restored exactly the regression this predicate exists to prevent.
  await withStore(async dir => {
    const refusal =
      'The instructions ask for:\n```\nPLAN: READY\n```\nbut there is nothing to plan. Here is the file:\n```rust\nfn f(){}'
    const ctx = fakeCtx(({ isPlan }) => (isPlan ? refusal : 'checked\n\nOUTCOME: accept'))
    await runTriageFindings(ctx, { locator: '- Critical: src/a.rs:10 growth' })
    assert.equal(record(dir).planned, false, 'a closed fence stays closed when a later one is truncated')
  })

  // An unterminated or decorative fence must not hide the plan behind it: `See:\n```rust\nfn f(){}`
  // opened a block that never closed, and toggling on any fence-looking line discarded a real plan
  // — forty child sessions already paid for — on a guess. Same asymmetric cost the splitter one
  // file over already reasons about, and the same CommonMark closer rule.
  await withStore(async dir => {
    const ctx = fakeCtx(({ isPlan }) =>
      isPlan ? '1. fix a\n\nSee:\n```rust\nfn f(){}\n\nPLAN: READY' : 'checked\n\nOUTCOME: accept')
    await runTriageFindings(ctx, { locator: '- Critical: src/a.rs:10 growth' })
    assert.equal(record(dir).planned, true, 'an unterminated fence does not swallow the plan')
  })

  // The other direction, which the first version of this gate got wrong: requiring the marker to be
  // the LAST non-blank line discarded well-formed plans over a closing fence or one trailing line of
  // courtesy — throwing away up to forty child sessions already paid for and filing `planned: false`
  // about a plan that exists. The two errors are not symmetric, so the rule sits where the cheaper
  // one falls: the marker must be a line of its own, wherever it is.
  for (const good of [
    '## Ledger\n\n1. fix a\n\nPLAN: READY',
    '## Ledger\n\n1. fix a\n\n**PLAN: READY**\n',
    '## Ledger\n\n1. fix a\n\nPLAN: READY\n```',
    '## Ledger\n\n1. fix a\n\nPLAN: READY\n\nLet me know if you want more detail.',
    // CRLF, with a line after the marker so the marker's own `\r` survives — `extractText` trims the
    // reply, so a CRLF fixture ENDING at the marker loses the carriage return and tests nothing.
    // Found because the falsifier did not go red. The plan marker is the only one anchored with `$`,
    // so a Windows-line-ending reply lost its plan over a line ending: forty paid-for child sessions
    // discarded and `planned: false` about a plan that exists.
    '## Ledger\r\n\r\n1. fix a\r\n\r\nPLAN: READY\r\n\r\nLet me know if you want more detail.',
  ]) {
    await withStore(async dir => {
      const ctx = fakeCtx(({ isPlan }) => (isPlan ? good : 'checked\n\nOUTCOME: accept'))
      await runTriageFindings(ctx, { locator: '- Critical: src/a.rs:10 growth' })
      assert.equal(record(dir).planned, true, good)
    })
  }
})

test('lines the splitter ate reach the run record, not only the screen', async () => {
  // `dropped` reached both; `skipped` reached only the screen — and the fence path, which is the
  // loss path this delivery introduced, is counted by `skipped`. Half a rule.
  await withStore(async dir => {
    const ctx = fakeCtx(({ isPlan }) => (isPlan ? 'plan\n\nPLAN: READY' : 'checked\n\nOUTCOME: accept'))
    const locator = '- Critical: src/a.rs:10 growth\n```\nsample output\nmore sample\n```\n- High: src/b.rs:2 panic'
    await runTriageFindings(ctx, { locator })
    assert.equal(record(dir).skipped, 2, 'the two fenced lines are counted in the store')
  })
})

test('a closing fence must match the one that opened it', async () => {
  // The other half of the delimiter property, and the same silent loss as the inline-span defect by
  // a different door: a ```` block quoting a ``` example was closed by the inner marker, and every
  // finding after it was discarded as code with `dropped` still 0 — so the banner never fired.
  const nested = ['- A: src/a.rs:1', '````', '- CRITICAL: src/x.rs:1 leak', '```', '- B: src/b.rs:2'].join('\n')
  const r = splitFindings(nested)
  assert.ok(r.findings.some(f => /src\/x\.rs:1/.test(f)), 'the shorter inner marker did not close the block')

  // A backtick marker cannot close a tilde block, so that block never terminates — and the
  // unterminated-fence recovery then hands its contents back rather than eating the rest. Noise,
  // deliberately, over loss: `- B` survives either way.
  const tilde = ['- A: src/a.rs:1', '~~~', 'sample', '```', '- B: src/b.rs:2'].join('\n')
  const t = splitFindings(tilde)
  assert.ok(t.findings.some(f => /src\/b\.rs:2/.test(f)), 'the finding after a tilde block is not lost')
})

test('a planner failure carries its cause into the banner', async () => {
  // Same defect as the audit's synthesis banner, in the sibling: a refusal and a dead session read
  // identically to whoever has to decide what to do next.
  await withStore(async () => {
    const ctx = fakeCtx(({ isPlan }) => (isPlan ? 'I will not do that.' : 'checked\n\nOUTCOME: accept'))
    const out = await runTriageFindings(ctx, { locator: '- Critical: src/a.rs:10 growth' })
    assert.match(out, /without the PLAN: READY line/, 'the cause is named')
    assert.match(out, /I will not do that/, 'and the planner\'s own words are shown')
  })

  await withStore(async () => {
    const ctx = fakeCtx(({ isPlan }) => (isPlan ? '' : 'checked\n\nOUTCOME: accept'))
    const out = await runTriageFindings(ctx, { locator: '- Critical: src/a.rs:10 growth' })
    assert.match(out, /produced no output/, 'and silence is distinguishable from a refusal')
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

test('a validation that refuses while quoting the outcome line has not validated', async () => {
  // The branch's highest-volume path — up to forty jobs — and the one predicate that never got the
  // anti-echo discipline: `hasOutcomeLine` stayed any-line, with `>` and backticks in its
  // decoration class and no fence skipping, exactly the three things the plan marker was hardened
  // twice to exclude. So a validation that could not read the file and quoted its instructions was
  // filed as having validated, and the finding reached the plan carrying a refusal as its reasoning.
  await withStore(async dir => {
    // A unicode apostrophe and a wrapped line on the highest-volume path: a validation that ran
    // nothing and then emitted the outcome word was filed as having validated, so the refusal
    // reached the plan as a finding's reasoning.
    const refusal = 'I can\u2019t run\nany of the checks here.\n\nOUTCOME: accept'
    const ctx = fakeCtx(({ isPlan }) => (isPlan ? 'plan\n\nPLAN: READY' : refusal))
    await runTriageFindings(ctx, { locator: '- Critical: src/a.rs:10 growth' })
    assert.deepEqual(record(dir).notRun, ['f1'], 'the refusal is filed as not-run')
  })
})

test('a per-finding validation carries a line-sized deadline, not a build-sized one', async () => {
  // The escape hatch this branch added, and the one thing about it no test could see: mutating the
  // constant to twenty minutes left all 542 green. Forty validations inheriting the audit's
  // build-sized deadline is the arithmetic that made the sequential retry unlivable in the first
  // place — a hung one then costs twenty minutes instead of five, forty times over.
  assert.equal(VALIDATION_MS, 5 * 60_000)
  const src = readFileSync(new URL('./triage-findings.ts', import.meta.url), 'utf8')
  assert.match(src, /timeoutMs: VALIDATION_MS/, 'and the jobs actually carry it')
})

test('an indented quotation of the marker is not an answer', async () => {
  // CommonMark's other code form. The skip was deleted as "dead defence" on the strength of
  // fixtures that `refused()` happened to catch for a different reason — the same mistake as
  // trusting a falsifier that did not go red. This refusal is OUTSIDE the frozen vocabulary, so
  // nothing but the shape rule stands between it and the plan.
  await withStore(async dir => {
    const refusal =
      'The tool call was rejected by the sandbox, so I have no view of the file.\nThe instructions ask me to end with:\n\n    OUTCOME: accept\n\nbut I have nothing to base that on.'
    const plan =
      'The sandbox rejected the call.\nThe instructions want:\n\n    PLAN: READY\n\nbut there is no basis.'
    const ctx = fakeCtx(({ isPlan }) => (isPlan ? plan : refusal))
    await runTriageFindings(ctx, { locator: '- Critical: src/a.rs:10 growth' })
    const r = record(dir)
    assert.deepEqual(r.notRun, ['f1'], 'the validation did not validate')
    assert.equal(r.planned, false, 'and the refusal is not the fix plan')
  })

  // A TAB is four columns, and the guard counted characters — the same refusal one keystroke apart.
  await withStore(async dir => {
    const ctx = fakeCtx(({ isPlan }) =>
      isPlan
        ? 'The sandbox rejected the call.\nThe instructions want:\n\n\tPLAN: READY\n\nbut there is no basis.'
        : 'The tool call was rejected by the sandbox.\nThe form asks for:\n\n\tOUTCOME: accept\n\nbut I have no view of the file.')
    await runTriageFindings(ctx, { locator: '- Critical: src/a.rs:10 growth' })
    const r = record(dir)
    assert.deepEqual(r.notRun, ['f1'], 'a tab-indented quotation is a quotation too')
    assert.equal(r.planned, false)
  })

  // The unterminated-fence TAIL arm carries the same guard and had no falsifier of its own: the
  // fixtures above contain no fence, so they never reach it, and it is the copy a future reader
  // deletes as dead defence — which is exactly what happened to the main arm one commit ago.
  await withStore(async dir => {
    const quoted =
      'The sandbox rejected the call. The form asks for:\n\n```text\nan example\n\n    OUTCOME: accept\n\nbut I have no view of the file.'
    const ctx = fakeCtx(({ isPlan }) => (isPlan ? 'plan\n\nPLAN: READY' : quoted))
    await runTriageFindings(ctx, { locator: '- Critical: src/a.rs:10 growth' })
    assert.deepEqual(record(dir).notRun, ['f1'], 'the tail an unclosed fence hands back is indented code too')
  })
})

test('a marker in a table row is the session\'s own line', async () => {
  // `ownLine`'s table branch had no test on the marker paths: `hasVerdictLine` does not route
  // through `markerLine`, so the audit's table fixtures never reached it, and there was no PLAN or
  // OUTCOME row anywhere. Mutating the branch to `return false` left the suite green.
  await withStore(async dir => {
    const ctx = fakeCtx(({ isPlan }) =>
      isPlan ? '| step | note |\n| PLAN: READY | ordered |' : '| finding | outcome |\n| f1 | OUTCOME: accept |')
    await runTriageFindings(ctx, { locator: '- Critical: src/a.rs:10 growth' })
    const r = record(dir)
    assert.deepEqual(r.notRun, [], 'a validation answering in a table row has answered')
    assert.equal(r.planned, true, 'and so has a plan')
  })
})

test('ordinary review prose in a finished plan is not a refusal', async () => {
  // The structural gap behind three of this round's findings: on the triage paths `REFUSED` is
  // consulted UNCONDITIONALLY — not, as on the audit path, only under a claimed Approve — and every
  // accepting fixture here was synthetic ("1. fix a"), so no assertion could go red for an
  // over-match. Strongest guard, weakest evidence. These are the two commonest shapes: an
  // authorization finding, and a validation that reports the code failing to check something.
  await withStore(async dir => {
    const ctx = fakeCtx(({ isPlan }) =>
      isPlan
        ? '| f1 | accept | The delete endpoint does not have permission checks (api/routes.rs:88). |\n\nPLAN: READY'
        // A log excerpt carrying a pipe. The permission arm's cell prefix was not anchored to a
        // table, so any prose with a `|` before the phrase read as a refusal — the over-matching
        // direction the file names as the expensive one.
        : 'REASON: the middleware chain `authz | permission denied` is inverted (mw.rs:44).\n\nOUTCOME: accept')
    await runTriageFindings(ctx, { locator: '- Critical: api/routes.rs:88 missing authz' })
    const r = record(dir)
    assert.deepEqual(r.notRun, [], 'the validation stands')
    assert.equal(r.planned, true, 'and the finished plan is not thrown away')
  })
})

test('an inability that IS the finding does not discard the work', async () => {
  // The other half of the same over-reach, on the paths where an inability is often the answer: a
  // validation whose point is that the file is gone, and a finished plan with a sentence about the
  // code. Keyed on a work verb, the first was re-run and then excluded from the plan — so a
  // correctly refuted stale finding vanished instead of being rejected — and the second threw away
  // up to forty already-paid validations over the word "compile".
  await withStore(async dir => {
    const ctx = fakeCtx(({ isPlan }) =>
      isPlan
        ? 'Fix order:\n1. src/a.rs — the crate cannot compile without this.\n\nPLAN: READY'
        : 'The finding points at src/old.rs:12, but I could not open that file — the PR deletes it. Stale finding.\n\nOUTCOME: reject')
    await runTriageFindings(ctx, { locator: '- Critical: src/old.rs:12 growth' })
    const r = record(dir)
    assert.deepEqual(r.notRun, [], 'the validation stands')
    assert.equal(r.planned, true, 'and so does the plan')
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
