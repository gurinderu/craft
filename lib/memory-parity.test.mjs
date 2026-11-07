// The project memory the Rust CLI applies (cli/crates/craft-review/src/memory/) held to this engine's own by one
// shared file, content/parity/memory-cases.json, which cli/crates/craft-review/src/memory/parity.rs reads too: each
// case is a recall agent's answer, the launcher's priorDecisions, the verified findings and what the scope check saw;
// the scope check named by commit; the expected side is what lib/memory-recall.mjs and lib/prior-decision-apply.mjs make of them with no match judge —
// the findings kept and set aside, the notes, the memory source the run record keeps, and the report's set-aside,
// Memory and not-applied sections. A changed rule fails both sides until the file is regenerated:
// `UPDATE_MEMORY_PARITY=1 npx vitest run lib/memory-parity.test.mjs`.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { memoryRecord, memorySection, mergeRecall, readMemoryRecall } from './memory-recall.mjs'
import { parsePriorDecisions, priorDecisionsRefusedSection } from './prior-decisions.mjs'
import { applyPriorDecisions, priorRejectedSection } from './prior-decision-apply.mjs'

const FILE = new URL('../content/parity/memory-cases.json', import.meta.url)
const C1 = '0123456789abcdef0123456789abcdef01234567'
const C2 = 'fedcba9876543210fedcba9876543210fedcba98'

/** A verified finding. @param {string} severity @param {string} title @param {number} line @param {string} [source] */
const finding = (severity, title, line, source = 'errors') => ({ severity, title, file: 'src/lib.rs', line, why: 'w', source, tier: 'confirmed' })

