// craft run-record writer — the deterministic half of run logging.
//
// WHY THIS EXISTS. A workflow script runs sandboxed with no filesystem access, so the only way it
// can reach disk is to spawn an agent with Bash. That constraint used to leak all the way into the
// data path: `logRun` handed a model the ENTIRE record (measured: 192KB) and a prose recipe for
// computing fields, naming the file and appending the index, so a model was formatting bytes it had
// no business formatting. It silently truncated at least one completed review to
// `dimensions: [], verification: null` — telemetry that cannot be told apart from "the lens found
// nothing". A model still has to TRANSPORT the record (nothing else can), but nothing here is left
// for it to DECIDE: this script owns the field computation, the layout, the index and the readback.
//
// It also fixes the second half of the problem — the record was only ever written at the very END.
// A run killed mid-flight (usage limit, hung agent, ^C) left nothing at all: three hours of work and
// zero telemetry. `checkpoint` lets a workflow persist each phase as it completes, `recover`
// promotes those leftovers into real (partial) records, and `from-journal` reconstructs a run from
// the transcript the runtime already wrote — with no model in the loop whatsoever.
//
// Commands (all read the payload from stdin unless noted):
//   write                                 one complete record → detail file + index line
//   checkpoint --phase <p> [--dir <d>] [--rejoin]
//                                         one phase slice; prints {"runDir":…} to reuse next time.
//                                         --rejoin re-enters THIS run's existing partial directory
//                                         when the first checkpoint failed and there is no --dir;
//                                         it adopts one only when the directory's own checkpoints
//                                         prove the same project/branch/head, and refuses when two
//                                         candidates do.
//   finalize [--dir <d>] [--rejoin]       complete record; folds in that run's checkpoints. --rejoin
//                                         locates them the same way when no --dir survived.
//   recover                               unfinalized checkpoint dirs → partial records (no stdin)
//   from-journal <transcriptDir>          rebuild a record from a workflow transcript (no stdin)
//   prior-round --branch <b> [--project <p>]  newest prior review round for that branch (no stdin)
//   repair-index [--apply]                index.jsonl: compact hand-written pretty-printed blocks,
//                                         quarantine damaged and duplicate ones; dry by default
//   enrich-cost --run-dir <d> --record <f>  POST-HOC (no stdin): sum the REAL per-agent cost
//                                         (cache_read/write) from <run-dir>/agent-*.jsonl and fold a
//                                         `cost` object into the record. Run by the launcher, which
//                                         holds the runId — not by any engine (the live sandbox
//                                         cannot see the transcripts). Idempotent.
//
// Run: node lib/craft-log-run.mjs <command> [flags]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ENGINE_REVISION, indexProjection, summarizeFindings, reviewVerdict, selectPriorRounds, fingerprint } from './run-record.mjs'
import { findJournalForRun } from './journal-link.mjs'
import { provesRound, reconcileChain } from './loop-state.mjs'
import { assembleLedgerShards } from './ledger-shards.mjs'

export const DEFAULT_STORE = path.join(os.homedir(), '.craft', 'runs')
const PARTIAL_DIR = '.partial'

// ---- computed fields -------------------------------------------------------------------------
// Everything here used to be a shell snippet in a prompt. It is ordinary IO with one rule: a field
// that cannot be resolved becomes null/'' and NEVER fails the run. Losing `dirty` is a blemish;
// losing the record because git was unhappy is the failure this whole file exists to prevent.
function git(args, cwd, { probe = false } = {}) {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return probe ? { ok: true, out } : out
  } catch {
    return probe ? { ok: false, out: '' } : ''
  }
}

// UTC, lexically sortable, filename-safe — selectPriorRound relies on string ordering being chronological.
export function stamp(d = new Date()) {
  return d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')
}

// The engine's own commit, not the project's: two runs of the same released version differ by this
// while a rubric is being edited. Resolved from THIS file's location, so no caller can get it wrong.
function craftRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

// The stable identity of the repository being reviewed. A run launched from a subdirectory, through
// a symlinked or differently-spelled path, or from a linked worktree would otherwise key its record
// to a DIFFERENT string than the next run — and the round chain breaks exactly the way a `.` key
// broke it.
//
// `--show-toplevel` does NOT collapse a linked worktree onto its main checkout — it reports the
// WORKTREE's own root, a different string from the main checkout's. Measured live in `~/.craft/runs`:
// rows are keyed to `.../.claude/worktrees/agent-a86b020e8815a0244` and
// `/private/tmp/.../scratchpad/wt-1254`, both linked worktrees of repos whose reviews are normally run
// from the main checkout — so `findPriorRound`'s exact-string match on `project` never reaches them,
// and the round chain silently restarts every time review happens to run from a worktree once and the
// main checkout the next time (or the reverse). `--git-common-dir` names the ONE `.git` a worktree and
// its main checkout share, so its parent is a key stable across both — for a main checkout, that
// parent is the same directory `--show-toplevel` already returned, so this changes nothing for the
// dominant case and only collapses the worktree one.
//
// Two things make "parent of the common dir" wrong on its own, both measured with real git (see
// craft-log-run.test.mjs):
//  - `git rev-parse` on git < 2.31 (no `--path-format`, shipped in 2021 — still current on e.g.
//    Ubuntu 20.04/Debian bullseye/RHEL 8) ECHOES the unrecognised flag to stdout and exits 0 rather
//    than failing: `commonDir` becomes the two-line string `"--path-format=absolute\n.git"`, whose
//    `dirname` is `"."` — every such run keys to the logger process's cwd, not the repo, and does so
//    silently. Guarded against by requiring the shape of a real answer (one line, absolute) before
//    trusting it.
//  - a submodule's common dir is `<super>/.git/modules/<name>` — its parent is `<super>/.git/modules`,
//    a directory that is neither a work tree nor unique per submodule: every submodule of one
//    superproject collapses onto that ONE key and can hand each other prior rounds; the same
//    derivation collides every bare repo beside another the same way. Guarded against by trusting the
//    parent-of-`.git` shortcut only when the common dir's own basename is literally `.git` (the plain
//    repo and linked-worktree shape) — a submodule's or bare repo's common dir never has that shape.
//
// This affects both sides: every NEW record's `project` field, and every read (`findPriorRound`,
// `recoverPartials`'s journal lookup) that keys off it — a deliberate, repo-wide re-keying, not a
// read-path patch, because a worktree review and a main-checkout review of the same repo are one
// round chain when the common dir's basename is `.git` (the plain repo and linked-worktree shape the
// guard above accepts). A worktree of a BARE repo, or of a SUBMODULE, does not have that shape, so the
// parent-of-`.git` shortcut correctly declines there and each side keys off its own `--show-toplevel`
// instead — the two round chains stay separate rather than merging. Measured as a degradation, not a
// defect: no cross-repo contamination, just lost round continuity for a topology this repo does not
// itself use. Not a git repo (or no git at all) → the resolved path, which is still better than a
// relative one.
export function repoKey(p = process.cwd()) {
  const abs = path.resolve(p)
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], abs)
  // Shape-check before trusting it: git silently echoes an unrecognised flag to stdout (exit 0) on
  // git < 2.31, so a single absolute-path line is the bar for "this is really the common dir".
  const validCommon = commonDir && !commonDir.includes('\n') && path.isAbsolute(commonDir)
  if (validCommon && /(?:^|[\\/])\.git$/.test(commonDir)) {
    // Plain repo or linked worktree: the parent of `.git` is the identity they share.
    return path.resolve(path.dirname(commonDir))
  }
  // Submodule (common dir ends in `.git/modules/<name>`, not `.git`) or bare repo (no `.git` subdir
  // at all — the common dir IS the repo). `--show-toplevel` gives each submodule its own distinct
  // root; a bare repo has none, so fall back to the common dir itself — still unique per bare repo,
  // unlike the collapsed parent this branch exists to avoid.
  const top = git(['rev-parse', '--show-toplevel'], abs)
  if (top) return path.resolve(top)
  if (validCommon) return path.resolve(commonDir)
  return abs
}

// The run's own branch and head, read from git by the SCRIPT rather than carried by a model.
//
// WHY. `branch` and `head` used to arrive exclusively from the `detect` agent's structured answer in
// review.js: the model ran `git rev-parse` itself and reported the strings. An agent that died,
// answered partially, or simply left the field empty produced a record with `branch: null` — and
// `findPriorRound` selects rows by `e.branch === branch`, so such a row does not exist for it.
// Measured on the live store on 2026-09-17: of 115 `kind:"workflow"` rows, 47 carried a branch and
// 60 a head, and a real run's prior-round read came back `found:false, ledgerCount:0` with
// `unattributable-rows-only` — the re-review memory could not even START. The same boundary this
// file's header draws for every other computed field applies here: THE MODEL TRANSPORTS, THE CODE
// DECIDES. The logger already runs as `cd <reviewed repo> && node <logger>`, so a shell and git are
// on hand at exactly the moment the record is written; `$CLAUDE_CODE_SESSION_ID` is resolved the
// same way, for the same reason.
//
// DETACHED HEAD RESOLVES TO NO BRANCH, deliberately. `git rev-parse --abbrev-ref HEAD` prints the
// literal string `HEAD` there, which is not a branch name: filed as one it would collect every
// detached run on the machine under a single shared key, and `findPriorRound`'s exact-string match
// would then hand one run's ledger to an unrelated one — worse than the missing round it fixes.
// Empty is the honest answer, and `findPriorRound` already reports `no-branch` for it.
//
// Nothing here may fail a write: every probe degrades to '' (see `git` above), so a bare repository,
// a repository with no commits, and no git at all all yield an empty field rather than a lost record.
export function gitIdentity(project = process.cwd()) {
  const ref = git(['rev-parse', '--abbrev-ref', 'HEAD'], project)
  return {
    branch: ref === 'HEAD' ? '' : ref,
    head: git(['rev-parse', 'HEAD'], project),
  }
}

// Git wins where git has an answer; the model's value survives only as a fallback for the fields git
// could not resolve. Written as "fill in only what git produced" rather than as an unconditional
// overwrite: on a detached HEAD or outside a repository the observed answer is "unknown", and
// unknown must not erase a value the caller did know.
export function applyGitIdentity(raw, id, fields = ['branch', 'head']) {
  const out = { ...raw }
  for (const k of fields) if (id && id[k]) out[k] = id[k]
  return out
}

// `engineRevision` is stamped HERE — the one choke point every write path passes through — rather
// than in each workflow script, so no engine can file a record that forgets to say which engine it
// was. It describes the checkout that is WRITING, which is exactly right for `write`/`finalize`/
// `recover` (the run and the writer are the same craft). `from-journal` is the one place it is a
// best guess — a transcript can be replayed by a later craft — and those records are `partial:true`,
// which analyze-runs excludes from every rate anyway.
// `session` is the harness's own `$CLAUDE_CODE_SESSION_ID`, shell-expanded into the logger's command
// line (never composed by a model — see lib/run-logging.mjs) and threaded through unchanged. An
// unset/empty value degrades to `null`, same as `craftCommit` — absence, not the string `""` read as
// a real id.
// ONE RECORD, ONE CHECKOUT. `project` is a `repoKey`, which deliberately collapses a linked worktree
// onto its main checkout so both share one round chain — so reading git off it answers about the MAIN
// checkout. `branch` and `head` are read off `workdir` (the path the caller actually pointed at) for
// exactly that reason, and `commit`/`dirty` used to be read off `project`: one record then described
// two working copies, and any analysis comparing `head` to `commit` was comparing different
// checkouts. `workdir` defaults to `project` so a caller that has only the one path is unchanged.
export function computedFields(project = process.cwd(), now = new Date(), session = '', workdir = '') {
  const observed = workdir || project
  return {
    engineRevision: ENGINE_REVISION,
    ts: stamp(now),
    project,
    commit: git(['rev-parse', '--short', 'HEAD'], observed),
    dirty: git(['status', '--porcelain'], observed).length > 0,
    craftCommit: git(['rev-parse', '--short', 'HEAD'], craftRoot()) || null,
    session: session || null,
  }
}

// A record's filename identity. `kind` and `name` come from the record; anything else would let two
// concurrent runs of different workflows collide on one file.
export function recordFilename(record) {
  const safe = s => String(s ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '-')
  return `${safe(record.ts)}-${safe(record.kind)}-${safe(record.name)}.json`
}

// ---- write -----------------------------------------------------------------------------------
// Readback is not ceremony. The whole point of the store is that a missing array means "the lens
// found nothing", so a write that half-lands must be LOUD rather than leave a plausible-looking file.
function verifyWritten(file, record) {
  const back = JSON.parse(fs.readFileSync(file, 'utf8'))
  const lost = Object.keys(record).filter(k => !Object.prototype.hasOwnProperty.call(back, k))
  if (lost.length) throw new Error(`readback lost key(s): ${lost.join(', ')}`)
  for (const [k, v] of Object.entries(record)) {
    if (Array.isArray(v) && (!Array.isArray(back[k]) || back[k].length !== v.length)) {
      throw new Error(`readback changed array '${k}': ${v.length} → ${Array.isArray(back[k]) ? back[k].length : 'not an array'}`)
    }
  }
  return back
}

export function writeRecord(input, { store = DEFAULT_STORE, project = process.cwd(), now = new Date(), session = '', gitId = null, workdir = '' } = {}) {
  fs.mkdirSync(store, { recursive: true })
  // `gitId` is opt-in rather than computed here, and that is the whole point of the parameter: the
  // CALLER knows whether the record describes a run happening NOW in `project` (write/finalize —
  // pass it) or one being reconstructed from an older run's checkpoints or transcript
  // (recover/from-journal — do not, or the reconstruction is re-stamped with whatever the checkout
  // is on today). It is applied HERE, not upstream in `finalizeRun`, because this is the one choke
  // point EVERY write path passes through — `write`, `finalize` and any future command — so no
  // caller can file a record that forgot to apply it, the same reason `engineRevision` is stamped
  // here.
  // It is NOT justified by the ownership proof in `finalizeRun`. An earlier version of this comment
  // claimed that filling `branch`/`head` before that comparison would make a run disagree with its
  // own checkpoints and stop them being folded — which assumed the payload's `head` AGREES with the
  // checkpoints' to begin with. It does not: review.js writes the diff base into checkpoint `head`
  // and the real HEAD into the record, so the fold was already failing on every run that reported a
  // head at all. `identityAgrees` no longer compares `head` for that reason (see its note), and
  // `branch` is the same string on both sides whether git or the caller supplied it — so the
  // placement is safe on its own merits, not because of anything the proof needs.
  const raw = gitId ? applyGitIdentity(input, gitId) : input
  // Computed fields win over anything the caller guessed: they are the ones this script exists to own.
  // `stamp()` has one-second resolution, so two runs of the same kind+name finishing in the same
  // second produced the same filename and the second silently overwrote the first — one record lost,
  // and the index then carrying two lines for one file. The partial directory got this treatment a
  // commit ago; the record itself is the half that actually matters. Claim the name: write
  // exclusively, step the stamp on collision. The record's own `ts` is recomputed with it, so the
  // file and its contents never disagree.
  let record = null
  let file = null
  for (let bump = 0; bump < 60; bump++) {
    record = { ...raw, ...computedFields(project, bump ? new Date(now.getTime() + bump * 1000) : now, session, workdir) }
    file = path.join(store, recordFilename(record))
    try {
      // `wx` is the whole fix: an existsSync probe followed by an ordinary write is check-then-write,
      // and two processes that both pass the probe both write — the loser's record is gone, while its
      // readback happily verifies against the winner's identical-by-construction file and both exit 0.
      fs.writeFileSync(file, JSON.stringify(record, null, 2), { flag: 'wx' })
      break
    } catch (e) {
      if (e && e.code === 'EEXIST') { file = null; continue }
      throw e
    }
  }
  if (!file) throw new Error(`cannot claim a record name under ${store} — 60 consecutive stamps taken`)
  verifyWritten(file, record)
  // One compact line, one atomic append — a partial index line would poison every later `jq -s`.
  fs.appendFileSync(path.join(store, 'index.jsonl'), JSON.stringify(indexProjection(record)) + '\n')
  ensureReadme(store)
  return { file, record }
}

