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
  assert.equal(loggerPrelude('/a/craft'), "CRAFT_LOGGER='/a/craft'/lib/craft-log-run.mjs\n")
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
