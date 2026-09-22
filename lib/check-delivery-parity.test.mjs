// The gate that compares the two deliveries, and the one that must be shown FIRING: a checker for
// a defect nobody can reproduce is a checker nobody trusts. The first case here is the defect that
// actually happened.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseVerdict, hasVerdictLine } from '../opencode/plugin/run-record.mjs'
import { OUTCOMES, UNPAIRED_BY_DESIGN, outcomesReported, checkParity, readAgents } from './check-delivery-parity.mjs'
import { REQUIREMENTS, REQUIREMENT_EXEMPTIONS, checkContentParity } from './check-delivery-parity.mjs'
// Namespace import for the shared form gate: a named import of a missing export kills the whole
// file at load, and the test that pins the export's existence must fail as ITS assertion instead.
import * as parity from './check-delivery-parity.mjs'

// The shape an OpenCode agent has to carry: a rubric, then the machine-read line whose instruction
// ENUMERATES all four tokens. The enumeration is what makes a naive word-count blind.
const MACHINE_LINE =
  'End with `VERDICT: X` where X is exactly one of the four tokens `APPROVE`, `WARNING`, `BLOCK`, `INCOMPLETE`.'

test('a port that lost the INCOMPLETE path is caught, though it still enumerates the token', () => {
  // The defect this checker exists for, in its own words: a fix shipped for Claude Code did not
  // reach the port, an unrun Miri reported Clean, and every gate stayed green because each judged
  // one file's shape alone. Note the port below CONTAINS the string `INCOMPLETE` — counting the
  // token would call it covered, which is why the rubric phrase is what is measured.
  const root = new Map([
    ['rust-miri', 'Rate: **Clean** if Miri ran and found nothing, **UB-found** ⛔ Block otherwise.\nIf nightly or miri is missing, report `INCOMPLETE (not run)` — an unrun Miri is never Clean.'],
  ])
  const port = new Map([
    ['rust-miri', `Rate: **Clean** if Miri ran and found nothing, **UB-found** otherwise.\n${MACHINE_LINE}`],
  ])
  const problems = checkParity(root, port, {})
  assert.equal(problems.length, 1)
  assert.match(problems[0], /rust-miri/)
  assert.match(problems[0], /agents\/ can report incomplete and opencode\/agents\/ cannot/)
})

test('the machine line alone is not a divergence', () => {
  // The false positive the first two versions of this checker produced, twice: the OpenCode port
  // must carry `VERDICT: X` and the Claude Code agent must not, so comparing the words as written
  // flagged every pair. Measuring the transport and calling it the meaning is the shape this
  // repository keeps producing; here it is pinned so a later "tightening" cannot bring it back.
  const rubric = 'Rate **Healthy** / **Concerns** / **At-risk**, or `INCOMPLETE (not run)` if no graph was built.'
  const root = new Map([['rust-architecture-reviewer', rubric]])
  const port = new Map([['rust-architecture-reviewer', `${rubric}\n${MACHINE_LINE}`]])
  assert.deepEqual(checkParity(root, port, {}), [])
})

test('an outcome the port gained and the root lacks is caught too', () => {
  // Both directions: a port that grew a verdict its origin cannot reach is the same divergence,
  // and it is the likelier one now that the port is edited by hand more often.
  const root = new Map([['rust-reviewer', 'Verdicts: **Approve** / **Block**, or `INCOMPLETE (not run)`.']])
  const port = new Map([
    ['rust-reviewer', 'Verdicts: **Approve** / **Warning** / **Block**, or `INCOMPLETE (not run)`.'],
  ])
  const problems = checkParity(root, port, {})
  assert.equal(problems.length, 1)
  assert.match(problems[0], /opencode\/agents\/ can report concern and agents\/ cannot/)
})

test('an unpaired agent must be excused by name, and the excuse expires', () => {
  const body = 'Verdicts: **Approve** / **Warning** / **Block**, or `INCOMPLETE (not run)`.'
  const excuse = { 'nix-reviewer': 'the OpenCode delivery ships no Nix profile — there is no nix-review command to call it' }

  // Not excused: shipping for one delivery only is a divergence until someone says otherwise.
  const surprise = checkParity(new Map([['rust-semver', body]]), new Map(), {})
  assert.equal(surprise.length, 1)
  assert.match(surprise[0], /ships only for Claude Code/)

  // Excused by an explicit allowlist entry: nix-reviewer has no OpenCode profile to call it.
  assert.deepEqual(checkParity(new Map([['nix-reviewer', body]]), new Map(), excuse), [])

  // And the excuse cannot outlive what it excused: once the port exists, the entry is stale.
  const stale = checkParity(new Map([['nix-reviewer', body]]), new Map([['nix-reviewer', body]]), excuse)
  assert.equal(stale.length, 1)
  assert.match(stale[0], /UNPAIRED_BY_DESIGN/)
  assert.match(stale[0], /now exists — drop the entry/)
})

test('a stale excuse for a deleted root file is caught too', () => {
  // The direction the root-keyed loop cannot reach: it only visits names present in `root`, so an
  // allowlist entry whose ROOT file was DELETED (present in neither map) is never visited by that
  // loop and its excuse lingers forever. A synthetic allowlist entry for a name absent from both
  // sides pins this — it states its own premise rather than depending on the real allowlist.
  const problems = checkParity(new Map(), new Map(), { 'ghost-reviewer': 'stood in for a deleted root file' })
  assert.ok(
    problems.some((p) => p.includes('ghost-reviewer') && p.includes('neither side')),
    'an UNPAIRED_BY_DESIGN entry for a name on neither side must be flagged as stale',
  )
})

test('a stale excuse for an OpenCode-only agent is caught too — the premise is false in reverse', () => {
  // Mirror of the deleted-root sweep above. UNPAIRED_BY_DESIGN means "ships only for Claude Code",
  // so an excuse for a name present ONLY under opencode/agents/ is exactly backwards. The root-keyed
  // pairing walk never visits that name (it is not in root), so catching this staleness is the
  // sweep's job, not the walk's — the walk only emits the "port of nothing" for the file itself.
  const body = 'Verdicts: **Approve** / **Warning** / **Block**, or `INCOMPLETE (not run)`.'
  const problems = checkParity(
    new Map(),
    new Map([['opencode-only', body]]),
    { 'opencode-only': 'the OpenCode delivery ships no Nix profile' },
  )
  assert.ok(
    problems.some((p) => p.includes('UNPAIRED_BY_DESIGN') && p.includes('opencode-only') && /premise/.test(p)),
    `an excuse for an OpenCode-only agent must be flagged stale as premise-false; got: ${JSON.stringify(problems)}`,
  )
})

