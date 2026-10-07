// Prior decisions through the real review engine (lib/engine-harness.mjs): what the report, the
// ledger and the verdict make of a finding the project already rejected. The rules themselves are
// pinned directly in prior-decisions.test.mjs.
import fs from 'node:fs'
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord, CALL_SPEND } from './engine-harness.mjs'
import { rejectionsFromThreads } from './pr-rejections.mjs'
import { parsePriorDecisions, decisionAnswers } from './prior-decisions.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }

/** @param {string} severity @param {Record<string, unknown>} [over] */
const finding = (severity, over = {}) => ({
  severity, title: 'unwrap in parser may panic', file: 'src/parse.rs', line: 12, why: 'panics on bad input', fix: 'return an error',
  blastRadius: '', source: 'safety', ruleId: 'ERR-001', symbol: 'parse', whereChecked: '', ...over,
})

const DECISION = {
  id: 'decision-46833ecec3', title: 'unwrap in parser may panic', scope: 'src/parse.rs',
  reason: 'input is validated upstream', who: 'alice', when: '2026-10-01', link: 'https://x/pr/1#c2', commit: 'abc1234',
}

/** @param {{ findings: any[], scope?: any }} o */
const scriptFor = ({ findings, scope = { unchanged: [DECISION.id], reason: '' } }) => ({
  detect: { baseRef: 'main', files: ['src/parse.rs'], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: (/** @type {{ callIndex: number }} */ { callIndex }) => ({ lens: 'safety', findings: callIndex === 0 ? findings : [] }),
  dedup: { groups: [] },
  verify: () => UPHELD,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
  'decision-scope': scope,
  synthesis: null,
  '*': null,
})

/** @param {any} run */
const ledgerOf = run => /** @type {any[]} */ ((filedRecord(run) || {}).ledger || [])

test('prior decisions: an unchanged-scope Medium is set aside, marked, out of the verdict, persisted as rejected', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [DECISION] }, script: scriptFor({ findings: [finding('Medium')] }) })
  assert.match(run.report, /## Rejected before \(set aside — not in the verdict\)/)
  assert.match(run.report, /REJECTED BEFORE: input is validated upstream — alice, 2026-10-01, https:\/\/x\/pr\/1#c2 \(decision decision-46833ecec3\)/)
  assert.match(run.report, /✅ Approve/, 'the set-aside Medium does not hold the verdict at Warning')
  const row = ledgerOf(run).find(e => e.file === 'src/parse.rs')
  assert.equal(row?.disposition, 'rejected', 'a re-review carries it like any other dismissal')
  const check = run.calls.find(c => c.label === 'decision-scope')
  assert.match(String(check?.prompt), /git diff --quiet 'abc1234' -- 'src\/parse\.rs'; echo 'decision-46833ecec3' \$\?/)
})

test('prior decisions: a High is raised again normally, with the decision named', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [DECISION] }, script: scriptFor({ findings: [finding('High')] }) })
  assert.doesNotMatch(run.report, /## Rejected before/)
  assert.match(run.report, /⛔ Block/)
  assert.match(run.report, /raised again: a Critical\/High finding is never set aside/)
  assert.ok(!run.calls.some(c => c.label === 'decision-scope'), 'nothing to check when no finding can be set aside')
})

test('prior decisions: a changed scope raises the finding again', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [DECISION] }, script: scriptFor({ findings: [finding('Medium')], scope: { unchanged: [], reason: '' } }) })
  assert.doesNotMatch(run.report, /## Rejected before/)
  assert.match(run.report, /⚠️ Warning/)
  assert.match(run.report, /changed since abc1234/)
})

test('prior decisions: a commit the repo does not know raises the finding and is named under Prior decisions not applied', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [DECISION] }, script: scriptFor({ findings: [finding('Medium')], scope: { unchanged: [], missing: [DECISION.id], reason: '' } }) })
  assert.doesNotMatch(run.report, /## Rejected before/)
  assert.match(run.report, /⚠️ Warning/)
  assert.match(run.report, /## Prior decisions not applied\n- ⚠️ decision decision-46833ecec3: commit abc1234 not found in this repo — raised normally/)
})

test('prior decisions: a dead scope-check agent sets nothing aside', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [DECISION] }, script: scriptFor({ findings: [finding('Medium')], scope: null }) })
  assert.doesNotMatch(run.report, /## Rejected before/)
  assert.ok(run.logs.some((/** @type {string} */ l) => /scope-check agent died or answered unreadably/.test(l)))
})