const CASES = [
  {
    name: 'a recalled decision sets aside its anchored finding, never a High one or one whose scope changed',
    recall: {
      backend: 'repo', why: 'the .craft/memory directory',
      decisions: [
        { id: 'decision-aaaaaaaaaa', kind: 'decision', title: 'unwrap on a checked value', body: 'checked above', scope: 'src/lib.rs', status: 'active', date: '2026-01-02', author: 'nick', commit: C1, line: 10, lens: 'errors', links: ['https://example.com/pr/1#r1'] },
        { id: 'decision-bbbbbbbbbb', kind: 'decision', title: 'slow loop is fine', body: 'cold path', scope: 'src', status: 'active', date: '2026-01-03', author: 'nick', commit: C2, lens: 'performance' },
      ],
      questions: [], rules: [], stale: [{ id: 'decision-cccccccccc', why: 'the guard is gone' }],
    },
    findings: [
      finding('Medium', 'unwrap of a value checked earlier', 11),
      finding('High', 'unwrap of a value checked earlier', 12),
      finding('Low', 'the slow loop is fine here', 40, 'performance'),
      finding('Medium', 'an unrelated defect', 90),
    ],
    unchanged: [C1], missing: [],
  },
  {
    name: 'rejections passed from a PR add to an empty recall, by their derived ids, the title rule matching them',
    recall: { backend: 'none', why: 'no memory configured', decisions: [] },
    passed: [
      { kind: 'decision', title: 'Missing timeout on the client', body: 'the caller sets one', scope: 'src/lib.rs', author: 'rev', date: '2026-02-01', commit: C1, links: ['https://example.com/pr/2#r9'] },
      { kind: 'decision', title: 'Error is swallowed in parse', body: 'logged upstream', scope: 'src', author: 'rev', commit: C2 },
      { kind: 'decision', title: 'no reason here', scope: 'src' },
    ],
    findings: [finding('Medium', 'missing timeout on the HTTP client', 5), finding('Low', 'error swallowed in parse', 7)],
    unchanged: [C1], missing: [C2],
  },
  {
    name: 'a deferred question sets its finding aside as known and deferred; one without a commit, and a plain question, do not',
    recall: {
      backend: 'mcp', why: 'pinned by AGENTS.md',
      decisions: [],
      questions: [
        { id: 'question-1111111111', title: 'retry budget for the fetch', body: 'decide after the load test', scope: 'src/lib.rs', status: 'active', date: '2026-03-01', author: 'nick', commit: C1, deferred: true, line: 20, lens: 'errors' },
        { id: 'question-2222222222', title: 'naming of the module', body: 'open', scope: 'src', status: 'active', deferred: true },
        { id: 'question-3333333333', title: 'should this be async', body: 'open', scope: 'src', status: 'active' },
      ],
      rules: [{ id: 'rule-4444444444', title: 'tests may unwrap', body: 'a test panics on purpose', scope: 'tests', status: 'active' }],
      externals: [{ id: 'external-5555555555', system: 'api', repo: 'https://example.com/api.git', versionFrom: 'Cargo.toml', scope: '.' }],
    },
    findings: [finding('Medium', 'retry budget of fetch is unbounded', 21), finding('Medium', 'naming of the module is off', 3)],
    unchanged: [C1], missing: [],
  },
  {
    name: 'a store id becomes the skill id, a passed copy of it adds nothing, and a superseded record no longer applies',
    recall: {
      backend: 'mcp', why: 'found by capability',
      decisions: [
        { id: 'node-77', kind: 'decision', title: 'Clone in the hot loop', body: 'measured, negligible', scope: 'src/lib.rs', status: 'active', commit: C1, links: ['store: node-77'] },
        { id: 'decision-dddddddddd', kind: 'decision', title: 'Old stance on clones', body: 'superseded', scope: 'src', status: 'active', commit: C1 },
        { id: 'decision-eeeeeeeeee', kind: 'decision', title: 'Newer stance on clones', body: 'replaces it', scope: 'src', status: 'active', commit: C1, links: ['supersedes: decision-dddddddddd'] },
      ],
    },
    passed: [{ kind: 'decision', title: 'Clone in the hot loop', body: 'measured', scope: 'src/lib.rs', commit: C1 }],
    findings: [finding('Low', 'clone in the hot loop', 30), finding('Low', 'old stance on clones holds', 31)],
    unchanged: [], missing: [],
  },
  {
    name: 'a recall that died applies the launcher list alone, each malformed record refused by name',
    recall: null,
    passed: [
      { id: 'decision-ffffffffff', kind: 'decision', title: 'Panics on empty input', reason: 'never empty', scope: 'src/lib.rs', status: 'withdrawn' },
      { id: 'lesson-0000000000', title: 'a lesson', reason: 'r', scope: 'src' },
      { id: 'decision-9999999999', title: 'Escapes the repo', reason: 'r', scope: '../etc' },
      { id: 'decision-8888888888', title: 'Bad commit', reason: 'r', scope: 'src', commit: 'not-a-hash' },
      { id: 'decision-7777777777', title: 'Line is a word', reason: 'r', scope: 'src', line: 'ten' },
      { id: 'decision-6666666666', title: 'Panics on empty input', reason: 'never empty', scope: 'src/lib.rs', who: 'nick', when: '2026-04-01' },
      { id: 'decision-6666666666', title: 'Twice', reason: 'r', scope: 'src' },
      'not an object',
    ],
    findings: [finding('Medium', 'panics on empty input', 2)],
    unchanged: [], missing: [],
  },
  {
    name: 'a launcher list given as a string is refused whole',
    recall: { backend: 'repo', why: 'the .craft/memory directory', decisions: [] },
    passed: 'priorDecisions=[{"id":"x"}]',
    findings: [finding('Medium', 'anything', 1)],
    unchanged: [], missing: [],
  },
  {
    name: 'a passed copy of a record the store withdrew is held back unless it is dated later',
    recall: {
      backend: 'repo', why: 'the .craft/memory directory', decisions: [],
      inactive: [
        { id: 'decision-1111111111', kind: 'decision', title: 'old', scope: 'src', status: 'withdrawn', date: '2026-03-01' },
        { id: 'decision-2222222222', kind: 'decision', title: 'older', scope: 'src', status: 'superseded', date: '2026-03-01T12:00:00+02:00' },
      ],
    },
    passed: [
      { id: 'decision-1111111111', kind: 'decision', title: 'Unwrap on parse', body: 'checked', scope: 'src/lib.rs', date: '2026-02-01', commit: C1 },
      { id: 'decision-2222222222', kind: 'decision', title: 'Clone of the buffer', body: 'cheap', scope: 'src/lib.rs', date: '2026-03-01T11:00:00Z', commit: C1 },
      { id: 'decision-6666666666', kind: 'decision', title: 'No date here', body: 'r', scope: 'src', commit: C1, links: ['store: decision-1111111111'] },
    ],
    findings: [finding('Medium', 'unwrap on parse', 4), finding('Medium', 'clone of the buffer', 6)],
    unchanged: [C1], missing: [],
  },
  {
    name: 'a newer PR rejection overrides the recalled successor that superseded it; an older one is held by it',
    recall: {
      backend: 'mcp', why: 'found by capability',
      decisions: [
        { id: 'decision-3333333333', kind: 'decision', title: 'Timeouts are the caller\'s', body: 'a stance', scope: 'src', status: 'active', date: '2026-01-10', commit: C1, links: ['supersedes: decision-4444444444', 'answers: decision-5555555555'] },
      ],
    },
    passed: [
      { id: 'decision-4444444444', kind: 'decision', title: 'Missing timeout on fetch', body: 'rejected on the PR', scope: 'src/lib.rs', author: 'rev', date: '2026-02-01', commit: C1, line: 8, lens: 'errors' },
      { id: 'decision-5555555555', kind: 'decision', title: 'Retry without backoff', body: 'older', scope: 'src/lib.rs', date: '2026-01-01', commit: C1 },
    ],
    findings: [finding('Medium', 'missing timeout on the fetch', 9), finding('Medium', 'retry without backoff', 20)],
    unchanged: [C1], missing: [],
  },
]

