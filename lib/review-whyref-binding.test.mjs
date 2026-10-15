// Two deadnix findings of different bindings in one file share one fingerprint (no symbol, one ruleId),
// so a `whyRef` — the pointer to a row's birth `why` — names the same (record, fp) for both (realm
// @nick/craft, vimarsha #243). Through the real review engine and the real between-round transport
// (filed into a temporary store and read back by findPriorRound, REALITY.md's cross-round carrier), each
// row keeps its own `why` across two rounds: nothing swaps them. The pointer itself does NOT tell the two
// apart — (record, fp) names both birth rows, and no consumer resolves it today; a future resolver must
// pick by the row's tool identity, as the tombstone check does.
import { test, onTestFinished } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { findPriorRound, recordFilename, WHY_TRANSPORT_MAX } from './craft-log-run.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const BINDINGS = ['self', 'pkgs']
// A rationale longer than the transport cap, distinct per binding and per round.
const whyOf = (/** @type {string} */ name, /** @type {number} */ round) => `${name} r${round}: ${`the ${name} binding is never read in round ${round}; `.repeat(14)}`
const seed = (/** @type {string} */ name, /** @type {number} */ round) => ({
  severity: 'Medium', title: `Unused lambda pattern: ${name}`, file: 'flake.nix', line: 3, why: whyOf(name, round), fix: 'drop it',
  blastRadius: '', source: 'deadnix', ruleId: 'MNT-001', symbol: '', whereChecked: '',
})

/** @param {number} round @param {any} [prior] */
const scriptFor = (round, prior) => ({
  detect: { baseRef: 'main', files: ['flake.nix'], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': prior || { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-W', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['maintainability'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  // Round 2 lists the bindings in the other order, so a pointer kept by position would cross.
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: (round === 1 ? BINDINGS : [...BINDINGS].reverse()).map(n => seed(n, round)), notes: '' },
  lens: { lens: 'maintainability', findings: [] },
  dedup: { groups: [] },
  verify: () => UPHELD,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
  adjudicate: { status: 'still-open', note: '', attack: '', currentLine: 3 },
  redteam: { defeated: false, attack: '' },
  carry: { changed: false, reason: 'unchanged' },
  synthesis: null,
  '*': null,
})

/** @param {string[]} args @param {string} cwd */
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()

/**
 * The round a run files, as the next round's loader reads it: the record in a fresh store, its index row
 * on a real commit; returns the filed record, its file name and findPriorRound's answer.
 * @param {any} run @param {number} round @param {string} ts
 */
function transported(run, round, ts) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-whyref-store-'))
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-whyref-repo-'))
  onTestFinished(() => { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }) })
  git(['init', '-q'], repo)
  git(['symbolic-ref', 'HEAD', 'refs/heads/feat/x'], repo)
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'i'], repo)
  const head = git(['rev-parse', 'HEAD'], repo)
  const ledger = /** @type {any[]} */ ((filedRecord(run) || {}).ledger || [])
  const rec = { ts, kind: 'workflow', name: 'review', round, ledger }
  const name = recordFilename(rec)
  fs.writeFileSync(path.join(store, name), JSON.stringify(rec))
  fs.writeFileSync(path.join(store, 'index.jsonl'), JSON.stringify({ ts, kind: 'workflow', name: 'review', project: repo, branch: 'feat/x', head, round, findingsTotal: ledger.length }) + '\n')
  const prior = findPriorRound({ store, project: repo, branch: 'feat/x' })
  assert.equal(prior.found, true, 'the filed round is found again')
  return { rec, name, prior: JSON.parse(JSON.stringify(prior)) }
}

/** The live row of one binding. @param {any[]} ledger @param {string} name */
const rowOf = (ledger, name) => {
  const rows = ledger.filter(r => r.disposition !== 'closed' && r.title === `Unused lambda pattern: ${name}`)
  assert.equal(rows.length, 1, `one live row for ${name}: ${JSON.stringify(ledger.map(r => r.title))}`)
  return rows[0]
}

test('two deadnix bindings of one file keep their own why and their own birth reference across two rounds', async () => {
  const run1 = await runEngine('review', { args: { languages: ['nix'] }, script: scriptFor(1) })
  const r1 = transported(run1, 1, '2026-10-06T00-00-00Z')
  const run2 = await runEngine('review', { args: { languages: ['nix'] }, script: scriptFor(2, r1.prior) })
  const r2 = transported(run2, 2, '2026-10-07T00-00-00Z')
  const [a, b] = BINDINGS.map(n => rowOf(r1.prior.ledger, n))
  assert.equal(a.fp, b.fp, 'the premise: both bindings share one fingerprint')
  for (const name of BINDINGS) {
    const birth = rowOf(r1.rec.ledger, name)
    assert.equal(birth.why, whyOf(name, 1), `${name} is born with its own full why`)
    for (const row of [rowOf(r1.prior.ledger, name), rowOf(r2.prior.ledger, name)]) {
      assert.ok(row.why.length <= WHY_TRANSPORT_MAX, 'the transport capped the why')
      assert.ok(row.why.startsWith(`${name} r`), `${name} carries its own why, not the other binding's: ${row.why.slice(0, 40)}`)
      assert.deepEqual(row.whyRef, { record: r1.name, fp: birth.fp }, `${name} points at its birth record`)
    }
  }
})