test('prior decisions: a finding outside the decision\'s scope is not set aside', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [DECISION] }, script: scriptFor({ findings: [finding('Medium', { file: 'src/other.rs' })], scope: { unchanged: [DECISION.id], reason: '' } }) })
  assert.doesNotMatch(run.report, /## Rejected before/, 'a finding outside the scope is not answered by the decision')
})

const MEMORY = '\n\n## Memory\n'
/** @param {string} report */
const memoryLineOf = report => (report.includes(MEMORY) ? (report.slice(report.indexOf(MEMORY) + MEMORY.length).split('\n')[0] ?? '') : '')
/** @param {string} report */
const withoutMemory = report => report.replace(/\n\n## Memory\n[^\n]*\n/, '')
const RECORD = { id: DECISION.id, kind: 'decision', title: DECISION.title, body: DECISION.reason, scope: DECISION.scope, status: 'active', date: DECISION.when, author: DECISION.who, commit: DECISION.commit, links: [DECISION.link] }
/** @param {unknown} recall */
const recalling = recall => ({ ...scriptFor({ findings: [finding('Medium')] }), 'memory-recall': recall })

test('memory (realm #203): absent priorDecisions → one recall agent runs for the diff paths, its decisions are applied, the source is named', async () => {
  for (const args of [{}, { priorDecisions: undefined }, { priorDecisions: null }, { priorDecisions: '' }]) {
    const run = await runEngine('review', { args, script: recalling({ backend: 'harness project memory', why: 'the default', decisions: [RECORD] }) })
    const recalls = run.calls.filter(c => c.label === 'memory-recall')
    assert.equal(recalls.length, 1, JSON.stringify(args))
    assert.match(String(recalls[0]?.prompt), /READ ONLY[\s\S]*- src\/parse\.rs[\s\S]*craft:memory skill/)
    assert.match(run.report, /REJECTED BEFORE: input is validated upstream — alice, 2026-10-01, https:\/\/x\/pr\/1#c2/)
    assert.equal(memoryLineOf(run.report), '- memory: recalled 1 decision(s) from harness project memory (the default)')
    assert.doesNotMatch(run.report, /Prior decisions not passed/)
  }
})

test('memory: a recall that finds nothing says none with its why; otherwise the report and ledger of an empty list', async () => {
  const empty = await runEngine('review', { args: { priorDecisions: [], _recalled: true }, script: scriptFor({ findings: [finding('Medium')] }) })
  assert.equal(memoryLineOf(empty.report), '- memory: recalled by the launching audit — none')
  const run = await runEngine('review', { args: {}, script: recalling({ backend: 'none', why: 'no backend applies', decisions: [] }) })
  assert.match(memoryLineOf(run.report), /^- memory: none — no backend applies/)
  assert.equal(withoutMemory(run.report), withoutMemory(empty.report))
  assert.deepEqual(ledgerOf(run), ledgerOf(empty))
})

test('memory: a dead recall agent is named and findings are raised normally', async () => {
  const run = await runEngine('review', { args: {}, script: recalling(null) })
  assert.equal(run.calls.filter(c => c.label === 'memory-recall').length, 1)
  assert.match(memoryLineOf(run.report), /^- memory: none — the recall agent died or returned no decision list.*findings are raised normally/)
  assert.match(run.report, /⚠️ Warning/)
  assert.doesNotMatch(run.report, /## Rejected before/)
})

test('memory: a recalled record that does not fit is refused by name, as a passed one would be', async () => {
  const run = await runEngine('review', { args: {}, script: recalling({ backend: 'repo', why: 'w', decisions: [{ id: 'x' }] }) })
  assert.match(run.report, /## Prior decisions not applied\n- ⚠️ recalled decision #0 \(x\) lacks an id, a title or a reason/)
  assert.equal(memoryLineOf(run.report), '- memory: recalled 0 decision(s) from repo (w)', 'the count is what was accepted: never "recalled 1" beside its refusal')
  const mixed = await runEngine('review', { args: {}, script: recalling({ backend: 'repo', why: 'w', decisions: [RECORD, { id: 'x' }] }) })
  assert.equal(memoryLineOf(mixed.report), '- memory: recalled 1 decision(s) from repo (w)')
})

test('memory: the recall prompt carries the repo directive once, not twice', async () => {
  const run = await runEngine('review', { args: { repo: '/some/other/repo' }, script: recalling({ backend: 'none', why: 'w', decisions: [] }) })
  const prompt = String(run.calls.find(c => c.label === 'memory-recall')?.prompt)
  assert.equal(prompt.split('WORKING DIRECTORY:').length - 1, 1, prompt.slice(0, 400))
})

test('memory: a budget wall on the recall dispatch (no priorDecisions) — the recall is named as not run, the budget behaviour is the one without it', async () => {
  const script = recalling({ backend: 'repo', why: 'w', decisions: [RECORD] })
  const control = await runEngine('review', { args: {}, script })
  const at = control.calls.findIndex(c => c.label === 'memory-recall')
  assert.ok(at > 0, 'the control dispatches the recall after detect')
  // The wall at the recall: it is refused; the run then meets the same wall on its next dispatch, as
  // it would have without a recall — it fails closed there, not on the recall's own throw.
  const err = await runEngine('review', { args: {}, script, budgetTotal: at * CALL_SPEND }).then(() => null, e => e)
  assert.ok(err, 'past the wall the run fails closed, as before the recall existed')
  assert.match(String(err.message), /budget exhausted/)
  // One step later: the recall ran, the wall falls on the lens phase — the existing INCOMPLETE verdict.
  const lensAt = control.calls.findIndex(c => String(c.label).startsWith('lens:'))
  const walled = await runEngine('review', { args: {}, script, budgetTotal: lensAt * CALL_SPEND })
  assert.match(walled.report, /INCOMPLETE/)
  assert.equal(memoryLineOf(walled.report), '- memory: recalled 1 decision(s) from repo (w)')
})

test('memory: a diff with nothing to review or no language profile spends no recall agent, and the report says why it was not recalled', async () => {
  for (const [files, why] of /** @type {[string[], string][]} */ ([[[], 'nothing to review'], [['README.md'], 'nothing to review'], [['app/main.py'], 'no language profile for the changed files']])) {
    const script = recalling({ backend: 'repo', why: 'w', decisions: [RECORD] })
    const run = await runEngine('review', { args: {}, script: { ...script, detect: { ...script.detect, files } } })
    assert.ok(!run.calls.some(c => c.label === 'memory-recall'), JSON.stringify(files))
    assert.equal(memoryLineOf(run.report), `- memory: none — not recalled — ${why}`, JSON.stringify(files))
  }
})

test('memory: an empty list forwarded with the launching audit\'s recall outcome is named as that outcome', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [], _recalled: true, _memory: 'the recall agent died' }, script: recalling({ backend: 'x', why: 'y', decisions: [RECORD] }) })
  assert.ok(!run.calls.some(c => c.label === 'memory-recall'))
  assert.equal(memoryLineOf(run.report), '- memory: recalled by the launching audit — none (the recall agent died)')
})

