// The nested launch resolves under the name the registry actually carries — executed, not assumed.
//
// Observed live in the installed plugin (realm @nick/craft, node #83): the registry lists engines
// as `craft:review`, `craft:rust-review`, …, and a nested `workflow('review')` refused to resolve —
// the review pins ran zero agents, and rust-audit's two nested reviews died inside its fan-out
// while every gate here stayed green. The fix is a qualified-first launch with a bare-name
// fallback, and these tests execute BOTH branches: a registry that resolves only the qualified
// spelling (the installed plugin) and one that resolves only the bare spelling (a checkout).
//
// Two layers on purpose. The unit tests pin the helper's own contract — fallback ONLY on the
// name-resolution refusal, never a relaunch of a nested run that failed on its own (that would run
// a whole review twice). The engine tests drive the REAL call sites through the harness, because
// the helper being correct says nothing about a site still launching by one hard-coded spelling.
import test from 'node:test'
import assert from 'node:assert/strict'
import { nestedWorkflow } from './nested-workflow.mjs'
import { runEngine, filedRecord } from './engine-harness.mjs'

// The refusal as the sandbox actually raises it: workflow() THROWS on an unknown name (documented
// contract), with this message shape observed verbatim at a consumer.
const refusal = name => new Error(
  `workflow('${name}'): no workflow with that name. Available: deep-research, craft:nix-review, craft:review, craft:rust-review, craft:rust-audit`,
)

const REPORT = '## Verdict\n✅ Approve — clean'

// A fake registry that resolves exactly the given spellings and records every attempt — including
// the refused ones, which the harness's own call log deliberately does not keep.
function registry(resolvable, answer = () => REPORT) {
  const attempts = []
  const fn = async (name, args) => {
    attempts.push(name)
    if (!resolvable.includes(name)) throw refusal(name)
    return answer(name, args)
  }
  return { attempts, fn }
}

// ---- the helper's own contract --------------------------------------------------------------

test('resolves the qualified name first and never touches the bare one when it works', async () => {
  const { attempts, fn } = registry(['craft:review'])
  assert.equal(await nestedWorkflow(fn, 'review', { base: 'main' }), REPORT)
  assert.deepEqual(attempts, ['craft:review'], 'one launch, under the installed plugin\'s spelling')
})

test('falls back to the bare name on the name-resolution refusal, and says so', async () => {
  const warned = []
  const { attempts, fn } = registry(['review'])
  assert.equal(await nestedWorkflow(fn, 'review', {}, w => warned.push(w)), REPORT)
  assert.deepEqual(attempts, ['craft:review', 'review'], 'the refusal buys exactly one more attempt')
  assert.ok(warned.some(w => /craft:review/.test(w) && /'review'/.test(w)),
    'the fallback is logged with both spellings, not taken silently')
})

test('a null return is a dead nested engine, not a missing name — no second launch', async () => {
  // The sandbox answers null when the nested run died; relaunching on it would re-run the review.
  const { attempts, fn } = registry(['craft:review'], () => null)
  assert.equal(await nestedWorkflow(fn, 'review', {}), null)
  assert.deepEqual(attempts, ['craft:review'], 'null passes through as the caller\'s NOT-RUN signal')
})

test('a substantive failure under the qualified name is rethrown — the bare name is never tried', async () => {
  // The single most expensive mistake available here: the qualified name RESOLVED and the nested
  // review failed on its own; a fallback now would run the whole review a second time.
  const attempts = []
  const boom = new Error('the nested review itself failed mid-run')
  const fn = async name => { attempts.push(name); throw boom }
  await assert.rejects(() => nestedWorkflow(fn, 'review', {}), e => e === boom)
  assert.deepEqual(attempts, ['craft:review'], 'no relaunch on a failure that is not a refusal')
})

test('a substantive failure under the bare name (after a refusal) is rethrown untouched', async () => {
  const attempts = []
  const boom = new Error('the nested review died after resolving')
  const fn = async name => {
    attempts.push(name)
    if (name === 'craft:review') throw refusal(name)
    throw boom
  }
  await assert.rejects(() => nestedWorkflow(fn, 'review', {}), e => e === boom)
  assert.deepEqual(attempts, ['craft:review', 'review'])
})

