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

test('parseVerdict reads the structured VERDICT: line, last one wins', () => {
  assert.equal(parseVerdict('Nothing found.\n\nVERDICT: APPROVE'), 'Approve')
  assert.equal(parseVerdict('Some notes.\n\nVERDICT: WARNING'), 'Warning')
  assert.equal(parseVerdict('UB everywhere.\n\nVERDICT: BLOCK'), 'Block')
  assert.equal(parseVerdict('cargo-hack absent.\n\nVERDICT: INCOMPLETE'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('**VERDICT: BLOCK**'), 'Block')
  assert.equal(parseVerdict('verdict: block'), 'Block')
  // The last one is the agent's own; an earlier one is a quoted example.
  assert.equal(parseVerdict('Example: `VERDICT: INCOMPLETE` if tooling is absent.\n\nVERDICT: APPROVE'), 'Approve')
  // Structured beats free-text keywords anywhere above it.
  assert.equal(parseVerdict('At-risk in places, blocking nothing.\n\nVERDICT: WARNING'), 'Warning')
})

test('parseVerdict does not fire on an agent quoting its own instruction (failure A)', () => {
  // Every dimension prompt plants the literal `INCOMPLETE (not run)` in the model's context. An
  // unanchored whole-text match turned a clean run that MENTIONED the instruction into a not-run.
  assert.equal(parseVerdict(
    'I was instructed to report INCOMPLETE (not run) if the toolchain is absent.\n' +
    'cargo-audit was present and ran cleanly.\n\nVerdict: Approve',
  ), 'Approve')
  assert.equal(parseVerdict(
    'I was instructed to report INCOMPLETE (not run) if absent. It ran cleanly.\n\nVERDICT: APPROVE',
  ), 'Approve')
})

test('parseVerdict does not read an emphasised prose adjective as a verdict (failure B)', () => {
  assert.equal(parseVerdict('The doc coverage here is INCOMPLETE.\n\nVerdict: Approve'), 'Approve')
  assert.equal(parseVerdict('Test coverage is **INCOMPLETE** in two modules...\n\nVerdict: Approve'), 'Approve')
  // A stated verdict outranks a table cell mentioning the token for one dimension.
  assert.equal(parseVerdict('| doc coverage | INCOMPLETE |\n\nVerdict: Approve'), 'Approve')
})

test('parseVerdict keeps unanticipated INCOMPLETE wordings out of Approve (failure C)', () => {
  assert.equal(parseVerdict('INCOMPLETE could not run'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE verdict (no toolchain)'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE status — sandbox has no network'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE result: cargo-deny is not installed'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE analysis: tool missing'), 'INCOMPLETE (not run)')
  assert.equal(parseVerdict('INCOMPLETE report: cargo not present'), 'INCOMPLETE (not run)')
})

test('buildAuditRecord rolls the top-level verdict up worst-wins over the dimensions', () => {
  // The synthesis text alone is not trusted: a real dimension table nearly always contains the word
  // "Warning" somewhere, which is what made the top-level INCOMPLETE marker unreachable.
  const rec = buildAuditRecord({
    results: [
      { label: 'security', ok: true, text: 'VERDICT: APPROVE' },
      { label: 'semver', ok: true, text: 'cargo-semver-checks absent.\n\nVERDICT: INCOMPLETE' },
    ],
    baseRef: 'main', hasUnsafe: false, synthesisText: 'All good.\n\nVERDICT: APPROVE',
  })
  assert.equal(rec.verdict, 'INCOMPLETE (not run)')
  assert.deepEqual(rec.incomplete, ['semver'])
  assert.deepEqual(rec.notRun, [])
  // A worse dimension still wins, and the incomplete one stays visible despite the collapse.
  const rec2 = buildAuditRecord({
    results: [
      { label: 'review', ok: true, text: 'VERDICT: BLOCK' },
      { label: 'deps', ok: true, text: 'VERDICT: INCOMPLETE' },
    ],
    baseRef: '', hasUnsafe: false, synthesisText: 'VERDICT: WARNING',
  })
  assert.equal(rec2.verdict, 'Block (INCOMPLETE)')
  assert.deepEqual(rec2.incomplete, ['deps'])
})

test('buildAuditRecord suffixes the verdict so partial coverage survives worst-wins', () => {
  // worstOf ranks INCOMPLETE below Warning, so a partial run collapsed to the bare token "Warning"
  // and lib/analyze-runs.mjs — which counts partial coverage with /INCOMPLETE/i over the verdict
  // string — scored it as fully covered. The suffix is the shape that file already understands.
  const warned = buildAuditRecord({
    results: [
      { label: 'review', ok: true, text: 'VERDICT: WARNING' },
      { label: 'deps', ok: true, text: 'VERDICT: INCOMPLETE' },
    ],
    baseRef: 'main', hasUnsafe: false, synthesisText: 'VERDICT: WARNING',
  })
  assert.equal(warned.verdict, 'Warning (INCOMPLETE)')
  assert.deepEqual(warned.incomplete, ['deps'])
  // A dimension whose session never returned is partial coverage too, even though `incomplete` —
  // which is about dimensions that RAN — cannot carry it.
  const crashed = buildAuditRecord({
    results: [
      { label: 'review', ok: true, text: 'VERDICT: WARNING' },
      { label: 'miri', ok: false, text: '' },
    ],
    baseRef: 'main', hasUnsafe: true, synthesisText: 'VERDICT: WARNING',
  })
  assert.equal(crashed.verdict, 'Warning (INCOMPLETE)')
  assert.deepEqual(crashed.incomplete, [])
  assert.deepEqual(crashed.notRun, ['miri'])
  // Full coverage is never suffixed, and an all-incomplete roll-up keeps its own single token
  // rather than growing a second one.
  const clean = buildAuditRecord({
    results: [{ label: 'review', ok: true, text: 'VERDICT: APPROVE' }],
    baseRef: 'main', hasUnsafe: false, synthesisText: 'VERDICT: APPROVE',
  })
  assert.equal(clean.verdict, 'Approve')
  const nothing = buildAuditRecord({
    results: [{ label: 'deps', ok: true, text: 'VERDICT: INCOMPLETE' }],
    baseRef: 'main', hasUnsafe: false, synthesisText: 'VERDICT: APPROVE',
  })
  assert.equal(nothing.verdict, 'INCOMPLETE (not run)')
})

test('the structured VERDICT line is authoritative only in the mandated uppercase', () => {
  // Case-insensitivity made an ordinary prose closing line structural, so it outranked the evidence
  // it contradicts — the exact inversion the fallback below was built to prevent.
  assert.equal(parseVerdict('Critical: UB. Block.\n\nVerdict: Approve'), 'Block')
  assert.equal(parseVerdict('Critical: UB. Block.\n\nverdict: approve'), 'Block')
  assert.equal(parseVerdict('Concerns noted.\n\nVerdict: Approve'), 'Warning')
  // With nothing to contradict it, a prose line still reads as Approve — via the fallback.
  assert.equal(parseVerdict('Nothing found.\n\nVerdict: Approve'), 'Approve')
  // The mandated form stays authoritative and still outranks contradicting evidence.
  assert.equal(parseVerdict('## Verdict\nBlock — bad\n\nVERDICT: APPROVE'), 'Approve')
  assert.equal(parseVerdict('looks fine\n\nVERDICT: BLOCK'), 'Block')
  // A mixed-case token is not the mandated form: it falls through to be weighed, not obeyed.
  assert.equal(parseVerdict('Critical: UB. Block.\n\nVERDICT: Approve'), 'Block')
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
  // Warning from synthesisText, suffixed because `architecture` never ran.
  assert.equal(rec.verdict, 'Warning (INCOMPLETE)')
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

test('a run that was never consolidated is not filed as Approve', () => {
  // The text fix was real but text-only: the fallback report EMBEDS the dimension blob, so
  // parseVerdict picked up the last dimension's VERDICT line and filed an Approve for a run nobody
  // consolidated. The human saw INCOMPLETE and index.jsonl saw Approve for the same run — worse
  // than either alone, since only the store is machine-read afterwards.
  const results = [
    { label: 'review', ok: true, text: 'nothing found\n\nVERDICT: APPROVE' },
    { label: 'tests-cov', ok: true, text: 'coverage fine\n\nVERDICT: APPROVE' },
  ]
  const fallback = '## ⚠️ INCOMPLETE (not run) — the audit was not consolidated\n\n' +
    results.map(r => `### ${r.label}\n\n${r.text}`).join('\n\n')

  const died = buildAuditRecord({ results, baseRef: 'main', hasUnsafe: false, synthesisText: fallback, synthesized: false })
  assert.match(died.verdict, /INCOMPLETE/, 'a run that was not consolidated cannot be an Approve')

  // And the ordinary path is unaffected: a real synthesis still decides with the dimensions.
  const lived = buildAuditRecord({
    results, baseRef: 'main', hasUnsafe: false,
    synthesisText: 'all clear\n\nVERDICT: APPROVE', synthesized: true,
  })
  assert.equal(lived.verdict, 'Approve')
})

test('the default keeps every existing caller honest', () => {
  // `synthesized` defaults to true, so a caller that does not pass it behaves exactly as before —
  // the flag adds a way to say "this never ran", it does not quietly change what the others mean.
  const results = [{ label: 'review', ok: true, text: 'VERDICT: WARNING' }]
  const r = buildAuditRecord({ results, baseRef: '', hasUnsafe: false, synthesisText: 'VERDICT: WARNING' })
  assert.equal(r.verdict, 'Warning')
})
