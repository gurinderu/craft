// One audit report, one count of the launcher's records (realm @nick/craft, node #218): the
// audit's `## Memory` line says "plus K passed by the launcher (J new)", K the launcher's records the
// decision reader accepted; the nested review under it says "Y of the M passed by its launcher". M was
// the launcher's records left after the id dedup, broken ones among them, so the two lines named two
// different Ks for the same records. Now M is K and Y is J; and when the audit's recall found none, the
// nested line says "applied Y of the K". And a recalled record that is well formed but
// not active holds its id against a passed copy of it through a whole engine run, not only in lib.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, judgeAllSame } from './engine-harness.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
/** @param {string} title @param {string} file */
const finding = (title, file) => ({
  severity: 'Medium', title, file, line: 12, why: 'w', fix: 'f', blastRadius: '', source: 'safety', ruleId: 'ERR-001', symbol: 's', whereChecked: '',
})
const P0 = { id: 'thread-1', title: 'unwrap in parser may panic', scope: 'src/parse.rs', reason: 'validated upstream', who: 'alice', when: '2026-10-01', link: 'https://x/pr/1#c1', commit: 'abc1234' }
const RECALLED = { id: 'decision-f830e51f89', kind: 'decision', title: 'magic number in config', body: 'documented in the spec', scope: 'src/config.rs', status: 'active', date: '2026-09-01', author: 'owner', commit: 'abc1234', links: [] }
const FINDINGS = [finding(P0.title, 'src/parse.rs'), finding(RECALLED.title, 'src/config.rs')]

/** @param {unknown} recall */
const reviewScript = recall => ({
  detect: { baseRef: 'main', files: ['src/parse.rs', 'src/config.rs'], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: (/** @type {{ callIndex: number }} */ { callIndex }) => ({ lens: 'safety', findings: callIndex === 0 ? FINDINGS : [] }),
  dedup: { groups: [] },
  verify: () => UPHELD,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
  'decision-scope': (/** @type {{ prompt: string }} */ { prompt }) => ({ unchanged: [...prompt.matchAll(/echo '([^']+)' \$\?/g)].map(m => m[1]), reason: '' }),
  'decision-match': judgeAllSame,
  'memory-recall': recall,
  synthesis: null,
  '*': null,
})

const MEMORY = '\n\n## Memory\n'
/** @param {string} report */
const memoryLineOf = report => (report.includes(MEMORY) ? (report.slice(report.indexOf(MEMORY) + MEMORY.length).split('\n')[0] ?? '') : '')
/** @param {string} report */
const rejectedBefore = report => [...report.matchAll(/REJECTED BEFORE: ([^—]+) —/g)].map(m => String(m[1]).trim()).sort()

const AUDIT_SCOUT = { baseRef: 'main', hasUnsafe: false, crates: [{ name: 'a', path: 'a' }, { name: 'b', path: 'b' }], changedCrates: [{ name: 'a', path: 'a' }, { name: 'b', path: 'b' }], edges: [], repoRoot: '/r', notes: 'n' }
const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }

/**
 * The audit's memory line, and the memory line of a review run with exactly what the audit handed its
 * first nested review. @param {unknown[]} passed @param {unknown[] | object} recalled its decisions, or the recall's whole answer
 */
async function auditAndNested(passed, recalled) {
  const audit = await runEngine('rust-audit', { args: { priorDecisions: passed }, script: {
    scout: AUDIT_SCOUT, workflow: () => '## Verdict\n✅ Approve', synthesis: 'the audit body', 'memory-recall': Array.isArray(recalled) ? { backend: 'repo', why: 'w', decisions: recalled } : recalled, '*': green,
  } })
  /** @type {any} */
  const a = /** @type {any[]} */ (audit.calls.find(c => c.label === 'workflow')?.argv ?? [])[1]
  const nested = await runEngine('review', { args: { priorDecisions: a.priorDecisions, _recalled: a._recalled, _memory: a._memory, _memoryParts: a._memoryParts }, script: reviewScript({ backend: 'x', why: 'y', decisions: [] }) })
  const k = memoryLineOf(audit.report).match(/plus (\d+) passed by the launcher \((\d+) new\)/)
  const m = memoryLineOf(nested.report).match(/(\d+) of the (\d+) passed by its launcher/)
  return { audit: memoryLineOf(audit.report), nested: memoryLineOf(nested.report), auditKJ: [k?.[2], k?.[1]], nestedYM: [m?.[1], m?.[2]] }
}

test('rust-audit (realm #218): a broken recalled record and passed [P0, junk] — the audit line and the nested line count the same launcher records', async () => {
  const r = await auditAndNested([P0, { id: 'junk' }], [{ id: P0.id }])
  assert.match(r.audit, /^- memory: returned 1 decision\(s\) from repo \(w\); plus 1 passed by the launcher \(1 new\);/)
  assert.equal(r.nested, '- memory: recalled by the launching audit — applied 1 decision(s) — 0 recalled, 1 of the 1 passed by its launcher')
  assert.deepEqual(r.nestedYM, r.auditKJ, 'Y of the M in the nested line is J of K in the audit line')
})

test('rust-audit (realm #218): a passed copy of a recalled id dropped by the dedup still counts in K — both lines say so', async () => {
  const r = await auditAndNested([P0, { ...P0, id: RECALLED.id, reason: 'an old reason' }], [RECALLED])
  assert.match(r.audit, /^- memory: returned 1 decision\(s\) from repo \(w\); plus 2 passed by the launcher \(1 new\);/)
  assert.equal(r.nested, '- memory: recalled by the launching audit — applied 2 decision(s) — 1 recalled, 1 of the 2 passed by its launcher')
  assert.deepEqual(r.nestedYM, r.auditKJ)
})

// The stale passed copy of a record the store superseded, and the superseded record itself, both by one id.
const SUPERSEDED = { ...RECALLED, status: 'superseded' }
const STALE_COPY = { ...P0, id: RECALLED.id, title: RECALLED.title, scope: RECALLED.scope, reason: 'a stale reason from a thread' }
const NOT_ACTIVE = `recalled decision #0 (${RECALLED.id}) is not active (status "superseded")`

test('review (realm #218): a valid inactive recalled record holds its id — the passed copy is dropped, the inactive one refuses itself, nothing resurrected', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [STALE_COPY, P0] }, script: reviewScript({ backend: 'repo', why: 'w', decisions: [SUPERSEDED] }) })
  assert.deepEqual(rejectedBefore(run.report), ['validated upstream'], 'only P0 applies; the superseded decision answers nothing')
  assert.doesNotMatch(run.report, /a stale reason from a thread|documented in the spec/)
  assert.ok(run.report.includes(`## Prior decisions not applied\n- ⚠️ ${NOT_ACTIVE}\n`), 'the inactive record refuses itself, by name')
  assert.equal(memoryLineOf(run.report), '- memory: recalled 0 decision(s) from repo (w); plus 2 passed by the launcher (1 new)')
})