test('EXHAUSTION: both spellings refused throws loudly, naming both — never a silent skip', async () => {
  const { attempts, fn } = registry([])
  await assert.rejects(
    () => nestedWorkflow(fn, 'review', {}),
    /neither 'craft:review' nor 'review' resolved — the nested run did NOT happen/,
  )
  assert.deepEqual(attempts, ['craft:review', 'review'], 'both were actually tried before giving up')
})

// ---- the real call sites, driven through the harness ------------------------------------------
// The harness's workflow stub resolves any name, so these tests override it with the two registry
// shapes. The harness records EVERY dispatch — a refused resolution stays in the trail with
// `threw` set (its dispatch spent tokens before dying), so trail consumers filter by `!c.threw`;
// the registry's own `attempts` stays the flat record of what was tried, in dispatch order.

for (const pin of ['rust-review', 'nix-review']) {
  test(`${pin}: the delegation resolves in a qualified-only registry (installed plugin)`, async () => {
    const { attempts, fn } = registry(['craft:review'])
    const { report } = await runEngine(pin, { args: {}, script: { '*': null, workflow: ({ argv }) => fn(...argv) } })
    assert.equal(report, REPORT, 'the child\'s report must come back through the pin')
    assert.deepEqual(attempts, ['craft:review'])
  })

  test(`${pin}: the delegation resolves in a bare-only registry (checkout)`, async () => {
    const { attempts, fn } = registry(['review'])
    const { report, logs } = await runEngine(pin, { args: {}, script: { '*': null, workflow: ({ argv }) => fn(...argv) } })
    assert.equal(report, REPORT)
    assert.deepEqual(attempts, ['craft:review', 'review'])
    assert.ok(logs.some(l => /did not resolve here/.test(l)), 'the fallback reaches the run log')
  })

  test(`${pin}: EXHAUSTION — a registry with neither spelling fails the run loudly`, async () => {
    const { fn } = registry([])
    await assert.rejects(
      () => runEngine(pin, { args: {}, script: { '*': null, workflow: ({ argv }) => fn(...argv) } }),
      /neither 'craft:review' nor 'review' resolved/,
      'an unresolvable child must fail the pin, never return something report-shaped',
    )
  })
}

test('rust-review: a nested run that failed on its own fails the pin — it is not relaunched', async () => {
  const attempts = []
  const fn = async name => { attempts.push(name); throw new Error('the nested review itself failed mid-run') }
  await assert.rejects(
    () => runEngine('rust-review', { args: {}, script: { '*': null, workflow: ({ argv }) => fn(...argv) } }),
    /failed mid-run/,
  )
  assert.deepEqual(attempts, ['craft:review'], 'one launch — a failed review must not be run twice under the other spelling')
})

// The scout answer that drives rust-audit's PER-CRATE fan-out (two changed crates → two nested
// reviews through the fan-out site) — as opposed to the whole-workspace site, which fires when
// the scout resolves nothing. Both sites are exercised separately: each is its own hard-coded
// launch in the engine, and either can regress alone.
const TWO_CRATES = {
  hasDiff: true, hasUnsafe: false, baseRef: 'main', repoRoot: '/ws', notes: 'x', edges: [],
  crates: [{ name: 'a', path: 'crates/a' }, { name: 'b', path: 'crates/b' }],
  changedCrates: [{ name: 'a', path: 'crates/a' }, { name: 'b', path: 'crates/b' }],
}

