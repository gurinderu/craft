// The run store's writes as the JavaScript writer makes them — the binary's requests (checkpoint, finalize,
// publication, and the post-hoc sorting-choice and develop-cycle) answered by integrations/shared/binary-filing-replay.mjs over integrations/shared/craft-log-run.mjs — held to the Rust writer
// (cli/crates/craft-store/tests/parity.rs) by one shared file, content/parity/store-cases.json: each case's requests in
// a fresh repository and store, the answers, and every file the store holds afterwards, byte for byte, with the paths,
// the commits and the writer's own commit put back as placeholders. Regenerate it with
// `UPDATE_STORE_PARITY=1 npx vitest run integrations/shared/store-parity.test.mjs` (realm @nick/craft, node #539).
import { afterAll, afterEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './binary-filing-replay.mjs'

const FILE = new URL('../../content/parity/store-cases.json', import.meta.url)
const NOW = Date.parse('2026-03-04T05:06:07.890Z')

/** @type {string[]} */
const made = []
afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true })
})
afterEach(() => {
  vi.useRealTimers()
})

const STEP = {
  run: '/tmp/run-p',
  done: true,
  report: '/tmp/run-p/report.md',
  verdict: 'Warning',
  line: 'Warning — 2 findings',
  head: '<head>',
  base: 'origin/main',
  path: 'crates/a',
  findings: [
    { severity: 'Medium', file: 'src/lib.rs', line: 12, title: 'unwrap on a checked value', ruleId: 'errors.unwrap', tier: 'confirmed' },
    { severity: 'Low', file: 'src/é.rs', line: 3.5, title: 'ünïcode "title"\n😀', ruleId: '', tier: 'suspected', extra: 1 },
  ],
  uncovered: ['flake.nix', 7],
  notRun: ['the tests lens'],
  round: 2,
  lensScope: 'delta',
  ledger: [
    {
      file: 'src/lib.rs',
      line: 12,
      symbol: 'fn parse<T>',
      severity: 'Medium',
      tier: 'confirmed',
      disposition: '',
      source: 'errors',
      ruleId: 'errors.unwrap',
      title: 'unwrap',
      why: 'w',
      toolRule: 'clippy::unwrap_used',
      sources: ['errors', 'tests'],
      deferral: { until: 'x' },
    },
    { file: 'src/old.rs', line: 'x', disposition: 'closed', title: 'gone' },
  ],
  reReview: { prior: 1, carried: 2 },
  memory: { source: '.craft/memory', 10: 'ten', 2: 'two' },
  sorting: {
    defects: 1,
    findings: [
      { n: 1, title: 'first', file: 'a.rs', line: 1 },
      { n: 2, title: 'second', file: 'b.rs', line: 2 },
    ],
    choices: { 2: { choice: 'defect', at: 'then' }, 1: { choice: 'question', at: 'then' } },
  },
  memoryContradictions: { count: 1, findings: [{ key: { file: 'src/lib.rs', ruleId: 'errors.unwrap' }, title: 'against memory' }, 'odd'] },
  prComments: null,
  dimensions: [{ dimension: 'errors', ran: true, findingCount: 1 }, 'not a row'],
  verification: { candidates: 2, refuted: 0.1 + 0.2 },
  lensRounds: [{ round: 1, lenses: 3 }],
  at: 9000,
  took: 100,
}

/** Steps as the binary keeps them: two phases and the finish. */
const STEPS = [
  { done: false, phase: 'scout', at: 1000, took: 400, agents: 0 },
  { done: false, phase: 'lenses', at: 61000, took: 300, agents: 2 },
  { done: false, phase: 'lenses', at: 90000, took: 200, agents: 5 },
  { done: true, phase: '', at: 150000, took: 500, agents: 7 },
]

/** The run's identity as the binary kept it, its working copy gone: what a checkpoint names its branch by. */
const KEPT = { repo: '<repo>-gone', gitDir: '<repo>/.git', head: '<head>' }

/**
 * The cases: each a repository kind and its requests, `<runDir>` the directory the last checkpoint named.
 * @type {Array<{ name: string, repo: string, calls: Array<[string, Record<string, unknown>]> }>}
 */