// ---- checkpoints -----------------------------------------------------------------------------
// A phase slice is small by construction (counts and per-lens yields, not the findings themselves):
// the point is that a run killed at 80% still says what the scout planned, whether the gate was
// green, and what each lens yielded — not that it duplicates the final record early.
//
// A run's directory is minted by its FIRST checkpoint and handed back as `runDir`, which the
// sandboxed workflow threads into every later call — the sandbox has no clock and no randomness, so
// it cannot name the directory itself. When that first call dies (a dead logger agent, a moved
// craftRoot, a throw) the workflow never gets a `runDir`, and every later checkpoint used to mint
// its OWN directory off a fresh `now`: one run fragmenting into several orphan partials, each
// holding one phase, which `recover` then promotes as several unrelated half-runs.
//
// So the identity is re-derived from the store instead of from the clock: a checkpoint with no
// `--dir` REJOINS an unfinalized directory of the same kind+name — but ONLY one whose checkpoints
// PROVE they belong to this run. Nothing about the directory's shape changes —
// `<ts>-<kind>-<name>`, parsed back by `recover` exactly as before — so leftovers already in the
// store stay readable.
//
// The directory NAME identifies nothing: the store is one machine-global `~/.craft/runs`, and
// review.js hardcodes kind/name to `workflow`/`review` for every language pin and every repository.
// So every concurrently live review on the machine — including one against a different repo — is an
// equally valid candidate under a name-only predicate, and "newest" is the wrong tie-break: this
// run's own directory is by construction the OLDER one whenever a neighbour started later. Adopting
// a neighbour's directory is not a near miss — `finalize` folds its checkpoints into THIS run's
// record and then deletes it, so one record describes two runs and the victim's telemetry is gone.
//
// The identity is therefore read out of the checkpoints themselves: `project` (the reviewed repo
// root, written into every checkpoint from the `--project` the CLI already receives) plus `branch`
// and `head` where the checkpoints carry them — all three decide, and all three are code-computed
// (see `identityAgrees`).
// A candidate is adoptable only when its recorded
// identity AGREES with ours; a candidate carrying no identity at all (a legacy leftover) never is;
// and when two candidates agree, the rejoin REFUSES rather than guesses — fragmentation is
// recoverable, a merged record is not.
//
// The window is a second, weaker guard: a leftover older than any real review is not this run's
// even if the identity matches (same repo, same branch, yesterday). Six hours is well past any real
// review (the longest measured is about three) and well short of "yesterday". It is deliberately
// one-sided — a FUTURE-stamped directory (clock skew, a store restored from a backup) is not this
// run's either, and `Math.abs` made exactly those adoptable.
export const REJOIN_WINDOW_MS = 6 * 60 * 60 * 1000

// A directory whose run was finalized carries this marker. `finalize` writes it immediately before
// removing the directory, so the only case it has to survive is the one where the removal did not
// happen (a crash, a permission error). The previous guard looked for `<dirname>.json` in the store
// — a file that CANNOT exist: `writeRecord` stamps a fresh `ts` from `now`, so a record finalized
// from a directory minted minutes earlier never shares its name.
const FINALIZED_MARKER = '.finalized'

// What identifies a RUN inside a checkpoint. `project` is the reviewed repository root (repoKey),
// which is the discriminator that matters most — concurrent reviews are usually of different repos.
// `branch` refines it for two reviews of the same repo, and is compared only when both sides have
// it (not every phase payload carries it). `head` refines it further and IS part of the ownership
// proof: both sides are stamped by `gitIdentity` in the CLI now, so the spelling mismatch that once
// got it dropped is gone (see `identityAgrees` for that history).
export function checkpointIdentity(o) {
  const s = k => (o && typeof o[k] === 'string' ? o[k] : '')
  return { project: s('project'), branch: s('branch'), head: s('head'), session: s('session') }
}

// The identity a directory's checkpoints attest to, merged across phases: the first non-empty value
// wins, and a field two checkpoints disagree about is poisoned to null — a directory that cannot
// agree with itself is not a run anyone should adopt.
export function dirIdentity(phases) {
  const out = { project: '', branch: '', head: '', session: '' }
  for (const p of phases) {
    const id = checkpointIdentity(p)
    for (const k of Object.keys(out)) {
      if (!id[k]) continue
      if (!out[k]) out[k] = id[k]
      else if (out[k] !== id[k]) out[k] = null
    }
  }
  return out
}

// The set of DISTINCT session ids a directory's checkpoints attest to, in first-seen order. Exists
// alongside `dirIdentity` rather than changing it: `dirIdentity`'s job is ownership proof
// (identityAgrees relies on its poison-to-null contract, pinned by a test), and collapsing two
// disagreeing session ids to `null` there is correct for that job. But `recoverPartials`'s journal
// lookup needs the OPPOSITE: a resumed run's later checkpoints land under a NEW
// `$CLAUDE_CODE_SESSION_ID` in the same directory (the scenario this store exists to support — see
// identityAgrees above), and the run's journal is findable under whichever of those session ids the
// harness used for the phase that matters. Poisoning to null and giving up recovers nothing for
// exactly the resumed-run case the feature was built for. This returns every id seen, so the caller
// can try each rather than accept one wrong answer.
export function dirSessionIds(phases) {
  const seen = []
  for (const p of phases) {
    const id = checkpointIdentity(p).session
    if (id && !seen.includes(id)) seen.push(id)
  }
  return seen
}

// Adoptable only on PROOF. `project` must be present on both sides and equal — absence is not
// agreement, and a legacy directory that predates identity is refused rather than guessed at.
//
// `session` is NOT compared here, deliberately, even though it is one of `dirIdentity`'s fields. A
// run resumed in a new harness session writes its later checkpoints under a different
// `$CLAUDE_CODE_SESSION_ID` into the SAME `.partial` directory — that is the primary scenario this
// branch exists to support. Comparing it would poison `dirIdentity` to `session: null` the moment a
// resumed run's second checkpoint disagreed with its first, and `identityAgrees` would then refuse
// forever: `findRejoinableDir` returns null, `--rejoin` mints a second directory, and `finalizeRun`
// computes `mine === false` and strands the directory as an "does not belong to this run" orphan.
// `branch` and `head` are stable for the run's whole lifetime; `session` is not, so it plays no part
// in deciding ownership — only `project`/`branch`/`head` do. It is still recorded on every checkpoint
// and still read out of `dirIdentity`, because the journal lookup in `recoverPartials` needs it.
// `head` IS compared, and the history of that is worth one paragraph because the field was dropped
// once and putting it back is the whole point. It was dropped on a measurement: `workflows/review.js`
// used to write `head: baseRef` (the DIFF BASE — `origin/main`, a ref name) into every checkpoint
// while its final record carried the run's actual HEAD sha, and run through these functions with
// exactly those two payload shapes `finalizeRun` returned `folded: 0, kept: true`, stranded the
// `.partial` directory and filed a record with no `phases` at all. A field whose two writers
// disagree about its MEANING cannot prove ownership — but the answer to that is to fix the
// spelling, not to delete the discriminator, and the spelling IS fixed now: the checkpoints carry
// the real head and put the diff base under its own `baseRef` key, and BOTH sides are stamped by
// `gitIdentity` in the CLI (write, finalize AND checkpoint) rather than by a model.
//
// Without `head` the proof decays to "the same repository", which is the very refusal it exists to
// prevent, and `repoKey` makes "the same repository" wider than "the same checkout" — it collapses
// a linked worktree onto the main checkout on purpose. Two concrete losses that reopens: a stale
// `.partial` from an abandoned earlier run of the same repo and branch passes, so its phases are
// folded into an unrelated run's record and its directory deleted (this file's header calls that
// irrecoverable, unlike the fragmentation that refusing costs); and `rust-audit` fans out child
// `review`s per crate through `parallel`, where the siblings share project AND branch.
//
// `session` is NOT compared, for the reason above. Two directories that both pass this proof still
// make `findRejoinableDir` REFUSE rather than guess, which is what bounds the residual damage —
// including the concurrent-sibling case, where project, branch and head all coincide.
export function identityAgrees(want, have) {
  if (!want.project || !have.project || want.project !== have.project) return false
  if (want.branch && have.branch && want.branch !== have.branch) return false
  if (have.branch === null) return false                  // the directory disagrees with itself
  if (want.head && have.head && want.head !== have.head) return false
  if (have.head === null) return false                    // …about the head, equally disqualifying
  return true
}

// The ts in the directory name is the activity marker on purpose: it comes from the same clock as
// `now`, where a file mtime does not (a store restored from a backup, or a test driving `now`).
export function dirStamp(name) {
  const m = String(name).match(/^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ)-/)
  return m ? stampMs(m[1]) : NaN
}

// The same filename stamp read as a time. Named once because two populations are compared on it —
// index rows (`ts`) and surviving checkpoint directories (the stamp in the name) — and a comparison
// whose two sides parse differently is a comparison that silently always answers one way.
export function stampMs(ts) {
  const m = String(ts ?? '').match(/^(\d{4}-\d\d-\d\d)T(\d\d)[:-](\d\d)[:-](\d\d)(?:\.\d+)?Z$/)
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : NaN
}

export function findRejoinableDir(record, { store = DEFAULT_STORE, now = new Date(), project = '' } = {}) {
  const root = path.join(store, PARTIAL_DIR)
  if (!fs.existsSync(root)) return null
  const want = { ...checkpointIdentity(record), project: project || checkpointIdentity(record).project }
  // With no identity of our own there is nothing to match against, and "newest" is not identity.
  if (!want.project) return null
  const suffix = recordFilename({ ts: '', kind: record?.kind, name: record?.name }).replace(/^-|\.json$/g, '')
  const found = fs.readdirSync(root)
    .filter(n => n.endsWith(`-${suffix}`))
    // A finalized run's directory is gone already; this only guards the race where it is not.
    .filter(n => !fs.existsSync(path.join(root, n, FINALIZED_MARKER)))
    .map(n => ({ n, at: dirStamp(n) }))
    // One-sided on purpose: a directory stamped in the FUTURE is not this run's (see above).
    .filter(x => Number.isFinite(x.at) && now.getTime() - x.at >= 0 && now.getTime() - x.at <= REJOIN_WINDOW_MS)
    // Holding no checkpoint at all, it attests to no identity — mint a fresh one rather than adopt it.
    .map(x => ({ ...x, phases: readCheckpoints(path.join(root, x.n)) }))
    .filter(x => x.phases.length > 0)
    .filter(x => identityAgrees(want, dirIdentity(x.phases)))
  // Two directories that both prove this identity cannot both be this run, and picking either one
  // destroys the other on finalize. Refuse: the cost of refusing is fragmentation, which `recover`
  // still promotes into records; the cost of guessing is a merged record and a deleted victim.
  return found.length === 1 ? path.join(root, found[0].n) : null
}

// `rejoin` is OPT-IN, and that is the whole safety of it. Rejoining by "newest partial dir of this
// kind+name" cannot tell a run whose first checkpoint failed from a SECOND run started while the
// first is still going — and concurrent reviews on one machine are ordinary here. Left automatic,
// every concurrent run would adopt its neighbour's directory and finalize one record describing two
// runs: a worse corruption than the fragmentation this fixes, and on the healthy path rather than
// the failure path. Only the caller knows which case it is in — the workflow rejoins solely after a
// checkpoint of ITS OWN run has already failed.
export function checkpointDir(record, { store = DEFAULT_STORE, now = new Date(), project = process.cwd(), rejoin = false } = {}) {
  const found = rejoin ? findRejoinableDir(record, { store, now, project }) : null
  if (found) return found
  // `stamp()` has one-second resolution and `mkdirSync(recursive)` silently returns an existing
  // directory, so two runs whose first checkpoint lands in the same second shared one — and craft's
  // own fan-out makes that ordinary: rust-audit dispatches one nested review per changed crate. Both
  // runs then wrote phases into one directory and the first to finalize deleted it under the other.
  // Claim the directory instead of assuming it: create it exclusively and step the stamp on
  // collision. The name keeps its exact shape, so `recover`'s parse and the rejoin search are
  // untouched, and a second of skew in a directory NAME is nothing — the record's own `ts` is
  // computed at write time.
  // TWO recreates, and the count is not arbitrary: the FIRST is the ordinary cold start — nothing
  // pre-creates `<store>/.partial`, so the first checkpoint on a fresh machine always lands here —
  // which leaves exactly one for the case this bound is really about, `.partial` vanishing under a
  // concurrent sweep. Bounded at all is the fix: `bump -= 1; continue` returned to the same stamp,
  // so while the ENOENT persisted the loop never advanced and never reached the 60 bound. It spun
  // until the harness killed the logger's shell, turning a recoverable miss into a hang.
  let remakes = 0
  for (let bump = 0; bump < 60; bump++) {
    const at = bump ? new Date(now.getTime() + bump * 1000) : now
    const dir = path.join(store, PARTIAL_DIR, recordFilename({ ...record, ...computedFields(project, at) }).replace(/\.json$/, ''))
    try {
      fs.mkdirSync(dir, { recursive: false })
      return dir
    } catch (e) {
      if (e && e.code === 'EEXIST') continue
      if (e && e.code === 'ENOENT' && remakes++ < 2) { fs.mkdirSync(path.join(store, PARTIAL_DIR), { recursive: true }); bump -= 1; continue }
      throw e
    }
  }
  throw new Error(`cannot mint a partial directory under ${path.join(store, PARTIAL_DIR)} — 60 consecutive stamps taken`)
}

// `project` is written into EVERY checkpoint, not just the first: it is what a later rejoin matches
// on, and an identity present on only some slices is an identity a partially-written directory can
// fail to attest to. The shell-expanded `project`/`session` here always win over anything of the
// same name inside `payload` — see the identity-spreads-last note below; the record's own `project`
// does NOT override it.
export function writeCheckpoint(dir, phase, payload, { project = '', session = '' } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const seq = fs.readdirSync(dir).filter(f => /^\d\d-/.test(f)).length
  const safe = String(phase ?? 'phase').replace(/[^A-Za-z0-9._-]/g, '-')
  const file = path.join(dir, `${String(seq).padStart(2, '0')}-${safe}.json`)
  const identity = { ...(project ? { project } : {}), ...(session ? { session } : {}) }
  // Identity spreads LAST. `payload` is the JSON a logger AGENT copies into a heredoc — the
  // model-mediated channel this file's header documents as having silently corrupted data before —
  // so a `session`/`project` key inside it must never be able to shadow the shell-expanded identity.
  // Stripping those keys from `payload` first would work today but breaks silently the next time a
  // field is added to `identity` and someone forgets to strip it too; spreading last is correct by
  // construction regardless of what `identity` ends up containing.
  fs.writeFileSync(file, JSON.stringify({ phase, at: new Date().toISOString(), ...payload, ...identity }, null, 2))
  return file
}

export function readCheckpoints(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(f => /^\d\d-.*\.json$/.test(f)).sort()
    .map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      } catch (e) {
        return { phase: f, unreadable: String(e && e.message) }
      }
    })
}

// ---- finalize --------------------------------------------------------------------------------
// Folding a directory's checkpoints into this record and then DELETING it is the destructive half of
// the rejoin: if the directory is not this run's, one record describes two runs and the victim's
// checkpoints are gone. So the identity is checked here too, on the same terms — and a directory
// that disagrees is neither folded nor removed, but left for `recover` to promote as its own record.
//
// `rejoin` exists here for the same reason it exists on `checkpoint`: a run whose checkpoints all
// lost their `runDir` has a directory in the store and no `--dir` to name it. Without this, it files
// its record AND leaves that directory behind as an orphan.
// `--dir` arrives from a MODEL. The workflow cannot reach the filesystem, so the run directory makes
// a round trip through an agent's structured output and comes back as a string this script then
// `fs.rmSync(recursive, force)`s. A hallucinated, truncated or mis-copied path would therefore delete
// whatever it names. Nothing outside `<store>/.partial/` is ever a run directory, so anything else is
// refused outright rather than folded and removed.
// A model-supplied path is echoed into these messages, and the engine's logger agent is told to read
// lines starting `craft-log-run FAILED`. A path carrying a newline could therefore forge one — and a
// forged FAILED reports a landed record as lost. One line, bounded.
export function safePath(p) {
  return String(p ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200)
}

