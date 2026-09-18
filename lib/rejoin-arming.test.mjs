// The rejoin flag says ONE thing to the CLI — "this run's `runDir` may have been adopted, so do not
// treat it as proof of ownership" — and for that it has to be armed by the condition that makes it
// true. The engine arms a checkpoint's `--rejoin` as `!runDir && checkpointFailed` (a run with no
// directory at all, after one of its own checkpoints failed: the only case where adopting is even
// possible), but finalized with the coarser `checkpointFailed`. A long review whose FIRST checkpoint
// minted the directory and whose THIRD failed therefore declared an adoption that never happened.
//
// The cost is not cosmetic. With the flag set, `finalizeRun` drops the `ownDir` shortcut — the one
// that exists so a working copy moving mid-review (ordinary across hours of reviewing) does not cost
// the run its own phases — and the run's own directory is kept instead of folded: a warning, no
// merge, telemetry split. `recover` promotes it later, so it is not corruption; it is a regression of
// the ordinary long-review case, which is precisely the case nobody watches.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runEngine } from './engine-harness.mjs'
import { checkpointDir, writeCheckpoint, finalizeRun } from './craft-log-run.mjs'

const RUN_DIR = '/store/.partial/2026-09-18T10-00-00Z-workflow-review'

test('a LATE checkpoint failure does not make the engine claim an adoption it never made', async () => {
  // The first checkpoint mints the directory; a later one dies. Nothing was ever adopted.
  let seen = 0
  const run = await runEngine('review', {
    script: {
      detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
      'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
      checkpoint: () => (seen++ === 0 ? { runDir: RUN_DIR, error: '' } : null),
      'log-run': { ok: true, error: '' },
      '*': null,
    },
  })
  const checkpoints = run.calls.filter(c => c.key === 'checkpoint')
  assert.ok(checkpoints.length >= 2, `the engine must reach a second checkpoint for this to prove anything; got ${checkpoints.length}`)
  assert.ok(!/--rejoin/.test(checkpoints[0].prompt), 'the first checkpoint has nothing to rejoin')

  const fin = [...run.calls].reverse().find(c => /^log-run/.test(c.label))
  assert.ok(fin, 'the engine must still file its record')
  assert.match(fin.prompt, new RegExp(`--dir '${RUN_DIR}'`), 'it finalizes with the directory it minted')
  assert.ok(!/--rejoin/.test(fin.prompt),
    'and must NOT arm the rejoin flag: the directory is its own, and claiming otherwise costs the run its phases')
})

test('a checkpoint that DID have to rejoin still says so at finalize', async () => {
  // The inverse, so the fix cannot be "never send the flag": the FIRST checkpoint dies, so the run
  // has no directory of its own, the next one rejoins and may adopt — and finalize must carry that.
  let seen = 0
  const run = await runEngine('review', {
    script: {
      detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
      'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
      checkpoint: () => (seen++ === 0 ? null : { runDir: RUN_DIR, error: '' }),
      'log-run': { ok: true, error: '' },
      '*': null,
    },
  })
  const armed = run.calls.filter(c => c.key === 'checkpoint' && /--rejoin/.test(c.prompt))
  assert.ok(armed.length >= 1, 'the checkpoint after the failure must arm the rejoin')
  const fin = [...run.calls].reverse().find(c => /^log-run/.test(c.label))
  assert.match(fin.prompt, /--rejoin/, 'and finalize must keep saying it: the runDir it holds may be someone else\'s')
})

test('a run whose working copy moved mid-review still folds its OWN phases', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-store-'))
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: '/repos/mine' })
  writeCheckpoint(dir, 'rust-plan', { kind: 'workflow', name: 'review', branch: 'feat/started-here', head: 'startsha' },
    { project: '/repos/mine' })

  const res = finalizeRun({ schemaVersion: 1, kind: 'workflow', name: 'review', verdict: 'Block' }, {
    store, project: '/repos/mine', dir, rejoin: false,
    gitId: { branch: 'feat/moved-since', head: 'endsha' },
  })
  assert.equal(res.folded, 1, 'its own phases are folded although branch and head both moved under it')
  assert.equal(res.kept, false, 'and the directory is not stranded')
  assert.equal(JSON.parse(fs.readFileSync(res.file, 'utf8')).phases.length, 1)
})
