import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { LOGRUN_SCHEMA, shq, loggerPrelude, logRunPrompt, logRunDispatch, logRunOutcome, quietly, checkpointPrompt } from './run-logging.mjs'
import { RECORD_FILING_FILES } from './engine-harness.mjs'
import { ENGINE_REVISION } from './run-record.mjs'
import { filesRunRecord } from './workflow-version.mjs'
import { findRegions } from './inline-regions.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOGGER = path.join(ROOT, 'lib', 'craft-log-run.mjs')

// The record shapes the four engines actually file (trimmed to the fields the write path touches).
const ENGINE_RECORDS = {
  review: {
    schemaVersion: 1, runtime: 'claude-code', craftVersion: '0.17.0', kind: 'workflow', name: 'review',
    nested: false, via: null, verdict: 'Approve', findings: { total: 0, bySeverity: {} },
    dimensions: [], verification: null, notRun: [], outputTokens: 10,
  },
  'adversarial-review': {
    schemaVersion: 1, runtime: 'claude-code', craftVersion: '0.17.0', kind: 'workflow', name: 'adversarial-review',
    nested: false, via: null, verdict: 'Approve', findings: { total: 0, bySeverity: {} },
    scout: { size: 'small', lenses: [] }, dimensions: [], verification: { candidates: 0, confirmed: 0, refuteRate: 0 },
    notRun: [], outputTokens: 10,
  },
  'rust-audit': {
    schemaVersion: 1, runtime: 'claude-code', craftVersion: '0.17.0', kind: 'workflow', name: 'rust-audit',
    nested: false, via: null, verdict: 'Approve', findings: { total: 0, bySeverity: {} },
    dimensions: [], verification: null, notRun: [], couldNotRun: [], outputTokens: 10,
  },
  'triage-findings': {
    schemaVersion: 1, runtime: 'claude-code', craftVersion: '0.17.0', kind: 'workflow', name: 'triage-findings',
    nested: false, via: null, verdict: '', findings: { total: 0, bySeverity: {} },
    sources: [], triage: { gathered: 0 }, notRun: [],
  },
}

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-repo-'))
  const real = fs.realpathSync(dir)
  execFileSync('git', ['init', '-q'], { cwd: real })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: real })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: real })
  fs.writeFileSync(path.join(real, 'a.txt'), 'hello\n')
  execFileSync('git', ['add', 'a.txt'], { cwd: real })
  execFileSync('git', ['commit', '-qm', 'init', '--no-gpg-sign'], { cwd: real })
  return real
}

// The shell command the logger agent is told to run, lifted out of the prompt exactly as it stands
// there. If the prompt ever stops carrying a runnable command, this yields nothing and every test
// below fails — which is the point: a prose recipe is not a command.
function loggerCommand(prompt) {
  const line = prompt.split('\n').find(l => l.includes('node "$CRAFT_LOGGER"'))
  assert.ok(line, 'the prompt carries no `node "$CRAFT_LOGGER"` command')
  return line
}

// The WHOLE fenced block, staging included — not just the `node` line. Lifting out one line is how a
// hardcoded `/tmp/craft-rec.json` survived: the test never ran the `cat >` that used it, so nothing
// pinned the transport. The record is substituted for the placeholder the prompt leaves in the
// heredoc, which is exactly what the logger agent is told to do.
function loggerScript(prompt, record) {
  const lines = prompt.split('\n')
  const open = lines.findIndex(l => l.trim() === '```')
  assert.ok(open >= 0, 'the prompt carries no fenced command block')
  const close = lines.findIndex((l, k) => k > open && l.trim() === '```')
  assert.ok(close > open, 'the fenced command block is not closed')
  const body = lines.slice(open + 1, close)
  const placeholder = body.findIndex(l => /(RECORD|PAYLOAD) below, byte for byte/.test(l))
  assert.ok(placeholder >= 0, 'the heredoc carries no record/payload placeholder')
  body[placeholder] = JSON.stringify(record)
  return body.join('\n')
}

// Run the prompt's own block the way the logger agent would, into a temp store.
function runPrompt(prompt, { repo, store, record }) {
  fs.mkdirSync(store, { recursive: true })
  const script = loggerScript(prompt, record).replace('--project "$PWD"', `--store ${shq(store)} --project "$PWD"`)
  return execFileSync('bash', ['-c', script], { cwd: repo, encoding: 'utf8' })
}