// The containment question itself, named once so it can be answered once. It is asked in two places
// with opposite polarity — refuse a run directory OUTSIDE the store, refuse a logger INSIDE the
// reviewed repo — and it has been got wrong separately in each: a string prefix that called
// `/x/store-evil` a child of `/x/store`, and a resolution that followed a symlinked directory but
// not a symlinked file. `lib/path-containment.test.mjs` holds one table of cases for this function
// and for the shell predicate that mirrors it in the logger prelude.
//
// Symlinks are resolved as far as they exist: `realpathSync` throws on a path that does not exist
// yet, which is ordinary here (a run directory about to be created), so the deepest existing
// ancestor is resolved and the remainder appended. Comparing an unresolved path against a resolved
// one is how a link pointing out of the store passed for a link that stayed in it.
function resolveAsFarAsItExists(p) {
  let abs = path.resolve(p)
  const tail = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(abs), ...tail.reverse())
    } catch (e) {
      // ONLY a path that does not exist yet is walked past. Catching everything degraded a symlink
      // loop, an unreadable parent or a bad mount into a purely lexical answer — the same fail-open
      // shape as a bound that keeps going when it runs out: the caller was told "resolved" about a
      // path that resolves nowhere. Anything other than absence is unresolvable, and unresolvable is
      // not an answer this predicate is allowed to invent.
      if (!e || e.code !== 'ENOENT') return null
      const parent = path.dirname(abs)
      if (parent === abs) return path.resolve(p)
      tail.push(path.basename(abs))
      abs = parent
    }
  }
}

export function containsPath(parent, child) {
  if (!parent || !child) return false
  const root = resolveAsFarAsItExists(parent)
  const abs = resolveAsFarAsItExists(child)
  // A path that cannot be resolved gets no verdict. Callers read this predicate to decide whether a
  // path is safe to act on, and "I could not tell" must never arrive dressed as "no".
  if (root === null || abs === null) return false
  // The filesystem root contains everything, and the prefix test below cannot express that: it would
  // compare against `//` and answer "outside" for every path. Both implementations of this predicate
  // had the same inversion, which is exactly why one shared table asks both.
  if (root === path.sep) return abs !== root
  // Slash-anchored, so a sibling that merely shares a prefix is not a child; and the directory is
  // not inside itself, which is the caller's business to interpret.
  return abs !== root && (abs + path.sep).startsWith(root + path.sep)
}

export function insideStore(dir, store) {
  if (!dir) return false
  return containsPath(path.resolve(store, PARTIAL_DIR), dir)
}

export function finalizeRun(raw, { store = DEFAULT_STORE, project = process.cwd(), dir = '', rejoin = false, now = new Date(), session = '', gitId = null, workdir = '' } = {}) {
  // Refuse the DIRECTORY, never the record. Throwing here cost the whole write: the CLI's catch turns
  // it into FAILED and exits before `writeRecord` runs, so a model that garbles `runDir` — the exact
  // untrusted value this guard exists for — lost the finished review record where the unguarded code
  // still filed it. That is the outcome the whole telemetry effort exists to prevent, introduced by
  // its own guard. The file already had the right precedent one branch down: a directory whose
  // identity disagrees sets `mine = false`, the record is written anyway and `kept` reports the
  // orphan for `recover`. Same shape here.
  const refusedDir = dir && !insideStore(dir, store) ? dir : ''
  // THE PROOF'S OWN SIDE IS CODE-COMPUTED, not payload-reported. `writeRecord` remains the single
  // choke point that applies `gitId` to the record being FILED; this is a separate use of the same
  // identity, for comparison only. It has to be stamped here because `checkpoint` stamps the other
  // side the same way: left as the payload reported it, the two sides disagree on spelling again
  // (the final payload carries `rev-parse --short`, a checkpoint the full sha) and the fold this
  // proof guards stops happening — the exact measurement that got `head` dropped the first time.
  const ownId = gitId ? applyGitIdentity({ ...raw, project }, gitId) : { ...raw, project }
  // A REFUSED directory ends the matter: it does NOT fall through into the rejoin search. The
  // fallback reads as helpful — the run has a real directory nobody can name any more — but what the
  // search returns is a guess, and it is the one guess with a destructive outcome. `findRejoinableDir`
  // refuses only at TWO or more candidates, and `rust-audit` fans one nested review out per crate, so
  // siblings sharing project, branch AND head are ordinary: the garbled twin finds EXACTLY ONE match
  // — its sibling's live directory — proves ownership on all three fields, folds it in and deletes it
  // while that sibling is still writing. The record is written either way; what is lost by refusing is
  // a fold that `recover` still performs later, against a live run's telemetry destroyed irrecoverably.
  const target = refusedDir ? null : (dir || (rejoin ? findRejoinableDir(ownId, { store, now, project }) : null))
  // Reading the leftovers must never be the reason the record is not written. A permission error, a
  // half-written slice or a vanished directory costs the FOLD, which recover can still do later.
  let phases = []
  let unreadable = ''
  try {
    phases = target ? readCheckpoints(target) : []
  } catch (e) {
    unreadable = String((e && e.message) || e)
  }
  // `--dir` is NOT proof of ownership, and treating it as proof left the destructive path unguarded.
  // The workflow keeps ONE `runDir` variable and assigns it from any successful checkpoint — including
  // one that used `--rejoin` and therefore ADOPTED a directory. From then on it passes `--dir <that>`
  // on every later call and on finalize, so the identity re-check added for exactly this ran only in
  // the case where no checkpoint ever returned a directory. The caller cannot distinguish a minted
  // runDir from a rejoined one, so the check belongs here and runs unconditionally: a directory that
  // ATTESTS an identity must agree with this record before its phases are folded in and it is
  // deleted. A directory attesting none is a legacy leftover — there is nothing to compare, and
  // refusing it would strand every partial written before identity existed.
  const attested = dirIdentity(phases)
  // THE TWO MODES ARE REAL, BUT THE FLAG THAT SEPARATED THEM NEVER ARRIVED. `ownDir` reads `dir &&
  // !rejoin` — "a directory this run minted itself" as against "one I searched for and might be
  // adopting" — and the distinction is worth having, because the two readings of a branch/head
  // disagreement are opposite: on a searched directory it means "not this run", and on this run's own
  // directory it means the working copy MOVED mid-run, which is ordinary during a long review and
  // must not cost the run its own phases. What was broken is that `logRunPrompt`/`checkpointPrompt`
  // emitted the rejoin flag as `!dir && rejoin`, so `--dir <d> --rejoin` could not be expressed at
  // all; review.js finalized with `{ dir: runDir, rejoin: checkpointFailed }`, so on every run that
  // had a runDir `rejoin` reached the CLI as false, `ownDir` was TRUE unconditionally, and ownership
  // degenerated to `attested.project === project` — "the same repository", which `repoKey` makes
  // wider still (it collapses a linked worktree onto the main checkout on purpose). The harm path
  // that opened: a first checkpoint fails, the second rejoins and ADOPTS a directory, `runDir` is now
  // someone else's, finalize passes `--dir <theirs>` with the rejoin flag swallowed — and the
  // directory is folded and deleted on a same-repo check. The flag is fixed at its source (see
  // lib/run-logging.mjs), and the engine's own predicate with it: review.js keeps a sticky
  // `rejoinArmed`, set when a checkpoint actually ASKS to rejoin (`!runDir && checkpointFailed`), and
  // finalizes on that rather than on the coarser `checkpointFailed` — which said "adopted" for any
  // run that merely lost a LATE checkpoint, and so spent the `ownDir` shortcut on runs that never
  // adopted anything. So `ownDir` is false exactly when the engine ever armed a rejoin, which is
  // exactly when its `runDir` may have been adopted. Pinned in lib/rejoin-arming.test.mjs, both ways.
  //
  // THE BOUNDARY, stated rather than implied. Even delivered, this separates the two modes by what
  // the ENGINE reports about its own checkpoints, not by anything observed about the directory. Two
  // cases stay open and are NOT closed by this code:
  //   - a `--dir` that is this run's by the engine's account but garbled in transit (it round-trips
  //     through an agent's structured output) is still accepted on a project-only check. The engine's
  //     own asked-vs-returned comparison in review.js is what catches that, not this proof.
  //   - EXACTLY TWO concurrent siblings — `rust-audit` fans one nested review out per crate — share
  //     project, branch AND head, so a sibling whose checkpoint failed finds exactly one matching
  //     live directory, adopts it, and folds and deletes it here while its sibling is still writing.
  //     `findRejoinableDir`'s refuse-on-two rule only bites at three or more, and the `head` this
  //     branch restored to the proof does not discriminate siblings either — it pays off against a
  //     STALE leftover of the same repo and branch at an older commit. STILL OPEN, deliberately —
  //     and open by ONE path only, the checkpoint that rejoins with no directory of its own. The
  //     second way in, a refused `--dir` falling back to the search, is closed at `target` above:
  //     read that refusal as a guarantee of the SEARCH and you will misread this paragraph, because
  //     it is not one. Closing what remains needs the search to reject a directory somebody is still
  //     writing into, which nothing here observes.
  //
  // A directory attesting NO project (`''`) is a legacy leftover written before identity existed —
  // nothing to compare, and refusing it would strand every such partial. A directory whose
  // checkpoints CONTRADICT each other about the project is the opposite case, and used to read as
  // the same one: `dirIdentity` poisons the field to `null`, `!attested.project` accepted that as
  // "attests nothing", and the dirtiest directory in the store short-circuited straight to `mine` —
  // folded and deleted. `null` is now a disagreement, and refused in BOTH modes.
  const ownDir = !!dir && !refusedDir && !rejoin
  const mine = !target || !phases.length ? true
    : attested.project === '' ? true
      : ownDir ? attested.project === project
        : identityAgrees({ ...checkpointIdentity(ownId), project }, attested)
  // Ledger shards are folded OUT, not in. They exist only so the ledger survives a lost record; the
  // record being written here carries the ledger in its own field, so folding them would store the
  // largest array in the record TWICE — and the record's size is the failure this whole path is
  // about. Their absence from `phases` costs nothing: a finalized directory is deleted anyway.
  const folded = mine ? phases.filter(p => !(p && typeof p === 'object' && p.ledgerShard)) : []
  // WHICH OBSERVATION OF GIT THE RECORD CARRIES. `gitId` was read at the moment of this call, which
  // for a review is hours after the run began: switch branches mid-review — ordinary while a long
  // audit runs — and the record is filed under whatever is checked out at the END. That is not a
  // cosmetic field, because the re-review chain selects on `branch`: the run's whole ledger is
  // attributed to a branch it never looked at, and the branch it did review has no round for it.
  // This run's OWN checkpoints already carry the same code-computed identity observed near its
  // start, so they are the better observation; write-time git is the fallback for a run that
  // checkpointed nothing. Still code over payload — just the code that ran at the right moment.
  // PER FIELD, never wholesale. Taken as a unit — `attested.branch || ''` — a run whose checkpoints
  // knew the head but not the branch handed `applyGitIdentity` an EMPTY branch, which it declines to
  // apply, so the record fell back to whatever the payload carried: the model-reported branch this
  // whole path exists to stop trusting. Each field independently prefers the start-of-run
  // observation and falls back to the write-time one, so a half-attested directory improves the
  // field it knows without demoting the field it does not.
  const startId = mine && attested && (attested.branch || attested.head)
    ? { branch: attested.branch || (gitId?.branch || ''), head: attested.head || (gitId?.head || '') }
    : null
  if (startId && gitId && ((startId.branch && gitId.branch && startId.branch !== gitId.branch) || (startId.head && gitId.head && startId.head !== gitId.head))) {
    console.error(`craft-log-run WARNING: the working copy moved during this run (${gitId.branch || '?'}@${String(gitId.head).slice(0, 8)} now, ${startId.branch || '?'}@${String(startId.head).slice(0, 8)} when it started) — filed under the identity it reviewed`)
  }
  // `writeRecord` stays the single choke point that APPLIES an identity to the record being filed;
  // this only chooses which of the two code-computed observations it is handed.
  const { file } = writeRecord(folded.length && !raw.phases ? { ...raw, phases: folded } : raw, { store, project, now, session, gitId: startId || gitId, workdir })
  // `!unreadable` is not tidiness: when readCheckpoints threw, `phases` is empty, so `mine` is true
  // by short-circuit and the directory would be DELETED on the strength of a read that never
  // happened — the comment above promises the fold is only deferred, and a transient EMFILE or a
  // TOCTOU race would instead make it permanent. Unread means unfolded, so it stays for `recover`.
  if (target && mine && !unreadable && fs.existsSync(target)) {
    // Marker first, removal second: if the removal fails, the leftover is still recognisably a run
    // that has already been finalized and no later rejoin can adopt it.
    try {
      fs.writeFileSync(path.join(target, FINALIZED_MARKER), `${new Date().toISOString()}\n`)
    } catch { /* the removal below is the point; the marker only covers its failure */ }
    // The record is already on disk at this point. A cleanup that cannot finish is untidy, not a
    // lost record — throwing here made the CLI print FAILED and the engine report a loss for a file
    // that exists, which is the same lie as silence, only louder.
    try {
      fs.rmSync(target, { recursive: true, force: true })
    } catch (e) {
      unreadable = unreadable || `the run directory could not be removed: ${String((e && e.message) || e)}`
    }
  }
  return { file, folded: folded.length, dir: target || '', kept: Boolean(target) && !mine, refusedDir, unreadable }
}

