import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseVerdict, buildAuditRecord, buildTriageRecord, indexProjection, writeRecord,
} from './run-record.mjs'

test('parseVerdict picks the worst signal in the text', () => {
  assert.equal(parseVerdict('all good, Approve'), 'Approve')
  assert.equal(parseVerdict('some Warning here'), 'Warning')
  assert.equal(parseVerdict('Concerns about layering'), 'Warning')
  assert.equal(parseVerdict('⛔ Block — must fix'), 'Block')
  assert.equal(parseVerdict('At-risk structure'), 'Block')
  assert.equal(parseVerdict('Miri: UB-found'), 'Block')
  assert.equal(parseVerdict(''), 'Approve')
})

test('buildAuditRecord assembles dimensions, notRun, and a null findings field', () => {
  const rec = buildAuditRecord({
    results: [
      { label: 'security', ok: true, text: 'Approve — clean' },
      { label: 'architecture', ok: false, text: '' },
    ],
    baseRef: 'main', hasUnsafe: false, synthesisText: 'overall verdict: Warning',
  })
  assert.equal(rec.schemaVersion, 1)
  assert.equal(rec.runtime, 'opencode')
  assert.equal(rec.kind, 'workflow')
  assert.equal(rec.name, 'rust-audit')
  assert.equal(rec.verdict, 'Warning')           // parsed from synthesisText
  assert.equal(rec.findings, null)
  assert.equal(rec.nested, false)
  assert.equal(rec.via, null)
  assert.deepEqual(rec.scout, { baseRef: 'main', hasUnsafe: false })
  assert.deepEqual(rec.dimensions, [
    { dimension: 'security', ran: true, verdict: 'Approve' },
    { dimension: 'architecture', ran: false, verdict: '' },
  ])
  assert.deepEqual(rec.notRun, ['architecture'])
})

test('buildTriageRecord uses an empty verdict and per-finding dimensions', () => {
  const rec = buildTriageRecord({
    results: [
      { label: 'f1', ok: true, text: 'OUTCOME: accept' },
      { label: 'f2', ok: false, text: '' },
    ],
  })
  assert.equal(rec.runtime, 'opencode')
  assert.equal(rec.name, 'triage-findings')
  assert.equal(rec.verdict, '')
  assert.equal(rec.findings, null)
  assert.deepEqual(rec.dimensions, [
    { dimension: 'f1', ran: true },
    { dimension: 'f2', ran: false },
  ])
  assert.deepEqual(rec.notRun, ['f2'])
})

test('indexProjection carries runtime and nulls findingsTotal when findings is null', () => {
  const rec = {
    schemaVersion: 1, runtime: 'opencode', ts: 'T', kind: 'workflow', name: 'rust-audit',
    project: '/p', commit: 'abc', dirty: true, verdict: 'Approve', findings: null,
    nested: false, via: null, dimensions: [{ dimension: 'x' }],
  }
  assert.deepEqual(indexProjection(rec), {
    schemaVersion: 1, runtime: 'opencode', ts: 'T', kind: 'workflow', name: 'rust-audit',
    project: '/p', commit: 'abc', dirty: true, verdict: 'Approve', findingsTotal: null,
    nested: false, via: null,
  })
})

test('writeRecord writes a detail file and appends one index line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'craft-obs-'))
  process.env.CRAFT_RUNS_DIR = dir
  // Fake PluginCtx: $ is a tagged-template returning a .quiet() that yields canned git output.
  const ctx = {
    worktree: '/proj',
    directory: '/proj',
    $: (_strings, ...vals) => ({
      quiet: async () => {
        const cmd = vals.join('')
        if (cmd.includes('rev-parse')) return { stdout: 'abc1234\n' }
        return { stdout: '' } // status --porcelain → clean
      },
    }),
  }
  try {
    await writeRecord(ctx, buildAuditRecord({
      results: [{ label: 'security', ok: true, text: 'Approve' }],
      baseRef: 'main', hasUnsafe: false, synthesisText: 'Approve',
    }))
    const lines = readFileSync(join(dir, 'index.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const line = JSON.parse(lines[0])
    assert.equal(line.runtime, 'opencode')
    assert.equal(line.kind, 'workflow')
    assert.equal(line.name, 'rust-audit')
    assert.equal(line.project, '/proj')
    assert.equal(line.commit, 'abc1234')
    assert.equal(line.dirty, false)
    assert.equal(line.findingsTotal, null)
    assert.match(line.ts, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/)
    const detail = readdirSync(dir).filter((f) => f.endsWith('.json'))
    assert.equal(detail.length, 1)
  } finally {
    delete process.env.CRAFT_RUNS_DIR
  }
})