const CASES = [
  {
    name: 'a run checkpointed at its start and each phase, then finalized with its directory folded',
    repo: 'git',
    calls: [
      ['checkpoint', { start: true, steps: STEPS.slice(0, 1), head: '<head>' }],
      ['checkpoint', { start: false, steps: STEPS.slice(0, 2), head: '<head>' }],
      ['checkpoint', { start: false, steps: STEPS.slice(0, 3), head: '<head>' }],
      ['checkpoint', { start: false, steps: STEPS, head: '<head>', runtime: 'codex', dir: '<runDir>' }],
      [
        'finalize',
        {
          step: STEP,
          steps: STEPS,
          dir: '<runDir>',
          retry: false,
          depth: 'light',
          strict: true,
          via: 'rust-audit',
          outputTokens: 1234,
          runtime: 'codex',
          session: 's-1',
        },
      ],
    ],
  },
  {
    name: 'a record sent again as a retry is answered already filed',
    repo: 'git',
    calls: [
      ['finalize', { step: { ...STEP, ledger: undefined, sorting: null }, steps: STEPS.slice(3), retry: false }],
      ['finalize', { step: { ...STEP, ledger: undefined, sorting: null }, steps: STEPS.slice(3), retry: true }],
    ],
  },
  {
    name: 'a publication renumbers the choices that still have their finding and drops the rest',
    repo: 'dirty',
    calls: [
      ['finalize', { step: STEP, steps: [], retry: false }],
      [
        'publication',
        {
          step: { ...STEP, sorting: { defects: 0, findings: [{ n: 1, title: 'second', file: 'b.rs', line: '2' }] }, prComments: { posted: 1 } },
          recordFile: '<recordFile>',
        },
      ],
    ],
  },
  {
    name: 'a plain directory, a step that cannot be read, a directory outside the store',
    repo: 'plain',
    calls: [
      ['finalize', { step: { run: '/r', done: true, verdict: 'Approve' }, steps: [] }],
      ['checkpoint', { start: true, steps: [], dir: '/elsewhere/run' }],
      ['finalize', { step: { ...STEP, findings: 'none', ledger: null }, steps: [], dir: '/elsewhere/run', retry: false }],
    ],
  },
  {
    name: 'a re-filed record keyed through the git directory the run kept, its working copy gone',
    repo: 'git',
    calls: [
      ['checkpoint', { start: true, steps: [], repo: '<repo>-gone', gitDir: '<repo>/.git', branch: 'feat/kept', head: '<head>', dirty: true }],
      [
        'finalize',
        { step: STEP, steps: [], repo: '<repo>-gone', gitDir: '<repo>/.git', branch: 'feat/kept', head: '<head>', dirty: true, dir: '<runDir>', retry: true },
      ],
    ],
  },
  {
    name: 'a run whose checkpoints lost their directory rejoins it, and finalizes into it',
    repo: 'git',
    calls: [
      ['checkpoint', { start: true, steps: [] }],
      ['checkpoint', { start: false, steps: STEPS.slice(0, 2), rejoin: true }],
      ['finalize', { step: STEP, steps: STEPS, rejoin: true, retry: false }],
    ],
  },
  {
    name: 'a run whose checkpoints contradict each other about its branch (A, B, A) is not rejoined',
    repo: 'git',
    calls: [
      ['checkpoint', { start: true, steps: [], ...KEPT, branch: 'feat/a' }],
      ['checkpoint', { start: false, steps: STEPS.slice(0, 2), ...KEPT, branch: 'feat/b', dir: '<runDir>' }],
      [
        'checkpoint',
        {
          start: false,
          steps: [...STEPS.slice(0, 3), { done: false, phase: 'verify', at: 150000, took: 500, agents: 7 }],
          ...KEPT,
          branch: 'feat/a',
          dir: '<runDir>',
        },
      ],
      ['finalize', { step: STEP, steps: STEPS, ...KEPT, branch: 'feat/a', rejoin: true, retry: false }],
    ],
  },
  {
    name: "the run's finalize replaces the record recover filed for it, and that record's index row",
    repo: 'git',
    calls: [
      [
        'write',
        { path: '<store>/2026-03-04T05-00-00Z-workflow-review.json', text: '{"ts":"2026-03-04T05-00-00Z","kind":"workflow","name":"review","partial":true}' },
      ],
      [
        'write',
        {
          path: '<store>/index.jsonl',
          text: '{"ts":"2026-03-01T00-00-00Z","kind":"workflow","name":"triage-findings"}\n{"ts":"2026-03-04T05-00-00Z","kind":"workflow","name":"review","verdict":"INCOMPLETE"}\n',
        },
      ],
      ['checkpoint', { start: true, steps: [] }],
      ['write', { path: '<runDir>/.recovered-live', text: '<store>/2026-03-04T05-00-00Z-workflow-review.json\n' }],
      ['finalize', { step: STEP, steps: STEPS, dir: '<runDir>', retry: false }],
    ],
  },
  {
    name: "replacing recover's record keeps an index line that is not UTF-8 byte for byte",
    repo: 'git',
    calls: [
      [
        'write',
        { path: '<store>/2026-03-04T05-00-00Z-workflow-review.json', text: '{"ts":"2026-03-04T05-00-00Z","kind":"workflow","name":"review","partial":true}' },
      ],
      [
        'write',
        {
          path: '<store>/index.jsonl',
          // {"title":"<FF FE> broken"} then recover's row
          hex: `${Buffer.from('{"title":"').toString('hex')}fffe${Buffer.from(' broken"}\n{"ts":"2026-03-04T05-00-00Z","kind":"workflow","name":"review"}\n').toString('hex')}`,
        },
      ],
      ['checkpoint', { start: true, steps: [] }],
      ['write', { path: '<runDir>/.recovered-live', text: '<store>/2026-03-04T05-00-00Z-workflow-review.json\n' }],
      ['finalize', { step: STEP, steps: STEPS, dir: '<runDir>', retry: false }],
    ],
  },
  {
    name: "a reviewer's sorting choices land in the run's record, the newest of its branch found when none is named",
    repo: 'git',
    calls: [
      ['finalize', { step: STEP, steps: [], retry: false }],
      ['sorting-choice', { n: 1, choice: 'dropped', recordFile: '<recordFile>' }],
      ['sorting-choice', { n: 2, choice: 'question' }],
      ['sorting-choice', { n: 9, choice: 'defect', recordFile: '<recordFile>' }],
      ['sorting-choice', { n: 1, choice: 'maybe', recordFile: '<recordFile>' }],
    ],
  },
  {
    name: 'a develop cycle is filed as its own record, and one that does not fit is refused by name',
    repo: 'dirty',
    calls: [
      [
        'develop-cycle',
        {
          session: 's-2',
          cycle: {
            outcome: 'converged',
            rounds: [
              { engine: ' review ', scope: 'full', verdict: 'Block', mediumPlus: 2 },
              { engine: 'review', scope: 'delta', verdict: 'Approve', mediumPlus: 0 },
            ],
            fullReviews: [{ afterRound: 2, engine: 'review', verdict: 'Approve', mediumPlus: 0 }],
          },
        },
      ],
      ['develop-cycle', { cycle: { outcome: 'capped', rounds: [{ engine: 'review', scope: 'all' }] } }],
    ],
  },
  {
    name: 'a directory whose checkpoints name another branch is left in place for recover',
    repo: 'git',
    calls: [
      ['checkpoint', { start: true, steps: [], ...KEPT, branch: 'feat/other' }],
      ['finalize', { step: STEP, steps: STEPS, dir: '<runDir>', rejoin: true, retry: false }],
    ],
  },
]

