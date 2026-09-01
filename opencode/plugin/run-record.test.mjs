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
  // Word boundaries: prose containing "block" must NOT register as Block.
  assert.equal(parseVerdict('no blocking issues found'), 'Approve')
  assert.equal(parseVerdict('unblocked the pipeline'), 'Approve')
})

test('parseVerdict never turns a dimension that could not run into an Approve', () => {
  assert.equal(parseVerdict('INCOMPLETE (not run) — cargo-semver-checks is absent'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('verdict: incomplete (not run)'), 'INCOMPLETE (not run)')
  // A real signal still outranks it: partial coverage with findings is not merely "uncovered".
  assert.equal(parseVerdict('Block — UB-found, and the rest is INCOMPLETE'), 'Block')
  assert.equal(parseVerdict('Warning, plus one INCOMPLETE dimension'), 'Warning')
})

test('parseVerdict does not read the bare word "incomplete" in prose as a verdict', () => {
  // This runs over an agent's whole free-text report, where "incomplete" is ordinary English.
  // A false INCOMPLETE on a run that was fine is what trains readers to ignore the marker.
  assert.equal(parseVerdict('Approve — coverage of untested paths is incomplete, but nothing found'), 'Approve')
  assert.equal(parseVerdict('the docs are incomplete'), 'Approve')
  assert.equal(parseVerdict('INCOMPLETE coverage of the feature powerset'), 'Approve')
  // The verdict phrase itself still registers, whitespace-tolerantly.
  assert.equal(parseVerdict('## Verdict\nINCOMPLETE  ( not run ) — nothing was scanned'), 'INCOMPLETE (not run)')
})

test('parseVerdict keeps an unanticipated INCOMPLETE wording out of the green bucket', () => {
  // Six rust-audit dimensions have no agent file — only a prompt string — so the exact phrase is not
  // guaranteed. Anything SHOUTED and used as a verdict must land non-permissively, never on Approve.
  assert.equal(parseVerdict('INCOMPLETE — cargo-hack is not installed'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE (not-run)'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('Verdict: INCOMPLETE, nothing was measured'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('## Verdict\nINCOMPLETE\n\nNo coverage tool is present.'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('| deps | INCOMPLETE |'), 'INCOMPLETE (not run)')
  // ...and the prose sense still does not, in either direction.
  assert.equal(parseVerdict('Approve. INCOMPLETE coverage of the powerset, but every build passed.'), 'Approve')
  assert.equal(parseVerdict('Approve — the docs are incomplete.'), 'Approve')
})

test('parseVerdict reads the prescribed wording with its punctuation dropped', () => {
  // A model told to end with `INCOMPLETE (not run)` that writes `INCOMPLETE not run` has done what
  // it was asked, near enough. Under a bare "not followed by a letter" shape test that is
  // space-then-letter and falls through to Approve — a dimension that ran nothing recorded as a
  // clean pass, the exact failure-reads-as-success direction this whole parser exists to close.
  assert.equal(parseVerdict('INCOMPLETE not run'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE Not run'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE run: no toolchain'), 'INCOMPLETE (not run)')
  // The rest of the closed continuation set: the words a REASON opens with.
  assert.equal(parseVerdict('INCOMPLETE no toolchain available'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE nothing was scanned'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE never ran — no cargo-mutants'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE because cargo-hack is missing'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE since the toolchain is absent'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE due to a missing toolchain'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE cannot run miri here'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE unable to run miri'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE missing cargo-semver-checks'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE absent toolchain'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE unavailable in this environment'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE skipped: no unsafe blocks'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE skip — nothing to measure'), 'INCOMPLETE (not run)')
  // Admitting those continuations must NOT reopen the adjective use.
  assert.equal(parseVerdict('Approve — INCOMPLETE coverage of the feature powerset'), 'Approve')
  assert.equal(parseVerdict('the docs are incomplete'), 'Approve')
  assert.equal(parseVerdict('Approve. Test coverage is incomplete but adequate.'), 'Approve')
  assert.equal(parseVerdict('Approve — INCOMPLETE documentation of the public API'), 'Approve')
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
    // Mirrors sh()'s `$\`bash -lc ${cmd}\`` shape: the command is the sole interpolated value,
    // so reading vals (ignoring the static `bash -lc ` prefix) reconstructs it.
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
