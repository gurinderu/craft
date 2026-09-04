// Observability run-record helpers for the opencode adapter. Plain JS (no opencode imports) so it
// is node --test-able. The opencode plugin is NOT sandboxed: this module reads the clock and writes
// files directly, so there is no logger agent (unlike the Claude Code workflows). opencode records
// are a deterministic subset of the shared schema: no findings.bySeverity, no outputTokens.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The verdict vocabulary is CLOSED, and every dimension prompt in rust-audit.ts and every agent
// file in opencode/agents/ mandates a terminal `VERDICT: <TOKEN>` line drawn from it. Parsing that
// line — instead of scanning an agent's whole prose report for keywords — is what makes the signal
// structural: a quoted instruction is never the LAST such line, and an emphasised adjective
// ("coverage is **INCOMPLETE**") is never a `VERDICT:` line at all. The free-text scan below is
// only a fallback for output carrying no structured line, and it reads the TAIL, not the whole
// report: the mandated verdict sits at the end, and scanning everything is precisely what let a
// quoted instruction forty lines up decide the verdict.
const VERDICT_TOKEN = {
  APPROVE: 'Approve',
  WARNING: 'Warning',
  BLOCK: 'Block',
  INCOMPLETE: 'INCOMPLETE (not run)',
}

// `VERDICT: TOKEN` starting a line, tolerating markdown decoration (bold, code, blockquote, bullet,
// table pipe) around the label and the token. CASE-SENSITIVE on purpose: the mandate says uppercase
// and no other wording, and only that shape is authoritative. A prose closing line in ordinary case
// — `Verdict: Approve` — is exactly what LABELLED below was written to weigh against the evidence,
// so matching it here would let it outrank a report of UB instead of losing to it.
const VERDICT_LINE = /^[ \t>|*_`#-]*VERDICT:[ \t]*[*_`]*[ \t]*(APPROVE|WARNING|BLOCK|INCOMPLETE)\b/gm

// The SAME shape, asked as a yes/no by the dispatcher to decide whether a dimension answered at all.
// Exported rather than re-spelled: written twice, the two drifted immediately and in the direction
// that loses severity — a bolded `**VERDICT: BLOCK**` is what a model ordinarily writes, and a
// stricter copy judged it "unanswered", so a real Block was re-run and then recorded as INCOMPLETE,
// which `worstOf` ranks BELOW Block. That is the defect this discriminator exists to prevent,
// inverted. A fresh regex per call because /g carries lastIndex between uses.
export function hasVerdictLine(text) {
  return new RegExp(VERDICT_LINE.source, 'm').test(String(text ?? ''))
}

// Same argument for the triage outcome line.
// Case-INSENSITIVE on the token, and the difference from VERDICT is not an oversight. `parseVerdict`
// is case-sensitive because a lowercase `Verdict: Approve` is deliberately weighed differently by a
// second reader; there is no second reader here, so the same strictness would only punish a
// validation that answered correctly and capitalised — re-running it and then filing it not-run,
// which is the inversion this predicate exists to prevent.
const OUTCOME_LINE = /^[ \t>|*_`#-]*OUTCOME:[ \t]*[*_`]*[ \t]*(accept|reject|defer|needs-decision|conflict)\b/mi

export function hasOutcomeLine(text) {
  return OUTCOME_LINE.test(String(text ?? ''))
}

// How much of the report the fallback scan is allowed to see.
const TAIL_LINES = 20

