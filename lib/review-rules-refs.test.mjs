// The language-independent review rules (skills/review-rules) as every lens and verifier is sent to
// them: unit, and executed through the real engine for both profiles.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { runEngine } from './engine-harness.mjs'
import { reviewRulesLine, alreadyFoundBlock, sharedExclusionsLine, pluginFileCandidates, REVIEW_RULES_DIR } from './review-rules-refs.mjs'
import { HARM_LEVELS, harmAtLeastOperatorRecovery } from './harm-levels.mjs'
import { FINDING_ITEM } from './review-schemas.mjs'

test('the shared rules directory ships the files the prompts name', () => {
  for (const f of ['SKILL.md', 'severity.md', 'classes.md', 'sweeps.md', 'fp-rules.md']) {
    assert.ok(fs.existsSync(new URL(`../${REVIEW_RULES_DIR}/${f}`, import.meta.url)), `${REVIEW_RULES_DIR}/${f}`)
  }
})

test('pluginFileCandidates: explicit root, then the plugin root, then the versioned cache; never a relative path', () => {
  assert.deepEqual(pluginFileCandidates('/r\nx', '1.2.3', 'skills/x'), ['`/r x/skills/x`', '`${CLAUDE_PLUGIN_ROOT}/skills/x`', '`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/craft/craft/1.2.3/skills/x`'])
  assert.equal(pluginFileCandidates('', '1.2.3', 'skills/x').length, 2, 'no craftRoot, no candidate for it')
})

test('reviewRulesLine names the three files, the plugin locations and the harm cap', () => {
  const line = reviewRulesLine('/plugins/craft', '1.2.3')
  for (const w of ['severity.md', 'classes.md', 'sweeps.md', '`/plugins/craft/skills/review-rules`', 'never the reviewed repo', '`harm`', '`harmLevel`', 'operator-recovery ≤ Medium']) {
    assert.ok(line.includes(w), w)
  }
})

test('alreadyFoundBlock forbids the same place and sends the lens to the sibling sweep', () => {
  const b = alreadyFoundBlock('- a.rs:3 thing')
  assert.match(b, /do not re-report these PLACES/)
  assert.match(b, /same class at a DIFFERENT place[^\n]*is NOT a repeat/)
  assert.match(b, /sweeps\.md §1/)
  assert.ok(b.endsWith('\n- a.rs:3 thing'))
  assert.doesNotMatch(b, /look for what these MISSED/, 'the old wording that made lenses skip sibling instances is gone')
})

test('sharedExclusionsLine points every verifier at the shared fp-rules and keeps FP-002 a downgrade', () => {
  const l = sharedExclusionsLine('', '1.2.3')
  assert.ok(l.includes('fp-rules.md') && l.includes('${CLAUDE_PLUGIN_ROOT}/skills/review-rules'))
  assert.match(l, /FP-002[^.]*DOWNGRADE, not a refutation/)
})

test('harm levels: the schema offers them and only operator recovery or worse counts for a floor', () => {
  assert.deepEqual(/** @type {any} */ (FINDING_ITEM.properties).harmLevel.enum, HARM_LEVELS)
  assert.ok(!FINDING_ITEM.required.includes('harm') && !FINDING_ITEM.required.includes('harmLevel'), 'optional: seeds and older records stay valid')
  assert.deepEqual(HARM_LEVELS.filter(harmAtLeastOperatorRecovery), ['data-loss', 'security', 'outage', 'irreversible', 'intent-unmet', 'repo-rule', 'operator-recovery'])
  assert.equal(harmAtLeastOperatorRecovery(undefined), false)
})

const base = {
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  '*': null,
}
const RUST = {
  ...base,
  detect: { baseRef: 'main', files: ['src/controller.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
  scout: { lenses: ['reconciler', 'safety', 'maintainability'], sizeBucket: 'small', securitySensitive: false, isLibrary: false, intent: 'controller change', churn: [] },
}
const NIX = {
  ...base,
  detect: { baseRef: 'main', files: ['flake.nix'], spec: '', branch: 'feat/x', head: 'abc1234' },
  scout: { lenses: ['purity', 'maintainability'], sizeBucket: 'small', securitySensitive: false, isLibrary: false, intent: 'flake change', churn: [] },
}

for (const [name, script, prefix] of /** @type {[string, any, string][]} */ ([['rust', RUST, 'lens:rust:'], ['nix', NIX, 'lens:nix:']])) {
  test(`review (${name}): every lens is sent to the review rules beside its rubric, with the new ALREADY-FOUND`, async () => {
    const { calls } = await runEngine('review', { args: { craftRoot: '/plugins/craft' }, script })
    const lenses = calls.filter(c => String(c.label).startsWith(prefix))
    assert.ok(lenses.length >= 2, `lenses must be dispatched: ${calls.map(c => c.label).join(', ')}`)
    for (const c of lenses) {
      assert.ok(c.prompt.includes('REVIEW RULES'), `${c.label} carries the review-rules line`)
      assert.ok(c.prompt.includes('`/plugins/craft/skills/review-rules`'), `${c.label} reads them from the plugin`)
      assert.match(c.prompt, /is NOT a repeat/, `${c.label} is told a sibling instance is not a repeat`)
    }
  })
}

test('review (rust): the reconciler and failure-windows lenses name the early-exit sweep', async () => {
  const { calls } = await runEngine('review', { args: {}, script: RUST })
  for (const l of ['reconciler', 'failure-windows']) {
    const c = calls.find(x => String(x.label).startsWith(`lens:rust:${l}`))
    assert.ok(c, `${l} dispatched`)
    assert.match(c.prompt, /EARLY EXITS \(review-rules sweeps\.md §2\)/, `${l} names the early-exit diff`)
    assert.match(c.prompt, /only when its `harmLevel` is operator-recovery or worse/, `${l} is told when the floor applies`)
  }
  const m = calls.find(x => String(x.label).startsWith('lens:rust:maintainability'))
  assert.match(m?.prompt ?? '', /SEVERITY: Low \(optional\) by default/, 'maintainability defaults to Low')
})
