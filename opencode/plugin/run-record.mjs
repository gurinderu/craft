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
// The mandated line, as a line of its own. NO leading pipe in the decoration class: with one, a row
// whose FIRST cell carried the token was read at stage 1 and re-entered last-wins against the
// overall line — so `VERDICT: BLOCK` followed by `| VERDICT: APPROVE | deps | … |` still parsed as
// Approve. The two-stage split only holds if every row shape reaches stage 2.
const VERDICT_LINE = /^[ \t>*_`#-]*VERDICT:[ \t]*[*_`]*[ \t]*(APPROVE|WARNING|BLOCK|INCOMPLETE)\b/gm

// The same token inside a markdown TABLE ROW — `| overall | VERDICT: APPROVE |`, which is how an
// audit synthesis usually writes its verdict. Read SECOND, and only when no line of its own carried
// one: a synthesis states its overall verdict as a line and then tables the dimensions, so taking
// last-wins across both made the last table ROW override the overall line. Executed on a real
// shape, `VERDICT: BLOCK` followed by a dimension table ending `| deps | VERDICT: APPROVE |` parsed
// as Approve — a Block filed as clean, which is worse than any not-run this branch exists to fix.
// Anchored on a leading `|` (after indentation — an indented table is still a table, and requiring
// column zero made the reader and the gate disagree about one) so it can only be a row: without that the prefix matched any prose
// carrying pipes. That anchor is defensive rather than load-bearing — the gate rejects such a line
// anyway, and no falsifier through the public surface can reach it, so it is not claimed as pinned.
//
// What reading rows concedes, since every other trade in this file is named: a row now outranks a
// tail KEYWORD, so `| security | Block — use-after-free … |` followed by `| deps | VERDICT: APPROVE |`
// heads the report Approve where main said Block, and a table-only synthesis resolves by document
// order rather than by severity. The store is unaffected — `buildAuditRecord` rolls worst-wins over
// each dimension's own text, so a genuine Block dimension is still caught — but the text a human
// reads can be headed by the milder verdict. Kept because the alternative is worse: without the row
// arm a table-formatted synthesis is not structured at all, and falls to the prose arm where a clean
// run that named an absent tool is filed not-run.
const VERDICT_ROW =
  /^[ \t]*\|(?:[^\n|]*\|){0,4}[ \t>|*_`#-]*VERDICT:[ \t]*[*_`]*[ \t]*(APPROVE|WARNING|BLOCK|INCOMPLETE)\b/gm

