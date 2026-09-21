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
import {
  runEngine, filedRecord, engineSource, CALL_SPEND,
  allEngines, RECORD_FILING_ENGINES, OPTION_READING_ENGINES,
} from './engine-harness.mjs'

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
    // What is banned is a DEFAULT PATH, not the `:-` operator: `${CLAUDE_PLUGIN_ROOT:-}` expands to
    // the empty string and is harmless, while `${CLAUDE_PLUGIN_ROOT:-.}` — or any other default —
    // silently supplies a directory, and after the `cd` that directory is the reviewed repository.
    assert.ok(
      !/\$\{CLAUDE_PLUGIN_ROOT:-[^}]/.test(logger.prompt),
      `${engine}: the plugin root must have no default path — an empty default is fine, a directory is not`,
    )
    // Anchored on the actual command line, not on `split('cd ')`: the first `cd ` in the prompt is
    // now the one inside the containment block's `$(cd <repo> && pwd -P)`, so splitting there tested
    // three lines that mention no logger at all — an assertion with no subject. Reintroducing the
    // original vulnerability left it green.
    const cdLine = logger.prompt.split('\n').find(l => /^cd .*&& node /.test(l)) || ''
    assert.ok(cdLine, `${engine}: expected the cd-into-repo command line`)
    assert.match(cdLine, /node "\$CRAFT_LOGGER"/, `${engine}: the logger must be run from the variable resolved before the cd`)
    assert.ok(
      !/craft-log-run\.mjs/.test(cdLine),
      `${engine}: no path may be resolved on the command line that has already cd'd into the reviewed repository`,
    )
    // Both, not either: an alternation whose branches are both true today cannot tell you which one
    // regressed. The variable is assigned first and the env var carries the hard `:?` abort, and the
    // two are separate properties — the assignment is what puts resolution BEFORE the `cd`, the `:?`
    // is what refuses to guess a path rather than falling back to the reviewed repository.
    assert.match(logger.prompt, /CRAFT_LOGGER=/, `${engine}: the logger path must be assigned before any cd`)
    // No alternation with the PRE-FIX spelling: `|CLAUDE_PLUGIN_ROOT:\?` kept this test green
    // through a full revert of the branch, and this is the file's only cross-engine guard on the
    // logger command. A branch that can only be satisfied by the old shape is not a fallback, it is
    // a blind spot.
    assert.match(logger.prompt, /craft-log-run FAILED[^\n]*refusing to resolve against the reviewed repository/,
      `${engine}: an unresolvable logger must refuse by name, not fall back`)
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
  // The QUALIFIED name: the harness stub resolves every name, and that is what the installed
  // plugin's registry does for `craft:review` — the bare spelling is only a fallback, tried when
  // the qualified one is refused (lib/nested-workflow.test.mjs drives both branches).
  assert.equal(name, 'craft:review', 'the nested engine is named, not implied')
  assert.equal(nestedArgs.craftRoot, '/plugins/craft',
    'craftRoot must reach the nested run — without it the child resolves its logger from the environment alone and files nothing')
  assert.equal(nestedArgs._via, 'rust-audit', 'and the child must know it is nested, or its record claims to be a standalone run')
  // `base` is deliberately NOT asserted here: rust-audit threads the base its SCOUT resolved, not
  // the one it was handed, and this script has a dead scout. Asserting it would be asserting a wish.
  assert.ok(!('base' in nestedArgs), 'with no resolved base, none is invented for the child')
})

test('every engine on disk is claimed by a roster — none may be forgotten', () => {
  // The rosters are derived, and this is what makes deriving them worth anything: a new engine that
  // neither files a record nor reads options is almost certainly one of the two with a forgotten
  // wire-up, and it must fail here rather than be quietly excluded from every shared assertion.
  // Twice on this branch a fix reached the engines a hand-written list named and missed the rest.
  const claimed = new Set([...RECORD_FILING_ENGINES, ...OPTION_READING_ENGINES])
  const orphans = allEngines().filter(e => !claimed.has(e))
  assert.deepEqual(orphans, [], 'every workflow must be reachable by the shared assertions')
  assert.ok(allEngines().length >= 6, 'and the engine list must actually have been read from disk')

  // Being claimed by SOME roster is not enough, and this is the escape that survived the previous
  // round: an engine filing records through its own `fileRun()` wrapper is claimed by the option
  // roster, satisfies the orphan check, and is silently absent from every shared record-filing
  // assertion. So the question is asked of the thing that cannot be renamed away — an engine that
  // writes a record must invoke the logger script, whatever it calls its own wrapper.
  const filesSomehow = allEngines().filter(e => /craft-log-run/.test(engineSource(e)))
  assert.deepEqual(
    filesSomehow.sort(), [...RECORD_FILING_ENGINES].sort(),
    'an engine that invokes the logger must be in the record-filing roster, whatever it names its wrapper',
  )
})