// ---- recover ---------------------------------------------------------------------------------
// A checkpoint dir that never got finalized IS the dead run. Promoting it costs nothing and turns
// "three hours, no telemetry" into a record that says exactly how far the run got.
export function recoverPartials({ store = DEFAULT_STORE, project = process.cwd(), now = new Date(), claudeHome } = {}) {
  const root = path.join(store, PARTIAL_DIR)
  if (!fs.existsSync(root)) return []
  const out = []
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name)
    if (!fs.statSync(dir).isDirectory()) continue
    if (fs.existsSync(path.join(dir, FINALIZED_MARKER))) continue // finalized; nothing to recover
    const phases = readCheckpoints(dir)
    if (!phases.length) continue
    // ts/kind/name are already encoded in the dir name — reuse them so the recovered record keeps
    // the identity its checkpoints were written under instead of getting a fresh "now".
    const m = name.match(/^(.*?Z)-(\w+)-(.*)$/)
    const head = phases.find(p => p.head)?.head ?? null
    const findings = phases.find(p => p.findings)?.findings ?? null
    // THE ROUND NUMBER, off the checkpoints the dead run wrote (workflows/review.js stamps `round`
    // on every phase payload). It is not decoration: `indexProjection` writes `r.round ?? 0`, so a
    // recovered record without it is indexed as round 0 and the next review of that branch starts
    // the chain over at 1 — one repair silently undoing every round that came before. Recovery must
    // not make the chain worse than the loss it repairs.
    const runRound = phases.map(p => Number(p.round)).find(n => Number.isFinite(n) && n > 0) || 0
    // Reconnect to the journal the harness already wrote for this run and pull a REAL ledger out of
    // it, instead of leaving the recovered record with only the checkpoint's {total, bySeverity}.
    // The per-directory identity (not the sweep's default `project`) is what must match: `recover`
    // promotes every unfinalized directory under the store in one pass, and those can belong to
    // different repositories. Best-effort by design — a journal that cannot be found, or whose file
    // cannot be parsed, must degrade to the checkpoint-only record, not abort the recovery.
    const runIdentity = dirIdentity(phases)
    const runProject = runIdentity.project || project
    // `session` is optional and only ever present on checkpoints written after this field was added
    // (a checkpoint written by an older build, or one where `$CLAUDE_CODE_SESSION_ID` was unset,
    // carries none). `dirIdentity` turns "two checkpoints disagree" into `null` — correct for
    // ownership proof (identityAgrees relies on it), but wrong here: a resumed run's later
    // checkpoints land under a NEW session id in the same directory, which is exactly the
    // "two checkpoints disagree" case, and it is the PRIMARY scenario recovery must still work for.
    // A single agreed session id is used directly; a poisoned (disagreeing) one falls back to trying
    // every distinct id the directory's checkpoints saw (dirSessionIds), never guessing among them.
    const runSession = typeof runIdentity.session === 'string' ? runIdentity.session : ''
    const runStartMs = dirStamp(name)
    // The reviewed branch, read off the checkpoints the same way `base` (below) will be — this is
    // the positive tie `findJournalForRun` now requires before it will match a journal off
    // uniqueness alone (see lib/journal-link.mjs: a unique-in-window candidate is unique BECAUSE the
    // run's own journal is missing at least as often as it is a real match, on the live store).
    const runBranch = phases.find(p => p.branch)?.branch ?? ''
    let journalFindings = null
    let journalFile = ''
    let linkStats = { seen: 0, linked: 0 }
    // Nothing downstream read `reason` before this — an operator saw only the generic checkpoint
    // fallback text and could not tell "no journal ever existed" from "refused for want of a branch
    // tie" or "two candidate journals, picked neither". Surfaced into `partialReason` below so the
    // refusal is legible instead of silent.
    let journalMissReason = ''
    try {
      const sessionCandidates = runSession ? [runSession] : dirSessionIds(phases)
      // Try each candidate session id and collect the ones that actually resolve to a journal. Two
      // ids each yielding a (necessarily different) journal is the same ambiguity findJournalForRun
      // itself refuses within one id — resolve to nothing rather than pick either.
      const hits = []
      for (const sid of sessionCandidates) {
        const jr = findJournalForRun({
          project: runProject, runStartMs, sessionId: sid, branch: runBranch,
          ...(claudeHome ? { claudeHome } : {}),
        })
        if (jr.found) hits.push(jr)
      }
      // A KNOWN session id (or set of them) that yielded no journal is positive evidence the journal
      // is not findable this way, not absence of evidence — falling through to the project-slug path
      // here would re-open exactly the uniqueness-without-evidence hole that path's branch tie exists
      // to close. Only the true "no session id at all" case (dirSessionIds found none — an older
      // checkpoint, or one written with $CLAUDE_CODE_SESSION_ID unset) still falls back to it, which
      // is the pre-existing fail-open shape for "session id unusable", not "session id tried and
      // missed".
      const jr = hits.length === 1 ? hits[0]
        : hits.length > 1 ? { found: false, reason: 'ambiguous-journals', count: hits.length }
          : sessionCandidates.length > 0 ? { found: false, reason: 'session-miss' }
            : findJournalForRun({ project: runProject, runStartMs, branch: runBranch, ...(claudeHome ? { claudeHome } : {}) })
      if (jr.found) {
        const raw = findingsFromJournal(jr.dir)
        linkStats = journalVerifyLinkStats(jr.dir)
        if (raw.length) { journalFindings = raw; journalFile = jr.file }
      } else {
        journalMissReason = jr.reason || ''
      }
    } catch { /* best-effort; recovery of the partial itself must not fail on a broken journal */ }
    // Trust gate: the journal recorded verify verdicts but NONE of them could be linked back to a
    // finding (a renamed/moved agent-<id>.jsonl, or its first user entry no longer being the verify
    // prompt — see verifyVerdictsFromJournal). `findingsFromJournal` already fell back to returning
    // every candidate unfiltered in that case (it cannot tell confirmed from refuted with zero
    // linked votes), which is fine as a BEST-EFFORT candidate list but must never be handed out as
    // `ledgerSource: 'journal'` — that marker is what lets a `partial: true` record feed the next
    // round's carry/adjudicate track (findPriorRound), and doing so here could resurrect findings
    // the dead run's own verification had already refuted. Refuse the ledger; findPriorRound then
    // rejects the record as `partial-only`, same as a partial with no ledger at all.
    const linkBroken = linkStats.seen > 0 && linkStats.linked === 0
    const base = {
      schemaVersion: 1, runtime: 'claude-code', kind: m ? m[2] : 'workflow', name: m ? m[3] : name,
      nested: false, via: null, partial: true,
      partialReason: journalFindings
        ? (linkBroken
          ? `run ended before it could write a final record — findings reconstructed from the workflow transcript (journal.jsonl), but ${linkStats.seen} verify verdict(s) recorded there could not be linked to their finding (0 of ${linkStats.seen} linked) — the reconstructed candidates are NOT trusted as a carry-forward ledger`
          : 'run ended before it could write a final record — findings reconstructed from the workflow transcript (journal.jsonl); the engine\'s own dedup/tier aggregation is not recoverable')
        : `run ended before it could write a final record — reconstructed from phase checkpoints${journalMissReason ? ` (journal not used: ${journalMissReason})` : ''}`,
      phases,
      verdict: phases.find(p => p.verdict)?.verdict ?? 'INCOMPLETE',
      findings: journalFindings ? summarizeFindings(journalFindings) : (findings ?? { total: 0, bySeverity: { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 } }),
      verifySeen: linkStats.seen, verifyLinked: linkStats.linked,
      // `ledgerSource: 'journal'` marks this ledger as reconstructed candidate evidence, not a
      // triaged/verified one — `findPriorRound` (below) checks exactly this marker before it will
      // let a `partial: true` record supply a prior round's ledger at all.
      ...(journalFindings && !linkBroken ? { ledger: normalizeLedger(journalFindings), ledgerSource: 'journal', journalFile } : {}),
      head, branch: runBranch || null, round: runRound,
      notRun: ['run did not finish — every phase after the last checkpoint is missing'],
    }
    // `runProject`, not the sweep's default `project`: `recover` promotes every unfinalized
    // directory under the store in one pass, and those can belong to different repositories (see the
    // note above `runIdentity`). Filing under the sweep's own default would put the record under the
    // wrong repository, invisible to `findPriorRound` for the repo that actually owns it.
    const record = { ...base, ...computedFields(runProject, now, runSession), ts: m ? m[1] : stamp(now) }
    fs.mkdirSync(store, { recursive: true })
    const file = path.join(store, recordFilename(record))
    // ALREADY PROMOTED. Reachable only on the path below that KEEPS a directory: the filename is
    // derived from ts/kind/name, all three read out of the directory's own name, so an existing file
    // means this very directory was recovered by an earlier sweep. Without this check a kept
    // directory would append one more index row on every `recover`, which is a worse lie than the
    // round it cannot read. Skipped whole — no second row, and the directory stays as evidence.
    if (runRound === 0 && fs.existsSync(file)) continue
    fs.writeFileSync(file, JSON.stringify(record, null, 2))
    fs.appendFileSync(path.join(store, 'index.jsonl'), JSON.stringify(indexProjection(record)) + '\n')
    // THE DIRECTORY IS KEPT when its round number could not be read — a directory written before
    // `round` rode on the checkpoints, or one whose every checkpoint is older than that. Deleting it
    // would destroy the only surviving witness of that round (`partialChainEvidence` reads exactly
    // these directories) and leave behind a row indexed as round 0, which reads as no round at all:
    // the repair would then be the thing that broke the chain. With a round in hand the record
    // carries the knowledge and the directory is redundant, so it goes, as before.
    if (runRound > 0) fs.rmSync(dir, { recursive: true, force: true })
    out.push({ file, phases: phases.length, round: runRound, kept: runRound === 0 })
  }
  ensureReadme(store)
  return out
}

// ---- from-journal ----------------------------------------------------------------------------
// The runtime already persists every agent's structured return value to journal.jsonl as it lands.
// That makes a dead run reconstructible with NO model involvement at all — the strongest form of
// "write it with a script". What cannot be recovered is the workflow's own aggregation (which
// findings were confirmed, how dedup merged them), so the result is explicitly marked partial and
// carries the raw per-agent evidence instead of pretending to be authoritative.
export function classifyResult(r) {
  if (!r || typeof r !== 'object') return 'unknown'
  if (Array.isArray(r.verdicts)) return 'verify-batch'
  if (typeof r.refuted === 'boolean' && typeof r.citedLineMatches === 'boolean') return 'verify'
  if (Array.isArray(r.findings)) return 'lens'
  if (Array.isArray(r.lenses) && r.sizeBucket) return 'scout'
  if (Array.isArray(r.files) && r.baseRef) return 'base'
  if (Array.isArray(r.groups)) return 'dedup'
  if (Array.isArray(r.missingLenses)) return 'critic'
  if (r.status && Array.isArray(r.seedFindings)) return 'gate'
  return 'unknown'
}

// A malformed line is a run whose index row is GONE, and a silent skip makes a partial read
// indistinguishable from a complete one — the defect this whole store keeps re-growing. The real
// ~/.craft/runs/index.jsonl was found holding 268 lines of which 29 do not parse: two blocks of
// pretty-printed multi-line records appended where one-line JSONL was expected (the workflow
// scripts instruct a MODEL to append the line, and a model sometimes pretty-prints it). So the
// count comes back with the entries, and `findPriorRound` says it out loud when it comes up empty:
// "this branch was never reviewed" and "its row is one of the 29 we could not read" are different
// answers, and only one of them means starting the ledger chain from scratch is correct.
export function readJsonlCounted(file) {
  if (!fs.existsSync(file)) return { entries: [], malformed: 0 }
  const entries = []
  let malformed = 0
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue
    try {
      entries.push(JSON.parse(l))
    } catch {
      malformed++
    }
  }
  return { entries, malformed }
}

function readJsonl(file) {
  return readJsonlCounted(file).entries
}

// Wall clock, spent agent time and the longest silence inside a single agent. The stall number is
// the one that matters operationally: a run whose slowest "agent" spent 64 minutes producing two
// tool calls was not working, it was hung, and no aggregate of durations shows that.
export function runtimeStats(dir) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^agent-.*\.jsonl$/.test(f)) : []
  let first = null, last = null, agentMs = 0, maxStallMs = 0
  const byModel = {}
  for (const f of files) {
    const times = readJsonl(path.join(dir, f)).map(o => o.timestamp && Date.parse(o.timestamp)).filter(Boolean)
    if (!times.length) continue
    times.sort((a, b) => a - b)
    for (let i = 1; i < times.length; i++) maxStallMs = Math.max(maxStallMs, times[i] - times[i - 1])
    agentMs += times[times.length - 1] - times[0]
    first = first === null ? times[0] : Math.min(first, times[0])
    last = last === null ? times[times.length - 1] : Math.max(last, times[times.length - 1])
    let model = 'unknown'
    try {
      model = JSON.parse(fs.readFileSync(path.join(dir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8')).model || 'unknown'
    } catch { /* meta is best-effort */ }
    byModel[model] = (byModel[model] || 0) + 1
  }
  const min = ms => Math.round(ms / 6000) / 10
  return {
    agents: files.length,
    wallClockMinutes: first === null ? 0 : min(last - first),
    agentMinutes: min(agentMs),
    longestStallSeconds: Math.round(maxStallMs / 1000),
    byModel,
  }
}

// Extracted from `recordFromJournal` so a caller that only wants the candidate findings (the
// journal-link recovery path below) does not have to re-derive the classification loop — one
// definition of "what counts as a finding in this journal", shared by the summary record and the
// reconstructed ledger.
// The same exact-match finding identity review.js's own pre-verification dedup uses (`key()` there:
// file:line:title, case/whitespace-normalized) — reused here so a journal-recovered verdict lines up
// with the journal-recovered finding it judged.
function findingKey(file, line, title) {
  return `${String(file || '').toLowerCase()}:${Number(line) || 0}:${String(title || '').toLowerCase().replace(/\s+/g, ' ').trim()}`
}

function firstUserText(agentFile) {
  for (const e of readJsonl(agentFile)) {
    if (!e || e.type !== 'user' || !e.message) continue
    const c = e.message.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      const t = c.find(x => x && x.type === 'text')
      if (t) return t.text || ''
    }
  }
  return ''
}

// verifyPrompt (review.js) embeds "FINDING: [severity] title\n  at file:line" — pull the identity
// back out of it. Exported so lib/craft-log-run.test.mjs can bind it to the REAL prompt text
// extracted from workflows/review.js, not a hand-typed copy — see the tripwire test there.
export function parseIndividualVerifyTarget(text) {
  const m = /FINDING:\s*\[[^\]]*\]\s*(.+?)\n\s*at\s+(.+?):(\d+)/.exec(text)
  return m ? { title: m[1], file: m[2], line: Number(m[3]) } : null
}

// batchVerifyPrompt (review.js) repeats "--- FINDING <i> ---\n[severity] title\n  at file:line"
// blocks — one per finding in the batch, `index` in the result matches `<i>` here.
export function parseBatchVerifyTargets(text) {
  const targets = new Map()
  const re = /---\s*FINDING\s+(\d+)\s*---\s*\n\[[^\]]*\]\s*(.+?)\n\s*at\s+(.+?):(\d+)/g
  let m
  while ((m = re.exec(text))) targets.set(Number(m[1]), { title: m[2], file: m[3], line: Number(m[4]) })
  return targets
}

// The verify/verify-batch `result` entry carries NO finding identity of its own — no fingerprint,
// no label, just an `agentId` (confirmed against a real journal on this machine: the entry is
// `{type, key, agentId, result}` and `key` is an opaque harness dedup hash, not a fingerprint of the
// finding). The identity survives only inside the verifier's OWN transcript — the harness persists
// that separately as `agent-<agentId>.jsonl` next to the journal, and its first user message IS the
// verify prompt review.js built, which embeds the finding's file:line:title (see verifyPrompt /
// batchVerifyPrompt in workflows/review.js). Best-effort per entry: a missing/unreadable/unparseable
// transcript contributes nothing to the tally rather than aborting it.
// Returns { tally, seen, linked }. `seen` counts every individual verify verdict the journal
// records (one per 'verify' result, one per entry of a 'verify-batch' result's `verdicts`);
// `linked` counts how many of those were actually matched back to a finding identity via a real
// agent-<id>.jsonl transcript. The gap between them is the observable signal that the harness
// renamed/moved a transcript, or verifyPrompt/batchVerifyPrompt changed shape out from under
// parseIndividualVerifyTarget/parseBatchVerifyTargets — see findingsFromJournal / recoverPartials
// for how callers act on it instead of silently trusting an empty tally.
export function verifyVerdictsFromJournal(dir) {
  const results = readJsonl(path.join(dir, 'journal.jsonl')).filter(e => e.type === 'result')
  const tally = new Map() // findingKey -> { refuted: n, upheld: n }
  let seen = 0
  let linked = 0
  const bump = (k, refuted) => {
    const t = tally.get(k) || { refuted: 0, upheld: 0 }
    t[refuted ? 'refuted' : 'upheld'] += 1
    tally.set(k, t)
    linked++
  }
  for (const e of results) {
    const k = classifyResult(e.result)
    if (k !== 'verify' && k !== 'verify-batch') continue
    seen += k === 'verify' ? 1 : (e.result.verdicts || []).filter(Boolean).length
    if (!e.agentId) continue
    const agentFile = path.join(dir, `agent-${e.agentId}.jsonl`)
    if (!fs.existsSync(agentFile)) continue
    let text
    try { text = firstUserText(agentFile) } catch { continue }
    if (!text) continue
    if (k === 'verify') {
      const target = parseIndividualVerifyTarget(text)
      if (target) bump(findingKey(target.file, target.line, target.title), !!e.result.refuted)
    } else {
      const targets = parseBatchVerifyTargets(text)
      for (const v of e.result.verdicts || []) {
        if (!v || typeof v.index !== 'number') continue
        const target = targets.get(v.index)
        if (target) bump(findingKey(target.file, target.line, target.title), !!v.refuted)
      }
    }
  }
  return { tally, seen, linked }
}

// NOT a cheap accessor, despite the name: it calls verifyVerdictsFromJournal(dir) IN FULL — re-reading
// journal.jsonl and every agent-<id>.jsonl transcript a second time — and returns only the seen/linked
// counts out of what it computed. `recordFromJournal` and `recoverPartials` each call this AND
// findingsFromJournal (which does its own internal call to verifyVerdictsFromJournal), so both pay the
// full re-derivation twice per run. Left as a correctness note rather than fixed here: fixing it means
// threading the already-computed stats out of findingsFromJournal instead of recomputing them, which
// is a shape change to that function's return value and its callers, not a one-line comment fix.
export function journalVerifyLinkStats(dir) {
  const { seen, linked } = verifyVerdictsFromJournal(dir)
  return { seen, linked }
}