test('memory (realm #218): a passed priorDecisions (an empty list included) still launches the recall agent; the line names both parts', async () => {
  for (const [priorDecisions, line] of /** @type {Array<[unknown, string]>} */ ([
    [[DECISION], '- memory: recalled 1 decision(s) from x (y); plus 1 passed by the launcher (0 new)'],
    [[], '- memory: recalled 1 decision(s) from x (y)'],
    ['{nope', '- memory: recalled 1 decision(s) from x (y)'],
  ])) {
    const run = await runEngine('review', { args: { priorDecisions }, script: recalling({ backend: 'x', why: 'y', decisions: [RECORD] }) })
    assert.equal(run.calls.filter(c => c.label === 'memory-recall').length, 1, JSON.stringify(priorDecisions))
    assert.equal(memoryLineOf(run.report), line, JSON.stringify(priorDecisions))
  }
})

test('prior decisions: malformed argument → nothing applied, the report says so, otherwise today\'s report', async () => {
  const base = await runEngine('review', { args: { priorDecisions: [] }, script: scriptFor({ findings: [finding('Medium')] }) })
  for (const [priorDecisions, why] of /** @type {Array<[unknown, RegExp]>} */ ([['{nope', /arrived as a string/], [{ a: 1 }, /not a list/], [[{ id: 'x' }], /lacks an id, a title or a reason/]])) {
    const run = await runEngine('review', { args: { priorDecisions }, script: scriptFor({ findings: [finding('Medium')] }) })
    const at = run.report.indexOf('\n\n## Prior decisions not applied\n')
    assert.ok(at >= 0, `the report names the refusal for ${JSON.stringify(priorDecisions)}`)
    assert.match(run.report.slice(at), why)
    assert.equal(run.report.slice(0, at), base.report, 'everything else is today\'s report')
    assert.deepEqual(ledgerOf(run), ledgerOf(base))
    assert.ok(!run.calls.some(c => c.label === 'decision-scope'))
  }
})

