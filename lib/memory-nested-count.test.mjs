// One audit report, one count of the launcher's records (realm @nick/craft, node #218): the
// audit's `## Memory` line says "plus K passed by the launcher (J new)", K the launcher's records the
// decision reader accepted; the nested review under it says "Y of the M passed by its launcher". M was
// the launcher's records left after the id dedup, broken ones among them, so the two lines named two
// different Ks for the same records. Now M is K and Y is J; and when the audit's recall found none, the
// nested line says "applied Y of the K". And a recalled record that is well formed but
// not active holds its id against a passed copy of it through a whole engine run, not only in lib.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
const P0 = {
  id: 'thread-1',
  title: 'unwrap in parser may panic',
  scope: 'src/parse.rs',
  reason: 'validated upstream',
  who: 'alice',
  when: '2026-10-01',
  link: 'https://x/pr/1#c1',
  commit: 'abc1234',
}
const RECALLED = {
  id: 'decision-f830e51f89',
  kind: 'decision',
  title: 'magic number in config',
  body: 'documented in the spec',
  scope: 'src/config.rs',
  status: 'active',
  date: '2026-09-01',
  author: 'owner',
  commit: 'abc1234',
  links: [],
}

const MEMORY = '\n\n## Memory\n'
/** @param {string} report */
const memoryLineOf = report => (report.includes(MEMORY) ? (report.slice(report.indexOf(MEMORY) + MEMORY.length).split('\n')[0] ?? '') : '')

const AUDIT_SCOUT = {
  baseRef: 'main',
  hasUnsafe: false,
  crates: [
    { name: 'a', path: 'a' },
    { name: 'b', path: 'b' },
  ],
  changedCrates: [
    { name: 'a', path: 'a' },
    { name: 'b', path: 'b' },
  ],
  edges: [],
  repoRoot: '/r',
  notes: 'n',
}
const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }

/**
 * The audit's memory line, and what the audit handed its first nested review. The nested review is the CLI review
 * now (realm @nick/craft, node #150): it takes the recall only as records with `_recalled`, so the split into parts
 * that let the nested line count the audit's K (#218, #244) has no carrier — the audit's line alone counts them.
 * @param {unknown[]} passed @param {unknown[] | object} recalled its decisions, or the recall's whole answer
 */
async function auditAndNested(passed, recalled) {
  const audit = await runEngine('rust-audit', {
    args: { priorDecisions: passed },
    script: {
      scout: AUDIT_SCOUT,
      workflow: () => '## Verdict\n✅ Approve',
      synthesis: 'the audit body',
      'memory-recall': Array.isArray(recalled) ? { backend: 'repo', why: 'w', decisions: recalled } : recalled,
      '*': green,
    },
  })
  /** @type {any} */
  const a = /** @type {any[]} */ (audit.calls.find(c => c.label === 'workflow' && !c.argv?.[1]?.gateOnly)?.argv ?? [])[1]
  return { audit: memoryLineOf(audit.report), forwarded: a }
}

/** What the nested review gets: records and the flag, never the recall's note or split, which cli-review refuses. @param {any} a */
function assertRecordsOnly(a) {
  assert.equal(a._recalled, true)
  assert.ok(Array.isArray(a.priorDecisions))
  for (const k of ['_memory', '_memoryParts', '_externals', '_knownExternals']) assert.ok(!(k in a), `${k} is not forwarded`)
}

test('rust-audit (realm #218): a broken recalled record and passed [P0, junk] — the audit line counts the launcher records, the nested review gets them as records only', async () => {
  const r = await auditAndNested([P0, { id: 'junk' }], [{ id: P0.id }])
  assert.match(r.audit, /^- memory: returned 1 decision\(s\) from repo \(w\); plus 1 passed by the launcher \(1 new\);/)
  assertRecordsOnly(r.forwarded)
})

test('rust-audit (realm #218): a passed copy of a recalled id dropped by the dedup still counts in K — the audit line says so', async () => {
  const r = await auditAndNested([P0, { ...P0, id: RECALLED.id, reason: 'an old reason' }], [RECALLED])
  assert.match(r.audit, /^- memory: returned 1 decision\(s\) from repo \(w\); plus 2 passed by the launcher \(1 new\);/)
  assertRecordsOnly(r.forwarded)
})

// The audit's recall found none, and the store's inactive list held back one of the launcher's two
// records: the audit line says K = 2, the nested review applied 1 — it says which K that 1 is of.
const P1 = { ...P0, id: 'thread-2', title: 'clone in loop is wasteful', scope: 'src/loop.rs', reason: 'loop runs twice' }
const WITHDRAWN = { id: P0.id, kind: 'decision', title: P0.title, scope: P0.scope, status: 'withdrawn' }

test('rust-audit (realm #218): its recall found none and applied ≠ accepted — the nested review gets only what applies', async () => {
  const r = await auditAndNested([P0, P1], { backend: 'mcp', why: 'w', decisions: [], inactive: [WITHDRAWN] })
  assert.match(
    r.audit,
    /^- memory: none — w \(backend mcp\); passed decision #0 \(thread-1\) not applied: withdrawn in memory .*; plus 2 passed by the launcher$/,
  )
  assertRecordsOnly(r.forwarded)
  assert.equal(r.forwarded.priorDecisions.length, 1, 'the withdrawn copy is held back; P1 alone is forwarded')
})