test('rust-audit (whole-workspace site): both registry shapes reach a running nested review', async () => {
  for (const [shape, resolvable, expected] of [
    ['qualified-only', ['craft:review'], ['craft:review']],
    ['bare-only', ['review'], ['craft:review', 'review']],
  ]) {
    const { attempts, fn } = registry(resolvable)
    const { calls } = await runEngine('rust-audit', { args: {}, script: { '*': null, workflow: ({ argv }) => fn(...argv) } })
    assert.deepEqual(attempts, expected, `${shape}: the launch sequence`)
    const synthesis = calls.find(c => c.label === 'synthesis')
    assert.ok(synthesis, `${shape}: the run must reach synthesis`)
    assert.match(synthesis.prompt, /"dimension": "review"/, `${shape}: the review dimension produced a result`)
    const notRunLine = synthesis.prompt.split('\n').find(l => l.startsWith('NOT RUN')) || ''
    assert.ok(!/\breview\b/.test(notRunLine), `${shape}: and it must not ALSO be listed as not run`)
  }
})

test('rust-audit (per-crate fan-out site): both registry shapes reach both crate reviews', async () => {
  for (const [shape, resolvable, expected] of [
    ['qualified-only', ['craft:review'], ['craft:review', 'craft:review']],
    ['bare-only', ['review'], ['craft:review', 'craft:review', 'review', 'review']],
  ]) {
    const { attempts, fn } = registry(resolvable)
    const { calls } = await runEngine('rust-audit', {
      args: {},
      script: { scout: TWO_CRATES, '*': null, workflow: ({ argv }) => fn(...argv) },
    })
    // The fan-out runs concurrently, so only the multiset of attempts is stable.
    assert.deepEqual([...attempts].sort(), [...expected].sort(), `${shape}: every crate's launch went through the resolver`)
    // Live dispatches only: in the bare-only shape each crate's refused `craft:review` attempt is
    // in the trail too, carrying `threw` — the resolution must leave exactly one ANSWERED launch
    // per crate, each under its own scope.
    const scopes = calls.filter(c => c.label === 'workflow' && !c.threw).map(c => c.argv[1].path).sort()
    assert.deepEqual(scopes, ['crates/a', 'crates/b'], `${shape}: each crate keeps its own scope through the resolution`)
    const synthesis = calls.find(c => c.label === 'synthesis')
    assert.match(synthesis.prompt, /"dimension": "review:a"/, `${shape}: crate a's review produced a result`)
    assert.match(synthesis.prompt, /"dimension": "review:b"/, `${shape}: crate b's review produced a result`)
  }
})

test('rust-audit EXHAUSTION: neither spelling resolving is a NOT-RUN dimension and an INCOMPLETE audit', async () => {
  // Inside the fan-out the thunk's `.catch(() => null)` absorbs the throw — by design, one dead
  // dimension must not kill the other nine. What must NOT happen is silence: the dimension has to
  // land in the NOT-RUN bookkeeping and mark the whole audit INCOMPLETE.
  const { attempts, fn } = registry([])
  const run = await runEngine('rust-audit', { args: {}, script: { '*': null, workflow: ({ argv }) => fn(...argv) } })
  assert.deepEqual(attempts, ['craft:review', 'review'], 'both spellings were tried before the dimension died')
  assert.ok(run.logs.some(l => /No result from: .*\breview\b/.test(l)), 'the miss is logged by name')
  const synthesis = run.calls.find(c => c.label === 'synthesis')
  const notRunLine = synthesis.prompt.split('\n').find(l => l.startsWith('NOT RUN')) || ''
  assert.match(notRunLine, /\breview\b/, 'the synthesis is told the review never ran')
  const record = filedRecord(run)
  assert.ok(record, 'the run still files its record')
  assert.ok(record.notRun.includes('review'), 'and the record carries the miss')
  assert.match(String(record.verdict), /INCOMPLETE/i, 'an audit whose review never ran is INCOMPLETE, never clean')
})

test('rust-audit: a nested review that failed on its own is NOT relaunched under the other spelling', async () => {
  const attempts = []
  const fn = async name => { attempts.push(name); throw new Error('the nested review itself failed mid-run') }
  const run = await runEngine('rust-audit', { args: {}, script: { '*': null, workflow: ({ argv }) => fn(...argv) } })
  assert.deepEqual(attempts, ['craft:review'], 'one launch — the fan-out\'s NOT-RUN bookkeeping takes it from here')
  assert.ok(filedRecord(run).notRun.includes('review'), 'and the death still surfaces as NOT RUN')
})