test('every engine understands the key=value form its own invocation line advertises', async () => {
  // Measured live before this was fixed: `review` launched with `base=v0.17.0` reviewed one
  // uncommitted file on the working tree instead of the 23-commit range, and reported a verdict that
  // read exactly like a requested one. Only `review` even attempted to normalize a string; the other
  // three took their defaults from a string arg without a word. The option most worth losing quietly
  // is the one that decides WHICH diff gets reviewed.
  for (const engine of OPTION_READING_ENGINES) {
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

test('the thin language pins normalize their args too, or they drop them into a valid-looking object', async () => {
  // rust-review and nix-review hand `review` a real OBJECT, so an option lost here arrives at the
  // child as a perfectly valid shape that the child's own normalizer cannot warn about: a caller
  // typing `base=v0.17.0` gets a confident verdict over the working tree with no line anywhere
  // saying the base was dropped. They are not in RECORD_FILING_ENGINES — they file no record — which
  // is exactly why the args tests above did not reach them.
  for (const pin of ['rust-review', 'nix-review']) {
    const { calls } = await runEngine(pin, { args: 'base=v0.17.0', script: { '*': null } })
    const nested = calls.filter(c => c.label === 'workflow')
    assert.equal(nested.length, 1, `${pin}: delegates exactly once`)
    const [, childArgs] = nested[0].argv
    assert.equal(childArgs.base, 'v0.17.0', `${pin}: the base must survive the delegation`)
    assert.ok(Array.isArray(childArgs.languages), `${pin}: and the pin it exists for must still be set`)
  }
})

// The absolute-`path` family. Measured 2026-09-17: dispatched as `path=<another repo>` — the spelling
// the pins' own argument list invited, because it named `path` and not `repo` — a run reviewed the
// session's checkout and spent 57 agents / 2.04M tokens having all 14 lenses independently rediscover
// that the base was unreachable and there were no sources. The first fix guessed "they meant repo",
// which a cold review refuted: the same spelling is how a caller narrows to a crate, and guessing
// turns a narrowing request into a whole-repo review wearing the narrow label. So the rule is to
// resolve it only where the prefix decides, and refuse otherwise.
const OTHER_REPO = '/Users/someone/projects/other-repo'

test('review: an absolute `path` with no `repo` refuses before dispatching a single agent', async () => {
  const { report, calls } = await runEngine('review', { args: { path: OTHER_REPO }, script: ALL_DEAD })
  assert.match(report, /INCOMPLETE/, 'it must not read as a review that happened')
  assert.match(report, /ambiguous/i, 'and must say WHY it did not run')
  assert.ok(report.includes('`repo`'), 'the report must name the argument that resolves it')
  // The HARD form of "costs nothing": not a named list of the calls that must be absent — a list is
  // a memory of the pipeline and goes stale the round a phase is added — but EVERY call except the
  // one that records the refusal. The weakened form said "no detect, no scout, no lenses" while
  // asserting only the first two, so a lens dispatched on a refused run would have passed it.
  // (`ALL_DEAD` kills the recorder too, so its one re-dispatch is the only other call permitted.)
  const labels = calls.map(c => String(c.label || ''))
  assert.deepEqual(labels.filter(l => !/^(retry:)?log-run$/.test(l)), [], 'refusing must cost NOTHING but the call that records it')
  assert.equal(labels.filter(l => l === 'log-run').length, 1, 'and the refusal is recorded exactly once')
  // (`logs` is deliberately NOT asserted: the refusal is carried by the report and the record, and
  // pinning a log line here would pin a decoration. The assertion it replaces — `logs.length >= 0` —
  // was true of every array ever constructed and checked nothing at all.)
})

test('review: `~` is absolute too — the shell expands it before git sees the pathspec', async () => {
  const { report, calls } = await runEngine('review', { args: { path: '~/projects/other-repo' }, script: ALL_DEAD })
  assert.match(report, /INCOMPLETE/, 'the tilde form reproduces the same incident and must be refused too')
  assert.ok(!calls.some(c => c.label === 'detect'), 'and refused just as cheaply')
})

test('review: an absolute `path` INSIDE the repo keeps the narrowing, it does not widen to the whole repo', async () => {
  // The defect the first fix introduced: read as a repo selector, `repo=<crate dir>` with no scope is
  // a confident WHOLE-repo review labelled as the crate. This is also how rust-audit's per-crate
  // fan-out fails when its scout answers with absolute crate directories.
  const { calls } = await runEngine('review', {
    args: { repo: OTHER_REPO, path: `${OTHER_REPO}/crates/core` },
    script: ALL_DEAD,
  })
  const detect = calls.find(c => c.label === 'detect')
  assert.ok(detect, 'the run must proceed — this spelling is decidable')
  assert.ok(detect.prompt.includes('crates/core'), 'the scope must survive as a repo-relative pathspec')
  assert.ok(
    !detect.prompt.includes(`-- ${OTHER_REPO}/crates/core`),
    'and must not reach git as an absolute pathspec, which matches nothing',
  )
})

test('review: an absolute `path` OUTSIDE an explicit `repo` drops the scope rather than emptying the diff', async () => {
  const { calls, logs } = await runEngine('review', {
    args: { repo: OTHER_REPO, path: '/elsewhere/crate' },
    script: ALL_DEAD,
  })
  assert.ok(logs.some(l => /ABSOLUTE/.test(l)), 'the mismatch must be reported, not silently honoured')
  const detect = calls.find(c => c.label === 'detect')
  assert.ok(!detect.prompt.includes('-- /elsewhere/crate'), 'the unusable pathspec must not reach git')
  assert.ok(detect.prompt.includes(OTHER_REPO), 'and the explicitly given repo must still be the target')
})

// `repo` is honoured by exactly one engine. The other three dispatch agents that run git/cargo in
// whatever directory the session sits in, so accepting the argument would reproduce the measured
// incident (57 agents, 2.04M tokens, nothing reviewed) in three more places — and rust-audit's own
// comment promised the argument while nothing read it.
for (const engine of ['rust-audit', 'adversarial-review', 'triage-findings']) {
  test(`${engine}: refuses \`repo\` instead of silently working on the session's own checkout`, async () => {
    const { report, calls } = await runEngine(engine, {
      args: { ...argsFor(engine), repo: '/Users/someone/projects/other-repo' },
      script: ALL_DEAD,
    })
    assert.match(report, /INCOMPLETE/, 'it must not read as a run that happened')
    assert.ok(report.includes('/Users/someone/projects/other-repo'), 'the refusal must name what it was given')
    assert.match(report, /craft:review/, 'and must name the engine that does support it')
    // "Costs nothing" means no REVIEW work, not literally no dispatch. The refusal now files a run
    // record, which is one cheap haiku logger call — the same price every other refusal in `review`
    // already pays, and for the same reason: a refusal that files nothing is invisible to the
    // `notRun` fragility ranking, so a caller repeating the same wrong dispatch cannot be seen to be
    // repeating it. What must stay at zero is the fan-out.
    const work = calls.filter(c => !/^log-run|^logrun|^log_run/i.test(String(c.label)))
    assert.deepEqual(work.map(c => c.label), [], 'refusing must cost no review work — no scout, no lenses, no plan')
    assert.equal(calls.length, 1, 'and exactly one call: the logger that records the refusal')
  })
}

// ---- the failure-windows lens is enforced by the plan, not requested in a prompt --------------
// Measured twice in this repo: a prompt-side "always include X" gets dropped, and a lens that
// silently did not run is indistinguishable from a lens that found nothing. So the rule "controller
// code gets the failure-windows lens" lives in the planner, and here it is executed: the scout asks
// for `reconciler` ALONE and the lens must still be dispatched. `securitySensitive: false` matters —
// the security floor pushes every profile lens, which would make this pass without the rule.
const RECONCILER_ONLY = {
  detect: { baseRef: 'main', files: ['src/controller.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  scout: { lenses: ['reconciler'], sizeBucket: 'small', securitySensitive: false, isLibrary: false, intent: 'controller change', churn: [] },
  '*': null,
}

test('review: a plan carrying `reconciler` also dispatches the failure-windows lens', async () => {
  const { calls } = await runEngine('review', { args: {}, script: RECONCILER_ONLY })
  // The label carries a round suffix (`lens:rust:reconciler r1`), so match on the prefix.
  const ranLens = l => calls.some(c => String(c.label).startsWith(`lens:rust:${l}`))
  assert.ok(ranLens('reconciler'), 'the scout-requested lens must run, or nothing was tested')
  assert.ok(
    ranLens('failure-windows'),
    'and the durability lens must be added by the planner even though the scout never asked for it',
  )
})

test('review: the failure-windows brief reaches the agent that runs it', async () => {
  // A registered lens whose brief never arrives is a lens reviewing nothing: the prompt is built from
  // lensBrief, so the procedure has to be visible in the dispatched prompt, not just in the table.
  const { calls } = await runEngine('review', { args: {}, script: RECONCILER_ONLY })
  const lens = calls.find(c => String(c.label).startsWith('lens:rust:failure-windows'))
  assert.ok(lens, 'the lens must be dispatched before its prompt can be checked')
  assert.match(lens.prompt, /IN EXECUTION ORDER/, 'the enumeration step must reach the agent')
  assert.match(lens.prompt, /EACH ADJACENT PAIR/, 'and the pairwise failure-window step')
  assert.match(lens.prompt, /A one-shot dependency scan is not a guard/, 'and the two-controller interleaving step')
})

test('review: a DROPPED scope reaches the report, not only the log', async () => {
  // A dropped narrowing is a divergence between what was ordered and what was done: the review ran
  // over the WHOLE repository under a request to narrow it. Saying so in `log()` alone puts it in
  // front of the one reader who is not the one receiving the verdict.
  const { report, calls } = await runEngine('review', {
    args: { repo: OTHER_REPO, path: '/elsewhere/crate' },
    script: ALL_DEAD,
  })
  assert.match(report, /INCOMPLETE/, 'a review that silently widened its own scope is not a complete answer')
  assert.ok(report.includes('/elsewhere/crate'), 'and the report must name the scope that was dropped')
  const logged = calls.find(c => c.label === 'log-run')
  assert.ok(logged, 'the run must file a record')
  assert.match(logged.prompt, /was DROPPED/, 'the drop belongs in notRun, where the store can see it too')
})

test('review: containment is decided on path segments, not on a raw string prefix', async () => {
  // Equivalent spellings of the same directory: a trailing slash on the repo, a `.` segment and a
  // `..` that cancels. A prefix comparison calls all three "outside the repo" and drops a scope the
  // caller does get to keep.
  const { calls } = await runEngine('review', {
    args: { repo: `${OTHER_REPO}/`, path: `${OTHER_REPO}/./crates/legacy/../core` },
    script: ALL_DEAD,
  })
  const detect = calls.find(c => c.label === 'detect')
  assert.ok(detect, 'the run must proceed — this spelling is decidable')
  assert.ok(detect.prompt.includes("'crates/core'"), 'the equivalent spelling must normalize to the same repo-relative scope')
  assert.ok(!detect.prompt.includes(OTHER_REPO + '/./'), 'and the un-normalized form must not reach git')
})

// ---- the budget gate, pinned where it lives ----------------------------------------------------
// The harness's own contract: an exhausted budget refuses every later dispatch, and the refusal is
// INERT — recorded, but answering no script key and spending nothing. The end-to-end exhaustion
// tests (review-budget-exhaustion.test.mjs) lean on all of that; here each property is asserted
// directly, so a regression in the gate fails as a harness failure and not as a confusing
// engine-level failure two files away.

test('harness: the budget wall lands by arithmetic and refuses inertly', async () => {
  let answered = 0
  const K = 2
  const run = await runEngine('review', {
    args: {},
    script: { '*': () => { answered += 1; return null } },
    budgetTotal: K * CALL_SPEND,
  })
  assert.equal(run.calls.findIndex(c => c.threw), K,
    `exactly ${K} dispatches fit under ${K}×CALL_SPEND — the wall lands by arithmetic, not by drift`)
  assert.ok(run.calls.length > K, 'the engine keeps dispatching into the wall, so the refusal shape below is actually exercised')
  for (const c of run.calls.slice(K)) {
    assert.equal(c.threw, 'budget exhausted', `every dispatch past the wall is refused (got '${c.label}')`)
    assert.equal(c.key, null, 'a refusal answers no script key')
    assert.equal(c.result, undefined, 'and carries no result')
  }
  assert.equal(answered, K, 'the script is consulted once per ANSWERED call — a refusal must not consume an entry')
  // budget.spent() staying at the wall across refusals is pinned in review-budget-exhaustion.test.mjs
  // (record.outputTokens), where refusals actually precede the record build.
})

test('rust-audit: an exhausted budget refuses nested workflow dispatches too', async () => {
  // The asymmetry this pins shut: agent() was gated and workflow() was not, so the one dispatch
  // surface a nesting engine (rust-audit) fans out through could never run out — an exhaustion
  // test over it would have modeled nested runs as free and un-refusable. The wall sits after the
  // first answered call (the scout), so the whole fan-out, nested review included, is refused; the
  // run then dies on the first refused dispatch nothing catches, which is fail-closed, and the
  // escaping error carries the call trail.
  let nested = 0
  const script = { workflow: () => { nested += 1; return null } }

  const control = await runEngine('rust-audit', { args: {}, script })
  assert.ok(control.calls.some(c => c.label === 'workflow' && !c.threw),
    'control: the nested dispatch is answered while the budget allows')
  assert.equal(nested, 1, 'and it consults the script')

  nested = 0
  const err = await runEngine('rust-audit', { args: {}, script, budgetTotal: CALL_SPEND })
    .then(() => null, e => e)
  assert.ok(err, 'the walled run must fail closed, not return a report over a fan-out that never ran')
  assert.match(String(err.message), /budget exhausted/, 'and the death must carry the exhaustion reason')
  const wf = (err.calls || []).filter(c => c.label === 'workflow')
  assert.ok(wf.length > 0, 'the nested dispatch must be attempted and refused, not silently skipped')
  assert.ok(wf.every(c => c.threw === 'budget exhausted'), 'every nested dispatch past the wall is refused')
  assert.equal(nested, 0, 'and a refused nested dispatch consults no script')
})

test('rust-audit: an ANSWERED nested dispatch spends — the other half of the workflow gate', async () => {
  // The refusal half is pinned above; this is the spend half, which a mutation run showed was
  // covered by nothing: deleting the workflow spend left every test green, because the only walled
  // nesting run put its wall BEFORE the first nested dispatch. Here the wall is calibrated one call
  // PAST the answered nested dispatch, so its position is load-bearing on that spend: a nested
  // dispatch modeled as free moves the first refusal one call later and this fails by name. The
  // index assertion doubles as the ordering pin: the record is made AT DISPATCH — made at
  // completion instead, it lands after its concurrent siblings in the trail and every wall
  // calibrated as `index × CALL_SPEND` reads the wrong call.
  const script = { workflow: () => null, '*': null }
  const control = await runEngine('rust-audit', { args: {}, script })
  const wfAt = control.calls.findIndex(c => c.label === 'workflow')
  assert.ok(wfAt > 0, 'the control must dispatch a nested workflow after at least one agent call')
  assert.ok(!control.calls[wfAt].threw, 'and answer it — the wall below sits one call past an ANSWERED dispatch')
  assert.ok(control.calls.length > wfAt + 1, 'and keep dispatching, or the wall below refuses nothing')

  const trail = await runEngine('rust-audit', { args: {}, script, budgetTotal: (wfAt + 1) * CALL_SPEND })
    .then(r => r.calls, e => e.calls || [])
  assert.equal(trail[wfAt]?.label, 'workflow', 'the nested dispatch is recorded at its DISPATCH position in the trail')
  assert.ok(!trail[wfAt].threw, 'and is answered, not refused — the wall sits one call past it')
  assert.equal(trail.findIndex(c => c.threw === 'budget exhausted'), wfAt + 1,
    'the first refusal lands exactly one call after the answered nested dispatch — a nested dispatch that spent nothing would land it one call later')
})

test('harness: a dispatch that dies mid-flight spends and stays in the trail — agent and workflow alike', async () => {
  // The spend model, exercised on its death path: a DISPATCHED call spends and is recorded whether
  // its answer resolves or throws — a live call burns tokens before it dies, so a death refunds
  // nothing — and the record says it died, with the throw's own reason. Before this, a scripted
  // throw escaped between the spend and the record (workflow) or before both (agent): the budget
  // and the trail disagreed, and the dying dispatch — whose argv is the very thing such a record
  // exists to carry — was the one entry the trail did not contain.
  const script = {
    security: () => { throw new Error('security agent blew up') },
    workflow: () => { throw new Error('nested engine died') },
    '*': null,
  }
  const control = await runEngine('rust-audit', { args: {}, script })
  const secAt = control.calls.findIndex(c => c.key === 'security')
  const wfAt = control.calls.findIndex(c => c.label === 'workflow')
  assert.ok(secAt >= 0, 'the throwing agent dispatch must be recorded — a death is not an unmade call')
  assert.ok(wfAt >= 0, 'the throwing nested dispatch must be recorded too')
  assert.equal(control.calls[secAt].threw, 'security agent blew up', "an agent death carries the throw's own reason")
  assert.equal(control.calls[wfAt].threw, 'nested engine died', 'a nested death likewise')
  assert.equal(control.calls[secAt].result, undefined, 'a dispatch that died has no result')
  assert.equal(control.calls[wfAt].result, undefined, 'on either surface')

  // The spend half, by wall arithmetic: every dispatched call spends, deaths included, so a wall
  // placed one call past the later death lands exactly there.
  const dAt = Math.max(secAt, wfAt)
  assert.ok(control.calls.length > dAt + 1, 'the engine must keep dispatching past the deaths, or the wall below refuses nothing')
  const trail = await runEngine('rust-audit', { args: {}, script, budgetTotal: (dAt + 1) * CALL_SPEND })
    .then(r => r.calls, e => e.calls || [])
  assert.equal(trail.findIndex(c => c.threw === 'budget exhausted'), dAt + 1,
    'the wall lands by arithmetic over ALL dispatched calls — a death that spent nothing would land it one call late')
})

test('review: the trail an escaping error carries includes the dispatch that killed the run', async () => {
  // The .catch attaches `calls` so an exhaustion test can see which dispatches died — but a
  // scripted throw used to escape before the push, so the dispatch that actually killed the run
  // was the one entry err.calls did not contain, and a test reading the trail located the death at
  // the previous call.
  const err = await runEngine('review', {
    args: {},
    script: { detect: () => { throw new Error('scripted death') }, '*': null },
  }).then(() => null, e => e)
  assert.ok(err, 'a throw from a directly-awaited dispatch must reject the run')
  assert.match(String(err.message), /scripted death/, "and the rejection is the script's own error")
  const fatal = (err.calls || []).find(c => c.key === 'detect')
  assert.ok(fatal, 'the fatal dispatch itself must be in the trail err.calls carries')
  assert.equal(fatal.threw, 'scripted death', "recorded as a death, with the throw's own reason")
})

test('harness: a frozen escaping error still escapes as itself — bookkeeping must not replace the death', async () => {
  // `err.calls = calls` runs in strict mode: on a frozen error the assignment itself throws, and
  // the promise then rejects with a TypeError about property assignment instead of the engine's
  // actual death — a swallowed-and-replaced error on the very path built to preserve failure
  // evidence. The trail is lost in that case (the error has nowhere writable to put it); the death
  // must not be.
  const err = await runEngine('review', {
    args: {},
    script: { detect: () => { throw Object.freeze(new Error('frozen death')) }, '*': null },
  }).then(() => null, e => e)
  assert.ok(err, 'the run must reject')
  assert.match(String(err.message), /frozen death/,
    "the escaping error is the script's own, not a TypeError from the trail attachment")
})

test('harness: an ASYNC scripted death is recorded at the dispatch that died — agent and workflow alike', async () => {
  // The agent surface used to evaluate a scripted answer WITHOUT awaiting it: an async entry that
  // rejects left `threw` unset and parked the raw rejected Promise in `call.result`, so the trail
  // showed a completed-looking call for the dispatch that actually killed the run — the exact
  // mislocated-death defect err.calls exists to prevent — while workflow(), which awaited, recorded
  // the same death correctly. One contract, two surfaces, so both are asserted here.
  const script = {
    security: async () => { throw new Error('async agent death') },
    workflow: async () => { throw new Error('async nested death') },
    '*': null,
  }
  const { calls } = await runEngine('rust-audit', { args: {}, script })
  const sec = calls.find(c => c.key === 'security')
  const wf = calls.find(c => c.label === 'workflow')
  assert.ok(sec && wf, 'both throwing dispatches must be recorded — a death is not an unmade call')
  assert.equal(sec.threw, 'async agent death', 'an async rejection on the agent surface is a death, not an answered call')
  assert.equal(wf.threw, 'async nested death', 'and on the workflow surface likewise')
  assert.equal(sec.result, undefined, 'a dispatch that died has no result — not a rejected Promise object')
  assert.equal(wf.result, undefined, 'on either surface')
})

test('harness: a resolved async scripted answer lands in the trail as its value, not as a Promise', async () => {
  // The other half of the unawaited-answer hole: even a RESOLVING async entry parked a Promise in
  // `call.result`, so every assertion over the trail compared against an opaque object and the
  // engine saw the value only because promise resolution happens to unwrap it downstream.
  const { calls } = await runEngine('review', {
    args: {},
    script: { detect: async () => ({ baseRef: 'main', files: [], spec: '', branch: 'b', head: 'h' }), '*': null },
  })
  const detect = calls.find(c => c.key === 'detect')
  assert.ok(detect, 'the async-answered dispatch must be recorded')
  assert.ok(!(detect.result instanceof Promise), 'the trail carries values — a Promise in result is unassertable')
  assert.equal(detect.result?.baseRef, 'main', 'and the value is the resolved one')
})

test('harness: a scripted FUNCTION throw still carries the trail — typeof "function" is not "object"', async () => {
  // The .catch that attaches `err.calls` guarded on `typeof err === 'object'`, so a thrown function
  // — writable like any object — escaped with no trail, and a consumer reading `e.calls || []`
  // failed over an empty trail with a message blaming the engine instead of naming the loss.
  const bomb = () => {}
  bomb.message = 'function death'
  const err = await runEngine('review', {
    args: {},
    script: { detect: () => { throw bomb }, '*': null },
  }).then(() => null, e => e)
  assert.equal(err, bomb, "the escaping value is the script's own throw")
  assert.ok(Array.isArray(err.calls), 'the trail must ride on it — a function accepts properties like any object')
  assert.ok(err.calls.some(c => c.key === 'detect'), 'and must contain the fatal dispatch')
})

test('harness: a death with an empty message still reads as a death — threw is never falsy', async () => {
  // Every consumer of the trail filters by truthiness (`calls.filter(c => c.threw)`,
  // `findIndex(c => c.threw)`), so `threw: ''` — what `String(err?.message ?? err)` yields for
  // `new Error('')` — made an empty-message death indistinguishable from a live, still-in-flight
  // dispatch: the one-entry-the-trail-did-not-contain hole, back for one input shape.
  const err = await runEngine('review', {
    args: {},
    script: { detect: () => { throw new Error('') }, '*': null },
  }).then(() => null, e => e)
  assert.ok(err, 'the run must reject')
  const fatal = (err.calls || []).find(c => c.key === 'detect')
  assert.ok(fatal, 'the fatal dispatch must be in the trail')
  assert.ok(fatal.threw, 'the death marker must be truthy — every trail consumer filters by it')
  assert.equal(fatal.threw, 'died with no message', 'and names its own emptiness rather than hiding it')
})

test('rust-audit: a crate path reaches the nested review repo-relative, or not at all', async () => {
  // `cargo metadata` prints `manifest_path` ABSOLUTE, so a scout that copies it out hands back
  // absolute crate directories — and `review` refuses an absolute `path` outright, which turns the
  // per-crate fan-out into a row of refusals. Repaired at the boundary, against the scout's repoRoot.
  const REPO = '/Users/someone/projects/ws'
  const { calls, logs } = await runEngine('rust-audit', {
    args: {},
    script: {
      scout: {
        hasDiff: true, hasUnsafe: false, baseRef: 'main', repoRoot: REPO,
        crates: [], edges: [], notes: 'x',
        changedCrates: [
          { name: 'core', path: `${REPO}/crates/core` },
          { name: 'api', path: 'crates/api' },
          { name: 'stray', path: '/somewhere/else/crates/stray' },
        ],
      },
      '*': null,
    },
  })
  const nested = calls.filter(c => c.label === 'workflow')
  const paths = nested.map(c => c.argv[1].path).sort()
  assert.deepEqual(paths, ['crates/api', 'crates/core'],
    'every crate path that reaches the child must be repo-relative — an absolute one is refused by the child, which zeroes the per-crate measurement')
  assert.equal(nested.length, 2, 'and the crate whose path cannot be relativized must not be dispatched at all')
  assert.ok(logs.some(l => /stray/.test(l) && /NOT RUN/.test(l)),
    'an unrelativizable crate is reported NOT RUN, never reviewed unscoped under its own label')
})
