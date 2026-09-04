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

test('a wrapped continuation stays with its finding', () => {
  // It was split into two: the continuation carries a file:line, which an earlier rule read as a
  // finding of its own — so half a sentence was validated as if it were a defect report.
  const { findings } = splitFindings('- Critical: the parser drops bytes\n  see src/parse.rs:88 for the site')
  assert.equal(findings.length, 1, 'the continuation belongs to the bullet above it')
  assert.match(findings[0], /drops bytes see src\/parse\.rs:88/)
})

test('prose findings are triaged, not discarded because something else was structured', () => {
  // The trap in the first attempt: one structured line anywhere flipped the whole blob into
  // "structured mode" and every plain sentence was dropped. A mixed report is the ordinary case, so
  // that lost real findings in exactly the situation the tool is used for.
  const { findings, skipped } = splitFindings(
    'The parser drops trailing bytes.\nThe retry loop never terminates.\n- src/a.rs:10 unbounded growth',
  )
  assert.equal(findings.length, 3, 'all three are findings')
  assert.equal(skipped, 0)
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