/** @param {string} prefix */
function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  made.push(d)
  return d
}

/** @param {string} repo @param {string[]} args */
const git = (repo, args) =>
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).stdout.trim()

/** A repository of `kind`: `git` one commit on feat/x, `dirty` with an untracked file beside it, `plain` no git. @param {string} kind */
function repoOf(kind) {
  const repo = tmp('craft-parity-repo-')
  if (kind === 'plain') return repo
  git(repo, ['init', '-q', '-b', 'feat/x'])
  fs.writeFileSync(path.join(repo, 'a.rs'), 'fn a() {}\n')
  git(repo, ['add', 'a.rs'])
  git(repo, ['commit', '-q', '-m', 'a'])
  if (kind === 'dirty') fs.writeFileSync(path.join(repo, 'b.rs'), '\n')
  return repo
}

/** @param {unknown} v @param {(s: string) => string} f @returns {unknown} */
const mapStrings = (v, f) => {
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) return v.map(x => mapStrings(x, f))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]))
  return v
}

/**
 * A file's bytes as the parity file holds them: each line as text, or `hex:<bytes>` for one that is not UTF-8 — so a
 * writer that put U+FFFD where the bytes were is told from one that kept them.
 * @param {Buffer} buf
 */
function shown(buf) {
  const strict = new TextDecoder('utf-8', { fatal: true })
  /** @type {string[]} */
  const lines = []
  let from = 0
  for (let i = 0; i <= buf.length; i++) {
    if (i < buf.length && buf[i] !== 0x0a) continue
    const line = buf.subarray(from, i)
    try {
      lines.push(strict.decode(line))
    } catch {
      lines.push(`hex:${line.toString('hex')}`)
    }
    from = i + 1
  }
  return lines.join('\n')
}