test('a port of nothing is caught', () => {
  const body = 'Verdicts: **Approve** / **Block**, or `INCOMPLETE (not run)`.'
  const problems = checkParity(new Map(), new Map([['ghost', body]]), {})
  assert.equal(problems.length, 1)
  assert.match(problems[0], /has no counterpart under agents\//)
})

test('a second, unrelated allowlist entry does not disturb a test about something else', () => {
  // The property the injectable parameter buys: adding a second entry to UNPAIRED_BY_DESIGN must
  // not break a test whose subject is not the allowlist. Before this parameter, every synthetic
  // map had to carry the real allowlist's contents to stay quiet, so a second real entry would have
  // forced padding at every such call site (realm @nick/craft).
  const body = 'Verdicts: **Approve** / **Block**, or `INCOMPLETE (not run)`.'
  const root = new Map([['rust-reviewer', body], ['nix-reviewer', body], ['some-other-agent', body]])
  const port = new Map([['rust-reviewer', body]])
  const twoEntryAllowlist = { 'nix-reviewer': 'reason one', 'some-other-agent': 'reason two' }
  assert.deepEqual(checkParity(root, port, twoEntryAllowlist), [])
})

test('a rubric word is not found inside a longer one', () => {
  // `\b` matches between `k` and `-`, so a naive boundary finds `At-risk` inside `At-risky` and
  // `Block` inside `Blocking`. The hyphenated words are the reason the boundary is spelled out.
  assert.deepEqual([...outcomesReported('Blocking issues are listed below.')], [])
  assert.deepEqual([...outcomesReported('The design is At-risky at best.')], [])
  assert.deepEqual([...outcomesReported('Cleanup is pending.')], [])
  assert.deepEqual([...outcomesReported('Rate it **At-risk**.')], ['bad'])

  // The hyphen specifically: `(?<![\w-])`/`(?![\w-])` excludes `-` from the boundary class, not
  // just `\w`. Relaxing either class to plain `\w` (dropping the `-`) does not redden any of the
  // four assertions above — `\w` alone already stops `Blocking`/`At-risky`/`Cleanup` — so those do
  // not pin the hyphen at all. These do: `Semi-Clean` must not read as `Clean`, and `Block-list`
  // must not read as `Block`, because a hyphen sits directly against the rubric word on one side.
  assert.deepEqual([...outcomesReported('Rate it Semi-Clean for now.')], [])
  assert.deepEqual([...outcomesReported('See the Block-list policy.')], [])
})

test('the bare token is not the rubric phrase', () => {
  // The enumeration in the machine line contains `INCOMPLETE`; only the rubric phrase names the
  // outcome. This is the single distinction the first case above rests on.
  assert.deepEqual([...outcomesReported(MACHINE_LINE)], [])
  assert.deepEqual([...outcomesReported('report `INCOMPLETE (not run)` and stop')], ['incomplete'])
})

test('the vocabulary is what the parser actually reads', () => {
  // The tripwire. `parseVerdict`'s fallthrough is `Approve` by design (`parseVerdict('banana')` is
  // `Approve`), so asserting the RETURNED TOKEN for the `ok` row is vacuous — any word, real or
  // invented, would pass. `hasVerdictLine` is the one that distinguishes recognised vocabulary from
  // fallthrough, so the `ok` row is pinned by RECOGNITION: each word, in a realistic `Verdict: X`
  // line, must be recognised — and a control non-word in the same shape must not be. The other three
  // rows keep the direct `parseVerdict` assertion: their outcomes are not the fallthrough, so
  // asserting the returned token there is not vacuous.
  for (const w of OUTCOMES.ok) {
    assert.equal(hasVerdictLine(`Verdict: ${w}`), true, `${w} should be recognised as a reported verdict`)
  }
  assert.equal(
    hasVerdictLine('Verdict: banana'),
    false,
    'an invented word must NOT be recognised — otherwise the ok-row assertions above prove nothing',
  )

  const expected = { concern: 'Warning', bad: 'Block', incomplete: 'INCOMPLETE (not run)' }
  for (const outcome of ['concern', 'bad', 'incomplete']) {
    for (const w of OUTCOMES[outcome]) {
      assert.equal(parseVerdict(w), expected[outcome], `${w} should read as ${expected[outcome]}`)
    }
  }
})

test('the gate reads the body, not the frontmatter — a real file gutted of body signal fails', () => {
  // The falsifier from the review: take the real opencode/agents/rust-reviewer.md, replace every
  // body occurrence of INCOMPLETE with APPROVE (gutting the not-run path), leave the frontmatter
  // untouched. Before this gate stripped frontmatter, the description line alone kept the outcome
  // set fully covered and the mutation went undetected.
  const root = readAgents(fileURLToPath(new URL('../agents', import.meta.url)))
  const port = readAgents(fileURLToPath(new URL('../opencode/agents', import.meta.url)))
  const real = port.get('rust-reviewer')
  const fmEnd = real.indexOf('\n---\n', real.indexOf('---\n') + 4) + 5
  const frontmatter = real.slice(0, fmEnd)
  const body = real.slice(fmEnd)
  const gutted = frontmatter + body.replaceAll('INCOMPLETE', 'APPROVE')

  const mutatedPort = new Map(port)
  mutatedPort.set('rust-reviewer', gutted)
  const problems = checkParity(root, mutatedPort)
  assert.ok(
    problems.some((p) => p.includes('rust-reviewer')),
    'a body-level INCOMPLETE→APPROVE mutation must be caught even though the frontmatter still names INCOMPLETE',
  )
})

test('a leading BOM or blank line does not let the frontmatter mask a gutted body', () => {
  // The same falsifier as the test above, but with the port file carrying an invisible authoring
  // slip before its `---`. fs.readFileSync(…, 'utf8') keeps a UTF-8 BOM, and an editor can leave a
  // blank line; either defeats an anchored `^---`, so an un-normalized strip returns the WHOLE file
  // and measures the `description:` line — which still names every outcome — reading the gutted body
  // as fully covered and GREENING the exact divergence the strip exists to catch. This is the
  // inverted red-before-fix: with the strip un-normalized, the divergence assertions below do NOT
  // red (the silent hole); the tolerant strip makes them red on the hole and the control confirms
  // it did not simply start reding everything.
  const root = readAgents(fileURLToPath(new URL('../agents', import.meta.url)))
  const port = readAgents(fileURLToPath(new URL('../opencode/agents', import.meta.url)))
  const real = port.get('rust-reviewer')
  const fmEnd = real.indexOf('\n---\n', real.indexOf('---\n') + 4) + 5
  const gutted = real.slice(0, fmEnd) + real.slice(fmEnd).replaceAll('INCOMPLETE', 'APPROVE')

  for (const prefix of ['\uFEFF', '\n', '  \n\n']) {
    const mutatedPort = new Map(port)
    mutatedPort.set('rust-reviewer', prefix + gutted)
    const problems = checkParity(root, mutatedPort)
    assert.ok(
      problems.some((p) => p.includes('rust-reviewer')),
      `a body gutted of INCOMPLETE behind a ${JSON.stringify(prefix)} prefix must still be caught, `
        + 'not masked by the unstripped description line',
    )
  }

  // The control: a BOM on a HEALTHY port must not manufacture a divergence — the tolerant strip
  // still lands on the real body, which is in parity with its root counterpart.
  const healthy = new Map(port)
  healthy.set('rust-reviewer', '\uFEFF' + real)
  assert.deepEqual(checkParity(root, healthy), [], 'a BOM on a healthy port must not manufacture a divergence')
})

// Shared by every CLI-fixture test below (hoisted, byte-identical, when a second CLI test
// arrived — one copy of the equality logic, not one per test): a spawned copy of the checker
// enters CLI mode only through the raw equality `import.meta.url === `file://${process.argv[1]}``,
// and the base directory must survive that round-trip — see the first CLI test's comments for
// the full rationale (percent-encoding, symlinked tmpdirs).
const usable = p => {
  try {
    const real = fs.realpathSync(p)
    fs.accessSync(real, fs.constants.W_OK)
    return pathToFileURL(real).href === `file://${real}` ? real : null
  } catch {
    return null
  }
}

test('the CLI refuses an empty agents/ read instead of passing vacuously', t => {
  // `checkParity(new Map(), new Map())` returns [] — an empty read has nothing to diverge — so the
  // guard in the CLI block is the only thing between "agents/ failed to read" and a green exit.
  // That block never runs under import, so the guard is reachable only by running the file as a
  // process — and the CLI resolves `agents/` against its OWN location, never the cwd, so the
  // fixture relocates the checker instead: the real source is copied, byte-for-byte at test time,
  // into a tree whose agents/ is empty. Editing the real source (the falsifier: guard →
  // `if (false)`) therefore reaches this test on the next run.
  //
  // The exit code alone cannot pin the guard: with the guard gone, the REAL allowlist's staleness
  // check ("nix-reviewer exists on neither side") happens to fail an all-empty tree too. What only
  // the guard produces is its own message — that is the assertion that reddens without it.
  const src = fileURLToPath(new URL('./check-delivery-parity.mjs', import.meta.url))
  // The copied checker enters CLI mode only through the raw equality
  // `import.meta.url === `file://${process.argv[1]}``, and TWO things fail it: a path holding a
  // character `import.meta.url` percent-encodes (a space or non-ASCII segment — real under a
  // user-set TMPDIR), and a path reached through a SYMLINK — Node resolves the main entry's
  // symlinks, so the child's `import.meta.url` is the realpath while `process.argv[1]` stays as
  // passed. The second is not exotic: macOS's os.tmpdir() is `/var/folders/...` with `/var` a
  // symlink to `/private/var`. Either way the child imports as a no-op module and exits 0 having
  // checked nothing. So the base is NORMALIZED through realpathSync first and then held to the
  // same equality the child applies; everything appended below it is unencodable ASCII, and
  // mkdtemp creates fresh real directories, so a base that passes here passes in the child.
  //
  // The base sits OUTSIDE the working tree, deliberately: cleanup does not survive a hard kill (a
  // runner SIGKILL inside the 30s spawn window), and a fixture orphaned inside lib/ — agents/*.md
  // and a live copy of the checker included — would sit one glob-widening away from being read as
  // source, where the same litter under tmpdir misleads nobody. tmpdir is the ONLY candidate:
  // $HOME and the checkout's parent directory would put an orphaned, executable copy of repo code
  // where editors and other repos' tooling can pick it up, which is worse than not running.
  const base = usable(os.tmpdir())
  if (!base) {
    // Honest only for an exotic environment (a TMPDIR with a space or non-ASCII segment, or an
    // unwritable one): on CI and on dev machines tmpdir survives the equality and the test runs.
    t.skip('os.tmpdir() cannot host the CLI fixture — its realpath does not survive the file:// '
      + 'round-trip (or is unwritable), so a spawned copy could never enter CLI mode from here')
    return
  }
  const dir = fs.mkdtempSync(path.join(base, 'craft-parity-cli-'))
  // Belt to the finally's braces: a failed assertion unwinds through the finally, but an abort
  // that ends the process without unwinding this frame — an uncaught throw elsewhere, an explicit
  // process.exit — skips it, and 'exit' listeners still run on those. Only a raw signal (the hard
  // kill conceded above) beats both; that residue is the price of the out-of-tree base.
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* the finally already removed it */ } }
  process.on('exit', cleanup)
  try {
    fs.mkdirSync(path.join(dir, 'lib'))
    fs.mkdirSync(path.join(dir, 'agents'))
    fs.mkdirSync(path.join(dir, 'opencode', 'agents'), { recursive: true })
    const copy = path.join(dir, 'lib', 'check-delivery-parity.mjs')
    fs.copyFileSync(src, copy)

    // The empty run: agents/ exists and reads empty — exactly the state the guard is for. The
    // spawn timeout fails CLOSED: a hung child returns status null, and the equality below rejects
    // null as loudly as it rejects 0.
    const empty = spawnSync(process.execPath, [copy], { encoding: 'utf8', timeout: 30000 })
    assert.equal(empty.status, 1, `an empty agents/ must exit 1 (got ${empty.status}`
      + `${empty.error ? `, spawn error: ${empty.error.message}` : ''}: null means `
      + 'the spawn timed out or died — spawnSync names the cause in result.error, appended above; '
      + '0 means the child checked nothing — the guard is gone, or the CLI block never ran because '
      + 'the path did not survive file:// round-tripping, which the base choice above is there to '
      + 'rule out)')
    assert.match(empty.stderr, /no agent files found — the checker would pass vacuously/,
      'and must fail BY THE GUARD, naming the vacuous pass — not by some incidental problem downstream')
    assert.ok(!/all clean/.test(empty.stdout), 'an empty run must never print the success line')

    // The success control in the same fixture shape, so the exit codes compare like for like.
    // The CLI runs the REAL allowlist, and the control is coupled to it in BOTH directions: a
    // hard-coded name reddens when its entry is dropped (an unexcused root-only file), and a
    // fixture covering only the first entry reddens when a second is added (the staleness loop
    // flags an excused name existing on neither side). So the fixture is DERIVED — one root-side
    // file per allowlist entry: every excused name present, none unexcused.
    const excused = Object.keys(UNPAIRED_BY_DESIGN)
    assert.ok(excused.length > 0, 'UNPAIRED_BY_DESIGN is empty — this control writes one root-only '
      + 'file per excused agent and now has nothing to write; rebuild it to write the SAME paired '
      + 'agent under both agents/ and opencode/agents/ instead')
    for (const name of excused) {
      fs.writeFileSync(path.join(dir, 'agents', `${name}.md`),
        'Verdicts: **Approve** / **Block**, or `INCOMPLETE (not run)`.\n')
    }
    const ok = spawnSync(process.execPath, [copy], { encoding: 'utf8', timeout: 30000 })
    assert.equal(ok.status, 0, `the control run must pass, or the empty run's exit 1 proves nothing `
      + `(status ${ok.status}${ok.error ? `, spawn error: ${ok.error.message}` : ''}): ${ok.stderr}`)
    assert.match(ok.stdout, /all clean/)
    // The success SUMMARY itself — unasserted before, so a regression that dropped the "over N
    // requirement group(s)" clause, hard-coded the count, or miscounted groups stayed green while
    // the summary silently misstated what ran (the defect class this repo exists to catch).
    assert.match(ok.stdout, /compared \d+ agent pair\(s\).*over \d+ requirement group\(s\)/,
      'the success run must print the summary of what was compared')
    // Pin the count to the registry, so adding a second group updates the summary line and this
    // assertion together — the number in the line cannot drift from Object.keys(REQUIREMENTS).length.
    assert.match(ok.stdout, new RegExp(`over ${Object.keys(REQUIREMENTS).length} requirement group\\(s\\)`),
      'the requirement-group count in the summary must reflect the registry')
  } finally {
    // Guarded like its `cleanup` sister above: a throw from cleanup inside a finally REPLACES the
    // assertion failure that was unwinding through it, turning a real red into a confusing rm error.
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort; must not mask a failing assertion */ }
    process.removeListener('exit', cleanup)
  }
})

