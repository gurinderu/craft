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
import { splitFindings } from './triage-findings.ts'

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
