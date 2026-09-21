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
  const usable = p => {
    try {
      const real = fs.realpathSync(p)
      fs.accessSync(real, fs.constants.W_OK)
      return pathToFileURL(real).href === `file://${real}` ? real : null
    } catch {
      return null
    }
  }
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
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
