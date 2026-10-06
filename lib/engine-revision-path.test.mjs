// The engine's revision on its way to the store (realm @nick/craft, node #114). It decides which
// fingerprint basis a later round reads this one under, and the record and checkpoint payloads it rides
// in are re-emitted by a logger AGENT. So the engine also writes it into the command line it builds, and
// craft-log-run files it only when the two copies agree: a logger that alters either cannot file a
// known — and wrong — basis, only an unknown one, which the engine reports as lost memory.
import { test, onTestFinished } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { logRunPrompt, checkpointPrompt, shq } from './run-logging.mjs'
import { run, priorBasisVerdict, rawCheckpointRevisions, readCheckpoints, settleEngineRevision } from './craft-log-run.mjs'
import { ENGINE_REVISION } from './run-record.mjs'
import { runEngine, RECORD_FILING_ENGINES } from './engine-harness.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// A revision on a DIFFERENT, known basis from this engine's (FP_BASIS_SINCE [1, 3]): filed as if real,
// a later round would read the prior's tombstones as a basis change rather than as lost memory.
const ALTERED = 2

const tmp = (/** @type {string} */ prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function tmpRepo() {
  const repo = tmp('craft-rev-repo-')
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  for (const args of [['init', '-q'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']]) {
    execFileSync('git', args, { cwd: repo, env })
  }
  return repo
}

const RECORD = {
  schemaVersion: 1, runtime: 'claude-code', craftVersion: '0.17.0', kind: 'workflow', name: 'review',
  nested: false, via: null, verdict: 'Approve', findings: { total: 0, bySeverity: {} }, dimensions: [],
  workflowEngineRevision: ENGINE_REVISION,
}

// The prompt's own fenced block, run the way the logger agent runs it — with `copied` in the heredoc,
// which is what the agent actually re-emitted, and `edit` applied to the command it actually typed.
/** @param {string} prompt @param {unknown} copied @param {string} repo @param {string} store @param {(s: string) => string} [edit] */
function runBlock(prompt, copied, repo, store, edit = s => s) {
  const lines = prompt.split('\n')
  const open = lines.findIndex(l => l.trim() === '```')
  const close = lines.findIndex((l, k) => k > open && l.trim() === '```')
  assert.ok(open >= 0 && close > open, 'the prompt carries a fenced command block')
  const body = lines.slice(open + 1, close).map(l => /(RECORD|PAYLOAD) below, byte for byte/.test(l) ? JSON.stringify(copied) : l)
  const script = edit(body.join('\n')).replace('--project "$PWD"', `--store ${shq(store)} --project "$PWD"`)
  const r = spawnSync('bash', ['-c', script], { cwd: repo, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r
}

/** @param {string} store */
function filed(store) {
  const [file] = fs.readdirSync(store).filter(f => f.endsWith('.json'))
  assert.ok(file, 'a record was filed')
  return JSON.parse(fs.readFileSync(path.join(store, file), 'utf8'))
}

/** @param {'write' | 'finalize'} command @param {unknown} copied @param {(s: string) => string} [edit] */
function fileRecord(command, copied, edit) {
  const repo = tmpRepo()
  const store = tmp('craft-rev-store-')
  const r = runBlock(logRunPrompt({ record: RECORD, craftRoot: ROOT, repo, command }), copied, repo, store, edit)
  return { record: filed(store), stderr: r.stderr }
}

/** @param {unknown} copied @param {(s: string) => string} [edit] */
function fileCheckpoint(copied, edit) {
  const repo = tmpRepo()
  const store = tmp('craft-rev-store-')
  const r = runBlock(checkpointPrompt({ payload: RECORD, craftRoot: ROOT, repo, phase: 'gate' }), copied, repo, store, edit)
  return { phases: readCheckpoints(JSON.parse(r.stdout.trim().split('\n').pop() || '{}').runDir), stderr: r.stderr }
}

const NOTHING = { priorFpRevisions: [], priorFpRevisionsCheck: '', sameFpBasis: false, fpBasisKnown: false }
const pick = (/** @type {Record<string, unknown>} */ v) => ({ priorFpRevisions: v['priorFpRevisions'], priorFpRevisionsCheck: v['priorFpRevisionsCheck'], sameFpBasis: v['sameFpBasis'], fpBasisKnown: v['fpBasisKnown'] })

for (const command of /** @type {const} */ (['write', 'finalize'])) {
  test(`${command}: a logger that alters the revision in the record it copies files no basis, never a wrong one`, () => {
    const { record, stderr } = fileRecord(command, { ...RECORD, workflowEngineRevision: ALTERED })
    assert.deepEqual(pick(priorBasisVerdict(record)), NOTHING)
    assert.match(stderr, /craft-log-run WARNING: the engine revision arrived altered/)
  })

  test(`${command}: a logger that alters the revision on the command line files no basis either`, () => {
    const { record } = fileRecord(command, RECORD, s => s.replace(`--engine-revision ${ENGINE_REVISION} `, `--engine-revision ${ALTERED} `))
    assert.deepEqual(pick(priorBasisVerdict(record)), NOTHING)
  })

  test(`${command}: a logger that drops the revision from the record it copies files no basis`, () => {
    const dropped = Object.fromEntries(Object.entries(RECORD).filter(([k]) => k !== 'workflowEngineRevision'))
    assert.deepEqual(pick(priorBasisVerdict(fileRecord(command, dropped).record)), NOTHING)
  })

  test(`${command}: a logger that injects recovery-only fields cannot file a basis through them`, () => {
    for (const injected of [{ partial: true, runEngineRevision: ALTERED }, { partial: true, phases: [{ workflowEngineRevision: ALTERED }] }]) {
      const { record, stderr } = fileRecord(command, { ...RECORD, ...injected })
      assert.deepEqual(pick(priorBasisVerdict(record)), NOTHING, JSON.stringify(injected))
      assert.match(stderr, /recovery-only/)
    }
  })

  test(`${command}: an honest copy keeps the engine's revision, and its basis`, () => {
    const { record, stderr } = fileRecord(command, RECORD)
    assert.equal(record.workflowEngineRevision, ENGINE_REVISION)
    assert.deepEqual(pick(priorBasisVerdict(record)), { priorFpRevisions: [ENGINE_REVISION], priorFpRevisionsCheck: String(ENGINE_REVISION), sameFpBasis: true, fpBasisKnown: true })
    assert.doesNotMatch(stderr, /arrived altered/)
  })
}

test('checkpoint: a logger that alters the revision in the payload it copies leaves a slice that attests to nothing', () => {
  const { phases, stderr } = fileCheckpoint({ ...RECORD, workflowEngineRevision: ALTERED })
  assert.equal(phases.length, 1)
  assert.deepEqual(rawCheckpointRevisions(phases), [])
  assert.match(stderr, /craft-log-run WARNING: the engine revision arrived altered/)
})

test('checkpoint: a logger that alters the revision on the command line leaves a slice that attests to nothing', () => {
  const { phases } = fileCheckpoint(RECORD, s => s.replace(`--engine-revision ${ENGINE_REVISION} `, `--engine-revision ${ALTERED} `))
  assert.deepEqual(rawCheckpointRevisions(phases), [])
})

test('checkpoint: an honest copy attests to the engine\'s revision', () => {
  assert.deepEqual(rawCheckpointRevisions(fileCheckpoint(RECORD).phases), [ENGINE_REVISION])
})

test('settleEngineRevision: only an integer flag equal to the payload\'s integer revision is accepted', () => {
  /** @type {string[]} */
  const w = []
  assert.deepEqual(settleEngineRevision({ workflowEngineRevision: 4 }, '4', w), { workflowEngineRevision: 4 })
  assert.deepEqual(w, [])
  for (const [payload, flag] of /** @type {Array<[Record<string, unknown>, string]>} */ ([
    [{ workflowEngineRevision: '4' }, '4'], [{ workflowEngineRevision: 4 }, '4.0'], [{ workflowEngineRevision: 4 }, ' 4'],
    [{ workflowEngineRevision: 4 }, '--project'], [{}, '4'], [{ workflowEngineRevision: 4 }, ''],
  ])) {
    const out = settleEngineRevision(payload, flag, w)
    assert.ok(!('workflowEngineRevision' in out), JSON.stringify([payload, flag]))
    assert.deepEqual(out['workflowEngineRevisionDisputed'], { argv: flag, payload: payload['workflowEngineRevision'] ?? null })
  }
  assert.equal(w.length, 6)
})

test('an invocation without the flag — an older engine, or one that stamps no basis — files the payload as before', async () => {
  const store = tmp('craft-rev-store-')
  const dir = tmp('craft-rev-dir-')
  const r = await run(['write', '--store', store, '--project', dir], process.env, dir, () => JSON.stringify({ ...RECORD, workflowEngineRevision: 3 }))
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  assert.equal(filed(store).workflowEngineRevision, 3)
  assert.ok(!('workflowEngineRevisionDisputed' in filed(store)))
  assert.doesNotMatch(logRunPrompt({ record: {} }), /--engine-revision/)
  assert.doesNotMatch(checkpointPrompt({ payload: { workflowEngineRevision: '4' } }), /--engine-revision/)
})

test('a flag the command line lost its value from is a dispute, not an older engine', async () => {
  const store = tmp('craft-rev-store-')
  const dir = tmp('craft-rev-dir-')
  const r = await run(['write', '--store', store, '--project', dir, '--engine-revision'], process.env, dir, () => JSON.stringify(RECORD))
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  assert.deepEqual(pick(priorBasisVerdict(filed(store))), NOTHING)
  assert.deepEqual(filed(store).workflowEngineRevisionDisputed, { argv: '', payload: ENGINE_REVISION })
})

test('readers: a disputed record or slice establishes no basis, whatever the logger\'s own stamp says', () => {
  const disputed = { workflowEngineRevisionDisputed: { argv: '4', payload: ALTERED } }
  assert.deepEqual(pick(priorBasisVerdict({ engineRevision: ENGINE_REVISION, ...disputed })), NOTHING)
  assert.deepEqual(rawCheckpointRevisions([{ engineRevision: ENGINE_REVISION, ...disputed }, { workflowEngineRevision: ENGINE_REVISION }]), [])
})

test('review: the record write and every checkpoint put the engine\'s revision on the command line', async () => {
  const run = await runEngine('review', { args: {}, script: {
    detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: { lens: 'safety', findings: [] },
    '*': null,
  } })
  const writes = run.calls.filter(c => /^(log-run|checkpoint:)/.test(c.label))
  assert.ok(writes.some(c => /^checkpoint:/.test(c.label)) && writes.some(c => /^log-run/.test(c.label)), 'premise: both kinds of write ran')
  for (const c of writes) assert.match(String(c.prompt), new RegExp(`node "\\$CRAFT_LOGGER" \\w+ (--phase '[^']*' )?--engine-revision ${ENGINE_REVISION} `), c.label)
})

for (const engine of RECORD_FILING_ENGINES.filter(e => e !== 'review')) {
  test(`${engine}: stamps no fingerprint basis, so sends no revision flag`, async () => {
    const run = await runEngine(engine, { args: engine === 'triage-findings' ? { pr: '60' } : {}, script: {} })
    const call = run.calls.find(c => /^log-run/.test(c.label))
    assert.ok(call, 'premise: the engine files a record')
    assert.doesNotMatch(String(call.prompt), /--engine-revision/)
  })
}
