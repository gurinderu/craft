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
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkpointDir, writeCheckpoint, finalizeRun } from './craft-log-run.mjs'

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