// Cross-lens dedup for journal-reconstructed candidates: the journal holds RAW per-lens/per-gate
// output across every internal round with no dedup at all (the live engine's own dedupPool runs an
// LLM grouping pass before it ever persists a ledger — not reproducible here with no agent to
// dispatch). `fingerprint` (lib/run-record.mjs) is reused rather than inventing a third identity:
// it is the line-TOLERANT identity the engine already uses for cross-round ledger matching
// (matchesPrior), which is the right shape here too — the same defect reported by two lenses in the
// same journal rarely cites the exact same line. findingKey (file:line:title, exact) stays reserved
// for linking a verify verdict back to the ONE finding instance the verifier prompt named.
// Merge rule: keep the highest-severity member as the base (a lens that under-called severity must
// not suppress one that called it correctly), union every contributing `source`, and prefer a
// non-empty `why` from the member that supplied the final severity.
const SEVERITY_RANK = { Critical: 4, High: 3, Medium: 2, Low: 1, Info: 0 }
export function dedupJournalFindings(findings) {
  const groups = new Map() // fp -> merged finding
  for (const f of findings) {
    if (!f) continue
    const fp = fingerprint(f)
    const existing = groups.get(fp)
    if (!existing) {
      groups.set(fp, { ...f, sources: [f.source].filter(Boolean) })
      continue
    }
    const sources = [...new Set([...(existing.sources || []), f.source].filter(Boolean))]
    const curRank = SEVERITY_RANK[existing.severity] ?? -1
    const newRank = SEVERITY_RANK[f.severity] ?? -1
    groups.set(fp, newRank > curRank
      ? { ...f, sources, why: f.why || existing.why }
      : { ...existing, sources })
  }
  return [...groups.values()]
}

export function findingsFromJournal(dir) {
  const results = readJsonl(path.join(dir, 'journal.jsonl')).filter(e => e.type === 'result')
  const findings = []
  for (const e of results) {
    const k = classifyResult(e.result)
    if (k === 'lens') findings.push(...e.result.findings.filter(Boolean))
    // Gate seeds are tool-grounded findings, not gate metadata — omitting them would under-report
    // exactly the candidates that outrank a lens's judgement downstream.
    if (k === 'gate') findings.push(...e.result.seedFindings.filter(Boolean).map(f => ({ ...f, source: f.source || 'gate' })))
  }
  const { tally, seen, linked } = verifyVerdictsFromJournal(dir)
  if (!tally.size) return dedupJournalFindings(findings)
  // True journal-wide when at least one verify verdict was recorded but never linked to ANY finding
  // (a renamed/moved transcript — see verifyVerdictsFromJournal). When this is true, a per-finding
  // tally that shows a refuted majority cannot be trusted as the FULL panel that finding actually
  // got: some of its own votes may be among the ones that failed to link. The panel size tierFromVotes
  // compares against is only knowable when every vote in the journal linked; short of that, prefer
  // keeping a finding over dropping it on a partial, possibly-incomplete count.
  const panelIncomplete = seen > linked
  const out = []
  for (const f of findings) {
    const t = tally.get(findingKey(f.file, f.line, f.title))
    if (!t) { out.push(f); continue }
    // Mirrors tierFromVotes' own majority rule in review.js: a finding is only disconfirmed when
    // refutes are a STRICT MAJORITY of the actual panel it got (refuted+upheld here — the same
    // quantity tierFromVotes calls `v.length`, the votes actually collected, not a fixed panel
    // size). A panel that split 1 refuted / 2 upheld is refutes(1) <= half(1.5): NOT a majority, so
    // the finding survives (as suspected, below) — dropping it on the old `refuted > upheld`
    // comparison would have thrown away a real defect on a single dissenting vote. This also
    // matches what the LIVE engine persists: toLedgerEntry is only ever called on
    // confirmed/suspected findings (workflows/review.js ~3144) — a majority-refuted finding never
    // reaches a real ledger either, so dropping it here is not a new rule, just the existing one
    // applied to a reconstruction.
    const total = t.refuted + t.upheld
    if (t.refuted > total / 2) {
      // The recovered tally itself looks like a refuted majority — but if OTHER votes in this
      // journal never linked to any finding, this finding's own missing votes (if any) could have
      // been among them, e.g. the real panel was 1 refuted / 2 upheld and only the refuted one
      // linked, leaving {refuted:1, upheld:0} here. Do not disconfirm on a count we cannot vouch
      // for as complete — demote instead of drop.
      if (panelIncomplete) {
        out.push({
          ...f,
          tier: 'suspected',
          why: `${f.why || ''} (demoted, not dropped: the dead run's transcript is only partially recoverable — ${linked}/${seen} verify verdict(s) in this journal linked to a finding — so a ${t.refuted} refuted / ${t.upheld} upheld count here cannot be trusted as the finding's full panel)`.trim(),
        })
      }
      continue
    }
    if (t.refuted > 0 || t.upheld > 0) {
      out.push({
        ...f,
        tier: 'suspected',
        why: `${f.why || ''} (the dead run's own verification recovered ${t.upheld} upheld / ${t.refuted} refuted vote(s) from its transcript, not a majority against it; not re-verified here, so it is carried as suspected rather than confirmed)`.trim(),
      })
      continue
    }
    out.push(f)
  }
  return dedupJournalFindings(out)
}

export function recordFromJournal(dir, { name = 'review', kind = 'workflow' } = {}) {
  const journal = readJsonl(path.join(dir, 'journal.jsonl'))
  const started = journal.filter(e => e.type === 'started').length
  const results = journal.filter(e => e.type === 'result')
  const byKind = {}
  const findings = findingsFromJournal(dir)
  const votes = { refuted: 0, upheld: 0 }
  for (const e of results) {
    const k = classifyResult(e.result)
    byKind[k] = (byKind[k] || 0) + 1
    if (k === 'verify') votes[e.result.refuted ? 'refuted' : 'upheld'] += 1
    if (k === 'verify-batch') for (const v of e.result.verdicts) if (v) votes[v.refuted ? 'refuted' : 'upheld'] += 1
  }
  const scout = results.map(e => e.result).find(r => classifyResult(r) === 'scout') ?? null
  const base = results.map(e => e.result).find(r => classifyResult(r) === 'base') ?? null
  const bySource = {}
  for (const f of findings) bySource[f.source || 'unknown'] = (bySource[f.source || 'unknown'] || 0) + 1
  const linkStats = journalVerifyLinkStats(dir)
  return {
    schemaVersion: 1, runtime: 'claude-code', kind, name, nested: false, via: null,
    partial: true,
    partialReason: 'reconstructed from the workflow transcript — per-agent evidence only; the engine\'s own dedup/tier aggregation is not recoverable',
    // Candidate findings, NOT confirmed ones: these are what the lenses filed, before dedup and
    // verification. Calling them the run's findings would overstate every rate computed from them.
    // Already deduped across lenses (dedupJournalFindings, inside findingsFromJournal) — see there
    // for why `fingerprint` is the identity reused rather than a third one.
    findings: summarizeFindings(findings),
    verifySeen: linkStats.seen, verifyLinked: linkStats.linked,
    verdict: `${reviewVerdict(findings)} (candidates)`,
    head: base?.head ?? null,
    branch: base?.branch ?? null,
    // Size and lenses only: rigor (maxRounds/verifyVotes) is derived in review.js from the size
    // bucket plus the security floor, and lives on the PLAN — which is script state, not an agent
    // result, so a transcript cannot show it. Reading it off the scout result left both keys
    // undefined and silently dropped them from the record; naming them here would be worse still,
    // since a value re-derived without the security floor would be wrong as often as not.
    scout: scout ? [{ size: scout.sizeBucket, lenses: scout.lenses }] : [],
    agentsStarted: started,
    agentsReturned: results.length,
    agentsLost: started - results.length,
    resultKinds: byKind,
    candidatesBySource: bySource,
    verificationVotes: votes,
    runtimeStats: runtimeStats(dir),
    notRun: started > results.length ? [`${started - results.length} agent(s) never returned a result`] : [],
  }
}

// ---- backfill-engine (one-off, operator-run) -------------------------------------------------
// Records written before `engineRevision` existed carry no engine identity, and analyze-runs
// therefore refuses to fold them in with attributed ones. That is the honest default, but it is not
// always the whole truth: when EVERY undated-engine record predates the behavioural change, they are
// all the OLD engine and can be classified without guessing. The soundness condition is exactly
// that — a single cut point, with no record on the far side of it — and it is the operator's to
// assert, which is why this is a command they run with an explicit `--before` and `--apply`, never
// something a build step does on its own.
//
// `--before` is the commit time of the change that defines the boundary (the merge that shipped it),
// and the rule is strict: only records with `ts < before` are stamped. Anything at or after the cut
// is left unattributed, because a record written in that window could be either engine. A record
// that already carries a revision is never rewritten.
export function normalizeStampBoundary(v) {
  const s = String(v || '').trim()
  // Accept both the record's own filename-stamp form (2026-09-01T20-08-31Z) and ordinary ISO
  // (2026-09-01T20:08:31Z / with millis), and compare in the record's form — it is lexically
  // ordered, which is what makes a string comparison chronological here.
  const iso = s.replace(/\.\d+Z$/, 'Z')
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})[:-](\d{2})[:-](\d{2})Z$/)
  return m ? `${m[1]}T${m[2]}-${m[3]}-${m[4]}Z` : null
}

export function backfillEngineRevision({ store = DEFAULT_STORE, revision, before, apply = false } = {}) {
  if (!Number.isInteger(revision)) throw new Error('--revision <integer> is required')
  const cut = normalizeStampBoundary(before)
  if (!cut) throw new Error('--before <ISO timestamp> is required (e.g. 2026-09-01T20:08:31Z)')
  const files = fs.readdirSync(store).filter(f => f.endsWith('.json'))
  const out = { cut, revision, apply, stamped: [], alreadyAttributed: 0, afterCut: [], unreadable: [] }
  for (const f of files.sort()) {
    const file = path.join(store, f)
    let rec
    try {
      rec = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      out.unreadable.push({ file: f, reason: String((e && e.message) || e).slice(0, 80) })
      continue
    }
    if (Number.isInteger(rec.engineRevision)) { out.alreadyAttributed++; continue }
    const ts = String(rec.ts || '')
    // No ts is not "before the cut" — it is unplaceable, and stamping it would invent the very
    // attribution this whole change exists to stop inventing.
    if (!ts || ts >= cut) { out.afterCut.push(f); continue }
    out.stamped.push(f)
    if (apply) fs.writeFileSync(file, JSON.stringify({ ...rec, engineRevision: revision }, null, 2))
  }
  return out
}

// ---- repair-index (one-off, operator-run) ----------------------------------------------------
// index.jsonl is written by THIS script and by nothing else — `writeRecord`/`recoverPartials` both
// append `JSON.stringify(indexProjection(record)) + '\n'`, one compact line, by construction. So a
// MULTI-LINE block inside it was not written here at all: it is the hand-written fallback both
// logging prompts in review.js forbid in words — a model appending the row itself after the script
// failed, pretty-printing it on the way.
//
// The general argument this case belongs to — that a prohibition living in prompt prose is a wish,
// not a defence, and that only a structure making the act impossible or a mechanism making its trace
// visible actually defends — lives in the realm (@nick/craft, node #33), with the second dated
// instance beside this one. The structural follow-up it names (leaving no path in the workflow where
// a model writes this file at all) is a change to the review engine, not to this command.
//
// The prohibition does not hold, and this store is the dated proof. Both prompt prohibitions landed
// on 2026-08-04; the block recovered here is stamped 2026-08-27 — twenty-three days later, written
// by hand with the prohibition already in front of the model. (The other block, 2026-07-19,
// predates it and proves nothing.) So the reason review.js is left alone here is NOT "the prompt
// already covers it": that reason is falsified. It is left alone because more words cannot fix what
// words did not achieve — the remedy is structural (no path in the workflow where a model writes
// index.jsonl at all; a failed logging step must fail loudly rather than invite a fallback), and
// that is a change to the review engine with its own blast radius and its own review. This branch
// repairs the damage; it does not pretend to have stopped the cause.
//
// Measured on the real store on 2026-09-02: 268 lines, 29 unparsable, in exactly two blocks, and
// each block is a pretty-printed INDEX PROJECTION (the 13-key legacy projection shape), not a full
// record — `JSON.stringify(…, null, 2)` where one compact line belonged.
//
// Two block classes, and only one of them is recoverable:
//   • the block joins into one JSON object — the same entry, only re-indented. Compacting it costs
//     nothing and invents nothing: JSON.stringify preserves key insertion order, so the row comes
//     out exactly as the writer would have produced it.
//   • the block does NOT join — truncated or otherwise damaged. Completing it would mean inventing
//     fields, and an invented telemetry row is the one outcome worse than a missing one: this whole
//     store exists because a plausible-looking record cannot be told apart from a real one. Those
//     bytes are moved out verbatim to a stamped sidecar, so nothing is destroyed, the operator can
//     decide, and the index stops reporting the same lines as unparsable on every future read.
//
// A recovered block is not put back blindly: it must not already be in the index. The real store
// holds the case — lines 40-53 are a field-for-field duplicate of the healthy compact line 54, and
// they are unparsable ONLY because the closing brace is missing. Had the writer closed it, joining
// would have succeeded and the repair would have silently double-counted one adversarial-review run
// in every `jq -s` aggregate: the quieter corruption this command exists to avoid, reached by the
// command itself. So a recovered row is keyed on ts+kind+name+project and QUARANTINED, not
// re-inserted, when that key is already present.
//   Why that key and not byte identity: the hand-written block is a re-typed projection, so it can
// differ from the real row in key order, in whitespace inside strings, or in fields the writer left
// out — every one of which defeats byte equality on exactly the case that matters. ts+kind+name+
// project is what identifies a RUN: craft-log-run stamps ts to the second, and a second run of the
// same workflow over the same project within the same second is not a thing that happens (a review
// takes minutes). Rows carrying no ts and no name fall back to byte identity of the compacted line.
//   Why quarantine rather than merely report: a reported duplicate stays in the file, and every
// aggregate keeps counting it until someone acts on a sentence in a terminal. Quarantine loses
// nothing — the bytes go verbatim to the sidecar — and it is the same treatment the non-joining
// class gets, for the same reason: both are blocks that must not enter the index unexamined.
//
// Every already-parsing line is copied through untouched, the original is backed up before any
// write, the new file is written to a temp path and renamed over the original (so a crash mid-write
// leaves the index intact rather than truncated), and the result is verified line for line against
// the lines that parsed before. Dry by default, like backfill-engine — it rewrites the operator's
// own telemetry, so the destructive form is asked for in words.
//
// NOT locked: it is read-modify-write on index.jsonl with no lock, so a review finalizing in the
// same instant can lose its line. Acceptable for a one-off operator command run by hand; do not run
// it while a review is in flight.
function parsesAsLine(l) {
  try {
    JSON.parse(l)
    return true
  } catch {
    return false
  }
}

// A run of non-parsing lines is recoverable exactly when it joins into ONE plain JSON object. An
// array or a scalar is not an index row, and accepting one would put a shape downstream `jq -s` and
// selectPriorRounds have never had to survive.
export function compactPrettyBlock(blockLines) {
  try {
    const o = JSON.parse(blockLines.join('\n'))
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null
    return JSON.stringify(o)
  } catch {
    return null
  }
}

// The identity of a RUN, as the index carries it. Not byte identity: see the note above.
export function indexKey(entry, fallback = '') {
  const ts = entry && typeof entry.ts === 'string' ? entry.ts : ''
  const name = entry && typeof entry.name === 'string' ? entry.name : ''
  if (!ts && !name) return `raw\u0000${fallback}`
  const kind = entry && typeof entry.kind === 'string' ? entry.kind : ''
  // Trailing slashes are stripped because what this key guards against is a RE-TYPED projection: a
  // hand-reproduced row carries `/p/` where the writer wrote `/p`, and an unnormalised key then
  // reads two spellings of one project as two projects and lets the duplicate back in — the very
  // failure the guard exists to stop, arriving through a difference too small to notice. A mistyped
  // `ts` or `name` defeats any key at all; the identity is only as strong as the fields are
  // faithful, and this closes the cheapest gap, not every gap.
  const project = (entry && typeof entry.project === 'string' ? entry.project : '').replace(/\/+$/, '')
  return `id\u0000${ts}\u0000${kind}\u0000${name}\u0000${project}`
}

