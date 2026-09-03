// Behaviour of the ENGINES, executed rather than pattern-matched.
//
// Everything here was previously either untestable or pinned by a source-text tripwire. The
// difference is not cosmetic: a tripwire asserts that a line still exists, so it catches a revert
// and misses every defect that keeps the line and breaks the behaviour. Each test below fails
// against the real defect that motivated it, not against its deletion.
//
// The engines take a `path` argument and dispatch agents; nothing here touches git, the filesystem
// or the network, so these run in milliseconds and in any checkout.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runEngine, filedRecord, engineSource, RECORD_FILING_ENGINES } from './engine-harness.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// A run where every agent is dead. The most important script in the file: an engine that renders
// dead agents as a clean result is this repo's recurring defect, and it is exactly what no
// source-text assertion can reach.
const ALL_DEAD = {}

// `triage-findings` refuses to run without a source, and rightly so — a triage over nothing would
// report an empty plan as a clean one. Every engine gets the minimum its own contract demands and
// nothing more.
const ARGS = { 'triage-findings': { pr: '60' } }
const argsFor = engine => ({ ...(ARGS[engine] || {}) })

// ---- the shared rule, asserted across every engine that carries it ----------------------------
// A rule living in four files and tested in one is how "a landed record labelled lost" came to be
// fixed in adversarial-review and nowhere else, with every gate green. These iterate the list.

for (const engine of RECORD_FILING_ENGINES) {
  test(`${engine}: a lost run record is reported in the run's own output`, async () => {
    const { report, calls } = await runEngine(engine, { args: argsFor(engine), script: ALL_DEAD })
    assert.ok(calls.some(c => c.label === 'log-run'), 'the engine must attempt to file a record')
    // Case-insensitive on purpose, and the difference is structural rather than sloppy: three engines
    // return report markdown and render a `## ⚠️ Telemetry lost` SECTION, while adversarial-review
    // returns a structured object whose equivalent is a lowercase note in `notRun`. What must hold
    // across all four is that the lost record is surfaced and named — not that the casing matches.
    assert.match(report, /telemetry lost/i, 'a record nobody can find must be said out loud')
    assert.match(report, /the run record/, 'and must name WHICH write went missing, not just that one did')
    assert.ok(!/telemetry incomplete/i.test(report), 'a record that never landed must not be softened to "incomplete"')
  })

  test(`${engine}: a landed record whose directory was refused is NOT called lost`, async () => {
    // The logger prints a WARNING on stderr and still exits 0: the record is on disk, the run
    // directory is not folded into it. Calling that "telemetry lost" is a false alarm, and a marker
    // that cries wolf is one readers stop reading — which costs the runs where it means what it says.
    const { report } = await runEngine(engine, {
      args: argsFor(engine),
      script: {
        'log-run': { ok: true, error: 'craft-log-run WARNING: --dir /tmp/elsewhere is not inside the store — record written, directory neither folded nor removed' },
        '*': null,
      },
    })
    assert.match(report, /Telemetry incomplete|telemetry: /, 'a landed-but-degraded run must be distinguishable')
    assert.ok(
      !/\d+ record write\(s\)\/read\(s\) for this run could not be confirmed/.test(report),
      'a record that landed must not be counted among the unconfirmed',
    )
  })

  test(`${engine}: the record it files carries the fields only the script can compute`, async () => {
    const run = await runEngine(engine, { args: argsFor(engine), script: ALL_DEAD })
    const record = filedRecord(run)
    assert.ok(record, 'the outgoing record must be recoverable from the logger prompt')
    assert.equal(record.schemaVersion, 1)
    assert.equal(record.kind, 'workflow')
    assert.equal(record.name, engine)
    assert.match(String(record.craftVersion), /^\d+\.\d+\.\d+$/, 'the version stamp rides on the record')
    assert.ok('verdict' in record, 'a record without a verdict is a run nobody can classify later')
    // engineRevision is deliberately NOT here: the script stamps it, and an engine that filled it
    // from the prompt would be reporting a revision it cannot know.
    assert.ok(!('engineRevision' in record), 'engineRevision belongs to the script, not the engine')
  })
}

// ---- the engine must not trust what comes back through an agent -------------------------------

test('review: a checkpoint that mints a different directory is reported, not adopted', async () => {
  // A refused `--dir` does not fail the checkpoint: the script mints a fresh directory and returns a
  // valid runDir. Adopting it silently strands every slice written into the directory we asked for —
  // finalize folds only the new one and the report calls the run clean.
  const { report } = await runEngine('review', {
    args: {},
    script: {
      detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
      'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
      checkpoint: ({ prompt, callIndex }) => {
        // First call mints A and the engine threads it into the second, which we refuse by handing
        // back B — precisely what an out-of-store --dir does in the wild.
        if (callIndex === 0) return { runDir: '/store/.partial/run-A', error: '' }
        assert.match(prompt, /run-A/, 'the engine must thread the directory it was given')
        return { runDir: '/store/.partial/run-B', error: '' }
      },
      'log-run': { ok: true, error: '' },
      '*': null,
    },
  })
  assert.match(report, /run-A/, 'the report must name the directory whose slices are now stranded')
  assert.match(report, /Telemetry/, 'and must reach the telemetry section rather than pass silently')
})