test('the repository itself is in parity', () => {
  // The gate over the real tree, so a divergence landing on main fails here and not only in CI.
  const root = readAgents(fileURLToPath(new URL('../agents', import.meta.url)))
  const port = readAgents(fileURLToPath(new URL('../opencode/agents', import.meta.url)))
  assert.ok(root.size > 0, 'agents/ must not read empty — an empty read passes vacuously')
  assert.deepEqual(checkParity(root, port), [])
})

// ── Requirement groups: the registry beyond the outcome set (realm @nick/craft, node #57) ──────
// OUTCOMES becomes the first entry (`verdict`) of a REQUIREMENTS registry, so the NEXT piece of
// required content rides the same engine: a future group arrives as a sibling entry in the same
// PR that lands its prose in both bodies. These tests pin that mechanic with a SYNTHETIC group,
// so they do not depend on any future group actually existing yet.

const EVIDENCE_GROUP = { evidence: ['Evidence of work', 'Proof the gate ran'] }
const TWO_GROUPS = { verdict: OUTCOMES, evidence: EVIDENCE_GROUP }
const VERDICT_RUBRIC = 'Verdicts: **Approve** / **Warning** / **Block**, or `INCOMPLETE (not run)`.'

test('the Miri fixture reds through checkContentParity exactly as it does through checkParity', () => {
  // Regression: the defect case this checker exists for must survive the generalization — same
  // single problem, same wording, byte-for-byte what the single-group entry point reports.
  const root = new Map([
    ['rust-miri', 'Rate: **Clean** if Miri ran and found nothing, **UB-found** ⛔ Block otherwise.\nIf nightly or miri is missing, report `INCOMPLETE (not run)` — an unrun Miri is never Clean.'],
  ])
  const port = new Map([
    ['rust-miri', `Rate: **Clean** if Miri ran and found nothing, **UB-found** otherwise.\n${MACHINE_LINE}`],
  ])
  const problems = checkContentParity(root, port, {})
  assert.equal(problems.length, 1)
  assert.match(problems[0], /rust-miri/)
  assert.match(problems[0], /agents\/ can report incomplete and opencode\/agents\/ cannot/)
  assert.deepEqual(problems, checkParity(root, port, {}))
})