// What a block IS, not only where it was — read out of the raw bytes so it works on a block that
// does not parse. The sidecar header carries this: an operator who repairs a quarantined block by
// hand (closing the brace) must be able to see it is a duplicate before pasting it back.
export function blockFields(blockLines) {
  const text = blockLines.join('\n')
  const out = {}
  for (const k of ['ts', 'kind', 'name', 'project', 'commit', 'verdict']) {
    const m = text.match(new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`))
    if (m && m[1]) out[k] = m[1]
  }
  return out
}

export function describeBlock(blockLines) {
  const f = blockFields(blockLines)
  const parts = Object.keys(f).map(k => `${k}=${f[k]}`)
  return parts.length ? parts.join(' ') : '(no recognisable fields)'
}

export function repairIndex({ store = DEFAULT_STORE, apply = false, now = new Date() } = {}) {
  const file = path.join(store, 'index.jsonl')
  if (!fs.existsSync(file)) throw new Error(`no index.jsonl in ${store}`)
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()   // the trailing newline, not a line

  const out = []          // the rebuilt file
  const kept = []         // every line that ALREADY parsed, verbatim and in order — the invariant
  const recovered = []
  const quarantined = []
  // Every run already in the index, keyed. Built over the WHOLE file first, because the healthy
  // twin can sit after the damaged block (in the real store it does: block 40-53, twin on line 54).
  const seen = new Set()
  for (const l of lines) {
    if (!l.trim() || !parsesAsLine(l)) continue
    seen.add(indexKey(JSON.parse(l), l))
  }
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (!l.trim() || parsesAsLine(l)) {
      out.push(l)
      if (l.trim()) kept.push(l)
      i++
      continue
    }
    let j = i
    while (j < lines.length && lines[j].trim() && !parsesAsLine(lines[j])) j++
    const block = lines.slice(i, j)
    const compact = compactPrettyBlock(block)
    if (compact === null) {
      // A block that does not join is still checked against the index, on the fields readable in its
      // raw bytes. The real store's block 40-53 is exactly this: unrecoverable AND a duplicate. The
      // operator who "repairs" it by adding the missing brace must be told before they paste it back.
      const f = blockFields(block)
      const dup = (f.ts || f.name) && seen.has(indexKey(f))
      quarantined.push({
        from: i + 1, to: j, lines: block, what: describeBlock(block),
        reason: dup
          ? 'does not join into one JSON object — and its run is ALREADY in the index; do not complete it by hand'
          : 'does not join into one JSON object',
      })
    } else {
      const key = indexKey(JSON.parse(compact), compact)
      if (seen.has(key)) {
        // It joins — and it is a run the index already carries. Recovering it would double-count.
        quarantined.push({ from: i + 1, to: j, lines: block, reason: 'duplicates a run already in the index', what: describeBlock(block) })
      } else {
        seen.add(key)
        out.push(compact)
        recovered.push({ from: i + 1, to: j, line: compact })
      }
    }
    i = j
  }

  // The one thing this command must never do. Checked BEFORE writing, and again after.
  const survivors = out.filter(l => l.trim() && parsesAsLine(l))
  if (survivors.length !== kept.length + recovered.length) {
    throw new Error(`refusing to write: ${kept.length} good + ${recovered.length} recovered ≠ ${survivors.length} in the result`)
  }
  let k = 0
  for (const l of out) if (k < kept.length && l === kept[k]) k++
  if (k !== kept.length) throw new Error(`refusing to write: ${kept.length - k} previously-parsing line(s) would not survive unchanged`)

  const report = {
    file, apply, linesBefore: lines.length, parsedBefore: kept.length,
    recovered, quarantined, parsedAfter: survivors.length, backup: null, quarantineFile: null,
  }
  if (!apply || (!recovered.length && !quarantined.length)) return report   // nothing to do → nothing written

  const at = stamp(now)
  report.backup = path.join(store, `index.jsonl.bak-${at}`)
  fs.copyFileSync(file, report.backup)
  if (quarantined.length) {
    report.quarantineFile = path.join(store, `index.quarantine-${at}.jsonl`)
    fs.writeFileSync(report.quarantineFile, quarantined
      .map(q => [
        `# index.jsonl lines ${q.from}-${q.to} — ${q.reason}; moved out by repair-index at ${at}`,
        `# block: ${q.what}`,
        q.lines.join('\n'),
      ].join('\n'))
      .join('\n') + '\n')
  }
  // Temp file + rename: the index is replaced atomically, so a crash mid-write cannot leave the
  // operator with a truncated index and no idea where the backup went. The shared helper also removes
  // the temp if the rename throws, so a failed repair leaves no `.tmp` stranded beside the index.
  writeFileAtomically(file, out.length ? out.join('\n') + '\n' : '')
  const back = readJsonlCounted(file)
  if (back.entries.length !== survivors.length || back.malformed !== 0) {
    throw new Error(`readback mismatch: expected ${survivors.length} parsing line(s) and 0 malformed, got ${back.entries.length}/${back.malformed} — the original is at ${report.backup}`)
  }
  return report
}

// ---- enrich-cost (POST-HOC, run by the launcher) ---------------------------------------------
// The REAL cost of a run, summed after it finishes and folded into its record. A workflow's live
// sandbox can only ever record `outputTokens` = `budget.spent()` — the harness POOL — and that pool
// describes under 1% of real spend. The other ~99% is cache_read/cache_write, and it is written ONLY
// into the per-agent transcripts (`<run-dir>/agent-*.jsonl`) the runtime lays down outside the
// sandbox's reach, so no engine running inside the sandbox can ever record it. So this is a separate,
// post-hoc command the LAUNCHER runs — the launcher is the party that holds the runId, hence the run
// directory. It never runs as part of a review.
//
// `sumTranscriptUsage` is the pure, testable core: it takes a transcript's raw bytes (or an array of
// already-parsed lines) and sums the four token classes over the `type === 'assistant'` records'
// `.message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
// `cache_creation_input_tokens`). That record shape and those field names are an EXTERNAL SURFACE
// owned by the Claude Code runtime, not by craft — pinned in the realm (realm @nick/craft, node #98)
// with the runtime version they were observed against; read that node before assuming the shape.
// Tolerant by construction — a `.jsonl` transcript is a stream a run may have been killed mid-line,
// and non-assistant records (user turns, tool results) carry no usage — so a blank, malformed or
// usage-less line is skipped, never allowed to abort the sum.
export function sumTranscriptUsage(input) {
  const lines = Array.isArray(input) ? input : String(input ?? '').split('\n')
  const total = { output: 0, input: 0, cacheRead: 0, cacheWrite: 0 }
  for (const line of lines) {
    let rec = line
    if (typeof line === 'string') {
      if (!line.trim()) continue
      try { rec = JSON.parse(line) } catch { continue }
    }
    if (!rec || typeof rec !== 'object' || rec.type !== 'assistant') continue
    const u = rec.message && rec.message.usage
    if (!u || typeof u !== 'object') continue
    total.output += Number(u.output_tokens) || 0
    total.input += Number(u.input_tokens) || 0
    total.cacheRead += Number(u.cache_read_input_tokens) || 0
    total.cacheWrite += Number(u.cache_creation_input_tokens) || 0
  }
  return total
}

// Atomic replace, shared by every temp+rename write path in this file: write a temp file in the SAME
// directory as the target (a rename is only atomic within one filesystem), then rename it over the
// target, so a crash mid-write cannot leave a truncated file. LEAVE NOTHING BEHIND: if either the
// write or the rename throws (a full disk, an unwritable directory, a target that is a directory), the
// temp is removed before the error propagates, so a failed write leaves the directory exactly as it
// found it — the atomic "all or nothing" this path exists for, extended to its own failure case.
// `force` suppresses ENOENT so a temp that never got created does not double-throw and mask the real
// error. Both `writeCostRecordAtomically` and `repairIndex` route through here (before, repairIndex's
// inline temp+rename leaked its `.tmp` when the rename threw, and the cost writer duplicated this).
export function writeFileAtomically(file, content) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}-${Date.now()}.tmp`)
  try {
    fs.writeFileSync(tmp, content)
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

// Atomic replace of a cost-enriched record — a thin wrapper over `writeFileAtomically`. Its callers
// are unchanged; the temp+rename and the leave-nothing-behind cleanup now live in the shared helper.
export function writeCostRecordAtomically(recordFile, record) {
  writeFileAtomically(recordFile, JSON.stringify(record, null, 2))
}

// Sum every `agent-*.jsonl` under `runDir`, merge a `cost` object into the record at `recordFile`,
// and write it back atomically (temp file in the same dir + rename), preserving every other field.
// IDEMPOTENT: `cost` is REPLACED on every run, never appended, so re-running after more transcripts
// land simply re-sums. `total` is the four token sums; `agents` is the count of transcripts ACTUALLY
// summed (not the raw glob count), and `skipped` is present only when some matching entry could not
// be read. Per-transcript tolerance — the cross-transcript twin of the line-level tolerance
// `sumTranscriptUsage` already applies: one unreadable entry (a subdirectory whose name matches the
// glob → EISDIR, or a transcript deleted/permission-flipped between readdir and read → ENOENT/EACCES)
// is skipped with a stderr warning rather than discarding every good transcript's cost. Throws with a
// clear message when the run directory is missing, holds no matching transcripts, none of them could
// be read at all, or the record is missing/unparseable — the CLI turns any throw into a non-zero exit.
// A readable-but-zero sum (agents summed, total 0) is not refused — a trivial run is theoretically
// possible — but it IS warned loudly on stderr, since the far likelier cause is the usage schema
// drifting out from under `sumTranscriptUsage` (realm @nick/craft, node #98).
export function enrichCost({ runDir, recordFile } = {}) {
  let names
  try {
    names = fs.readdirSync(runDir)
  } catch (e) {
    throw new Error(`run directory not readable: ${runDir} (${String((e && e.message) || e)})`)
  }
  const transcripts = names.filter(n => /^agent-.*\.jsonl$/.test(n)).sort()
  if (!transcripts.length) throw new Error(`no agent-*.jsonl transcripts under ${runDir}`)
  const cost = { output: 0, input: 0, cacheRead: 0, cacheWrite: 0, total: 0, agents: 0 }
  let skipped = 0
  for (const name of transcripts) {
    let u
    try {
      u = sumTranscriptUsage(fs.readFileSync(path.join(runDir, name), 'utf8'))
    } catch (e) {
      // One unreadable entry must not discard every good transcript's cost. Skip it, warn, keep summing.
      skipped++
      console.error(`craft-log-run WARNING: skipped unreadable transcript ${name}: ${String((e && e.message) || e)}`)
      continue
    }
    cost.output += u.output
    cost.input += u.input
    cost.cacheRead += u.cacheRead
    cost.cacheWrite += u.cacheWrite
    cost.agents++
  }
  // Every matching transcript unreadable is the no-data case — a cost of all zeros here would read as a
  // real measurement of a free run, so throw instead, the same stance as no matching transcripts at all.
  if (!cost.agents) throw new Error(`no readable agent-*.jsonl transcripts under ${runDir} (${skipped} matched but unreadable)`)
  cost.total = cost.output + cost.input + cost.cacheRead + cost.cacheWrite
  if (skipped) cost.skipped = skipped   // legible on the record itself, not only on stderr
  // Readability (the `!cost.agents` throw above) is not the same guard as zero-sum: transcripts can
  // parse fine yet carry no usage — an empty/truncated transcript, or the runtime renaming a usage
  // field (external surface, realm @nick/craft, node #98). A real run is never free, so an all-zeros
  // cost with agents summed is almost certainly a measurement failure. WARN loudly but still file it
  // (a trivial run is theoretically possible): recorded-and-flagged beats refused, and `tallyCost`
  // would otherwise average this in as a genuine near-free run — silently wrong.
  if (cost.agents > 0 && cost.total === 0) {
    console.error(`craft-log-run WARNING: ${cost.agents} transcript(s) summed to zero tokens — a real run is never free; likely the transcript usage schema drifted (realm @nick/craft, node #98)`)
  }
  let record
  try {
    record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
  } catch (e) {
    throw new Error(`record not readable at ${recordFile}: ${String((e && e.message) || e)}`)
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`record at ${recordFile} is not a JSON object`)
  }
  record.cost = cost   // replace, never append: a re-run must re-sum, not accumulate onto a stale cost
  writeCostRecordAtomically(recordFile, record)
  return { cost, recordFile }
}

// ---- store README ----------------------------------------------------------------------------
function ensureReadme(store) {
  const file = path.join(store, 'README.md')
  if (fs.existsSync(file)) return
  fs.writeFileSync(file, `# craft run records

- \`index.jsonl\` — one compact JSON line per run; load with \`jq -s\`.
- \`<ts>-<kind>-<name>.json\` — full per-run detail.
- \`.partial/<run>/\` — phase checkpoints of a run still in flight. \`node lib/craft-log-run.mjs recover\`
  promotes any that never finalized into \`partial: true\` records.

Common fields: schemaVersion, engineRevision, ts, kind (workflow|agent), name, project, commit, dirty, verdict,
findings{total,bySeverity}, nested, via. Workflows add scout/dimensions/verification/notRun/outputTokens;
agents add toolsRun. A record with \`partial: true\` did NOT finish — never average it in with complete runs.

An optional \`cost{output,input,cacheRead,cacheWrite,total,agents}\` (with a \`skipped\` count added
only when a transcript could not be read) is folded in AFTER the run by
\`node lib/craft-log-run.mjs enrich-cost --run-dir <d> --record <f>\` — the REAL per-agent spend summed
from the run's agent-*.jsonl transcripts (cacheRead is ~99% of it). \`outputTokens\` above is only the
harness pool, under 1% of real cost. Absent until a run is enriched.

    jq -s 'group_by(.name)[]|{name:.[0].name,runs:length}' index.jsonl
    jq 'select(.verdict|test("Block"))' index.jsonl
`)
}

// ---- prior round (READ path) -----------------------------------------------------------------
// The mirror image of `write`: the re-review round used to be located by handing a model a prose
// recipe (read the index, pick the newest match, check ancestry, rebuild the path, read the JSON).
// That is a chain of DECISIONS, and it silently returned "no prior round" whenever any link failed.
// It is all done here, deterministically; the model only carries the bytes.
export const PRIOR_ROUND_NONE = { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, journalSourced: false, sameEngineRevision: false, reason: '' }

// Every "no prior round" carries WHY. The defect this command exists to remove is a silent
// chain-break, so the read path must never collapse "no store yet", "this branch has never been
// reviewed", "the head was rebased away" and "the record file is gone" into one indistinguishable
// {found:false} — the workflow logs this string so a broken chain is visible in the transcript.
function noPriorRound(reason) {
  return { ...PRIOR_ROUND_NONE, reason }
}

// The exact shape the workflow's strict LEDGER_ITEM schema accepts, with each key's natural empty.
// Normalizing here is the point: an older persisted ledger entry missing one required key would
// invalidate the whole structured output downstream and null out the round we just located. The
// script owns the shape; the model only transports it.
const LEDGER_ITEM_SHAPE = {
  fp: '', file: '', line: 0, symbol: '', severity: '', tier: '',
  disposition: '', source: '', ruleId: '', title: '', why: '',
}

function normalizeLedgerItem(item) {
  const src = (item && typeof item === 'object') ? item : {}
  const out = {}
  for (const [k, empty] of Object.entries(LEDGER_ITEM_SHAPE)) {
    const v = src[k]
    if (typeof empty === 'number') {
      const n = Number(v)
      out[k] = Number.isFinite(n) ? Math.trunc(n) : 0
    } else {
      out[k] = typeof v === 'string' ? v : (v == null ? '' : String(v))
    }
  }
  // `sources` is optional in the schema but carries the strict-mode escalation — keep it when it is
  // present and well-formed, drop it otherwise rather than emitting a value the schema rejects.
  if (Array.isArray(src.sources)) out.sources = src.sources.filter(x => typeof x === 'string')
  // `whyRef` is the pointer to the record that holds the FULL `why` for a transport-shortened item.
  // Preserve it verbatim (never synthesize or truncate it here — that is the transport step's job in
  // `findPriorRound`): a stored carried item already carries the BIRTH reference, and normalizing must
  // propagate that reference forward unchanged rather than dropping it as an unknown key.
  // NB `whyRef.record` is polymorphic: a finalized record FILENAME for a complete/proven item, or the
  // surviving partial-DIRECTORY basename for an evidence-recovery item (no finalized record exists there).
  // No consumer resolves it today; a future resolver must try both the record store and the partial store.
  if (src.whyRef && typeof src.whyRef === 'object' &&
      typeof src.whyRef.record === 'string' && typeof src.whyRef.fp === 'string') {
    out.whyRef = { record: src.whyRef.record, fp: src.whyRef.fp }
  }
  return out                                          // unknown keys are dropped by construction
}

