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
//   checkpoint --phase <p> [--dir <d>]    one phase slice; prints {"runDir":…} to reuse next time
//   finalize --dir <d>                    complete record; folds in that run's checkpoints
//   recover                               unfinalized checkpoint dirs → partial records (no stdin)
//   from-journal <transcriptDir>          rebuild a record from a workflow transcript (no stdin)
//   prior-round --branch <b> [--project <p>]  newest prior review round for that branch (no stdin)
//   repair-index [--apply]                index.jsonl: compact hand-written pretty-printed blocks,
//                                         quarantine damaged and duplicate ones; dry by default
//
// Run: node lib/craft-log-run.mjs <command> [flags]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ENGINE_REVISION, indexProjection, summarizeFindings, reviewVerdict, selectPriorRounds } from './run-record.mjs'

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
// broke it. `--show-toplevel` collapses all of those onto one key. Not a git repo (or no git at
// all) → the resolved path, which is still better than a relative one.
export function repoKey(p = process.cwd()) {
  const abs = path.resolve(p)
  const top = git(['rev-parse', '--show-toplevel'], abs)
  return top ? path.resolve(top) : abs
}

// `engineRevision` is stamped HERE — the one choke point every write path passes through — rather
// than in each workflow script, so no engine can file a record that forgets to say which engine it
// was. It describes the checkout that is WRITING, which is exactly right for `write`/`finalize`/
// `recover` (the run and the writer are the same craft). `from-journal` is the one place it is a
// best guess — a transcript can be replayed by a later craft — and those records are `partial:true`,
// which analyze-runs excludes from every rate anyway.
export function computedFields(project = process.cwd(), now = new Date()) {
  return {
    engineRevision: ENGINE_REVISION,
    ts: stamp(now),
    project,
    commit: git(['rev-parse', '--short', 'HEAD'], project),
    dirty: git(['status', '--porcelain'], project).length > 0,
    craftCommit: git(['rev-parse', '--short', 'HEAD'], craftRoot()) || null,
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

export function writeRecord(raw, { store = DEFAULT_STORE, project = process.cwd(), now = new Date() } = {}) {
  fs.mkdirSync(store, { recursive: true })
  // Computed fields win over anything the caller guessed: they are the ones this script exists to own.
  const record = { ...raw, ...computedFields(project, now) }
  const file = path.join(store, recordFilename(record))
  fs.writeFileSync(file, JSON.stringify(record, null, 2))
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
export function checkpointDir(record, { store = DEFAULT_STORE, now = new Date(), project = process.cwd() } = {}) {
  const stub = { ...record, ...computedFields(project, now) }
  const dir = path.join(store, PARTIAL_DIR, recordFilename(stub).replace(/\.json$/, ''))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function writeCheckpoint(dir, phase, payload) {
  fs.mkdirSync(dir, { recursive: true })
  const seq = fs.readdirSync(dir).filter(f => /^\d\d-/.test(f)).length
  const safe = String(phase ?? 'phase').replace(/[^A-Za-z0-9._-]/g, '-')
  const file = path.join(dir, `${String(seq).padStart(2, '0')}-${safe}.json`)
  fs.writeFileSync(file, JSON.stringify({ phase, at: new Date().toISOString(), ...payload }, null, 2))
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

// ---- recover ---------------------------------------------------------------------------------
// A checkpoint dir that never got finalized IS the dead run. Promoting it costs nothing and turns
// "three hours, no telemetry" into a record that says exactly how far the run got.
export function recoverPartials({ store = DEFAULT_STORE, project = process.cwd(), now = new Date() } = {}) {
  const root = path.join(store, PARTIAL_DIR)
  if (!fs.existsSync(root)) return []
  const out = []
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name)
    if (!fs.statSync(dir).isDirectory()) continue
    if (fs.existsSync(path.join(store, `${name}.json`))) continue // finalized; nothing to recover
    const phases = readCheckpoints(dir)
    if (!phases.length) continue
    // ts/kind/name are already encoded in the dir name — reuse them so the recovered record keeps
    // the identity its checkpoints were written under instead of getting a fresh "now".
    const m = name.match(/^(.*?Z)-(\w+)-(.*)$/)
    const head = phases.find(p => p.head)?.head ?? null
    const findings = phases.find(p => p.findings)?.findings ?? null
    const base = {
      schemaVersion: 1, runtime: 'claude-code', kind: m ? m[2] : 'workflow', name: m ? m[3] : name,
      nested: false, via: null, partial: true,
      partialReason: 'run ended before it could write a final record — reconstructed from phase checkpoints',
      phases,
      verdict: phases.find(p => p.verdict)?.verdict ?? 'INCOMPLETE',
      findings: findings ?? { total: 0, bySeverity: { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 } },
      head, branch: phases.find(p => p.branch)?.branch ?? null,
      notRun: ['run did not finish — every phase after the last checkpoint is missing'],
    }
    const record = { ...base, ...computedFields(project, now), ts: m ? m[1] : stamp(now) }
    fs.mkdirSync(store, { recursive: true })
    const file = path.join(store, recordFilename(record))
    fs.writeFileSync(file, JSON.stringify(record, null, 2))
    fs.appendFileSync(path.join(store, 'index.jsonl'), JSON.stringify(indexProjection(record)) + '\n')
    fs.rmSync(dir, { recursive: true, force: true })
    out.push({ file, phases: phases.length })
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

export function recordFromJournal(dir, { name = 'review', kind = 'workflow' } = {}) {
  const journal = readJsonl(path.join(dir, 'journal.jsonl'))
  const started = journal.filter(e => e.type === 'started').length
  const results = journal.filter(e => e.type === 'result')
  const byKind = {}
  const findings = []
  const votes = { refuted: 0, upheld: 0 }
  for (const e of results) {
    const k = classifyResult(e.result)
    byKind[k] = (byKind[k] || 0) + 1
    if (k === 'lens') findings.push(...e.result.findings.filter(Boolean))
    // Gate seeds are tool-grounded findings, not gate metadata — omitting them would under-report
    // exactly the candidates that outrank a lens's judgement downstream.
    if (k === 'gate') findings.push(...e.result.seedFindings.filter(Boolean).map(f => ({ ...f, source: f.source || 'gate' })))
    if (k === 'verify') votes[e.result.refuted ? 'refuted' : 'upheld'] += 1
    if (k === 'verify-batch') for (const v of e.result.verdicts) if (v) votes[v.refuted ? 'refuted' : 'upheld'] += 1
  }
  const scout = results.map(e => e.result).find(r => classifyResult(r) === 'scout') ?? null
  const base = results.map(e => e.result).find(r => classifyResult(r) === 'base') ?? null
  const bySource = {}
  for (const f of findings) bySource[f.source || 'unknown'] = (bySource[f.source || 'unknown'] || 0) + 1
  return {
    schemaVersion: 1, runtime: 'claude-code', kind, name, nested: false, via: null,
    partial: true,
    partialReason: 'reconstructed from the workflow transcript — per-agent evidence only; the engine\'s own dedup/tier aggregation is not recoverable',
    // Candidate findings, NOT confirmed ones: these are what the lenses filed, before dedup and
    // verification. Calling them the run's findings would overstate every rate computed from them.
    findings: summarizeFindings(findings),
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
  const project = entry && typeof entry.project === 'string' ? entry.project : ''
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
  // operator with a truncated index and no idea where the backup went.
  const tmp = `${file}.repair-${at}.tmp`
  fs.writeFileSync(tmp, out.length ? out.join('\n') + '\n' : '')
  fs.renameSync(tmp, file)
  const back = readJsonlCounted(file)
  if (back.entries.length !== survivors.length || back.malformed !== 0) {
    throw new Error(`readback mismatch: expected ${survivors.length} parsing line(s) and 0 malformed, got ${back.entries.length}/${back.malformed} — the original is at ${report.backup}`)
  }
  return report
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

    jq -s 'group_by(.name)[]|{name:.[0].name,runs:length}' index.jsonl
    jq 'select(.verdict|test("Block"))' index.jsonl
`)
}

// ---- prior round (READ path) -----------------------------------------------------------------
// The mirror image of `write`: the re-review round used to be located by handing a model a prose
// recipe (read the index, pick the newest match, check ancestry, rebuild the path, read the JSON).
// That is a chain of DECISIONS, and it silently returned "no prior round" whenever any link failed.
// It is all done here, deterministically; the model only carries the bytes.
export const PRIOR_ROUND_NONE = { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: '' }

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
  return out                                          // unknown keys are dropped by construction
}

function normalizeLedger(ledger) {
  return (Array.isArray(ledger) ? ledger : []).map(normalizeLedgerItem)
}

export function findPriorRound({ store = DEFAULT_STORE, project = process.cwd(), branch = '' } = {}) {
  if (!branch) return noPriorRound('no-branch')
  const indexFile = path.join(store, 'index.jsonl')
  if (!fs.existsSync(store)) return noPriorRound('no-store')
  if (!fs.existsSync(indexFile)) return noPriorRound('no-index')
  const { entries, malformed } = readJsonlCounted(indexFile)
  // Every "no prior round" answer below is qualified by the lines we could not read: without this,
  // a chain broken by a corrupt index reads exactly like a branch that was never reviewed.
  const none = reason => noPriorRound(malformed ? `${reason} (index.jsonl: ${malformed} unparsable line(s) skipped)` : reason)
  // Rows exist under both the resolved absolute path and whatever string the caller passed. NOT under
  // `.`: legacy rows written with project="." are not attributable to any repository, and matching
  // them can hand this branch a round from an unrelated repo — worse than missing the round.
  const cwd = path.resolve(project)
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
    return none(unattributable ? 'unattributable-rows-only' : 'no-candidate-rows')
  }
  // A repo we cannot interrogate is not the same as a rejected candidate: without git, ancestry is
  // unknowable and EVERY row below would be dropped for the wrong reason.
  if (!git(['rev-parse', '--git-dir'], cwd, { probe: true }).ok) return none('git-unavailable')
  // Newest FIRST, and a rejection continues the search: a candidate whose head is no longer on this
  // history (rebase/force-push) or whose detail record is unreadable must not blank a valid older
  // round — that is the silent chain-break this command exists to remove.
  let rejected = ''
  for (const cand of rows) {
    if (!cand.head) { rejected ||= 'row-without-head'; continue }
    const mb = git(['merge-base', '--is-ancestor', String(cand.head), 'HEAD'], cwd, { probe: true })
    if (!mb.ok) { rejected ||= 'ancestry-rejected'; continue }
    const file = path.join(store, recordFilename({ ts: cand.ts, kind: cand.kind, name: cand.name }))
    let rec
    try {
      rec = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      rejected ||= 'detail-unreadable'
      continue
    }
    // A `partial: true` record is a run that DIED — its ledger is whatever the last checkpoint
    // happened to hold, not the round's conclusion. The store's own README says never to average
    // one in; carrying one as the prior round would silently truncate the ledger chain. Keep
    // walking: an older complete round is a far better base than a half-written newer one.
    if (rec.partial) { rejected ||= 'partial-only'; continue }
    const ledger = normalizeLedger(rec.ledger)
    return {
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
      reason: '',
    }
  }
  return none(rejected || 'no-candidate-rows')
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
  const parseStdin = () => {
    const raw = readStdin()
    if (!raw.trim()) throw new Error('no record on stdin')
    return JSON.parse(raw) // a malformed payload must fail LOUD, not land as a plausible file
  }
  try {
    if (cmd === 'write') {
      const { file } = writeRecord(parseStdin(), { store, project })
      console.log(`wrote ${file}`)
    } else if (cmd === 'checkpoint') {
      const payload = parseStdin()
      const dir = flag(argv, 'dir') || checkpointDir(payload, { store, project })
      const file = writeCheckpoint(dir, flag(argv, 'phase') || payload.phase, payload)
      // stdout is the channel back to the workflow: it holds the dir for the next checkpoint.
      console.log(JSON.stringify({ runDir: dir, file }))
    } else if (cmd === 'finalize') {
      const dir = flag(argv, 'dir')
      const raw = parseStdin()
      const phases = dir ? readCheckpoints(dir) : []
      const { file } = writeRecord(phases.length && !raw.phases ? { ...raw, phases } : raw, { store, project })
      if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
      console.log(`wrote ${file}${phases.length ? ` (folded ${phases.length} checkpoint(s))` : ''}`)
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
        out = findPriorRound({ store, project, branch: flag(argv, 'branch') || '' })
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
    } else {
      console.error('usage: craft-log-run.mjs write|checkpoint|finalize|recover|from-journal|prior-round|backfill-engine|repair-index')
      process.exit(2)
    }
  } catch (e) {
    console.error(`craft-log-run FAILED: ${String((e && e.message) || e)}`)
    process.exit(1)
  }
}
