// triage-findings with a project memory the size a long-lived project grows (realm @nick/craft, node #273):
// more than a hundred decisions for the batch's paths and a few project-wide rules beside them. A rule
// still strikes every finding it covers before validation, so none of them becomes a plan item — the
// decisions do not crowd the rules out of the records read, nor do the pairs past one judge's prompt
// go unjudged.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

const RACE_RULE = {
  kind: 'rule',
  title: 'Do not guard theoretical races or double faults with consistent reads or elaborate recovery paths',
  body: 'a race in a tiny window, where upstream main is no better, is accepted as is',
  scope: '.',
  status: 'active',
  date: '2026-11-04',
  author: 'nick',
  links: [],
}
const OTHER_RULES = [
  { ...RACE_RULE, title: 'Mixed-version clusters and rollback are not supported', body: 'upgrade with a full restart' },
  { ...RACE_RULE, title: 'No helper under three lines and no single-caller helper', body: 'the maintainer rejects them' },
]
/** @param {number} i */
const decision = i => ({
  kind: 'decision',
  title: `doc wording ${i}`,
  body: 'kept as written',
  scope: `docs/d${i}.md`,
  status: 'active',
  date: '2026-11-01',
  author: 'nick',
  commit: 'def5678',
  links: [],
})
/** @param {string} title @param {number} line */
const finding = (title, line) => ({ severity: 'Medium', title, location: `src/auth/login.rs:${line}`, detail: 'd', proposed_fix: 'add a CAS', thread_id: '' })
const RACES = Array.from({ length: 15 }, (_, i) => finding(`race ${i} between concurrent logins with no interleaving shown`, 10 + i * 10))
const OWN = finding('consent revoke leaves the session cookie', 400)

/** The rule judge: covered when a race finding meets the race rule. @param {{ prompt: string }} call */
const RULE_JUDGE = ({ prompt }) => {
  const pairs = JSON.parse(String(/^\[\{"pair".*\]$/m.exec(prompt)?.[0]))
  return {
    verdicts: pairs.map((/** @type {any} */ p) => ({
      pair: p.pair,
      covered: /theoretical races/.test(p.rule.rule) && /^race /.test(p.finding.title),
      violates: false,
      why: 'no concrete interleaving: a theoretical race',
    })),
  }
}

test('a project rule strikes every finding it covers before validation, past a hundred decisions and one judge prompt', async () => {
  const r = await runEngine('triage-findings', {
    args: { pr: '9' },
    script: {
      'log-run': { ok: true },
      'gather:pr': { source: 'github-pr', findings: [...RACES, OWN] },
      'memory-recall': {
        backend: 'harness',
        why: 'the default',
        decisions: Array.from({ length: 120 }, (_, i) => decision(i)),
        rules: [RACE_RULE, ...OTHER_RULES],
      },
      'decision-scope': { unchanged: [], missing: [], reason: '' },
      'rule-match': RULE_JUDGE,
      validate: (/** @type {{ prompt: string }} */ { prompt }) => ({
        stable_id: /stable_id MUST be exactly: (.+)/.exec(prompt)?.[1] ?? '?',
        verdict: 'accept',
        reason: 'real',
        fix_pointer: 'rust-concurrency: add a CAS',
        premise_checked: '',
        noise_class: 0,
        severity: 'Medium',
      }),
      plan: { plan_markdown: 'BODY', summary: 'S', ledger: [] },
    },
  })
  const validated = r.calls.filter((/** @type {any} */ c) => c.label.startsWith('validate:'))
  assert.deepEqual(
    validated.map((/** @type {any} */ c) => /- what: (.+)/.exec(c.prompt)?.[1]),
    [OWN.title],
    'only the finding no rule covers is validated',
  )
  const plan = r.calls.find((/** @type {any} */ c) => c.label === 'plan')
  const accepted = /ACCEPTED \(with their findings\):\n([\s\S]*?)\n\nALL VERDICTS/.exec(String(plan?.prompt))?.[1] ?? ''
  assert.doesNotMatch(accepted, /race \d+ between concurrent logins/, 'no covered finding becomes a plan item')
  const ledger = /** @type {any[]} */ (r.reportValue.ledger)
  for (const f of RACES) {
    const row = ledger.find(e => e.stable_id === `github-pr::${f.location}::${f.title}`)
    assert.equal(row?.verdict, 'reject', f.title)
    assert.match(String(row?.reason), /COVERED BY PROJECT RULE: Do not guard theoretical races/)
  }
  assert.ok(r.calls.filter((/** @type {any} */ c) => c.label === 'rule-match').length >= 2, 'the 48 pairs take more than one judge prompt')
  assert.equal(r.reportValue.ruleNotices, undefined, 'no finding in a rule scope is left unjudged')
  const recall = r.calls.find((/** @type {any} */ c) => c.label === 'memory-recall')
  assert.match(String(recall?.prompt), /once for kind rule with no path filter/, "rules are recalled past the paths' bound")
})