export function normalizeLedger(ledger) {
  return (Array.isArray(ledger) ? ledger : []).map(normalizeLedgerItem)
}

// The prior-round TRANSPORT cap for a ledger item's `why`. The whole ledger crosses an agent as
// structured output on its way into the next round; a full rationale is the bulk of that payload, and
// the model never sees more than the cap anyway (prompts pass `why` through sanitizeAttack, which caps
// at the same 500). The cap governs FRESH items only: a finding born this round has its `why` truncated
// to <=cap here and gains a `whyRef` back to the record it was born in, from which the FULL one stays
// recoverable. A CARRIED item — one that already has a `whyRef` — is deliberately NOT re-truncated
// (`shortenTransportWhy` short-circuits it), so it does not steady at <=cap: it steadies at its short
// base (<=cap) plus at most the LATEST adjudication marker and attack (the attack itself <=ATTACK_MAX,
// also 500), roughly 1KB for paths that re-append a fresh marker. The carried-UNVERIFIED path is the
// exception: its ` (STILL NOT VERIFIED: carried from round N…)` suffix is not one baseWhy strips, so it
// accretes ~90 chars per unverified round rather than steadying (pre-existing, not from this change).
// Re-slicing a carried `why` to the cap would sever the
// ` — <marker>: ` suffix that baseWhy/sanitizeAttack parse to strip a stale attack before re-appending,
// and a cut marker accretes round over round instead of being replaced — so the transport carries a
// SHORT base with the FULL rationale recoverable via `whyRef`, not a `why` re-capped every round.
export const WHY_TRANSPORT_MAX = 500

// Shorten each item's `why` for TRANSPORT, at the read/emission boundary in `findPriorRound` — NEVER
// inside `normalizeLedgerItem`, which the write path (journal reconstruction) also runs and which must
// keep stored records whole. `record` is the identifier of the record this ledger is being read from,
// which for a full-`why` item IS that finding's birth record.
//   - a full `why` (>cap) with no `whyRef`: truncate and point `whyRef` at THIS record (its birth).
//   - an item that ALREADY carries a `whyRef`: leave `why` and `whyRef` untouched — it is a carried,
//     already-short item, and its `whyRef` is the ORIGINAL birth reference to propagate forward.
//   - a short `why` (<=cap) with no `whyRef`: leave as-is; nothing was dropped, so no pointer is owed.
// Per-item `why` length changes only; the entry COUNT is untouched, so the transport-integrity guard
// (`ledgerTruncated`, which compares `ledgerCount` to the array length) does not fire.
function shortenTransportWhy(ledger, record) {
  return ledger.map(item => {
    if (item.whyRef) return item
    if (typeof item.why === 'string' && item.why.length > WHY_TRANSPORT_MAX) {
      return { ...item, why: item.why.slice(0, WHY_TRANSPORT_MAX), whyRef: { record, fp: item.fp } }
    }
    return item
  })
}

