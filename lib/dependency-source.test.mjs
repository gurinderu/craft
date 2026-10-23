// The one instruction for finding a pinned dependency's source (lib/dependency-source.mjs) reaches
// the agents that must open that code to settle a premise: the triage validator, every
// adversarial-review lens, and review's lenses and verifiers.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
import { DEPENDENCY_SOURCE_HOW } from './dependency-source.mjs'

test('the instruction names the pinned version, locked cargo calls, vendoring, flake inputs and other ecosystems', () => {
  assert.match(DEPENDENCY_SOURCE_HOW, /version the project pins/)
  assert.match(DEPENDENCY_SOURCE_HOW, /`manifest_path` from `cargo metadata --locked --format-version 1`/)
  assert.match(DEPENDENCY_SOURCE_HOW, /Cargo\.lock/)
  assert.match(DEPENDENCY_SOURCE_HOW, /`cargo fetch --locked`/)
  assert.match(DEPENDENCY_SOURCE_HOW, /Cargo\.lock exists but `--locked` refuses.*cannot be determined/)
  assert.match(DEPENDENCY_SOURCE_HOW, /no Cargo\.lock[^.]*throwaway copy/)
  assert.match(DEPENDENCY_SOURCE_HOW, /throwaway copy[^;]*`cargo metadata --format-version 1` there/)
  assert.match(DEPENDENCY_SOURCE_HOW, /resolved today, not a pinned one/)
  assert.match(DEPENDENCY_SOURCE_HOW, /never write Cargo\.lock in the reviewed checkout/)
  assert.doesNotMatch(DEPENDENCY_SOURCE_HOW.replace(/throwaway copy[^;]*there/, ''), /cargo (?:metadata|fetch)(?! --locked)/, 'only the throwaway copy resolves unlocked')
  assert.match(DEPENDENCY_SOURCE_HOW, /vendor/)
  assert.match(DEPENDENCY_SOURCE_HOW, /flake\.lock/)
  assert.match(DEPENDENCY_SOURCE_HOW, /lockfile/)
  assert.doesNotMatch(DEPENDENCY_SOURCE_HOW, /[\r\n]/)
})

test('triage-findings: the validator prompt carries the instruction beside its premise discipline', async () => {
  const r = await runEngine('triage-findings', {
    args: { report: '/r.md' },
    script: {
      'log-run': { ok: true },
      'gather:report': { source: 'rust-audit', findings: [{ severity: 'High', title: 'leak', location: 'src/a.rs:10', detail: 'd', proposed_fix: '', thread_id: '' }] },
      validate: { stable_id: 'rust-audit::src/a.rs:10::leak', verdict: 'accept', reason: 'real', fix_pointer: 'rust-errors: x', premise_checked: '' },
      plan: { plan_markdown: 'BODY', summary: 'S', ledger: [] },
    },
  })
  const prompt = r.calls.find(c => c.label.startsWith('validate:'))?.prompt ?? ''
  assert.ok(prompt.includes(DEPENDENCY_SOURCE_HOW), 'validator prompt carries the instruction')
  assert.ok(prompt.indexOf('PREMISE DISCIPLINE') < prompt.indexOf(DEPENDENCY_SOURCE_HOW), 'after the premise discipline')
})

test('adversarial-review: a lens prompt carries the instruction beside WHERE-CHECKED', async () => {
  const r = await runEngine('adversarial-review', {
    script: {
      scout: { baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: ['src/a.rs'], notes: 'n' },
      'index-warmup': { indexed: false, notes: 'x' },
      'coverage-critic': { findings: [] },
      'log-run': { ok: true },
      '*': () => ({ findings: [] }),
    },
  })
  const prompt = r.calls.find(c => c.label === 'review:correctness')?.prompt ?? ''
  assert.ok(prompt.includes(DEPENDENCY_SOURCE_HOW), 'lens prompt carries the instruction')
  assert.ok(prompt.indexOf('WHERE-CHECKED') < prompt.indexOf(DEPENDENCY_SOURCE_HOW), 'after WHERE-CHECKED')
})

test('review: the lens WHERE-CHECKED rule and the verifiers carry the instruction', async () => {
  const FILE = 'crates/node/src/db.rs'
  const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
  /** @param {Record<string, unknown>} over */
  const finding = over => ({ severity: 'Medium', title: 't', file: FILE, line: 12, why: 'w', fix: 'f', blastRadius: '', source: 'errors', ruleId: '', symbol: 's', whereChecked: '', ...over })
  // A High goes to its own verifier, a Medium to the batch one; the High is refuted so no confirmed
  // Block lets the batch be skipped.
  const mediums = [1, 2].map(n => finding({ severity: 'Medium', title: `medium ${n}`, line: 20 + n }))
  const r = await runEngine('review', { args: {}, script: {
    detect: { baseRef: 'main', files: [FILE], spec: '', branch: 'feat/x', head: 'abc9999' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses: ['errors'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: (/** @type {{ opts: { label: string } }} */ { opts }) => ({ lens: 'errors', findings: opts.label.startsWith('lens:rust:errors r1') ? [finding({ severity: 'High' }), ...mediums] : [] }),
    dedup: { groups: [] },
    verify: () => ({ ...UPHELD, refuted: true }),
    'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
    '*': null,
  } })
  /** @param {(label: string) => boolean} pick */
  const prompts = pick => r.calls.filter(c => pick(String(c.label))).map(c => String(c.prompt))
  const lenses = prompts(l => l.startsWith('lens:'))
  const single = prompts(l => l.startsWith('verify:'))
  const batch = prompts(l => l.startsWith('verify-batch'))
  assert.ok(lenses.length && single.length && batch.length, `lens, verify and verify-batch all ran: ${r.calls.map(c => c.label).join(', ')}`)
  for (const p of lenses) assert.ok(p.indexOf('WHERE-CHECKED') < p.indexOf(DEPENDENCY_SOURCE_HOW) && p.includes(DEPENDENCY_SOURCE_HOW), 'lens prompt carries it after WHERE-CHECKED')
  for (const p of [...single, ...batch]) assert.ok(p.includes(DEPENDENCY_SOURCE_HOW), 'verifier prompt carries it')
})