// Whether a dimension ANSWERED, asked of the parser itself rather than of one of its arms.
//
// Spelling the structural arm twice was the first mistake and it was fixed by exporting the regex —
// but exporting one ARM left the gate strictly narrower than the reader, which is the same defect
// with a smaller gap. `parseVerdict` also reads a prose tail: "Found a use-after-free in
// src/x.rs:10.\n\nVerdict: Block" parses as Block while a VERDICT_LINE test says "unanswered", so a
// security dimension that found UB was re-run at full cost and then filed INCOMPLETE — which
// `worstOf` ranks BELOW Block. Severity lost, by the gate that exists to stop severity being lost.
//
// So the gate is now: did the parser reach a verdict from EVIDENCE, or only by its fallthrough?
// Approve is the fallthrough on purpose (a clean prose report carries no keyword at all), and that
// is exactly the case a silent or refusing session also lands in — which is why the fallthrough,
// and only the fallthrough, is what "did not answer" means.
// A session saying it did NOTHING — the whole of the refusal test, and deliberately the whole of it.
//
// An earlier version also matched an inability followed by a work verb ("I could not inspect the
// workspace"), and that was wrong in the direction this branch is most careful about. The audit
// prompts MANDATE a partial note — "Skip any absent tool with a note", "Note any absent tools" — and
// the natural note is first person: "cargo-audit ran clean over 214 crates. cargo-deny is not
// installed, so I could not check licenses." Ten dimensions that all ran were retried on the shared
// budget and then filed not-run. The same clause discarded correct triage work, where an inability
// is often the FINDING: "I could not open that file — the PR deletes it. Stale finding. OUTCOME:
// reject", and "the crate cannot compile without this" inside a finished plan.
//
// Four wordings were trimmed after they caught mandated notes in a second phrasing: `scans` (a
// docs-only diff honestly reports "no scans were run" and still approves), `nothing to report` (what
// a clean review says), `could not be found` ("cargo-deny could not be found on PATH, so licenses
// were not checked" is the same partial note as "is not installed"), and `nothing to check` — which
// is the answer `opencode/agents/rust-miri.md` MANDATES for a crate with no unsafe code, so keeping
// it filed a clean miri dimension as not-run after a full retry off the shared budget.
//
// So only a stated TOTAL non-execution counts, plus a denial of access. Nothing here can describe
// reviewed code: a report about a codebase does not say "no checks were run" or "nothing to review".
//
// The ceiling this leaves is real and is not closable by vocabulary: a session that refuses in the
// passive voice, or in another language, or with no prose at all, and then writes a conforming
// `VERDICT: APPROVE`, is indistinguishable from an answer by text. What stands behind it is not this
// regex — it is thinner than that: worst-wins can only PROPAGATE a severity some dimension
// supplied, so when every dimension refuses in a conceded shape it has nothing to propagate, and
// `synthesized` is true because the synthesis did deliver. In that scenario — a total silent
// approval, not a partially caught one — what remains is the prompts, which tell a refusing agent
// to answer INCOMPLETE.
const REFUSED = new RegExp(
  [
    'no[ \\t]+(?:checks|tools|analysis|commands)[ \\t]+(?:were|was|could[ \\t]+be)[ \\t]+(?:run|performed|executed)',
    'none[ \\t]+of[ \\t]+the[ \\t]+(?:tools|checks|commands)[ \\t]+(?:is|are|was|were)[ \\t]+(?:installed|available|run)',
    'nothing[ \\t]+(?:was|could[ \\t]+be)[ \\t]+(?:checked|verified|analysed|analyzed|inspected|reviewed|examined|run|executed)',
    'nothing[ \\t]+ran\\b',
    'nothing[ \\t]+to[ \\t]+(?:review|plan|order|validate|judge|triage|consolidate|inspect)\\b',
    // `[ \\t]*not`, not `[ \\t]+not`: the contracted spelling CANNOT is the commonest English form,
    // and requiring a space between `can` and `not` let "I cannot run any of the tools in this
    // sandbox." plus a conforming VERDICT: APPROVE be filed ran:true, verdict:Approve. Not the
    // conceded ceiling — that names passive voice, another language, or no prose at all. Every
    // `cannot` in the corpus happened to be caught by a different arm, so the one combination that
    // breaks it appeared nowhere.
    '(?:I|we)[ \\t]+(?:could|did|can|do)(?:n\'t|[ \\t]*not)[ \\t]+(?:run|perform|execute)[ \\t]+(?:any|anything)',
    '(?:I|we)[ \\t]+(?:was|were|am|are)?[ \\t]*un(?:able)[ \\t]+to[ \\t]+(?:run|perform|execute)[ \\t]+(?:any|anything)',
    '(?:I|we)[ \\t]+reviewed[ \\t]+nothing',
    '(?:could|can)[ \\t]*not[ \\t]+be[ \\t]+(?:run|executed|performed)',
    // `denied BY`, not `denied for`: "the access control check is denied for anonymous callers" is a
    // finding about the code, and a wide denial clause read it as a refusal.
    'permission[ \\t]+denied',
    '(?:do|does|did)[ \\t]+not[ \\t]+have[ \\t]+permission',
    'access[ \\t\\w]{0,40}?denied[ \\t]+by\\b',
  ].join('|'),
  'i',
)

export function hasVerdictLine(text) {
  const t = String(text ?? '')
  const e = verdictEvidence(t)
  if (e === null) return false
  // Reported Block stands whatever else the text says: reading a finding as a refusal files a
  // use-after-free as INCOMPLETE, which worstOf ranks BELOW Block.
  if (e.verdict === 'Block') return true
  // A bare keyword in the tail is a word, not a judgement — `warning:` is what cargo prints.
  if (e.by === 'keyword') return false
  // A claimed APPROVE is a claim about what was not found, and it holds only over what was looked
  // at. Everything else — Warning, INCOMPLETE — is an agent reporting a limit, which is honest.
  if (e.verdict === 'Approve') return !REFUSED.test(t)
  return true
}