test('a group phrase reachable in one body and not its pair is one problem naming the group and the agent', () => {
  // The point of the registry: content divergence BEYOND the outcome set reddens the gate. The
  // verdict group is deliberately in the registry too and in parity, so the one problem below
  // can only come from the group loop visiting the second entry.
  const root = new Map([['rust-reviewer', `${VERDICT_RUBRIC}\nEvery finding carries Evidence of work.`]])
  const port = new Map([['rust-reviewer', VERDICT_RUBRIC]])
  const problems = checkContentParity(root, port, {}, TWO_GROUPS, {})
  assert.equal(problems.length, 1)
  assert.match(problems[0], /rust-reviewer/)
  assert.match(problems[0], /"evidence"/)
  assert.match(problems[0], /agents\/ can report evidence and opencode\/agents\/ cannot/)

  // Mirrored: a port that gained content its origin lacks is the same divergence, other way.
  const mirrored = checkContentParity(port, root, {}, TWO_GROUPS, {})
  assert.equal(mirrored.length, 1)
  assert.match(mirrored[0], /rust-reviewer/)
  assert.match(mirrored[0], /"evidence"/)
  assert.match(mirrored[0], /opencode\/agents\/ can report evidence and agents\/ cannot/)
})

test('synonym phrases from the same group list are parity, not divergence', () => {
  // A group lists the formulations that NAME the requirement; two bodies reaching it through
  // different listed phrases agree on the meaning, and the gate must not measure the wording.
  const root = new Map([['rust-reviewer', `${VERDICT_RUBRIC}\nEvery finding carries Evidence of work.`]])
  const port = new Map([['rust-reviewer', `${VERDICT_RUBRIC}\nEvery finding carries Proof the gate ran.`]])
  assert.deepEqual(checkContentParity(root, port, {}, TWO_GROUPS, {}), [])
})

