// The prior-decision sections lifted out of a nested report and carried into the outer one verbatim
// (integrations/shared/prior-decision-report.mjs, bundled into src/rust-audit.js).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { liftPriorDecisionSections, nestedPriorDecisionsSection, PRIOR_DECISION_HEADINGS } from './prior-decision-report.mjs'

/** The heading that starts with `start`. @param {string} start @returns {string} */
const heading = start => PRIOR_DECISION_HEADINGS.find(h => h.startsWith(start)) ?? ''
const REJECTED = heading('## Rejected before')
const DEFERRED = heading('## Known and deferred')
const TITLES = heading('## Tool finding titles')

test('lift: each prior-decision section leaves the report whole, from its heading to the next heading', () => {
  const report = ['Intro line', '## Verdict', 'Approve', `${REJECTED}  `, '- a', '- b', '## Findings', '- c', TITLES, '- t1'].join('\n')
  assert.deepEqual(liftPriorDecisionSections(report), {
    rest: ['Intro line', '## Verdict', 'Approve', '## Findings', '- c'].join('\n'),
    lifted: [`${REJECTED}  `, '- a', '- b', TITLES, '- t1'].join('\n').trim(),
  })
})

test("lift: a High a human's decision set aside and a High a rule covers ride with the rest (node #196)", () => {
  const human = '## High rejected by a human (set aside — not in the verdict)'
  const confirm = '## High covered by a project rule — confirm (still in the verdict)'
  const report = ['## Verdict', 'Warning', human, '- h', confirm, '- c', '## Findings', '- f'].join('\n')
  assert.deepEqual(liftPriorDecisionSections(report), {
    rest: ['## Verdict', 'Warning', '## Findings', '- f'].join('\n'),
    lifted: [human, '- h', confirm, '- c'].join('\n'),
  })
})

test('lift: a report without the sections is returned as it came, nothing lifted', () => {
  assert.deepEqual(liftPriorDecisionSections('text\n## Verdict\nok'), { rest: 'text\n## Verdict\nok', lifted: '' })
})

test('lift: the lifted text is trimmed at its ends, its inner lines kept', () => {
  const report = `${DEFERRED}\n\n- q\n\n`
  assert.deepEqual(liftPriorDecisionSections(report), { rest: '', lifted: `${DEFERRED}\n\n- q` })
})

test('lift: a heading only shaped like one (no space after ##) does not open or close a section', () => {
  const report = `${REJECTED}\n- a\n##note\n- b`
  assert.deepEqual(liftPriorDecisionSections(report), { rest: '', lifted: `${REJECTED}\n- a\n##note\n- b` })
})

test('nested section: every dimension with lifted text, under its own heading; the empty ones left out', () => {
  const out = nestedPriorDecisionsSection([
    { dimension: 'security', text: `${REJECTED}\n- a` },
    { dimension: 'style', text: '' },
    { dimension: 'perf', text: `${TITLES}\n- t` },
  ])
  assert.equal(out, `\n\n## Prior decisions in the nested reviews (verbatim)\n### security\n${REJECTED}\n- a\n\n### perf\n${TITLES}\n- t\n`)
})

test('nested section: empty when no nested review had any', () => {
  assert.equal(nestedPriorDecisionsSection([]), '')
  assert.equal(nestedPriorDecisionsSection([{ dimension: 'security', text: '' }]), '')
})
