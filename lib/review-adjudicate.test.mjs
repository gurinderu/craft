// Regression tests for the Adjudicate-track hardening in workflows/review.js:
//  - sanitizeAttack: model "attack"/"note" text is capped and flattened before it is persisted
//    into the ledger `why`, re-interpolated into next-round prompts, or rendered in the report;
//  - baseWhy: " — fix incomplete: …" / " — REGRESSED after fix: …" suffixes never accrete across
//    re-review rounds (each round sees the original rationale plus at most the LATEST attack);
//  - wiring: a contradictory resolved+attack adjudication demotes, red-team death is surfaced,
//    and a defeated=true verdict with an empty attack is rejected.
// review.js is a sandbox workflow script (top-level export/await/return) — like
// lib/review-registry.test.mjs we eval the declarations prefix (before phase('Scout')).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'workflows', 'review.js'), 'utf8')

function loadHelpers() {
  const cut = src.indexOf("phase('Scout')")
  assert.ok(cut > 0, "expected a top-level phase('Scout') to mark the end of the declarations prefix")
  const prefix = src.slice(0, cut).replace(/^export const meta/m, 'const meta')
  const stub = () => {}
  const budget = { total: null, spent: () => 0, remaining: () => 0 }
  const factory = new Function(
    'args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow',
    `${prefix}\n;return { sanitizeAttack, baseWhy, ATTACK_MAX };`,
  )
  return factory({}, stub, stub, stub, stub, stub, budget, stub)
}

const { sanitizeAttack, baseWhy, ATTACK_MAX } = loadHelpers()

test('sanitizeAttack flattens newlines, strips markdown structure chars, caps length', () => {
  assert.equal(sanitizeAttack('a\nb\r\nc'), 'a b c')
  assert.equal(sanitizeAttack('## heading ```fence```'), 'heading fence')
  const out = sanitizeAttack('x'.repeat(ATTACK_MAX + 100))
  assert.equal(out.length, ATTACK_MAX + 1, 'capped to ATTACK_MAX chars plus the ellipsis')
  assert.ok(out.endsWith('…'), 'truncation is marked with an ellipsis')
  assert.equal(sanitizeAttack(null), '')
  assert.equal(sanitizeAttack('   \n  '), '', 'whitespace-only attack is empty (falsy) after sanitizing')
})

test('baseWhy strips prior fix-incomplete / REGRESSED suffixes so attacks do not accrete', () => {
  assert.equal(baseWhy('races on shared map — fix incomplete: attack A'), 'races on shared map')
  assert.equal(
    baseWhy('races on shared map — fix incomplete (adjudicator reported attack despite resolved): attack A'),
    'races on shared map',
  )
  assert.equal(baseWhy('races on shared map — REGRESSED after fix: new defect'), 'races on shared map')
  assert.equal(baseWhy('races on shared map — fix incomplete: A — fix incomplete: B'), 'races on shared map')
  assert.equal(baseWhy('plain why with — a dash but no marker'), 'plain why with — a dash but no marker')
  assert.equal(baseWhy(null), '')
})

test('adjudicate wiring: contradiction demotes, red-team death surfaced, empty-attack defeat rejected', () => {
  assert.ok(/resolved WITH an attack/.test(src),
    'checkResults must demote a contradictory resolved+attack adjudication to still-open (log marker "resolved WITH an attack")')
  assert.ok(/red-team died/.test(src),
    'the Adjudicate summary log must surface the red-team death counter ("N red-team died")')
  assert.ok(/claimed defeat with NO attack/.test(src),
    'redTeam must reject defeated=true with an empty attack (log marker "claimed defeat with NO attack")')
})