test('review: the base it was given reaches the agent that resolves the diff', async () => {
  // Passing `base` used to be silently ineffective end to end: the argument arrived, the prompt was
  // built without it, and the engine reviewed the working tree instead of the range asked for. The
  // verdict looked entirely normal — for the wrong diff.
  const { calls } = await runEngine('review', { args: { base: 'v0.17.0' }, script: ALL_DEAD })
  const detect = calls.find(c => c.label === 'detect')
  assert.ok(detect, 'the engine must dispatch the base-resolution agent')
  assert.match(detect.prompt, /v0\.17\.0/, 'the requested base must appear in the prompt that resolves it')
  assert.ok(
    !/Try in order until one resolves/.test(detect.prompt),
    'and the fallback ladder must not be offered alongside an explicit base',
  )
})

test('review: a scoped path reaches the prompt that lists the changed files', async () => {
  const { calls } = await runEngine('review', { args: { path: 'lib/' }, script: ALL_DEAD })
  const detect = calls.find(c => c.label === 'detect')
  assert.match(detect.prompt, /lib\//, 'the scope must reach the agent, or the run silently reviews everything')
})

// ---- two strings that must agree, and nothing else makes them ---------------------------------

test('the schema description and the prompt agree about the WARNING line', async () => {
  // The field description is what the model steers by. It said "empty otherwise" while the prompt 60
  // lines below asked for the WARNING line in that same field, so a landed-but-degraded run returned
  // '' and never reached the banner. Both are strings in one file; nothing but this compares them.
  for (const engine of RECORD_FILING_ENGINES) {
    const src = engineSource(engine)
    const describesWarning = /ok is true AND the script printed a craft-log-run WARNING/.test(src)
    const asksForWarning = /craft-log-run WARNING/.test(src) && /"ok": true, "error"/.test(src)
    assert.equal(
      describesWarning, asksForWarning,
      `${engine}: the error field's description and the prompt must both mention the WARNING case, or neither`,
    )
  }
})

test('every engine that files a record stamps the manifest version on it', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
  for (const engine of RECORD_FILING_ENGINES) {
    const run = await runEngine(engine, { args: argsFor(engine), script: ALL_DEAD })
    const record = filedRecord(run)
    assert.equal(record?.craftVersion, manifest.version, `${engine}: records must carry the released version`)
  }
})

// ---- the logger command itself, as the engine actually writes it ------------------------------

test('the logger is never resolved against the reviewed repository', async () => {
  // The reviewed repo is untrusted by construction: resolving the logger relative to it would run
  // that repository's own script with the user's privileges. The `:-.` fallback did exactly that,
  // because it resolved AFTER the `cd`. Its removal must not creep back in any engine.
  for (const engine of RECORD_FILING_ENGINES) {
    const { calls } = await runEngine(engine, { args: argsFor(engine), script: ALL_DEAD })
    const logger = calls.find(c => c.label === 'log-run')
    assert.ok(logger, `${engine}: expected a logger dispatch`)
    assert.ok(
      !/CLAUDE_PLUGIN_ROOT:-\.\}/.test(logger.prompt) && !/\$\{CLAUDE_PLUGIN_ROOT:-/.test(logger.prompt),
      `${engine}: the logger path must not fall back to the working directory`,
    )
    assert.match(logger.prompt, /CRAFT_LOGGER=|CLAUDE_PLUGIN_ROOT:\?/, `${engine}: the logger path must be resolved before any cd`)
  }
})

test('the record is staged through a per-run temp file, removed after, exit code carried', async () => {
  // A fixed /tmp path is an arbitrary-overwrite primitive on a shared box (cat > follows a symlink)
  // and, with craft's own fan-out, one run files another's record under its identity.
  for (const engine of RECORD_FILING_ENGINES) {
    const { calls } = await runEngine(engine, { args: argsFor(engine), script: ALL_DEAD })
    const p = calls.find(c => c.label === 'log-run').prompt
    assert.match(p, /mktemp/, `${engine}: staging must be per-run`)
    assert.ok(!/\/tmp\/craft-rec\.json/.test(p), `${engine}: the fixed staging path must be gone`)
    assert.match(p, /CRAFT_RC=\$\?[\s\S]*rm -f[\s\S]*exit \$CRAFT_RC/, `${engine}: the exit code must survive the cleanup`)
  }
})
