// The consumer's own agents as extra lenses of craft:review (realm @nick/craft, node #295), driven through
// the whole engine: named or discovered, dispatched on their own agent type with the diff range, their
// findings verified with the rest; an unknown or dead one is a coverage gap, never a failed run.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const EXTRA = { severity: 'Medium', title: 'extra finds this', file: 'src/lib.rs', line: 7, why: 'w', fix: 'f', source: 'x', ruleId: '', whereChecked: '' }
const VOTE = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'holds' }
const AGENTS = [
  { name: 'code-critic', description: 'Reads the diff of a PR and reviews it for defects.', tools: 'Read, Grep, Bash' },
  { name: 'fixer', description: 'Reviews findings and applies fixes to the code.', tools: 'Read, Bash' },
  { name: 'docs-writer', description: 'Writes documentation.', tools: 'Read' },
]

/** @param {Record<string, any>} [extra] @returns {Record<string, any>} */
function script(extra = {}) {
  return {
    detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, output: ['wrote r.json'] },
    scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: { lens: 'x', findings: [] },
    dedup: { groups: [] },
    'verify-batch': { verdicts: [{ index: 0, ...VOTE }] },
    'extra-lens-discovery': { agents: AGENTS },
    'extra-lens': (/** @type {{ opts: any }} */ { opts }) => {
      if (opts.agentType === 'ghost') throw new Error("agent type 'ghost' not found")
      return { lens: opts.agentType, findings: [EXTRA] }
    },
    synthesis: null,
    '*': null,
    ...extra,
  }
}

/** @param {import('./engine-harness.mjs').Call[]} calls */
const extraCalls = calls => calls.filter(c => c.key === 'extra-lens')