test('adversarial-review (realm #218): the same — the inactive recalled record holds its id against the passed copy', async () => {
  const run = await runEngine('adversarial-review', { args: { priorDecisions: [STALE_COPY] }, script: {
    scout: { baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: ['src/config.rs'], notes: 'x' },
    'index-warmup': { indexed: false, notes: 'x' },
    review: { findings: [{ title: RECALLED.title, file: 'src/config.rs', line: 4, severity: 'medium', description: 'd', fix: 'f', whereChecked: '' }] },
    'coverage-critic': { findings: [] },
    'decision-scope': { unchanged: [RECALLED.id], reason: '' },
    'decision-match': judgeAllSame,
    'log-run': { ok: true },
    'memory-recall': { backend: 'repo', why: 'w', decisions: [SUPERSEDED] },
    '*': (/** @type {{ opts: { label?: string } }} */ { opts }) => (/^verify/.test(String(opts.label)) ? { refuted: false, premiseSupported: true, reasoning: 'ok', severity: 'medium' } : null),
  } })
  const v = run.reportValue
  assert.equal(v.rejectedBefore, undefined, 'nothing rejected before')
  assert.deepEqual(v.confirmed.map((/** @type {{ title: string }} */ f) => f.title), [RECALLED.title], 'the finding the stale copy would answer is raised normally')
  assert.deepEqual(v.priorDecisionsNotApplied, [NOT_ACTIVE])
  assert.deepEqual(v.memory, { source: 'recalled', count: 0, why: 'repo (w)', passed: 1, added: 0 })
})

// The audit's recall found none, and the store's inactive list held back one of the launcher's two
// records: the audit line says K = 2, the nested review applied 1 — it says which K that 1 is of.
const P1 = { ...P0, id: 'thread-2', title: 'clone in loop is wasteful', scope: 'src/loop.rs', reason: 'loop runs twice' }
const WITHDRAWN = { id: P0.id, kind: 'decision', title: P0.title, scope: P0.scope, status: 'withdrawn' }

test('rust-audit (realm #218): its recall found none and applied ≠ accepted — the nested line says applied Y of the audit\'s K', async () => {
  const r = await auditAndNested([P0, P1], { backend: 'mcp', why: 'w', decisions: [], inactive: [WITHDRAWN] })
  assert.match(r.audit, /^- memory: none — w \(backend mcp\); passed decision #0 \(thread-1\) not applied: withdrawn in memory .*; plus 2 passed by the launcher$/)
  assert.equal(r.nested, '- memory: recalled by the launching audit — none (w (backend mcp)); applied 1 of the 2 passed by its launcher')
})
