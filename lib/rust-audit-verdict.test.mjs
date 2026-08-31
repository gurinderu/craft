// Verdict-honesty guards for the rust-audit workflow (workflows/rust-audit.js).
//
// Two ways it used to overclaim or misreport a nested review's verdict:
//   1. `/INCOMPLETE/i` was tested FIRST, so `⛔ Block (INCOMPLETE)` was downgraded to Warning —
//      the opposite of the severity-first rule lib/analyze-runs.mjs states and implements.
//   2. the whole report body was matched, so an Approve whose body carries a ⚠️ line (the
//      "Not reviewed" section review.js now emits) scored Warning.
//
// rust-audit.js can't be imported (sandbox script: top-level await, `workflow()`, no exports), and
// the helpers under test live past the first executable phase, so the declarations-prefix trick used
// by review-coverage.test.mjs doesn't reach them. Instead we slice each `function <name>(…) { … }`
// block out of the source by brace matching and eval just those — they are pure and closure-free.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const auditSrc = fs.readFileSync(path.join(root, 'workflows', 'rust-audit.js'), 'utf8')
const libSrc = fs.readFileSync(path.join(root, 'lib', 'run-record.mjs'), 'utf8')

// Slice `function <name>(...) { ... }` from `src` by counting braces from the header's `{`.
function fnSource(src, name) {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `expected a top-level function ${name} in the source`)
  let i = src.indexOf('{', start)
  assert.ok(i > 0, `expected a body for ${name}`)
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`unbalanced braces while slicing ${name}`)
}

const { verdictLine, reviewResult, auditVerdict, worstVerdict, normalizeDimensionVerdict } = new Function(
  `${fnSource(auditSrc, 'verdictLine')}\n${fnSource(auditSrc, 'reviewResult')}\n`
  + `${fnSource(auditSrc, 'auditVerdict')}\n${fnSource(auditSrc, 'worstVerdict')}\n`
  + `${/^const GREEN_VERDICT = .*$/m.exec(auditSrc)[0]}\n${fnSource(auditSrc, 'normalizeDimensionVerdict')}\n`
  + 'return { verdictLine, reviewResult, auditVerdict, worstVerdict, normalizeDimensionVerdict }',
)()

const report = (verdict, ...body) => ['## Verdict', verdict, '', ...body].join('\n')

// ---- severity first, then coverage ----

test('a Block (INCOMPLETE) nested review stays a Block', () => {
  // Partial coverage cannot un-find a finding that was already made. Testing /INCOMPLETE/ first
  // downgraded this to Warning and contradicted lib/analyze-runs.mjs's rule for the same question.
  assert.equal(reviewResult('review:x', report('⛔ Block — 2 High · ⚠️ INCOMPLETE — parts of the review did not run.')).verdict, 'Block')
  assert.equal(reviewResult('review:x', report('Block (INCOMPLETE)')).verdict, 'Block')
})

test('the summary of a Block (INCOMPLETE) never calls the dimension uncovered', () => {
  // The summary used to be set from a bare INCOMPLETE test while the verdict classified severity
  // first, so one dimension was a Block and was described as an absence of coverage.
  for (const line of ['⛔ Block — 2 High · ⚠️ INCOMPLETE — parts of the review did not run.', 'Block (INCOMPLETE)']) {
    const r = reviewResult('review:x', report(line))
    assert.equal(r.verdict, 'Block')
    assert.ok(!/uncovered/i.test(r.summary), `a Block summary must not say uncovered: ${r.summary}`)
    assert.match(r.summary, /BLOCK/)
    assert.match(r.summary, /coverage was also partial/)
  }
  const clean = reviewResult('review:x', report('⛔ Block — 2 High'))
  assert.equal(clean.verdict, 'Block')
  assert.match(clean.summary, /BLOCK/)
  assert.ok(!/partial/.test(clean.summary))
})

test('an incomplete non-block review is still described as uncovered', () => {
  const r = reviewResult('review:x', report('⚠️ INCOMPLETE — no supported language in this diff'))
  assert.equal(r.verdict, 'Warning')
  assert.match(r.summary, /uncovered, not clean/)
})

test('an unreadable verdict is described as unverified, not as clean', () => {
  const r = reviewResult('review:x', 'no heading here')
  assert.equal(r.verdict, 'Warning')
  assert.match(r.summary, /unverified, not clean/)
})

test('an Approve voided by incompleteness is not an Approve', () => {
  assert.equal(reviewResult('review:x', report('✅ Approve · ⚠️ INCOMPLETE — parts of the review did not run.')).verdict, 'Warning')
  assert.equal(reviewResult('review:x', report('⚠️ INCOMPLETE — no supported language in this diff')).verdict, 'Warning')
})

// ---- the verdict line decides, not the body ----

test('an Approve whose body contains a ⚠️ line still scores Approve', () => {
  const r = reviewResult('review:x', report(
    '✅ Approve — no confirmed findings.',
    '## Not reviewed (no language profile)',
    '- ⚠️ docs/README.md',
    '## Coverage gaps',
    '- ⚠️ the macro expansion was not checked',
  ))
  assert.equal(r.verdict, 'Approve')
  assert.equal(r.summary, 'Elastic deep review — see findings below.')
})

