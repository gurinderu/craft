// The recurrence reader (realm @nick/craft, node #205): findings that come back across different
// branches of ONE project, read from a run store built here in a temp directory.
import { test, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run, RECURRING_RUNS_MAX } from './recurring-findings.mjs'
import { recurringGroups, RECURRING_GROUPS_MAX, RECURRING_TITLES_MAX } from './recurring-groups.mjs'

/** @type {string} */
let tmp
/** @type {string} */
let store
/** @type {string} */
let project

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-recur-'))
  store = path.join(tmp, 'runs')
  project = path.join(tmp, 'proj')
  fs.mkdirSync(store)
  fs.mkdirSync(project)
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

let seq = 0
/**
 * One review record in the store.
 * @param {{ branch: string, rows: Array<{ file: string, title: string, severity?: string, disposition?: string, tier?: string, why?: string }>, project?: string, partial?: boolean, ts?: string }} o
 */
function record({ branch, rows, project: proj = project, partial = false, ts }) {
  seq++
  const stamp = ts || `2026-10-0${1 + (seq % 9)}T00-00-${String(seq).padStart(2, '0')}Z`
  const rec = {
    schemaVersion: 1, kind: 'workflow', name: 'review', ts: stamp, project: proj, branch, ...(partial ? { partial: true } : {}),
    ledger: rows.map(r => ({ fp: 'x', file: r.file, line: 1, symbol: 's', severity: r.severity || 'Medium', tier: r.tier || 'confirmed', disposition: r.disposition || 'open', source: 'safety', ruleId: '', title: r.title, why: r.why || 'w' })),
  }
  fs.writeFileSync(path.join(store, `${stamp}-${seq}-workflow-review.json`), JSON.stringify(rec))
}

/** @param {string[]} [extra] */
async function read(extra = []) {
  const r = await run(['--store', store, '--project', project, ...extra], {})
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  return JSON.parse(r.stdout.join('\n'))
}

test('recurrence: the same finding on two different branches is one group, both branches and runs named', async () => {
  record({ branch: 'feat/a', rows: [{ file: 'src/parse.rs', title: 'unwrap in parser may panic', severity: 'High' }] })
  record({ branch: 'feat/b', rows: [{ file: 'src/parse.rs', title: 'parser unwrap may panic', severity: 'Medium' }] })
  const out = await read()
  assert.equal(out.groups.length, 1)
  const g = out.groups[0]
  assert.equal(g.file, 'src/parse.rs')
  assert.deepEqual(g.branches, ['feat/a', 'feat/b'])
  assert.equal(g.runs.length, 2)
  assert.deepEqual(g.severities, ['High', 'Medium'])
  assert.ok(g.titles.includes('unwrap in parser may panic'))
  assert.match(g.lastSeen, /^2026-10-/)
})

test('recurrence: the same branch twice is not a recurrence', async () => {
  record({ branch: 'feat/a', rows: [{ file: 'src/parse.rs', title: 'unwrap in parser may panic' }] })
  record({ branch: 'feat/a', rows: [{ file: 'src/parse.rs', title: 'unwrap in parser may panic' }] })
  const out = await read()
  assert.deepEqual(out.groups, [])
})

test('recurrence: another project\'s runs are ignored, and counted', async () => {
  record({ branch: 'feat/a', rows: [{ file: 'src/parse.rs', title: 'unwrap in parser may panic' }] })
  record({ branch: 'feat/b', project: path.join(tmp, 'other'), rows: [{ file: 'src/parse.rs', title: 'unwrap in parser may panic' }] })
  const out = await read()
  assert.deepEqual(out.groups, [])
  assert.equal(out.skipped.otherProject, 1)
})

test('recurrence: a different file or too little title overlap is not the same finding', async () => {
  record({ branch: 'feat/a', rows: [{ file: 'src/parse.rs', title: 'unwrap in parser may panic' }, { file: 'src/lex.rs', title: 'slow lexer loop' }] })
  record({ branch: 'feat/b', rows: [{ file: 'src/lex.rs', title: 'unwrap in parser may panic' }, { file: 'src/parse.rs', title: 'missing doc comment on parse' }] })
  assert.deepEqual((await read()).groups, [])
})

test('recurrence: partial runs and runs without a branch are left out and counted', async () => {
  record({ branch: 'feat/a', rows: [{ file: 'src/parse.rs', title: 'unwrap in parser may panic' }] })
  record({ branch: 'feat/b', partial: true, rows: [{ file: 'src/parse.rs', title: 'unwrap in parser may panic' }] })
  record({ branch: '', rows: [{ file: 'src/parse.rs', title: 'unwrap in parser may panic' }] })
  const out = await read()
  assert.deepEqual(out.groups, [])
  assert.equal(out.skipped.partial, 1)
  assert.equal(out.skipped.noBranch, 1)
})

test('recurrence: --path narrows the groups to the touched paths (a file, or a directory holding it)', async () => {
  for (const b of ['feat/a', 'feat/b']) record({ branch: b, rows: [{ file: 'src/parse.rs', title: 'unwrap in parser may panic' }, { file: 'lib/x.rs', title: 'leaky handle in x' }] })
  assert.equal((await read()).groups.length, 2)
  assert.deepEqual((await read(['--path', 'src'])).groups.map((/** @type {any} */ g) => g.file), ['src/parse.rs'])
  assert.deepEqual((await read(['--path', 'lib/x.rs'])).groups.map((/** @type {any} */ g) => g.file), ['lib/x.rs'])
})