function readBack(store) {
  const detail = fs.readdirSync(store).filter(f => f.endsWith('.json') && f !== 'in.json')
  assert.equal(detail.length, 1, `expected exactly one detail record, got ${detail.join(', ')}`)
  const index = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n')
  assert.equal(index.length, 1)
  return { record: JSON.parse(fs.readFileSync(path.join(store, detail[0]), 'utf8')), index: JSON.parse(index[0]) }
}

// ---- the write path, executed --------------------------------------------------------------
for (const [engine, raw] of Object.entries(ENGINE_RECORDS)) {
  test(`${engine}: its record goes through the script and comes back stamped`, () => {
    const repo = tmpRepo()
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-store-'))
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

    runPrompt(logRunPrompt({ record: raw, craftRoot: ROOT, repo }), { repo, store, record: raw })
    const { record, index } = readBack(store)

    // The fact this whole change exists for: no engine can stamp this from a prompt, at any quality
    // of instruction, and analyze-runs buckets a record without it into `r?`.
    assert.equal(record.engineRevision, ENGINE_REVISION)
    assert.equal(record.project, repo)              // NOT the store, and not the logger agent's cwd
    assert.equal(record.commit, head)               // a real commit, not ''
    assert.equal(record.dirty, false)
    assert.equal(record.name, raw.name)
    assert.equal(index.project, repo)
    assert.equal(index.commit, head)
    assert.ok(record.craftCommit === null || typeof record.craftCommit === 'string')
  })
}

test('the record survives the round trip verbatim — big arrays included', () => {
  const repo = tmpRepo()
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-store-'))
  const raw = {
    ...ENGINE_RECORDS['adversarial-review'],
    dimensions: Array.from({ length: 40 }, (_, i) => ({ dimension: `lens${i}`, findingCount: i })),
  }
  runPrompt(logRunPrompt({ record: raw, craftRoot: ROOT, repo }), { repo, store, record: raw })
  assert.equal(readBack(store).record.dimensions.length, 40)
})

test('a project keyed to the store itself is impossible — --project is $PWD, the reviewed repo', () => {
  const repo = tmpRepo()
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-store-'))
  const prompt = logRunPrompt({ record: ENGINE_RECORDS.review, craftRoot: ROOT, repo })
  const cmd = loggerCommand(prompt)
  assert.match(cmd, /cd '.+' && node "\$CRAFT_LOGGER"/)
  assert.match(cmd, /--project "\$PWD"/)
  runPrompt(prompt, { repo, store, record: ENGINE_RECORDS.review })
  assert.notEqual(readBack(store).record.project, store)
})

