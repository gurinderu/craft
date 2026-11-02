// A real engine filing a record past 100 KB (realm @nick/craft, node #396), run through the harness: the
// record goes down in parts, no logger call carries more than ~20 KB of it, and what finalize puts back is
// the record the engine would have sent whole. The case is the one #245 left open: a ledger shard that did
// not land, so the record carries the whole ledger.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord, sentRecord } from './engine-harness.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const FINDINGS = Array.from({ length: 150 }, (_, i) => ({
  severity: 'Medium', title: `t${i}`, file: 'src/lib.rs', line: i + 1, why: `${i} `.padEnd(600, 'w'), fix: 'fix it',
  blastRadius: '', source: 'safety', ruleId: 'ERR-001', symbol: `g${i}`, whereChecked: '',
}))
const RUN_DIR = '/store/.partial/run-A'

const MISS = 'craft-log-run TRANSCRIPT-MISS 0 agent transcripts under /h/projects carry craft-0000000000000000'

// A first review whose one lens returns FINDINGS and whose second ledger shard does not land; `parts` says
// whether the record's own parts do, `transcript` whether the logger's transcript read (step 1, the only
// step of a prompt with no heredoc) finds the record (realm @nick/craft, node #429).
/** @param {boolean} parts @param {boolean} [transcript] */
const scriptWith = (parts, transcript = false) => ({
  detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: (/** @type {{ opts: { label?: string } }} */ { opts }) => {
    const label = String(opts.label)
    return label === 'checkpoint:ledger-02' || (!parts && label.startsWith('checkpoint:record-')) ? null : { runDir: RUN_DIR, error: '' }
  },

  scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: (/** @type {{ callIndex: number }} */ { callIndex }) => ({ lens: 'safety', findings: callIndex === 0 ? FINDINGS : [] }),
  dedup: { groups: [] },
  verify: () => UPHELD,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
  synthesis: null,
  // The logger under any of its labels, `log-run (NKB)` included; every other unscripted agent is dead.
  '*': (/** @type {{ prompt: string, opts: { label?: string } }} */ { prompt, opts }) => {
    if (!/^log-run/.test(String(opts.label))) return null
    return transcript || prompt.includes('CRAFT_RECORD_EOF') ? { ok: true, output: ['wrote r.json'] } : { ok: false, output: [MISS], error: MISS }
  },
})

/** @param {string} prompt */
const payloadBytes = prompt => (/\n(?:RECORD|PAYLOAD):\s*\n([\s\S]+)$/.exec(prompt)?.[1] ?? '').length

test('review: a record past 100 KB is filed in parts of ~16 KB and put back as the whole record', async () => {
  const parted = await runEngine('review', { args: {}, script: scriptWith(true) })
  const whole = await runEngine('review', { args: {}, script: scriptWith(false) })
  const sent = sentRecord(whole)
  const size = JSON.stringify(sent, null, 2).length
  assert.ok(size > 100 * 1024, `the whole record is ${size} bytes`)
  const parts = parted.calls.filter(c => c.label.startsWith('checkpoint:record-'))
  assert.ok(parts.length >= 7, `${parts.length} part(s)`)
  assert.ok(parts.every(c => c.prompt.includes(`--dir '${RUN_DIR}'`)), 'into the run\'s own directory')
  // Of the calls that offer the heredoc: the first, transcript-only call carries the record but asks no copy.
  const largest = Math.max(...parted.calls.filter(c => /^checkpoint:record-|^log-run/.test(c.label) && c.prompt.includes('CRAFT_RECORD_EOF')).map(c => payloadBytes(c.prompt)))
  assert.ok(largest <= 20 * 1024, `the largest payload one record call asks to copy is ${largest} bytes`)
  const fin = parted.calls.filter(c => /^log-run/.test(c.label))
  assert.deepEqual(fin.map(c => c.label.replace(/\d+KB/, 'NKB')), ['log-run (NKB)', 'log-run'])
  assert.doesNotMatch(String(fin[0]?.prompt), /CRAFT_RECORD_EOF/, 'the transcript call offers no heredoc')
  fin.shift()
  assert.match(String(fin[0]?.prompt), new RegExp(`node "\\$CRAFT_LOGGER" finalize .*--dir '${RUN_DIR}' `))
  assert.ok(payloadBytes(String(fin[0]?.prompt)) < 4096, 'the final call carries a header, not the record')
  assert.deepEqual(filedRecord(parted), sent)
})

test('review: with no record part landed the record goes whole in one call, as before', async () => {
  const whole = await runEngine('review', { args: {}, script: scriptWith(false) })
  const fin = whole.calls.filter(c => /^log-run/.test(c.label))
  assert.match(String(fin[0]?.label), /^log-run \(\d+KB\)$/)
  assert.ok(payloadBytes(String(fin[0]?.prompt)) > 100 * 1024)
  assert.equal(sentRecord(whole).ledger.length, FINDINGS.length)
  assert.ok(whole.logs.some(l => /telemetry lost: record part 'record-01'/.test(l)), whole.logs.join('\n'))
  // A logger that is dead for two parts in a row is not asked for the rest.
  assert.deepEqual([...new Set(whole.calls.filter(c => /^checkpoint:record-/.test(c.label)).map(c => c.label))], ['checkpoint:record-01', 'checkpoint:record-02'])
})

test('review: a record past 100 KB the logger reads from its own transcript is filed by ONE call, no parts', async () => {
  const run = await runEngine('review', { args: {}, script: scriptWith(true, true) })
  const fin = run.calls.filter(c => /^log-run/.test(c.label))
  assert.equal(fin.length, 1)
  assert.match(String(fin[0]?.label), /^log-run \(\d+KB\)$/)
  assert.equal(fin[0]?.opts?.model, 'haiku', 'the model copies nothing, so the cheap one carries any size')
  assert.match(String(fin[0]?.prompt), /--from-transcript craft-[0-9a-f]{16}\n/)
  assert.doesNotMatch(String(fin[0]?.prompt), /CRAFT_RECORD_EOF/)
  assert.deepEqual(run.calls.filter(c => /^checkpoint:record-/.test(c.label)), [])
  assert.equal(sentRecord(run).ledger.length, FINDINGS.length)
  assert.deepEqual(filedRecord(run), sentRecord(run))
})
