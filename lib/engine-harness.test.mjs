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
    // The negative has to be spelled in the wording the engine ACTUALLY uses, or it is a no-op that
    // reads as coverage. Three engines render telemetryLostSection and its "could not be confirmed"
    // count; adversarial-review returns a structured object whose note is prefixed instead. Keying
    // both on the count sentence would leave the fourth engine unchecked while the loop still
    // reported four-engine coverage — the same shape as the defects this file exists to catch.
    if (engine === 'adversarial-review') {
      assert.match(report, /⚠️ telemetry: /, 'the landed-but-degraded note carries its own prefix')
      assert.ok(
        !/⚠️ telemetry lost: the run directory \(the record itself landed\)/.test(report),
        'and a landed record must not be prefixed as lost',
      )
    } else {
      assert.match(report, /Telemetry incomplete/, 'a landed-but-degraded run must be distinguishable')
      assert.ok(
        !/\d+ record write\(s\)\/read\(s\) for this run could not be confirmed/.test(report),
        'a record that landed must not be counted among the unconfirmed',
      )
    }
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
  const checkpointPrompts = []
  const { report } = await runEngine('review', {
    args: {},
    script: {
      detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
      'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
      // NO assertion inside this thunk: review.js dispatches checkpoints through a wrapper that
      // swallows throws, so an AssertionError raised here is absorbed and re-emitted as a
      // telemetry-loss line — the test would fail indirectly, or not at all. Record, assert after.
      checkpoint: ({ prompt, callIndex }) => {
        checkpointPrompts.push(prompt)
        // First call mints A and the engine threads it into the second, which we refuse by handing
        // back B — precisely what an out-of-store --dir does in the wild.
        return callIndex === 0
          ? { runDir: '/store/.partial/run-A', error: '' }
          : { runDir: '/store/.partial/run-B', error: '' }
      },
      'log-run': { ok: true, error: '' },
      '*': null,
    },
  })
  assert.ok(checkpointPrompts.length > 1, 'the run must reach a second checkpoint, or nothing was tested')
  assert.match(checkpointPrompts[1], /run-A/, 'the engine must thread the directory it was given')
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
  // ABSOLUTE, not symmetric. A symmetric agreement passes when NEITHER side mentions the case, and
  // that is a live failure rather than a pedantic one: reword the phrase consistently everywhere —
  // an ordinary regeneration of the inline region — and the description stops asking the model for
  // the WARNING line, so the logger returns error:'' on a landed-but-degraded run, `landed.reason`
  // is never set, and the branch this file proves works in all four engines never fires in
  // production. The engine half is executable; the instruction that makes a model fill the field is
  // not, so it is pinned here by its text and nowhere else.
  const REQUIRED = 'ok is true AND the script printed a craft-log-run WARNING'
  assert.match(
    fs.readFileSync(path.join(root, 'lib', 'run-logging.mjs'), 'utf8'), new RegExp(REQUIRED),
    'the schema description must ASK for the WARNING line — the model steers by it',
  )
  for (const engine of RECORD_FILING_ENGINES) {
    const src = engineSource(engine)
    assert.match(src, new RegExp(REQUIRED), `${engine}: the inlined description must carry it too`)
    assert.match(src, /"ok": true, "error"/, `${engine}: and the prompt must ask for it in that same field`)
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
    // Both, not either: an alternation whose branches are both true today cannot tell you which one
    // regressed. The variable is assigned first and the env var carries the hard `:?` abort, and the
    // two are separate properties — the assignment is what puts resolution BEFORE the `cd`, the `:?`
    // is what refuses to guess a path rather than falling back to the reviewed repository.
    assert.match(logger.prompt, /CRAFT_LOGGER=/, `${engine}: the logger path must be assigned before any cd`)
    assert.match(logger.prompt, /CLAUDE_PLUGIN_ROOT:\?/, `${engine}: and an unset plugin root must abort, not fall back`)
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

// ---- the harness's own fidelity, asserted rather than assumed --------------------------------
// A stub that is wrong in the permissive direction is the worst outcome available here: tests go
// green on an engine that would fail in production. These pin the two contracts the engines lean on.

test('an agent that THROWS is a dead agent, not a crashed run', async () => {
  // The sandbox turns a throwing thunk into null, and rust-audit's `.filter(Boolean)` depends on it.
  // A harness that rejected instead would make half the dead-agent class untestable and would read
  // as an engine defect. So: one dimension throws, the run must still produce its report and say
  // that dimension did not run.
  // The property is an EQUIVALENCE, and asserting it that way is what makes the test mean something:
  // the sandbox's contract is that a thrown error and a returned null are the same outcome, so a
  // run where one dimension throws must produce the same report as one where it merely dies. A
  // weaker "the report mentions not-run" would hold whether or not anything threw, since every other
  // agent is dead too — the assertion would be true for the wrong reason.
  const { report: threw } = await runEngine('rust-audit', {
    args: {},
    script: { security: () => { throw new Error('agent blew up') }, '*': null },
  })
  const { report: died } = await runEngine('rust-audit', { args: {}, script: ALL_DEAD })
  assert.ok(threw, 'a throwing agent must not take the run down')
  assert.equal(threw, died, 'a thrown error and a returned null are one outcome — the sandbox says so and rust-audit relies on it')
})

test('what an engine threads into a nested run is visible to assertions', async () => {
  // rust-audit dispatches a nested `review` and threads base/path/languages/craftRoot into it. None
  // of that is in any prompt, so without recording the dispatch it is unassertable — and craftRoot
  // is precisely the argument whose absence stops a record from ever being written.
  const { calls } = await runEngine('rust-audit', {
    args: { base: 'v0.17.0', craftRoot: '/plugins/craft' },
    script: { '*': null },
  })
  const nested = calls.filter(c => c.label === 'workflow')
  assert.equal(nested.length, 1, 'rust-audit dispatches exactly one nested review here')
  const [name, nestedArgs] = nested[0].argv
  assert.equal(name, 'review', 'the nested engine is named, not implied')
  assert.equal(nestedArgs.craftRoot, '/plugins/craft',
    'craftRoot must reach the nested run — without it the child resolves its logger from the environment alone and files nothing')
  assert.equal(nestedArgs._via, 'rust-audit', 'and the child must know it is nested, or its record claims to be a standalone run')
  // `base` is deliberately NOT asserted here: rust-audit threads the base its SCOUT resolved, not
  // the one it was handed, and this script has a dead scout. Asserting it would be asserting a wish.
  assert.ok(!('base' in nestedArgs), 'with no resolved base, none is invented for the child')
})

test('every engine understands the key=value form its own invocation line advertises', async () => {
  // Measured live before this was fixed: `review` launched with `base=v0.17.0` reviewed one
  // uncommitted file on the working tree instead of the 23-commit range, and reported a verdict that
  // read exactly like a requested one. Only `review` even attempted to normalize a string; the other
  // three took their defaults from a string arg without a word. The option most worth losing quietly
  // is the one that decides WHICH diff gets reviewed.
  for (const engine of RECORD_FILING_ENGINES) {
    const { calls, logs } = await runEngine(engine, {
      args: engine === 'triage-findings' ? 'pr=60 base=v0.17.0' : 'base=v0.17.0',
      script: ALL_DEAD,
    })
    // Shared across all four: the string form is UNDERSTOOD, the repair is said out loud, and the
    // VALUE LANDS. Asserting only the warning text was the hole that let the real defect ship green —
    // the guard had been rewritten to read the normalized object while the value was still read from
    // the raw `args`, so a string arg produced the literal "undefined" in the scout's prompt. Each
    // engine is asserted through the option IT has, which is not the same word everywhere; that is a
    // reason to name them, not a reason to assert nothing.
    assert.ok(
      logs.some(l => /key=value/.test(l)),
      `${engine}: the repair must be said out loud — a silently repaired arg teaches the next caller nothing`,
    )
    assert.ok(
      !logs.some(l => /ALL options ignored/.test(l)),
      `${engine}: the key=value form must not fall through to the drop-everything path`,
    )
    // Narrow on purpose: a bare "undefined" is ordinary English in these prompts (rust-audit asks
    // Miri about undefined behavior). What cannot appear is an option INTERPOLATED as undefined —
    // quoted, backticked, or introduced by the word that precedes a value — which is the exact shape
    // the defect took: "1. Resolve the diff base. Use `undefined`."
    const prompts = calls.map(c => c.prompt).join('\n')
    assert.ok(
      !/[`'"]undefined[`'"]|=\s*undefined\b|\bUse undefined\b/.test(prompts),
      `${engine}: an option was interpolated as undefined — the value was read from the raw args, not the normalized object`,
    )
  }
})

test('the option each engine actually has lands in the prompt that uses it', async () => {
  // Named per engine because the word differs: adversarial-review calls it `diffBase`, review and
  // rust-audit `base`, triage-findings has no diff to base and takes `pr` instead. Naming four
  // options is a page of work; not naming them is how "undefined" reached a scout prompt.
  const cases = [
    ['review', 'base=v0.17.0', /v0\.17\.0/],
    ['adversarial-review', 'diffBase=v0.17.0', /v0\.17\.0/],
    ['rust-audit', 'base=v0.17.0', /v0\.17\.0/],
    ['triage-findings', 'pr=60', /\b60\b/],
  ]
  for (const [engine, argString, expected] of cases) {
    const { calls } = await runEngine(engine, { args: argString, script: ALL_DEAD })
    const prompts = calls.map(c => c.prompt).join('\n')
    assert.match(prompts, expected, `${engine}: the value passed as ${argString} must reach an agent`)
  }
})

test('prose passed as args is dropped loudly, never turned into flags', async () => {
  // The parser's own trap: a bare word became a flag, so a pasted sentence would have invented
  // options nobody wrote — an invented `strict` or `fresh` changes what the run does.
  const { logs } = await runEngine('review', { args: 'please review the release diff', script: ALL_DEAD })
  assert.ok(logs.some(l => /unrecognized string/.test(l)), 'prose must be reported as dropped')
})