test('recurrence: no run store is said in one line, not an error', async () => {
  const r = await run(['--store', path.join(tmp, 'nope'), '--project', project], {})
  assert.equal(r.exitCode, 0)
  const out = JSON.parse(r.stdout.join('\n'))
  assert.deepEqual(out.groups, [])
  assert.match(out.note, /no run store at/)
})

test('recurrence: a flag without its value is refused with exit 2', async () => {
  const r = await run(['--store'], {})
  assert.equal(r.exitCode, 2)
  assert.match(r.stderr.join('\n'), /--store needs a value/)
})

test('bound: past RECURRING_RUNS_MAX the newest runs are read and the rest named, never silently', async () => {
  // Recurrence only in the two OLDEST runs: past the bound they are not read, and the output says so.
  record({ branch: 'feat/old1', ts: '2026-01-01T00-00-00Z', rows: [{ file: 'src/parse.rs', title: 'unwrap in parser may panic' }] })
  record({ branch: 'feat/old2', ts: '2026-01-01T00-00-01Z', rows: [{ file: 'src/parse.rs', title: 'unwrap in parser may panic' }] })
  for (let i = 0; i < RECURRING_RUNS_MAX; i++) record({ branch: `feat/n${i}`, ts: `2026-09-01T00-${String(Math.floor(i / 60)).padStart(2, '0')}-${String(i % 60).padStart(2, '0')}Z`, rows: [{ file: `f${i}.rs`, title: `t${i}` }] })
  const out = await read()
  assert.equal(out.runsRead, RECURRING_RUNS_MAX)
  assert.equal(out.runsNotRead, 2)
  assert.deepEqual(out.groups, [])
  assert.match(out.note, new RegExp(`2 older run\\(s\\) past the bound of ${RECURRING_RUNS_MAX} were not read`))
})

test('bound: past RECURRING_GROUPS_MAX the groups most spread across branches are kept and the rest counted', () => {
  /** @type {any[]} */
  const runs = []
  const last = RECURRING_GROUPS_MAX + 2
  for (let g = 0; g <= last; g++) {
    // group g recurs on 2 branches, except the LAST one (seen last, named last), which recurs on 3 —
    // it must lead and survive the cut.
    const file = g === last ? 'zz.rs' : `f${String(g).padStart(2, '0')}.rs`
    for (let b = 0; b < (g === last ? 3 : 2); b++) runs.push({ file: `r${g}-${b}`, ts: '2026-10-01', branch: `b${b}`, rows: [{ file, title: `distinct title number ${g}`, severity: 'Low' }] })
  }
  const r = recurringGroups(runs)
  assert.equal(r.groups.length, RECURRING_GROUPS_MAX)
  assert.equal(r.groupsCut, 3)
  assert.equal(r.groups[0]?.file, 'zz.rs')
})

test('bound: a group lists at most RECURRING_TITLES_MAX distinct titles and counts the rest', () => {
  const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
  /** @type {any[]} */
  const runs = []
  for (let i = 0; i < RECURRING_TITLES_MAX + 2; i++) {
    runs.push({ file: `r${i}`, ts: '2026-10-01', branch: `b${i}`, rows: [{ file: 'a.rs', title: `${words.join(' ')} v${i}`, severity: 'Low' }] })
  }
  const g = recurringGroups(runs).groups[0]
  assert.equal(g?.titles.length, RECURRING_TITLES_MAX)
  assert.equal(g?.titlesMore, 2)
})

test('recurrence: only findings that were real count — a rejected row, a refuted one, a dismissed tombstone, a justified row and a deferred (carried) one are left out; open and resolved count', async () => {
  const t = 'unwrap in parser may panic'
  record({ branch: 'feat/a', rows: [{ file: 'src/parse.rs', title: t, disposition: 'rejected' }] })
  record({ branch: 'feat/b', rows: [{ file: 'src/parse.rs', title: t, disposition: 'rejected' }] })
  record({ branch: 'feat/c', rows: [{ file: 'src/parse.rs', title: t, tier: 'refuted' }] })
  record({ branch: 'feat/d', rows: [{ file: 'src/parse.rs', title: t, disposition: 'closed', why: 'dismissed in round 2' }] })
  record({ branch: 'feat/e', rows: [{ file: 'src/parse.rs', title: t, disposition: 'deferred' }] })
  record({ branch: 'feat/g', rows: [{ file: 'src/parse.rs', title: t, disposition: 'justified' }] })
  const none = await read()
  assert.equal(none.groups.length, 0, 'a finding rejected, justified or known and deferred on several branches is no lesson')
  assert.match(none.note, /rejected, refuted, justified, deferred and dismissed findings are not counted/)
  record({ branch: 'feat/f', rows: [{ file: 'src/parse.rs', title: t, disposition: 'closed', why: 'resolved in round 2' }] })
  record({ branch: 'feat/h', rows: [{ file: 'src/parse.rs', title: t, disposition: 'open' }] })
  const out = await read()
  assert.deepEqual(out.groups.map((/** @type {{ branches: string[] }} */ g) => g.branches), [['feat/f', 'feat/h']])
})