test('an exemption names (agent, group) with a reason and expires once both sides reach the group', () => {
  // Modeled on UNPAIRED_BY_DESIGN: an entry is a REASON, not a silence — and it cannot outlive
  // what it excused. Once the group's phrases are reachable on both sides, the entry excuses
  // nothing and must itself go red.
  const exemptions = { 'rust-reviewer': { evidence: 'the evidence clause ships to the port in the next PR' } }
  const withPhrase = `${VERDICT_RUBRIC}\nEvery finding carries Evidence of work.`

  const oneSided = checkContentParity(
    new Map([['rust-reviewer', withPhrase]]),
    new Map([['rust-reviewer', VERDICT_RUBRIC]]),
    {}, TWO_GROUPS, exemptions,
  )
  assert.deepEqual(oneSided, [])

  const stale = checkContentParity(
    new Map([['rust-reviewer', withPhrase]]),
    new Map([['rust-reviewer', withPhrase]]),
    {}, TWO_GROUPS, exemptions,
  )
  assert.equal(stale.length, 1)
  assert.match(stale[0], /rust-reviewer/)
  assert.match(stale[0], /"evidence"/)
  assert.match(stale[0], /REQUIREMENT_EXEMPTIONS/)
  assert.match(stale[0], /drop the entry/)
})

test('a registry group authored as a bare string is a loud form problem, not a vacuous green', () => {
  // The most likely authoring slip for a one-phrase group: `{ evidence: 'Evidence of work' }` —
  // a string where an object belongs. Without a form gate, `Object.entries` hands out the
  // string's characters, single-character whole-word regexes read as reachable in almost any
  // prose, and the group gates NOTHING while CI stays green — the silent-degradation class this
  // repository names as its production risk. The gate must instead red the run NAMING the group.
  const root = new Map([['rust-reviewer', 'Every finding carries Evidence of work.']])
  const port = new Map([['rust-reviewer', 'No such clause anywhere in this port.']])
  const problems = checkContentParity(root, port, {}, { evidence: 'Evidence of work' }, {})
  assert.ok(
    problems.some((p) => /REQUIREMENTS group "evidence"/.test(p)),
    `a string-valued group must be reported as a form problem naming the group; got: ${JSON.stringify(problems)}`,
  )
  assert.ok(
    problems.every((p) => p.includes('REQUIREMENTS group')),
    'a malformed registry must yield ONLY form problems — comparing through a broken registry proves nothing',
  )
})

test('a null registry group is a loud form problem naming the group, not a bare TypeError', () => {
  const root = new Map([['rust-reviewer', VERDICT_RUBRIC]])
  const port = new Map([['rust-reviewer', VERDICT_RUBRIC]])
  let problems
  assert.doesNotThrow(() => {
    problems = checkContentParity(root, port, {}, { verdict: OUTCOMES, evidence: null }, {})
  }, 'a null group must not throw from deep inside the comparison loop')
  assert.ok(
    problems.some((p) => /REQUIREMENTS group "evidence"/.test(p)),
    `the problem must name the malformed group; got: ${JSON.stringify(problems)}`,
  )
})

test('a phrase list authored as a bare string, or empty, is a loud form problem naming group and key', () => {
  const root = new Map([['rust-reviewer', VERDICT_RUBRIC]])
  const port = new Map([['rust-reviewer', VERDICT_RUBRIC]])
  const cases = [
    { evidence: { evidence: 'Evidence of work' } }, // string where an array belongs: per-character matching
    { evidence: { evidence: [] } }, // an empty list can never be reached — the key gates nothing
    { evidence: { evidence: ['Evidence of work', ''] } }, // an empty phrase matches everywhere
    // Whitespace-only is the empty phrase in disguise: the compiled boundary `(?<![\w-]) (?![\w-])`
    // matches punctuation spacing in almost any prose, so the group greens vacuously while the
    // bodies genuinely diverge — same silent class, one character wider.
    { evidence: { evidence: [' '] } },
    { evidence: { evidence: ['\t'] } },
    { evidence: {} }, // an empty group has no keys to compare at all
  ]
  for (const registry of cases) {
    const problems = checkContentParity(root, port, {}, registry, {})
    assert.ok(
      problems.some((p) => /REQUIREMENTS group "evidence"/.test(p)),
      `registry ${JSON.stringify(registry)} must red the gate naming the group; got: ${JSON.stringify(problems)}`,
    )
  }
  // The key is named too, where there is one to name.
  const keyed = checkContentParity(root, port, {}, { evidence: { evidence: 'Evidence of work' } }, {})
  assert.ok(keyed.some((p) => /key "evidence"/.test(p)), 'the offending key must be named')
})

test('an exemption keyed on an agent no pair carries is flagged as dead, not silently kept', () => {
  // Mirror of the UNPAIRED_BY_DESIGN sweep: the group loop only reaches (agent, group) cells for
  // PAIRED agents, so an exemption keyed on a deleted/misspelled agent — or on an agent currently
  // unpaired, which the loop `continue`s past before any group — is never consulted and would
  // linger forever without its own sweep.
  const dead = checkContentParity(new Map(), new Map(), {}, TWO_GROUPS, {
    'ghost-reviewer': { evidence: 'stood in for a deleted root file' },
  })
  assert.equal(dead.length, 1)
  assert.match(dead[0], /REQUIREMENT_EXEMPTIONS/)
  assert.match(dead[0], /ghost-reviewer/)
  assert.match(dead[0], /no agent pair/)

  // The unpaired case: the agent exists on one side, so it is not "deleted" — but the group
  // comparison still never runs for it, so the exemption is just as dead.
  const rootOnly = checkContentParity(
    new Map([['solo', VERDICT_RUBRIC]]),
    new Map(),
    {},
    TWO_GROUPS,
    { solo: { evidence: 'waiting on a port that never came' } },
  )
  assert.ok(
    rootOnly.some((p) => p.includes('REQUIREMENT_EXEMPTIONS') && p.includes('solo')),
    `an exemption on an unpaired agent must be flagged as dead; got: ${JSON.stringify(rootOnly)}`,
  )
  assert.ok(
    rootOnly.some((p) => p.includes('ships only for Claude Code')),
    'and the unpaired divergence itself must still be reported',
  )
})