test('named: the agent runs on its own type with the diff range, and its finding is verified into the verdict', async () => {
  const run = await runEngine('review', { args: { extraLenses: ['reviewer'] }, script: script() })
  assert.ok(!run.calls.some(c => c.key === 'extra-lens-discovery'), 'a named list is not discovered')
  const [call, more] = extraCalls(run.calls)
  assert.ok(call && !more, 'dispatched once')
  assert.equal(call.opts.agentType, 'reviewer')
  assert.match(call.prompt, /git diff --merge-base 'main'/, 'the prompt carries the diff range')
  assert.match(call.prompt, /READ-ONLY \(hard rule\): change nothing in the working copy\. No file writes, no git commit, push, checkout, switch, reset or stash, no formatter or fixer runs\./)
  assert.ok(run.calls.some(c => c.key === 'verify-batch'), 'its Medium went through verification')
  assert.match(run.report, /## Confirmed\n- Medium[^\n]*extra finds this/)
  assert.match(run.report, /## Extra lenses\nChosen: named by the caller[^\n]*\nRan: reviewer\./)
  assert.match(run.report, /Their findings were verified under the rust profile's rubric/)
  const record = filedRecord(run)
  assert.deepEqual(record.extraLenses, { how: 'named', requested: ['reviewer'], ran: ['reviewer'], failed: [] })
})

test('an exit before any lens names the extra lenses as not run, in the report and the record', async () => {
  const tsOnly = { detect: { baseRef: 'main', files: ['app.ts'], spec: '', branch: 'feat/x', head: 'abc1234' } }
  const noProfile = await runEngine('review', { args: { extraLenses: ['reviewer'], depth: 'light' }, script: script(tsOnly) })
  assert.equal(extraCalls(noProfile.calls).length, 0, 'not run without a profile')
  assert.match(noProfile.report, /coverage gap: reviewer -- not run: no language profile covers the diff/)
  assert.match(noProfile.report, /## Light pass -- no lens ran/, 'the light section does not claim a round ran')
  assert.doesNotMatch(noProfile.report, /ONE round/)
  const rec = filedRecord(noProfile)
  assert.deepEqual(rec.extraLenses.failed, [{ agent: 'reviewer', why: 'not run: no language profile covers the diff' }])
  assert.equal(rec.depth, 'light')
  assert.ok(rec.notRun.some((/** @type {string} */ n) => /extra lens reviewer -- not run/.test(n)))

  const red = await runEngine('review', { args: { extraLenses: ['reviewer'] }, script: script({ gate: { status: 'fail', provenance: 'CI', failedChecks: ['clippy'], carriedChecks: [], seedFindings: [], notes: '' } }) })
  assert.match(red.report, /coverage gap: reviewer -- not run: the mechanical gate is red/)
  assert.deepEqual(filedRecord(red).extraLenses.failed, [{ agent: 'reviewer', why: 'not run: the mechanical gate is red' }])

  const discovered = await runEngine('review', { args: { depth: 'light' }, script: script(tsOnly) })
  assert.match(discovered.report, /## Extra lenses\nDiscovery did not run \(no language profile covers the diff\)\./)
  assert.doesNotMatch(discovered.report, /No repo reviewer found/)
})

test('a named extra lens on a docs-only or empty diff is not needed: no gap, no notRun entry', async () => {
  for (const files of [['README.md'], []]) {
    const run = await runEngine('review', { args: { extraLenses: ['reviewer'] }, script: script({ detect: { baseRef: 'main', files, spec: '', branch: 'feat/x', head: 'abc1234' } }) })
    assert.match(run.report, /Ran: none\. Not needed \((nothing reviewable changed|the diff is empty)\)/, JSON.stringify(files))
    assert.doesNotMatch(run.report, /coverage gap/)
    const rec = filedRecord(run)
    assert.deepEqual(rec.extraLenses.failed, [])
    assert.ok(!rec.notRun.some((/** @type {string} */ n) => /extra lens/.test(n)))
  }
})

test('a named agent that does not exist is a coverage gap; the run completes with the others', async () => {
  const run = await runEngine('review', { args: { extraLenses: ['ghost', 'reviewer'], depth: 'light' }, script: script() })
  assert.match(run.report, /coverage gap: ghost -- the agent type is not registered/)
  assert.match(run.report, /INCOMPLETE[^\n]*extra lens ghost/, 'the verdict names the gap')
  assert.match(run.report, /extra finds this/, 'the agent that exists still contributed')
  assert.deepEqual(filedRecord(run).extraLenses.failed, [{ agent: 'ghost', why: 'the agent type is not registered in this session' }])
})

test('discovered: a reviewer under another name is found, an editing agent skipped', async () => {
  const run = await runEngine('review', { args: { depth: 'light' }, script: script() })
  assert.ok(run.calls.some(c => c.key === 'extra-lens-discovery'), 'discovery ran')
  assert.deepEqual(extraCalls(run.calls).map(c => c.opts.agentType), ['code-critic'])
  assert.match(run.report, /Chosen: discovered among the session project's agents\.\nRan: code-critic\./)
  assert.equal(filedRecord(run).extraLenses.how, 'discovered')
})

test('discovered: none found, or the listing dead, leaves the craft lenses alone and says so', async () => {
  const none = await runEngine('review', { args: { depth: 'light' }, script: script({ 'extra-lens-discovery': { agents: [AGENTS[1], AGENTS[2]] } }) })
  assert.equal(extraCalls(none.calls).length, 0)
  assert.match(none.report, /No repo reviewer found: 2 agent definition\(s\) read/)
  const dead = await runEngine('review', { args: { depth: 'light' }, script: script({ 'extra-lens-discovery': null }) })
  assert.match(dead.report, /No repo reviewer found: the agent listing[^\n]*did not answer/)
  assert.doesNotMatch(dead.report, /INCOMPLETE/, 'no extra lens is not a coverage gap')
})

test('on a worktree of the session project, discovery reads the session\'s agents and the lens reviews repo=', async () => {
  const sameProject = { 'extra-lens-discovery': { agents: AGENTS, sessionCommonDir: '/work/proj/.git', repoCommonDir: '/work/proj/.git/' } }
  const run = await runEngine('review', { args: { depth: 'light', repo: '/work/proj/.claude/worktrees/wt' }, script: script(sameProject) })
  const discovery = run.calls.find(c => c.key === 'extra-lens-discovery')
  assert.ok(discovery, 'discovery ran')
  assert.doesNotMatch(discovery.prompt, /^WORKING DIRECTORY/, 'no cd into the reviewed repo')
  assert.match(discovery.prompt, /git toplevel of the directory you START in/)
  assert.match(discovery.prompt, /never a file inside `\.claude\/worktrees\/`/)
  assert.match(discovery.prompt, /repoCommonDir: the same for '\/work\/proj\/\.claude\/worktrees\/wt'/)
  const [lens] = extraCalls(run.calls)
  assert.ok(lens, 'the discovered lens ran')
  assert.match(lens.prompt, /^WORKING DIRECTORY: this review targets the repository at '\/work\/proj\/\.claude\/worktrees\/wt'/, 'the lens itself still reviews repo=')
})

test('on a foreign repo=, discovery runs none of the session\'s agents and says so, with no gap; named ones still run', async () => {
  const foreign = { 'extra-lens-discovery': { agents: AGENTS, sessionCommonDir: '/work/proj/.git', repoCommonDir: '/work/other/.git' } }
  const run = await runEngine('review', { args: { depth: 'light', repo: '/work/other' }, script: script(foreign) })
  assert.equal(extraCalls(run.calls).length, 0, 'no session agent reviews a foreign repo')
  assert.match(run.report, /## Extra lenses\nDiscovery skipped: repo is not this session's project/)
  assert.doesNotMatch(run.report, /INCOMPLETE/)
  const rec = filedRecord(run)
  assert.ok(!rec.notRun.some((/** @type {string} */ n) => /extra lens/.test(n)))
  assert.deepEqual(rec.extraLenses.failed, [])

  const unknown = await runEngine('review', { args: { depth: 'light', repo: '/work/other' }, script: script({ 'extra-lens-discovery': { agents: AGENTS, sessionCommonDir: '', repoCommonDir: '' } }) })
  assert.equal(extraCalls(unknown.calls).length, 0, 'an unknown common dir is not the same project')

  const named = await runEngine('review', { args: { repo: '/work/other', extraLenses: ['reviewer'] }, script: script(foreign) })
  assert.ok(!named.calls.some(c => c.key === 'extra-lens-discovery'))
  assert.deepEqual(extraCalls(named.calls).map(c => c.opts.agentType), ['reviewer'])
})

test('a discovered lens that cannot run is reported, not a gap; a named one stays a gap', async () => {
  const ghostDefs = { 'extra-lens-discovery': { agents: [{ name: 'ghost', description: 'Reviews the diff.', tools: 'Read' }] } }
  const discovered = await runEngine('review', { args: { depth: 'light' }, script: script(ghostDefs) })
  assert.match(discovered.report, /## Extra lenses\nChosen: discovered[^\n]*\nRan: none\.\n- ghost could not run: the agent type is not registered in this session \(discovered, not named, so no coverage gap\)\./)
  assert.doesNotMatch(discovered.report, /coverage gap: ghost/)
  assert.doesNotMatch(discovered.report, /INCOMPLETE/)
  const rec = filedRecord(discovered)
  assert.ok(!rec.notRun.some((/** @type {string} */ n) => /extra lens/.test(n)), 'no notRun entry')
  assert.deepEqual(rec.extraLenses.failed, [{ agent: 'ghost', why: 'the agent type is not registered in this session' }])

  const named = await runEngine('review', { args: { depth: 'light', extraLenses: ['ghost'] }, script: script() })
  assert.match(named.report, /coverage gap: ghost/)
  assert.match(named.report, /INCOMPLETE[^\n]*extra lens ghost/)
  assert.ok(filedRecord(named).notRun.some((/** @type {string} */ n) => /extra lens ghost/.test(n)))
})

test('an empty list turns the extra lenses off: no discovery, no section', async () => {
  const run = await runEngine('review', { args: { extraLenses: [] }, script: script() })
  assert.ok(!run.calls.some(c => c.key === 'extra-lens-discovery' || c.key === 'extra-lens'))
  assert.doesNotMatch(run.report, /## Extra lenses/)
  assert.equal(filedRecord(run).extraLenses.how, 'off')
})