// A labelled verdict statement — `Verdict: Approve`, `Overall rating: INCOMPLETE`. Used only to
// decide between Approve and INCOMPLETE; Block/Warning evidence outranks it.
const LABELLED = /\b(?:overall[ \t]+)?(?:verdict|rating|outcome)[ \t]*:[ \t]*[*_`]*[ \t]*(Approve|Clean|Healthy|INCOMPLETE)\b/gi

// The words a "nothing ran" reason opens with. A closed set that no longer has to grow, because a
// conforming agent never reaches this arm.
const REASON =
  '(?:[Nn](?:ot|o|one|othing|ever)|[Rr]un|[Dd]ue|[Bb]ecause|[Ss]ince|[Cc](?:annot|ould|an)' +
  '|[Uu]n(?:able|available)|[Mm]issing|[Aa]bsent|[Ss]kip(?:ped)?)'

// INCOMPLETE used as a verdict rather than as an adjective. The discriminator is position plus what
// follows: it must START a line (an adjective in prose — "coverage here is INCOMPLETE" — does not),
// and then either nothing word-like follows, or a reason-word does, or a short label does and is
// closed by `:` / `(` / a dash ("INCOMPLETE result: cargo-deny is not installed"). An adjective is
// followed by the bare noun it qualifies with no such punctuation ("INCOMPLETE coverage of the
// feature powerset"), which matches none of the three.
const INCOMPLETE_LINE = new RegExp(
  '^[ \\t>|*_`#-]*INCOMPLETE\\b(?:' +
    '[ \\t]*\\(?[ \\t]*' + REASON + '\\b' +
    '|[ \\t]+[A-Za-z][\\w-]*(?:[ \\t]+[A-Za-z][\\w-]*)?[ \\t]*[:(—–-]' +
    '|(?![ \\t]+[A-Za-z])' +
  ')',
  'm',
)
// A whole table cell holding the token, e.g. `| deps | INCOMPLETE |`.
const INCOMPLETE_CELL = /\|[ \t]*\**[ \t]*INCOMPLETE[ \t]*\**[ \t]*\|/

function lastMatch(re, t) {
  re.lastIndex = 0
  let m, last = null
  while ((m = re.exec(t)) !== null) last = m[1]
  return last
}

export function parseVerdict(text) {
  const t = String(text || '')

  // 1. Structural: the last `VERDICT: <TOKEN>` line wins, and is authoritative when present.
  const structured = lastMatch(VERDICT_LINE, t)
  if (structured) return VERDICT_TOKEN[structured]

  // 2. Fallback for non-conforming output, over the tail only.
  const tail = t.split('\n').slice(-TAIL_LINES).join('\n')
  // Word boundaries (and the verdict emoji) so prose like "no blocking issues" / "unblocked"
  // doesn't collide with the Block keyword. Worst signal still wins (Block before Warning), and
  // both outrank a labelled statement: an agent claiming Approve while reporting UB is not taken
  // at its word.
  if (/⛔|\b(?:Block|At-risk|UB-found)\b/i.test(tail)) return 'Block'
  if (/⚠️|\b(?:Warning|Concerns)\b/i.test(tail)) return 'Warning'
  // A labelled statement decides between the remaining two. This is what stops a report that merely
  // MENTIONS incompleteness — quoting its own instructions, or tabling one dimension as INCOMPLETE
  // — from overriding the verdict the agent actually stated.
  const labelled = lastMatch(LABELLED, tail)
  if (labelled) return /incomplete/i.test(labelled) ? 'INCOMPLETE (not run)' : 'Approve'
  // A dimension whose tooling was absent checked nothing. That must not land in the Approve bucket:
  // an Approve is a claim about what was NOT found, and it only holds over what was looked at.
  if (INCOMPLETE_LINE.test(tail) || INCOMPLETE_CELL.test(tail)) return 'INCOMPLETE (not run)'
  // Approve is the fallthrough on purpose: this reads an agent's whole prose report, where a clean
  // dimension legitimately contains no keyword at all. (Contrast worstVerdict() in
  // lib/run-record.mjs, which receives already-parsed tokens and rightly refuses to default.)
  return 'Approve'
}

// Precedence for the top-level roll-up, worst wins.
const RANK = { Approve: 0, 'INCOMPLETE (not run)': 1, Warning: 2, Block: 3 }

export function worstOf(verdicts) {
  return verdicts.reduce((a, b) => ((RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a), 'Approve')
}

// `synthesized: false` says the consolidation step never delivered. Without it the record read the
// verdict out of the RAW dimension blob that stands in for the report — whose last VERDICT line is
// whatever the final dimension wrote, commonly APPROVE. The human then saw INCOMPLETE while the
// index recorded Approve for the same run, which is worse than either alone: the store and the
// report disagree, and only the store is machine-read afterwards.
export function buildAuditRecord({ results, baseRef, hasUnsafe, synthesisText, synthesized = true }) {
  const rs = Array.isArray(results) ? results : []
  const dimensions = rs.map((r) => ({
    dimension: r.label, ran: !!r.ok, verdict: r.ok ? parseVerdict(r.text) : '',
  }))
  // The top-level verdict is the worst of the synthesis's own verdict and every dimension's, so it
  // no longer depends on the synthesising model restating the roll-up correctly — and no longer on
  // the word "Warning" happening to appear somewhere in a dimension table.
  const worst = worstOf([
    synthesized ? parseVerdict(synthesisText) : 'INCOMPLETE (not run)',
    ...dimensions.map((d) => (d.ran ? d.verdict : 'INCOMPLETE (not run)')),
  ])
  const notRun = rs.filter((r) => !r.ok).map((r) => r.label)
  const incomplete = dimensions.filter((d) => d.ran && d.verdict === 'INCOMPLETE (not run)').map((d) => d.dimension)
  // Worst-wins ranks INCOMPLETE below Warning, so partial coverage vanishes from the top-level
  // token whenever anything else is worse. The SUFFIXED form is the shape lib/analyze-runs.mjs
  // already reads (`/INCOMPLETE/i` over the verdict string, severity-first bucketing), so emitting
  // `Warning (INCOMPLETE)` keeps both readers working: the severity is still the severity, and the
  // run is still counted as partial coverage.
  const partial = incomplete.length > 0 || notRun.length > 0
  const verdict = partial && !/INCOMPLETE/.test(worst) ? `${worst} (INCOMPLETE)` : worst
  return {
    schemaVersion: 1,
    runtime: 'opencode',
    kind: 'workflow',
    name: 'rust-audit',
    verdict,
    findings: null,
    nested: false,
    via: null,
    scout: { baseRef: baseRef || '', hasUnsafe: !!hasUnsafe },
    dimensions,
    notRun,
    // Dimensions that RAN but reported their own tooling absent. `notRun` cannot carry these (their
    // child session succeeded), and worst-wins precedence hides them at top level whenever any
    // other dimension is Warning or Block — which is most real runs. This keeps the fact reachable.
    incomplete,
  }
}

// `planned: false` and a non-zero `untriaged` are the two ways a triage run is incomplete, and the
// record has to be able to say so: the plan that never came, and the findings past the cap that
// nobody looked at. Without them the store showed a run that looked ordinary while the reader had
// been told, on screen only, that neither held.
//
// They are their OWN fields; `verdict` stays empty. A triage has no verdict — that is deliberate and
// pinned by a test — and widening a field other readers already interpret, to carry a fact that has
// no home yet, is how two writers come to disagree about what a column means.
export function buildTriageRecord({ results, planned = true, untriaged = 0 }) {
  const rs = Array.isArray(results) ? results : []
  return {
    schemaVersion: 1,
    runtime: 'opencode',
    kind: 'workflow',
    name: 'triage-findings',
    planned,
    untriaged,
    verdict: '',
    findings: null,
    nested: false,
    via: null,
    dimensions: rs.map((r) => ({ dimension: r.label, ran: !!r.ok })),
    notRun: rs.filter((r) => !r.ok).map((r) => r.label),
  }
}

export function indexProjection(r) {
  return {
    schemaVersion: r.schemaVersion, runtime: r.runtime ?? null, ts: r.ts, kind: r.kind, name: r.name,
    project: r.project, commit: r.commit, dirty: r.dirty,
    verdict: r.verdict, findingsTotal: r.findings ? r.findings.total : null,
    nested: r.nested, via: r.via,
  }
}

function runsDir() {
  return process.env.CRAFT_RUNS_DIR || join(homedir(), '.craft', 'runs')
}

// Filesystem-safe UTC: YYYY-MM-DDTHH-MM-SSZ (drop millis, replace the time colons).
function tsStamp(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')
}

async function sh(ctx, cmd) {
  try {
    const r = await ctx.$`bash -lc ${cmd}`.quiet()
    return (r.stdout?.toString?.() ?? String(r.stdout ?? '')).trim()
  } catch {
    return ''
  }
}

// Best-effort: stamp the runtime fields, write the detail file, append the index line. NEVER throws
// into the caller — observability must not break a workflow run.
export async function writeRecord(ctx, record) {
  try {
    const dir = runsDir()
    const ts = tsStamp(new Date())
    const project = ctx.worktree || ctx.directory || (await sh(ctx, 'pwd'))
    const commit = await sh(ctx, 'git rev-parse --short HEAD 2>/dev/null')
    const dirty = (await sh(ctx, 'git status --porcelain 2>/dev/null')).length > 0
    const full = { ...record, ts, project, commit, dirty }
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${ts}-${full.kind}-${full.name}.json`), JSON.stringify(full, null, 2) + '\n')
    appendFileSync(join(dir, 'index.jsonl'), JSON.stringify(indexProjection(full)) + '\n')
  } catch (e) {
    try { console.error(`craft observability: failed to write run record: ${e?.message ?? e}`) } catch { /* ignore */ }
  }
}