test('an exemption naming a group the registry does not carry is flagged as dead', () => {
  // The typo case: `evidnce` is never looked up by the group loop (it iterates the registry's
  // names, not the exemption's), so without the sweep the entry never goes stale.
  const problems = checkContentParity(
    new Map([['rust-reviewer', VERDICT_RUBRIC]]),
    new Map([['rust-reviewer', VERDICT_RUBRIC]]),
    {},
    TWO_GROUPS,
    { 'rust-reviewer': { evidnce: 'a typo nothing would ever visit' } },
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /rust-reviewer/)
  assert.match(problems[0], /REQUIREMENT_EXEMPTIONS/)
  assert.match(problems[0], /"evidnce"/)
  assert.match(problems[0], /not in the REQUIREMENTS registry/)
})

test('readAgents returns agents in sorted order, so the FAIL output is stable across filesystems', () => {
  // POSIX readdir order is implementation-defined (ext4 hashes its entries, other filesystems
  // differ), and the pairing walk and the CLI print FAIL lines in that order. This checker's output
  // is diffed and pasted between agents, where a per-machine reordering reads as a spurious change,
  // so readAgents sorts. Pins the contract; note it cannot red-before-fix on a filesystem whose
  // readdir already happens to return sorted — the sort's value is holding on the ones that do not.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-parity-order-'))
  try {
    for (const n of ['zeta.md', 'alpha.md', 'mid.md', 'beta.md']) {
      fs.writeFileSync(path.join(dir, n), 'x')
    }
    assert.deepEqual([...readAgents(dir).keys()], ['alpha', 'beta', 'mid', 'zeta'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('readAgents rethrows a readdir failure that is not ENOENT, instead of reading it as an empty dir', () => {
  // A bare `catch { return out }` turned EVERY readdir failure into "no agents here": an
  // unreadable opencode/agents would misdiagnose as four missing ports, with the real cause
  // (permissions, a file where a directory belongs) discarded. Only a genuinely absent
  // directory may read as empty.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-parity-readagents-'))
  try {
    const file = path.join(dir, 'not-a-directory')
    fs.writeFileSync(file, 'plain file\n')
    assert.throws(
      () => readAgents(file),
      (err) => err.code === 'ENOTDIR',
      'a readdir failure other than ENOENT must surface, not read as an empty directory',
    )
    assert.equal(readAgents(path.join(dir, 'no-such-dir')).size, 0,
      'a genuinely missing directory still reads as empty — that is the one case the catch is for')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the repository itself is in content parity, and the real registry is today\'s outcome run', () => {
  // The gate over the real tree, through the generalized entry point and the REAL registry and
  // exemptions. With the registry at its one group (`verdict` IS the outcome table), this run is
  // identical to the outcome-set run it generalizes — pinned by comparing the two outputs.
  const root = readAgents(fileURLToPath(new URL('../agents', import.meta.url)))
  const port = readAgents(fileURLToPath(new URL('../opencode/agents', import.meta.url)))
  assert.ok(root.size > 0, 'agents/ must not read empty — an empty read passes vacuously')
  assert.equal(REQUIREMENTS.verdict, OUTCOMES, 'OUTCOMES must BE the registry\'s verdict group, not a copy')
  assert.deepEqual(REQUIREMENT_EXEMPTIONS, {})
  assert.deepEqual(checkContentParity(root, port), [])
  assert.deepEqual(checkContentParity(root, port), checkParity(root, port))
})

test('describeContentParity returns a structured verdict the CLI branches on, without re-deriving it', () => {
  // The CLI must learn "did the run short-circuit on a malformed configuration?" from the single
  // call, not recompute configurationFormProblems beside it. Two evaluations of the same decision
  // that must stay in lockstep are a summary that lies the moment the short-circuit condition is
  // widened on one side only — the misleading-wrapper-summary class this repo names as its risk.
  // So the structured result carries the discriminator, and the array entry point is exactly its
  // `problems`, computed once.
  const root = new Map([['rust-reviewer', VERDICT_RUBRIC]])
  const port = new Map([['rust-reviewer', VERDICT_RUBRIC]])

  const clean = parity.describeContentParity(root, port, {})
  assert.equal(clean.malformed, false, 'a well-formed configuration is not malformed')
  assert.deepEqual(clean.problems, [], 'and its problems are the comparison result, here empty')

  const broken = parity.describeContentParity(root, port, {}, TWO_GROUPS, { 'rust-reviewer': null })
  assert.equal(broken.malformed, true, 'a malformed configuration short-circuits before comparing')
  assert.ok(
    broken.problems.some((p) => /REQUIREMENT_EXEMPTIONS entry "rust-reviewer"/.test(p)),
    `and its problems are the form problems alone; got: ${JSON.stringify(broken.problems)}`,
  )

  // One source of truth: the array entry point IS the structured result's problems, so the CLI's
  // summary (which branches on `malformed`) can never disagree with what was actually compared.
  assert.deepEqual(
    checkContentParity(root, port, {}, TWO_GROUPS, { 'rust-reviewer': null }),
    broken.problems,
  )
  assert.deepEqual(checkContentParity(root, port, {}), clean.problems)
})

// ── One form gate over both hand-authored configuration surfaces ───────────────────────────────
// The REQUIREMENTS registry got a form gate because hand-authored data degrades silently; the
// sibling surface, REQUIREMENT_EXEMPTIONS, is hand-authored the same way and degraded the same
// ways — a null entry crashed with a bare TypeError naming nothing, a string entry produced one
// nonsense problem per CHARACTER, an empty `{}` entry lingered unswept forever. The invariant is
// the shape, not the table: every table of this kind passes ONE gate (`tableFormProblems`), so
// the next table inherits the protection instead of growing a third copy of the hole.

test('a null exemption entry is a loud form problem naming the entry, not a bare TypeError', () => {
  const root = new Map([['rust-reviewer', VERDICT_RUBRIC]])
  const port = new Map([['rust-reviewer', VERDICT_RUBRIC]])
  let problems
  assert.doesNotThrow(() => {
    problems = checkContentParity(root, port, {}, TWO_GROUPS, { 'rust-reviewer': null })
  }, 'a null exemption entry must not throw from Object.keys deep inside the sweep')
  assert.ok(
    problems.some((p) => /REQUIREMENT_EXEMPTIONS entry "rust-reviewer"/.test(p)),
    `the problem must name the malformed entry; got: ${JSON.stringify(problems)}`,
  )
})

test('an exemption entry authored as a bare string is one loud form problem, not per-character noise', () => {
  // `Object.keys` over a string yields its character indices, so the sweep reported `excuses a
  // group "0"` … `"5"` — six misleading problems and none naming the actual slip.
  const root = new Map([['rust-reviewer', VERDICT_RUBRIC]])
  const port = new Map([['rust-reviewer', VERDICT_RUBRIC]])
  const problems = checkContentParity(root, port, {}, TWO_GROUPS, { 'rust-reviewer': 'ships to the port next PR' })
  assert.ok(
    problems.some((p) => /REQUIREMENT_EXEMPTIONS entry "rust-reviewer"/.test(p)),
    `the problem must name the malformed entry; got: ${JSON.stringify(problems)}`,
  )
  assert.ok(
    problems.every((p) => !/"\d+"/.test(p)),
    `no per-character index garbage; got: ${JSON.stringify(problems)}`,
  )
})

test('an empty exemption group map is a loud form problem, not an entry that lingers unswept forever', () => {
  // `{ 'rust-reviewer': {} }` for a PAIRED agent: the sweep iterates zero keys, the group walk
  // consults `exemptions[name]?.[groupName]` and finds nothing — never used, never flagged.
  const root = new Map([['rust-reviewer', VERDICT_RUBRIC]])
  const port = new Map([['rust-reviewer', VERDICT_RUBRIC]])
  const problems = checkContentParity(root, port, {}, TWO_GROUPS, { 'rust-reviewer': {} })
  assert.ok(
    problems.some((p) => /REQUIREMENT_EXEMPTIONS entry "rust-reviewer"/.test(p)),
    `the empty entry must be flagged by name; got: ${JSON.stringify(problems)}`,
  )
})

test('an exemption reason that is not a non-empty string is a loud form problem, both failure directions', () => {
  // Falsy junk ('' , 0) sits inert forever — never excuses, never goes stale, never swept.
  // Truthy junk (an array or object — the natural one-level nesting slip) is worse: it ACTS as
  // an excuse and silently suppresses a real divergence. Both are authoring slips; both red.
  const root = new Map([['rust-reviewer', VERDICT_RUBRIC]])
  const port = new Map([['rust-reviewer', VERDICT_RUBRIC]])
  for (const reason of ['', '   ', 0, false, ['the reason text'], { nested: 'object' }]) {
    const problems = checkContentParity(root, port, {}, TWO_GROUPS, { 'rust-reviewer': { evidence: reason } })
    assert.ok(
      problems.some((p) => /REQUIREMENT_EXEMPTIONS entry "rust-reviewer", group "evidence"/.test(p)),
      `reason ${JSON.stringify(reason)} must red the gate naming entry and group; got: ${JSON.stringify(problems)}`,
    )
  }
})

test('the same malformed shapes red both configuration surfaces — the invariant is shared, not per-table', () => {
  // The proof the frame demands: the registry and the exemptions table are the same KIND of
  // surface, so the same catalogue of malformed record shapes must produce a named problem
  // whichever table carries it. One catalogue, two surfaces, one gate underneath.
  const root = new Map([['rust-reviewer', VERDICT_RUBRIC]])
  const port = new Map([['rust-reviewer', VERDICT_RUBRIC]])
  for (const bad of [null, undefined, 'a bare string', 42, [], {}]) {
    const viaRegistry = checkContentParity(root, port, {}, { verdict: OUTCOMES, evidence: bad }, {})
    assert.ok(
      viaRegistry.some((p) => /REQUIREMENTS group "evidence"/.test(p)),
      `registry record ${JSON.stringify(bad)} must red naming the group; got: ${JSON.stringify(viaRegistry)}`,
    )
    const viaExemptions = checkContentParity(root, port, {}, TWO_GROUPS, { 'rust-reviewer': bad })
    assert.ok(
      viaExemptions.some((p) => /REQUIREMENT_EXEMPTIONS entry "rust-reviewer"/.test(p)),
      `exemption record ${JSON.stringify(bad)} must red naming the entry; got: ${JSON.stringify(viaExemptions)}`,
    )
  }
})

test('tableFormProblems is the one carrier of the invariant — a third table inherits it by construction', () => {
  // Exported precisely so this can be pinned executably: both surface gates are thin specs over
  // this function, and a future table of the same kind comes through here with its own spec.
  assert.equal(
    typeof parity.tableFormProblems,
    'function',
    'the shared gate must be exported — REQUIREMENTS and REQUIREMENT_EXEMPTIONS are specs over it, not copies',
  )
  const spec = {
    surface: 'SOME_FUTURE_TABLE',
    entryNoun: 'entry',
    keyNoun: 'key',
    entryRule: 'is not a non-empty object — fix it',
    leafOk: (v) => v === 'valid',
    leafRule: 'must be the string "valid"',
  }
  assert.deepEqual(parity.tableFormProblems({ good: { k: 'valid' } }, spec), [])
  assert.deepEqual(parity.tableFormProblems({ broken: null }, spec), [
    'SOME_FUTURE_TABLE entry "broken" is not a non-empty object — fix it',
  ])
  assert.deepEqual(parity.tableFormProblems({ half: { k: 'valid', j: 'junk' } }, spec), [
    'SOME_FUTURE_TABLE entry "half", key "j" must be the string "valid"',
  ])
})

test('an empty REQUIREMENTS registry is a loud form problem, not a vacuous green', () => {
  // `checkContentParity(root, port, {}, {}, {})` over bodies that diverge on every verdict word
  // returned [] — the gate compared nothing and the run greened. The registry is the engine of
  // this checker: empty, it gates nothing, which is a configuration defect, not a quiet day.
  // (The exemptions table has no such rule: empty is its healthy state — nothing excused.)
  const root = new Map([['rust-reviewer', VERDICT_RUBRIC]])
  const port = new Map([['rust-reviewer', 'No verdict words anywhere in this port.']])
  const problems = checkContentParity(root, port, {}, {}, {})
  assert.ok(
    problems.some((p) => /REQUIREMENTS carries no groups/.test(p)),
    `an empty registry must red the gate; got: ${JSON.stringify(problems)}`,
  )
})

test('a dead exemption group named like an Object.prototype property is still swept', () => {
  // `groupName in requirements` walks the prototype chain: `toString` satisfies it though the
  // registry carries no such group, so the one typo class the sweep structurally could not see
  // was a name that happens to be an inherited property. `Object.hasOwn` sees own keys only.
  const root = new Map([['rust-reviewer', VERDICT_RUBRIC]])
  const port = new Map([['rust-reviewer', VERDICT_RUBRIC]])
  const problems = checkContentParity(root, port, {}, TWO_GROUPS, { 'rust-reviewer': { toString: 'dead entry' } })
  assert.ok(
    problems.some((p) => p.includes('"toString"') && /not in the REQUIREMENTS registry/.test(p)),
    `a prototype-named dead group must be flagged; got: ${JSON.stringify(problems)}`,
  )
})

test('a root-only agent named like an Object.prototype property is flagged, not masked as excused', () => {
  // The pair-pass twin of the sweep test above (deadExemptionProblems). `agentPairProblems` read
  // the excuse as a bare `unpaired[name]`, and agent names come from filenames: an agent
  // `constructor.md` (or `toString.md`) with no port makes `unpaired['constructor']` resolve to the
  // inherited Object constructor — truthy — so the root-only branch reads it as UNPAIRED_BY_DESIGN
  // and returns [], masking the very divergence the gate exists to catch. The allowlist is EMPTY,
  // so nothing legitimately excuses this name. `Object.hasOwn` sees own entries only.
  const root = new Map([['constructor', VERDICT_RUBRIC]])
  const port = new Map()
  const problems = checkContentParity(root, port, {}, TWO_GROUPS, {})
  assert.ok(
    problems.some((p) => p.includes('agents/constructor.md') && /ships only for Claude Code/.test(p)),
    `a prototype-named root-only agent must be flagged, not masked as excused; got: ${JSON.stringify(problems)}`,
  )
})

test('an exemption goes stale once the pair reaches the group identically — a subset suffices, by design', () => {
  // The deliberate semantics, pinned so it cannot flip silently in either direction. NOT "every
  // key of the group reachable on both sides": a group may carry a key unreachable on both sides
  // by design (rust-miri reports no `concern` — it has no Warning path), and full-group staleness
  // would let an entry on such a group linger forever — the silent-linger class the sweeps exist
  // to kill. Identical partial reach instead retires the entry LOUDLY the moment the pair agrees;
  // a later one-sided key takes a fresh entry with a fresh reason. Loud churn over silent linger.
  const twoKey = { things: { a: ['Alpha clause'], b: ['Beta clause'] } }
  const body = 'Both sides carry the Alpha clause and nothing else.'
  const problems = checkContentParity(
    new Map([['rust-reviewer', body]]),
    new Map([['rust-reviewer', body]]),
    {},
    twoKey,
    { 'rust-reviewer': { things: 'the Beta clause lands in the next PR' } },
  )
  assert.equal(problems.length, 1, `exactly the staleness problem; got: ${JSON.stringify(problems)}`)
  assert.match(problems[0], /REQUIREMENT_EXEMPTIONS/)
  assert.match(problems[0], /"things"/)
  assert.match(problems[0], /identically/)
  assert.match(problems[0], /drop the entry/)
})

test('readAgents names the unreadable file instead of rethrowing a bare EISDIR', () => {
  // readFileSync on a directory named `x.md` throws `EISDIR: illegal operation on a directory,
  // read` with NO path attached (verified on Node 22: err.path is undefined), and the CLI has no
  // try/catch of its own — the raw form crashes the run pointing at nothing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-parity-eisdir-'))
  try {
    fs.mkdirSync(path.join(dir, 'oops.md'))
    assert.throws(
      () => readAgents(dir),
      (err) => err.message.includes('oops.md'),
      'the rethrow must name the file the read failed on',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the CLI does not claim a comparison that never ran when a configuration table is malformed', t => {
  // With a malformed configuration table checkContentParity returns the form problems alone,
  // having compared nothing — yet the CLI printed `compared N agent pair(s) …` anyway: a wrapper
  // summary misstating what ran, the exact shape AGENTS.md warns about. The fixture mutates a
  // COPY's exemptions table into a null entry (the plausible hand-authoring slip) and asserts the
  // run reds NAMING the entry, prints the honest summary, and never prints the pairs line.
  const src = fileURLToPath(new URL('./check-delivery-parity.mjs', import.meta.url))
  const base = usable(os.tmpdir())
  if (!base) {
    t.skip('os.tmpdir() cannot host the CLI fixture — see the first CLI test')
    return
  }
  const dir = fs.mkdtempSync(path.join(base, 'craft-parity-cli-malformed-'))
  try {
    fs.mkdirSync(path.join(dir, 'lib'))
    fs.mkdirSync(path.join(dir, 'agents'))
    fs.mkdirSync(path.join(dir, 'opencode', 'agents'), { recursive: true })
    const source = fs.readFileSync(src, 'utf8')
    const anchor = 'export const REQUIREMENT_EXEMPTIONS = {}'
    assert.ok(
      source.includes(anchor),
      'the fixture mutates the real exemptions table in a copy; its anchor moved — update the anchor',
    )
    const copy = path.join(dir, 'lib', 'check-delivery-parity.mjs')
    fs.writeFileSync(copy, source.replace(anchor, 'export const REQUIREMENT_EXEMPTIONS = { ghost: null }'))
    // The derived agents fixture from the first CLI test's control run: every excused name
    // present so the run reaches the summary, none unexcused.
    for (const name of Object.keys(UNPAIRED_BY_DESIGN)) {
      fs.writeFileSync(path.join(dir, 'agents', `${name}.md`),
        'Verdicts: **Approve** / **Block**, or `INCOMPLETE (not run)`.\n')
    }
    const run = spawnSync(process.execPath, [copy], { encoding: 'utf8', timeout: 30000 })
    assert.equal(run.status, 1, `a malformed configuration must exit 1 (got ${run.status}): ${run.stderr}`)
    assert.match(run.stderr, /REQUIREMENT_EXEMPTIONS entry "ghost"/,
      'the FAIL line must name the malformed entry')
    assert.match(run.stdout, /configuration malformed — nothing compared/,
      'the summary must say nothing was compared')
    assert.ok(!/compared \d+ agent pair/.test(run.stdout),
      'the pairs summary would claim a comparison that never ran')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