test('prior decisions: a JSON-string argument is refused by name — only a list in an object argument is read', async () => {
  const script = scriptFor({ findings: [finding('Low')] })
  const run = await runEngine('review', { args: { priorDecisions: JSON.stringify([DECISION]) }, script })
  assert.doesNotMatch(run.report, /## Rejected before/)
  assert.match(run.report, /## Prior decisions not applied[\s\S]*priorDecisions arrived as a string/)
})

test('prior decisions: every engine that launches review hands priorDecisions through unchanged', async () => {
  for (const engine of ['rust-review', 'nix-review', 'rust-audit']) {
    const given = await runEngine(engine, { args: { priorDecisions: [DECISION] }, script: { '*': null } })
    const nested = given.calls.filter(c => c.label === 'workflow')
    assert.ok(nested.length >= 1, `${engine} dispatches a nested review`)
    for (const c of nested) assert.deepEqual(/** @type {any[]} */ (c.argv)[1].priorDecisions, [DECISION], `${engine} forwards priorDecisions`)
    if (engine === 'rust-audit') continue // absent, it recalls once itself (rust-audit-prior-decisions.test.mjs)
    const without = await runEngine(engine, { args: {}, script: { '*': null } })
    for (const c of without.calls.filter(x => x.label === 'workflow')) assert.ok(!('priorDecisions' in /** @type {any[]} */ (c.argv)[1]), `${engine} invents none: the nested review recalls`)
  }
})

test('PR comments: the posted body carries the marker, and a rejection of it becomes a decision that answers the finding', async () => {
  const run = await runEngine('review', { args: { comment: true }, script: { ...scriptFor({ findings: [finding('Medium')] }), 'pr-comments': { posted: 1, reason: 'PR #9' } } })
  const call = run.calls.find(c => c.label === 'pr-comments')
  const sent = JSON.parse(String(call?.prompt).slice(String(call?.prompt).indexOf('[\n')).split('\nReturn {posted')[0] || '[]')
  assert.equal(sent.length, 1)
  assert.match(sent[0].body, /^\[Medium\] unwrap in parser may panic\n[\s\S]*<!-- craft-finding -->$/)
  const threads = { data: { repository: { pullRequest: { reviewThreads: { totalCount: 1, nodes: [{
    path: sent[0].file,
    comments: { totalCount: 2, nodes: [
      { author: { login: 'nick' }, authorAssociation: 'OWNER', body: sent[0].body, url: 'https://x/pr/9#r1', createdAt: '2026-10-01T00:00:00Z', originalCommit: { oid: 'abc1234' } },
      { author: { login: 'alice' }, authorAssociation: 'MEMBER', body: 'Not a bug: validated upstream.', url: 'https://x/pr/9#r2', createdAt: '2026-10-02T00:00:00Z', originalCommit: { oid: 'abc1234' } },
    ] },
  }] } } } } }
  const rec = /** @type {any} */ (rejectionsFromThreads(threads)).decisions
  const { decisions, refused } = parsePriorDecisions(rec)
  assert.deepEqual(refused, [], 'the record the reader writes is one the engine accepts')
  assert.ok(decisionAnswers(finding('Medium'), /** @type {any} */ (decisions[0])), 'and it answers the finding it rejected')
})

test('every review engine tells its launcher that it always recalls itself, that priorDecisions only adds to that recall, and to post only through the engine', () => {
  for (const engine of ['review', 'adversarial-review', 'rust-review', 'nix-review', 'rust-audit']) {
    const src = fs.readFileSync(new URL(`../workflows/${engine}.js`, import.meta.url), 'utf8')
    const whenToUse = String(src.match(/whenToUse: '((?:[^'\\]|\\.)*)'/)?.[1])
    assert.match(whenToUse, /The engine itself always recalls[^.;]*craft:memory skill/, engine)
    assert.match(whenToUse, /priorDecisions is optional and ADDS to that recall, never replaces it/, engine)
    assert.doesNotMatch(whenToUse, /skips the recall/, engine)
    assert.match(whenToUse, /never post findings by hand/, engine)
  }
})