// The plan marker must BE the last thing said, not merely appear somewhere. An any-line boolean is
// satisfied by a refusal that quotes or reconstructs the marker — `\`PLAN: READY\` is what the
// instructions ask for, but there is nothing to plan` passed, and the refusal was returned as the
// fix plan with `planned: true`. Removing the literal line from the prompt addressed the example;
// the property is that a short marker can always be reconstructed, and the only thing a refusal
// cannot do is stop refusing. The audit side survives the same shape only by accident, because
// `parseVerdict` reads the LAST such line rather than any.
//
// So: the marker must be a LINE OF ITS OWN — decoration allowed, trailing prose not. That is what a
// quotation cannot survive, because a refusal quoting the instruction says something on either side
// of it.
//
// Terminality was the first attempt and it was too strong in the other direction: requiring the
// marker to be the LAST non-blank line discarded well-formed plans over a closing fence or a
// trailing "Let me know if you want more." A false not-run there throws away up to forty child
// sessions already paid for and files `planned: false` about a plan that exists, so the two errors
// are not symmetric and the rule is set where the cheaper one falls. What that concedes, said
// plainly: a reply that emits the marker and then retracts it in the next paragraph is accepted.
// The reader still sees the retraction — it is the text they are handed.
// No blockquote and no backtick in the decoration class, and fenced blocks are skipped: those are
// exactly the three ways a refusal puts the marker on a line of its own while quoting it. Bold,
// emphasis and a list bullet stay, because those are how a model DECORATES its own final line.
const PLAN_MARKER = /^[ \t*_#-]*PLAN:[ \t]*[*_]*[ \t]*READY[ \t]*[*_.]*[ \t]*$/i
const FENCE = /^[ \t]*(`{3,}|~{3,})/

// One anti-echo rule for every marker: outside fenced blocks, on a line of its own. Written once
// because it was got right once and then not carried: `hasOutcomeLine` kept the any-line form with
// `>` and backticks in its decoration class and no fence skipping — the three things the plan
// marker was hardened twice to exclude — on the branch's highest-volume path, so a validation
// answering "I could not read src/a.rs ... the instructions ask for: ```OUTCOME: accept```" was
// filed as having validated, and a Critical finding reached the plan carrying a refusal as its
// reasoning.
// A table row's CELLS are lines of their own, in table terms. No neighbour rule and no attempt to
// tell a quoted table from a real one: that game is unwinnable and was lost twice. A lone row was
// called a quotation, so a genuine one-row summary — the form the synthesis prompt asks for — was
// filed not-run; then a quoted table given a header row walked straight back in, because two lines
// of markdown are not a discriminator for intent. What separates a refusal from an answer is not
// the SHAPE the marker is written in but whether the session says it could not do the work, and
// that test now guards every marker (see REFUSED) whatever shape carries it — heading, HTML block
// and quoted table included.
function ownLine(line, marker) {
  if (marker.test(line)) return true
  if (!/^[ \t]{0,3}\|/.test(line)) return false
  return line.split('|').some((cell) => marker.test(cell.trim()))
}

function markerLine(text, marker) {
  // `\r` stripped: `PLAN_MARKER` is the one marker anchored with `$`, so a CRLF reply lost its plan
  // and discarded forty paid-for child sessions over a line ending.
  const lines = String(text ?? '').split('\n').map((l) => l.replace(/\r$/, ''))
  let openedWith = null
  let openedAt = -1
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(FENCE)
    if (f) {
      if (openedWith === null) {
        openedWith = f[1]
        openedAt = i
      } else if (f[1][0] === openedWith[0] && f[1].length >= openedWith.length) {
        openedWith = null
        openedAt = -1
      }
      continue
    }
    // Four spaces or more is CommonMark's other code form, which this walk does not track as a block
    // — so an indented quotation of the marker is not the session's own line either.
    if (/^[ \t]{4,}/.test(lines[i])) continue
    if (openedWith === null && ownLine(lines[i], marker)) return true
  }
  // An opener that never closed took the input's TAIL with it on a guess — so read that tail, and
  // only that tail. Re-reading every line instead re-admitted the contents of every properly closed
  // fence before it, so one truncated final code block was enough to make a marker quoted inside an
  // earlier block count as an answer. Which error this chooses, said plainly: a marker quoted inside
  // the UNCLOSED trailing fence is still accepted. Losing a real answer to a truncated paste costs
  // work already paid for; accepting one quoted inside a block nobody closed costs a re-read.
  if (openedWith !== null) {
    const tail = lines.slice(openedAt + 1)
    return tail.some((l) => !FENCE.test(l) && !/^[ \t]{4,}/.test(l) && ownLine(l, marker))
  }
  return false
}

// A closer must match its opener in character and length — the CommonMark rule the sibling splitter
// already implements, and for the same asymmetric-cost reason: toggling on any fence-looking line
// meant a truncated or decorative one ("See:\n```rust\nfn f(){}") hid a real plan behind it and
// discarded up to forty child sessions already paid for. An unterminated fence loses nothing here,
// because the marker is looked for on every line the fence never closed over.
export function hasPlanMarkerLine(text) {
  return markerLine(text, PLAN_MARKER) && !REFUSED.test(String(text ?? ''))
}


// Same argument for the triage outcome line.
// Case-INSENSITIVE on the token, and the difference from VERDICT is not an oversight. `parseVerdict`
// is case-sensitive because a lowercase `Verdict: Approve` is deliberately weighed differently by a
// second reader; there is no second reader here, so the same strictness would only punish a
// validation that answered correctly and capitalised — re-running it and then filing it not-run,
// which is the inversion this predicate exists to prevent.
// No blockquote, no backtick, no `m` flag: this goes through `markerLine`, which walks lines itself
// and skips fenced blocks. Trailing prose on the line is allowed — unlike the plan marker, the
// outcome word is followed by the one or two sentences of reasoning the prompt asks for.
//
// What that concedes, and it is a real concession this marker has that the plan marker did not:
// fencing a machine-read final line is a common model habit, so a GENUINE validation that writes
// ```\nOUTCOME: accept\n``` is now re-run at full cost and then excluded from the plan as not-run.
// Kept anyway, because the alternative admitted a validation that could not read the file and
// quoted its instructions back — and that one reaches the plan as a finding's reasoning.
const OUTCOME_LINE = /^[ \t*_#-]*OUTCOME:[ \t]*[*_]*[ \t]*(accept|reject|defer|needs-decision|conflict)\b/i

export function hasOutcomeLine(text) {
  return markerLine(text, OUTCOME_LINE) && !REFUSED.test(String(text ?? ''))
}

// How much of the report the fallback scan is allowed to see.
const TAIL_LINES = 20

// A labelled verdict statement — `Verdict: Approve`, `Overall rating: INCOMPLETE`. Used only to
// decide between Approve and INCOMPLETE; Block/Warning evidence outranks it.
const LABELLED = /\b(?:overall[ \t]+)?(?:verdict|rating|outcome)[ \t]*:[ \t]*[*_`]*[ \t]*(Approve|Clean|Healthy|INCOMPLETE)\b/gi

// The same statement with the whole vocabulary, used ONLY to decide whether the session answered.
// The distinction the gate needs and the reader does not: a LABELLED statement is a judgement the
// agent chose to make, while a bare keyword in the tail is just a word — and `warning:` is what
// cargo prints. Without this split the gate read "warning: unused variable `x` / I was unable to
// complete the review." as an answer and filed a refusing dimension `ran: true, verdict: Warning`,
// which is the branch's own property broken by the guard installed to hold it. The reader keeps
// weighing bare keywords, because for a session that DID run they are evidence that outranks a
// claimed Approve; for one that did not, they are noise.
const LABELLED_ANY =
  /\b(?:overall[ \t]+)?(?:verdict|rating|outcome)[ \t]*:[ \t]*[*_`]*[ \t]*(Approve|Clean|Healthy|INCOMPLETE|Block|Warning|Concerns|At-risk|UB-found)\b/gi

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

// The single body both the reader and the gate ask. Returns the verdict together with WHAT decided
// it, or null when nothing did — the two callers below differ only in which of those they keep, so
// they cannot drift apart again.
function verdictEvidence(t) {
  // 1. Structural: the last `VERDICT: <TOKEN>` line wins, and is authoritative when present.
  const structured = lastMatch(VERDICT_LINE, t) ?? lastMatch(VERDICT_ROW, t)
  if (structured) return { verdict: VERDICT_TOKEN[structured], by: 'structured' }

  // 2. Fallback for non-conforming output, over the tail only.
  const tail = t.split('\n').slice(-TAIL_LINES).join('\n')
  // Word boundaries (and the verdict emoji) so prose like "no blocking issues" / "unblocked"
  // doesn't collide with the Block keyword. Worst signal still wins (Block before Warning), and
  // both outrank a labelled statement: an agent claiming Approve while reporting UB is not taken
  // at its word.
  // A labelled statement anywhere in the tail is what makes a bare keyword count as an ANSWER.
  const stated = lastMatch(LABELLED_ANY, tail) !== null
  if (/⛔|\b(?:Block|At-risk|UB-found)\b/i.test(tail)) return { verdict: 'Block', by: stated ? 'labelled' : 'keyword' }
  if (/⚠️|\b(?:Warning|Concerns)\b/i.test(tail)) return { verdict: 'Warning', by: stated ? 'labelled' : 'keyword' }
  // A labelled statement decides between the remaining two. This is what stops a report that merely
  // MENTIONS incompleteness — quoting its own instructions, or tabling one dimension as INCOMPLETE
  // — from overriding the verdict the agent actually stated.
  const labelled = lastMatch(LABELLED, tail)
  if (labelled) {
    return { verdict: /incomplete/i.test(labelled) ? 'INCOMPLETE (not run)' : 'Approve', by: 'labelled' }
  }
  // A dimension whose tooling was absent checked nothing. That must not land in the Approve bucket:
  // an Approve is a claim about what was NOT found, and it only holds over what was looked at.
  if (INCOMPLETE_LINE.test(tail) || INCOMPLETE_CELL.test(tail)) {
    return { verdict: 'INCOMPLETE (not run)', by: 'incomplete-line' }
  }
  // Nothing decided it. The READER still answers Approve here on purpose — this reads an agent's
  // whole prose report, where a clean dimension legitimately contains no keyword at all (contrast
  // worstVerdict() in lib/run-record.mjs, which receives already-parsed tokens and rightly refuses
  // to default) — while the GATE reads the same absence as "did not answer".
  return null
}

export function parseVerdict(text) {
  return verdictEvidence(String(text || ''))?.verdict ?? 'Approve'
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
  // `!synthesized` belongs here, and its absence made the record disagree with the reader for every
  // audit worse than clean: an unconsolidated Warning run was byte-identical to a consolidated one,
  // because worst-wins only lifts the all-Approve case to INCOMPLETE by accident. The reader saw the
  // banner, the store said Warning. This also makes the fact reachable — every reader of the store
  // reads `verdict`, and none of them reads `synthesized`.
  const partial = incomplete.length > 0 || notRun.length > 0 || !synthesized
  const verdict = partial && !/INCOMPLETE/.test(worst) ? `${worst} (INCOMPLETE)` : worst
  return {
    schemaVersion: 1,
    runtime: 'opencode',
    kind: 'workflow',
    name: 'rust-audit',
    verdict,
    // Emitted, not merely accepted. The comment justifying the removal of the echo guard offered
    // "the record already carries `synthesized`" as a reason it was safe — and it did not: the
    // parameter only chose the verdict, so a reader of the store could not tell a consolidated
    // audit from an unconsolidated one.
    synthesized,
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
// `skipped` is here for the same reason `untriaged` is: it counts lines the splitter ATE, and the
// fence path is the loss path this delivery introduced — the one the store could not see, while the
// screen could. "No trace in the output OR the run record" is not half a rule.
export function buildTriageRecord({ results, planned = true, untriaged = 0, skipped = 0 }) {
  const rs = Array.isArray(results) ? results : []
  return {
    schemaVersion: 1,
    runtime: 'opencode',
    kind: 'workflow',
    name: 'triage-findings',
    planned,
    untriaged,
    skipped,
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