test('the word INCOMPLETE in the body alone does not mark the dimension uncovered', () => {
  const r = reviewResult('review:x', report(
    '✅ Approve — no confirmed findings.',
    '## Confirmed',
    '- Low · src/a.rs:1 · the doc comment is INCOMPLETE',
  ))
  assert.equal(r.verdict, 'Approve')
  assert.equal(r.summary, 'Elastic deep review — see findings below.')
})

test('a report with no readable verdict line is Warning, never Approve', () => {
  assert.equal(verdictLine('no heading here, but it says Approve'), null)
  assert.equal(reviewResult('review:x', 'no heading here, but it says Approve').verdict, 'Warning')
  assert.equal(reviewResult('review:x', '').verdict, 'Warning')
  assert.equal(reviewResult('review:x', null).verdict, 'Warning')
})

test('verdictLine takes the first non-empty line under the Verdict heading', () => {
  assert.equal(verdictLine('## Verdict\n\n  ✅ Approve — clean.\n\n## Gate\n⚠️ x'), '✅ Approve — clean.')
  assert.equal(verdictLine('# Verdict\n⛔ Block'), '⛔ Block')
})

// ---- the aggregate ----

test('worstVerdict over an empty set is INCOMPLETE, never Approve', () => {
  assert.match(worstVerdict([]), /INCOMPLETE/)
  assert.equal(auditVerdict(worstVerdict([]), ['architecture']), worstVerdict([]))
  assert.equal(auditVerdict('Approve', ['architecture']), 'Approve (INCOMPLETE)')
  assert.equal(auditVerdict('Approve', []), 'Approve')
})

// ---- the two copies of the mirrored helpers must stay identical ----

test('worstVerdict is byte-identical in lib/run-record.mjs and workflows/rust-audit.js', () => {
  assert.equal(fnSource(auditSrc, 'worstVerdict'), fnSource(libSrc, 'worstVerdict').replace(/^export /, ''))
})


// ---- 3. a verdict written INLINE on the heading must not be lost ----

test('verdictLine reads an inline verdict off the heading line itself', () => {
  // Slicing from the END of the heading landed on the next heading, which matches nothing — so a
  // Block was reported as "could not be read" and silently downgraded to Warning.
  assert.equal(verdictLine('## Verdict: ⛔ Block — 2 High\n\n## Gate\nclean'), '⛔ Block — 2 High')
  assert.equal(reviewResult('review:x', '## Verdict: ⛔ Block — 2 High\n\n## Gate\nclean').verdict, 'Block')
  assert.equal(reviewResult('review:x', '### Verdict — ⚠️ Warning\n\n## Gate').verdict, 'Warning')
  assert.equal(reviewResult('review:x', '## Verdict ✅ Approve — no findings\n\n## Gate').verdict, 'Approve')
  // A bare heading still classifies on the first non-empty line below it.
  assert.equal(verdictLine('## Verdict\n\n✅ Approve — clean\n'), '✅ Approve — clean')
  assert.equal(verdictLine('## Verdict:\n\n⛔ Block\n'), '⛔ Block')
  assert.equal(verdictLine('no heading here'), null)
})

// ---- 5. a non-permissive default belongs over a CONSTRAINED vocabulary ----

test('off-vocabulary green answers normalise to Approve instead of flipping the audit', () => {
  for (const v of ['Clean', 'No UB detected', 'No UB found', 'OK', 'No issues', 'no issues found', 'Pass', 'Healthy', 'Approved']) {
    assert.equal(worstVerdict([normalizeDimensionVerdict(v)]), 'Approve', `${v} is a green answer`)
  }
})

test('normalisation never turns a red or unreadable verdict green', () => {
  for (const v of ['Block', 'UB-found', 'At-risk', 'blocking findings', 'Warning', 'Concerns', 'OK, but 2 blocking findings']) {
    assert.notEqual(worstVerdict([normalizeDimensionVerdict(v)]), 'Approve', `${v} must not read as green`)
  }
  // Genuinely unrecognisable text is returned unchanged, so the non-permissive default still applies.
  assert.equal(normalizeDimensionVerdict('¯\\_(ツ)_/¯'), '¯\\_(ツ)_/¯')
  assert.equal(worstVerdict([normalizeDimensionVerdict('¯\\_(ツ)_/¯')]), 'Warning')
  assert.equal(worstVerdict([normalizeDimensionVerdict('')]), 'Warning')
})

test('the dimension verdict vocabulary is pinned by an enum in the schema, not by prose', () => {
  const m = /verdict: \{[\s\S]*?\n {4}\}/.exec(auditSrc)
  assert.ok(m, 'expected the FINDINGS_SCHEMA verdict property')
  assert.ok(/enum: \[/.test(m[0]), 'the verdict property must constrain its vocabulary with an enum')
  for (const w of ['Approve', 'Warning', 'Block', 'Clean', 'UB-found', 'Healthy', 'At-risk']) {
    assert.ok(m[0].includes(`'${w}'`), `the enum must offer ${w}`)
  }
})

test('every dimension result is normalised once, where results are collected', () => {
  assert.ok(
    /const results = \(await parallel\(tasks\)\)\.filter\(Boolean\)\.map\(r => \(\{ \.\.\.r, verdict: normalizeDimensionVerdict\(r\.verdict\) \}\)\)/.test(auditSrc),
    'the aggregate, the record and the synthesis prompt must all read the normalised verdict',
  )
})