/**
 * What the scope check sees for the records it is handed: a case names the commits whose scope is unchanged and those
 * the repository lacks. @param {{ unchanged: string[], missing: string[] }} c @param {Array<{ id: string, commit: string }>} toCheck
 */
const scopeSeen = (c, toCheck) => ({
  unchanged: toCheck.filter(d => c.unchanged.includes(d.commit)).map(d => d.id),
  missing: toCheck.filter(d => c.missing.includes(d.commit)).map(d => d.id),
  reason: '',
})

/** What this engine makes of case `c`. @param {typeof CASES[number]} c */
async function expected(c) {
  const r = readMemoryRecall(c.recall, 0)
  const m = mergeRecall(r, c.passed, parsePriorDecisions)
  const applied = await applyPriorDecisions({ confirmed: c.findings }, m.prior.decisions, async toCheck => scopeSeen(c, toCheck))
  const refused = [...m.prior.refused, ...applied.refused]
  return {
    kept: (applied.tiers['confirmed'] ?? []).map(f => ({ title: f.title, why: f.why })),
    setAside: applied.setAside.map(f => ({ title: f.title, why: f.why, priorTier: f.priorTier, priorDecision: f.priorDecision, priorKind: f.priorKind, priorMatch: f.priorMatch })),
    notes: applied.notes,
    memory: memoryRecord(m.memory),
    report: `${priorRejectedSection(applied.setAside)}${memorySection(m.memory)}${priorDecisionsRefusedSection(refused)}`,
  }
}

test('the memory the CLI is held to is the one this engine applies', async () => {
  const cases = []
  for (const c of CASES) cases.push({ ...c, expected: await expected(c) })
  if (process.env['UPDATE_MEMORY_PARITY']) writeFileSync(FILE, `${JSON.stringify({ cases }, null, 2)}\n`)
  const file = JSON.parse(readFileSync(FILE, 'utf8'))
  assert.deepEqual(file.cases, JSON.parse(JSON.stringify(cases)), 'regenerate with UPDATE_MEMORY_PARITY=1 after a rule change')
})