/** Every file under `dir`, by its path relative to it. @param {string} dir @returns {Record<string, string>} */
function filesUnder(dir, at = '') {
  /** @type {Record<string, string>} */
  const out = {}
  for (const e of fs.readdirSync(path.join(dir, at), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = at ? `${at}/${e.name}` : e.name
    if (e.isDirectory()) Object.assign(out, filesUnder(dir, rel))
    else out[rel] = shown(fs.readFileSync(path.join(dir, rel)))
  }
  return out
}

/**
 * The text with this case's real values put back as placeholders: the store, the repository, the head and its short
 * form, the writer's own commit, and each proof's key (a hash over the real paths).
 * @param {{ store: string, repo: string, head: string, short: string, craft: string }} real
 */
function placeholders({ store, repo, head, short, craft }) {
  /** @param {string} s */
  return s => {
    let t = s.split(store).join('<store>').split(repo).join('<repo>')
    if (head) t = t.split(head).join('<head>')
    if (short) t = t.replaceAll(`"${short}"`, '"<short>"')
    if (craft) {
      t = t.replaceAll(`"craftCommit":"${craft}"`, '"craftCommit":"<craft>"')
      t = t.replaceAll(`"craftCommit": "${craft}"`, '"craftCommit": "<craft>"')
    }
    return t.replace(/\b(dir-)?[0-9a-f]{64}\b/g, (_, d) => `${d ?? ''}<proof>`)
  }
}

/** One case through the JavaScript writer: its answers and the store it leaves. @param {(typeof CASES)[number]} c */
async function played(c) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  const repo = repoOf(c.repo)
  const store = tmp('craft-parity-store-')
  const scratch = tmp('craft-parity-in-')
  const head = c.repo === 'plain' ? '' : git(repo, ['rev-parse', 'HEAD'])
  const short = c.repo === 'plain' ? '' : git(repo, ['rev-parse', '--short', 'HEAD'])
  const craft = git(path.dirname(new URL(import.meta.url).pathname), ['rev-parse', '--short', 'HEAD'])
  const back = placeholders({ store, repo, head, short, craft })
  let runDir = ''
  let recordFile = ''
  const answers = []
  for (const [i, [command, req]] of c.calls.entries()) {
    const real = mapStrings({ repo: '<repo>', craftVersion: '0.55.0', session: '', dir: '', rejoin: false, steps: [], head: '', ...req }, s =>
      s
        .replace(/<runDir>/g, runDir)
        .replace(/<recordFile>/g, recordFile)
        .replace(/<repo>/g, repo)
        .replace(/<head>/g, head)
        .replace(/<store>/g, store),
    )
    if (command === 'write') {
      // A file laid in the store as another writer left it: recover's kept record, its index, its marker.
      const w = /** @type {Record<string, unknown>} */ (real)
      const at = String(w['path'])
      fs.mkdirSync(path.dirname(at), { recursive: true })
      fs.writeFileSync(at, typeof w['hex'] === 'string' ? Buffer.from(w['hex'], 'hex') : String(w['text']))
      answers.push({ wrote: back(at) })
      continue
    }
    const input = path.join(scratch, `${i}.json`)
    fs.writeFileSync(input, JSON.stringify(real))
    const r = await run([command, '--input', input, '--store', store])
    assert.equal(r.exitCode, 0, r.stderr.join('\n'))
    const answer = JSON.parse(String(r.stdout.at(-1)))
    if (answer.runDir) runDir = answer.runDir
    if (answer.file) recordFile = answer.file
    answers.push(JSON.parse(back(JSON.stringify(answer))))
  }
  const files = Object.fromEntries(
    Object.entries(filesUnder(store))
      .map(([k, v]) => [back(k), back(v)])
      .sort((x, y) => ((x[0] ?? '') < (y[0] ?? '') ? -1 : 1)),
  )
  return { answers, files }
}

test('replacement preserves an invalid UTF-8 row even when its filename matches', async () => {
  const source = CASES.find(c => c.name === "replacing recover's record keeps an index line that is not UTF-8 byte for byte")
  assert.ok(source)
  const invalid = Buffer.concat([
    Buffer.from('{"ts":"2026-03-04T05-00-00Z","kind":"workflow","name":"review","extra":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ])
  /** @type {[string, Record<string, unknown>][]} */
  const calls = source.calls.map(([command, request]) =>
    command === 'write' && request['path'] === '<store>/index.jsonl'
      ? [command, { ...request, hex: Buffer.concat([invalid, Buffer.from('\n')]).toString('hex') }]
      : [command, request],
  )
  const result = await played({ ...source, calls })
  assert.ok(result.files['index.jsonl'].startsWith(`hex:${invalid.toString('hex')}\n`))
})

test('the JavaScript writer files each case as the shared parity file holds it', async () => {
  const cases = []
  for (const c of CASES)
    cases.push({ name: c.name, repo: c.repo, now: NOW, calls: c.calls.map(([command, request]) => ({ command, request })), expected: await played(c) })
  const file = {
    note: 'Generated by integrations/shared/store-parity.test.mjs (UPDATE_STORE_PARITY=1); read by cli/crates/craft-store/tests/parity.rs.',
    cases,
  }
  const text = `${JSON.stringify(file, null, 2)}\n`
  if (process.env['UPDATE_STORE_PARITY']) fs.writeFileSync(FILE, text)
  assert.equal(text, fs.readFileSync(FILE, 'utf8'), 'regenerate with UPDATE_STORE_PARITY=1')
})