// ---- a failed write is asserted, not inferred ------------------------------------------------
test('a script failure surfaces as a FAILED line the agent must report', () => {
  const repo = tmpRepo()
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-store-'))
  fs.mkdirSync(store, { recursive: true })
  fs.writeFileSync(path.join(store, 'in.json'), 'not json at all')
  let out = ''
  try {
    execFileSync('bash', ['-c', `node ${shq(LOGGER)} write --store ${shq(store)} --project ${shq(repo)} < ${shq(path.join(store, 'in.json'))}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    out = String(e.stderr || '')
  }
  assert.match(out, /^craft-log-run FAILED/m)
  assert.ok(!fs.existsSync(path.join(store, 'index.jsonl')), 'a failed write must leave no index line')
})

test('logRunOutcome: only an explicit ok:true counts as landed', () => {
  assert.deepEqual(logRunOutcome({ ok: true }), { ok: true, reason: '' })
  assert.equal(logRunOutcome({ ok: false, error: 'craft-log-run FAILED: boom' }).ok, false)
  assert.equal(logRunOutcome({ ok: false, error: 'craft-log-run FAILED: boom' }).reason, 'craft-log-run FAILED: boom')
  assert.equal(logRunOutcome(null).reason, 'the logger agent returned no result')
  assert.equal(logRunOutcome({}).reason, 'the logger agent returned no result')       // malformed = not vouched for
  assert.equal(logRunOutcome({ ok: 'yes' }).ok, false)
  assert.equal(logRunOutcome({ __threw: 'budget exceeded' }).reason, 'budget exceeded')
})

test('quietly: a throw from the logger becomes a reportable result, never an abort', async () => {
  const wrapped = quietly(async () => { throw new Error('budget exceeded') })
  const res = await wrapped('p', {})
  assert.deepEqual(res, { __threw: 'budget exceeded' })
  assert.equal(logRunOutcome(res).ok, false)
  assert.equal(logRunOutcome(res).reason, 'budget exceeded')
  assert.deepEqual(await quietly(async () => ({ ok: true }))('p', {}), { ok: true })
})

test('logRunDispatch sizes the model to the payload and always asserts the outcome', () => {
  const small = logRunDispatch({ a: 1 }, { phase: 'Synthesize' })
  assert.equal(small.model, 'haiku')
  assert.equal(small.label, 'log-run')
  assert.equal(small.phase, 'Synthesize')
  assert.equal(small.schema, LOGRUN_SCHEMA)
  const big = logRunDispatch({ a: 'x'.repeat(40 * 1024) })
  assert.equal(big.model, 'sonnet')
  assert.match(big.label, /^log-run \(\d+KB\)$/)
})

test('loggerPrelude resolves the logger BEFORE any cd', () => {
  // The PROPERTY, not the old one-liner. Pinning `CRAFT_LOGGER='/a/craft'/lib/…` as correct was the
  // gate defending the unguarded shape: that spelling was an early return which skipped both the
  // absoluteness check and the refusal, so the assertion certified the hole.
  const explicit = loggerPrelude('/a/craft', '1.0.0')
  assert.match(explicit, /\/a\/craft/, 'an explicit root is still consulted')
  assert.match(explicit, /case "\$CRAFT_TRY" in \/\*\)/, 'and it goes through the same absoluteness check as every other source')
  assert.match(explicit, /craft-log-run FAILED/, 'and can still reach the refusal')
  assert.match(loggerPrelude(''), /CLAUDE_PLUGIN_ROOT/)
  // the prelude line precedes the `cd` in the emitted command block
  const p = logRunPrompt({ record: {}, craftRoot: '/a/craft', repo: '/b/repo' })
  assert.ok(p.indexOf('CRAFT_LOGGER=') < p.indexOf('cd '))
})

test('finalize mode is available for the engine that checkpoints, write for the rest', () => {
  assert.match(loggerCommand(logRunPrompt({ record: {}, command: 'finalize', dir: '/d/run' })), /finalize --dir '\/d\/run' --project/)
  assert.match(loggerCommand(logRunPrompt({ record: {}, command: 'finalize', rejoin: true })), /finalize --rejoin --project/)
  assert.match(loggerCommand(logRunPrompt({ record: {} })), /"\$CRAFT_LOGGER" write --project/)
})

// ---- the tripwire: no engine may fall out of the unified path -------------------------------
const WORKFLOW_DIR = path.join(ROOT, 'workflows')
const workflowSources = fs.readdirSync(WORKFLOW_DIR).filter(f => f.endsWith('.js'))
  .map(f => ({ name: f, src: fs.readFileSync(path.join(WORKFLOW_DIR, f), 'utf8') }))
const RECORD_FILING = RECORD_FILING_FILES

test('every record-filing engine is still visible to the CRAFT_VERSION gate', () => {
  // TWO INDEPENDENT SIGNALS, and that independence is the whole value of this test. The gate in
  // workflow-version.mjs derives its set by matching `logRun(` — a NAME. The roster derives its set
  // by which shared source an engine inlines — a STRUCTURE. Comparing a name-derived set against a
  // literal list was the old shape; comparing it against another name-derived set would be a
  // tautology that moves with any rename. Against the structural one it bites: rename `logRun` to
  // `fileRun` in any engine and the gate stops seeing it while the roster still does, so the two
  // sets disagree here — which is exactly the silent drop-out this test exists to prevent.
  const seen = workflowSources.filter(f => filesRunRecord(f.src)).map(f => f.name).sort()
  assert.deepEqual(seen, [...RECORD_FILING].sort())
})

test('every record-filing engine routes its write through lib/run-logging.mjs', () => {
  for (const name of RECORD_FILING) {
    const src = workflowSources.find(f => f.name === name).src
    const named = findRegions(src).filter(r => r.source === 'lib/run-logging.mjs').flatMap(r => r.names)
    assert.ok(named.includes('logRunPrompt'), `${name} does not inline logRunPrompt from lib/run-logging.mjs`)
    assert.ok(named.includes('LOGRUN_SCHEMA'), `${name} does not inline LOGRUN_SCHEMA — a failed write would be inferred, not asserted`)
  }
})

test('no engine still carries the prose write recipe', () => {
  for (const { name, src } of workflowSources) {
    assert.ok(!/mkdir -p ~\/\.craft\/runs/.test(src), `${name} still tells a model to mkdir the store — the cwd that produced a record keyed to ~/.craft/runs`)
    assert.ok(!/date -u \+%Y/.test(src), `${name} still tells a model to compute ts itself`)
    // index.jsonl may only appear as a PROHIBITION now ("do NOT append to index.jsonl by hand"),
    // never as an instruction to write it.
    assert.ok(!/append it as ONE compact line/.test(src), `${name} still tells a model to write the index line`)
  }
})

test('indexProjection is no longer mirrored into any engine — the script owns the index line', () => {
  for (const { name, src } of workflowSources) {
    assert.ok(!/function indexProjection/.test(src), `${name} still mirrors indexProjection, which nothing there calls`)
  }
})

// The staging file must be per-run. A fixed `/tmp/craft-rec.json` was one engine's private detail;
// extracting the prompt would have propagated it to all four — three defects at once: `cat >` follows
// a symlink another local uid can pre-create (arbitrary overwrite; the sticky bit does not stop
// CREATING an entry), the record holds every finding title and quoted snippet from the reviewed repo
// under a default umask, and a fixed name carries no run id while rust-audit fans out nested reviews
// through `parallel` — so one run can file another's record under its own identity, with the script
// succeeding, the readback verifying and `{ok:true}` coming back. Nothing would report a loss.
test('the record is staged through a per-run temp file, not a fixed path', () => {
  const prompts = [
    logRunPrompt({ record: { kind: 'workflow', name: 'review' }, command: 'write' }),
    logRunPrompt({ record: { kind: 'workflow', name: 'review' }, command: 'finalize', dir: '/x' }),
  ]
  for (const p of prompts) {
    assert.ok(!/\/tmp\/craft-\w+\.json/.test(loggerScript(p, {})), 'no fixed staging path may reach the command')
    assert.match(loggerScript(p, {}), /mktemp/, 'the staging file must be minted per run')
    assert.match(loggerScript(p, {}), /rm -f/, 'and removed — the record is not left readable in a shared directory')
    // The write's exit code must survive the cleanup, or a failed write reports as a success.
    assert.match(loggerScript(p, {}), /CRAFT_RC=\$\?[\s\S]*exit \$CRAFT_RC/)
  }
})

test('two runs staging at the same moment do not share a file', () => {
  // Executed, because the property is about the shell, not about the string.
  const script = loggerScript(logRunPrompt({ record: { kind: 'workflow', name: 'review' } }), { a: 1 })
    .split('\n').filter(l => l.includes('mktemp')).join('\n') + '\necho "$CRAFT_REC"'
  const one = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim()
  const two = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim()
  assert.notEqual(one, two, 'each run must get its own staging file')
  for (const f of [one, two]) if (fs.existsSync(f)) fs.rmSync(f)
})

test('the checkpoint prompt is the same builder, and emits what it is asked to', () => {
  // It was a hand-copy of the record prompt, so every fix to the shared path — the staged file, the
  // prelude ordering, the exit-code carry — had to be applied twice, and the copy was the one nearly
  // missed each time. Same builder now; these pin the one difference and the armed flag.
  const armed = loggerScript(checkpointPrompt({ payload: { kind: 'workflow', name: 'review' }, phase: 'rust-lenses', rejoin: true, craftRoot: '/opt/craft' }), {})
  assert.match(armed, /checkpoint --phase 'rust-lenses' --rejoin /)
  assert.ok(!/--dir /.test(armed), 'a rejoin is asked for only when there is no directory to name')

  const pinned = loggerScript(checkpointPrompt({ payload: {}, phase: 'rust-verify', dir: '/s/.partial/x', rejoin: true, craftRoot: '/opt/craft' }), {})
  assert.match(pinned, /--dir '\/s\/\.partial\/x' /)
  assert.ok(!/--rejoin/.test(pinned), 'naming a directory and asking to search for one are exclusive')

  // Same discipline as the record prompt: resolve first, stage per run, carry the exit code past
  // the cleanup — the properties that had to be fixed twice while there were two copies.
  assert.ok(armed.indexOf('CRAFT_LOGGER=') < armed.indexOf('mktemp'), 'the logger resolves before anything is staged')
  assert.match(armed, /mktemp/)
  assert.match(armed, /CRAFT_RC=\$\?[\s\S]*rm -f[\s\S]*exit \$CRAFT_RC/)
})

test('with no craftRoot and no CLAUDE_PLUGIN_ROOT the block fails loudly and stages nothing', () => {
  // The loud failure replaced a `${CLAUDE_PLUGIN_ROOT:-.}` fallback that resolved BEFORE the cd, i.e.
  // against the repository under review — a repo shipping its own lib/craft-log-run.mjs would have
  // been executed. `:?` is a hard abort, so the prelude must come first: after the staging it killed
  // the block before `rm -f` and left the whole record sitting in TMPDIR.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-tmpdir-'))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-home-'))
  const script = loggerScript(logRunPrompt({ record: { kind: 'workflow', name: 'review', craftVersion: '9.9.9' } }), { a: 1 })
  assert.ok(script.indexOf('CRAFT_LOGGER=') < script.indexOf('mktemp'), 'resolve before staging, or the abort leaks the record')
  let failed = false
  try {
    // An empty HOME: no installed copy to find, so the search falls through to the refusal. Without
    // pinning HOME this test would pass or fail depending on what is installed on the machine
    // running it, which is not a test.
    execFileSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, TMPDIR: tmp, HOME: home } })
  } catch (e) {
    failed = true
    assert.match(String(e.stdout || '') + String(e.stderr || ''), /craft-log-run FAILED/)
  }
  assert.ok(failed, 'it must fail rather than resolve the logger against the reviewed repository')
  assert.deepEqual(fs.readdirSync(tmp), [], 'and nothing may be left staged in TMPDIR')
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

test('an installed copy of THIS version is found when the environment says nothing', () => {
  // The defect this closes was measured, not imagined: an installed plugin ran with
  // CLAUDE_PLUGIN_ROOT unset in the logger agent's shell, the prelude refused, and the store gained
  // nothing at all — invisibly, since it stays full of older runs. Executed rather than matched,
  // because what is being claimed is that a real shell resolves a real path.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-home-'))
  const installed = path.join(home, '.claude', 'plugins', 'cache', 'craft', 'craft', '7.7.7', 'lib')
  fs.mkdirSync(installed, { recursive: true })
  fs.writeFileSync(path.join(installed, 'craft-log-run.mjs'), '// stand-in\n')
  const prelude = loggerPrelude('', '7.7.7')
  const out = execFileSync('bash', ['-c', `${prelude}echo "$CRAFT_LOGGER"`], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } })
  assert.equal(out.trim(), path.join(installed, 'craft-log-run.mjs'), 'the engine must find its own installed copy')

  // And only its OWN version: a 7.7.7 engine must not log through some other build's script, which
  // would file records describing a run that build never made.
  const other = loggerPrelude('', '8.8.8')
  let refused = false
  try {
    execFileSync('bash', ['-c', `${other}echo "$CRAFT_LOGGER"`], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } })
  } catch { refused = true }
  assert.ok(refused, 'a version with no installed copy must refuse rather than borrow another')
  fs.rmSync(home, { recursive: true, force: true })
})

test('only a VERSION-PINNED copy may be found — never an unpinned checkout', () => {
  // The marketplace directory was a second candidate for exactly one commit, and it is a git clone
  // tracking the marketplace rather than a versioned release. On a machine whose clone had moved on,
  // an engine stamped 0.18.0 would have executed a NEWER script — which stamps engineRevision and
  // craftCommit from its own build — while the record body said 0.18.0. A record misdescribing which
  // engine ran is worse than no record, because it is counted. So: a plausible unpinned copy present
  // and the pinned one absent must still refuse.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-home-'))
  for (const rel of ['plugins/marketplaces/craft/lib', 'plugins/cache/craft/craft/1.1.1/lib']) {
    const d = path.join(home, '.claude', rel)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'craft-log-run.mjs'), '// wrong build\n')
  }
  let refused = false
  try {
    execFileSync('bash', ['-c', `${loggerPrelude('', '2.2.2')}echo "$CRAFT_LOGGER"`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home },
    })
  } catch { refused = true }
  assert.ok(refused, 'a copy that is not this exact version must never be borrowed')
  fs.rmSync(home, { recursive: true, force: true })
})

test('a session with CLAUDE_CONFIG_DIR set is searched where its plugins actually live', () => {
  // Hardcoding ~/.claude would leave that user with the defect unfixed and no sign of it: the search
  // simply never fires, the refusal is correct, and nothing says why.
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-cfg-'))
  const d = path.join(cfg, 'plugins', 'cache', 'craft', 'craft', '3.3.3', 'lib')
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'craft-log-run.mjs'), '// stand-in\n')
  const out = execFileSync('bash', ['-c', `${loggerPrelude('', '3.3.3')}echo "$CRAFT_LOGGER"`], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/tmp/nonexistent-home', CLAUDE_CONFIG_DIR: cfg },
  })
  assert.equal(out.trim(), path.join(d, 'craft-log-run.mjs'))
  fs.rmSync(cfg, { recursive: true, force: true })
})

test('a RELATIVE config dir is refused, or the reviewed repository is a candidate again', () => {
  // The hole the `:-.` removal closed, re-entering by another door. `[ -f ]` is evaluated in the
  // logger agent's cwd, but `node "$CRAFT_LOGGER"` runs AFTER the cd into the reviewed repository —
  // so a relative candidate resolves THERE. A project-local CLAUDE_CONFIG_DIR plus a hostile repo
  // shipping .claude/plugins/cache/craft/craft/<version>/lib/craft-log-run.mjs (the version is
  // public in the manifest) would execute that repo's script with the user's privileges.
  // Executed with a real relative value, because the relative-ness arrives from the ENVIRONMENT and
  // can never appear as a literal in the emitted string — no amount of matching the prelude text
  // could see this.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-cwd-'))
  const planted = path.join(cwd, 'evil', 'plugins', 'cache', 'craft', 'craft', '4.4.4', 'lib')
  fs.mkdirSync(planted, { recursive: true })
  fs.writeFileSync(path.join(planted, 'craft-log-run.mjs'), '// hostile\n')
  let refused = false
  try {
    execFileSync('bash', ['-c', `${loggerPrelude('', '4.4.4')}echo "$CRAFT_LOGGER"`], {
      encoding: 'utf8', cwd, env: { PATH: process.env.PATH, HOME: '/tmp/nonexistent-home', CLAUDE_CONFIG_DIR: 'evil' },
    })
  } catch { refused = true }
  assert.ok(refused, 'a non-absolute config dir must be refused, not resolved against the working directory')
  fs.rmSync(cwd, { recursive: true, force: true })
})

test('EVERY way of naming the logger is refused when it is not absolute', () => {
  // The absoluteness rule reached one source of three: an explicit craftRoot returned EARLY, before
  // the check and before the refusal. craftRoot arrives in the model-composed args string, so
  // `craftRoot=.` against an untrusted repo shipping lib/craft-log-run.mjs restored the removed
  // `:-.` hole verbatim — and bypassed the version pin and the loud refusal with it. Executed from
  // inside a planted repo, because that cwd is the whole mechanism: `[ -f ]` runs there, `node` runs
  // there after the cd.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-evil-'))
  fs.mkdirSync(path.join(repo, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'lib', 'craft-log-run.mjs'), '// hostile\n')
  const cases = [
    ['explicit craftRoot', loggerPrelude('.', '1.0.0'), {}],
    ['explicit craftRoot climbing out', loggerPrelude('..', '1.0.0'), {}],
    ['relative CLAUDE_PLUGIN_ROOT', loggerPrelude('', '1.0.0'), { CLAUDE_PLUGIN_ROOT: '.' }],
    ['relative CLAUDE_CONFIG_DIR', loggerPrelude('', '1.0.0'), { CLAUDE_CONFIG_DIR: 'evil' }],
  ]
  for (const [what, prelude, extraEnv] of cases) {
    let refused = false
    try {
      execFileSync('bash', ['-c', `${prelude}echo "$CRAFT_LOGGER"`], {
        encoding: 'utf8', cwd: repo,
        env: { PATH: process.env.PATH, HOME: '/tmp/nonexistent-home', ...extraEnv },
      })
    } catch { refused = true }
    assert.ok(refused, `${what}: a non-absolute path must be refused, never resolved in the reviewed repository`)
  }
  fs.rmSync(repo, { recursive: true, force: true })
})

test('an absolute craftRoot that names no file is refused rather than run', () => {
  // The early return also skipped the `[ -f ]`: a craftRoot pointing at nothing emitted a command
  // that ran `node` on a path which does not exist, so the failure arrived as a module-not-found
  // from node rather than as the marker the engines turn into their telemetry banner.
  let refused = false
  let output = ''
  try {
    output = execFileSync('bash', ['-c', `${loggerPrelude('/nonexistent/craft', '1.0.0')}echo "$CRAFT_LOGGER"`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/tmp/nonexistent-home' },
    })
  } catch (e) {
    refused = true
    output = String(e.stdout || '') + String(e.stderr || '')
  }
  assert.ok(refused, 'a craftRoot naming no logger must refuse')
  assert.match(output, /craft-log-run FAILED/, 'and refuse by the marker the engines report')
})

test('a version that would break out of the shell string cannot', () => {
  // Interpolated with its quotes stripped for one commit, which made this execution. Unreachable
  // today — every craftVersion traces to the release-please literal — but the invariant was stated
  // and false, and a version sourced from anywhere else would land as command injection.
  // `1.0.0; echo PWNED; :` is the payload that matters and it was MISSING: with the quoting stripped
  // the other three are inert — the `"` one opens a quote that swallows to the next `"`, and the two
  // substitutions have their output ASSIGNED rather than printed. So the set held while the invariant
  // it names was broken. A falsifier that cannot go red is the same defect as an assertion that
  // cannot fail, one layer out.
  for (const hostile of ['1.0.0; echo PWNED; :', '1.0.0"; echo PWNED; #', '$(echo PWNED)', '`echo PWNED`']) {
    let out = ''
    try {
      out = execFileSync('bash', ['-c', `${loggerPrelude('', hostile)}echo "resolved=$CRAFT_LOGGER"`], {
        encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/tmp/nonexistent-home' },
      })
    } catch (e) { out = String(e.stdout || '') + String(e.stderr || '') }
    // A line that IS the word distinguishes execution from mention: the refusal message quotes the
    // version back verbatim, so a naive /PWNED/ match calls the safe case a breach — which it did,
    // and cost a round of chasing a hole that was not there.
    assert.ok(
      !out.split('\n').some(l => l.trim() === 'PWNED'),
      `a version must never execute: ${hostile}`,
    )
  }
})

test('the checkpoint builder derives its version from the payload, not from a caller who may forget', () => {
  // As a plumbing argument with a silent default it was forgettable, and was duly forgotten at one of
  // three call sites: every gate stayed green while that engine's checkpoints refused exactly as
  // before the fix, with finalize and prior-round succeeding beside them.
  const withVersion = checkpointPrompt({ payload: { kind: 'workflow', name: 'review', craftVersion: '5.5.5' }, phase: 'p' })
  assert.match(withVersion, /plugins\/cache\/craft/, 'a payload carrying a version yields the search block')
  assert.match(withVersion, /5\.5\.5/, 'and searches for that version')
  const without = checkpointPrompt({ payload: { kind: 'workflow', name: 'review' }, phase: 'p' })
  assert.ok(!/plugins\/cache\/craft/.test(without), 'and no version means no search rather than a wrong one')
})

test('the environment wins over the search when it resolves', () => {
  // The search is a fallback, not an override. Written the other way round, it overwrote a good path
  // from CLAUDE_PLUGIN_ROOT with whatever the cache held — a launch from a checkout would then have
  // logged through some other installed version without a word.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-home-'))
  const cached = path.join(home, '.claude', 'plugins', 'cache', 'craft', 'craft', '7.7.7', 'lib')
  const envRoot = path.join(home, 'checkout', 'lib')
  for (const d of [cached, envRoot]) {
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'craft-log-run.mjs'), '// stand-in\n')
  }
  const out = execFileSync('bash', ['-c', `${loggerPrelude('', '7.7.7')}echo "$CRAFT_LOGGER"`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_ROOT: path.dirname(envRoot) },
  })
  assert.equal(out.trim(), path.join(envRoot, 'craft-log-run.mjs'), 'the environment must not be overridden by the search')
  fs.rmSync(home, { recursive: true, force: true })
})