// `workdir` is the working copy whose HISTORY decides ancestry, kept separate from `project`, which
// keys the ROWS. They are the same path for a plain checkout and deliberately different for a linked
// worktree: `project` is the collapsed `repoKey` (so a worktree and its main checkout share one
// round chain) while `git merge-base --is-ancestor <row head> HEAD` has to be asked of the copy
// actually being reviewed. Asked of the collapsed key, the `HEAD` in that command is the MAIN
// checkout's — so a worktree's own row was rejected as `ancestry-rejected` (measured), while a row
// from the main checkout's branch, being an ancestor of the worktree's commits, was accepted.
// The loop state that SURVIVED. A run files its final record once, at the end, through a model —
// the path that lost two consecutive runs (a network error; a 196KB payload) and left 57
// unfinalized directories in the live store. It writes its phase checkpoints as it goes, small and
// straight to disk — the path that survived in every one of those cases. So the chain is read from
// the checkpoints too: a lost record may cost the round's ledger, it must not cost the knowledge
// that the round happened (lib/loop-state.mjs states the rule and the trade-off).
//
// Read-only and chain-scoped, deliberately unlike `recoverPartials`: that one sweeps every
// directory in the store, promotes it to a record and DELETES it. A read of the chain must not
// mutate the store it is reading, and must not touch another repository's leftovers.
//
// Identity is PROOF, on the same terms as the rejoin: `project` must be present on both sides and
// equal, so a legacy directory that predates the identity fields (13 of the 57 in the live store)
// is skipped rather than guessed at. `branch` must not disagree. Only `workflow`/`review`
// directories are candidates — the chain is the review chain, the same population
// `selectPriorRounds` filters to.
// `session` is the CALLER'S OWN `$CLAUDE_CODE_SESSION_ID`, and passing it excludes the caller's own
// directory from its own evidence. That is not the concurrent-sibling trade-off below — it is nearer
// and more likely: the engine supports rejoining a directory, so a RESUMED run re-reads the chain
// while its own unfinalized directory is already in the store under the same project and branch. It
// would then count itself as a dead predecessor, take a round number one too high and (before the
// rule in reconcileChain) a head of its own. The session id is the one field that tells the two
// apart, and it is already on every checkpoint — `dirIdentity` merely declines to compare it, for
// OWNERSHIP purposes (see its note: a resumed run legitimately writes several). Here every id a
// directory attests to is checked, so a resumed run recognises itself under any of them.
export function partialChainEvidence({ store = DEFAULT_STORE, project = '', branch = '', session = '' } = {}) {
  const root = path.join(store, PARTIAL_DIR)
  if (!project || !fs.existsSync(root)) return []
  const out = []
  let names
  try {
    names = fs.readdirSync(root)
  } catch {
    return []
  }
  for (const name of names) {
    const m = name.match(/^(.*?Z)-(\w+)-(.*)$/)
    if (!m || m[2] !== 'workflow' || m[3] !== 'review') continue
    const dir = path.join(root, name)
    try {
      if (!fs.statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    if (fs.existsSync(path.join(dir, FINALIZED_MARKER))) continue
    const phases = readCheckpoints(dir)
    if (!phases.length) continue
    const id = dirIdentity(phases)
    if (session && dirSessionIds(phases).includes(session)) continue   // this run's own directory
    if (!id.project || id.project !== project) continue
    if (id.branch === null) continue                      // the directory disagrees with itself
    if (branch && id.branch && id.branch !== branch) continue
    if (branch && !id.branch) continue                    // cannot attest to this branch: not evidence for it
    // The LEDGER the dead run sharded into its checkpoints (lib/ledger-shards.mjs). This is what
    // turns a surviving directory from "a round happened" into the round's actual memory. Normalized
    // here, at the read boundary, for the same reason a complete round's ledger is: the array crosses
    // an agent as structured output into the workflow's strict schema, and one entry missing one key
    // invalidates the whole load. And transport-shortened here too, the SAME step the complete and
    // proven paths take in findPriorRound below: this ledger reaches the next round through
    // reconcileChain's evidence branch, which returns it verbatim, so shortened anywhere but here it
    // would be the ONE transport path that crosses the agent full-length with no `whyRef` — and a
    // later normal-path read would then re-truncate an already-markered `why` (cutting the adjudicator
    // marker) and mint a `whyRef` at the wrong record. The record identifier is the surviving
    // directory's own on-disk `name`: this path has no finalized record (that is what "evidence"
    // means), so the directory the shards live in IS where the full `why` is recoverable from.
    // `ledgerTotal` is the count the dead run DECLARED, kept separate from the array so a shortfall
    // stays visible — see the note in reconcileChain; shortening changes `why` lengths only, never the
    // entry COUNT, so `ledgerTotal` and the array length still relate exactly as they did.
    const shards = assembleLedgerShards(phases)
    out.push({
      dir,
      at: dirStamp(name),
      head: typeof id.head === 'string' ? id.head : '',
      // The dead run's own count of what it had found. It is what makes the loss legible downstream:
      // a non-zero count beside an empty ledger is the shape review.js reads as a degraded round.
      findingsTotal: Number(phases.find(p => p.findings)?.findings?.total ?? 0) || 0,
      ledger: shortenTransportWhy(normalizeLedger(shards.ledger), name),
      ledgerTotal: shards.total,
      ledgerComplete: shards.complete,
    })
  }
  return out.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
}

export function findPriorRound({ store = DEFAULT_STORE, project = process.cwd(), branch = '', workdir = '', session = '' } = {}) {
  if (!branch) return noPriorRound('no-branch')
  const indexFile = path.join(store, 'index.jsonl')
  const cwd = path.resolve(project)
  // Every git question below is asked of the reviewed WORKING COPY; `cwd` above only keys rows.
  const repoCwd = workdir ? path.resolve(workdir) : cwd
  const gitOk = git(['rev-parse', '--git-dir'], repoCwd, { probe: true }).ok
  // Ancestry is the one filter that applies to BOTH populations — index rows and surviving
  // checkpoint directories. A head that is no longer on this history (rebase, force-push) belongs to
  // a chain that genuinely ended; an empty head cannot be checked and is carried as unverifiable
  // rather than dropped, because the caller falls back to the base ref for it.
  const onThisHistory = head =>
    !head || (gitOk && git(['merge-base', '--is-ancestor', String(head), 'HEAD'], repoCwd, { probe: true }).ok)
  // What survived when a record did not. Gathered before the index is read so a store with no index
  // at all (or none this branch appears in) still reaches it.
  // `e.head` must be NON-EMPTY here, unlike an index row's. `onThisHistory` passes an empty head as
  // "unverifiable, carried" because the row's consumer falls back to the base ref for it. Evidence
  // has no such fallback: a directory's head is empty exactly when its checkpoints DISAGREE about it
  // (`dirIdentity` poisons a contested field to null) — and the answer then pins the NEXT round's
  // number to whatever head is left, which is a completed earlier round's. A round number one higher
  // than reality, tied to a commit that is not where the dead run stood, is worse than not counting
  // the directory: the complete round or the proven row still answers, and still answers loudly.
  const evidence = fs.existsSync(store)
    ? partialChainEvidence({ store, project: cwd, branch, session }).find(e => e.head && onThisHistory(e.head)) || null
    : null
  // `complete`/`proven`/`evidence` are reconciled by one rule, stated in lib/loop-state.mjs: a chain
  // break is never rendered as a first round.
  const answer = (complete, completeAt, proven, reason) => {
    const out = reconcileChain({ complete, completeAt, proven, evidence })
    return out || noPriorRound(reason)
  }
  if (!fs.existsSync(store)) return noPriorRound('no-store')
  if (!fs.existsSync(indexFile)) return answer(null, NaN, null, 'no-index')
  const { entries, malformed } = readJsonlCounted(indexFile)
  // Every "no prior round" answer below is qualified by the lines we could not read: without this,
  // a chain broken by a corrupt index reads exactly like a branch that was never reviewed.
  const none = reason => (malformed ? `${reason} (index.jsonl: ${malformed} unparsable line(s) skipped)` : reason)
  // Rows exist under both the resolved absolute path and whatever string the caller passed. NOT under
  // `.`: legacy rows written with project="." are not attributable to any repository, and matching
  // them can hand this branch a round from an unrelated repo — worse than missing the round.
  // The invariant is enforced HERE, not at the CLI: a relative candidate (`.` above all) is dropped
  // and only its resolved absolute form is searched, so a direct library call cannot reach the rows
  // the comment above forbids.
  const candidates = [...new Set([project, cwd])].filter(p => path.isAbsolute(p))
  const rows = candidates
    .flatMap(p => selectPriorRounds(entries, { project: p, branch }))
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
  if (!rows.length) {
    // Distinguish "never reviewed on this branch" from "reviewed, but every row is keyed to a
    // string that names no repository" — the latter is the population this branch deliberately
    // stops matching, and the FIRST re-review of every pre-existing branch lands here.
    const unattributable = entries.some(e =>
      e && e.kind === 'workflow' && e.name === 'review' && e.branch === branch &&
      typeof e.project === 'string' && !path.isAbsolute(e.project))
    return answer(null, NaN, null, none(unattributable ? 'unattributable-rows-only' : 'no-candidate-rows'))
  }
  // A repo we cannot interrogate is not the same as a rejected candidate: without git, ancestry is
  // unknowable and EVERY row below would be dropped for the wrong reason.
  if (!gitOk) return noPriorRound(none('git-unavailable'))
  // Newest FIRST, and a rejection continues the search: a candidate whose head is no longer on this
  // history (rebase/force-push) or whose detail record is unreadable must not blank a valid older
  // round — that is the silent chain-break this command exists to remove.
  let rejected = ''
  // The FIRST rejection that PROVES a round happened anyway — a record that is corrupt, truncated or
  // gone, as against a history that genuinely does not carry the round. It is the fallback the
  // reconciliation uses when no older round can be materialized, so the break is reported as a
  // degraded round instead of a blank first pass.
  let proven = null
  for (const cand of rows) {
    if (!cand.head) { rejected ||= 'row-without-head'; continue }
    if (!onThisHistory(cand.head)) { rejected ||= 'ancestry-rejected'; continue }
    // `recordId` is this candidate record's on-disk identifier — it names both the file read here and,
    // for any full-`why` item shortened for transport below, the record its FULL `why` is recoverable
    // from (its birth record).
    const recordId = recordFilename({ ts: cand.ts, kind: cand.kind, name: cand.name })
    const file = path.join(store, recordId)
    let rec
    try {
      rec = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      rejected ||= 'detail-unreadable'
      // `reason` rides along because the two rejections that still PROVE a round differ in the one
      // way the engine must act on: whose head this is. Here the detail is unreadable but the row
      // belongs to a round that FINISHED, so its head is a completed head and an incremental delta
      // off it is legitimate. Dropping the reason here is where the distinction used to be lost
      // (realm @nick/craft, node #76).
      // `sameEngineRevision:false` — the index row carries no engine revision (indexProjection omits
      // it), so a round proved by an unreadable detail cannot establish comparability; set false (not
      // omit) so the recidivism guard skips rather than compares across an unknown basis.
      proven ||= provesRound('detail-unreadable') ? { reason: 'detail-unreadable', round: cand.round, head: cand.head, findingsTotal: cand.findingsTotal, sameEngineRevision: false } : null
      continue
    }
    // A `partial: true` record is a run that DIED — for VERDICT purposes it stays rejected here,
    // same as ever: the store's own README says never to average one in, and this function never
    // reports a partial record's `verdict` as the round's conclusion. But its `ledger`, when one was
    // reconstructed from the run's own journal.jsonl (`ledgerSource === 'journal'`, written only by
    // `recoverPartials`), is real per-finding evidence the harness already paid for — reusing it does
    // not make any record claim something false; it only lets a stalled round's candidate findings
    // seed the next round instead of being silently discarded. A partial record with no such ledger
    // (the ordinary checkpoint-only recovery, which only ever holds `{total, bySeverity}` counts) is
    // still rejected for its LEDGER — but it still proves the round happened, so it is kept as
    // `proven` rather than discarded outright.
    const journalLedger = rec.partial && rec.ledgerSource === 'journal' && Array.isArray(rec.ledger) && rec.ledger.length
    if (rec.partial && !journalLedger) {
      rejected ||= 'partial-only'
      // A partial record is a run that STOPPED, so its head is a stopped head — see the reason field
      // above. And its ledger shards are still here: `recoverPartials` copies every checkpoint into
      // `phases` unfiltered (the shard filter sits only on the finalize path), then deletes the
      // directory once the round is non-zero. So the shards a run wrote survive INSIDE the record
      // while the chain reader, which only ever looked at live directories, could not see them —
      // the repair tool made the carried ledger unreadable. Read them from the record instead.
      const shardsInRecord = assembleLedgerShards(rec.phases)
      proven ||= provesRound('partial-only')
        ? {
          reason: 'partial-only',
          round: Number(rec.round || cand.round || 0) || 0,
          head: cand.head,
          findingsTotal: Number(rec.findings?.total ?? cand.findingsTotal ?? 0) || 0,
          // Normalized at the read boundary, like every other ledger read in this file. The array
          // crosses an agent as structured output into the workflow's strict schema, and one entry
          // missing one key invalidates the whole load — `toLedgerEntry` writes `severity` without
          // a fallback, so a finding that lacks it yields an entry with the key absent entirely.
          ledger: shortenTransportWhy(normalizeLedger(shardsInRecord.ledger), recordId),
          ledgerTotal: shardsInRecord.total,
          // Computed here, the one recovery branch that still holds the record: the tombstones in this
          // recovered ledger were fingerprinted under the DEAD run's revision, so they are comparable to
          // this round's only when that revision matches ours. Without it a stall-then-upgrade-then-recover
          // sequence — the exact 2->3 boundary the guard targets — would compare across bases silently.
          // A record with no revision (legacy/pre-field) is not comparable, same as the complete branch.
          sameEngineRevision: Number.isInteger(rec.engineRevision) && rec.engineRevision === ENGINE_REVISION,
        }
        : null
      continue
    }
    const ledger = shortenTransportWhy(normalizeLedger(rec.ledger), recordId)
    const complete = {
      found: true,
      round: Number(rec.round || cand.round || 0) || 0,
      // The head we RETURN is the head whose ancestry we just verified. Preferring `rec.head` here
      // would hand `git diff <head>...HEAD` a value nothing checked — they agree today only because
      // one write produces both.
      head: String(cand.head),
      ledger,
      // Authoritative count, computed here. The ledger crosses an agent boundary as structured
      // output on its way to the workflow; without a count printed alongside it, a truncated array
      // is indistinguishable from a genuinely short round. The workflow asserts the two agree.
      ledgerCount: ledger.length,
      priorFindings: Number(rec.findings?.total ?? cand.findingsTotal ?? 0) || 0,
      // True exactly when THIS round's ledger came from `journalLedger` above (a stalled run
      // reconstructed from journal.jsonl), never from a normal completed round. The distinction
      // matters to the caller for a reason unrelated to trustworthiness (that is `ledgerSource`'s
      // job, already spent above): a journal-sourced round's `head` is the commit the DEAD run was
      // reviewing when it stalled. The operator's natural next move is to re-run on that exact same
      // commit before making any fix — so `head` can equal the caller's current HEAD, and a lens
      // diff of `head...HEAD` would then be empty rather than incremental. review.js uses this flag
      // to force a full base...HEAD re-scan on a journal-sourced round, same as it already does for
      // a degraded one, but keeps the two reasons distinct in its own logging (see `shouldFullRescan`).
      journalSourced: Boolean(journalLedger),
      // Whether this prior round was produced under the SAME engine revision that will stamp the round
      // being computed now. The finding fingerprint (`fp`) basis is revision-scoped — a bump changes
      // what a recorded `fp` means (see ENGINE_REVISION) — so a stored `fp` may be compared to a freshly
      // computed one ONLY when the revisions match. Computed here, the one place that holds both the
      // prior record's revision and this engine's, because the workflow cannot import ENGINE_REVISION.
      // A record with no revision (legacy, pre-field) is not comparable: it used the old fp basis.
      sameEngineRevision: Number.isInteger(rec.engineRevision) && rec.engineRevision === ENGINE_REVISION,
      reason: '',
    }
    return answer(complete, stampMs(cand.ts), proven, none(rejected || 'no-candidate-rows'))
  }
  return answer(null, NaN, proven, none(rejected || 'no-candidate-rows'))
}

// ---- CLI -------------------------------------------------------------------------------------
function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const store = flag(argv, 'store') || DEFAULT_STORE
  // `project` keys the record to the repo that was REVIEWED. It defaults to cwd because that is
  // right for a live run, but from-journal is typically run from somewhere else entirely — and a
  // record filed against the wrong project silently splits that project's history in two.
  // Resolved to the REPOSITORY ROOT, not merely to an absolute path: a row keyed "." is not
  // attributable to any repository (and the read path deliberately refuses to match those), and a
  // row keyed to a subdirectory of the repo is invisible to a run launched from the root. Both the
  // write path (checkpoint/finalize) and the read path (prior-round) go through this one line, so
  // records written before and after keep matching.
  const project = repoKey(flag(argv, 'project') || process.cwd())
  // The WORKING COPY the caller pointed at, kept separate from `project` on purpose. `repoKey`
  // deliberately collapses a linked worktree onto its main checkout so both share one round chain
  // (see its header), which is exactly the wrong path to read a branch from: `git -C <main>
  // rev-parse --abbrev-ref HEAD` answers with the MAIN checkout's branch. Measured on a real
  // worktree pair (main on `main`, linked copy on `feat/x`): `gitIdentity(repoKey(<wt>))` →
  // `{branch: 'main'}`, `gitIdentity(<wt>)` → `{branch: 'feat/x'}`.
  const workdir = flag(argv, 'project') || process.cwd()
  // Shell-expanded by the caller from `$CLAUDE_CODE_SESSION_ID` (see lib/run-logging.mjs) — never
  // composed by a model. An absent flag degrades to `''`, which every consumer below already treats
  // as "no session id known" rather than a real, empty one.
  const session = flag(argv, 'session') || ''
  // Read ONCE, off the reviewed repository the command has already been pointed at, and used by
  // every command below that describes THIS run. The historical commands (`recover`, `from-journal`)
  // deliberately do not use it: they reconstruct a run that happened earlier, whose branch and head
  // are whatever its own checkpoints or transcript recorded, not whatever the checkout is on now.
  // Read off `workdir`, NOT off `project`: the collapsed key names the main checkout, whose branch
  // and head are not this run's whenever the review happens in a linked worktree. Since git now
  // WINS over the caller's `--branch` on both the write path and `prior-round`, reading the wrong
  // path does not merely lose a field — it overwrites a correct `--branch feat/x` with `main` and
  // then asks `findPriorRound` under `main`, where `merge-base --is-ancestor` passes (feat/x
  // descends from main) and a foreign branch's ledger is adopted as this run's prior round.
  const gitId = gitIdentity(workdir)
  const parseStdin = () => {
    const raw = readStdin()
    if (!raw.trim()) throw new Error('no record on stdin')
    return JSON.parse(raw) // a malformed payload must fail LOUD, not land as a plausible file
  }
  try {
    if (cmd === 'write') {
      const { file } = writeRecord(parseStdin(), { store, project, session, gitId, workdir })
      console.log(`wrote ${file}`)
    } else if (cmd === 'checkpoint') {
      // Stamped with the SAME code-computed identity as `write` and `finalize`, and stamped BEFORE
      // the payload is used, because both uses depend on it: `checkpointDir` names the directory and
      // `writeCheckpoint` is what `identityAgrees` later reads the proof out of. This command was the
      // one write path that left `branch`/`head` as the model reported them — and the `detect` prompt
      // that fills them tells the model they are a fallback and an empty string is a fine answer, so
      // the proof was routinely reduced to `{project, '', ''}`, i.e. to "the same repository".
      const payload = applyGitIdentity(parseStdin(), gitId)
      // The same model-authored value `finalizeRun` refuses. Unguarded it was `mkdir -p`'d and written
      // to anywhere the user can write, and then refused at finalize — so the slices were lost too.
      // Refuse the path, not the checkpoint: mint a real one and say so.
      const asked = flag(argv, 'dir')
      const refused = asked && !insideStore(asked, store) ? asked : ''
      if (refused) console.error(`craft-log-run WARNING: --dir ${safePath(refused)} is not inside ${path.join(store, PARTIAL_DIR)} — a fresh run directory was used instead`)
      const dir = (refused ? '' : asked) || checkpointDir(payload, { store, project, rejoin: argv.includes('--rejoin') })
      const file = writeCheckpoint(dir, flag(argv, 'phase') || payload.phase, payload, { project, session })
      // stdout is the channel back to the workflow: it holds the dir for the next checkpoint.
      console.log(JSON.stringify({ runDir: dir, file }))
    } else if (cmd === 'finalize') {
      const raw = parseStdin()
      const res = finalizeRun(raw, { store, project, dir: flag(argv, 'dir') || '', rejoin: argv.includes('--rejoin'), session, gitId, workdir })
      console.log(`wrote ${res.file}${res.folded ? ` (folded ${res.folded} checkpoint(s))` : ''}`)
      // Loud, because it is the case where telemetry stayed split: the directory we found does not
      // belong to this run, so it was neither folded nor deleted.
      if (res.kept) console.error(`craft-log-run WARNING: ${safePath(res.dir)} does not match this run's identity — left for \`recover\``)
      // Same register, same reason: the record IS filed, the directory is not touched. It must not
      // read as a failed write, or the engine reports a lost record that is on disk.
      if (res.unreadable) console.error(`craft-log-run WARNING: the run directory could not be read (${safePath(res.unreadable)}) — record written, checkpoints not folded`)
      if (res.refusedDir) console.error(`craft-log-run WARNING: --dir ${safePath(res.refusedDir)} is not inside ${path.join(store, PARTIAL_DIR)} — record written, directory neither folded nor removed`)
    } else if (cmd === 'recover') {
      const out = recoverPartials({ store, project })
      console.log(out.length ? out.map(o => `recovered ${o.file} (${o.phases} phase(s))`).join('\n') : 'no unfinalized runs to recover')
    } else if (cmd === 'from-journal') {
      const dir = argv[1]
      if (!dir) throw new Error('usage: from-journal <transcriptDir>')
      const rec = recordFromJournal(dir, { name: flag(argv, 'name') || 'review' })
      const { file } = writeRecord(rec, { store, project })
      console.log(`wrote ${file} (${rec.agentsStarted} agent(s), ${rec.agentsLost} lost, ${rec.findings.total} candidate finding(s))`)
    } else if (cmd === 'prior-round') {
      // Losing the prior round must DEGRADE the review, never abort it: any failure below is a
      // clean "no prior round" on stdout with exit 0, never the FAILED line the other commands use.
      let out = PRIOR_ROUND_NONE
      try {
        // Git FIRST, the flag as the fallback — the same inversion as the write path, and for the
        // same reason: `--branch` is interpolated from a model's answer in review.js, so an agent
        // that died or left the field empty used to send `--branch ''` and get `no-branch` back,
        // with no attempt made. The command has already been `cd`'d into the reviewed repository and
        // is given `--project "$PWD"`, so the branch is simply readable here. On a detached HEAD
        // `gitIdentity` yields '' and the flag is used, which is the only case a caller could still
        // know a branch name this script cannot.
        // `session` so this run cannot read its OWN unfinalized directory as a dead predecessor
        // (see partialChainEvidence). Absent, it degrades to '' — no exclusion, the old behaviour.
        out = findPriorRound({ store, project, workdir, session, branch: gitId.branch || flag(argv, 'branch') || '' })
      } catch {
        out = PRIOR_ROUND_NONE
      }
      // findPriorRound already qualifies every "no prior round" answer with the lines it could not
      // read — but on the FOUND path that count is invisible, and a corrupt index then passes
      // silently through the one command that reads it every run. It goes to stderr on purpose:
      // stdout is a single JSON line against a strict `additionalProperties:false` schema, so it
      // cannot carry another key. Fires only when the index is actually damaged.
      try {
        const { malformed } = readJsonlCounted(path.join(store, 'index.jsonl'))
        if (malformed) console.error(`craft-log-run WARNING: index.jsonl holds ${malformed} unparsable line(s) — run \`node lib/craft-log-run.mjs repair-index\` to see what is recoverable`)
      } catch { /* never let the warning break the read path */ }
      console.log(JSON.stringify(out))
    } else if (cmd === 'backfill-engine') {
      // Dry by default: it rewrites the user's own telemetry, so the destructive form must be asked
      // for in words. `--apply` is the word.
      const res = backfillEngineRevision({
        store, revision: Number(flag(argv, 'revision')), before: flag(argv, 'before'),
        apply: argv.includes('--apply'),
      })
      console.log(`${res.apply ? 'stamped' : 'would stamp'} engineRevision=${res.revision} on ${res.stamped.length} record(s) with ts < ${res.cut}`)
      console.log(`left alone: ${res.alreadyAttributed} already attributed, ${res.afterCut.length} at/after the cut (engine unknowable), ${res.unreadable.length} unreadable`)
      for (const f of res.stamped) console.log(`- ${f}`)
      if (!res.apply) console.log('\n(dry run — re-run with --apply to write)')
    } else if (cmd === 'repair-index') {
      // Same discipline as backfill-engine: it rewrites the operator's own telemetry, so dry by
      // default and `--apply` is the word that makes it write.
      const res = repairIndex({ store, apply: argv.includes('--apply') })
      // A no-op --apply wrote nothing; saying "repaired" would claim a write that never happened —
      // the same defect as a check that reads as more than it is.
      const nothingToDo = !res.recovered.length && !res.quarantined.length
      console.log(nothingToDo ? `already clean: ${res.file}` : `${res.apply ? 'repaired' : 'would repair'} ${res.file}`)
      console.log(`${res.linesBefore} line(s) read: ${res.parsedBefore} already parse, ${res.recovered.length} pretty-printed block(s) recoverable, ${res.quarantined.length} block(s) quarantined`)
      for (const r of res.recovered) console.log(`- recover lines ${r.from}-${r.to} → one line: ${r.line.length > 160 ? `${r.line.slice(0, 160)}…` : r.line}`)
      for (const q of res.quarantined) console.log(`- quarantine lines ${q.from}-${q.to} (${q.lines.length} line(s); ${q.reason} — NOT reinserted) [${q.what}]`)
      console.log(`verified: all ${res.parsedBefore} already-parsing line(s) survive unchanged; result holds ${res.parsedAfter} parsing line(s)`)
      if (res.backup) console.log(`backup: ${res.backup}`)
      if (res.quarantineFile) console.log(`quarantined bytes: ${res.quarantineFile}`)
      if (!res.apply && !nothingToDo) console.log('\n(dry run — re-run with --apply to write)')
    } else if (cmd === 'enrich-cost') {
      const runDir = flag(argv, 'run-dir')
      const recordFile = flag(argv, 'record')
      if (!runDir || !recordFile) throw new Error('usage: enrich-cost --run-dir <path> --record <path>')
      const { cost } = enrichCost({ runDir, recordFile })
      console.log(`enriched ${recordFile} — ${cost.agents} agent(s)${cost.skipped ? ` (${cost.skipped} unreadable, skipped)` : ''}: cacheRead ${cost.cacheRead}, cacheWrite ${cost.cacheWrite}, input ${cost.input}, output ${cost.output}, total ${cost.total} tok (real cost; outputTokens is the harness pool, ~<1%)`)
    } else {
      console.error(`usage: craft-log-run.mjs <command> [flags]

  write                                   one complete record from stdin
  checkpoint --phase <p> [--dir <d>] [--rejoin]
                                          one phase slice from stdin; prints {"runDir":…}
                                          --rejoin: re-enter this run's own partial directory when
                                          the first checkpoint failed (identity-checked; refuses
                                          when two directories match)
  finalize [--dir <d>] [--rejoin]         complete record from stdin; folds in this run's checkpoints
  recover                                 promote unfinalized checkpoint dirs into partial records
  from-journal <transcriptDir> [--name n] rebuild a record from a workflow transcript
  prior-round --branch <b>                newest prior review round for that branch
  backfill-engine --revision <n> --before <ts> [--apply]
  repair-index [--apply]
  enrich-cost --run-dir <d> --record <f>  fold the run's REAL cost (cache_read/write, summed from
                                          <run-dir>/agent-*.jsonl) into the record; run by the launcher

  common: --store <dir> --project <dir>`)
      process.exit(2)
    }
  } catch (e) {
    console.error(`craft-log-run FAILED: ${String((e && e.message) || e)}`)
    process.exit(1)
  }
}
